// src/server.js
import express from 'express';
import cors from 'cors';
import { ALLOWED_ORIGINS } from './config.js';
import { requireAuth } from './auth.js';
import authRoutes from './routes/auth.js';
import dataRoutes from './routes/data.js';
import blocklistRoutes from './routes/blocklist.js';
import proxyRoutes from './routes/proxy.js';

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
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/api', requireAuth, dataRoutes);

// PostgREST-shaped surface for the admin dashboard. Every request is
// authenticated and rewritten by src/policies.js before it reaches Supabase.
app.use('/rest/v1', requireAuth, proxyRoutes);
app.use('/blocklist', requireAuth, blocklistRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler. Anything without an explicit status is a bug on our side, so
// the client gets a generic message and the detail goes to the logs.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

export { app };
