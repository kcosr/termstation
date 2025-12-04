/**
 * WebSocket Connection Manager
 * Manages WebSocket connections and client-session relationships
 */

import { logger } from '../utils/logger.js';
import { config } from '../config-loader.js';

export class ConnectionManager {
  constructor() {
    this.connections = new Map(); // clientId -> WebSocket
    this.clientSessions = new Map(); // clientId -> Set of sessionIds
  }

  addConnection(clientId, ws) {
    this.connections.set(clientId, ws);
    this.clientSessions.set(clientId, new Set());
    const user = (ws && typeof ws.username === 'string' && ws.username) ? ws.username : 'unknown';
    const authState = config.AUTH_ENABLED ? 'ENABLED' : 'DISABLED';
    logger.info(`Client ${clientId} connected (user='${user}', auth=${authState})`);
  }

  removeConnection(clientId) {
    this.connections.delete(clientId);
    this.clientSessions.delete(clientId);
    logger.info(`Client ${clientId} disconnected`);
  }

  sendToClient(clientId, message) {
    const ws = this.connections.get(clientId);
    if (ws && ws.readyState === 1) { // WebSocket.OPEN
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch (error) {
        logger.error(`Error sending message to client ${clientId}: ${error.message}`);
        // Mark connection as failed for cleanup
        this.removeConnection(clientId);
        return false;
      }
    } else if (ws) {
      // Connection exists but not open - clean it up
      logger.debug(`Cleaning up inactive connection for client ${clientId} (readyState: ${ws.readyState})`);
      this.removeConnection(clientId);
    }
    return false;
  }

  broadcast(message, excludeClientId = null) {
    let successCount = 0;
    const failedClients = [];

    // Determine if this message should be user-filtered
    // Support two modes:
    // 1) Target a single user explicitly via message.user
    // 2) Restrict private session updates to owner OR admins (manage_all_sessions)
    let targetUser = null;
    let restrictOwnerOrAdmin = false;
    let ownerForPrivate = null;
    try {
      if (message && typeof message.user === 'string' && message.user) {
        targetUser = String(message.user);
      }
      if (message && message.type === 'session_updated' && message.session_data) {
        const sd = message.session_data || {};
        if (sd.visibility === 'private' && sd.created_by) {
          restrictOwnerOrAdmin = true;
          ownerForPrivate = String(sd.created_by);
        }
      } else if (!targetUser && message && message.sessionId && global.sessionManager) {
        const s = global.sessionManager.getSession(message.sessionId);
        if (s && s.visibility === 'private' && s.created_by) {
          restrictOwnerOrAdmin = true;
          ownerForPrivate = String(s.created_by);
        }
      } else if (!targetUser && message && (message.type === 'workspaces_updated' || message.type === 'sessions_reordered') && typeof message.user === 'string' && message.user) {
        targetUser = String(message.user);
      } else if (!targetUser && message && message.type === 'notification' && typeof message.user === 'string' && message.user) {
        targetUser = String(message.user);
      }
    } catch (_) {}

    for (const [clientId, ws] of this.connections) {
      if (clientId === excludeClientId) continue;
      if (ws.readyState !== 1) continue;

      // Enforce filtering when applicable
      const uname = (ws && typeof ws.username === 'string' && ws.username) ? String(ws.username) : '';
      if (targetUser) {
        if (uname !== targetUser) continue;
      }
      if (restrictOwnerOrAdmin) {
        const isOwner = uname === ownerForPrivate;
        const isAdmin = !!(ws && ws.permissions && ws.permissions.manage_all_sessions === true);
        if (!isOwner && !isAdmin) continue;
      }

      try {
        ws.send(JSON.stringify(message));
        successCount++;
      } catch (error) {
        logger.error(`Error broadcasting to client ${clientId}: ${error.message}`);
        failedClients.push(clientId);
      }
    }

    // Cleanup failed connections
    for (const clientId of failedClients) {
      this.removeConnection(clientId);
    }

    logger.debug(`Broadcast complete: ${successCount} successful, ${failedClients.length} failed`);
  }

  attachClientToSession(clientId, sessionId) {
    const sessions = this.clientSessions.get(clientId);
    if (sessions) {
      sessions.add(sessionId);
    }
  }

  detachClientFromSession(clientId, sessionId) {
    const sessions = this.clientSessions.get(clientId);
    if (sessions) {
      sessions.delete(sessionId);
    }
  }

  isClientAttachedToSession(clientId, sessionId) {
    const sessions = this.clientSessions.get(clientId);
    return sessions ? sessions.has(sessionId) : false;
  }
}
