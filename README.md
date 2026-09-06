# LinkedIn Profile Insight — Backend

Sits between the Chrome extension and Supabase. The extension no longer holds
any Supabase credentials; this server holds the `service_role` key and decides
what each signed-in user is allowed to see and do.

## Why this exists

Previously the extension shipped `SUPABASE_URL` and the anon key in
`src/config.js`, and every table had RLS disabled. Anyone with a copy of the
extension folder could read the entire database from a terminal — including the
`owners` table, which stores email addresses and bcrypt password hashes.

Moving to a backend plus RLS closes that. The anon key stops being a master key,
and old installs stop working.

## Setup

```bash
cp .env.example .env      # fill in SUPABASE_SERVICE_KEY
npm install
npm start                 # http://localhost:8080
```

Sanity check: `curl http://localhost:8080/health` → `{"ok":true}`

Run the test suite (uses an in-memory stand-in for Supabase, touches nothing
real):

```bash
node test/run-tests.mjs
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/login` | — | email + password → bearer token |
| POST | `/auth/logout` | token | revoke the current token |
| GET | `/auth/session` | optional | `{session}` or `{session:null}`, never 401 |
| GET | `/api/recruiters` | ✓ | your recruiter accounts |
| POST | `/api/recruiters` | ✓ | add one (`owner_id` from session) |
| GET | `/api/profiles/:linkedinId` | ✓ | profile + contacts |
| POST | `/api/contacts` | ✓ | create or update your contact |
| PATCH | `/api/contacts/:id/reassign` | ✓ | reassign one of your contacts |
| GET/POST | `/api/highlights` | ✓ | list / create |
| DELETE | `/api/highlights/:id` | ✓ | delete your own |
| GET/POST | `/api/keywords` | ✓ | list / create |
| DELETE | `/api/keywords/:id` | ✓ | delete your own |
| GET | `/blocklist/check?url=` | ✓ | proxied Apps Script lookup |

Every `/api` route returns `401 {"error":"AUTH_REQUIRED"}` without a valid token.

## Security model

- **Tokens** are 32 random bytes. Only their SHA-256 hash is stored, so a
  database dump doesn't hand over live sessions. Expiry is enforced on every
  request, and disabling an account in `owners` kills its sessions immediately.
- **Passwords** are compared server side with bcrypt. No hash ever reaches the
  client — the old build downloaded the full owner row to the browser.
- **Ownership** is checked on every write. The extension sends a `recruiterId`,
  which is client-controlled input, so `src/ownership.js` confirms it belongs to
  the caller before anything touches the database. Without that, any signed-in
  user could file contacts under a colleague's name or reassign their leads.
- **`owner_id` always comes from the session**, never from the request body.
- **Login is throttled** in memory (10 attempts per IP+email per 15 min). It
  resets on redeploy and doesn't span instances — add your host's rate limiter
  if this is widely exposed.
- Unknown email and wrong password return the same message, so the endpoint
  can't be used to enumerate accounts.

## The dashboard proxy (`/rest/v1`)

The admin dashboard makes ~53 PostgREST queries across 8 files — pagination,
`.or()` search, embedded joins, exact counts, `head:true`. Rewriting each into a
bespoke endpoint would be a large change with a lot of room for regressions, so
the backend instead exposes a PostgREST-shaped surface the dashboard's existing
`supabase-js` client points at. Every request is authenticated and rewritten by
`src/policies.js` before being forwarded with the service key.

**This file is a security boundary.** The service key bypasses RLS, so a mistake
in `policies.js` or `routes/proxy.js` is a hole in the database.

What the policies enforce today:

- Tables outside the policy list are refused. `auth_sessions` is unreachable.
- `owners.password` is stripped from every response and can't be selected —
  enforced both by rewriting `select` and by filtering the response body, so one
  missed edge case doesn't leak hashes.
- Writes to `owners` (approve, disable, delete) are admin-only. An owner can't
  promote themselves.
- `owner_id` / `user_id` are stamped from the session on insert and rejected on
  update, so records can't be filed under or moved to another owner.
- Deleting a `profiles` row is admin-only — it cascades to *every* recruiter's
  contacts for that person, not just yours.

### Tightening reads

Most reads are scoped `'all'` (any signed-in user), which preserves exactly what
the dashboard does today: team-wide leaderboards, admin cross-owner views, the
`OWNER_PERMISSIONS` list in `accountSlice.js`. The fix here is that "any
signed-in user" replaced "anyone on the internet with the anon key".

If separate customers ever share this database, change `read` to `'own'` on
`recruiters` and `contacts` in `policies.js` and re-test the dashboard — the
leaderboard and admin views will need attention.

## Deploying

Any Node host works. Set the environment variables from `.env.example` in the
host's dashboard — never commit them.

- **Render / Railway / Fly.io**: point at this directory, build `npm install`,
  start `npm start`.
- **Vercel**: needs a serverless wrapper; the in-memory login throttle and
  blocklist cache won't be shared across invocations. Both degrade gracefully.

Whatever you pick, put it behind HTTPS and note the URL — it goes into the
extension's `src/config.js` as `API_BASE_URL`.

## ⚠️ Cutover order

Enabling RLS breaks every old install at once, including login. There is no
partial rollout, so sequence it:

1. Run `sql/01_sessions_and_status.sql` — safe, additive, old build keeps working.
2. Deploy this backend and confirm `/health`.
3. Set `API_BASE_URL` in the extension's `src/config.js`, load it unpacked, and
   test login end to end.
4. Send the new extension folder to your team **with a deadline**. There's no
   Chrome Web Store auto-update here — everyone replaces the folder by hand and
   hits reload on `chrome://extensions`.
5. Run `sql/02_enable_rls.sql`. Old installs stop working now.
6. Rotate the Supabase anon key, then reset the passwords in `owners`. Both have
   been effectively public for as long as the extension has been distributed.

Rollback, if step 5 goes wrong, is at the bottom of `02_enable_rls.sql`.

## Note on statuses

`schema.sql` allows `pending, chatting, interested, rejected, hired, failed,
ghosted`, but the extension's `STATUS_CONFIG` sends `pending, chatting, not
interested, sent js, success, failed, accept, need reconnection`. These don't
match, so your live table has presumably drifted from the committed schema.
`sql/01_sessions_and_status.sql` realigns the constraint with what the extension
actually sends — check your current constraint and data before running it.
