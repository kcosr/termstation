/**
 * Notification Message Handler
 * Handles WebSocket notification messages
 */
import { debug } from '../../../utils/debug.js';

export class NotificationHandler {
    handle(message, context) {
        // Delegate to terminal manager's notification handler if available
        if (context.terminalManager && context.terminalManager.handleNotification) {
            context.terminalManager.handleNotification(message);
            return;
        }
        
        // Otherwise handle directly if notification center is available
        if (context.notificationCenter) {
            const notificationType = message.notification_type || 'info';
            const title = message.title || 'Notification';
            const content = message.message || message.content || '';
            
            context.notificationCenter.show({
                type: notificationType,
                title: title,
                message: content,
                duration: message.duration || 5000
            });
        }
        
        debug.log('wsLogs', '[Notification]', message);
    }
}

export const notificationHandler = new NotificationHandler();
