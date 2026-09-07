// Netlify entry point.
//
// Netlify Functions are Lambdas, not a persistent server, so app.listen() never
// runs here. serverless-http adapts the same Express app to the Lambda event
// shape, meaning the routes, policies and auth code are shared with the
// Railway/Render deployment — there is no second copy to keep in sync.
import serverless from 'serverless-http';
import { app } from '../../src/app.js';

const handler = serverless(app, {
  request(req, event) {
    // With the /* redirect, Netlify usually passes the original path through.
    // Direct hits to /.netlify/functions/api/... arrive with the prefix still
    // attached, so strip it or Express won't match any route.
    const prefix = '/.netlify/functions/api';
    if (req.url.startsWith(prefix)) {
      req.url = req.url.slice(prefix.length) || '/';
    }
  },
});

export { handler };
