// Policy tests for the PostgREST proxy the dashboard talks to.
// Run: node test/run-proxy-tests.mjs
import { createMock, seed, tables } from './mock-postgrest.mjs';

const mock = createMock();
await new Promise(r => mock.listen(54331, r));
const fx = seed();

// Promote Alice to admin, keep Mallory a plain owner.
tables.owners.find(o => o.id === fx.alice.id).role = 'admin';
tables.owners.find(o => o.id === fx.mallory.id).role = 'owner';
tables.owners.find(o => o.id === fx.mallory.id).status = 'active';

process.env.SUPABASE_URL = 'http://127.0.0.1:54331';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.PORT = '54332';
process.env.ALLOWED_ORIGINS = '';

await import('../src/server.js');
await new Promise(r => setTimeout(r, 400));

const API = 'http://127.0.0.1:54332';
let pass = 0, fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

async function call(path, { method = 'GET', token = null, body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = JSON.parse(await res.text()); } catch {}
  return { status: res.status, data };
}

async function login(email, password) {
  const r = await call('/auth/login', { method: 'POST', body: { email, password } });
  return r.data;
}

const admin = await login('alice@example.com', 'correct-horse');
const owner = await login('mallory@example.com', 'hunter2');

console.log('\n── Session carries a server-side role ──');
check('admin role comes from the database', admin?.session?.role === 'admin');
check('owner role comes from the database', owner?.session?.role === 'owner');

console.log('\n── Unauthenticated ──');
{
  const r = await call('/rest/v1/contacts?select=*');
  check('proxy rejects requests with no token', r.status === 401, `got ${r.status}`);
  const b = await call('/rest/v1/owners?select=*', { token: 'garbage' });
  check('proxy rejects a bogus token', b.status === 401, `got ${b.status}`);
}

console.log('\n── Password hashes never leave the server ──');
{
  const r = await call('/rest/v1/owners?select=*', { token: owner.token });
  check('select=* on owners returns rows', r.status === 200 && r.data.length > 0);
  check('no password field in the response',
    r.data.every(o => !('password' in o)), JSON.stringify(r.data[0] || {}).slice(0, 120));

  const explicit = await call('/rest/v1/owners?select=id,password', { token: owner.token });
  check('explicitly selecting password is refused', explicit.status === 403, `got ${explicit.status}`);

  const embedded = await call('/rest/v1/auth_sessions?select=*,owners(password)', { token: admin.token });
  check('auth_sessions table is unreachable entirely', embedded.status === 403, `got ${embedded.status}`);
}

console.log('\n── Admin-only writes on owners ──');
{
  const target = fx.disabled.id;
  const asOwner = await call(`/rest/v1/owners?id=eq.${target}`, {
    method: 'PATCH', token: owner.token, body: { status: 'active' },
  });
  check('owner cannot approve accounts', asOwner.status === 403, `got ${asOwner.status}`);

  const del = await call(`/rest/v1/owners?id=eq.${target}`, { method: 'DELETE', token: owner.token });
  check('owner cannot delete accounts', del.status === 403, `got ${del.status}`);

  const asAdmin = await call(`/rest/v1/owners?id=eq.${target}`, {
    method: 'PATCH', token: admin.token, body: { status: 'active' },
  });
  check('admin can approve accounts', asAdmin.status < 300, `got ${asAdmin.status}`);
  check('the change actually landed',
    tables.owners.find(o => o.id === target).status === 'active');
}

console.log('\n── Privilege escalation attempts ──');
{
  const self = await call(`/rest/v1/owners?id=eq.${fx.mallory.id}`, {
    method: 'PATCH', token: owner.token, body: { role: 'admin' },
  });
  check('owner cannot promote themselves', self.status === 403, `got ${self.status}`);
  check('role in the database is unchanged',
    tables.owners.find(o => o.id === fx.mallory.id).role === 'owner');

  const reg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Sneak', email: 'sneak@example.com', password: 'password123', role: 'admin', status: 'active' },
  });
  check('signup ignores role and status from the body', reg.status === 201);
  const created = tables.owners.find(o => o.email === 'sneak@example.com');
  check('new account is owner + disabled', created?.role === 'owner' && created?.status === 'disabled');
  check('signup stores a hash, not the password', created?.password !== 'password123');

  const dupe = await call('/auth/register', {
    method: 'POST', body: { name: 'X', email: 'sneak@example.com', password: 'password123' },
  });
  check('duplicate email refused', dupe.status === 409, `got ${dupe.status}`);

  const weak = await call('/auth/register', {
    method: 'POST', body: { name: 'X', email: 'weak@example.com', password: 'short' },
  });
  check('weak password refused', weak.status === 400, `got ${weak.status}`);
}

console.log('\n── Owner-scoped writes ──');
{
  const r = await call('/rest/v1/recruiters', {
    method: 'POST', token: owner.token,
    body: [{ name: 'New Rec', company: 'X', owner_id: fx.alice.id }],
  });
  check('insert succeeds', r.status < 300, `got ${r.status}`);
  const created = tables.recruiters.find(x => x.name === 'New Rec');
  check('owner_id is overwritten with the session owner',
    created?.owner_id === fx.mallory.id, `got ${created?.owner_id}`);

  const steal = await call(`/rest/v1/recruiters?id=eq.${fx.aliceRec.id}`, {
    method: 'PATCH', token: owner.token, body: { owner_id: fx.mallory.id },
  });
  check('cannot reassign a recruiter to yourself', steal.status === 403, `got ${steal.status}`);

  // Scope filter is appended, so a PATCH aimed at someone else's row matches nothing.
  const before = tables.recruiters.find(x => x.id === fx.aliceRec.id).name;
  await call(`/rest/v1/recruiters?id=eq.${fx.aliceRec.id}`, {
    method: 'PATCH', token: owner.token, body: { name: 'HACKED' },
  });
  check("cannot edit another owner's recruiter",
    tables.recruiters.find(x => x.id === fx.aliceRec.id).name === before);
}

console.log('\n── Destructive deletes ──');
{
  const r = await call(`/rest/v1/profiles?id=eq.${fx.profile.id}`, {
    method: 'DELETE', token: owner.token,
  });
  check('owner cannot delete a shared profile', r.status === 403, `got ${r.status}`);
  check('profile still present', tables.profiles.some(p => p.id === fx.profile.id));
}

console.log('\n── Unknown tables ──');
{
  const r = await call('/rest/v1/pg_catalog?select=*', { token: admin.token });
  check('tables outside the policy list are refused', r.status === 403, `got ${r.status}`);
}

console.log('\n── Team-wide reads still work ──');
{
  const r = await call('/rest/v1/contacts?select=*', { token: owner.token });
  check('contacts remain visible team-wide', r.status === 200 && r.data.length > 0);
  const d = await call('/rest/v1/daily_reports?select=*', { token: owner.token });
  check('daily_reports readable for leaderboards', d.status === 200);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
