import { broadcastSessionUpdate } from '../../utils/broadcast.js';
import { logger } from '../../utils/logger.js';

export function createSessionVisibilityHandler(mustOwnSession) {
  return async function handleSessionVisibilityUpdate(req, res) {
    let session = global.sessionManager.getSession(req.params.sessionId);
    let sessionRetrievedFromHistory = false;
  
    if (!session) {
      try {
        session = await global.sessionManager.getSessionIncludingTerminated(req.params.sessionId);
        sessionRetrievedFromHistory = !!session && session.is_active === false;
      } catch (error) {
        logger.error(`[API] Failed to resolve session ${req.params.sessionId} for visibility update: ${error?.message || error}`);
        return res.status(500).json({ error: 'Failed to update visibility' });
      }
    }
  
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!mustOwnSession(req, session)) return res.status(403).json({ error: 'Forbidden' });
  
    const requested = String(req.body.visibility || '').trim();
    const allowed = new Set(['public', 'private', 'shared_readonly']);
    if (!allowed.has(requested)) {
      return res.status(400).json({ error: 'Invalid visibility', allowed: Array.from(allowed) });
    }
  
    const oldVis = session.visibility || 'private';
    const newVis = requested;
    session.visibility = newVis;
  
    // Re-evaluate currently connected clients
    try {
      const owner = String(session.created_by || '');
      if (newVis === 'private') {
        // Detach non-owner clients
        const toDetach = Array.from(session.connected_clients || []).filter(cid => {
          try {
            const ws = global.connectionManager?.connections?.get(cid);
            const uname = ws && ws.username ? String(ws.username) : '';
            return uname !== owner;
          } catch (_) { return true; }
        });
        for (const cid of toDetach) {
          try {
            global.sessionManager.detachClientFromSession(session.session_id, cid);
            global.connectionManager.detachClientFromSession(cid, session.session_id);
            global.connectionManager.sendToClient(cid, { type: 'detached', session_id: session.session_id });
          } catch (_) {}
        }
        // Notify non-owners to remove the session from their UI
        try {
          for (const [clientId, ws] of global.connectionManager.connections || []) {
            const uname = ws && ws.username ? String(ws.username) : '';
            if (uname !== owner) {
              global.connectionManager.sendToClient(clientId, {
                type: 'session_removed',
                session_id: session.session_id,
                reason: 'visibility_private'
              });
            }
          }
        } catch (_) {}
      }
      // For shared_readonly: keep attachments; server enforces read-only on stdin
    } catch (e) {
      logger.warning(`[API] visibility change post-processing failed: ${e.message}`);
    }
  
    // Broadcast updated session state
    broadcastSessionUpdate(session, 'updated');
  
    if (!session.is_active || sessionRetrievedFromHistory) {
      try {
        await global.sessionManager.saveTerminatedSessionMetadata(session, { force: true });
      } catch (error) {
        logger.warning(`[API] Failed to persist metadata after visibility update for session ${session.session_id}: ${error?.message || error}`);
      }
    }
  
    res.json({ message: 'Visibility updated', visibility: newVis, previous: oldVis });
  };
}
