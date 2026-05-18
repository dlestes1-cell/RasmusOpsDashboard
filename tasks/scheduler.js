// tasks/scheduler.js — HubSpot + Gmail integrated
const cron  = require('node-cron');
const gmail = require('./gmail');
const {
  getConfirmations, updateConfirmation, addAlert,
  getProjects, updateProject, setProjects,
  getLeaderProjects, addLeaderProject, updateLeaderProject, deleteLeaderProject
} = require('../state');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const HUBSPOT_API   = 'https://api.hubapi.com';
const WINDOW_MS     = 24 * 60 * 60 * 1000;

const ACTIVE_STAGE_LABELS = [
  'New Auction', 'Identification', 'Auction Posting',
  'Staffing', 'Quality Control', 'Selling & Closing', 'Reconciliation',
  'Selling Online', 'Live show', 'Onboarding', 'ID In-process'
];

const EXCLUDED_STAGE_IDS = [
  '1300469340','1320719876','997854466','998000723','997964862','1070887958',
  '1044146096','1044046920','1006697529','1006697530','1006750136'
];

const KNOWN_LEADERS = [
  'Karen Kester', 'Kenny Weaver', 'Luciana Castillo',
  'Darren Estes', 'Blake Johnson', 'Warner Martinez'
];

function normalizeLeader(raw) {
  if (!raw) return '';
  const val = String(raw).toLowerCase().replace(/_/g, ' ').trim();
  return KNOWN_LEADERS.find(name => {
    const n = name.toLowerCase();
    return n === val || n.includes(val) || val.includes(n) ||
           n.split(' ')[0] === val || n.split(' ')[1] === val;
  }) || '';
}

function stageToStatus(label) {
  if (!label) return 'on-track';
  const l = label.toLowerCase();
  if (l.includes('reconciliation'))   return 'needs-attention';
  if (l.includes('selling & closing') || l.includes('selling online') || l.includes('live show')) return 'at-risk';
  return 'on-track';
}

