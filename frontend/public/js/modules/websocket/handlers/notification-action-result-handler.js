/**
 * Notification Action Result Handler
 * Handles WebSocket notification_action_result messages for interactive notifications.
 */
import { debug } from '../../../utils/debug.js';
import { notificationDisplay } from '../../../utils/notification-display.js';
import { notificationCenter } from '../../notification-center/notification-center.js';

export class NotificationActionResultHandler {
    handle(message, context) {
        try {
            console.log('[InteractiveNotification][WS][ResultDispatch]', {
                notificationId: message && message.notification_id,
                actionKey: message && message.action_key,
                ok: !!(message && message.ok),
                status: message && message.status ? String(message.status) : null
            });
        } catch (_) {}

        try {
            if (notificationDisplay && typeof notificationDisplay.handleActionResult === 'function') {
                notificationDisplay.handleActionResult(message);
            }
        } catch (e) {
            console.warn('[NotificationActionResultHandler] Failed to apply action result on toast:', e);
        }

        try {
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
