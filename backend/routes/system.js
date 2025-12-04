/**
 * System API Routes
 * Handles system information, templates, and notifications
 */

import express from 'express';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { config } from '../config-loader.js';
import { clearSessionCookie, createSessionToken, rotateSessionSecret, setSessionCookie } from '../utils/session-cookie.js';
import { templateLoader } from '../template-loader.js';
import { resolveAllowedTemplatesForUser } from '../utils/template-access.js';
import { sendNtfyNotification } from '../services/notification-service.js';
import { linksLoader } from '../links-loader.js';
import { logger } from '../utils/logger.js';
import { usersConfigCache, groupsConfigCache, linksConfigCache } from '../utils/json-config-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const router = express.Router();

// System info
router.get('/info', (req, res) => {
  // Check if server is shutting down
  if (global.isShuttingDown) {
    return res.status(503).json({
      error: 'Server is shutting down',
      status: 'shutting_down'
    });
  }

  let version = '0.0.0'; // default fallback
  let build = 0;
  let commit = null;
  try {
    // Load shared version module (CommonJS) from ESM context
    const requireCjs = createRequire(import.meta.url);
    const shared = requireCjs(path.resolve(__dirname, '..', '..', 'shared', 'version.js'));
    if (shared && typeof shared.version === 'string' && shared.version.trim()) {
      version = shared.version.trim();
    }
    if (shared && typeof shared.build === 'number') {
      build = shared.build;
    }
    if (shared && typeof shared.commit === 'string') {
      commit = shared.commit;
    }
  } catch (error) {
    logger.warning(`Could not read shared version: ${error.message}`);
  }

  res.json({
    version: version,
    build: build,
    commit: commit,
    platform: os.platform(),
    arch: os.arch(),
    node_version: process.version,
    uptime: process.uptime(),
    frontend_url: config.NTFY?.frontend_url || null,
    auth_enabled: !!config.AUTH_ENABLED,
    current_user: (req.user && req.user.username) ? req.user.username : config.DEFAULT_USERNAME,
    default_username: config.DEFAULT_USERNAME
  });
});

// Authentication helpers
router.post('/auth/logout', (req, res) => {
  try {
    clearSessionCookie(res, req);
  } catch (_) {}
  return res.json({ success: true, message: 'Logged out' });
});

// Short-lived WebSocket token for handshake when cookies aren’t visible to WS
router.get('/ws-token', (req, res) => {
  try {
    const user = req.user || { username: config.DEFAULT_USERNAME };
    // 10-second TTL to cover immediate WS connect
    const token = createSessionToken(user, 10);
    return res.json({ token });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to issue ws token' });
  }
});

// Rotate the server session cookie signing secret and issue a fresh cookie for the requester
// Gated by feature flag `cookie_token_reset_enabled`
router.post('/auth/reset-token', (req, res) => {
  try {
    const enabled = !!(req?.user?.features?.cookie_token_reset_enabled);
    if (!enabled) {
      return res.status(403).json({ error: 'FEATURE_DISABLED', message: 'Cookie token reset is disabled' });
    }
    // Rotate the secret (this invalidates all outstanding cookies/tokens)
    rotateSessionSecret();
    try { clearSessionCookie(res, req); } catch (_) {}
    // Issue a fresh cookie for the requester to avoid locking out their session immediately
    try {
      const user = req.user || { username: config.DEFAULT_USERNAME };
      const token = createSessionToken(user);
      // Note: setSessionCookie is called in auth middleware on subsequent requests as well
      res.set('X-Token-Rotated', '1');
      // Manually set cookie via helper for immediate continuity
      setSessionCookie(res, token, req);
    } catch (_) {}
    return res.json({ ok: true, rotated: true });
  } catch (e) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to reset token' });
  }
});

