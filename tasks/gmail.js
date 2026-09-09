// tasks/gmail.js — Gmail OAuth2 helper with auto token refresh

function sanitizeSubject(str) {
  return (str || '')
    .replace(/—/g, ' - ')    // em dash → spaced hyphen
    .replace(/–/g, ' - ')    // en dash → spaced hyphen
    .replace(/[^\x00-\x7F]/g, '') // strip any remaining non-ASCII
    .trim();
}

const GMAIL_API     = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';

// ── Recipient allowlist ───────────────────────────────────────
// The send endpoints take a recipient from the request body, so without
// this guard they are an open relay on destes@rasmus.com. This holds even
// if ADMIN_TOKEN leaks, so it stays independent of the auth middleware.
const ALLOWED_DOMAINS = (process.env.EMAIL_ALLOWED_DOMAINS || 'rasmus.com')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

// Registered by server.js at startup. Returns the seller contact emails
// already synced into state — legitimate external targets.
let knownRecipients = () => [];
function setKnownRecipients(fn) { knownRecipients = fn; }

function parseAddress(to) {
  const m = /<([^>]+)>/.exec(to || '');
  return (m ? m[1] : String(to || '')).trim().toLowerCase();
}

function isAllowedRecipient(to) {
  const addr = parseAddress(to);
  if (!addr.includes('@')) return false;
  if (ALLOWED_DOMAINS.includes(addr.slice(addr.lastIndexOf('@') + 1))) return true;
  return knownRecipients().some(e => parseAddress(e) === addr);
}

let cachedToken     = null;
let tokenExpiresAt  = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;

  const res  = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) { console.error('[GMAIL] Token refresh failed:', data); return null; }

  cachedToken    = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  console.log('[GMAIL] Access token refreshed');
  return cachedToken;
}

async function searchMessages(query, maxResults = 5) {
  const token = await getAccessToken();
  if (!token) return [];
  const q   = encodeURIComponent(query);
  const res = await fetch(`${GMAIL_API}/users/me/messages?q=${q}&maxResults=${maxResults}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.messages || [];
}

async function getMessageMetadata(id) {
  const token = await getAccessToken();
  if (!token) return null;
  const res  = await fetch(
    `${GMAIL_API}/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!data.payload) return null;
  const hdr = name => (data.payload.headers || []).find(h => h.name === name)?.value || '';
  return { from: hdr('From'), subject: hdr('Subject'), internalDate: Number(data.internalDate) };
}

async function sendEmail(to, subject, htmlBody) {
  if (!isAllowedRecipient(to)) {
    console.error(`[GMAIL] Blocked send to disallowed recipient: ${to}`);
    return { ok: false, gmailError: { error: 'Recipient not allowed' } };
  }
  const token = await getAccessToken();
  if (!token) { console.log('[GMAIL] No token — cannot send email'); return { ok: false, gmailError: { error: 'No Gmail token' } }; }
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${sanitizeSubject(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${htmlBody}`
  ).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const res = await fetch(`${GMAIL_API}/users/me/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  const data = await res.json();
  if (data.id) { console.log(`[GMAIL] Sent to ${to}: ${subject}`); return { ok: true }; }
  console.error('[GMAIL] Send failed:', JSON.stringify(data));
  return { ok: false, gmailError: data };
}

async function createDraft(to, subject, htmlBody) {
  if (!isAllowedRecipient(to)) {
    console.error(`[GMAIL] Blocked draft to disallowed recipient: ${to}`);
    return false;
  }
  const token = await getAccessToken();
  if (!token) { console.log('[GMAIL] No token — cannot create draft'); return false; }
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${sanitizeSubject(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${htmlBody}`
  ).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const res  = await fetch(`${GMAIL_API}/users/me/drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw } })
  });
  const data = await res.json();
  if (data.id) { console.log(`[GMAIL] Draft created for ${to}: ${subject}`); return true; }
  console.error('[GMAIL] Draft creation failed:', JSON.stringify(data));
  return false;
}

module.exports = {
  getAccessToken, searchMessages, getMessageMetadata, sendEmail, createDraft, sanitizeSubject,
  setKnownRecipients, isAllowedRecipient
};
