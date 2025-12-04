/**
 * Broadcast utilities
 */

/**
 * Broadcast a standard session update payload to all clients
 * @param {import('../models/terminal-session.js').TerminalSession} session
 * @param {('created'|'updated'|'terminated'|string)} updateType
 */
export function broadcastSessionUpdate(session, updateType = 'updated') {
  try {
    const sessionData = session.toResponseObject();
    if (global.connectionManager) {
      global.connectionManager.broadcast({
        type: 'session_updated',
        update_type: updateType,
        session_data: sessionData
      });
    }
  } catch (_) {
    // best-effort only
  }
}

