/**
 * Visible Sessions Selector
 * Computes the final, ordered list of sessions to display given the
 * sessionList state (including overlay search via filteredIds) and
 * optional instance data (like manualOrder).
 */

import { SessionFilterService } from '../session-filter-service.js';

/**
 * Compute visible sessions in final display order.
 * @param {Object} slState - sessionList slice from app store
 * @param {Object} opts - optional instance data
 * @param {Array<string>} [opts.manualOrder] - manual order of session IDs
 * @returns {Array<Object>} ordered array of session objects
 */
export function computeVisibleSessions(slState, opts = {}) {
  if (!slState || !slState.sessions || !(slState.sessions instanceof Map)) return [];
  const { sessions, filters, filteredIds, sortBy, sortOrder } = slState;
  const manualOrder = Array.isArray(opts.manualOrder) ? opts.manualOrder : [];

  // Build base set: respect overlay filteredIds even when empty
  let baseArray;
  if (Array.isArray(filteredIds)) {
    baseArray = filteredIds.map(id => sessions.get(id)).filter(Boolean);
  } else {
    baseArray = Array.from(sessions.values());
  }

  // Ignore text search when overlay is active
  const effectiveFilters = Array.isArray(filteredIds) ? { ...filters, search: '' } : (filters || {});
  const pinnedSessions = effectiveFilters.pinnedSessions || new Set();

  const filteredArray = SessionFilterService.filter(baseArray, effectiveFilters);

  // If manual order exists, use the SessionList semantics:
  if (manualOrder && manualOrder.length > 0) {
    return filteredArray.sort((a, b) => {
      // Pinned first
      const aPinned = pinnedSessions.has(a.session_id);
      const bPinned = pinnedSessions.has(b.session_id);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      // Manual order next
      const aIndex = manualOrder.indexOf(a.session_id);
      const bIndex = manualOrder.indexOf(b.session_id);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;

      // Fallback to default sort: created desc
      const aCreated = a.created_at || 0;
      const bCreated = b.created_at || 0;
      return (bCreated - aCreated);
    });
  }

  // Default sort via SessionFilterService
  return SessionFilterService.sort(
    filteredArray,
    pinnedSessions,
    sortBy,
    sortOrder
  );
}

