/**
 * Link Removed Handler
 * Handles WebSocket messages for link removals
 */
import { debug } from '../../../utils/debug.js';

export const linkRemovedHandler = {
    handle(message, context) {
        const { terminalManager, eventBus } = context;
        
        debug.log('wsLogs', '[LinkRemovedHandler] Received link-removed message:', message);
        
        // Validate required fields
        if (!message.sessionId || !message.url) {
            console.error('[LinkRemovedHandler] Missing required fields in message:', message);
            return;
        }
        
        // Update session data if this is the current session
        if (terminalManager.currentSession && terminalManager.currentSession.sessionId === message.sessionId) {
            const sessionData = terminalManager.sessionList.getSessionData(message.sessionId);
            if (sessionData && sessionData.links) {
                // Create updated session data with link removed
                const updatedLinks = sessionData.links.filter(link => link.url !== message.url);
                
                if (updatedLinks.length < sessionData.links.length) {
                    const updatedSessionData = {
                        ...sessionData,
                        links: updatedLinks
                    };
                    
                    // Update the store properly to trigger reactive updates
                    terminalManager.sessionList.updateSession(updatedSessionData);
                    debug.log('wsLogs', `[LinkRemovedHandler] Removed link from store: ${message.url}`);
                    
                    // Update the links dropdown with fresh data  
                    terminalManager.updateSessionLinks(updatedSessionData);
                    debug.log('wsLogs', `[LinkRemovedHandler] Updated links dropdown for session ${message.sessionId}`);
                }
            }
        }
        
        // Emit event for tab manager to handle
        eventBus.emit('link-removed', {
            sessionId: message.sessionId,
            url: message.url
        });
        
        debug.log('wsLogs', `[LinkRemovedHandler] Emitted link-removed event for session ${message.sessionId}`);
    }
};
