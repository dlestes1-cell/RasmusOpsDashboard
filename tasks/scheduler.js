// tasks/scheduler.js — HubSpot + Gmail integrated
const cron = require('node-cron');
const {
  getConfirmations, updateConfirmation, addAlert,
  getProjects, updateProject, setProjects
} = require('../state');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const HUBSPOT_API   = 'https://api.hubapi.com';
const GMAIL_API     = 'https://gmail.googleapis.com/gmail/v1';
const WINDOW_MS     = 24 * 60 * 60 * 1000;

// Active stages — deals in these appear on dashboard
const ACTIVE_STAGE_LABELS = [
  'New Auction', 'Identification', 'Auction Posting',
  'Staffing', 'Quality Control', 'Selling & Closing', 'Reconciliation',
  'Selling Online', 'Live show', 'Onboarding', 'ID In-process'
];

// Excluded stage IDs (Reconciled, Cancelled, Archived across all pipelines)
const EXCLUDED_STAGE_IDS = [
  '1300469340','1320719876','997854466','998000723','997964862','1070887958',
  '1044146096','1044046920','1006697529','1006697530','1006750136'
];

function stageToStatus(label) {
  if (!label) return 'on-track';
  const l = label.toLowerCase();
  if (l.includes('reconciliation'))                                          return 'needs-attention';
  if (l.includes('selling & closing') || l.includes('selling online') || l.includes('live show')) return 'at-risk';
  return 'on-track';
}

function daysBefore(n) {
  const d = new Date(Date.now() - n * 864e5);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

let broadcast;
let stageMap = {};

// ── Build stage ID→label map ──────────────────────────────────
async function buildStageMap() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return;
  try {
    const res  = await fetch(`${HUBSPOT_API}/crm/v3/properties/deals/dealstage`, {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const data = await res.json();
    (data.options || []).forEach(o => { stageMap[o.value] = o.label; });
    console.log(`[TASK] Stage map: ${Object.keys(stageMap).length} stages loaded`);
  } catch (e) {
    console.error('[TASK] Stage map failed:', e.message);
  }
}

// ── TASK 1: HubSpot deal sync — 8:00 AM daily ────────────────
async function runHubSpotSync() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) { console.log('[TASK] No HUBSPOT_API_KEY — skipping'); return; }

  console.log('[TASK] Syncing HubSpot deals…');
  try {
    const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
      body: JSON.stringify({
        limit: 200,
        properties: ['dealname','dealstage','pipeline','closedate','hubspot_owner_id','description','amount'],
        sorts: [{ propertyName: 'closedate', direction: 'ASCENDING' }],
        filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'NOT_IN', values: EXCLUDED_STAGE_IDS }] }]
      })
    });

    const data  = await res.json();
    const deals = (data.results || []);

    const projects = deals.map(deal => {
      const p     = deal.properties;
      const stage = stageMap[p.dealstage] || p.dealstage || 'Unknown';
      if (!ACTIVE_STAGE_LABELS.some(l => stage.toLowerCase().includes(l.toLowerCase()))) return null;

      const jobMatch = (p.dealname || '').match(/^(R\d+)\s+(.*)/i);
      return {
        id:          String(deal.id),
        hubspotId:   String(deal.id),
        jobNumber:   jobMatch ? jobMatch[1] : '',
        name:        jobMatch ? jobMatch[2].trim() : (p.dealname || 'Unnamed'),
        location:    '',
        date:        p.closedate ? p.closedate.split('T')[0] : '',
        status:      stageToStatus(stage),
        stage,
        notes:       p.description || '',
        summaryText: '',
        amount:      p.amount || '',
        createdAt:   Date.now()
      };
    }).filter(Boolean);

    setProjects(projects);
    addAlert({ type:'sync', message:`🔄 HubSpot sync — ${projects.length} active deals loaded at ${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}` });
    console.log(`[TASK] HubSpot sync: ${projects.length} projects`);
    if (broadcast) broadcast();
  } catch (e) {
    console.error('[TASK] HubSpot sync error:', e.message);
    addAlert({ type:'error', message:`⚠ HubSpot sync failed: ${e.message}` });
    if (broadcast) broadcast();
  }
}

