// server.js — Rasmus Auctions Field Operations Dashboard
const express   = require('express');
const http      = require('http');
const { WebSocketServer } = require('ws');
const path      = require('path');

const state     = require('./state');
const scheduler = require('./tasks/scheduler');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket — push state to all connected clients ───────────
function broadcast() {
  const payload = JSON.stringify({ type: 'state', data: state.getSnapshot() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({ type: 'state', data: state.getSnapshot() }));
  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ── REST API ──────────────────────────────────────────────────

// GET full snapshot
app.get('/api/state', (req, res) => {
  res.json(state.getSnapshot());
});

// ── Projects ──────────────────────────────────────────────────
app.get('/api/projects', (req, res) => {
  res.json(state.getProjects());
});

app.post('/api/projects', (req, res) => {
  const { name, location, date, status, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  state.addProject({ name, location, date, status: status || 'on-track', notes: notes || '' });
  broadcast();
  res.json({ ok: true });
});

app.patch('/api/projects/:id', (req, res) => {
  state.updateProject(req.params.id, req.body);
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  state.deleteProject(req.params.id);
  broadcast();
  res.json({ ok: true });
});

// ── Confirmations ─────────────────────────────────────────────
app.get('/api/confirmations', (req, res) => {
  res.json(state.getConfirmations());
});

app.post('/api/confirmations', (req, res) => {
  const { site, recipient, project, completedAt } = req.body;
  if (!site) return res.status(400).json({ error: 'site required' });
  state.addConfirmation({
    site, recipient: recipient || '', project: project || '',
    completedAt: completedAt || Date.now()
  });
  broadcast();
  res.json({ ok: true });
});

app.patch('/api/confirmations/:id', (req, res) => {
  state.updateConfirmation(req.params.id, req.body);
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/confirmations/:id', (req, res) => {
  state.deleteConfirmation(req.params.id);
  broadcast();
  res.json({ ok: true });
});

// ── Alerts ────────────────────────────────────────────────────
app.delete('/api/alerts/:id', (req, res) => {
  state.clearAlert(req.params.id);
  broadcast();
  res.json({ ok: true });
});

// ── AI proxy — keeps API key server-side, never in browser ────
app.post('/api/ai/summary', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { projectId } = req.body;
  const p = state.getProject(projectId);
  if (!p) return res.status(404).json({ error: 'Project not found' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `You are an assistant for Rasmus Auctions field operations. Write a concise 2-sentence operational status note for this project.

Project: ${p.name}
Location: ${p.location}
Auction Date: ${p.date || 'TBD'}
Status: ${p.status}
Notes: ${p.notes || 'None'}

Write only the 2-sentence note, no preamble.`
        }]
      })
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    state.updateProject(projectId, { summaryText: text });
    broadcast();
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ai/draft-email', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { confirmationId } = req.body;
  const c = state.getConfirmation(confirmationId);
  if (!c) return res.status(404).json({ error: 'Confirmation not found' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `You are writing on behalf of Rasmus Auctions Field Operations. Write a professional post-project site confirmation email.

Site/Client: ${c.site}
Recipient: ${c.recipient || 'the client'}
Project Completed: ${new Date(c.completedAt).toLocaleString('en-US', { weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' })}
${c.project ? `Related project: ${c.project}` : ''}

The email should confirm project/auction completion, thank them, note next steps in general terms, and be signed from "Field Operations, Rasmus Auctions". Write ONLY the email body, under 150 words.`
        }]
      })
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    state.updateConfirmation(confirmationId, { draftText: text });
    broadcast();
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
scheduler.init(broadcast);

server.listen(PORT, () => {
  console.log(`[SERVER] Rasmus Dashboard running on port ${PORT}`);
  console.log(`[SERVER] API key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
});
