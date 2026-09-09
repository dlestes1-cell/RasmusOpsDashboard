// ─────────────────────────────────────────────────────────────
// auth.js — token gate for the REST API and the WebSocket handshake
//
// Two roles:
//   admin  (ADMIN_TOKEN)  — full access, every method
//   viewer (VIEWER_TOKEN) — GET/HEAD only; mutations get 403
//
// Built as a factory rather than reading process.env at module load so
// tests can exercise every combination without mutating the environment.
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

const READ_METHODS = new Set(['GET', 'HEAD']);

function createAuth(adminToken, viewerToken) {
  // ADMIN_TOKEN alone arms the gate. A VIEWER_TOKEN with no ADMIN_TOKEN would
  // leave no way in at full privilege, so it is ignored in that case — as is a
  // viewer token that duplicates the admin one, which would silently demote it.
  const enabled = Boolean(adminToken);
  const viewer  = enabled && viewerToken && viewerToken !== adminToken ? viewerToken : null;

  function matches(supplied, expected) {
    if (!expected) return false;
    if (typeof supplied !== 'string' || supplied.length === 0) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    // timingSafeEqual throws on length mismatch, so compare lengths first.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // 'open' when unconfigured, otherwise 'admin' | 'viewer' | null.
  function roleFor(supplied) {
    if (!enabled) return 'open';
    if (matches(supplied, adminToken)) return 'admin';
    if (matches(supplied, viewer))     return 'viewer';
    return null;
  }

  function authorize(supplied) {
    return roleFor(supplied) !== null;
  }

  function middleware(req, res, next) {
    const role = roleFor(req.get('X-Admin-Token'));
    if (!role) return res.status(401).json({ error: 'Unauthorized' });
    if (role === 'viewer' && !READ_METHODS.has(req.method)) {
      return res.status(403).json({ error: 'Read-only access — this action needs the full token' });
    }
    req.authRole = role;
    next();
  }

  // Browsers cannot set headers on a WebSocket handshake, so the token rides
  // in the query string. The socket is read-only by nature, so either role
  // may connect.
  function authorizeSocket(reqUrl, host) {
    if (!enabled) return true;
    try {
      return authorize(new URL(reqUrl, `http://${host || 'localhost'}`).searchParams.get('token'));
    } catch {
      return false;
    }
  }

  return { enabled, roleFor, authorize, middleware, authorizeSocket };
}

module.exports = { createAuth };
