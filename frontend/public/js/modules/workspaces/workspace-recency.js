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
