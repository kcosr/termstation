/**
 * Link Updated Handler
 * Handles WebSocket messages for link updates (renames)
 */
import { debug } from '../../../utils/debug.js';

export const linkUpdatedHandler = {
    handle(message, context) {
        const { terminalManager, eventBus } = context;
        
        debug.log('wsLogs', '[LinkUpdatedHandler] Received link-updated message:', message);
        
        // Validate required fields (url always required; name optional; refresh optional)
        if (!message.sessionId || !message.url) {
            console.error('[LinkUpdatedHandler] Missing required fields in message:', message);
            return;
        }
        
        // Update session data if this is the current session
        if (terminalManager.currentSession && terminalManager.currentSession.sessionId === message.sessionId) {
            const sessionData = terminalManager.sessionList.getSessionData(message.sessionId);
            if (sessionData && sessionData.links) {
                // Find and update the link in session data
                const linkToUpdate = sessionData.links.find(link => link.url === message.url);
                if (linkToUpdate) {
                    // Create updated session data with modified link
                    const updatedSessionData = {
                        ...sessionData,
                        links: sessionData.links.map(link => {
                            if (link.url !== message.url) return link;
                            const next = { ...link };
                            if (typeof message.name === 'string') next.name = message.name;
                            if (Object.prototype.hasOwnProperty.call(message, 'refresh')) next.refresh = !!message.refresh;
                            return next;
                        })
                    };
                    
                    // Update the store properly to trigger reactive updates
                    terminalManager.sessionList.updateSession(updatedSessionData);
                    debug.log('wsLogs', `[LinkUpdatedHandler] Updated link name in store: ${message.url} -> ${message.name}`);
                    
                    // Update the links dropdown with fresh data
                    terminalManager.updateSessionLinks(updatedSessionData);
                    debug.log('wsLogs', `[LinkUpdatedHandler] Updated links dropdown for session ${message.sessionId}`);
                }
            }
        }
        
        // Emit event for tab manager to handle
        eventBus.emit('link-updated', {
            sessionId: message.sessionId,
            url: message.url,
            name: message.name,
            refresh: Object.prototype.hasOwnProperty.call(message, 'refresh') ? !!message.refresh : undefined
        });
        
        debug.log('wsLogs', `[LinkUpdatedHandler] Emitted link-updated event for session ${message.sessionId}`);
    }
};
