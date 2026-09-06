// Replays the dashboard's actual query shapes through supabase-js pointed at
// the proxy, to confirm the existing 53 call sites keep working unchanged.
// Run: node test/run-dashboard-tests.mjs
import { createClient } from '@supabase/supabase-js';
import { createMock, seed, tables } from './mock-postgrest.mjs';

const mock = createMock();
await new Promise(r => mock.listen(54341, r));
const fx = seed();
tables.owners.find(o => o.id === fx.alice.id).role = 'admin';
tables.owners.find(o => o.id === fx.mallory.id).role = 'owner';
tables.owners.find(o => o.id === fx.mallory.id).status = 'active';

process.env.SUPABASE_URL = 'http://127.0.0.1:54341';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.PORT = '54342';
process.env.ALLOWED_ORIGINS = '';

await import('../src/server.js');
await new Promise(r => setTimeout(r, 400));

const API = 'http://127.0.0.1:54342';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const login = async (email, password) => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res.json();
};

const admin = await login('alice@example.com', 'correct-horse');
const owner = await login('mallory@example.com', 'hunter2');

// Exactly how src/app/supabaseClient.js builds it in the browser.
const clientFor = token => createClient(API, token, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const asAdmin = clientFor(admin.token);
const asOwner = clientFor(owner.token);

console.log('\n── ownersSlice ──');
{
  const { data, error } = await asAdmin.from('owners')
    .select('id, name, email, role, status, created_at')
    .order('created_at', { ascending: false });
  check('getOwnersContent', !error && Array.isArray(data) && data.length > 0, error?.message);
  check('no password in payload', (data || []).every(o => !('password' in o)));

  const { error: upErr } = await asAdmin.from('owners')
    .update({ status: 'active' }).eq('id', fx.disabled.id)
    .select('id, name, email, role, status, created_at');
  check('updateOwnerStatus as admin', !upErr, upErr?.message);

  const { error: denied } = await asOwner.from('owners')
    .update({ status: 'active' }).eq('id', fx.disabled.id).select('id');
  check('updateOwnerStatus blocked for owner', !!denied);
}

console.log('\n── accountSlice ──');
{
  const { data, error, count } = await asOwner.from('recruiters')
    .select('*', { count: 'exact' })
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(0, 9);
  check('getAccountsContent with exact count', !error && Array.isArray(data), error?.message);
  check('Content-Range survives the proxy', typeof count === 'number', `count=${count}`);

  const { error: searchErr } = await asOwner.from('recruiters')
    .select('*', { count: 'exact' })
    .or('name.ilike.%a%,email.ilike.%a%,company.ilike.%a%')
    .range(0, 9);
  check('search via .or() passes through', !searchErr, searchErr?.message);

  const { data: added, error: addErr } = await asOwner.from('recruiters')
    .insert([{ name: 'Dash Rec', company: 'Acme', email: '' }]).select();
  check('addAccountToDb', !addErr && added?.length === 1, addErr?.message);
  check('owner_id stamped from session', added?.[0]?.owner_id === fx.mallory.id);
}

console.log('\n── candidatesSlice / failedCandidatesSlice ──');
{
  const { data, error, count } = await asOwner.from('contacts')
    .select('*, profiles (*), recruiters (company)', { count: 'exact' })
    .eq('status', 'chatting')
    .order('contacted_at', { ascending: false })
    .range(0, 9);
  check('embedded joins work through the proxy', !error && Array.isArray(data), error?.message);
  check('embedded profiles resolved', !!data?.[0]?.profiles, JSON.stringify(data?.[0] || {}).slice(0, 80));
  check('count header returned', typeof count === 'number');
}

console.log('\n── dailyReportService ──');
{
  const { error } = await asOwner.from('daily_reports')
    .select('*')
    .gte('report_date', '2026-01-01')
    .lte('report_date', '2026-12-31')
    .order('report_date', { ascending: false });
  check('fetchDailyReports', !error, error?.message);

  const { data, error: saveErr } = await asOwner.from('daily_reports')
    .upsert({ user_id: fx.alice.id, report_date: '2026-05-01', connects: 5 },
            { onConflict: 'user_id,report_date' })
    .select();
  check('saveDailyReport upsert', !saveErr, saveErr?.message);
  check('user_id forced to the session owner',
    data?.[0]?.user_id === fx.mallory.id, `got ${data?.[0]?.user_id}`);

  const { error: ownersErr } = await asOwner.from('owners')
    .select('id, name, email, role, status')
    .eq('status', 'active').neq('role', 'admin')
    .order('name', { ascending: true });
  check('fetchOwners', !ownersErr, ownersErr?.message);
}

console.log('\n── dashboardSlice head-count query ──');
{
  const { count, error } = await asOwner.from('contacts')
    .select('id', { count: 'exact', head: true })
    .or(`owner_id.eq.${fx.mallory.id}`);
  check('head:true count query', !error, error?.message);
  check('count is a number', typeof count === 'number', `got ${count}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
