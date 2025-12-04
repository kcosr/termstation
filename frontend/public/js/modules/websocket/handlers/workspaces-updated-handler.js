/**
 * Workspaces Updated Handler
 * Updates the workspace list from server on broadcast
 */
import { appStore } from '../../../core/store.js';
import { apiService } from '../../../services/api.service.js';

export class WorkspacesUpdatedHandler {
    async handle(message, context) {
        try {
            // Preserve existing filterActive flag if present to avoid resetting user preference
            const prev = appStore.getState('workspaces');
            const prevFilterActive = prev && Object.prototype.hasOwnProperty.call(prev, 'filterActive')
                ? prev.filterActive
                : undefined;
            // Use payload if provided, otherwise fetch
            let list = Array.isArray(message.workspaces) ? message.workspaces : null;
            if (!list) {
                const resp = await apiService.getWorkspaces();
                list = resp?.workspaces || [];
            }
            // Normalize to objects { name, pinned }
            const workspaces = list.map(w => (typeof w === 'string' ? { name: w, pinned: false } : { name: w.name, pinned: !!w.pinned }));
            // Build ordered list and sets for store
            const order = workspaces.map(w => w.name);
            const namesSet = new Set(order);
            if (!namesSet.has('Default')) {
                namesSet.add('Default');
                order.includes('Default') || order.unshift('Default');
            }
            const pinnedSet = new Set(workspaces.filter(w => w.pinned).map(w => w.name));

            appStore.beginTransaction();
            appStore.setPath('workspaces.order', order);
            appStore.setPath('workspaces.items', namesSet);
            appStore.setPath('workspaces.pinned', pinnedSet);
            // Re-apply preserved filterActive if it existed
            if (prevFilterActive !== undefined) {
                appStore.setPath('workspaces.filterActive', prevFilterActive === true);
            }
            
            // Update selected name if server reports rename
            if (message.action === 'renamed' && message.old_name && message.new_name) {
                const current = appStore.getState('workspaces')?.current;
                if (current && current === message.old_name) {
                    appStore.setPath('workspaces.current', message.new_name);
                }
            }
            // Clear current if the selected one was deleted
            if (message.action === 'deleted' && message.name) {
                const current = appStore.getState('workspaces')?.current;
                if (current && current === message.name) {
                    appStore.setPath('workspaces.current', null);
                }
            }
            appStore.commitTransaction();

            // Ask terminal manager to refresh derived workspace list from sessions too
            if (context.terminalManager && context.terminalManager.updateWorkspacesFromSessions) {
                context.terminalManager.updateWorkspacesFromSessions();
            }
        } catch (error) {
            console.warn('[WorkspacesUpdatedHandler] Failed to update workspaces:', error);
        }
    }
}

export const workspacesUpdatedHandler = new WorkspacesUpdatedHandler();
