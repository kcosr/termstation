import express from 'express';
import { logger } from '../utils/logger.js';

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

// Create a notification for the current user (utility/debug)
router.post('/', (req, res) => {
  try {
    const user = req.user?.username;
    const payload = req.body || {};
    const saved = getManager().add(user, payload);
    // Broadcast immediately to the current user's connected clients
    try {
      if (global.connectionManager) {
        global.connectionManager.broadcast({
          type: 'notification',
          user,
          title: saved.title,
          message: saved.message,
          notification_type: saved.notification_type,
          session_id: saved.session_id,
          server_id: saved.id,
          is_active: saved.is_active,
          timestamp: saved.timestamp
        });
      }
    } catch (e) {
      logger.warning(`Failed to broadcast user notification: ${e.message}`);
    }
    res.status(201).json(saved);
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