// ── TASK 2: Gmail confirmation scan — 8:05 AM daily ──────────
async function runGmailSync() {
  const token = process.env.GMAIL_ACCESS_TOKEN;
  if (!token) { console.log('[TASK] No GMAIL_ACCESS_TOKEN — skipping'); return; }

  console.log('[TASK] Scanning Gmail…');
  try {
    const confs = getConfirmations();
    for (const c of confs) {
      if (c.sent) continue;

      // Check sent mail for outbound confirmation
      const sentQ   = encodeURIComponent(`in:sent "${c.site}" after:${daysBefore(2)}`);
      const sentRes = await fetch(`${GMAIL_API}/users/me/messages?q=${sentQ}&maxResults=5`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const sentData = await sentRes.json();

      if ((sentData.messages || []).length > 0) {
        updateConfirmation(c.id, { sent: true });
        addAlert({ type:'confirmed', confirmationId:c.id, message:`✅ Gmail: Confirmation sent for "${c.site}" — auto-marked.` });
        console.log(`[TASK] Gmail auto-confirmed: ${c.site}`);
      } else if (c.recipient) {
        // Check for client reply
        const replyQ   = encodeURIComponent(`from:${c.recipient} "${c.site}" after:${daysBefore(3)}`);
        const replyRes = await fetch(`${GMAIL_API}/users/me/messages?q=${replyQ}&maxResults=3`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const replyData = await replyRes.json();
        if ((replyData.messages || []).length > 0) {
          updateConfirmation(c.id, { replied: true });
          addAlert({ type:'reply', confirmationId:c.id, message:`📬 "${c.site}" — client replied. Check inbox.` });
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }
    if (broadcast) broadcast();
  } catch (e) {
    console.error('[TASK] Gmail sync error:', e.message);
  }
}

// ── TASK 3: 24hr confirmation checker — every 5 min ──────────
function runConfirmationCheck() {
  const ts = Date.now();
  let changed = false;
  getConfirmations().forEach(c => {
    if (c.sent) return;
    const left = WINDOW_MS - (ts - c.completedAt);
    if (left <= 0 && !c.flagged) {
      updateConfirmation(c.id, { flagged: true });
      addAlert({ type:'overdue', confirmationId:c.id, message:`⚠ OVERDUE: "${c.site}" passed the 24-hour window.` });
      changed = true;
    } else if (left > 0 && left <= 3*3600000 && !c.warnedAt) {
      updateConfirmation(c.id, { warnedAt: ts });
      addAlert({ type:'warning', confirmationId:c.id, message:`⏱ URGENT: "${c.site}" due in ${Math.ceil(left/3600000)}h.` });
      changed = true;
    }
  });
  if (changed && broadcast) broadcast();
}

// ── TASK 4: AI status scan — every 6 hours ───────────────────
async function runAIStatusScan() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const projects = getProjects().filter(p => p.status === 'at-risk' || p.status === 'needs-attention');
  if (!projects.length) return;
  console.log(`[TASK] AI scan: ${projects.length} at-risk projects`);
  for (const p of projects) {
    try {
      const res  = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 200,
          messages: [{ role:'user', content:`You are an assistant for Rasmus Auctions field operations. Write a concise 2-sentence operational status note flagging the key concern and suggested next action.\n\nJob: ${p.jobNumber} — ${p.name}\nStage: ${p.stage || p.status}\nAuction Date: ${p.date || 'TBD'}\nNotes: ${p.notes || 'None'}\n\nWrite only the 2-sentence note, no preamble.` }]
        })
      });
      const data = await res.json();
      const text = data.content?.[0]?.text;
      if (text) updateProject(p.id, { summaryText: text });
    } catch (e) {
      console.error(`[TASK] AI scan error for ${p.name}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (broadcast) broadcast();
}

// ── Init ──────────────────────────────────────────────────────
async function init(broadcastFn) {
  broadcast = broadcastFn;
  await buildStageMap();

  // Daily 8am ET — set TZ=America/New_York in Railway environment variables
  cron.schedule('0 8 * * *',   () => runHubSpotSync());
  cron.schedule('5 8 * * *',   () => runGmailSync());
  cron.schedule('*/5 * * * *', () => runConfirmationCheck());
  cron.schedule('0 */6 * * *', () => runAIStatusScan());

  // Startup run
  console.log('[CRON] Running startup sync…');
  await runHubSpotSync();
  runConfirmationCheck();
  runAIStatusScan();
  console.log('[CRON] All tasks active.');
}

module.exports = { init };