function daysBefore(n) {
  const d = new Date(Date.now() - n * 864e5);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

let broadcast;
let stageMap    = {};
let ownerMap    = {}; // ownerId (string) → full name
let leaderEnums = {}; // project_leader enum value → label

// ── Build HubSpot stage map ───────────────────────────────────
async function buildStageMap() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return;
  try {
    const res  = await fetch(`${HUBSPOT_API}/crm/v3/pipelines/deals`, {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    console.log('[DEBUG] buildStageMap status:', res.status);
    const data = await res.json();
    const pipelines = data.results || [];
    console.log(`[DEBUG] buildStageMap: ${pipelines.length} pipelines found`);
    pipelines.forEach(pipeline => {
      (pipeline.stages || []).forEach(stage => {
        stageMap[stage.id] = stage.label;
      });
    });
    console.log(`[TASK] Stage map: ${Object.keys(stageMap).length} stages —`, JSON.stringify(stageMap));
  } catch (e) {
    console.error('[TASK] Stage map error:', e.message);
  }
}

// ── Build HubSpot owner map (id → full name) ─────────────────
async function buildOwnerMap() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return;
  try {
    const res  = await fetch(`${HUBSPOT_API}/crm/v3/owners?limit=100`, {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const data = await res.json();
    (data.results || []).forEach(o => {
      const name = [o.firstName, o.lastName].filter(Boolean).join(' ');
      ownerMap[String(o.id)] = name;
    });
    console.log(`[TASK] Owner map: ${Object.keys(ownerMap).length} owners —`, JSON.stringify(ownerMap));
  } catch (e) {
    console.error('[TASK] Owner map error:', e.message);
  }
}

// ── Build project_leader enum option map (value → label) ─────
async function buildLeaderEnums() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) return;
  try {
    const res  = await fetch(`${HUBSPOT_API}/crm/v3/properties/deals/project_leader`, {
      headers: { Authorization: `Bearer ${hsKey}` }
    });
    const data = await res.json();
    (data.options || []).forEach(opt => {
      leaderEnums[String(opt.value)] = opt.label;
    });
    console.log(`[TASK] Leader enum map: ${Object.keys(leaderEnums).length} options —`, JSON.stringify(leaderEnums));
  } catch (e) {
    console.error('[TASK] Leader enum error:', e.message);
  }
}

// ── Leader Projects sync (called from HubSpot sync) ──────────
function syncLeaderProjects(deals) {
  const APRIL_1 = '2026-04-01';
  const today   = new Date().toISOString().slice(0, 10);

  // Include all deals with closedate >= April 1 (past-dated ones are hidden
  // on the frontend; only truly expired deals get removed from the board)
  const qualifying = deals.filter(deal => {
    const p  = deal.properties;
    const cd = p.closedate ? p.closedate.split('T')[0] : null;
    const cr = p.createdate ? p.createdate.split('T')[0] : null;
    // Accept if closedate is April 1+ OR if no closedate but created April 1+
    if (cd) return cd >= APRIL_1;
    if (cr) return cr >= APRIL_1;
    return false;
  });

  const existing = getLeaderProjects();

  qualifying.forEach(deal => {
    const p          = deal.properties;
    const closeDate  = p.closedate  ? p.closedate.split('T')[0]  : '';
    const createDate = p.createdate ? p.createdate.split('T')[0] : APRIL_1;
    const startDate  = createDate < APRIL_1 ? APRIL_1 : createDate;
    const jobMatch   = (p.dealname || '').match(/^(R\d+)\s+(.*)/i);
    const title      = jobMatch ? jobMatch[2].trim() : (p.dealname || 'Unnamed');
    const projectNumber = jobMatch ? jobMatch[1] : '';

    // Resolve project_leader: try it as an owner ID, then enum label, then hubspot_owner_id, then raw text
    const rawLeader      = p.project_leader || '';
    const ownerFromPL    = ownerMap[rawLeader] || '';
    const enumLabel      = leaderEnums[rawLeader] || '';
    const ownerFromDeal  = ownerMap[String(p.hubspot_owner_id || '')] || '';
    const hsLeader       = normalizeLeader(ownerFromPL) || normalizeLeader(enumLabel) || normalizeLeader(ownerFromDeal) || normalizeLeader(rawLeader);
    console.log(`[DEBUG] Deal ${deal.id} leader resolution: raw="${rawLeader}" ownerFromPL="${ownerFromPL}" enumLabel="${enumLabel}" ownerFromDeal="${ownerFromDeal}" → "${hsLeader}"`);

    const match = existing.find(e => e.hubspotId === String(deal.id));
    if (match) {
      const leader = hsLeader || (match.manualLeader ? match.leader : '');
      updateLeaderProject(match.id, { projectNumber, title, startDate, removalDate: closeDate, leader });
    } else {
      addLeaderProject({ projectNumber, title, leader: hsLeader, startDate, removalDate: closeDate, hubspotId: String(deal.id) });
    }
  });

  // Only remove HubSpot-sourced entries whose closedate has genuinely passed today
  const qualifyingIds = new Set(qualifying.map(d => String(d.id)));
  existing
    .filter(e => e.hubspotId && !qualifyingIds.has(e.hubspotId) && e.removalDate && e.removalDate < today)
    .forEach(e => deleteLeaderProject(e.id));

  console.log(`[TASK] Leader board synced: ${qualifying.length} qualifying deals`);
}

// ── TASK 1: HubSpot sync — 8:00 AM ───────────────────────────
async function runHubSpotSync() {
  const hsKey = process.env.HUBSPOT_API_KEY;
  if (!hsKey) { console.log('[TASK] No HUBSPOT_API_KEY'); return; }
  console.log('[TASK] Syncing HubSpot deals…');

  const requestBody = {
    limit: 200,
    properties: ['dealname','dealstage','pipeline','closedate','createdate','description','amount','project_leader','hubspot_owner_id'],
    sorts: [{ propertyName: 'closedate', direction: 'ASCENDING' }],
    filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'NOT_IN', values: EXCLUDED_STAGE_IDS }] }]
  };
  console.log('[DEBUG] Request URL:', `${HUBSPOT_API}/crm/v3/objects/deals/search`);
  console.log('[DEBUG] Request body:', JSON.stringify(requestBody, null, 2));
  console.log('[DEBUG] Stage map size at sync time:', Object.keys(stageMap).length, '— entries:', JSON.stringify(stageMap, null, 2));

  try {
    const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/deals/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hsKey}` },
      body: JSON.stringify(requestBody)
    });

    console.log('[DEBUG] Response status:', res.status, res.statusText);
    console.log('[DEBUG] Response headers:', JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2));

    const rawText = await res.text();
    console.log('[DEBUG] Raw response body:', rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('[DEBUG] Failed to parse response as JSON:', parseErr.message);
      addAlert({ type:'error', message:`⚠ HubSpot sync failed: unparseable response (status ${res.status})` });
      if (broadcast) broadcast();
      return;
    }

    const deals = data.results || [];
    console.log(`[DEBUG] Total deals returned by API: ${deals.length}`);
    console.log(`[DEBUG] data.total (if present): ${data.total}`);
    console.log(`[DEBUG] data.paging (if present): ${JSON.stringify(data.paging)}`);

    if (deals.length === 0) {
      console.log('[DEBUG] No deals in response — possible causes: wrong pipeline, all stages excluded, API key scopes, or filter mismatch.');
      console.log('[DEBUG] EXCLUDED_STAGE_IDS:', JSON.stringify(EXCLUDED_STAGE_IDS));
    }

    const projects = deals.map(deal => {
      const p     = deal.properties;
      const stage = stageMap[p.dealstage] || p.dealstage || 'Unknown';
      const stageMatches = ACTIVE_STAGE_LABELS.some(l => stage.toLowerCase().includes(l.toLowerCase()));
      console.log(`[DEBUG] Deal ${deal.id} | dealstage ID: "${p.dealstage}" | resolved stage: "${stage}" | closedate: "${p.closedate}" | name: "${p.dealname}" | stage matches active list: ${stageMatches}`);
      if (!stageMatches) return null;
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

    console.log(`[DEBUG] Deals after active-stage filter: ${projects.length} of ${deals.length}`);

    setProjects(projects);
    syncLeaderProjects(deals);
    addAlert({ type:'sync', message:`🔄 HubSpot sync — ${projects.length} active deals at ${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}` });
    console.log(`[TASK] HubSpot: ${projects.length} projects loaded`);
    if (broadcast) broadcast();
  } catch (e) {
    console.error('[TASK] HubSpot error:', e.message);
    console.error('[TASK] HubSpot error stack:', e.stack);
    addAlert({ type:'error', message:`⚠ HubSpot sync failed: ${e.message}` });
    if (broadcast) broadcast();
  }
}

// ── TASK 2: Gmail scan — 8:05 AM ─────────────────────────────
async function runGmailSync() {
  const hasGmail = process.env.GMAIL_REFRESH_TOKEN && process.env.GMAIL_CLIENT_ID;
  if (!hasGmail) { console.log('[TASK] No Gmail credentials — skipping'); return; }
  console.log('[TASK] Scanning Gmail…');
  try {
    const confs = getConfirmations();
    for (const c of confs) {
      if (c.sent) continue;

      // Check sent mail for outbound confirmation
      const sentMsgs = await gmail.searchMessages(
        `in:sent "${c.site}" after:${daysBefore(2)}`, 5
      );
      if (sentMsgs.length > 0) {
        updateConfirmation(c.id, { sent: true });
        addAlert({ type:'confirmed', confirmationId:c.id, message:`✅ Gmail: Confirmation sent for "${c.site}" — auto-marked.` });
        console.log(`[TASK] Gmail auto-confirmed: ${c.site}`);
      } else if (c.recipient) {
        // Check for client reply
        const replyMsgs = await gmail.searchMessages(
          `from:${c.recipient} "${c.site}" after:${daysBefore(3)}`, 3
        );
        if (replyMsgs.length > 0) {
          updateConfirmation(c.id, { replied: true });
          addAlert({ type:'reply', confirmationId:c.id, message:`📬 "${c.site}" — client replied. Check inbox.` });
          console.log(`[TASK] Gmail reply detected: ${c.site}`);
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }
    if (broadcast) broadcast();
  } catch (e) {
    console.error('[TASK] Gmail error:', e.message);
  }
}

// ── TASK 3: 24hr checker — every 5 min ───────────────────────
function runConfirmationCheck() {
  const ts = Date.now();
  let changed = false;
  getConfirmations().forEach(c => {
    if (c.sent) return;
    const left = WINDOW_MS - (ts - c.completedAt);
    if (left <= 0 && !c.flagged) {
      updateConfirmation(c.id, { flagged: true });
      addAlert({ type:'overdue', confirmationId:c.id, message:`⚠ OVERDUE: "${c.site}" passed 24-hour window.` });
      changed = true;
    } else if (left > 0 && left <= 3*3600000 && !c.warnedAt) {
      updateConfirmation(c.id, { warnedAt: ts });
      addAlert({ type:'warning', confirmationId:c.id, message:`⏱ URGENT: "${c.site}" due in ${Math.ceil(left/3600000)}h.` });
      changed = true;
    }
  });
  if (changed && broadcast) broadcast();
}

// ── TASK 4: AI scan — every 6 hours ──────────────────────────
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
      console.error(`[TASK] AI error for ${p.name}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  if (broadcast) broadcast();
}

// ── Init ──────────────────────────────────────────────────────
async function init(broadcastFn) {
  broadcast = broadcastFn;
  await buildStageMap();
  await buildOwnerMap();
  await buildLeaderEnums();

  // Set TZ=America/New_York in Railway vars for 8am ET
  cron.schedule('0 8 * * *',   () => runHubSpotSync());
  cron.schedule('5 8 * * *',   () => runGmailSync());
  cron.schedule('*/5 * * * *', () => runConfirmationCheck());
  cron.schedule('0 */6 * * *', () => runAIStatusScan());

  console.log('[CRON] Running startup sync…');
  await runHubSpotSync();
  runConfirmationCheck();
  runAIStatusScan();
  console.log('[CRON] All tasks active.');
}

module.exports = { init, runHubSpotSync };
