// ─────────────────────────────────────────────────────────────
// state.js — In-memory store (Railway free tier)
//
// UPGRADE PATH: When you add Railway Postgres, replace this
// module with a pg-backed equivalent. All reads/writes go
// through these exported functions so nothing else changes.
// ─────────────────────────────────────────────────────────────

const { uid, now } = require('./utils');

// ── Seed data ────────────────────────────────────────────────
let state = {
  projects: [
    {
      id: uid(), name: 'Henderson Estate', location: 'Fredericksburg, VA',
      date: '2026-05-22', status: 'on-track',
      notes: 'Full household — 3-day pack', summaryText: '',
      createdAt: now()
    },
    {
      id: uid(), name: 'Coastal Marine Surplus', location: 'Annapolis, MD',
      date: '2026-05-18', status: 'at-risk',
      notes: 'Awaiting transport permits', summaryText: '',
      createdAt: now()
    },
    {
      id: uid(), name: 'Capitol Industrial Lot 7', location: 'Richmond, VA',
      date: '2026-05-30', status: 'on-track',
      notes: 'Machinery appraisals in progress', summaryText: '',
      createdAt: now()
    }
  ],
  confirmations: [
    {
      id: uid(), site: 'Henderson Estate — Site Closeout',
      recipient: 'henderson@gmail.com', project: 'Henderson Estate',
      completedAt: now() - 18 * 3600 * 1000, sent: false,
      flagged: false, draftText: ''
    },
    {
      id: uid(), site: 'Coastal Marine — Dock Return',
      recipient: 'ops@coastalmarine.com', project: 'Coastal Marine Surplus',
      completedAt: now() - 26 * 3600 * 1000, sent: false,
      flagged: true, draftText: ''           // already overdue — pre-flagged
    },
    {
      id: uid(), site: 'Quentin Farm Auction',
      recipient: 'quentin@farmauctions.net', project: '',
      completedAt: now() - 6 * 3600 * 1000, sent: false,
      flagged: false, draftText: ''
    }
  ],
  alerts: [],  // { id, type, message, projectId?, confirmationId?, ts }
  leaderProjects: []  // { id, projectNumber, title, leader, startDate, removalDate, createdAt }
};

// ── Projects ─────────────────────────────────────────────────
function getProjects()          { return state.projects; }
function getProject(id)         { return state.projects.find(p => p.id === id); }
function addProject(data)       { state.projects.push({ id: uid(), createdAt: now(), summaryText: '', contactName: '', contactPhone: '', contactEmail: '', activityLog: [], ...data }); }
function updateProject(id, patch) {
  const i = state.projects.findIndex(p => p.id === id);
  if (i !== -1) state.projects[i] = { ...state.projects[i], ...patch };
}
function addActivityLog(id, text) {
  const i = state.projects.findIndex(p => p.id === id);
  if (i === -1) return;
  const log = state.projects[i].activityLog || [];
  state.projects[i] = { ...state.projects[i], activityLog: [{ id: uid(), ts: now(), text }, ...log] };
}
function deleteProject(id)      { state.projects = state.projects.filter(p => p.id !== id); }
function setProjects(incoming) {
  const keep = {};
  state.projects.forEach(p => { keep[p.id] = p; });
  state.projects = incoming.map(p => {
    const ex = keep[p.id];
    if (!ex) return p;
    return { ...p, contactName: ex.contactName || '', contactPhone: ex.contactPhone || '', contactEmail: ex.contactEmail || '', activityLog: ex.activityLog || [] };
  });
}

// ── Confirmations ─────────────────────────────────────────────
function getConfirmations()       { return state.confirmations; }
function getConfirmation(id)      { return state.confirmations.find(c => c.id === id); }
function addConfirmation(data)    { state.confirmations.push({ id: uid(), sent: false, flagged: false, draftText: '', ...data }); }
function updateConfirmation(id, patch) {
  const i = state.confirmations.findIndex(c => c.id === id);
  if (i !== -1) state.confirmations[i] = { ...state.confirmations[i], ...patch };
}
function deleteConfirmation(id)   { state.confirmations = state.confirmations.filter(c => c.id !== id); }

// ── Leader Projects ───────────────────────────────────────────
function getLeaderProjects()         { return state.leaderProjects; }
function getLeaderProject(id)        { return state.leaderProjects.find(p => p.id === id); }
function addLeaderProject(data)      { state.leaderProjects.push({ id: uid(), createdAt: now(), ...data }); }
function updateLeaderProject(id, patch) {
  const i = state.leaderProjects.findIndex(p => p.id === id);
  if (i !== -1) state.leaderProjects[i] = { ...state.leaderProjects[i], ...patch };
}
function deleteLeaderProject(id)     { state.leaderProjects = state.leaderProjects.filter(p => p.id !== id); }

// ── Alerts ────────────────────────────────────────────────────
function getAlerts()    { return state.alerts; }
function addAlert(alert) {
  state.alerts.unshift({ id: uid(), ts: now(), ...alert });
  if (state.alerts.length > 50) state.alerts = state.alerts.slice(0, 50); // cap
}
function clearAlert(id) { state.alerts = state.alerts.filter(a => a.id !== id); }

// ── Full snapshot (sent to clients) ───────────────────────────
function getSnapshot() {
  return {
    projects:       state.projects,
    confirmations:  state.confirmations,
    alerts:         state.alerts,
    leaderProjects: state.leaderProjects,
    serverTime:     now()
  };
}

module.exports = {
  getProjects, getProject, addProject, updateProject, addActivityLog, deleteProject, setProjects,
  getConfirmations, getConfirmation, addConfirmation, updateConfirmation, deleteConfirmation,
  getLeaderProjects, getLeaderProject, addLeaderProject, updateLeaderProject, deleteLeaderProject,
  getAlerts, addAlert, clearAlert,
  getSnapshot
};
