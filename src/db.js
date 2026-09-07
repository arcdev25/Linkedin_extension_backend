// src/db.js
// Thin PostgREST wrapper. Every call authenticates with the service key, which
// bypasses RLS — so the *only* thing standing between a caller and the whole
// database is the authorization logic in this app. Treat each route as if it
// were a raw SQL prompt, because effectively it is.
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, UPSTREAM_TIMEOUT_MS } from './config.js';

// The new-style secret keys (sb_secret_…) are NOT JWTs, so Supabase rejects
// them on the Authorization: Bearer header — they must travel on `apikey`
// alone. Legacy service_role keys are JWTs and want both. Detect and adapt so
// either kind works.
export const isLegacyJwtKey = SUPABASE_SERVICE_KEY.startsWith('eyJ');

export const supabaseAuthHeaders = () => (
  isLegacyJwtKey
    ? { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    : { apikey: SUPABASE_SERVICE_KEY }
);

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
    // Postgres error details can leak schema information, so log them here and
    // hand the client something generic.
    console.error('[db] error', res.status, data);
    throw new DbError('Database request failed', res.status >= 500 ? 502 : 400);
  }

  return data;
}

// PostgREST puts filter values in the query string, so anything user-supplied
// has to be encoded or it can inject extra filters.
export const eq = value => `eq.${encodeURIComponent(value)}`;

export function one(rows) {
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}
