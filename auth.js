// ─────────────────────────────────────────────────────────────
// auth.js — token gate for the REST API and the WebSocket handshake
//
// Built as a factory rather than reading process.env at module load so
// tests can exercise both the configured and unconfigured cases without
// mutating the environment.
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

function createAuth(adminToken) {
  const enabled = Boolean(adminToken);

  // Single decision point shared by the HTTP middleware and the socket
  // handshake. Unconfigured means open, which is the local dev default.
  function authorize(supplied) {
    if (!enabled) return true;
    if (typeof supplied !== 'string' || supplied.length === 0) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(adminToken);
    // timingSafeEqual throws on length mismatch, so compare lengths first.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function middleware(req, res, next) {
    if (authorize(req.get('X-Admin-Token'))) return next();
    res.status(401).json({ error: 'Unauthorized' });
  }

  // Browsers cannot set headers on a WebSocket handshake, so the token
  // rides in the query string instead.
  function authorizeSocket(reqUrl, host) {
    if (!enabled) return true;
    try {
      return authorize(new URL(reqUrl, `http://${host || 'localhost'}`).searchParams.get('token'));
    } catch {
      return false;
    }
  }

  return { enabled, authorize, middleware, authorizeSocket };
}

module.exports = { createAuth };
