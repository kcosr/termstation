import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_SORT_MODE_MANUAL,
  WORKSPACE_SORT_MODE_RECENT,
  buildRecencyMapFromSessions,
  buildWorkspaceDisplayOrder,
  computeSessionRecencyMillis,
  mergeRecencyMapsMaxWins,
  normalizeWorkspaceSortMode,
  parseTimestampToMillis,
  pruneRecencyMapBySessionIds,
  resolveSessionId,
  resolveWorkspaceSortTransition,
  shouldShowWorkspaceSortRefresh,
  sortWorkspaceNamesByRecency
} from '../public/js/modules/workspaces/workspace-recency.js';

test('parseTimestampToMillis handles ISO, unix seconds, and invalid input', () => {
  assert.equal(
    parseTimestampToMillis('2026-03-10T15:00:00.000Z'),
    Date.parse('2026-03-10T15:00:00.000Z')
  );
  assert.equal(parseTimestampToMillis(1710000000), 1710000000000);
  assert.equal(parseTimestampToMillis('1710000000'), 1710000000000);
  assert.equal(parseTimestampToMillis(new Date('2026-03-10T15:00:00.000Z')), Date.parse('2026-03-10T15:00:00.000Z'));
  assert.equal(parseTimestampToMillis(1710000000000), 1710000000000);
  assert.equal(parseTimestampToMillis(-1), null);
  assert.equal(parseTimestampToMillis(Number.NaN), null);
  assert.equal(parseTimestampToMillis('not-a-date'), null);
  assert.equal(parseTimestampToMillis(''), null);
  assert.equal(parseTimestampToMillis(null), null);
});

test('normalizeWorkspaceSortMode defaults to manual and accepts case-insensitive recent', () => {
  assert.equal(normalizeWorkspaceSortMode('recent'), WORKSPACE_SORT_MODE_RECENT);
  assert.equal(normalizeWorkspaceSortMode(' ReCeNt '), WORKSPACE_SORT_MODE_RECENT);
  assert.equal(normalizeWorkspaceSortMode('manual'), WORKSPACE_SORT_MODE_MANUAL);
  assert.equal(normalizeWorkspaceSortMode(undefined), WORKSPACE_SORT_MODE_MANUAL);
});

test('resolveSessionId prefers session_id and falls back to sessionId', () => {
  assert.equal(resolveSessionId({ session_id: '  abc  ', sessionId: 'fallback' }), 'abc');
  assert.equal(resolveSessionId({ sessionId: '  xyz  ' }), 'xyz');
  assert.equal(resolveSessionId({ session_id: '' }), null);
  assert.equal(resolveSessionId(null), null);
});

test('computeSessionRecencyMillis follows last_output_at -> created_at -> 0 fallback', () => {
  const fromOutput = computeSessionRecencyMillis({
    last_output_at: '2026-03-10T16:00:00.000Z',
    created_at: '2026-03-10T10:00:00.000Z'
  });
  assert.equal(fromOutput, Date.parse('2026-03-10T16:00:00.000Z'));

  const fromCreated = computeSessionRecencyMillis({
    last_output_at: '',
    created_at: '2026-03-10T10:00:00.000Z'
  });
  assert.equal(fromCreated, Date.parse('2026-03-10T10:00:00.000Z'));

  const fromCreatedCamel = computeSessionRecencyMillis({
    last_output_at: '',
    createdAt: '2026-03-10T11:00:00.000Z'
  });
  assert.equal(fromCreatedCamel, Date.parse('2026-03-10T11:00:00.000Z'));

  assert.equal(computeSessionRecencyMillis({ last_output_at: null, created_at: null }), 0);
});

test('buildRecencyMapFromSessions normalizes session_id/sessionId', () => {
  const map = buildRecencyMapFromSessions([
    { session_id: 'a', created_at: '2026-03-10T10:00:00.000Z' },
    { sessionId: 'b', last_output_at: '2026-03-10T12:00:00.000Z' },
    { session_id: '', created_at: '2026-03-10T12:00:00.000Z' }
  ]);

  assert.equal(map.get('a'), Date.parse('2026-03-10T10:00:00.000Z'));
  assert.equal(map.get('b'), Date.parse('2026-03-10T12:00:00.000Z'));
  assert.equal(map.size, 2);
});

test('mergeRecencyMapsMaxWins preserves newer timestamps and prune removes stale ids', () => {
  const existing = new Map([
    ['a', 200],
    ['b', 150]
  ]);
  const incoming = new Map([
    ['a', 100], // older than existing -> ignored
    ['b', 250], // newer than existing -> applied
    ['c', 300] // new
  ]);

  const merged = mergeRecencyMapsMaxWins(existing, incoming);
  assert.equal(merged.get('a'), 200);
  assert.equal(merged.get('b'), 250);
  assert.equal(merged.get('c'), 300);

  const pruned = pruneRecencyMapBySessionIds(merged, new Set(['a', 'c']));
  assert.deepEqual(Array.from(pruned.entries()), [['a', 200], ['c', 300]]);
});

