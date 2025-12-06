import express from 'express';
import { logger } from '../utils/logger.js';
import { sendNtfyNotification } from '../services/notification-service.js';

const router = express.Router();

// Ensure NotificationManager is available globally via server.js
function getManager() {
  const mgr = global.notificationManager;
  if (!mgr) throw new Error('Notification manager not initialized');
  return mgr;
}

// List notifications for the authenticated user
router.get('/', (req, res) => {
  try {
    const user = req.user?.username;
    const items = getManager().list(user);
    res.json({ notifications: items });
  } catch (error) {
    logger.error(`Failed to list notifications: ${error.message}`);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list notifications' });
  }
});

// Create a notification (user-scoped or session-scoped broadcast)
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const type = body.type || 'info';
    const { title, message, sound = true, session_id } = body;

    if (!title || !message) {
      return res.status(400).json({ error: 'title and message are required' });
    }

    const validTypes = ['info', 'warning', 'error', 'success'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: `Invalid notification type: ${type}. Must be one of: ${validTypes.join(', ')}`
      });
    }

    const requester = req.user || {};
    const canBroadcast = requester?.permissions?.broadcast === true;

    // Session-targeted notifications: owner + attached users (requires broadcast permission)
    if (session_id) {
      if (!canBroadcast) {
        return res.status(403).json({
          error: 'FORBIDDEN',
          message: 'Broadcast permission required for session notifications'
        });
      }

      // Resolve session (active or terminated)
      let session = null;
      try { session = global.sessionManager.getSession(session_id); } catch (_) { session = null; }
      if (!session && global.sessionManager?.getSessionIncludingTerminated) {
        try {
          session = await global.sessionManager.getSessionIncludingTerminated(session_id, { loadFromDisk: true });
        } catch (_) {
          session = null;
        }
      }
      if (!session) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `Session ${session_id} not found` });
      }

      // Build recipients: owner + currently attached usernames
      const recipients = new Set();
      const owner = String(session.created_by || '').trim();
      if (owner) recipients.add(owner);
      try {
        for (const clientId of session.connected_clients || []) {
          const ws = global.connectionManager?.connections?.get(clientId);
          const uname = ws && ws.username ? String(ws.username).trim() : '';
          if (uname) recipients.add(uname);
        }
      } catch (_) {}

      const savedObjects = [];
      for (const username of recipients) {
        const saved = getManager().add(username, {
          title,
          message,
          notification_type: type,
          timestamp: new Date().toISOString(),
          session_id,
          is_active: false
        });
        savedObjects.push(saved);
        try {
          global.connectionManager.broadcast({
            type: 'notification',
            user: username,
            title: saved.title,
            message: saved.message,
            notification_type: saved.notification_type,
            session_id: saved.session_id,
            server_id: saved.id,
            is_active: saved.is_active,
            timestamp: saved.timestamp,
            sound: !!sound
          });
        } catch (_) {}
      }

      try { await sendNtfyNotification(title, message, session_id, type); } catch (_) {}
      return res.status(201).json({ recipients: Array.from(recipients), saved: savedObjects });
    }

    // Non-session notifications: persist to requesting user
    const username = requester?.username;
    if (!username) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const saved = getManager().add(username, {
      title,
      message,
      notification_type: type,
      timestamp: new Date().toISOString(),
      session_id: null,
      is_active: false
    });
    try {
      global.connectionManager.broadcast({
        type: 'notification',
        user: username,
        title: saved.title,
        message: saved.message,
        notification_type: saved.notification_type,
        session_id: saved.session_id,
        server_id: saved.id,
        is_active: saved.is_active,
        timestamp: saved.timestamp,
        sound: !!sound
      });
    } catch (_) {}
    try { await sendNtfyNotification(title, message, null, type); } catch (_) {}
    return res.status(201).json({ saved });
  } catch (error) {
    logger.error(`Failed to create notification: ${error.message}`);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create notification' });
  }
});

// Mark all as read for current user (define BEFORE :id route so it isn't captured by param)
router.patch('/mark-all-read', (req, res) => {
  try {
    const user = req.user?.username;
    const updated = getManager().markAllRead(user);
    res.json({ ok: true, updated });
  } catch (error) {
    logger.error(`Failed to mark all notifications as read: ${error.message}`);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to mark all read' });
  }
});

// Delete all notifications for current user
router.delete('/', (req, res) => {
  try {
    const user = req.user?.username;
    const deleted = getManager().clearAll(user);
    res.json({ ok: true, deleted });
  } catch (error) {
    logger.error(`Failed to clear notifications: ${error.message}`);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to clear notifications' });
  }
});

// Mark as read (single)
router.patch('/:id', (req, res) => {
  try {
    const user = req.user?.username;
    const { id } = req.params;
    const { read } = req.body || {};
    if (read === true) {
      const ok = getManager().markRead(user, id);
      if (!ok) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Notification not found' });
      }
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Unsupported patch' });
  } catch (error) {
    logger.error(`Failed to update notification: ${error.message}`);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update notification' });
  }
});

// Delete notification (single)
router.delete('/:id', (req, res) => {
  try {
    const user = req.user?.username;
    const { id } = req.params;
    const ok = getManager().delete(user, id);
    if (!ok) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Notification not found' });
    }
    res.json({ ok: true });
  } catch (error) {
    logger.error(`Failed to delete notification: ${error.message}`);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete notification' });
  }
});

export default router;