// Admin-only: Reload core JSON configuration from disk (templates/users/groups/links)
// Gated by feature flag `config_reload_enabled`
router.post('/system/reload-config', (req, res) => {
  try {
    const enabled = !!(req?.user?.features?.config_reload_enabled);
    if (!enabled) {
      return res.status(403).json({ error: 'FEATURE_DISABLED', message: 'Config reload is disabled' });
    }

    const username = (req?.user?.username && String(req.user.username).trim()) || config.DEFAULT_USERNAME;
    logger.info(`[ConfigReload] Manual config reload requested by '${username}'`);

    const errors = [];

    // Templates: delegate to TemplateLoader (which uses the shared cache internally)
    let templatesSummary = { count: 0, last_modified: null };
    try {
      const tplResult = templateLoader.reloadTemplates();
      templatesSummary.count = Number.isFinite(tplResult?.templatesCount) ? tplResult.templatesCount : 0;
      templatesSummary.last_modified = tplResult?.lastModified || null;
    } catch (e) {
      errors.push({ source: 'templates', message: e?.message || String(e) });
      logger.error(`[ConfigReload] Failed to reload templates: ${e?.message || e}`);
    }

    // Users
    let usersSummary = { count: 0 };
    try {
      const usersResult = usersConfigCache.reloadNow();
      const usersRaw = usersConfigCache.get();
      const users = Array.isArray(usersRaw) ? usersRaw : [];
      usersSummary.count = users.length;
      if (!usersResult.ok && usersResult.error) {
        errors.push({ source: 'users', message: usersResult.error.message || String(usersResult.error) });
      }
    } catch (e) {
      errors.push({ source: 'users', message: e?.message || String(e) });
      logger.error(`[ConfigReload] Failed to reload users: ${e?.message || e}`);
    }

    // Groups
    let groupsSummary = { count: 0 };
    try {
      const groupsResult = groupsConfigCache.reloadNow();
      const groupsRaw = groupsConfigCache.get();
      const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
      groupsSummary.count = groups.length;
      if (!groupsResult.ok && groupsResult.error) {
        errors.push({ source: 'groups', message: groupsResult.error.message || String(groupsResult.error) });
      }
    } catch (e) {
      errors.push({ source: 'groups', message: e?.message || String(e) });
      logger.error(`[ConfigReload] Failed to reload groups: ${e?.message || e}`);
    }

    // Links
    let linksSummary = { groups: 0 };
    try {
      const linksResult = linksConfigCache.reloadNow();
      const linksRaw = linksConfigCache.get();
      const groups = Array.isArray(linksRaw?.groups)
        ? linksRaw.groups
        : (Array.isArray(linksRaw?.link_groups) ? linksRaw.link_groups : []);
      linksSummary.groups = groups.length;
      if (!linksResult.ok && linksResult.error) {
        errors.push({ source: 'links', message: linksResult.error.message || String(linksResult.error) });
      }
    } catch (e) {
      errors.push({ source: 'links', message: e?.message || String(e) });
      logger.error(`[ConfigReload] Failed to reload links: ${e?.message || e}`);
    }

    const ok = errors.length === 0;
    logger.info(`[ConfigReload] Completed for '${username}': ok=${ok}, templates=${templatesSummary.count}, users=${usersSummary.count}, groups=${groupsSummary.count}, linkGroups=${linksSummary.groups}`);

    return res.json({
      ok,
      templates: templatesSummary,
      users: usersSummary,
      groups: groupsSummary,
      links: linksSummary,
      errors
    });
  } catch (e) {
    logger.error(`[ConfigReload] Unexpected error: ${e?.message || e}`);
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to reload configuration' });
  }
});

