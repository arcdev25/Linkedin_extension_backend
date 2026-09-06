// src/ownership.js
// The extension sends a recruiter id with most writes. That id is client-side
// input, so before it reaches the database we confirm it actually belongs to
// the signed-in owner — otherwise anyone could file contacts under a
// colleague's name, or reassign their leads away.
import { db, eq, one, DbError } from './db.js';

export async function assertOwnsRecruiter(ownerId, recruiterId) {
  if (!recruiterId) throw new DbError('recruiterId is required', 400);

  const row = one(await db(
    `recruiters?id=${eq(recruiterId)}&owner_id=${eq(ownerId)}&select=id`
  ));
  if (!row) throw new DbError('Recruiter not found', 404);
  return row.id;
}

export async function assertOwnsHighlight(ownerId, highlightId) {
  const row = one(await db(
    `highlights?id=${eq(highlightId)}&select=id,recruiters!inner(owner_id)`
  ));
  if (!row || row.recruiters?.owner_id !== ownerId) {
    throw new DbError('Highlight not found', 404);
  }
  return row.id;
}

export async function assertOwnsKeyword(ownerId, keywordId) {
  const row = one(await db(
    `keywords?id=${eq(keywordId)}&owner_id=${eq(ownerId)}&select=id`
  ));
  if (!row) throw new DbError('Keyword not found', 404);
  return row.id;
}

// Contacts are visible team-wide, but only the owning recruiter's owner may
// reassign one.
export async function assertOwnsContact(ownerId, contactId) {
  const row = one(await db(
    `contacts?id=${eq(contactId)}&select=id,recruiter_id,recruiters!inner(owner_id)`
  ));
  if (!row || row.recruiters?.owner_id !== ownerId) {
    throw new DbError('Contact not found', 404);
  }
  return row;
}
