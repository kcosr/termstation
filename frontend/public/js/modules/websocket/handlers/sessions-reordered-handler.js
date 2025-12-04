/**
 * Sessions Reordered Handler
 * Updates session workspace order for a given workspace
 */
export class SessionsReorderedHandler {
    async handle(message, context) {
        try {
            const { workspace, order } = message;
            if (!workspace || !Array.isArray(order)) return;

            const store = context.terminalManager?.sessionList?.store;
            if (!store) return;
            const current = store.getState().sessionList?.sessions;
            if (!current) return;

            const newSessions = new Map(current);
            order.forEach((sessionId, idx) => {
                if (newSessions.has(sessionId)) {
                    const data = newSessions.get(sessionId);
                    // Update only if in this workspace
                    if ((data.workspace || 'Default') === workspace) {
                        newSessions.set(sessionId, { ...data, workspace_order: idx });
                    }
                }
            });

            store.setPath('sessionList.sessions', newSessions);

            // Sync SessionList manual order with server-provided order so UI reflects it immediately
            try {
                const sl = context?.terminalManager?.sessionList;
                if (sl && typeof sl.applyManualOrderFromServer === 'function') {
                    sl.applyManualOrderFromServer(order, workspace);
                }
            } catch (_) {}
        } catch (e) {
            console.warn('[SessionsReorderedHandler] Failed to apply reorder:', e);
        }
    }
}

export const sessionsReorderedHandler = new SessionsReorderedHandler();
