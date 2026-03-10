/**
 * Workspace recency helper utilities.
 * These helpers are intentionally pure so they can be tested independently.
 */

export const WORKSPACE_SORT_MODE_MANUAL = 'manual';
export const WORKSPACE_SORT_MODE_RECENT = 'recent';

export function normalizeWorkspaceSortMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return normalized === WORKSPACE_SORT_MODE_RECENT
    ? WORKSPACE_SORT_MODE_RECENT
    : WORKSPACE_SORT_MODE_MANUAL;
}

function parseNumericTimestamp(value) {
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  // Heuristic: values < 1e12 are likely unix seconds.
  if (value < 1e12) return Math.floor(value * 1000);
  return Math.floor(value);
}

/**
 * Parse timestamps from ISO string, unix-seconds, unix-millis, or Date.
 * Returns millisecond epoch number or null when invalid.
 */
export function parseTimestampToMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  if (typeof value === 'number') {
    return parseNumericTimestamp(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      return parseNumericTimestamp(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function resolveSessionId(input) {
  const raw = (input && (input.session_id || input.sessionId)) || '';
  const sessionId = String(raw).trim();
  return sessionId || null;
}

/**
 * Ranking fallback chain:
 *   last_output_at -> created_at -> 0
 */
export function computeSessionRecencyMillis(session) {
  if (!session || typeof session !== 'object') return 0;
  const outputTs = parseTimestampToMillis(session.last_output_at);
  if (outputTs != null) return outputTs;
  const createdTs = parseTimestampToMillis(
    Object.prototype.hasOwnProperty.call(session, 'created_at')
      ? session.created_at
      : session.createdAt
  );
  return createdTs != null ? createdTs : 0;
}

/**
 * Build a recency seed map from API sessions.
 */
export function buildRecencyMapFromSessions(sessions) {
  const recencyById = new Map();
  if (!Array.isArray(sessions)) return recencyById;
  sessions.forEach((session) => {
    const sessionId = resolveSessionId(session);
    if (!sessionId) return;
    recencyById.set(sessionId, computeSessionRecencyMillis(session));
  });
  return recencyById;
}

export function mergeRecencyMapsMaxWins(baseMap, incomingMap) {
  const next = new Map(baseMap instanceof Map ? baseMap : []);
  if (!(incomingMap instanceof Map)) return next;
  incomingMap.forEach((incomingTs, sessionId) => {
    const normalizedId = String(sessionId || '').trim();
    if (!normalizedId) return;
    const safeIncoming = Number.isFinite(incomingTs) ? incomingTs : 0;
    const current = Number(next.get(normalizedId)) || 0;
    if (safeIncoming > current) {
      next.set(normalizedId, safeIncoming);
    }
  });
  return next;
}

export function pruneRecencyMapBySessionIds(recencyMap, validSessionIds) {
  if (!(recencyMap instanceof Map)) return new Map();
  const validSet = validSessionIds instanceof Set ? validSessionIds : new Set();
  const next = new Map();
  recencyMap.forEach((ts, sessionId) => {
    const normalizedId = String(sessionId || '').trim();
    if (!normalizedId) return;
    if (!validSet.has(normalizedId)) return;
    next.set(normalizedId, Number.isFinite(ts) ? ts : 0);
  });
  return next;
}

/**
 * Sort workspace names by recency descending with manual-order tie-break.
 */
export function sortWorkspaceNamesByRecency({
  workspaceNames,
  sessions,
  sessionRecencyById,
  manualOrder
}) {
  const names = Array.isArray(workspaceNames) ? workspaceNames.filter(Boolean) : [];
  const sessionArray = sessions instanceof Map
    ? Array.from(sessions.values())
    : (Array.isArray(sessions) ? sessions : []);
  const recencyMap = sessionRecencyById instanceof Map ? sessionRecencyById : new Map();
  const manualList = Array.isArray(manualOrder) ? manualOrder : [];

  const workspaceSet = new Set(names);
  const workspaceRecency = new Map();
  names.forEach((name) => workspaceRecency.set(name, 0));

  sessionArray.forEach((session) => {
    if (!session || typeof session !== 'object') return;
    const workspace = String(session.workspace || 'Default');
    if (!workspaceSet.has(workspace)) return;

    const sessionId = resolveSessionId(session);
    const fromMap = sessionId != null ? Number(recencyMap.get(sessionId)) : NaN;
    const recency = Number.isFinite(fromMap) ? fromMap : computeSessionRecencyMillis(session);
    const current = Number(workspaceRecency.get(workspace)) || 0;
    if (recency > current) {
      workspaceRecency.set(workspace, recency);
    }
  });

  const manualIndex = new Map();
  manualList.forEach((name, idx) => {
    if (!manualIndex.has(name)) manualIndex.set(name, idx);
  });
  const inputIndex = new Map();
  names.forEach((name, idx) => {
    if (!inputIndex.has(name)) inputIndex.set(name, idx);
  });

  return [...names].sort((a, b) => {
    const recencyA = Number(workspaceRecency.get(a)) || 0;
    const recencyB = Number(workspaceRecency.get(b)) || 0;
    if (recencyA !== recencyB) return recencyB - recencyA;

    const manualA = manualIndex.has(a) ? manualIndex.get(a) : (inputIndex.get(a) ?? Number.MAX_SAFE_INTEGER);
    const manualB = manualIndex.has(b) ? manualIndex.get(b) : (inputIndex.get(b) ?? Number.MAX_SAFE_INTEGER);
    if (manualA !== manualB) return manualA - manualB;

    return String(a).localeCompare(String(b));
  });
}

/**
 * Resolve deterministic display order for sidebar workspaces.
 * - manual mode: manual order filtered to eligible set
 * - recent mode: applied recent snapshot filtered to eligible set,
 *   then append missing eligible names in manual-order fallback
 */
export function buildWorkspaceDisplayOrder({
  sortMode,
  manualOrder,
  eligibleNames,
  appliedRecentOrder
}) {
  const mode = normalizeWorkspaceSortMode(sortMode);
  const manualList = Array.isArray(manualOrder) ? manualOrder.filter(Boolean) : [];
  const eligibleList = Array.isArray(eligibleNames) ? eligibleNames.filter(Boolean) : [];
  const eligibleSet = new Set(eligibleList);

  const manualOrderedEligible = manualList.filter((name) => eligibleSet.has(name));
  const manualSet = new Set(manualOrderedEligible);
  const manualFallback = [
    ...manualOrderedEligible,
    ...eligibleList.filter((name) => !manualSet.has(name))
  ];

  if (mode !== WORKSPACE_SORT_MODE_RECENT) {
    return manualFallback;
  }

  const appliedRecent = Array.isArray(appliedRecentOrder) ? appliedRecentOrder.filter(Boolean) : [];
  const recentEligible = appliedRecent.filter((name) => eligibleSet.has(name));
  const recentSet = new Set(recentEligible);
  const missing = manualFallback.filter((name) => !recentSet.has(name));
  return [...recentEligible, ...missing];
}

function areOrderedNameArraysEqual(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function hasWorkspaceDisplayOrderChanged({
  sortMode,
  manualOrder,
  eligibleNames,
  currentAppliedRecentOrder,
  nextAppliedRecentOrder
}) {
  const currentOrder = buildWorkspaceDisplayOrder({
    sortMode,
    manualOrder,
    eligibleNames,
    appliedRecentOrder: currentAppliedRecentOrder
  });
  const nextOrder = buildWorkspaceDisplayOrder({
    sortMode,
    manualOrder,
    eligibleNames,
    appliedRecentOrder: nextAppliedRecentOrder
  });
  return !areOrderedNameArraysEqual(currentOrder, nextOrder);
}

/**
 * Compute sort-mode transition effects for manager state updates.
 */
export function resolveWorkspaceSortTransition({
  requestedMode,
  applyRecent = true,
  currentDirty = false
}) {
  const nextMode = normalizeWorkspaceSortMode(requestedMode);
  if (nextMode === WORKSPACE_SORT_MODE_MANUAL) {
    return { nextMode, nextDirty: false, shouldApplyRecent: false };
  }
  if (applyRecent) {
    return { nextMode, nextDirty: false, shouldApplyRecent: true };
  }
  return { nextMode, nextDirty: currentDirty === true, shouldApplyRecent: false };
}

export function shouldShowWorkspaceSortRefresh(sortMode, sortDirty) {
  return normalizeWorkspaceSortMode(sortMode) === WORKSPACE_SORT_MODE_RECENT && sortDirty === true;
}
