// src/routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, eq, ilike, one } from '../db.js';
import {
  issueSession, revokeSession, revokeAllSessionsForOwner,
  requireAuth, bearerFrom, resolveSession,
} from '../auth.js';

const router = Router();

// ─── Login throttle ───────────────────────────────────────────────────────────
// Backed by a database table rather than memory. On a serverless host
// (Netlify, Vercel) each invocation gets its own memory and instances come and
// go, so an in-memory counter can be reset simply by spreading attempts across
// cold starts — a limit that looks like it works but doesn't.
//
// Degrades gracefully: if the login_attempts table is missing, throttling is
// skipped and a warning is logged rather than blocking all logins.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
let throttleTableMissing = false;

async function throttled(key) {
  if (throttleTableMissing) return false;

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  try {
    const rows = await db(
      `login_attempts?key=${eq(key)}&attempted_at=gte.${encodeURIComponent(since)}&select=id`
    );
    return (rows || []).length >= MAX_ATTEMPTS;
  } catch (e) {
    console.warn('[auth] login throttle unavailable — run sql/03_login_attempts.sql');
    throttleTableMissing = true;
    return false;
  }
}

async function recordAttempt(key) {
  if (throttleTableMissing) return;
  try {
    await db('login_attempts', { method: 'POST', body: { key } });
  } catch (e) {
    // Never let bookkeeping break a legitimate login.
  }
}

async function clearThrottle(key) {
  if (throttleTableMissing) return;
  try {
    await db(`login_attempts?key=${eq(key)}`, { method: 'DELETE' });
  } catch (e) {
    // Non-fatal.
  }
}

// ─── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const throttleKey = `${req.ip}:${email}`;
    if (await throttled(throttleKey)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }

    // Stored emails have mixed case ("Faker@owner.com") and PostgREST's `eq`
    // is case-sensitive, so an exact match on the lowercased input finds
    // nothing. Match case-insensitively with ilike, then confirm real equality
    // in JS — ilike treats `_` as a single-character wildcard, so `a_b@x.com`
    // would otherwise match a different account.
    const candidates = await db(
      `owners?email=${ilike(email)}&select=id,name,email,role,password,status&limit=5`
    );
    const owner = (candidates || []).find(
      o => String(o.email).toLowerCase() === email
    ) || null;

    // Same message and roughly the same work whether the email exists or not,
    // so this endpoint can't be used to enumerate accounts.
    const hash = owner?.password || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
    const passwordMatches = await bcrypt.compare(password, hash);

    if (!owner || !passwordMatches) {
      await recordAttempt(throttleKey);

      // Normally both failures return the same message so this endpoint can't
      // be used to discover which emails exist. Set AUTH_DEBUG=true TEMPORARILY
      // while commissioning a deploy to see which one actually failed, then
      // remove it — leaving it on hands attackers an account enumerator.
      const body = { error: 'Incorrect email or password.' };
      if (process.env.AUTH_DEBUG === 'true') {
        body.debug = !owner
          ? `no account matched "${email}" (checked case-insensitively)`
          : `account found (${owner.email}); bcrypt comparison failed. `
            + `stored hash prefix="${String(owner.password).slice(0, 4)}" `
            + `length=${String(owner.password).length} (expected $2a$/$2b$/$2y$ and 60)`;
      }
      return res.status(401).json(body);
    }
    if (owner.status !== 'active') {
      return res.status(403).json({
        error: 'Your account is pending admin approval. Please contact the admin.'
      });
    }

    await clearThrottle(throttleKey);
    const { token, expiresAt } = await issueSession(owner.id);

    res.json({
      token,
      expiresAt: expiresAt.toISOString(),
      session: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        role: owner.role || 'owner',
      },
    });
  } catch (e) {
    next(e);
  }
});

// ─── POST /auth/register ──────────────────────────────────────────────────────
// New accounts start disabled and need an admin to approve them, matching what
// the dashboard did before. Hashing happens here, not in the browser.
router.post('/register', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const email = String(req.body?.email || '').toLowerCase().trim().slice(0, 200);
    const password = String(req.body?.password || '');

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    // Same case-insensitivity applies here, or two accounts could differ only
    // by capitalisation and both be able to "log in" as each other's email.
    const existingRows = await db(`owners?email=${ilike(email)}&select=id,email&limit=5`);
    const existing = (existingRows || []).find(
      o => String(o.email).toLowerCase() === email
    );
    if (existing) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const rows = await db('owners', {
      method: 'POST',
      prefer: 'return=representation',
      // `role` is hard-coded. Never take it from the request body, or signup
      // becomes a way to mint admins.
      body: { name, email, password: hashed, role: 'owner', status: 'disabled' },
    });

    const created = one(rows);
    res.status(201).json({
      user: { id: created.id, name: created.name, email: created.email, role: created.role },
    });
  } catch (e) {
    next(e);
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
router.post('/logout', async (req, res, next) => {
  try {
    await revokeSession(bearerFrom(req));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ─── GET /auth/session ────────────────────────────────────────────────────────
// Returns the session or null. Never 401s, so the extension can distinguish
// "signed out" from "server is down".
router.get('/session', async (req, res, next) => {
  try {
    const resolved = await resolveSession(bearerFrom(req));
    res.json({ session: resolved ? resolved.owner : null });
  } catch (e) {
    next(e);
  }
});

// ─── POST /auth/change-password ───────────────────────────────────────────────
// Change your own password. Requires the current one, so a stolen session token
// alone can't lock the real owner out.
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const row = one(await db(`owners?id=${eq(req.owner.id)}&select=password&limit=1`));
    if (!row || !(await bcrypt.compare(currentPassword, row.password))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    await db(`owners?id=${eq(req.owner.id)}`, {
      method: 'PATCH',
      body: { password: await bcrypt.hash(newPassword, 10) },
    });

    // Every existing session is invalidated, including this one — a password
    // change should log out anyone who had the old credentials.
    await revokeAllSessionsForOwner(req.owner.id);
    res.json({ ok: true, message: 'Password changed. Please sign in again.' });
  } catch (e) {
    next(e);
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ session: req.owner });
});

export default router;
