/**
 * Stdout Message Handler
 * Handles terminal output messages
 */
import { debug } from '../../../utils/debug.js';
import { wsSessionTrace } from '../../../utils/ws-session-trace.js';

export class StdoutHandler {
    handle(message, context) {
        if (!message.session_id) {
            console.warn('[StdoutHandler] Message missing session_id:', message);
            return;
        }
        
        // Get session from terminal manager
        if (context.terminalManager) {
            try {
                const bytes = typeof message.data === 'string' ? message.data.length : 0;
                wsSessionTrace.pushStdout(message.session_id, bytes);
            } catch (_) {}
            const session = context.terminalManager.sessions.get(message.session_id);
            if (session) {
                // Pass along the from_queue flag if present (for debugging)
                session.handleOutput(message.data, message.from_queue || false);
            } else {
                // Session might not exist yet or be filtered out
                debug.debug('wsLogs', `[StdoutHandler] Session ${message.session_id} not found in active sessions`);
            }
        }
    }
}

export const stdoutHandler = new StdoutHandler();
