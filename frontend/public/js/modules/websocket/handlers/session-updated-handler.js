/**
 * Session Updated Message Handler
 * Handles session update messages (created, updated, terminated)
 */
import { notificationDisplay } from '../../../utils/notification-display.js';
import { debug } from '../../../utils/debug.js';
import { appStore } from '../../../core/store.js';
import { computeDisplayTitle } from '../../../utils/title-utils.js';

// Track sessions we have already notified as terminated to avoid duplicates
const notifiedTerminations = new Set();
export class SessionUpdatedHandler {
    async handle(message, context) {
        debug.log('wsLogs', '[SessionUpdatedHandler] Processing session_updated message:', message);
        
        if (!message.session_data || !message.update_type) {
            console.warn('[SessionUpdatedHandler] Invalid message format:', message);
            return;
        }
        
        debug.log('wsLogs', `[SessionUpdatedHandler] Handling update type: ${message.update_type} for session: ${message.session_data.session_id}`);
        
        // Delegate to terminal manager's session update handler
        if (context.terminalManager && context.terminalManager.handleSessionUpdate) {
            debug.log('wsLogs', '[SessionUpdatedHandler] Calling terminalManager.handleSessionUpdate');
            await context.terminalManager.handleSessionUpdate(message.session_data, message.update_type);
        } else {
            console.warn('[SessionUpdatedHandler] No terminalManager or handleSessionUpdate method available in context');
        }
        
        // Termination notifications are now server-generated and persisted.
        // Do not raise a local notification here to avoid duplication.

        // Emit event for other components
        if (context.eventBus) {
            debug.log('wsLogs', `[SessionUpdatedHandler] Emitting event: session:${message.update_type}`);
            context.eventBus.emit(`session:${message.update_type}`, {
                sessionData: message.session_data,
                updateType: message.update_type
            });
        } else {
            console.warn('[SessionUpdatedHandler] No eventBus available in context');
        }
        
        debug.log('wsLogs', '[SessionUpdatedHandler] Completed processing');
    }
}

export const sessionUpdatedHandler = new SessionUpdatedHandler();
