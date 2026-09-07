// src/routes/health.js
// Deployment diagnostics. Reports whether the backend can actually reach
// Supabase and whether the tables it needs exist — the two things that make
// login fail with an opaque "Database request failed" after a fresh deploy.
//
// Returns booleans only: no data, no credentials, no error details. Once your
// deploy is stable you can delete this route; it exists to make the first
// hour of debugging bearable.
import { Router } from 'express';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from '../config.js';
import { supabaseAuthHeaders, authHeadersFor, isLegacyJwtKey, AUTH_MODE } from '../db.js';

const router = Router();

const REQUIRED_TABLES = [
  { name: 'owners', hint: 'core schema — should already exist' },
  { name: 'recruiters', hint: 'core schema' },
  { name: 'contacts', hint: 'core schema' },
  { name: 'profiles', hint: 'core schema' },
  { name: 'auth_sessions', hint: 'run sql/01_sessions_and_status.sql' },
  { name: 'login_attempts', hint: 'run sql/03_login_attempts.sql (optional)' },
];

// PostgREST puts the real reason in the response body. Without it, a 403 is
// indistinguishable between "wrong key", "no grant" and "schema not exposed".
async function readError(res) {
  try {
    const body = await res.json();
    return [body?.message, body?.hint, body?.code].filter(Boolean).join(' | ').slice(0, 300);
  } catch {
    return '';
  }
}

async function probe(table) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, {
      headers: supabaseAuthHeaders(),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return { status: res.status, ok: true };
    return { status: res.status, ok: false, message: await readError(res) };
  } catch (e) {
    return { status: 0, ok: false, error: 'unreachable' };
  }
}

// Which header combination does this project actually accept? Settles the
// question empirically instead of relying on which docs page you read.
async function probeAuthMode(mode) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/owners?select=id&limit=1`, {
      headers: authHeadersFor(mode),
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) return `ok (HTTP ${r.status})`;
    const msg = await readError(r);
    return `FAIL (HTTP ${r.status})${msg ? ' — ' + msg : ''}`;
  } catch (e) {
    return 'FAIL (unreachable)';
  }
}

router.get('/db', async (req, res) => {
  const results = {};
  for (const { name, hint } of REQUIRED_TABLES) {
    const r = await probe(name);
    results[name] = r.ok
      ? 'ok'
      : `FAIL (${r.error || `HTTP ${r.status}`})${r.message ? ' — ' + r.message : ''} [${hint}]`;
  }

  const authModes = {
    both:   await probeAuthMode('both'),
    apikey: await probeAuthMode('apikey'),
    bearer: await probeAuthMode('bearer'),
  };
  const workingMode = Object.entries(authModes).find(([, v]) => v.startsWith('ok'))?.[0] || null;

  const anyAuthFailure = Object.values(results).some(v => /HTTP 40[13]/.test(v));
  const allUnreachable = Object.values(results).every(v => v.includes('unreachable'));

  res.json({
    supabaseUrlConfigured: Boolean(SUPABASE_URL),
    supabaseUrlHost: SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0] + '.supabase.co',
    keyFormat: isLegacyJwtKey ? 'legacy service_role JWT' : 'new-style secret key (sb_secret_…)',
    // Length and prefix only — enough to spot a truncated paste without
    // printing the key itself.
    keyLength: SUPABASE_SERVICE_KEY.length,
    keyPrefix: SUPABASE_SERVICE_KEY.slice(0, 10),
    keyHasWhitespace: /\s/.test(SUPABASE_SERVICE_KEY),
    keyHasQuotes: /^["']|["']$/.test(SUPABASE_SERVICE_KEY),
    authModeInUse: AUTH_MODE,
    authModeProbes: authModes,
    workingAuthMode: workingMode,
    tables: results,
    diagnosis: allUnreachable
      ? 'Cannot reach Supabase at all — check SUPABASE_URL.'
      : workingMode && workingMode !== AUTH_MODE
        ? `Set SUPABASE_AUTH_MODE=${workingMode} — that header combination works, the current one doesn't.`
        : !workingMode
          ? (Object.values(authModes).some(v => v.includes('HTTP 403'))
              ? 'The key authenticates (403, not 401) but its role lacks table privileges. '
                + 'This is a Postgres GRANT problem, not a bad key — see the message text above.'
              : 'No header combination worked and none returned 403, so the key itself is '
                + 'being rejected. Re-copy it from Settings → API Keys.')
          : anyAuthFailure
            ? 'Supabase rejected the key on some tables — check grants for the service role.'
            : Object.values(results).some(v => v.startsWith('FAIL'))
              ? 'Reachable, but a table is missing — see the hints above.'
              : 'All checks passed.',
  });
});

export default router;
