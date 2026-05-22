// Mock node-cron so schedule() calls don't fire during tests
jest.mock('node-cron', () => ({ schedule: jest.fn() }));

// Mock gmail so no real network calls are made
jest.mock('../tasks/gmail', () => ({
  getAccessToken: jest.fn().mockResolvedValue('mock-token'),
  searchMessages: jest.fn().mockResolvedValue([]),
  sendEmail: jest.fn().mockResolvedValue(true),
}));

// Stable wrapper functions so scheduler.js destructuring captures these references,
// while the underlying impl can be swapped per-test via stateMocks.
const stateMocks = {};
jest.mock('../state', () => ({
  getConfirmations:    (...a) => stateMocks.getConfirmations(...a),
  updateConfirmation:  (...a) => stateMocks.updateConfirmation(...a),
  addConfirmation:     (...a) => stateMocks.addConfirmation(...a),
  deleteConfirmation:  (...a) => stateMocks.deleteConfirmation(...a),
  addAlert:            (...a) => stateMocks.addAlert(...a),
  getProjects:         (...a) => stateMocks.getProjects(...a),
  updateProject:       (...a) => stateMocks.updateProject(...a),
  setProjects:         (...a) => stateMocks.setProjects(...a),
  getLeaderProjects:   (...a) => stateMocks.getLeaderProjects(...a),
  addLeaderProject:    (...a) => stateMocks.addLeaderProject(...a),
  updateLeaderProject: (...a) => stateMocks.updateLeaderProject(...a),
  deleteLeaderProject: (...a) => stateMocks.deleteLeaderProject(...a),
}));

global.fetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  stateMocks.getConfirmations    = jest.fn().mockReturnValue([]);
  stateMocks.updateConfirmation  = jest.fn();
  stateMocks.addConfirmation     = jest.fn();
  stateMocks.deleteConfirmation  = jest.fn();
  stateMocks.addAlert            = jest.fn();
  stateMocks.getProjects         = jest.fn().mockReturnValue([]);
  stateMocks.updateProject       = jest.fn();
  stateMocks.setProjects         = jest.fn();
  stateMocks.getLeaderProjects   = jest.fn().mockReturnValue([]);
  stateMocks.addLeaderProject    = jest.fn();
  stateMocks.updateLeaderProject = jest.fn();
  stateMocks.deleteLeaderProject = jest.fn();
});

const { normalizeLeader, stageToStatus, runConfirmationCheck } = require('../tasks/scheduler');

// ── normalizeLeader ───────────────────────────────────────────────

describe('normalizeLeader', () => {
  test('returns empty string for falsy input', () => {
    expect(normalizeLeader('')).toBe('');
    expect(normalizeLeader(null)).toBe('');
    expect(normalizeLeader(undefined)).toBe('');
  });

  test('matches exact KNOWN_LEADERS names', () => {
    expect(normalizeLeader('Karen Kester')).toBe('Karen Kester');
    expect(normalizeLeader('Kenneth Weaver')).toBe('Kenneth Weaver');
    expect(normalizeLeader('Luciana Castillo')).toBe('Luciana Castillo');
    expect(normalizeLeader('Darren Estes')).toBe('Darren Estes');
    expect(normalizeLeader('Blake Johnson')).toBe('Blake Johnson');
    expect(normalizeLeader('Werner Manrique-Martinez')).toBe('Werner Manrique-Martinez');
  });

  test('case-insensitive match', () => {
    expect(normalizeLeader('karen kester')).toBe('Karen Kester');
    expect(normalizeLeader('BLAKE JOHNSON')).toBe('Blake Johnson');
    expect(normalizeLeader('darren estes')).toBe('Darren Estes');
  });

  test('resolves LEADER_ALIASES', () => {
    expect(normalizeLeader('kenny weaver')).toBe('Kenneth Weaver');
    expect(normalizeLeader('warner martinez')).toBe('Werner Manrique-Martinez');
    expect(normalizeLeader('werner martinez')).toBe('Werner Manrique-Martinez');
    expect(normalizeLeader('warner manrique-martinez')).toBe('Werner Manrique-Martinez');
  });

  test('matches by first name only', () => {
    expect(normalizeLeader('Karen')).toBe('Karen Kester');
    expect(normalizeLeader('Blake')).toBe('Blake Johnson');
  });

  test('matches by last name only', () => {
    expect(normalizeLeader('Kester')).toBe('Karen Kester');
    expect(normalizeLeader('Johnson')).toBe('Blake Johnson');
  });

  test('returns empty string for unknown name', () => {
    expect(normalizeLeader('John Doe')).toBe('');
    expect(normalizeLeader('Unknown Person')).toBe('');
  });

  test('strips underscores (HubSpot enum format)', () => {
    expect(normalizeLeader('karen_kester')).toBe('Karen Kester');
  });
});

