// EMAIL_ALLOWED_DOMAINS is read at module load, so each block re-requires
// gmail.js after setting the env it needs.
let gmail;

function loadGmail(allowedDomains) {
  jest.resetModules();
  if (allowedDomains === undefined) delete process.env.EMAIL_ALLOWED_DOMAINS;
  else process.env.EMAIL_ALLOWED_DOMAINS = allowedDomains;
  return require('../tasks/gmail');
}

// ── Default domain allowlist ─────────────────────────────────────

describe('isAllowedRecipient — default domain', () => {
  beforeEach(() => {
    gmail = loadGmail(undefined);
    gmail.setKnownRecipients(() => []);
  });

  test('allows a bare rasmus.com address', () => {
    expect(gmail.isAllowedRecipient('destes@rasmus.com')).toBe(true);
  });

  test('allows a display-name form', () => {
    expect(gmail.isAllowedRecipient('Karen Kester <kkester@rasmus.com>')).toBe(true);
  });

  test('is case-insensitive on the domain', () => {
    expect(gmail.isAllowedRecipient('Destes@RASMUS.com')).toBe(true);
  });

  test('tolerates surrounding whitespace', () => {
    expect(gmail.isAllowedRecipient('  destes@rasmus.com  ')).toBe(true);
  });

  test('blocks arbitrary external domains', () => {
    expect(gmail.isAllowedRecipient('attacker@evil.com')).toBe(false);
    expect(gmail.isAllowedRecipient('victim@gmail.com')).toBe(false);
  });

  test('blocks a domain-suffix spoof', () => {
    expect(gmail.isAllowedRecipient('x@rasmus.com.evil.com')).toBe(false);
  });

  test('blocks a subdomain that is not explicitly allowed', () => {
    expect(gmail.isAllowedRecipient('x@mail.rasmus.com')).toBe(false);
  });

  test('blocks the domain used as a local part', () => {
    expect(gmail.isAllowedRecipient('rasmus.com@evil.com')).toBe(false);
  });

  test('blocks malformed and empty values without throwing', () => {
    for (const bad of ['', '   ', 'not-an-email', null, undefined, 0, {}, []]) {
      expect(gmail.isAllowedRecipient(bad)).toBe(false);
    }
  });

  test('uses the last @ when the display name contains one', () => {
    expect(gmail.isAllowedRecipient('"a@evil.com" <real@rasmus.com>')).toBe(true);
  });
});

// ── Known recipients from app state ──────────────────────────────

describe('isAllowedRecipient — known synced contacts', () => {
  beforeEach(() => {
    gmail = loadGmail(undefined);
    gmail.setKnownRecipients(() => ['seller@hendersonestate.com', 'Bob <bob@coastal.org>', '', null]);
  });

  test('allows an external address present in state', () => {
    expect(gmail.isAllowedRecipient('seller@hendersonestate.com')).toBe(true);
  });

  test('matches a known contact case-insensitively', () => {
    expect(gmail.isAllowedRecipient('SELLER@HendersonEstate.com')).toBe(true);
  });

  test('matches a known contact stored in display-name form', () => {
    expect(gmail.isAllowedRecipient('bob@coastal.org')).toBe(true);
  });

  test('still blocks externals absent from state', () => {
    expect(gmail.isAllowedRecipient('attacker@evil.com')).toBe(false);
  });

  test('ignores empty entries in the known list', () => {
    expect(gmail.isAllowedRecipient('')).toBe(false);
  });

  test('reflects state changes on each call', () => {
    expect(gmail.isAllowedRecipient('later@added.com')).toBe(false);
    gmail.setKnownRecipients(() => ['later@added.com']);
    expect(gmail.isAllowedRecipient('later@added.com')).toBe(true);
  });

  test('defaults to no known recipients when never registered', () => {
    const fresh = loadGmail(undefined);
    expect(fresh.isAllowedRecipient('seller@hendersonestate.com')).toBe(false);
  });
});

// ── Configurable domains ─────────────────────────────────────────

describe('isAllowedRecipient — EMAIL_ALLOWED_DOMAINS override', () => {
  test('honours a multi-domain list with whitespace and casing', () => {
    gmail = loadGmail(' rasmus.com , Partner.CO ');
    gmail.setKnownRecipients(() => []);
    expect(gmail.isAllowedRecipient('a@rasmus.com')).toBe(true);
    expect(gmail.isAllowedRecipient('b@partner.co')).toBe(true);
    expect(gmail.isAllowedRecipient('c@evil.com')).toBe(false);
  });

  // Blanking the var falls back to the rasmus.com default rather than
  // allowing nothing, so an operator cannot silently kill the daily digest.
  test('an empty override falls back to the rasmus.com default', () => {
    gmail = loadGmail('');
    gmail.setKnownRecipients(() => []);
    expect(gmail.isAllowedRecipient('a@rasmus.com')).toBe(true);
    expect(gmail.isAllowedRecipient('a@evil.com')).toBe(false);
  });
});

// ── Send/draft guards ────────────────────────────────────────────

describe('sendEmail / createDraft guards', () => {
  beforeEach(() => {
    gmail = loadGmail(undefined);
    gmail.setKnownRecipients(() => []);
    // No Gmail credentials in test env, so a blocked send must fail on the
    // allowlist before any network call is attempted.
    global.fetch = jest.fn(() => { throw new Error('network should not be reached'); });
  });

  afterEach(() => { delete global.fetch; });

  test('sendEmail refuses a disallowed recipient without calling the API', async () => {
    const result = await gmail.sendEmail('attacker@evil.com', 'Subject', '<p>body</p>');
    expect(result.ok).toBe(false);
    expect(result.gmailError).toEqual({ error: 'Recipient not allowed' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('createDraft refuses a disallowed recipient without calling the API', async () => {
    const result = await gmail.createDraft('attacker@evil.com', 'Subject', '<p>body</p>');
    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sendEmail always returns the { ok, gmailError } shape callers expect', async () => {
    const result = await gmail.sendEmail('attacker@evil.com', 'S', 'b');
    expect(typeof result).toBe('object');
    expect(result).toHaveProperty('ok');
  });
});
