-- ============================================================
-- 03 — Login attempt throttling
-- Safe to run any time. Required if you deploy to a serverless host
-- (Netlify, Vercel), optional but recommended on a persistent one.
-- ============================================================

-- The login throttle used to live in memory. That works on a single
-- long-running server, but serverless invocations don't share memory and
-- instances come and go — so an attacker spreading attempts across cold starts
-- gets a far higher effective limit than the intended 10 per 15 minutes.
--
-- If you skip this table, logins still work: the backend logs a warning and
-- runs without throttling rather than locking everyone out.

CREATE TABLE IF NOT EXISTS login_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL,           -- "<ip>:<email>"
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_key_time
  ON login_attempts(key, attempted_at DESC);

-- Successful logins clear their own rows. Old failures accumulate, so prune
-- them periodically (Supabase → Integrations → Cron, or by hand):
--   DELETE FROM login_attempts WHERE attempted_at < now() - interval '1 day';

-- Include this table when you run migration 02:
--   ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
