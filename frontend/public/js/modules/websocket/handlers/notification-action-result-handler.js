/**
 * Notification Action Result Handler
 * Handles WebSocket notification_action_result messages for interactive notifications.
 */
import { debug } from '../../../utils/debug.js';
import { notificationDisplay } from '../../../utils/notification-display.js';

export class NotificationActionResultHandler {
    handle(message, context) {
        try {
            if (notificationDisplay && typeof notificationDisplay.handleActionResult === 'function') {
                notificationDisplay.handleActionResult(message);
            }
        } catch (e) {
            console.warn('[NotificationActionResultHandler] Failed to apply action result:', e);
        }

        debug.log('wsLogs', '[NotificationActionResult]', message);
    }
}

export const notificationActionResultHandler = new NotificationActionResultHandler();

