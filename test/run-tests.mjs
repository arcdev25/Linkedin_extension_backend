// End-to-end checks against the real backend, backed by the in-memory mock.
// Run: node test/run-tests.mjs
import { createMock, seed, tables } from './mock-postgrest.mjs';

const mock = createMock();
await new Promise(r => mock.listen(54321, r));
const fixtures = seed();

process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.PORT = '54322';
process.env.ALLOWED_ORIGINS = '';

await import('../src/server.js');
await new Promise(r => setTimeout(r, 400));

const API = 'http://127.0.0.1:54322';
let pass = 0, fail = 0;

async function call(path, { method = 'GET', token = null, body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

console.log('\n── Unauthenticated access ──');
for (const path of ['/api/recruiters', '/api/profiles/jane-doe', '/api/keywords', '/blocklist/check?url=x']) {
  const r = await call(path);
  check(`${path} → 401`, r.status === 401 && r.data?.error === 'AUTH_REQUIRED', `got ${r.status}`);
}
{
  const r = await call('/api/contacts', { method: 'POST', body: { data: { linkedinId: 'x', status: 'pending' } } });
  check('POST /api/contacts → 401', r.status === 401, `got ${r.status}`);
  const bad = await call('/api/recruiters', { token: 'not-a-real-token' });
  check('garbage token → 401', bad.status === 401, `got ${bad.status}`);
}

console.log('\n── Login ──');
{
  const wrong = await call('/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: 'nope' } });
  check('wrong password → 401', wrong.status === 401, `got ${wrong.status}`);

  const unknown = await call('/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'x' } });
  check('unknown email → 401, same message', unknown.status === 401 && unknown.data.error === wrong.data.error);

  const disabled = await call('/auth/login', { method: 'POST', body: { email: 'dan@example.com', password: 'letmein' } });
  check('disabled account → 403', disabled.status === 403, `got ${disabled.status}`);
}

const alice = (await call('/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: 'correct-horse' } })).data;
const mallory = (await call('/auth/login', { method: 'POST', body: { email: 'MALLORY@example.com', password: 'hunter2' } })).data;
check('valid login returns a token', !!alice?.token);
check('email match is case-insensitive', !!mallory?.token);
check('login response carries no password field', !('password' in (alice?.session || {})));
check('token is not stored in plaintext', tables.auth_sessions.every(s => s.token_hash !== alice.token));

console.log('\n── Authenticated reads ──');
{
  const r = await call('/api/recruiters', { token: alice.token });
  check('alice sees only her own recruiters',
    r.status === 200 && r.data.recruiters.length === 1 && r.data.recruiters[0].owner_id === fixtures.alice.id);

  const p = await call('/api/profiles/jane-doe', { token: alice.token });
  check('profile lookup succeeds', p.status === 200 && p.data.profile?.linkedin_id === 'jane-doe');
  check('contacts visible team-wide (CONTACT_SCOPE=global)', p.data.profile.contacts.length === 1);
}

console.log('\n── Cross-owner authorization ──');
{
  // Mallory's recruiter id is not Alice's to write under.
  const r = await call('/api/contacts', {
    method: 'POST', token: alice.token,
    body: { data: { linkedinId: 'jane-doe', recruiterId: fixtures.malloryRec.id, status: 'pending', notes: 'x' } },
  });
  check('cannot file a contact under another owner\'s recruiter', r.status === 404, `got ${r.status}`);

  const reassign = await call(`/api/contacts/${tables.contacts[0].id}/reassign`, {
    method: 'PATCH', token: alice.token, body: { newRecruiterId: fixtures.aliceRec.id },
  });
  check('cannot steal another owner\'s contact', reassign.status === 404, `got ${reassign.status}`);

  const hl = await call(`/api/highlights?linkedinId=jane-doe&recruiterId=${fixtures.malloryRec.id}`, { token: alice.token });
  check('cannot read highlights for another owner\'s recruiter', hl.status === 404, `got ${hl.status}`);
}

console.log('\n── Writes under your own recruiter ──');
{
  const r = await call('/api/contacts', {
    method: 'POST', token: alice.token,
    body: { data: { linkedinId: 'jane-doe', name: 'Jane Doe', recruiterId: fixtures.aliceRec.id, status: 'chatting', notes: 'hello' } },
  });
  check('contact created', r.status === 201, `got ${r.status}`);

  const bad = await call('/api/contacts', {
    method: 'POST', token: alice.token,
    body: { data: { linkedinId: 'jane-doe', recruiterId: fixtures.aliceRec.id, status: 'definitely-not-valid' } },
  });
  check('invalid status rejected', bad.status === 400, `got ${bad.status}`);

  const kw = await call('/api/keywords', { method: 'POST', token: alice.token, body: { word: 'rust', colorId: 'green' } });
  check('keyword created', kw.status === 201);
  check('keyword bound to session owner, not request body', kw.data.keyword.owner_id === fixtures.alice.id);

  const mKw = await call(`/api/keywords/${kw.data.keyword.id}`, { method: 'DELETE', token: mallory.token });
  check('cannot delete another owner\'s keyword', mKw.status === 404, `got ${mKw.status}`);
}

console.log('\n── Recruiter creation binds to session ──');
{
  const r = await call('/api/recruiters', {
    method: 'POST', token: alice.token,
    body: { name: 'Sneaky', owner_id: fixtures.mallory.id },
  });
  check('owner_id in body is ignored', r.status === 201 && r.data.recruiter.owner_id === fixtures.alice.id);
}

console.log('\n── Logout ──');
{
  const out = await call('/auth/logout', { method: 'POST', token: alice.token });
  check('logout succeeds', out.status === 200);
  const after = await call('/api/recruiters', { token: alice.token });
  check('token dead after logout', after.status === 401, `got ${after.status}`);
  const sess = await call('/auth/session', { token: alice.token });
  check('/auth/session reports null, not 401', sess.status === 200 && sess.data.session === null);
}

console.log('\n── Disabled mid-session ──');
{
  const owner = tables.owners.find(o => o.id === fixtures.mallory.id);
  owner.status = 'disabled';
  const r = await call('/api/recruiters', { token: mallory.token });
  check('disabling an account kills live sessions', r.status === 401, `got ${r.status}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
