import express from 'express';
import { workspaceManager } from '../managers/workspace-manager.js';
import { logger } from '../utils/logger.js';
import { config } from '../config-loader.js';

const router = express.Router();

// Get all workspaces
router.get('/', (req, res) => {
  try {
    const username = req?.user?.username || config.DEFAULT_USERNAME;
    const base = workspaceManager.getAllForUser(username);

    // Build a union of existing workspaces + names from active sessions the user can see.
    // Admins: include all active sessions. Non-admins: include own sessions + non-private (public/shared_readonly).
    const isAdmin = !!(req?.user?.permissions?.manage_all_sessions === true);
    const set = new Set(base.map(w => String(w.name || '').trim()).filter(Boolean));
    try {
      const sessions = global.sessionManager.getActiveSessions();
      for (const s of sessions) {
        if (!s) continue;
        const isPriv = (s.visibility === 'private');
        const isOwner = String(s.created_by || '') === String(username);
        if (!isAdmin && isPriv && !isOwner) continue; // skip other users' private sessions
        const ws = String(s.workspace || 'Default').trim() || 'Default';
        set.add(ws);
      }
    } catch (_) {}
    // Always ensure Default exists
    if (!set.has('Default')) set.add('Default');
    const merged = Array.from(set.values())
      .map(name => {
        // Preserve metadata when present; otherwise synthesize a default entry
        const existing = base.find(w => w.name === name);
        return existing || { name, pinned: false, note: '', note_version: 0, note_updated_at: null, note_updated_by: null };
      });
    return res.json({ workspaces: merged });
  } catch (error) {
    logger.error(`[API] Failed to get workspaces: ${error.message}`);
    return res.status(500).json({ message: 'Failed to get workspaces' });
  }
});

// IMPORTANT: Define non-parameter routes BEFORE parameterized routes like '/:name'
// Update order of workspaces
router.put('/order', (req, res) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order) {
      return res.status(400).json({ message: 'order array is required' });
    }
    const username = req?.user?.username || config.DEFAULT_USERNAME;
    logger.info(`[API] Reorder workspaces request (user='${username}'): ${JSON.stringify(order)}`);
    const updated = workspaceManager.setOrderForUser(username, order);
    // Broadcast updated list with preserved order
    try {
      if (global.connectionManager) {
        global.connectionManager.broadcast({
          type: 'workspaces_updated',
          workspaces: updated,
          action: 'reordered',
          user: username
        });
      }
      logger.info(`[API] Broadcasted workspaces_updated action=reordered, count=${updated.length}`);
    } catch (e) {
      logger.warning(`[API] Failed to broadcast workspaces_updated after reorder: ${e.message}`);
    }
    return res.json({ workspaces: updated });
  } catch (error) {
    let status = 500;
    if (error.code === 'INVALID_ORDER') status = 400;
    return res.status(status).json({ message: error.message, code: error.code || 'ERROR' });
  }
});

// Reorder sessions within a workspace
router.put('/:name/sessions/order', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name || '').trim();
    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!name) return res.status(400).json({ message: 'Workspace name required' });
    if (!order) return res.status(400).json({ message: 'order array is required' });

    const sessionIds = order.map(id => String(id));
    const sessions = global.sessionManager.getAllSessions();
    // Update listed sessions first
    sessions.forEach(session => {
      if ((session.workspace || 'Default') === name && sessionIds.includes(session.session_id) && String(session.created_by || '') === String(req?.user?.username || config.DEFAULT_USERNAME)) {
        session.workspace_order = sessionIds.indexOf(session.session_id);
      }
    });
    // For any remaining sessions in this workspace not in the list, append after
    const maxIndex = sessionIds.length;
    let appendIndex = maxIndex;
    sessions.forEach(session => {
      if ((session.workspace || 'Default') === name && !sessionIds.includes(session.session_id) && String(session.created_by || '') === String(req?.user?.username || config.DEFAULT_USERNAME)) {
        session.workspace_order = appendIndex++;
      }
    });

    // Broadcast a consolidated reorder event
    try {
      if (global.connectionManager) {
        global.connectionManager.broadcast({
          type: 'sessions_reordered',
          workspace: name,
          order: Array.from(global.sessionManager.getAllSessions()
            .filter(s => (s.workspace || 'Default') === name && String(s.created_by || '') === String(req?.user?.username || config.DEFAULT_USERNAME))
            .sort((a, b) => (a.workspace_order ?? 0) - (b.workspace_order ?? 0))
            .map(s => s.session_id)),
          user: req?.user?.username || config.DEFAULT_USERNAME
        });
      }
    } catch (e) {
      logger.warning(`[API] Failed to broadcast sessions_reordered for '${name}': ${e.message}`);
    }

    return res.json({ workspace: name, order: sessionIds });
  } catch (error) {
    logger.error(`[API] Failed to reorder sessions: ${error.message}`);
    return res.status(500).json({ message: 'Failed to reorder sessions' });
  }
});

