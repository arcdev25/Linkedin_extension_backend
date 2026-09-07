// src/db.js
// Thin PostgREST wrapper. Every call authenticates with the service key, which
// bypasses RLS — so the *only* thing standing between a caller and the whole
// database is the authorization logic in this app. Treat each route as if it
// were a raw SQL prompt, because effectively it is.
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, UPSTREAM_TIMEOUT_MS } from './config.js';

export const isLegacyJwtKey = SUPABASE_SERVICE_KEY.startsWith('eyJ');

// Supabase's gateway authenticates on `apikey`, but PostgREST decides which
// DATABASE ROLE you get from the `Authorization` header. Send only `apikey` and
// you can authenticate fine yet land on a role without grants — which shows up
// as HTTP 403 on every table.
//
// So: send both by default, which is what supabase-js itself does, for legacy
// service_role JWTs and new sb_secret_ keys alike.
//
// SUPABASE_AUTH_MODE overrides this if your project needs something else:
//   both   (default) — apikey + Authorization: Bearer
//   apikey           — apikey only
//   bearer           — Authorization: Bearer only
// GET /health/db probes all three and reports which your project accepts.
export const AUTH_MODE = ['both', 'apikey', 'bearer'].includes(process.env.SUPABASE_AUTH_MODE)
  ? process.env.SUPABASE_AUTH_MODE
  : 'both';

export function authHeadersFor(mode, key = SUPABASE_SERVICE_KEY) {
  if (mode === 'apikey') return { apikey: key };
  if (mode === 'bearer') return { Authorization: `Bearer ${key}` };
  return { apikey: key, Authorization: `Bearer ${key}` };
}

export const supabaseAuthHeaders = () => authHeadersFor(AUTH_MODE);

const baseHeaders = {
  'Content-Type': 'application/json',
  ...supabaseAuthHeaders(),
};

export class DbError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

export async function db(path, { method = 'GET', body = null, prefer = null } = {}) {
  const headers = { ...baseHeaders };
  if (prefer) headers.Prefer = prefer;

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    throw new DbError('Database unreachable', 503);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    // Full Postgres error details can leak schema information, so the body goes
    // to the logs. The upstream status code is safe to surface and is the
    // single most useful clue when debugging a deploy:
    //   401/403 — SUPABASE_SERVICE_KEY wrong, or sent on the wrong header
    //   404     — table missing (usually sql/01 not run yet) or bad SUPABASE_URL
    //   400     — column missing; the schema doesn't match what the code expects
    console.error('[db] error', res.status, path, JSON.stringify(data)?.slice(0, 400));
    throw new DbError(
      `Database request failed (upstream ${res.status})`,
      res.status >= 500 ? 502 : 400
    );
  }

  return data;
}

// PostgREST puts filter values in the query string, so anything user-supplied
// has to be encoded or it can inject extra filters.
export const eq = value => `eq.${encodeURIComponent(value)}`;

// Case-insensitive match. PostgREST maps `*` to the SQL `%` wildcard, so strip
// any the caller supplied. `_` is still a single-char wildcard here and is
// legal in an email, so callers MUST verify exact equality on the results.
export const ilike = value =>
  `ilike.${encodeURIComponent(String(value).replace(/\*/g, ''))}`;

export function one(rows) {
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}
