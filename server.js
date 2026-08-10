// server.js — Rasmus Auctions Field Operations Dashboard
const express   = require('express');
const http      = require('http');
const { WebSocketServer } = require('ws');
const path      = require('path');

const state     = require('./state');
const { getEmailTracking, getEmailTrackingEntry, updateEmailTracking, deleteEmailTracking } = require('./state');
const scheduler = require('./tasks/scheduler');
const gmail     = require('./tasks/gmail');
const { sanitizeSubject } = gmail;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

function localDateKey(date = new Date()) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function formatDateKey(dateKey) {
  if (!dateKey) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

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
  const { name, location, date, status, notes, contactName, contactPhone, contactEmail } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  state.addProject({ name, location, date, status: status || 'identification', notes: notes || '', contactName: contactName || '', contactPhone: contactPhone || '', contactEmail: contactEmail || '' });
  broadcast();
  res.json({ ok: true });
});

app.post('/api/projects/:id/log', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  state.addActivityLog(req.params.id, text);
  broadcast();
  res.json({ ok: true });
});

app.patch('/api/projects/:id', async (req, res) => {
  state.updateProject(req.params.id, req.body);
  broadcast();

  // Write close date back to HubSpot if the date field changed
  if (req.body.date) {
    const hsKey = process.env.HUBSPOT_API_KEY;
    if (hsKey) {
      try {
        await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${req.params.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
          body: JSON.stringify({ properties: { closedate: req.body.date + 'T00:00:00.000Z' } })
        });
        console.log(`[HUBSPOT] closedate updated for deal ${req.params.id}: ${req.body.date}`);
      } catch (e) {
        console.error('[HUBSPOT] closedate update failed:', e.message);
      }
    }
  }

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

// ── Leader Projects ───────────────────────────────────────────
app.get('/api/leader-projects', (req, res) => {
  res.json(state.getLeaderProjects());
});

app.post('/api/leader-projects', (req, res) => {
  const { projectNumber, title, leader, startDate, removalDate } = req.body;
  if (!title)  return res.status(400).json({ error: 'title required' });
  if (!leader) return res.status(400).json({ error: 'leader required' });
  state.addLeaderProject({ projectNumber: projectNumber || '', title, leader, startDate: startDate || '', removalDate: removalDate || '' });
  broadcast();
  res.json({ ok: true });
});

app.patch('/api/leader-projects/:id', (req, res) => {
  state.updateLeaderProject(req.params.id, req.body);
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/leader-projects/:id', (req, res) => {
  state.deleteLeaderProject(req.params.id);
  broadcast();
  res.json({ ok: true });
});

// ── Email Tracking ────────────────────────────────────────────
app.get('/api/email-tracking', (req, res) => {
  res.json(getEmailTracking());
});

app.patch('/api/email-tracking/:id', (req, res) => {
  updateEmailTracking(req.params.id, req.body);
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/email-tracking/:id', (req, res) => {
  deleteEmailTracking(req.params.id);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/email-tracking/:id/send', async (req, res) => {
  const { recipient, text } = req.body;
  if (!recipient) return res.status(400).json({ error: 'recipient required' });
  if (!text)      return res.status(400).json({ error: 'text required' });
  const entry = getEmailTrackingEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  const subject = `Identification Complete - ${entry.jobNumber ? entry.jobNumber + ' | ' : ''}${sanitizeSubject(entry.name)}`;
  const html    = `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;padding:24px;max-width:600px">${text.replace(/\n/g, '<br>')}</body></html>`;
  const result  = await gmail.sendEmail(recipient, subject, html);
  if (!result.ok) return res.status(502).json({ error: 'Gmail send failed', gmailError: result.gmailError });

  updateEmailTracking(req.params.id, { sent: true, sentAt: Date.now() });
  broadcast();
  res.json({ ok: true });
});

// ── AI proxy — keeps API key server-side, never in browser ────
app.post('/api/ai/summary', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { projectId, fallback } = req.body;
  let p = state.getProject(projectId);
  if (!p && fallback) {
    p = { id: projectId, name: fallback.name || 'Unknown', stage: fallback.stage || '', date: fallback.date || '', location: '', notes: '', activityLog: [] };
  }
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
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: (() => {
            const recentLog = (p.activityLog || []).slice(0, 3)
              .map((e, i) => `${i + 1}. ${new Date(e.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${e.text}`)
              .join('\n');
            return `You are a field ops coordinator at Rasmus Auctions. Give a quick 2-3 line project snapshot — what stage it's in, when the auction is, and any key detail worth flagging. Be direct, no fluff.

Job: ${p.name}
Location: ${p.location || 'Unknown'}
Auction Date: ${p.date || 'TBD'}
Stage: ${p.stage || p.status}
Notes: ${p.notes || 'None'}
${recentLog ? `Recent Activity:\n${recentLog}` : ''}

Plain text only. No bullet points, no preamble, no sign-off.`;
          })()
        }]
      })
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    if (state.getProject(projectId)) {
      state.updateProject(projectId, { summaryText: text });
      broadcast();
    }
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function generateConfirmationDraft(c) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: `You are writing on behalf of Rasmus Auctions Field Operations. Write a professional post-project site confirmation email.

Site/Client: ${c.site}
Recipient: ${c.recipient || 'the client'}
Project Completed: ${new Date(c.completedAt).toLocaleString('en-US', { weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' })}
${c.project ? `Related project: ${c.project}` : ''}

The email should confirm project/auction completion, thank them, note next steps in general terms, and be signed from "Field Operations, Rasmus Auctions". Write ONLY the email body, under 150 words.` }]
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(`Anthropic API error: ${data.error.type} — ${data.error.message}`);
  return data.content?.[0]?.text || '';
}

