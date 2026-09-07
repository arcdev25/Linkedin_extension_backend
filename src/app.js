// src/server.js
import express from 'express';
import cors from 'cors';
import { ALLOWED_ORIGINS } from './config.js';
import { requireAuth } from './auth.js';
import authRoutes from './routes/auth.js';
import dataRoutes from './routes/data.js';
import blocklistRoutes from './routes/blocklist.js';
import proxyRoutes from './routes/proxy.js';
import healthRoutes from './routes/health.js';

// Netlify's function bundler can transpile these ES modules to CommonJS. When
// it does, a default export arrives wrapped as { default: fn } and Express
// throws "Router.use() requires a middleware function but got a Object".
// Unwrapping here keeps one codebase working under both module systems.
const mw = m => (typeof m === 'function' ? m : m?.default);

const app = express();

app.set('trust proxy', 1); // so req.ip is the real client behind a proxy/CDN
app.disable('x-powered-by');

app.use(cors({
  origin(origin, cb) {
    // Requests from the extension's service worker may have no Origin header.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // dev default
    return cb(null, ALLOWED_ORIGINS.includes(origin));
  },
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],

  // Reflect whatever headers the browser asks for in the preflight, rather than
  // maintaining a fixed list. supabase-js sends a moving set — x-client-info,
  // x-retry-count, x-supabase-api-version — and each one missing from an
  // allowlist fails the preflight with an error that names CORS but is really
  // just a missing header name.
  //
  // This is not a weakening: the ORIGIN allowlist above is what decides who may
  // talk to this API, and it still applies. Which request headers a permitted
  // origin may send is not a security boundary — the bearer token is.
  // (Omitting `allowedHeaders` makes the cors package echo
  // Access-Control-Request-Headers.)

  // Response headers must be explicitly exposed or JavaScript cannot read them.
  // Content-Range carries the row count for `{ count: 'exact' }` queries —
  // without it every paginated table in the dashboard shows a null total.
  exposedHeaders: ['Content-Range', 'Content-Profile', 'Preference-Applied'],

  maxAge: 86400,
}));

app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/health', mw(healthRoutes));

app.use('/auth', mw(authRoutes));
app.use('/api', requireAuth, mw(dataRoutes));

// PostgREST-shaped surface for the admin dashboard. Every request is
// authenticated and rewritten by src/policies.js before it reaches Supabase.
app.use('/rest/v1', requireAuth, mw(proxyRoutes));
app.use('/blocklist', requireAuth, mw(blocklistRoutes));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler. Anything without an explicit status is a bug on our side, so
// the client gets a generic message and the detail goes to the logs.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

export { app };
