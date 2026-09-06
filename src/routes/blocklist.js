// src/routes/blocklist.js
// Proxies the Google Apps Script blocklist lookup so the extension doesn't call
// it directly, and so the script URL isn't shipped to every install.
import { Router } from 'express';
import { BLOCKLIST_SCRIPT_URL } from '../config.js';

const router = Router();

// Apps Script web apps cold-start slowly and the answer changes rarely, so a
// short in-memory cache keeps the panel responsive.
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

router.get('/check', async (req, res) => {
  const url = String(req.query.url || '').trim();

  if (!BLOCKLIST_SCRIPT_URL || !url) return res.json({ exists: false });
  if (!/^https:\/\/(www\.)?linkedin\.com\/in\//i.test(url)) {
    return res.json({ exists: false });
  }

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return res.json({ exists: hit.exists });

  try {
    const upstream = await fetch(
      `${BLOCKLIST_SCRIPT_URL}?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await upstream.json();
    const exists = data?.exists === true;
    cache.set(url, { exists, at: Date.now() });
    res.json({ exists });
  } catch (e) {
    // A timeout here is expected, not a failure worth surfacing to the user.
    console.warn('[blocklist] lookup skipped:', e.message);
    res.json({ exists: false });
  }
});

export default router;
