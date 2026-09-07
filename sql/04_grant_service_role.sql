-- ============================================================
-- 04 — Diagnose and fix "permission denied" (HTTP 403) for the backend
-- ============================================================
--
-- Symptom: GET /health/db returns 403 on every table, while a bearer-only
-- request returns 401. That difference matters:
--   401 = the key isn't recognised  → wrong or truncated key
--   403 = the key IS recognised, but its role lacks privileges → this file
--
-- Run the SELECTs first. Only run the GRANTs if the SELECTs show what you
-- expect — don't paste privilege changes into a live database blind.


-- ── 1. Which role does the API map to, and what can it touch? ────────────────
SELECT grantee, table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'service_role')
GROUP BY grantee, table_name
ORDER BY grantee, table_name;

-- If `service_role` is absent or missing tables here, that's your 403.
-- If `anon` has grants and `service_role` doesn't, the old extension worked
-- while the new backend can't — exactly the pattern you're seeing.


-- ── 2. Is the public schema exposed to the Data API? ─────────────────────────
-- Dashboard: Settings → API (or Integrations → Data API) → "Exposed schemas".
-- `public` must be listed. If it isn't, every table 403s no matter what
-- grants exist.
SELECT nspname AS schema, has_schema_privilege('service_role', nspname, 'USAGE') AS service_role_can_use
FROM pg_namespace
WHERE nspname = 'public';


-- ── 3. Grant what's missing ──────────────────────────────────────────────────
-- Only run this after the queries above confirm service_role is short on
-- privileges. It grants the service role normal access to the public schema.

GRANT USAGE ON SCHEMA public TO service_role;

GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Cover tables created later (e.g. by migration 03):
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;


-- ── 4. Re-check ──────────────────────────────────────────────────────────────
-- Re-run query 1. service_role should now appear for every table. Then reload
-- /health/db — it should report "All checks passed."

-- NOTE: this grants privileges to the role your backend uses. It does NOT
-- expose anything to the anon/publishable key, and it does not affect the RLS
-- cutover in 02_enable_rls.sql — service_role bypasses RLS by design, which is
-- precisely why only your server may hold this key.
