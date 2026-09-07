// src/routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, eq, one } from '../db.js';
import { issueSession, revokeSession, requireAuth, bearerFrom, resolveSession } from '../auth.js';

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

    const owner = one(await db(
      `owners?email=${eq(email)}&select=id,name,email,role,password,status&limit=1`
    ));

    // Same message and roughly the same work whether the email exists or not,
    // so this endpoint can't be used to enumerate accounts.
    const hash = owner?.password || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
    const passwordMatches = await bcrypt.compare(password, hash);

    if (!owner || !passwordMatches) {
      await recordAttempt(throttleKey);
      return res.status(401).json({ error: 'Incorrect email or password.' });
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

    const existing = one(await db(`owners?email=${eq(email)}&select=id&limit=1`));
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

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ session: req.owner });
});

export default router;
