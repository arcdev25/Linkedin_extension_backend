-- ============================================================
-- 02 — Enable Row Level Security  ⚠️  THE CUTOVER STEP
-- ============================================================
--
-- This is the statement that actually stops the old extension AND the old
-- dashboard bundle. Until you run
-- it, the anon key shipped in every previous install can still read and write
-- everything, and the backend changes nothing.
--
-- RUN THIS ONLY AFTER:
--   1. The backend is deployed and healthy
--   2. The new extension is built and tested against it
--   3. The new dashboard is deployed to Vercel and tested (login, signup,
--      owners admin, candidates, reports, rank)
--   4. Your whole team has installed the new extension version
--
-- The moment this runs, every old install breaks — including login, since the
-- old build reads the `owners` table directly. There is no partial rollout.
--
-- How it works: the backend connects with the service_role key, which bypasses
-- RLS entirely. The old extension holds only the anon key. With RLS enabled and
-- no policy granting anon anything, anon reads return zero rows and writes are
-- refused.
-- ============================================================

ALTER TABLE owners     ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruiters ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;
ALTER TABLE keywords   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions    ENABLE ROW LEVEL SECURITY;

-- Used by the dashboard's reports and leaderboards. Not in any committed schema
-- file, so confirm it exists before running this:
ALTER TABLE daily_reports    ENABLE ROW LEVEL SECURITY;

-- Import scratch table from COMPLETE_SUPABASE_SCHEMA.sql:
ALTER TABLE staging_contacts ENABLE ROW LEVEL SECURITY;

-- Deliberately no policies. No policy means no access for anon or authenticated
-- roles. Only service_role gets through, and only the backend holds that key.

-- Drop anything permissive left over from earlier experiments:
-- DROP POLICY IF EXISTS "allow all" ON contacts;
-- (repeat per table as needed)

-- Verify — rowsecurity should be true for every row:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public'
--   ORDER BY tablename;

-- Confirm the lockout from a terminal. With RLS on, this returns [] instead of
-- your contacts. Substitute your real anon key:
--   curl "https://YOUR-PROJECT.supabase.co/rest/v1/contacts?select=*" \
--     -H "apikey: YOUR_ANON_KEY" \
--     -H "Authorization: Bearer YOUR_ANON_KEY"

-- ── Afterwards ────────────────────────────────────────────────────────────────
-- Rotate the anon key (Supabase → Settings → API). The old key has been sitting
-- in plain text inside every copy of the extension you ever distributed, so
-- treat it as public. Rotating before RLS is on accomplishes nothing, since the
-- replacement would ship in the next build too — but once the extension no
-- longer holds any Supabase key at all, rotation closes the door for good.
--
-- Also rotate the passwords in `owners`. Every bcrypt hash in that table has
-- been readable with the anon key for as long as the extension has existed.

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- If something goes wrong at cutover and you need the old build working again:
--   ALTER TABLE owners     DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE recruiters DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE profiles   DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE contacts   DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE highlights DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE keywords   DISABLE ROW LEVEL SECURITY;
