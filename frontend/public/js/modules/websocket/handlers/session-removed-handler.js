/**
 * Session Removed Handler
 * Handle server instruction to remove a session from the client UI
 */
export const sessionRemovedHandler = {
    handle(message, context) {
        try {
            const sessionId = message.session_id || message.sessionId || null;
            if (!sessionId) return;
            const { terminalManager } = context;
            if (!terminalManager || !terminalManager.sessionList) return;
            // Remove from session list store
            try { terminalManager.sessionList.removeSession(sessionId); } catch (_) {}
            // Clear selection if it was the current one
            try {
                if (terminalManager.currentSessionId === sessionId) {
                    terminalManager.clearTerminalView();
                    terminalManager.currentSessionId = null;
                    terminalManager.currentSession = null;
                }
            } catch (_) {}
            try { terminalManager.updateSessionTabs(); } catch (_) {}
        } catch (_) {}
    }
};