// Create workspace
router.post('/', (req, res) => {
  try {
    const name = req.body?.name;
    const username = req?.user?.username || config.DEFAULT_USERNAME;
    const created = workspaceManager.addForUser(username, name);

    // Broadcast workspace list update
    try {
      if (global.connectionManager) {
        global.connectionManager.broadcast({
          type: 'workspaces_updated',
          workspaces: workspaceManager.getAllForUser(username),
          action: 'created',
          name: created,
          user: username
        });
      }
    } catch (e) {
      logger.warning(`[API] Failed to broadcast workspaces_updated after create: ${e.message}`);
    }

    return res.status(201).json({ name: created });
  } catch (error) {
    const status = (error.code === 'ALREADY_EXISTS') ? 409 : (error.code === 'INVALID_NAME' ? 400 : 500);
    return res.status(status).json({ message: error.message, code: error.code || 'ERROR' });
  }
});

// Rename workspace
router.put('/:name', async (req, res) => {
  try {
    const oldName = decodeURIComponent(req.params.name || '').trim();
    const newName = (req.body?.new_name || '').trim();
    const username = req?.user?.username || config.DEFAULT_USERNAME;
    const renamed = workspaceManager.renameForUser(username, oldName, newName);

    // Re-associate sessions with the new workspace name and broadcast updates
    try {
      const sessions = await global.sessionManager.getAllSessionsIncludingTerminated();
      let updatedCount = 0;
      for (const session of sessions) {
        const ws = session.workspace || 'Default';
        if (ws === oldName && String(session.created_by || '') === String(username)) {
          session.workspace = newName || 'Default';
          updatedCount++;
          // Persist metadata for terminated sessions
          if (!session.is_active) {
            try { await global.sessionManager.saveTerminatedSessionMetadata(session, { force: true }); } catch (_) {}
          }
          // Broadcast update to all clients
          if (global.connectionManager) {
            global.connectionManager.broadcast({
              type: 'session_updated',
              update_type: 'updated',
              session_data: session.toResponseObject()
            });
          }
        }
      }
      logger.info(`[API] Workspace rename '${oldName}' -> '${newName}' updated ${updatedCount} session(s)`);
    } catch (e) {
      logger.warning(`[API] Failed to propagate workspace rename to sessions: ${e.message}`);
    }

    // Broadcast workspace list update
    try {
      if (global.connectionManager) {
        global.connectionManager.broadcast({
          type: 'workspaces_updated',
          workspaces: workspaceManager.getAllForUser(username),
          action: 'renamed',
          old_name: oldName,
          new_name: renamed,
          user: username
        });
      }
    } catch (e) {
      logger.warning(`[API] Failed to broadcast workspaces_updated after rename: ${e.message}`);
    }

    return res.json({ old_name: oldName, new_name: renamed });
  } catch (error) {
    let status = 500;
    if (error.code === 'NOT_FOUND') status = 404;
    else if (error.code === 'ALREADY_EXISTS') status = 409;
    else if (error.code === 'FORBIDDEN' || error.code === 'INVALID_NAME') status = 400;
    return res.status(status).json({ message: error.message, code: error.code || 'ERROR' });
  }
});

// Delete workspace
router.delete('/:name', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name || '').trim();
    const username = req?.user?.username || config.DEFAULT_USERNAME;
    workspaceManager.removeForUser(username, name);

    // Re-associate sessions to Default and broadcast updates
    try {
      const sessions = await global.sessionManager.getAllSessionsIncludingTerminated();
      let updatedCount = 0;
      for (const session of sessions) {
        const ws = session.workspace || 'Default';
        if (ws === name && String(session.created_by || '') === String(username)) {
          session.workspace = 'Default';
          updatedCount++;
          // Persist metadata for terminated sessions
          if (!session.is_active) {
            try { await global.sessionManager.saveTerminatedSessionMetadata(session, { force: true }); } catch (_) {}
          }
          // Broadcast update
          if (global.connectionManager) {
            global.connectionManager.broadcast({
              type: 'session_updated',
              update_type: 'updated',
              session_data: session.toResponseObject()
            });
          }
        }
      }
      logger.info(`[API] Workspace delete '${name}' re-associated ${updatedCount} session(s) to Default`);
    } catch (e) {
      logger.warning(`[API] Failed to re-associate sessions after workspace delete: ${e.message}`);
    }

    // Broadcast workspace list update
    try {
      if (global.connectionManager) {
        global.connectionManager.broadcast({
          type: 'workspaces_updated',
          workspaces: workspaceManager.getAllForUser(req?.user?.username || config.DEFAULT_USERNAME),
          action: 'deleted',
          name: name,
          user: req?.user?.username || config.DEFAULT_USERNAME
        });
      }
    } catch (e) {
      logger.warning(`[API] Failed to broadcast workspaces_updated after delete: ${e.message}`);
    }

    return res.status(204).send();
  } catch (error) {
    let status = 500;
    if (error.code === 'NOT_FOUND') status = 404;
    else if (error.code === 'FORBIDDEN') status = 400;
    return res.status(status).json({ message: error.message, code: error.code || 'ERROR' });
  }
});

