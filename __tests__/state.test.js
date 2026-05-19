let state;

beforeEach(() => {
  jest.resetModules();
  state = require('../state');
});

// ── Projects ─────────────────────────────────────────────────────

describe('projects', () => {
  test('seed data is present on load', () => {
    expect(state.getProjects().length).toBeGreaterThan(0);
  });

  test('addProject creates a project with defaults', () => {
    const before = state.getProjects().length;
    state.addProject({ name: 'Test Job', location: 'VA', date: '2026-06-01', status: 'on-track' });
    expect(state.getProjects().length).toBe(before + 1);
    const p = state.getProjects().find(p => p.name === 'Test Job');
    expect(p.activityLog).toEqual([]);
    expect(p.contactName).toBe('');
    expect(p.contactPhone).toBe('');
    expect(p.contactEmail).toBe('');
    expect(p.summaryText).toBe('');
    expect(p.id).toBeDefined();
    expect(p.createdAt).toBeDefined();
  });

  test('getProject returns undefined for unknown id', () => {
    expect(state.getProject('nonexistent')).toBeUndefined();
  });

  test('updateProject patches fields', () => {
    state.addProject({ name: 'Patch Me', status: 'on-track' });
    const p = state.getProjects().find(p => p.name === 'Patch Me');
    state.updateProject(p.id, { status: 'at-risk', notes: 'urgent' });
    const updated = state.getProject(p.id);
    expect(updated.status).toBe('at-risk');
    expect(updated.notes).toBe('urgent');
    expect(updated.name).toBe('Patch Me');
  });

  test('updateProject on unknown id is a no-op', () => {
    const before = state.getProjects().length;
    state.updateProject('bad-id', { name: 'Ghost' });
    expect(state.getProjects().length).toBe(before);
  });

  test('deleteProject removes the project', () => {
    const before = state.getProjects().length;
    state.addProject({ name: 'Remove Me', status: 'on-track' });
    const p = state.getProjects().find(p => p.name === 'Remove Me');
    state.deleteProject(p.id);
    expect(state.getProjects().length).toBe(before);
    expect(state.getProject(p.id)).toBeUndefined();
  });

  test('addActivityLog prepends entries in reverse-chronological order', () => {
    state.addProject({ name: 'Log Test' });
    const p = state.getProjects().find(p => p.name === 'Log Test');
    state.addActivityLog(p.id, 'First');
    state.addActivityLog(p.id, 'Second');
    const logs = state.getProject(p.id).activityLog;
    expect(logs.length).toBe(2);
    expect(logs[0].text).toBe('Second');
    expect(logs[1].text).toBe('First');
    expect(logs[0].id).toBeDefined();
    expect(logs[0].ts).toBeDefined();
  });

  test('addActivityLog on unknown id is a no-op', () => {
    expect(() => state.addActivityLog('bad-id', 'text')).not.toThrow();
  });

  test('setProjects replaces project list', () => {
    state.setProjects([{ id: 'x1', name: 'Only One', status: 'on-track', activityLog: [], contactName: '', contactPhone: '', contactEmail: '' }]);
    expect(state.getProjects().length).toBe(1);
    expect(state.getProject('x1').name).toBe('Only One');
  });

  test('setProjects preserves activityLog from existing project', () => {
    const existing = state.getProjects()[0];
    state.addActivityLog(existing.id, 'preserve me');
    state.setProjects([{ id: existing.id, name: existing.name, status: 'at-risk', activityLog: [], contactName: '', contactPhone: '', contactEmail: '' }]);
    expect(state.getProject(existing.id).activityLog[0].text).toBe('preserve me');
  });

  test('setProjects preserves contact info when incoming is empty', () => {
    const existing = state.getProjects()[0];
    state.updateProject(existing.id, { contactName: 'Jane Smith', contactPhone: '555-9876', contactEmail: 'jane@example.com' });
    state.setProjects([{ id: existing.id, name: existing.name, status: 'on-track', activityLog: [], contactName: '', contactPhone: '', contactEmail: '' }]);
    const p = state.getProject(existing.id);
    expect(p.contactName).toBe('Jane Smith');
    expect(p.contactPhone).toBe('555-9876');
    expect(p.contactEmail).toBe('jane@example.com');
  });

  test('setProjects uses incoming contact info when provided', () => {
    const existing = state.getProjects()[0];
    state.updateProject(existing.id, { contactName: 'Old Name' });
    state.setProjects([{ id: existing.id, name: existing.name, status: 'on-track', activityLog: [], contactName: 'New Name', contactPhone: '', contactEmail: '' }]);
    expect(state.getProject(existing.id).contactName).toBe('New Name');
  });
});

