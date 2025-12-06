/**
 * Notification Action Result Handler
 * Handles WebSocket notification_action_result messages for interactive notifications.
 */
import { debug } from '../../../utils/debug.js';
import { notificationDisplay } from '../../../utils/notification-display.js';
import { notificationCenter } from '../../notification-center/notification-center.js';
import { appStore } from '../../../core/store.js';

function isInteractiveDebugEnabled() {
    try {
        const debugPrefs = appStore.getState('preferences.debug') || {};
        return !!debugPrefs.websocketLogs;
    } catch (_) {
        return false;
    }
}

export class NotificationActionResultHandler {
    handle(message, context) {
        try {
            const notificationId = message && message.notification_id;
            const actionKey = message && message.action_key;
            const ok = !!(message && message.ok);
            const status = message && message.status ? String(message.status) : null;
            const hasDisplay = !!notificationDisplay;
            const hasDisplayHandler = !!(notificationDisplay && typeof notificationDisplay.handleActionResult === 'function');
            const hasCenter = !!notificationCenter;
            const hasCenterHandler = !!(notificationCenter && typeof notificationCenter.handleActionResult === 'function');
            if (isInteractiveDebugEnabled()) {
                console.log('[InteractiveNotification][WS][ResultDispatch]', {
                    notificationId,
                    actionKey,
                    ok,
                    status,
                    hasDisplay,
                    hasDisplayHandler,
                    hasCenter,
                    hasCenterHandler
                });
            }
        } catch (_) {}

        try {
            if (isInteractiveDebugEnabled()) {
                console.log('[InteractiveNotification][WS][ResultToToast]', {
                    notificationId: message && message.notification_id,
                    actionKey: message && message.action_key
                });
            }
            if (notificationDisplay && typeof notificationDisplay.handleActionResult === 'function') {
                notificationDisplay.handleActionResult(message);
            }
        } catch (e) {
            console.warn('[NotificationActionResultHandler] Failed to apply action result on toast:', e);
        }

        try {
            if (isInteractiveDebugEnabled()) {
                console.log('[InteractiveNotification][WS][ResultToCenter]', {
                    notificationId: message && message.notification_id,
                    actionKey: message && message.action_key
                });
            }
            if (notificationCenter && typeof notificationCenter.handleActionResult === 'function') {
                notificationCenter.handleActionResult(message);
            }
        } catch (e) {
            console.warn('[NotificationActionResultHandler] Failed to apply action result in center:', e);
        }

        debug.log('wsLogs', '[NotificationActionResult]', message);
    }
}

export const notificationActionResultHandler = new NotificationActionResultHandler();
