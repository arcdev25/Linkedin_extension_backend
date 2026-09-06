// src/routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, eq, one } from '../db.js';
import { issueSession, revokeSession, requireAuth, bearerFrom, resolveSession } from '../auth.js';

const router = Router();

// ─── Login throttle ───────────────────────────────────────────────────────────
// In-memory, so it resets on redeploy and doesn't span multiple instances. It's
// here to blunt credential stuffing, not as a hard guarantee — put a real rate
// limiter (or your host's) in front if this is exposed widely.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function throttled(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > WINDOW_MS) {
    attempts.set(key, { first: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

function clearThrottle(key) {
  attempts.delete(key);
}

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of attempts) if (entry.first < cutoff) attempts.delete(key);
}, WINDOW_MS).unref?.();

// ─── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const throttleKey = `${req.ip}:${email}`;
    if (throttled(throttleKey)) {
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
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    if (owner.status !== 'active') {
      return res.status(403).json({
        error: 'Your account is pending admin approval. Please contact the admin.'
      });
    }

    clearThrottle(throttleKey);
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