// ── stageToStatus ─────────────────────────────────────────────────

describe('stageToStatus', () => {
  test('returns on-track for empty/null input', () => {
    expect(stageToStatus('')).toBe('on-track');
    expect(stageToStatus(null)).toBe('on-track');
    expect(stageToStatus(undefined)).toBe('on-track');
  });

  test('returns needs-attention for Reconciliation', () => {
    expect(stageToStatus('Reconciliation')).toBe('needs-attention');
    expect(stageToStatus('reconciliation phase')).toBe('needs-attention');
  });

  test('returns at-risk for active selling stages', () => {
    expect(stageToStatus('Selling & Closing')).toBe('at-risk');
    expect(stageToStatus('Selling Online')).toBe('at-risk');
    expect(stageToStatus('Live show')).toBe('at-risk');
  });

  test('returns on-track for all other stages', () => {
    expect(stageToStatus('New Auction')).toBe('on-track');
    expect(stageToStatus('Identification')).toBe('on-track');
    expect(stageToStatus('Staffing')).toBe('on-track');
    expect(stageToStatus('Quality Control')).toBe('on-track');
    expect(stageToStatus('Onboarding')).toBe('on-track');
  });
});

// ── runConfirmationCheck ──────────────────────────────────────────

describe('runConfirmationCheck', () => {
  const WINDOW_MS = 24 * 60 * 60 * 1000;

  test('does nothing when no confirmations', () => {
    stateMocks.getConfirmations.mockReturnValue([]);
    runConfirmationCheck();
    expect(stateMocks.updateConfirmation).not.toHaveBeenCalled();
    expect(stateMocks.addAlert).not.toHaveBeenCalled();
  });

  test('skips already-sent confirmations', () => {
    stateMocks.getConfirmations.mockReturnValue([
      { id: '1', site: 'Sent Site', sent: true, flagged: false, completedAt: Date.now() - WINDOW_MS - 1000 },
    ]);
    runConfirmationCheck();
    expect(stateMocks.updateConfirmation).not.toHaveBeenCalled();
    expect(stateMocks.addAlert).not.toHaveBeenCalled();
  });

  test('flags overdue confirmation (past 24h window)', () => {
    stateMocks.getConfirmations.mockReturnValue([
      { id: '1', site: 'Overdue Site', sent: false, flagged: false, idDateSet: true, completedAt: Date.now() - WINDOW_MS - 5000 },
    ]);
    runConfirmationCheck();
    expect(stateMocks.updateConfirmation).toHaveBeenCalledWith('1', { flagged: true });
    expect(stateMocks.addAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'overdue' }));
  });

  test('does not double-flag already-flagged overdue confirmation', () => {
    stateMocks.getConfirmations.mockReturnValue([
      { id: '1', site: 'Already Flagged', sent: false, flagged: true, completedAt: Date.now() - WINDOW_MS - 5000 },
    ]);
    runConfirmationCheck();
    expect(stateMocks.updateConfirmation).not.toHaveBeenCalled();
    expect(stateMocks.addAlert).not.toHaveBeenCalled();
  });

  test('issues warning when within 3h of deadline', () => {
    const twoHoursLeft = Date.now() - WINDOW_MS + 2 * 3600 * 1000;
    stateMocks.getConfirmations.mockReturnValue([
      { id: '2', site: 'Almost Due', sent: false, flagged: false, warnedAt: null, idDateSet: true, completedAt: twoHoursLeft },
    ]);
    runConfirmationCheck();
    expect(stateMocks.updateConfirmation).toHaveBeenCalledWith('2', expect.objectContaining({ warnedAt: expect.any(Number) }));
    expect(stateMocks.addAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });

  test('does not warn if already warned', () => {
    const twoHoursLeft = Date.now() - WINDOW_MS + 2 * 3600 * 1000;
    stateMocks.getConfirmations.mockReturnValue([
      { id: '2', site: 'Already Warned', sent: false, flagged: false, warnedAt: Date.now() - 1000, completedAt: twoHoursLeft },
    ]);
    runConfirmationCheck();
    expect(stateMocks.updateConfirmation).not.toHaveBeenCalled();
    expect(stateMocks.addAlert).not.toHaveBeenCalled();
  });

  test('does not warn for confirmation with plenty of time left', () => {
    const manyHoursLeft = Date.now() - WINDOW_MS + 10 * 3600 * 1000;
    stateMocks.getConfirmations.mockReturnValue([
      { id: '3', site: 'Plenty of Time', sent: false, flagged: false, warnedAt: null, completedAt: manyHoursLeft },
    ]);
    runConfirmationCheck();
    expect(stateMocks.updateConfirmation).not.toHaveBeenCalled();
    expect(stateMocks.addAlert).not.toHaveBeenCalled();
  });
});
