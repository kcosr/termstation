/**
 * Notification Service for termstation Backend
 * Handles sending notifications through various channels (WebSocket, ntfy.sh)
 */

import { config } from '../config-loader.js';
import { logger } from '../utils/logger.js';

/**
 * Send notification through ntfy.sh service
 * @param {string} title - Notification title
 * @param {string} message - Notification message
 * @param {string} sessionId - Optional session ID
 * @param {string} notificationType - Type of notification (info, warning, error, success)
 */
export async function sendNtfyNotification(title, message, sessionId = null, notificationType = 'info') {
  if (!config.NTFY_ENABLED || !config.NTFY_URL || !config.NTFY_TOPIC) {
    return;
  }
  
  try {
    const ntfyUrl = `${config.NTFY_URL.replace(/\/$/, '')}/${config.NTFY_TOPIC}`;
    const priority = 'default'; // Use default priority for all notification types
    
    // Get session title if session_id is provided
    let sessionTitle = null;
    if (sessionId && global.sessionManager) {
      const session = global.sessionManager.getSession(sessionId);
      if (session && session.title) {
        sessionTitle = session.title;
      }
    }
    
    // Enhance title and message with session info
    let enhancedTitle = title;
    let enhancedMessage = message;
    
    if (sessionTitle) {
      enhancedTitle = `${title} - ${sessionTitle}`;
    }
    
    if (sessionId && config.NTFY_FRONTEND_URL) {
      const sessionUrl = `${config.NTFY_FRONTEND_URL}?session_id=${sessionId}`;
      enhancedMessage = `${message}\n\nSession: ${sessionUrl}`;
    }
    
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Title': enhancedTitle,
      'Priority': priority,
      'Tags': notificationType === 'error' ? 'warning' : notificationType
    };
    
    const response = await fetch(ntfyUrl, {
      method: 'POST',
      headers: headers,
      body: enhancedMessage
    });
    
    if (response.ok) {
      logger.debug(`Successfully sent ntfy notification: ${title}`);
    } else {
      logger.warning(`ntfy.sh returned status ${response.status} for notification: ${title}`);
    }
    
  } catch (error) {
    logger.error(`Failed to send ntfy notification: ${error.message}`);
  }
}

export default {
  sendNtfyNotification
};
