// Entry point for a persistent host (Railway, Render, Fly, local dev).
// Netlify uses netlify/functions/api.js instead, which imports the same app.
import { app } from './app.js';
import { PORT, ALLOWED_ORIGINS } from './config.js';

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn('[server] ALLOWED_ORIGINS is empty — all origins accepted. Set it in production.');
  }
});
