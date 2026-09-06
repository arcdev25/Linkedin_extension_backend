// src/routes/data.js
// Recruiters, profiles, contacts, highlights and keywords. Everything here is
// behind requireAuth, mounted in server.js.
import { Router } from 'express';
import { db, eq, one, DbError } from '../db.js';
import { CONTACT_SCOPE } from '../config.js';
import {
  assertOwnsRecruiter,
  assertOwnsHighlight,
  assertOwnsKeyword,
  assertOwnsContact,
} from '../ownership.js';

const router = Router();

// Mirrors STATUS_CONFIG in the extension's content.js. If you add a status,
// add it in both places — and to the CHECK constraint in Postgres.
const STATUSES = new Set([
  'pending', 'chatting', 'not interested', 'sent js',
  'success', 'failed', 'accept', 'need reconnection',
]);

const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);

function displayName(r) {
  return r.company ? `${r.name}'s ${r.company}` : r.name;
}

// ─── Recruiters ───────────────────────────────────────────────────────────────

router.get('/recruiters', async (req, res, next) => {
  try {
    const rows = await db(
      `recruiters?owner_id=${eq(req.owner.id)}&select=id,name,company,email,created_at&order=name.asc`
    );
    res.json({ recruiters: (rows || []).map(r => ({ ...r, displayName: displayName(r) })) });
  } catch (e) { next(e); }
});

router.post('/recruiters', async (req, res, next) => {
  try {
    const name = str(req.body?.name, 120);
    if (!name) throw new DbError('Name is required', 400);

    // owner_id comes from the session, never from the request body.
    const rows = await db('recruiters', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        owner_id: req.owner.id,
        name,
        company: str(req.body?.company, 120),
        email: str(req.body?.email, 200),
      },
    });
    const recruiter = one(rows);
    res.status(201).json({ recruiter: { ...recruiter, displayName: displayName(recruiter) } });
  } catch (e) { next(e); }
});

// ─── Profiles + contacts ──────────────────────────────────────────────────────

function cleanProfileText(value, blocked = []) {
  const text = str(value, 500);
  if (!text) return '';
  return blocked.some(b => b.toLowerCase() === text.toLowerCase()) ? '' : text;
}

function buildProfilePayload(data, existing = {}) {
  const name = cleanProfileText(data.name, ['Name not found']);
  const headline = cleanProfileText(data.headline, ['No headline available', 'Headline not found']);
  const location = cleanProfileText(data.location);

  return {
    linkedin_id: str(data.linkedinId, 200),
    name: name || cleanProfileText(existing.name, ['Name not found']) || '',
    headline: headline || cleanProfileText(existing.headline, ['No headline available', 'Headline not found']) || '',
    profile_url: cleanProfileText(data.profileUrl) || existing.profile_url || '',
    avatar_url: cleanProfileText(data.avatarUrl) || existing.avatar_url || '',
    location: location || cleanProfileText(existing.location) || '',
  };
}

async function upsertProfile(data) {
  const linkedinId = str(data.linkedinId, 200);
  if (!linkedinId) throw new DbError('linkedinId is required', 400);

  const existing = one(await db(
    `profiles?linkedin_id=${eq(linkedinId)}&select=id,name,headline,profile_url,avatar_url,location`
  )) || {};

  const rows = await db('profiles?on_conflict=linkedin_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: buildProfilePayload({ ...data, linkedinId }, existing),
  });
  return one(rows);
}

router.get('/profiles/:linkedinId', async (req, res, next) => {
  try {
    const linkedinId = str(req.params.linkedinId, 200);
    const select = 'select=*,contacts(*,recruiters(id,name,company,email,owner_id))';
    const rows = await db(`profiles?linkedin_id=${eq(linkedinId)}&${select}`);
    const profile = one(rows);

    if (profile && CONTACT_SCOPE === 'owner') {
      profile.contacts = (profile.contacts || [])
        .filter(c => c.recruiters?.owner_id === req.owner.id);
    }

    res.json({ profile: profile || null });
  } catch (e) { next(e); }
});

