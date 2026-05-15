// tasks/scheduler.js
// Runs on the server via node-cron. Fires independently of browser connections.
// broadcast() is injected by server.js so tasks can push live updates to all clients.

const cron = require('node-cron');
const {
  getConfirmations, updateConfirmation, addAlert,
  getProjects, updateProject
} = require('../state');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const WINDOW_MS     = 24 * 60 * 60 * 1000; // 24 hours

let broadcast; // set via init()

// ─────────────────────────────────────────────────────────────
// TASK 1: Confirmation window checker
// Runs every 5 minutes. Flags confirmations approaching or past
// the 24-hour window and creates alerts.
// ─────────────────────────────────────────────────────────────
function runConfirmationCheck() {
  const confs = getConfirmations();
  const ts    = Date.now();
  let changed = false;

  confs.forEach(c => {
    if (c.sent) return;

    const elapsed  = ts - c.completedAt;
    const timeLeft = WINDOW_MS - elapsed;

    // Overdue: past 24h window
    if (timeLeft <= 0 && !c.flagged) {
      updateConfirmation(c.id, { flagged: true });
      addAlert({
        type: 'overdue',
        confirmationId: c.id,
        message: `⚠ OVERDUE: "${c.site}" confirmation email has passed the 24-hour window.`
      });
      changed = true;
      console.log(`[TASK] Flagged overdue: ${c.site}`);
    }

    // Warning: under 3 hours left, not yet flagged warning
    if (timeLeft > 0 && timeLeft <= 3 * 3600 * 1000 && !c.flagged) {
      addAlert({
        type: 'warning',
        confirmationId: c.id,
        message: `⏱ URGENT: "${c.site}" confirmation due in ${Math.ceil(timeLeft / 3600000)}h — send now.`
      });
      changed = true;
      console.log(`[TASK] Warning alert: ${c.site}`);
    }
  });

  if (changed && broadcast) broadcast();
}

// ─────────────────────────────────────────────────────────────
// TASK 2: AI project status scan
// Runs every 6 hours. For each project that is 'at-risk' or
// 'needs-attention', asks Claude for an updated status note.
// Requires ANTHROPIC_API_KEY env var on Railway.
// ─────────────────────────────────────────────────────────────
async function runProjectStatusScan() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[TASK] Skipping AI status scan — ANTHROPIC_API_KEY not set');
    return;
  }

  const projects = getProjects().filter(p =>
    p.status === 'at-risk' || p.status === 'needs-attention'
  );

  if (!projects.length) {
    console.log('[TASK] No at-risk projects to scan');
    return;
  }

  console.log(`[TASK] Running AI status scan on ${projects.length} project(s)`);

  for (const p of projects) {
    try {
      const res = await fetch(ANTHROPIC_API, {
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
            content: `You are an assistant for Rasmus Auctions field operations. Given this at-risk project, write a concise 2-sentence operational status note flagging the key concern and suggested next action.

Project: ${p.name}
Location: ${p.location}
Auction Date: ${p.date || 'TBD'}
Status: ${p.status}
Notes: ${p.notes || 'None'}
Last Summary: ${p.summaryText || 'None'}

Write only the 2-sentence status note, no preamble.`
          }]
        })
      });

      const data = await res.json();
      const text = data.content?.[0]?.text;
      if (text) {
        updateProject(p.id, { summaryText: text });
        addAlert({
          type: 'status-update',
          projectId: p.id,
          message: `🔄 AI status updated for "${p.name}": ${text.slice(0, 80)}…`
        });
        console.log(`[TASK] AI summary updated: ${p.name}`);
      }
    } catch (err) {
      console.error(`[TASK] AI scan failed for ${p.name}:`, err.message);
    }

    // Avoid hammering the API back-to-back
    await new Promise(r => setTimeout(r, 1500));
  }

  if (broadcast) broadcast();
}

// ─────────────────────────────────────────────────────────────
// Init — called by server.js, injects the broadcast function
// ─────────────────────────────────────────────────────────────
function init(broadcastFn) {
  broadcast = broadcastFn;

  // Confirmation check: every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    console.log('[CRON] Running confirmation check…');
    runConfirmationCheck();
  });

  // AI project scan: every 6 hours
  cron.schedule('0 */6 * * *', () => {
    console.log('[CRON] Running AI project status scan…');
    runProjectStatusScan();
  });

  // Run both immediately on startup
  console.log('[CRON] Running startup checks…');
  runConfirmationCheck();
  runProjectStatusScan();

  console.log('[CRON] Scheduled tasks active.');
}

module.exports = { init };
