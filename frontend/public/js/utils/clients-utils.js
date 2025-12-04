/**
 * Clients Utils
 * Helpers for computing connected client information
 */

/**
 * Get IDs of clients connected to the session excluding the current client
 * @param {Object} sessionData
 * @param {string} currentClientId
 * @returns {string[]} other client IDs
 */
export function getOtherClientIds(sessionData, currentClientId) {
  try {
    const ids = Array.isArray(sessionData?.connected_client_ids)
      ? sessionData.connected_client_ids
      : [];
    return ids.filter((id) => id && id !== currentClientId);
  } catch (_) {
    return [];
  }
}

/**
 * Count other clients connected to the session
 * @param {Object} sessionData
 * @param {string} currentClientId
 * @returns {number}
 */
export function countOtherClients(sessionData, currentClientId) {
  return getOtherClientIds(sessionData, currentClientId).length;
}

