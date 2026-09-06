-- ============================================================
-- 01 — Auth sessions + status constraint
-- Run this FIRST, before deploying the backend.
-- Safe to run while the old extension and dashboard are still in use.
-- ============================================================

-- ── Server-issued session tokens ──────────────────────────────────────────────
-- NOTE: your database already has a `sessions` table (from
-- COMPLETE_SUPABASE_SCHEMA.sql) with a NOT NULL `token` column. This uses a
-- SEPARATE table on purpose — `CREATE TABLE IF NOT EXISTS sessions` would have
-- silently done nothing, leaving no `token_hash` column, and every login would
-- have failed with a confusing error.
--
-- Only the SHA-256 hash of each token is stored, so a database dump does not
-- hand over usable sessions.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_owner_id   ON auth_sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

-- Housekeeping (optional — expired tokens are rejected in code anyway):
--   DELETE FROM auth_sessions WHERE expires_at < now();

-- The old `sessions` table appears unused by both apps. Once you've confirmed
-- that, drop it so it isn't mistaken for the live one:
--   DROP TABLE IF EXISTS sessions;


-- ── daily_reports ─────────────────────────────────────────────────────────────
-- Used by the dashboard but absent from every committed schema file, so it was
-- presumably created by hand. Confirm it exists before running migration 02 —
-- it needs RLS like everything else:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'daily_reports';


-- ── Status values ─────────────────────────────────────────────────────────────
-- Check what you have first:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conrelid = 'contacts'::regclass;
--
--   SELECT status, count(*) FROM contacts GROUP BY status ORDER BY count DESC;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_status_check;

ALTER TABLE contacts ADD CONSTRAINT contacts_status_check
  CHECK (status IN (
    'pending', 'chatting', 'not interested', 'sent js',
    'success', 'failed', 'accept', 'need reconnection'
  ));

-- If the ALTER fails because existing rows hold old values, map them first,
-- adjusting to your own meaning, then re-run the ADD CONSTRAINT above:
--   UPDATE contacts SET status = 'not interested' WHERE status = 'rejected';
--   UPDATE contacts SET status = 'success'        WHERE status IN ('hired', 'interested');
--   UPDATE contacts SET status = 'failed'         WHERE status = 'ghosted';