// ── Confirmations ─────────────────────────────────────────────────

describe('confirmations', () => {
  test('addConfirmation creates with defaults', () => {
    const before = state.getConfirmations().length;
    state.addConfirmation({ site: 'Test Site', completedAt: Date.now() });
    expect(state.getConfirmations().length).toBe(before + 1);
    const c = state.getConfirmations().find(c => c.site === 'Test Site');
    expect(c.sent).toBe(false);
    expect(c.flagged).toBe(false);
    expect(c.draftText).toBe('');
    expect(c.id).toBeDefined();
  });

  test('updateConfirmation patches fields', () => {
    state.addConfirmation({ site: 'Update Site', completedAt: Date.now() });
    const c = state.getConfirmations().find(c => c.site === 'Update Site');
    state.updateConfirmation(c.id, { sent: true });
    expect(state.getConfirmation(c.id).sent).toBe(true);
    expect(state.getConfirmation(c.id).site).toBe('Update Site');
  });

  test('deleteConfirmation removes the confirmation', () => {
    state.addConfirmation({ site: 'Delete Site', completedAt: Date.now() });
    const c = state.getConfirmations().find(c => c.site === 'Delete Site');
    state.deleteConfirmation(c.id);
    expect(state.getConfirmation(c.id)).toBeUndefined();
  });
});

// ── Leader Projects ───────────────────────────────────────────────

describe('leaderProjects', () => {
  test('starts empty', () => {
    expect(state.getLeaderProjects()).toEqual([]);
  });

  test('addLeaderProject creates with createdAt', () => {
    state.addLeaderProject({ title: 'R100 Test Job', leader: 'Karen Kester', startDate: '2026-05-01', removalDate: '2026-07-01' });
    const lp = state.getLeaderProjects().find(p => p.title === 'R100 Test Job');
    expect(lp).toBeDefined();
    expect(lp.leader).toBe('Karen Kester');
    expect(lp.createdAt).toBeDefined();
  });

  test('updateLeaderProject patches fields', () => {
    state.addLeaderProject({ title: 'Patch LP', leader: 'Darren Estes' });
    const lp = state.getLeaderProjects().find(p => p.title === 'Patch LP');
    state.updateLeaderProject(lp.id, { leader: 'Blake Johnson' });
    expect(state.getLeaderProject(lp.id).leader).toBe('Blake Johnson');
  });

  test('deleteLeaderProject removes entry', () => {
    state.addLeaderProject({ title: 'Delete LP', leader: 'Kenneth Weaver' });
    const lp = state.getLeaderProjects().find(p => p.title === 'Delete LP');
    state.deleteLeaderProject(lp.id);
    expect(state.getLeaderProject(lp.id)).toBeUndefined();
  });
});

// ── Alerts ────────────────────────────────────────────────────────

describe('alerts', () => {
  test('addAlert prepends (most recent first)', () => {
    state.addAlert({ type: 'sync', message: 'First' });
    state.addAlert({ type: 'sync', message: 'Second' });
    expect(state.getAlerts()[0].message).toBe('Second');
  });

  test('addAlert attaches id and ts', () => {
    state.addAlert({ type: 'sync', message: 'Hello' });
    const a = state.getAlerts().find(a => a.message === 'Hello');
    expect(a.id).toBeDefined();
    expect(a.ts).toBeDefined();
  });

  test('clearAlert removes by id', () => {
    state.addAlert({ type: 'test', message: 'Remove Me' });
    const a = state.getAlerts().find(a => a.message === 'Remove Me');
    state.clearAlert(a.id);
    expect(state.getAlerts().find(a => a.message === 'Remove Me')).toBeUndefined();
  });

  test('caps alerts at 50', () => {
    for (let i = 0; i < 60; i++) state.addAlert({ type: 'test', message: `Alert ${i}` });
    expect(state.getAlerts().length).toBe(50);
  });
});

// ── Snapshot ──────────────────────────────────────────────────────

describe('getSnapshot', () => {
  test('includes all collections and serverTime', () => {
    const snap = state.getSnapshot();
    expect(snap).toHaveProperty('projects');
    expect(snap).toHaveProperty('confirmations');
    expect(snap).toHaveProperty('alerts');
    expect(snap).toHaveProperty('leaderProjects');
    expect(typeof snap.serverTime).toBe('number');
  });
});