app.post('/api/ai/draft-email', async (req, res) => {
  const { confirmationId } = req.body;
  const c = state.getConfirmation(confirmationId);
  if (!c) return res.status(404).json({ error: 'Confirmation not found' });
  try {
    const text = await generateConfirmationDraft(c);
    state.updateConfirmation(confirmationId, { draftText: text });
    broadcast();
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ai/et-draft', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const entry = getEmailTrackingEntry(req.body.entryId);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{ role: 'user', content: `You are writing on behalf of Rasmus Auctions Field Operations. Write a professional post-identification email to the seller/client.

Job: ${entry.jobNumber ? entry.jobNumber + ' — ' : ''}${entry.name}
Project Leader: ${entry.leader || 'Field Operations'}

This email informs the seller that the identification (cataloging/inventory) of their items is complete and outlines what comes next: preparation for sale, auction timeline, and removal coordination after the auction. Keep the tone professional and reassuring. Sign from "${entry.leader ? entry.leader + ', ' : ''}Field Operations, Rasmus Auctions". Write ONLY the email body, under 200 words.` }]
      })
    });
    const data = await r.json();
    if (data.error) throw new Error(`Anthropic error: ${data.error.message}`);
    res.json({ text: data.content?.[0]?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/confirmations/:id/send', async (req, res) => {
  const c = state.getConfirmation(req.params.id);
  if (!c) return res.status(404).json({ error: 'Confirmation not found' });
  if (!c.recipient) return res.status(400).json({ error: 'No recipient email on this confirmation' });

  try {
    let draftText = c.draftText;
    if (!draftText) {
      draftText = await generateConfirmationDraft(c);
      if (draftText) state.updateConfirmation(c.id, { draftText });
    }
    if (!draftText) return res.status(500).json({ error: 'Could not generate email draft' });

    const subject = `Site Confirmation - ${sanitizeSubject(c.site)}`;
    const html = `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;padding:24px;max-width:600px">${draftText.replace(/\n/g, '<br>')}</body></html>`;

    const result = await gmail.sendEmail(c.recipient, subject, html);
    if (!result.ok) return res.status(502).json({ error: 'Gmail send failed', gmailError: result.gmailError });

    state.updateConfirmation(c.id, { sent: true });
    broadcast();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manual overdue draft trigger ──────────────────────────────
app.post('/api/overdue-draft/trigger', async (req, res) => {
  try {
    await scheduler.runOverdueDraft();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manual digest trigger ─────────────────────────────────────
app.post('/api/digest/trigger', async (req, res) => {
  try {
    await scheduler.runDailyDigest();
    res.json({ ok: true });
  } catch (e) {
    console.error('[DIGEST] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ── Manual email scan trigger ─────────────────────────────────
app.post('/api/email-scan/trigger', async (req, res) => {
  try {
    await scheduler.runEmailGmailScan();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manual sync trigger ───────────────────────────────────────
app.post('/api/sync/trigger', async (req, res) => {
  try {
    await scheduler.runHubSpotSync();
    res.json({ ok: true, leaderProjects: state.getLeaderProjects() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot contact scope test ───────────────────────────────
app.get('/api/sync/test-contact', async (req, res) => {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return res.status(503).json({ error: 'No HUBSPOT_API_KEY' });
  try {
    // Get associations for a known deal
    const dealId = '59560761184'; // Unionville Brewing
    const assocRes = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/contacts`, {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const assocData = await assocRes.json();
    const contactIds = (assocData.results || []).map(r => r.id);
    if (!contactIds.length) return res.json({ contactIds: [], contacts: [] });

    const batchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
      body: JSON.stringify({ inputs: contactIds.map(id => ({ id })), properties: ['firstname','lastname','phone','mobilephone','email'] })
    });
    const batchData = await batchRes.json();
    res.json({ contactIds, status: batchRes.status, contacts: batchData.results || [], error: batchData.message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sync: List All Pipelines ──────────────────────────────────
app.get('/api/sync/pipelines', async (req, res) => {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return res.status(503).json({ error: 'No HUBSPOT_API_KEY' });

  try {
    const response = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {
      headers: {
        'Authorization': `Bearer ${hsKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();

    const pipelines = data.results.map(p => ({
      id: p.id,
      label: p.label,
      stages: p.stages.map(s => ({ id: s.id, label: s.label }))
    }));

    res.json({ count: pipelines.length, pipelines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HubSpot pipeline stages ───────────────────────────────────
app.get('/api/sync/stages/:pipelineId', async (req, res) => {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return res.status(503).json({ error: 'No HUBSPOT_API_KEY' });
  try {
    const r = await fetch(`https://api.hubapi.com/crm/v3/pipelines/deals/${req.params.pipelineId}/stages`, {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const data = await r.json();
    res.json((data.results || []).map(s => ({ id: s.id, label: s.label, displayOrder: s.displayOrder })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot raw debug — find the project leader property name ─
app.get('/api/sync/deal-properties', async (req, res) => {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return res.status(503).json({ error: 'No HUBSPOT_API_KEY' });
  try {
    const propsRes  = await fetch('https://api.hubapi.com/crm/v3/properties/deals', {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const propsData = await propsRes.json();
    const allProps  = propsData.results || [];
    const keywords  = ['date','schedule','auction','preview','removal','identification','inspection','closing','close','id_date','id date'];
    const matched   = allProps
      .filter(p => keywords.some(k => p.label.toLowerCase().includes(k) || p.name.toLowerCase().includes(k)))
      .map(p => ({ name: p.name, label: p.label, type: p.type, groupName: p.groupName }))
      .sort((a, b) => a.groupName.localeCompare(b.groupName) || a.label.localeCompare(b.label));
    res.json({ count: matched.length, properties: matched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sync/debug', async (req, res) => {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return res.status(503).json({ error: 'No HUBSPOT_API_KEY' });
  try {
    // 1. List all custom deal properties, find anything matching "leader" or "project"
    const propsRes = await fetch('https://api.hubapi.com/crm/v3/properties/deals', {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const propsData = await propsRes.json();
    const allProps = (propsData.results || []);
    const leaderProps = allProps.filter(p =>
      p.label.toLowerCase().includes('leader') ||
      p.label.toLowerCase().includes('project') ||
      p.name.toLowerCase().includes('leader') ||
      p.name.toLowerCase().includes('project')
    ).map(p => ({ name: p.name, label: p.label, type: p.type }));

    // 2. Fetch one deal with ALL its properties to see raw values
    const dealRes = await fetch('https://api.hubapi.com/crm/v3/objects/deals?limit=1&properties=' +
      allProps.map(p => p.name).join(','), {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const dealData = await dealRes.json();
    const sampleDeal = dealData.results?.[0] || null;
    const filledProps = sampleDeal
      ? Object.entries(sampleDeal.properties)
          .filter(([, v]) => v !== null && v !== '')
          .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {})
      : {};

    res.json({ leaderProps, sampleDealId: sampleDeal?.id, filledProps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Triage POC debug — inspect one deal's associations ───────────
app.get('/api/sync/triage-debug/:dealId', async (req, res) => {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return res.status(503).json({ error: 'No HUBSPOT_API_KEY' });
  const { dealId } = req.params;
  try {
    // Raw triage_poc value on this deal
    const dealRes  = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=triage_poc,dealname,dealstage,pipeline`, {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const dealData = await dealRes.json();

    // v4 deal-to-deal associations
    const v4Res  = await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/deals`, {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const v4Data = await v4Res.json();

    // v4 deal-to-contact associations (in case triage_poc is stored differently)
    const ctRes  = await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/contacts`, {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const ctData = await ctRes.json();

    // If any associated deals, fetch their triage_poc
    const assocDealIds = (v4Data.results || []).map(r => r.toObjectId);
    let assocDealProps = [];
    if (assocDealIds.length) {
      const batchRes  = await fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
        body: JSON.stringify({ inputs: assocDealIds.map(id => ({ id: String(id) })), properties: ['triage_poc','dealname','pipeline','dealstage'] })
      });
      const batchData = await batchRes.json();
      assocDealProps = (batchData.results || []).map(d => ({ id: d.id, ...d.properties }));
    }

    res.json({
      deal:          { id: dealId, ...dealData.properties },
      assocDealIds,
      assocDealProps,
      assocContactIds: (ctData.results || []).map(r => r.toObjectId),
      v4Raw:         v4Data
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot Active Projects ───────────────────────────────────
app.get('/api/hubspot-active-projects', async (req, res) => {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return res.status(503).json({ error: 'No HUBSPOT_API_KEY' });

  const PIPELINE = '147097136';
  const ACTIVE_STAGES = {
    '249570210':  'Identification',
    '978470732':  'Auction Posting',
    '249570211':  'Quality Control',
    '1026748166': 'Staffing',
    '249570214':  'Selling & Closing'
  };

  const OWNERS = {
    '84584819':   'Karen Kester',
    '89024581':   'Blake Johnson',
    '1613587974': 'Kenneth Weaver',
    '76302559':   'Darren Estes',
    '84107196':   'Luciana Castillo',
    '84584840':   'Werner Manrique-Martinez',
    '76302361':   'Madi Felix',
    '76267712':   'Lauren Balderson',
    '78392611':   'Clarke Gray',
    '89024559':   'Kelly Jackson',
    '89745865':   'Rachel Wulfekuhle',
    '90980995':   'Mashao Seabela',
    '321507837':  'Cecelia Bussey',
    '638585431':  'Crystal Felix',
    '650958939':  'Michelle Jarvis',
    '662451144':  'Scott Wright',
    '1275610303': 'Abby Fitzgerald',
    '1338132313': 'Kathleen Rodimak',
    '1355258725': 'Chris Kubica',
    '1391725369': 'Chris Rasmus',
    '1886951536': 'Patrick Rasmus',
    '2006075167': 'Theo Babacar',
    '2061785375': 'Candy Sicilia',
    '24375587':   'Erik Rasmus',
    '72301438':   'Adam Roberts',
    '77636448':   'Susan Rasmus',
    '77935192':   'Demomé Hydol'
  };

  try {
    const today = localDateKey();

    let allDeals = [];
    let after = undefined;

    do {
      const body = {
        filterGroups: [{
          filters: [
            { propertyName: 'pipeline',       operator: 'EQ',           value: PIPELINE },
            { propertyName: 'dealstage',      operator: 'IN',           values: Object.keys(ACTIVE_STAGES) },
            { propertyName: 'project_leader', operator: 'HAS_PROPERTY' }
          ]
        }],
        properties: ['dealname', 'dealstage', 'project_leader', 'triage_poc', 'closedate'],
        limit: 100,
        sorts: [{ propertyName: 'closedate', direction: 'ASCENDING' }]
      };
      if (after) body.after = after;

      const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      allDeals = allDeals.concat(data.results || []);
      after = data.paging?.next?.after;
    } while (after);

    const filtered = allDeals.filter(deal => {
      const cd = deal.properties.closedate;
      if (!cd) return true;
      return cd.split('T')[0] >= today;
    });

    // Enrich triage_poc from associated Prospect deals where the active deal has none
    const needsTriage = filtered.filter(d => !d.properties.triage_poc);
    if (needsTriage.length) {
      try {
        // 1. Batch-fetch deal→deal associations
        const assocRes  = await fetch('https://api.hubapi.com/crm/v4/associations/deals/deals/batch/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
          body: JSON.stringify({ inputs: needsTriage.map(d => ({ id: d.id })) })
        });
        const assocData = await assocRes.json();

        const dealAssocMap = {};
        (assocData.results || []).forEach(r => {
          dealAssocMap[r.from.id] = (r.to || []).map(t => String(t.toObjectId));
        });

        // 2. Batch-read triage_poc from all associated deals
        const assocIds = [...new Set(Object.values(dealAssocMap).flat())];
        if (assocIds.length) {
          const batchRes  = await fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
            body: JSON.stringify({ inputs: assocIds.map(id => ({ id })), properties: ['triage_poc'] })
          });
          const batchData = await batchRes.json();
          const triageMap = {};
          (batchData.results || []).forEach(d => {
            if (d.properties?.triage_poc) triageMap[d.id] = d.properties.triage_poc;
          });

          // Back-fill active deals
          needsTriage.forEach(deal => {
            for (const aid of (dealAssocMap[deal.id] || [])) {
              if (triageMap[aid]) { deal.properties.triage_poc = triageMap[aid]; break; }
            }
          });
        }
      } catch (e) {
        console.warn('[HUBSPOT] Triage POC enrichment failed:', e.message);
      }
    }

    const deals = filtered.map(deal => {
      const p         = deal.properties;
      const leaderId  = p.project_leader;
      const triageId  = p.triage_poc;
      const closeDate = p.closedate ? p.closedate.split('T')[0] : null;
      return {
        id:           deal.id,
        name:         p.dealname || 'Untitled',
        stage:        ACTIVE_STAGES[p.dealstage] || p.dealstage,
        closedate:    formatDateKey(closeDate),
        closedateRaw: closeDate,
        leaderId,
        leaderName:   OWNERS[leaderId] || `Owner ${leaderId}`,
        triagePoc:    triageId ? (OWNERS[triageId] || `Owner ${triageId}`) : null,
        hubspotUrl:   `https://app.hubspot.com/contacts/46444696/record/0-3/${deal.id}`
      };
    });

    const groups = {};
    deals.forEach(deal => {
      if (!groups[deal.leaderName]) groups[deal.leaderName] = [];
      groups[deal.leaderName].push(deal);
    });

    Object.values(groups).forEach(arr => {
      arr.sort((a, b) => {
        if (!a.closedateRaw && !b.closedateRaw) return 0;
        if (!a.closedateRaw) return 1;
        if (!b.closedateRaw) return -1;
        return a.closedateRaw.localeCompare(b.closedateRaw);
      });
    });

    const sortedGroups = Object.entries(groups).sort(([, a], [, b]) => {
      const aDate = a.find(d => d.closedateRaw)?.closedateRaw;
      const bDate = b.find(d => d.closedateRaw)?.closedateRaw;
      if (!aDate && !bDate) return 0;
      if (!aDate) return 1;
      if (!bDate) return -1;
      return aDate.localeCompare(bDate);
    });

    res.json({
      asOf:   new Date().toISOString(),
      total:  deals.length,
      groups: sortedGroups.map(([leader, jobs]) => ({ leader, jobs }))
    });

  } catch (e) {
    console.error('[HUBSPOT-ACTIVE] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Leader Stats Debug — inspect completed deal properties ────
app.get('/api/leader-stats/debug', async (req, res) => {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return res.status(503).json({ error: 'No HUBSPOT_API_KEY' });
  const PIPELINE = '147097136';
  try {
    // Fetch ALL deal properties so we can request them all at once
    const propsRes  = await fetch('https://api.hubapi.com/crm/v3/properties/deals', {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const propsData = await propsRes.json();
    const allPropNames = (propsData.results || []).map(p => p.name);

    const now = Date.now();
    const twelveMonthsAgo = now - 365 * 24 * 60 * 60 * 1000;
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'pipeline',  operator: 'EQ',  value: PIPELINE },
          { propertyName: 'closedate', operator: 'GTE', value: String(twelveMonthsAgo) },
          { propertyName: 'closedate', operator: 'LT',  value: String(now) }
        ]
      }],
      properties: allPropNames,
      limit: 3,
      sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }]
    };
    const r    = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    const BID_KEYWORDS = ['bid', 'auction', 'reconcil', 'sale', 'revenue', 'gross', 'proceed', 'total', 'final', 'amount', 'price'];
    const allPropMeta = Object.fromEntries((propsData.results || []).map(p => [p.name, p.label]));

    const deals = (data.results || []).map(d => ({
      id:   d.id,
      name: d.properties.dealname,
      closedate:  d.properties.closedate,
      dealstage:  d.properties.dealstage,
      filledProps: Object.entries(d.properties)
        .filter(([, v]) => v !== null && v !== '' && v !== '0')
        .sort(([a], [b]) => a.localeCompare(b))
        .reduce((acc, [k, v]) => { acc[k] = { value: v, label: allPropMeta[k] || k }; return acc; }, {}),
      bidAndSaleProps: Object.entries(d.properties)
        .filter(([k, v]) => v !== null && v !== '' && BID_KEYWORDS.some(kw => k.toLowerCase().includes(kw) || (allPropMeta[k] || '').toLowerCase().includes(kw)))
        .reduce((acc, [k, v]) => { acc[k] = { value: v, label: allPropMeta[k] || k }; return acc; }, {})
    }));
    res.json({
      note: 'Shows filled properties on the 3 most-recently-closed deals. Check bidAndSaleProps for bid/reconciliation field names.',
      deals
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Leader Field Stats ────────────────────────────────────────
app.get('/api/leader-stats', async (req, res) => {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return res.status(503).json({ error: 'No HUBSPOT_API_KEY' });

  const PIPELINE = '147097136';
  const OWNERS = {
    '84584819':   'Karen Kester',
    '89024581':   'Blake Johnson',
    '1613587974': 'Kenneth Weaver',
    '76302559':   'Darren Estes',
    '84107196':   'Luciana Castillo',
    '84584840':   'Werner Manrique-Martinez',
    '76302361':   'Madi Felix',
    '76267712':   'Lauren Balderson',
    '78392611':   'Clarke Gray',
    '89024559':   'Kelly Jackson',
    '89745865':   'Rachel Wulfekuhle',
    '90980995':   'Mashao Seabela',
    '321507837':  'Cecelia Bussey',
    '638585431':  'Crystal Felix',
    '650958939':  'Michelle Jarvis',
    '662451144':  'Scott Wright',
    '1275610303': 'Abby Fitzgerald',
    '1338132313': 'Kathleen Rodimak',
    '1355258725': 'Chris Kubica',
    '1391725369': 'Chris Rasmus',
    '1886951536': 'Patrick Rasmus',
    '2006075167': 'Theo Babacar',
    '2061785375': 'Candy Sicilia',
    '24375587':   'Erik Rasmus',
    '72301438':   'Adam Roberts',
    '77636448':   'Susan Rasmus',
    '77935192':   'Demomé Hydol'
  };

  try {
    const now = Date.now();
    const twelveMonthsAgo = now - 365 * 24 * 60 * 60 * 1000;

    let allDeals = [];
    let after = undefined;

    // Two filter groups (OR): deals with closedate in range, OR deals assigned to a known
    // leader via project_leader/hubspot_owner_id regardless of closedate, so we don't
    // miss completed deals that have a null or future closedate in HubSpot.
    do {
      const body = {
        filterGroups: [
          // Group A: closedate-based (catches deals explicitly closed in the window)
          {
            filters: [
              { propertyName: 'pipeline',  operator: 'EQ',  value: PIPELINE },
              { propertyName: 'closedate', operator: 'GTE', value: String(twelveMonthsAgo) },
              { propertyName: 'closedate', operator: 'LT',  value: String(now) }
            ]
          },
          // Group B: stage-excluded (catches closed/won deals regardless of closedate)
          {
            filters: [
              { propertyName: 'pipeline',   operator: 'EQ',     value: PIPELINE },
              { propertyName: 'dealstage',  operator: 'NOT_IN', values: [
                '249570210','978470732','249570211','1026748166','249570214'  // active stages
              ]},
              { propertyName: 'createdate', operator: 'GTE', value: String(twelveMonthsAgo) }
            ]
          }
        ],
        properties: ['dealname', 'project_leader', 'closedate', 'createdate', 'dealstage', 'adjusted_total__after_refunds___on_site_sales_', 'amount', 'commission_structure__notes_'],
        limit: 100,
        sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }]
      };
      if (after) body.after = after;

      const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      allDeals = allDeals.concat(data.results || []);
      after = data.paging?.next?.after;
    } while (after);

    // Deduplicate by deal ID (OR filter groups can return the same deal twice)
    const seen = new Set();
    allDeals = allDeals.filter(d => { if (seen.has(d.id)) return false; seen.add(d.id); return true; });

    const cutoffs = {
      m3:  now - 3  * 30 * 24 * 60 * 60 * 1000,
      m6:  now - 6  * 30 * 24 * 60 * 60 * 1000,
      m9:  now - 9  * 30 * 24 * 60 * 60 * 1000,
      m12: now - 12 * 30 * 24 * 60 * 60 * 1000
    };
    const ytdStart = new Date(new Date().getFullYear(), 0, 1).getTime();

    const leaderMap = {};
    allDeals.forEach(deal => {
      const p = deal.properties;
      // Only attribute to the project_leader field (not hubspot_owner_id — that's the sales
      // account manager, a different person from the field project leader)
      const leaderId = p.project_leader;
      if (!leaderId || !OWNERS[leaderId]) return;
      const leaderName = OWNERS[leaderId];
      if (['Chris Rasmus', 'Erik Rasmus', 'Crystal Felix', 'Susan Rasmus', 'Patrick Rasmus'].includes(leaderName)) return;

      // Use closedate if set; fall back to createdate so the deal still counts
      const dateStr  = p.closedate || p.createdate;
      const closedMs = dateStr ? new Date(dateStr).getTime() : null;
      if (!closedMs) return;

      if (!leaderMap[leaderName]) leaderMap[leaderName] = { name: leaderName, m3: 0, m6: 0, m9: 0, m12: 0, ytdTotal: 0, deals: [] };
      if (closedMs >= cutoffs.m3)  leaderMap[leaderName].m3++;
      if (closedMs >= cutoffs.m6)  leaderMap[leaderName].m6++;
      if (closedMs >= cutoffs.m9)  leaderMap[leaderName].m9++;
      if (closedMs >= cutoffs.m12) leaderMap[leaderName].m12++;

      const jobMatch  = (p.dealname || '').match(/^(R\d+)\s+(.*)/i);
      const jobNumber = jobMatch ? jobMatch[1] : '';
      const jobName   = jobMatch ? jobMatch[2].trim() : (p.dealname || 'Untitled');
      const closeDate  = (p.closedate || p.createdate || '').split('T')[0] || null;
      // Parse the Stats text block for bid count and dollar totals
      const statsText  = p.commission_structure__notes_ || '';
      const bidMatch   = statsText.match(/Number of bids\t([\d,]+)/);
      const bidCount   = bidMatch ? parseInt(bidMatch[1].replace(/,/g, ''), 10) : null;
      const amtBidsMatch = statsText.match(/Amount of bids\t\$([\d,]+\.?\d*)/);
      const statsBidAmt  = amtBidsMatch ? parseFloat(amtBidsMatch[1].replace(/,/g, '')) : null;
      // Sale total: adjusted recon total → stats max bids → standard amount field
      const rawAmt    = p.adjusted_total__after_refunds___on_site_sales_ || null;
      const amount    = (rawAmt && parseFloat(rawAmt) > 0)
        ? parseFloat(rawAmt)
        : (statsBidAmt && statsBidAmt > 0 ? statsBidAmt : null);

      if (amount && closedMs >= ytdStart) leaderMap[leaderName].ytdTotal += amount;

      leaderMap[leaderName].deals.push({
        hubspotId:  deal.id,
        jobNumber,
        name:       jobName,
        closeDate,
        amount,
        bidCount,
        hubspotUrl: `https://app.hubspot.com/contacts/46444696/record/0-3/${deal.id}`
      });
    });

    // Sort each leader's deals newest first
    Object.values(leaderMap).forEach(l => {
      l.deals.sort((a, b) => (b.closeDate || '').localeCompare(a.closeDate || ''));
    });

    const leaders = Object.values(leaderMap)
      .filter(l => l.m12 > 0)
      .sort((a, b) => b.m12 - a.m12);

    res.json({ asOf: new Date().toISOString(), total: allDeals.length, leaders });
  } catch (e) {
    console.error('[LEADER-STATS] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
scheduler.init(broadcast);

server.listen(PORT, () => {
  console.log(`[SERVER] Rasmus Dashboard running on port ${PORT}`);
  console.log(`[SERVER] API key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
});
