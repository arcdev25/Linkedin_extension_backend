// Minimal in-memory stand-in for Supabase's PostgREST, just enough to exercise
// the backend's auth and authorization paths in tests. Not part of the deploy.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

export const tables = {
  owners: [],
  sessions: [],
  recruiters: [],
  profiles: [],
  contacts: [],
  highlights: [],
  keywords: [],
  login_attempts: [],
  auth_sessions: [],
  daily_reports: [],
};

export function seed() {
  for (const k of Object.keys(tables)) tables[k] = [];

  const alice = { id: randomUUID(), name: 'Alice', email: 'alice@example.com', password: bcrypt.hashSync('correct-horse', 8), status: 'active' };
  const mallory = { id: randomUUID(), name: 'Mallory', email: 'mallory@example.com', password: bcrypt.hashSync('hunter2', 8), status: 'active' };
  const disabled = { id: randomUUID(), name: 'Dan', email: 'dan@example.com', password: bcrypt.hashSync('letmein', 8), status: 'disabled' };
  tables.owners.push(alice, mallory, disabled);

  const aliceRec = { id: randomUUID(), owner_id: alice.id, name: 'Alice', company: 'TechHunt', email: '' };
  const malloryRec = { id: randomUUID(), owner_id: mallory.id, name: 'Mallory', company: 'Evil', email: '' };
  tables.recruiters.push(aliceRec, malloryRec);

  const profile = { id: randomUUID(), linkedin_id: 'jane-doe', name: 'Jane Doe', headline: 'Engineer', location: '', profile_url: '', avatar_url: '' };
  tables.profiles.push(profile);

  tables.contacts.push({
    id: randomUUID(), profile_id: profile.id, recruiter_id: malloryRec.id,
    status: 'chatting', notes: 'mallory private note', contacted_at: new Date().toISOString(),
  });

  return { alice, mallory, disabled, aliceRec, malloryRec, profile };
}

function parseFilters(query) {
  const filters = [];
  let select = null, limit = null;
  for (const [key, raw] of query.entries()) {
    if (key === 'select') { select = raw; continue; }
    if (key === 'limit') { limit = Number(raw); continue; }
    if (key === 'order' || key === 'on_conflict') continue;
    const eqm = raw.match(/^eq\.(.*)$/);
    if (eqm) { filters.push([key, eqm[1], 'eq']); continue; }
    const gtem = raw.match(/^gte\.(.*)$/);
    if (gtem) filters.push([key, gtem[1], 'gte']);
  }
  return { filters, select, limit };
}

// Expands the few embedded selects the backend actually uses.
function embed(table, row, select) {
  const out = { ...row };
  if (!select) return out;
  if (table === 'auth_sessions' && select.includes('owners(')) {
    out.owners = tables.owners.find(o => o.id === row.owner_id) || null;
  }
  if (table === 'contacts' && select.includes('recruiters')) {
    out.recruiters = tables.recruiters.find(r => r.id === row.recruiter_id) || null;
  }
  if (table === 'contacts' && select.includes('profiles')) {
    out.profiles = tables.profiles.find(p => p.id === row.profile_id) || null;
  }
  if (table === 'highlights' && select.includes('recruiters')) {
    out.recruiters = tables.recruiters.find(r => r.id === row.recruiter_id) || null;
  }
  if (table === 'profiles' && select.includes('contacts(')) {
    out.contacts = tables.contacts
      .filter(c => c.profile_id === row.id)
      .map(c => ({ ...c, recruiters: tables.recruiters.find(r => r.id === c.recruiter_id) || null }));
  }
  return out;
}

export function createMock() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const table = url.pathname.replace('/rest/v1/', '').split('?')[0];
    const { filters, select, limit } = parseFilters(url.searchParams);

    if (!tables[table]) { res.writeHead(404).end('[]'); return; }

    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : null;

    const match = row => filters.every(([k, v, op]) =>
      op === 'gte'
        ? new Date(row[k]).getTime() >= new Date(v).getTime()
        : String(row[k]) === String(v));

    if (req.method === 'GET' || req.method === 'HEAD') {
      const all = tables[table].filter(match);
      let rows = all.map(r => embed(table, r, select));
      if (limit) rows = rows.slice(0, limit);

      const headers = { 'Content-Type': 'application/json' };
      // PostgREST reports totals via Content-Range when Prefer: count=exact.
      if ((req.headers.prefer || '').includes('count=')) {
        headers['Content-Range'] = `0-${Math.max(all.length - 1, 0)}/${all.length}`;
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? '' : JSON.stringify(rows));
      return;
    }

    if (req.method === 'POST') {
      const conflict = url.searchParams.get('on_conflict');
      if (conflict) {
        const existing = tables[table].find(r => r[conflict] === payload[conflict]);
        if (existing) {
          Object.assign(existing, payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([existing]));
          return;
        }
      }
      // PostgREST accepts a single object or an array of them.
      const incoming = Array.isArray(payload) ? payload : [payload];
      const created = incoming.map(p => {
        const row = {
          id: randomUUID(),
          created_at: new Date().toISOString(),
          attempted_at: new Date().toISOString(),
          ...p,
        };
        tables[table].push(row);
        return row;
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(created));
      return;
    }

    if (req.method === 'PATCH') {
      tables[table].filter(match).forEach(r => Object.assign(r, payload));
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'DELETE') {
      tables[table] = tables[table].filter(r => !match(r));
      res.writeHead(204).end();
      return;
    }

    res.writeHead(405).end();
  });
}