router.post('/contacts', async (req, res, next) => {
  try {
    const data = req.body?.data || req.body || {};
    const status = str(data.status, 40) || 'pending';
    if (!STATUSES.has(status)) throw new DbError('Unknown status', 400);

    const recruiterId = await assertOwnsRecruiter(req.owner.id, data.recruiterId);
    const profile = await upsertProfile(data);
    const notes = str(data.notes, 5000);

    const existing = one(await db(
      `contacts?profile_id=${eq(profile.id)}&recruiter_id=${eq(recruiterId)}&select=id`
    ));

    if (existing) {
      await db(`contacts?id=${eq(existing.id)}`, {
        method: 'PATCH',
        body: { status, notes, updated_at: new Date().toISOString() },
      });
      return res.json({ contact: { id: existing.id, status, notes } });
    }

    const rows = await db('contacts', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        profile_id: profile.id,
        recruiter_id: recruiterId,
        status,
        notes,
        contacted_at: new Date().toISOString(),
      },
    });
    res.status(201).json({ contact: one(rows) });
  } catch (e) { next(e); }
});

// Reassign an existing contact to one of your own recruiters. Requires
// ownership of both the contact and the destination recruiter.
router.patch('/contacts/:id/reassign', async (req, res, next) => {
  try {
    const contact = await assertOwnsContact(req.owner.id, str(req.params.id, 60));
    const newRecruiterId = await assertOwnsRecruiter(req.owner.id, req.body?.newRecruiterId);

    await db(`contacts?id=${eq(contact.id)}`, {
      method: 'PATCH',
      body: {
        recruiter_id: newRecruiterId,
        status: 'pending',
        contacted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ─── Highlights ───────────────────────────────────────────────────────────────

router.get('/highlights', async (req, res, next) => {
  try {
    const linkedinId = str(req.query.linkedinId, 200);
    const recruiterId = await assertOwnsRecruiter(req.owner.id, req.query.recruiterId);

    const profile = one(await db(`profiles?linkedin_id=${eq(linkedinId)}&select=id`));
    if (!profile) return res.json({ highlights: [] });

    const rows = await db(
      `highlights?profile_id=${eq(profile.id)}&recruiter_id=${eq(recruiterId)}&order=created_at.desc`
    );
    res.json({ highlights: rows || [] });
  } catch (e) { next(e); }
});

router.post('/highlights', async (req, res, next) => {
  try {
    const data = req.body?.data || req.body || {};
    const recruiterId = await assertOwnsRecruiter(req.owner.id, data.recruiterId);
    const text = str(data.text, 1000);
    if (!text) throw new DbError('Highlight text is required', 400);

    const profile = await upsertProfile({ linkedinId: data.linkedinId });
    const rows = await db('highlights', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        profile_id: profile.id,
        recruiter_id: recruiterId,
        highlighted_text: text,
        color_id: str(data.colorId, 20) || 'yellow',
        note: str(data.note, 2000),
      },
    });
    res.status(201).json({ highlight: one(rows) });
  } catch (e) { next(e); }
});

router.delete('/highlights/:id', async (req, res, next) => {
  try {
    const id = await assertOwnsHighlight(req.owner.id, str(req.params.id, 60));
    await db(`highlights?id=${eq(id)}`, { method: 'DELETE' });
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ─── Keywords ─────────────────────────────────────────────────────────────────

router.get('/keywords', async (req, res, next) => {
  try {
    const rows = await db(
      `keywords?owner_id=${eq(req.owner.id)}&select=id,word,color_id,created_at&order=created_at.desc`
    );
    res.json({ keywords: rows || [] });
  } catch (e) { next(e); }
});

router.post('/keywords', async (req, res, next) => {
  try {
    const word = str(req.body?.word, 100);
    if (!word) throw new DbError('Keyword is required', 400);

    const rows = await db('keywords', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        owner_id: req.owner.id,
        word,
        color_id: str(req.body?.colorId, 20) || 'yellow',
      },
    });
    res.status(201).json({ keyword: one(rows) });
  } catch (e) { next(e); }
});

router.delete('/keywords/:id', async (req, res, next) => {
  try {
    const id = await assertOwnsKeyword(req.owner.id, str(req.params.id, 60));
    await db(`keywords?id=${eq(id)}`, { method: 'DELETE' });
    res.json({ success: true });
  } catch (e) { next(e); }
});

export default router;
