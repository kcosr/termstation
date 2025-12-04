/**
 * Session Detached Message Handler
 * Handles session detach messages when a client disconnects from a session
 */
import { notificationDisplay } from '../../../utils/notification-display.js';
export class SessionDetachedHandler {
    handle(message, context) {
        console.log(`[SessionDetachedHandler] Client detached from session: ${message.session_id}`);
        
        // Update terminal manager UI/state to reflect detach without echoing a WS detach
        try {
            if (context.terminalManager && typeof context.terminalManager.handleRemoteDetach === 'function') {
                context.terminalManager.handleRemoteDetach(message.session_id);
            } else if (context.terminalManager && context.terminalManager.connectedSessionId === message.session_id) {
                // Fallback: ensure the attach button appears for current session
                const mgr = context.terminalManager;
                mgr.viewController?.clearTerminalView?.();
                const sessionListData = mgr.sessionList?.getSessionData?.(message.session_id) || { session_id: message.session_id };
                mgr.viewController?.showAttachButton?.(sessionListData);
                mgr.viewController?.updateAttachDetachButton?.(sessionListData);
            }
        } catch (e) {
            console.warn('[SessionDetachedHandler] Failed to update UI on remote detach:', e);
        }
        
        // Notify the user that they have been detached (forced-detach or remote detach)
        try {
            const sid = message.session_id || '';
            const shortId = sid ? sid.substring(0, 8) : '';
            let friendly = '';
            try {
                const data = context?.terminalManager?.sessionList?.getSessionData?.(sid);
                if (data) {
                    friendly = (data.title && data.title.trim()) ||
                               (data.template_name && data.template_name.trim()) ||
                               (data.command && data.command.trim()) || '';
                }
            } catch (_) { /* ignore */ }
            const pretty = friendly ? friendly : (shortId ? `Session ${shortId}` : 'Session');
            notificationDisplay.show({
                title: 'Detached',
                message: `You were detached from ${pretty}`,
                notification_type: 'warning',
                session_id: sid,
                is_active: true
            });
        } catch (_) { /* ignore notification failures */ }
        
        // Emit event for other components
        if (context.eventBus) {
            context.eventBus.emit('session:detached', {
                sessionId: message.session_id
            });
        }
    }
}

export const sessionDetachedHandler = new SessionDetachedHandler();
