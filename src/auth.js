// src/auth.js
// Opaque bearer tokens backed by a `sessions` table. Only the SHA-256 hash of a
// token is stored, so a database dump doesn't hand over live sessions.
import crypto from 'node:crypto';
import { db, eq, one, DbError } from './db.js';
import { SESSION_TTL_DAYS } from './config.js';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function issueSession(ownerId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db('auth_sessions', {
    method: 'POST',
    body: {
      owner_id: ownerId,
      token_hash: hashToken(token),
      expires_at: expiresAt.toISOString(),
    },
  });

  return { token, expiresAt };
}

export async function revokeSession(token) {
  if (!token) return;
  await db(`auth_sessions?token_hash=${eq(hashToken(token))}`, { method: 'DELETE' });
}

export async function revokeAllSessionsForOwner(ownerId) {
  await db(`auth_sessions?owner_id=${eq(ownerId)}`, { method: 'DELETE' });
}

function bearerFrom(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Resolves a bearer token to an active owner, or null.
export async function resolveSession(token) {
  if (!token) return null;

  const rows = await db(
    `auth_sessions?token_hash=${eq(hashToken(token))}&select=id,owner_id,expires_at,owners(id,name,email,role,status)`
  );
  const row = one(rows);
  if (!row) return null;

  // Expired, or the account was disabled since login.
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db(`auth_sessions?id=${eq(row.id)}`, { method: 'DELETE' });
    return null;
  }
  const owner = row.owners;
  if (!owner || owner.status !== 'active') {
    await db(`auth_sessions?owner_id=${eq(row.owner_id)}`, { method: 'DELETE' });
    return null;
  }

  return {
    sessionId: row.id,
    // `role` comes from the database on every request. The dashboard used to
    // read it from localStorage, which meant a user could type themselves into
    // an admin by editing it.
    owner: {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      role: owner.role || 'owner',
    },
  };
}

// Route guard. Attaches req.owner for downstream handlers.
export async function requireAuth(req, res, next) {
  try {
    const resolved = await resolveSession(bearerFrom(req));
    if (!resolved) {
      return res.status(401).json({ error: 'AUTH_REQUIRED' });
    }
    req.owner = resolved.owner;
    req.sessionId = resolved.sessionId;
    req.token = bearerFrom(req);
    next();
  } catch (e) {
    next(e);
  }
}

export { bearerFrom, DbError };
