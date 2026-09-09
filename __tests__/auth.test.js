const { createAuth } = require('../auth');

const TOKEN = 'correct-horse-battery-staple';

// Minimal express req/res doubles — enough for the middleware contract.
function mockReq(headerValue, method = 'GET') {
  return { method, get: (name) => (name === 'X-Admin-Token' ? headerValue : undefined) };
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

function runMiddleware(auth, headerValue, method = 'GET') {
  const res = mockRes();
  const req = mockReq(headerValue, method);
  let nextCalled = false;
  auth.middleware(req, res, () => { nextCalled = true; });
  return { nextCalled, res, req };
}

// ── Configured (ADMIN_TOKEN set) ─────────────────────────────────

describe('auth — token configured', () => {
  let auth;
  beforeEach(() => { auth = createAuth(TOKEN); });

  test('reports itself as enabled', () => {
    expect(auth.enabled).toBe(true);
  });

  test('authorizes the exact token', () => {
    expect(auth.authorize(TOKEN)).toBe(true);
  });

  test('rejects a wrong token of equal length', () => {
    const wrong = 'x'.repeat(TOKEN.length);
    expect(wrong.length).toBe(TOKEN.length);
    expect(auth.authorize(wrong)).toBe(false);
  });

  test('rejects a token that is a prefix of the real one', () => {
    expect(auth.authorize(TOKEN.slice(0, -1))).toBe(false);
  });

  test('rejects a token that extends the real one', () => {
    expect(auth.authorize(TOKEN + 'x')).toBe(false);
  });

  test('rejects empty, missing, and non-string values without throwing', () => {
    for (const bad of ['', undefined, null, 0, {}, [], true]) {
      expect(auth.authorize(bad)).toBe(false);
    }
  });

  test('is case-sensitive', () => {
    expect(auth.authorize(TOKEN.toUpperCase())).toBe(false);
  });

  test('middleware calls next() with the correct header', () => {
    const { nextCalled, res } = runMiddleware(auth, TOKEN);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  test('middleware 401s with a wrong header', () => {
    const { nextCalled, res } = runMiddleware(auth, 'nope');
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  test('middleware 401s when the header is absent', () => {
    const { nextCalled, res } = runMiddleware(auth, undefined);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

// ── WebSocket handshake ──────────────────────────────────────────

describe('auth — websocket handshake', () => {
  let auth;
  beforeEach(() => { auth = createAuth(TOKEN); });

  test('accepts a correct token in the query string', () => {
    expect(auth.authorizeSocket(`/?token=${TOKEN}`, 'localhost:3000')).toBe(true);
  });

  test('accepts a url-encoded token', () => {
    const spicy = createAuth('a b&c=d');
    expect(spicy.authorizeSocket(`/?token=${encodeURIComponent('a b&c=d')}`, 'h')).toBe(true);
  });

  test('rejects a wrong token', () => {
    expect(auth.authorizeSocket('/?token=wrong', 'localhost:3000')).toBe(false);
  });

  test('rejects a handshake with no token at all', () => {
    expect(auth.authorizeSocket('/', 'localhost:3000')).toBe(false);
  });

  test('rejects an empty token param', () => {
    expect(auth.authorizeSocket('/?token=', 'localhost:3000')).toBe(false);
  });

  test('ignores other query params', () => {
    expect(auth.authorizeSocket(`/?a=1&token=${TOKEN}&b=2`, 'h')).toBe(true);
  });

  test('rejects rather than throws on a malformed url', () => {
    expect(auth.authorizeSocket('://::malformed', undefined)).toBe(false);
  });

  test('survives a missing host header', () => {
    expect(auth.authorizeSocket(`/?token=${TOKEN}`, undefined)).toBe(true);
  });
});

// ── Viewer role ──────────────────────────────────────────────────

const VIEWER = 'viewer-token-9f3a';

describe('auth — viewer role', () => {
  let auth;
  beforeEach(() => { auth = createAuth(TOKEN, VIEWER); });

  test('classifies each token', () => {
    expect(auth.roleFor(TOKEN)).toBe('admin');
    expect(auth.roleFor(VIEWER)).toBe('viewer');
    expect(auth.roleFor('neither')).toBeNull();
  });

  test.each(['GET', 'HEAD'])('viewer may %s', (method) => {
    const { nextCalled, res, req } = runMiddleware(auth, VIEWER, method);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
    expect(req.authRole).toBe('viewer');
  });

  test.each(['POST', 'PATCH', 'DELETE', 'PUT'])('viewer is 403d on %s', (method) => {
    const { nextCalled, res } = runMiddleware(auth, VIEWER, method);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/read-only/i);
  });

  test.each(['GET', 'POST', 'PATCH', 'DELETE'])('admin may still %s', (method) => {
    const { nextCalled, req } = runMiddleware(auth, TOKEN, method);
    expect(nextCalled).toBe(true);
    expect(req.authRole).toBe('admin');
  });

  test('an unknown token is 401, not 403, even on a mutation', () => {
    const { res } = runMiddleware(auth, 'bogus', 'POST');
    expect(res.statusCode).toBe(401);
  });

  test('viewer may open the websocket', () => {
    expect(auth.authorizeSocket(`/?token=${VIEWER}`, 'h')).toBe(true);
  });

  test('a viewer token identical to the admin token is ignored, not demoted', () => {
    const same = createAuth(TOKEN, TOKEN);
    expect(same.roleFor(TOKEN)).toBe('admin');
    expect(runMiddleware(same, TOKEN, 'POST').nextCalled).toBe(true);
  });

  test('a viewer token without an admin token does not arm the gate', () => {
    const viewerOnly = createAuth(undefined, VIEWER);
    expect(viewerOnly.enabled).toBe(false);
    expect(viewerOnly.roleFor(VIEWER)).toBe('open');
    expect(runMiddleware(viewerOnly, undefined, 'POST').nextCalled).toBe(true);
  });

  test('with no viewer token configured, only admin is accepted', () => {
    const adminOnly = createAuth(TOKEN);
    expect(adminOnly.roleFor(VIEWER)).toBeNull();
    expect(adminOnly.roleFor(TOKEN)).toBe('admin');
  });
});

// ── Unconfigured (local dev default) ─────────────────────────────

describe('auth — token not configured', () => {
  test.each([undefined, null, ''])('is disabled and open for %p', (value) => {
    const auth = createAuth(value);
    expect(auth.enabled).toBe(false);
    expect(auth.authorize(undefined)).toBe(true);
    expect(auth.authorize('anything')).toBe(true);
    expect(auth.authorizeSocket('/', 'h')).toBe(true);
    expect(runMiddleware(auth, undefined).nextCalled).toBe(true);
  });
});
