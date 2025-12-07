/**
 * Notification Updated Handler
 * Handles WebSocket notification_updated messages for interactive notifications.
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

export class NotificationUpdatedHandler {
    handle(message, context) {
        try {
            const notificationId = message && message.notification_id;
            const isActive = !!(message && message.is_active !== false);
            const status = message && message.response && typeof message.response.status === 'string'
                ? message.response.status
                : null;
            const hasDisplay = !!notificationDisplay;
            const hasDisplayHandler = !!(notificationDisplay && typeof notificationDisplay.handleNotificationUpdate === 'function');
            const hasCenter = !!notificationCenter;
            const hasCenterHandler = !!(notificationCenter && typeof notificationCenter.handleNotificationUpdate === 'function');
            if (isInteractiveDebugEnabled()) {
                console.log('[InteractiveNotification][WS][UpdatedDispatch]', {
                    notificationId,
                    isActive,
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
                console.log('[InteractiveNotification][WS][UpdatedToToast]', {
                    notificationId: message && message.notification_id
                });
            }
            if (notificationDisplay && typeof notificationDisplay.handleNotificationUpdate === 'function') {
                notificationDisplay.handleNotificationUpdate(message);
            }
        } catch (e) {
            console.warn('[NotificationUpdatedHandler] Failed to apply update on toast:', e);
        }

        try {
            if (isInteractiveDebugEnabled()) {
                console.log('[InteractiveNotification][WS][UpdatedToCenter]', {
                    notificationId: message && message.notification_id
                });
            }
            if (notificationCenter && typeof notificationCenter.handleNotificationUpdate === 'function') {
                notificationCenter.handleNotificationUpdate(message);
            }
        } catch (e) {
            console.warn('[NotificationUpdatedHandler] Failed to apply update in center:', e);
        }

        debug.log('wsLogs', '[NotificationUpdated]', message);
    }
}

export const notificationUpdatedHandler = new NotificationUpdatedHandler();