// Tunnel helper download (placeholder for static binary delivery)
// For Phase 1, return 404 with guidance unless helper binaries are added.
router.get('/tunnel-helper/:platform-:arch', (req, res) => {
  try {
    // In a follow-up, serve a static file based on platform/arch
    return res.status(404).json({
      error: 'Not Implemented',
      details: 'Tunnel helper distribution not configured on this server',
      platform: req.params.platform,
      arch: req.params.arch
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to handle request' });
  }
});

// Templates endpoints
router.get('/templates', (req, res) => {
  try {
    const allTemplates = templateLoader.getAllTemplates();
    const allowedIds = new Set(resolveAllowedTemplatesForUser(req.user));
    const filtered = allTemplates.filter((t) => allowedIds.has(t.id));
    res.json({ templates: filtered });
  } catch (error) {
    logger.error(`Error getting templates: ${error.message}`);
    res.status(500).json({
      error: 'SERVER_ERROR',
      code: 'TEMPLATES_FAILED',
      detail: error.message,
      context: {}
    });
  }
});

// Global links menu
router.get('/links', (req, res) => {
  try {
    const result = linksLoader.getLinks();
    res.json(result);
  } catch (error) {
    logger.error(`Error getting links: ${error.message}`);
    res.status(500).json({
      error: 'SERVER_ERROR',
      code: 'LINKS_FAILED',
      detail: error.message,
      context: {}
    });
  }
});

// Forge configuration summary
router.get('/forges', (req, res) => {
  try {
    const forgesRaw = config && (config.FORGES || {});
    const forges = Object.entries(forgesRaw).map(([name, cfg]) => ({
      name,
      type: cfg && cfg.type ? String(cfg.type) : '',
      host: cfg && cfg.host ? String(cfg.host) : '',
      has_list_repos: !!(cfg && cfg.list_repos),
      has_list_branches: !!(cfg && cfg.list_branches)
    }));
    res.json({
      forges,
      default_forge: config && (config.DEFAULT_FORGE || '')
    });
  } catch (error) {
    logger.error(`Error getting forge configuration: ${error.message}`);
    res.status(500).json({
      error: 'SERVER_ERROR',
      code: 'FORGES_FAILED',
      detail: error.message,
      context: {}
    });
  }
});

router.get('/templates/:templateId/parameters/:parameterName/options', (req, res) => {
  try {
    const { templateId, parameterName } = req.params;
    let variables = {};
    try {
      if (typeof req.query.vars === 'string' && req.query.vars.trim()) {
        variables = JSON.parse(req.query.vars);
      }
    } catch (e) {
      logger.warning(`Invalid vars query for options: ${e.message}`);
    }
    const options = templateLoader.getParameterOptions(templateId, parameterName, variables, req.user || null);
    res.json(options);
  } catch (error) {
    logger.error(`Error getting parameter options: ${error.message}`);
    const context = { template_id: req.params?.templateId, parameter: req.params?.parameterName };
    if (error.message.includes('not found')) {
      res.status(404).json({ error: 'NOT_FOUND', code: 'TEMPLATE_PARAM_NOT_FOUND', detail: error.message, context });
    } else {
      res.status(500).json({ error: 'SERVER_ERROR', code: 'PARAM_OPTIONS_FAILED', detail: error.message, context });
    }
  }
});

// Support POST with JSON body to pass variables
router.post('/templates/:templateId/parameters/:parameterName/options', (req, res) => {
  try {
    const { templateId, parameterName } = req.params;
    const variables = (req.body && typeof req.body.variables === 'object') ? req.body.variables : {};
    const options = templateLoader.getParameterOptions(templateId, parameterName, variables, req.user || null);
    res.json(options);
  } catch (error) {
    logger.error(`Error (POST) getting parameter options: ${error.message}`);
    const context = { template_id: req.params?.templateId, parameter: req.params?.parameterName };
    if (error.message.includes('not found')) {
      res.status(404).json({ error: 'NOT_FOUND', code: 'TEMPLATE_PARAM_NOT_FOUND', detail: error.message, context });
    } else {
      res.status(500).json({ error: 'SERVER_ERROR', code: 'PARAM_OPTIONS_FAILED', detail: error.message, context });
    }
  }
});

// Notification endpoint
router.post('/notifications', async (req, res) => {
  try {
    const { type = 'info', title, message, sound = true, session_id } = req.body || {};

    // Validate required fields
    if (!title || !message) {
      return res.status(400).json({ error: 'title and message are required' });
    }

    // Validate notification type
    const validTypes = ['info', 'warning', 'error', 'success'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: `Invalid notification type: ${type}. Must be one of: ${validTypes.join(', ')}`
      });
    }

    const requester = req.user || {};
    const canBroadcast = requester?.permissions?.broadcast === true;

    // Session-targeted notifications require broadcast permission.
    if (session_id) {
      if (!canBroadcast) {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'Broadcast permission required for session notifications' });
      }

      // Resolve session (active or terminated)
      let session = null;
      try { session = global.sessionManager.getSession(session_id); } catch (_) { session = null; }
      if (!session && global.sessionManager?.getSessionIncludingTerminated) {
        try { session = await global.sessionManager.getSessionIncludingTerminated(session_id, { loadFromDisk: true }); } catch (_) { session = null; }
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
        const saved = global.notificationManager.add(username, {
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

    // Non-session notifications: persist to requesting user (legacy behavior)
    const username = requester?.username;
    if (!username) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const saved = global.notificationManager.add(username, {
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
    logger.error(`Error sending notification: ${error.message}`);
    res.status(500).json({ error: 'Failed to send notification', details: error.message });
  }
});

// Shutdown endpoint
router.post('/shutdown', (req, res) => {
  logger.info('=== API SHUTDOWN: SENDING NOTIFICATION ===');
  
  const connectedCount = global.connectionManager.connections.size;
  logger.info(`Sending shutdown notification to ${connectedCount} connected clients`);
  
  if (connectedCount > 0) {
    const shutdownMessage = {
      type: 'shutdown',
      title: 'Server Shutdown',
      message: 'The terminal server is shutting down. The application will reload in 5 seconds.',
      notification_type: 'warning',
      timestamp: new Date().toISOString()
    };
    
    global.connectionManager.broadcast(shutdownMessage);
    logger.info('Shutdown notification sent to all clients');
  }
  
  res.json({ message: `Shutdown notification sent to ${connectedCount} clients, server shutting down` });
  
  // Shutdown after brief delay
  setTimeout(() => {
    logger.info('Initiating server shutdown');
    process.emit('SIGTERM');
  }, 1000);
});

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

export default router;
