/**
 * Deferred Input Updated Handler
 * Keeps the client-side deferred input queue in sync with the server.
 */
import { debug } from '../../../utils/debug.js';

export class DeferredInputUpdatedHandler {
    handle(message, context) {
        try {
            debug.log('wsLogs', '[DeferredInputUpdatedHandler]', message);
            const mgr = context && context.terminalManager;
            if (!mgr || typeof mgr.handleDeferredInputUpdated !== 'function') return;
            mgr.handleDeferredInputUpdated(message);
        } catch (e) {
            console.warn('[DeferredInputUpdatedHandler] failed to handle message:', e);
        }
    }
}

export const deferredInputUpdatedHandler = new DeferredInputUpdatedHandler();