// Update workspace attributes (e.g., pinned)
router.patch('/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name || '').trim();
    const username = req?.user?.username || config.DEFAULT_USERNAME;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'pinned')) {
      const updated = workspaceManager.setPinnedForUser(username, name, !!req.body.pinned);
      // Broadcast workspaces update
      try {
        if (global.connectionManager) {
          global.connectionManager.broadcast({
            type: 'workspaces_updated',
            workspaces: workspaceManager.getAllForUser(username),
            action: updated.pinned ? 'pinned' : 'unpinned',
            name,
            user: username
          });
        }
      } catch (e) {
        logger.warning(`[API] Failed to broadcast workspaces_updated after pin change: ${e.message}`);
      }
      return res.json(updated);
    }
    return res.status(400).json({ message: 'No supported attributes to update' });
  } catch (error) {
    let status = 500;
    if (error.code === 'NOT_FOUND') status = 404;
    else if (error.code === 'FORBIDDEN') status = 400;
    return res.status(status).json({ message: error.message, code: error.code || 'ERROR' });
  }
});

// Workspace notes APIs
router.get('/:name/note', (req, res) => {
  // Feature gate: notes must be enabled for this user
  try {
    const enabled = req?.user?.features && req.user.features.notes_enabled === true;
    if (!enabled) {
      return res.status(403).json({ message: 'Notes feature disabled', code: 'FEATURE_DISABLED' });
    }
  } catch (_) {}
  try {
    const username = req?.user?.username || config.DEFAULT_USERNAME;
    const name = decodeURIComponent(req.params.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Workspace name required' });
    const snapshot = workspaceManager.getNoteSnapshotForUser(username, name);
    return res.json({ ...snapshot, workspace: name });
  } catch (error) {
    logger.error(`[API] Failed to get workspace note: ${error?.message || error}`);
    return res.status(500).json({ message: 'Failed to get workspace note' });
  }
});

router.put('/:name/note', (req, res) => {
  // Feature gate: notes must be enabled for this user
  try {
    const enabled = req?.user?.features && req.user.features.notes_enabled === true;
    if (!enabled) {
      return res.status(403).json({ message: 'Notes feature disabled', code: 'FEATURE_DISABLED' });
    }
  } catch (_) {}
  try {
    const username = req?.user?.username || config.DEFAULT_USERNAME;
    const name = decodeURIComponent(req.params.name || '').trim();
    const { content, version } = req.body || {};
    if (!name) return res.status(400).json({ message: 'Workspace name required' });
    if (content !== undefined && typeof content !== 'string') return res.status(400).json({ message: 'Note content must be a string' });
    if (version !== undefined && !Number.isInteger(version)) return res.status(400).json({ message: 'Version must be an integer' });

    const snapshot = workspaceManager.updateNoteForUser(username, name, content ?? '', {
      expectedVersion: Number.isInteger(version) ? version : undefined,
      updatedBy: username
    });

    // Broadcast workspace list update (note metadata could be used by clients)
    try {
      if (global.connectionManager) {
        global.connectionManager.broadcast({
          type: 'workspaces_updated',
          workspaces: workspaceManager.getAllForUser(username),
          action: 'note_updated',
          name,
          user: username
        });
      }
    } catch (e) { logger.warning(`[API] Failed to broadcast workspaces_updated after note update: ${e.message}`); }

    return res.json({ ...snapshot, workspace: name });
  } catch (error) {
    if (error && error.code === 'NOTE_VERSION_CONFLICT') {
      const latest = error.context?.latest || null;
      return res.status(409).json({ message: 'Note update conflict', code: error.code, note: latest, context: { note: latest } });
    }
    logger.error(`[API] Failed to update workspace note: ${error?.message || error}`);
    return res.status(500).json({ message: 'Failed to update workspace note' });
  }
});

// Update order of workspaces

export default router;
