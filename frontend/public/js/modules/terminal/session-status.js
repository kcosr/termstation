/**
 * Session Status Manager
 * Handles session status calculations, badge generation, and tooltips
 */

import { getOtherClientIds } from '../../utils/clients-utils.js';

export class SessionStatusManager {
    constructor() {
        // No state needed - all methods are pure functions
    }

    /**
     * Calculate display information for a session
     * @param {Object} sessionData - Session data object
     * @param {string} currentClientId - Current client's ID
     * @param {string} connectedSessionId - Currently connected session ID
     * @returns {Object} Display info with statusHtml and sessionClass
     */
    calculateDisplayInfo(sessionData, currentClientId, connectedSessionId) {
        if (!sessionData.is_active) {
            return {
                statusHtml: '<span class="session-status-pill session-status-pill--ended" title="Session ended">ENDED</span>' +
                    '<button class="load-history-btn" title="Load History">📜</button>',
                sessionClass: 'terminated'
            };
        }

        // Active session - calculate client count display
        const isCurrentConnected = connectedSessionId === sessionData.session_id;
        const otherClientIds = getOtherClientIds(sessionData, currentClientId);
        const otherClientsCount = otherClientIds.length;
        
        let statusHtml = '';
        if (otherClientsCount > 0) {
            const tooltipText = this.createTooltip(otherClientIds, otherClientsCount);
            statusHtml = this.createStatusBadge(otherClientsCount, tooltipText);
        }

        // Green border only if OTHER clients are connected (excluding ourselves)
        const sessionClass = otherClientsCount > 0 ? 'connected' : 'idle';

        return {
            statusHtml,
            sessionClass
        };
    }

    /**
     * Create status badge HTML
     * @param {number} clientCount - Number of other clients
     * @param {string} tooltipText - Tooltip text to display
     * @returns {string} Badge HTML
     */
    createStatusBadge(clientCount, tooltipText) {
        return `<span class="status-badge status-idle" data-tooltip="${tooltipText}">${clientCount}</span>`;
    }

    /**
     * Create tooltip text for other clients
     * @param {Array} otherClientIds - Array of other client IDs
     * @param {number} otherClientsCount - Count of other clients
     * @returns {string} Tooltip text
     */
    createTooltip(otherClientIds, otherClientsCount) {
        return otherClientIds.length > 0 ? 
            `Other clients: ${otherClientIds.join(', ')}` :
            `${otherClientsCount} other client${otherClientsCount === 1 ? '' : 's'}`;
    }

    /**
     * Filter out current client from connected clients list
     * @param {Array} connectedClientIds - Array of all connected client IDs
     * @param {string} currentClientId - Current client's ID
     * @returns {Array} Filtered array without current client
     */
    filterOtherClients(connectedClientIds, currentClientId) {
        // Delegate to shared util for consistency
        try { return getOtherClientIds({ connected_client_ids: connectedClientIds }, currentClientId); } catch (_) { return []; }
    }
}
