// src/config.js
// Central place for every environment-supplied setting. The service key is the
// only credential that can bypass Supabase RLS, so it lives here and nowhere
// near anything that gets shipped to a browser.
import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export const SUPABASE_URL = required('SUPABASE_URL').replace(/\/+$/, '');
export const SUPABASE_SERVICE_KEY = required('SUPABASE_SERVICE_KEY');

export const PORT = Number(process.env.PORT || 8080);

// Comma-separated list of allowed origins. Chrome extensions send
// `chrome-extension://<id>` — put your unpacked extension's ID here.
// Example: ALLOWED_ORIGINS=chrome-extension://abcdefghijklmnop,https://your-signup-page.vercel.app
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// How long a login lasts before the user must sign in again.
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);

// Who can see a given profile's outreach history:
//   'global' — every signed-in user sees every recruiter's contacts.
//              This is what the extension did before, so it's the default.
//   'owner'  — a user only sees contacts belonging to their own recruiters.
// Pick 'owner' if separate customers share one database and shouldn't see
// each other's pipelines.
export const CONTACT_SCOPE = process.env.CONTACT_SCOPE === 'owner' ? 'owner' : 'global';

// Google Apps Script endpoint used for the blocklist check. Proxied so the
// extension never talks to it directly.
export const BLOCKLIST_SCRIPT_URL = process.env.BLOCKLIST_SCRIPT_URL || '';

// Upstream timeout for Supabase calls. Keep this comfortably below your host's
// own request limit — Netlify Functions cut off around 10s on the free tier,
// so a longer timeout here would never get the chance to fire.
export const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 8000);
