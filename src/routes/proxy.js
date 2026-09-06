// src/routes/proxy.js
// A PostgREST-shaped endpoint the dashboard's supabase-js client points at.
// Requests are authenticated, rewritten according to src/policies.js, then
// forwarded to Supabase with the service key.
//
// Everything in here is a security boundary. The service key bypasses RLS
// entirely, so a mistake in this file is a hole in the database.
import { Router } from 'express';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from '../config.js';
import { policyFor, scopeAllows } from '../policies.js';

const router = Router();

const METHOD_SCOPE = {
  GET: 'read',
  HEAD: 'read',
  POST: 'insert',
  PATCH: 'update',
  PUT: 'update',
  DELETE: 'delete',
};

// Headers worth passing through to PostgREST. Anything else (notably the
// client's own apikey/authorization) is dropped and replaced.
const FORWARD_REQUEST_HEADERS = ['prefer', 'range', 'range-unit', 'content-type', 'accept'];
const FORWARD_RESPONSE_HEADERS = ['content-range', 'content-type', 'preference-applied'];

function bodyColumns(body) {
  if (!body) return [];
  const rows = Array.isArray(body) ? body : [body];
  return [...new Set(rows.flatMap(r => (r && typeof r === 'object' ? Object.keys(r) : [])))];
}

function applyForcedValues(body, forced, ownerId) {
  if (!body || !forced) return body;
  const stamp = row => {
    const out = { ...row };
    for (const [col, source] of Object.entries(forced)) {
      out[col] = source === 'session' ? ownerId : source;
    }
    return out;
  };
  return Array.isArray(body) ? body.map(stamp) : stamp(body);
}

router.all('/:table', async (req, res) => {
  const table = req.params.table;
  const owner = req.owner;             // set by requireAuth in server.js
  const policy = policyFor(table);

  if (!policy) {
    return res.status(403).json({ message: `Table '${table}' is not accessible` });
  }

  const action = METHOD_SCOPE[req.method];
  if (!action) return res.status(405).json({ message: 'Method not allowed' });

  const scope = policy[action];
  if (!scopeAllows(scope, owner.role)) {
    return res.status(403).json({
      message: scope === 'admin'
        ? 'Admin access required'
        : `Not permitted on '${table}'`,
    });
  }

  // ── Rewrite the query string ────────────────────────────────────────────────
  const params = new URLSearchParams(req.url.split('?')[1] || '');

  // Never let a hidden column be selected, embedded or otherwise.
  const select = params.get('select') || '';
  if (policy.hiddenColumns?.some(col => new RegExp(`\\b${col}\\b`).test(select))) {
    return res.status(403).json({ message: 'Requested column is not readable' });
  }
  // For tables with a fixed safe projection, ignore whatever was asked for.
  if (policy.forceSelect && action === 'read') {
    if (!select || select.includes('*')) {
      params.set('select', policy.forceSelect);
    }
  }

  // 'own' scope: pin the query to the caller's rows. PostgREST ANDs repeated
  // filters, so a client-supplied filter on the same column can only narrow
  // this further — it can't widen it.
  if (scope === 'own' && policy.ownColumn) {
    params.append(policy.ownColumn, `eq.${owner.id}`);
  }

  // ── Rewrite the body ────────────────────────────────────────────────────────
  let body = req.body;

  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    const cols = bodyColumns(body);
    // Hidden columns can't be written either; immutable ones are read-only.
    const guarded = [...(policy.hiddenColumns || []), ...(policy.immutableColumns || [])];
    const blocked = guarded.filter(c => cols.includes(c));
    // owner_id is forced on insert, so it's only a violation when the caller is
    // trying to set it on an update.
    const isForced = col => policy.forceOnInsert && col in policy.forceOnInsert;
    const reallyBlocked = blocked.filter(c => !(req.method === 'POST' && isForced(c)));
    if (reallyBlocked.length && owner.role !== 'admin') {
      return res.status(403).json({ message: `Cannot set: ${reallyBlocked.join(', ')}` });
    }

    if (req.method === 'POST' && policy.forceOnInsert && owner.role !== 'admin') {
      body = applyForcedValues(body, policy.forceOnInsert, owner.id);
    }
  }

  // ── Forward ─────────────────────────────────────────────────────────────────
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.get(h);
    if (v) headers[h] = v;
  }
  if (!headers['content-type']) headers['content-type'] = 'application/json';

  const qs = params.toString();
  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}${qs ? `?${qs}` : ''}`;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(20000),
    });

    for (const h of FORWARD_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    let text = await upstream.text();
    if (!upstream.ok) {
      console.error('[proxy]', req.method, table, upstream.status, text.slice(0, 300));
    }

    // Belt and braces: even if the rewritten `select` didn't take effect, a
    // forbidden column never reaches the client. Rewriting the query alone
    // would mean one missed edge case leaks password hashes.
    if (upstream.ok && policy.hiddenColumns?.length && text) {
      try {
        const parsed = JSON.parse(text);
        const strip = row => {
          if (!row || typeof row !== 'object') return row;
          const out = { ...row };
          for (const col of policy.hiddenColumns) delete out[col];
          return out;
        };
        const cleaned = Array.isArray(parsed) ? parsed.map(strip) : strip(parsed);
        text = JSON.stringify(cleaned);
      } catch {
        // Not JSON — pass through untouched.
      }
    }

    res.status(upstream.status).send(text);
  } catch (e) {
    console.error('[proxy] upstream failure', e.message);
    res.status(502).json({ message: 'Upstream request failed' });
  }
});

export default router;
