// src/policies.js
// The dashboard talks PostgREST, so instead of rewriting its ~53 queries we
// forward them — but only after applying the rules below. This is RLS enforced
// in the application layer: the proxy holds the service key, so these policies
// are the only thing deciding who can touch what.
//
// scope values:
//   'all'   — any signed-in user
//   'own'   — rows where <ownColumn> equals the caller's owner id
//   'admin' — role === 'admin' only
//   'none'  — never, via this proxy
//
// Two distinct column lists, easy to confuse:
//   hiddenColumns    — stripped from every response, never readable
//   immutableColumns — readable, but the client may not set them
//
// NOTE ON READS: most reads are 'all', which preserves exactly what the
// dashboard does today (team-wide leaderboards, admin cross-owner views, the
// OWNER_PERMISSIONS list). The critical fix here is that "any signed-in user"
// replaces "anyone on the internet with the anon key". Tightening reads further
// is a product decision — see README, section "Tightening reads".

export const SAFE_OWNER_COLUMNS = 'id,name,email,role,status,created_at';

export const POLICIES = {
  owners: {
    read: 'all',              // needed for owner filters, rank names, report filters
    insert: 'none',           // registration goes through POST /auth/register
    update: 'admin',          // approve / disable accounts
    delete: 'admin',
    ownColumn: 'id',
    // Never let the password hash out, whatever the select says.
    forceSelect: SAFE_OWNER_COLUMNS,
    hiddenColumns: ['password'],
  },

  recruiters: {
    read: 'all',
    insert: 'own',
    update: 'own',
    delete: 'own',
    ownColumn: 'owner_id',
    forceOnInsert: { owner_id: 'session' },
    // Readable — the dashboard uses it for ownership checks — but the client
    // can't set it, so a recruiter can't be reassigned to another owner.
    immutableColumns: ['owner_id'],
  },

  profiles: {
    read: 'all',
    insert: 'all',
    update: 'all',
    // Deleting a profile cascades to EVERY recruiter's contacts for that
    // person, not just yours. Admin-only on purpose — see README.
    delete: 'admin',
    ownColumn: null,
  },

  contacts: {
    read: 'all',              // the whole point of the tool is shared visibility
    insert: 'own',
    update: 'own',
    delete: 'own',
    ownColumn: 'owner_id',
    forceOnInsert: { owner_id: 'session' },
  },

  daily_reports: {
    read: 'all',              // leaderboards are team-wide
    insert: 'own',
    update: 'own',
    delete: 'own',
    ownColumn: 'user_id',
    forceOnInsert: { user_id: 'session' },
  },

  highlights: { read: 'all', insert: 'all', update: 'all', delete: 'all', ownColumn: null },
  keywords:   { read: 'all', insert: 'own', update: 'own', delete: 'own', ownColumn: 'owner_id',
                forceOnInsert: { owner_id: 'session' } },

  // Not reachable through the proxy under any circumstances.
  sessions:      { read: 'none', insert: 'none', update: 'none', delete: 'none', ownColumn: null },
  auth_sessions: { read: 'none', insert: 'none', update: 'none', delete: 'none', ownColumn: null },
};

export function policyFor(table) {
  return Object.prototype.hasOwnProperty.call(POLICIES, table) ? POLICIES[table] : null;
}

export function scopeAllows(scope, role) {
  if (scope === 'none') return false;
  if (scope === 'admin') return role === 'admin';
  return true; // 'all' and 'own' are both permitted; 'own' adds a filter
}