test('sortWorkspaceNamesByRecency uses recency desc with manual-order tie break', () => {
  const sessions = [
    { session_id: 'a1', workspace: 'Alpha', last_output_at: '2026-03-10T10:00:00.000Z' },
    { session_id: 'b1', workspace: 'Beta', last_output_at: '2026-03-10T10:00:00.000Z' },
    { session_id: 'g1', workspace: 'Gamma', last_output_at: '2026-03-10T09:00:00.000Z' }
  ];

  const order = sortWorkspaceNamesByRecency({
    workspaceNames: ['Beta', 'Alpha', 'Gamma', 'Empty'],
    sessions,
    sessionRecencyById: new Map(),
    manualOrder: ['Alpha', 'Beta', 'Gamma', 'Empty']
  });

  // Alpha/Beta tie on recency; manual order wins (Alpha then Beta).
  assert.deepEqual(order, ['Alpha', 'Beta', 'Gamma', 'Empty']);
});

test('buildWorkspaceDisplayOrder preserves manual mode and recent snapshot fallback', () => {
  const manual = buildWorkspaceDisplayOrder({
    sortMode: WORKSPACE_SORT_MODE_MANUAL,
    manualOrder: ['Alpha', 'Beta', 'Gamma'],
    eligibleNames: ['Beta', 'Gamma'],
    appliedRecentOrder: ['Gamma', 'Alpha']
  });
  assert.deepEqual(manual, ['Beta', 'Gamma']);

  const recent = buildWorkspaceDisplayOrder({
    sortMode: WORKSPACE_SORT_MODE_RECENT,
    manualOrder: ['Alpha', 'Beta', 'Gamma'],
    eligibleNames: ['Alpha', 'Beta', 'Gamma'],
    appliedRecentOrder: ['Gamma', 'Alpha']
  });
  assert.deepEqual(recent, ['Gamma', 'Alpha', 'Beta']);
});

test('recent mode does not auto-reorder until apply snapshot changes', () => {
  const workspaceNames = ['Alpha', 'Beta'];
  const sessions = [
    { session_id: 'a1', workspace: 'Alpha', created_at: '2026-03-10T10:00:00.000Z' },
    { session_id: 'b1', workspace: 'Beta', created_at: '2026-03-10T10:00:00.000Z' }
  ];
  const manualOrder = ['Alpha', 'Beta'];

  const initialRecency = new Map([
    ['a1', 200],
    ['b1', 100]
  ]);
  const appliedRecentOrder = sortWorkspaceNamesByRecency({
    workspaceNames,
    sessions,
    sessionRecencyById: initialRecency,
    manualOrder
  });
  assert.deepEqual(appliedRecentOrder, ['Alpha', 'Beta']);

  const updatedRecency = new Map([
    ['a1', 200],
    ['b1', 300]
  ]);
  const recomputed = sortWorkspaceNamesByRecency({
    workspaceNames,
    sessions,
    sessionRecencyById: updatedRecency,
    manualOrder
  });
  assert.deepEqual(recomputed, ['Beta', 'Alpha']);

  const stillRendered = buildWorkspaceDisplayOrder({
    sortMode: WORKSPACE_SORT_MODE_RECENT,
    manualOrder,
    eligibleNames: workspaceNames,
    appliedRecentOrder
  });
  assert.deepEqual(stillRendered, ['Alpha', 'Beta']);
});

test('resolveWorkspaceSortTransition enforces mode/dirty/apply semantics', () => {
  const enterRecent = resolveWorkspaceSortTransition({
    requestedMode: WORKSPACE_SORT_MODE_RECENT,
    applyRecent: true,
    currentDirty: true
  });
  assert.deepEqual(enterRecent, {
    nextMode: WORKSPACE_SORT_MODE_RECENT,
    nextDirty: false,
    shouldApplyRecent: true
  });

  const stayRecentNoApply = resolveWorkspaceSortTransition({
    requestedMode: WORKSPACE_SORT_MODE_RECENT,
    applyRecent: false,
    currentDirty: true
  });
  assert.deepEqual(stayRecentNoApply, {
    nextMode: WORKSPACE_SORT_MODE_RECENT,
    nextDirty: true,
    shouldApplyRecent: false
  });

  const leaveManual = resolveWorkspaceSortTransition({
    requestedMode: WORKSPACE_SORT_MODE_MANUAL,
    applyRecent: false,
    currentDirty: true
  });
  assert.deepEqual(leaveManual, {
    nextMode: WORKSPACE_SORT_MODE_MANUAL,
    nextDirty: false,
    shouldApplyRecent: false
  });
});

test('shouldShowWorkspaceSortRefresh only returns true for recent && dirty', () => {
  assert.equal(shouldShowWorkspaceSortRefresh('recent', true), true);
  assert.equal(shouldShowWorkspaceSortRefresh('recent', false), false);
  assert.equal(shouldShowWorkspaceSortRefresh('manual', true), false);
});
