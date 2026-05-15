// tasks/gmail.js — Gmail OAuth2 helper with auto token refresh

const GMAIL_API     = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';

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

module.exports = { getAccessToken, searchMessages };
