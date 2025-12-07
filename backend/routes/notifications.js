import express from 'express';
import { logger } from '../utils/logger.js';
import { sendNtfyNotification } from '../services/notification-service.js';
import { config } from '../config-loader.js';
import { processInteractiveNotificationAction } from '../services/interactive-notification-action.js';

const router = express.Router();

const INTERACTIVE_MAX_INPUT_VALUE_LENGTH = 4096;
const INTERACTIVE_MAX_CALLBACK_URL_LENGTH = 2048;
const ALLOWED_CALLBACK_METHODS = ['POST', 'PUT', 'PATCH'];
const ALLOWED_ACTION_STYLES = ['primary', 'secondary', 'danger'];
const ALLOWED_INPUT_TYPES = ['string', 'secret'];

// Ensure NotificationManager is available globally via server.js
function getManager() {
  const mgr = global.notificationManager;
  if (!mgr) throw new Error('Notification manager not initialized');
  return mgr;
}

/**
 * Validate and normalize interactive notification fields from the request body.
 * When no interactive fields are present, returns { isInteractive: false, interactive: null }.
 * On validation error, returns { error: { statusCode, body } }.
 */
export function validateInteractiveNotificationBody(rawBody = {}) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};

  const hasActionsField = Array.isArray(body.actions) && body.actions.length > 0;
  const hasInputsField = Array.isArray(body.inputs) && body.inputs.length > 0;
  const hasCallbackUrlField = typeof body.callback_url === 'string' && body.callback_url.trim().length > 0;
  const hasCallbackMethodField = typeof body.callback_method === 'string' && body.callback_method.trim().length > 0;
  const hasCallbackHeadersField =
    body.callback_headers && typeof body.callback_headers === 'object' && !Array.isArray(body.callback_headers);

  const anyInteractiveField =
    hasActionsField || hasInputsField || hasCallbackUrlField || hasCallbackMethodField || hasCallbackHeadersField;
  if (!anyInteractiveField) {
    return { isInteractive: false, interactive: null };
  }

  const error = (code, message) => ({
    error: {
      statusCode: 400,
      body: {
        error: code,
        message
      }
    }
  });

  // Require callback_url when any interactive-related field is present
  if ((hasActionsField || hasInputsField || hasCallbackMethodField || hasCallbackHeadersField) && !hasCallbackUrlField) {
    return error(
      'INVALID_CALLBACK_URL',
      'callback_url is required when actions, inputs, callback_method, or callback_headers are provided'
    );
  }

  // Validate callback_url
  let callback_url = null;
  if (hasCallbackUrlField) {
    const rawUrl = body.callback_url.trim();
    if (rawUrl.length > INTERACTIVE_MAX_CALLBACK_URL_LENGTH) {
      return error('INVALID_CALLBACK_URL', 'callback_url is too long');
    }
    try {
      const u = new URL(rawUrl);
      const protocol = String(u.protocol || '').toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') {
        return error('INVALID_CALLBACK_URL', 'callback_url must use http or https scheme');
      }
    } catch (_) {
      return error('INVALID_CALLBACK_URL', 'callback_url must be a valid URL');
    }
    callback_url = rawUrl;
  }

  // Validate callback_method
  let callback_method = 'POST';
  if (hasCallbackMethodField) {
    const method = body.callback_method.trim().toUpperCase();
    if (!ALLOWED_CALLBACK_METHODS.includes(method)) {
      return error(
        'INVALID_CALLBACK_METHOD',
        `callback_method must be one of: ${ALLOWED_CALLBACK_METHODS.join(', ')}`
      );
    }
    callback_method = method;
  }

  // Validate callback_headers
  let callback_headers;
  if (body.callback_headers !== undefined) {
    if (!hasCallbackHeadersField) {
      return error('INVALID_CALLBACK_HEADERS', 'callback_headers must be an object of header name to value');
    }
    const out = {};
    for (const [name, value] of Object.entries(body.callback_headers || {})) {
      const key = String(name || '').trim();
      if (!key) continue;
      out[key] = typeof value === 'string' ? value : String(value ?? '');
    }
    if (Object.keys(out).length > 0) {
      callback_headers = out;
    }
  }

  // Validate actions
  let actions = null;
  if (body.actions !== undefined) {
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      return error('INVALID_ACTIONS', 'actions must be a non-empty array when provided');
    }
    actions = [];
    const seenKeys = new Set();
    for (let idx = 0; idx < body.actions.length; idx += 1) {
      const rawAction = body.actions[idx];
      if (!rawAction || typeof rawAction !== 'object') {
        return error('INVALID_ACTIONS', `actions[${idx}] must be an object`);
      }
      const key = typeof rawAction.key === 'string' ? rawAction.key.trim() : '';
      const label = typeof rawAction.label === 'string' ? rawAction.label.trim() : '';
      if (!key || !label) {
        return error('INVALID_ACTIONS', `actions[${idx}] must include non-empty key and label`);
      }
      if (seenKeys.has(key)) {
        return error('INVALID_ACTIONS', `Duplicate action key '${key}'`);
      }
      seenKeys.add(key);
      const action = { key, label };
      if (rawAction.style !== undefined && rawAction.style !== null && String(rawAction.style).trim()) {
        const styleNorm = String(rawAction.style).trim().toLowerCase();
        if (!ALLOWED_ACTION_STYLES.includes(styleNorm)) {
          return error(
            'INVALID_ACTIONS',
            `actions[${idx}].style must be one of: ${ALLOWED_ACTION_STYLES.join(', ')}`
          );
        }
        action.style = styleNorm;
      }
      if (rawAction.requires_inputs !== undefined) {
        if (!Array.isArray(rawAction.requires_inputs)) {
          return error('INVALID_ACTIONS', `actions[${idx}].requires_inputs must be an array when provided`);
        }
        const ids = [];
        for (const entry of rawAction.requires_inputs) {
          const id = typeof entry === 'string' ? entry.trim() : '';
          if (!id || ids.includes(id)) continue;
          ids.push(id);
        }
        if (ids.length > 0) {
          action.requires_inputs = ids;
        }
      }
      actions.push(action);
    }
  }

  // Validate inputs
  let inputs = null;
  const inputIdSet = new Set();
  if (body.inputs !== undefined) {
    if (!Array.isArray(body.inputs) || body.inputs.length === 0) {
      return error('INVALID_INPUTS', 'inputs must be a non-empty array when provided');
    }
    inputs = [];
    for (let idx = 0; idx < body.inputs.length; idx += 1) {
      const rawInput = body.inputs[idx];
      if (!rawInput || typeof rawInput !== 'object') {
        return error('INVALID_INPUTS', `inputs[${idx}] must be an object`);
      }
      const id = typeof rawInput.id === 'string' ? rawInput.id.trim() : '';
      if (!id) {
        return error('INVALID_INPUTS', `inputs[${idx}].id is required`);
      }
      if (inputIdSet.has(id)) {
        return error('INVALID_INPUTS', `Duplicate input id '${id}'`);
      }
      inputIdSet.add(id);
      const label = typeof rawInput.label === 'string' ? rawInput.label.trim() : '';
      if (!label) {
        return error('INVALID_INPUTS', `inputs[${idx}].label is required`);
      }
      let type = typeof rawInput.type === 'string' ? rawInput.type.trim().toLowerCase() : 'string';
      if (!ALLOWED_INPUT_TYPES.includes(type)) {
        return error('INVALID_INPUTS', `inputs[${idx}].type must be one of: ${ALLOWED_INPUT_TYPES.join(', ')}`);
      }
      const required = rawInput.required === true;
      const placeholder = (typeof rawInput.placeholder === 'string' && rawInput.placeholder.trim())
        ? rawInput.placeholder
        : undefined;
      let max_length;
      if (rawInput.max_length !== undefined && rawInput.max_length !== null) {
        const nVal = Number(rawInput.max_length);
        if (!Number.isFinite(nVal) || nVal <= 0) {
          return error('INVALID_INPUTS', `inputs[${idx}].max_length must be a positive number when provided`);
        }
        const clamped = Math.min(Math.floor(nVal), INTERACTIVE_MAX_INPUT_VALUE_LENGTH);
        max_length = clamped;
      }
      const input = { id, label, type, required };
      if (placeholder) input.placeholder = placeholder;
      if (max_length !== undefined) input.max_length = max_length;
      inputs.push(input);
    }
  }

  const hasActions = Array.isArray(actions) && actions.length > 0;
  const hasInputs = Array.isArray(inputs) && inputs.length > 0;

  if (!hasActions && !hasInputs) {
    return error(
      'INVALID_INTERACTIVE_NOTIFICATION',
      'Interactive notifications require at least one action or input when callback_url is provided'
    );
  }

  // Validate that action.requires_inputs entries exist in inputs
  if (hasActions) {
    const knownInputIds = new Set(inputs ? inputs.map((i) => i.id) : []);
    for (const action of actions) {
      if (!action.requires_inputs) continue;
      for (const reqId of action.requires_inputs) {
        if (!knownInputIds.has(reqId)) {
          return error(
            'INVALID_INTERACTIVE_NOTIFICATION',
            `Action '${action.key}' references unknown input id '${reqId}'`
          );
        }
      }
    }
  }

  return {
    isInteractive: hasActions || hasInputs,
    interactive: {
      callback_url,
      callback_method,
      callback_headers,
      actions,
      inputs
    }
  };
}

// Remove backend-only metadata before returning notifications to clients
function sanitizeNotificationForClient(notification) {
  if (!notification || typeof notification !== 'object') return notification;
  const { callback_url, callback_method, callback_headers, ...rest } = notification;
  return rest;
}

// List notifications for the authenticated user
router.get('/', (req, res) => {
  try {
    const user = req.user?.username;
    const items = getManager().list(user).map(sanitizeNotificationForClient);
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

    // Validate interactive metadata (actions/inputs/callback)
    const interactiveResult = validateInteractiveNotificationBody(body);
    if (interactiveResult.error) {
      return res
        .status(interactiveResult.error.statusCode)
        .json(interactiveResult.error.body);
    }
    const isInteractive = interactiveResult.isInteractive === true;
    const interactiveFields = interactiveResult.interactive || {};
    const nowIso = new Date().toISOString();

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
          timestamp: nowIso,
          session_id,
          is_active: isInteractive,
          ...(isInteractive ? interactiveFields : {})
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
            sound: !!sound,
            actions: Array.isArray(saved.actions) && saved.actions.length > 0 ? saved.actions : undefined,
            inputs: Array.isArray(saved.inputs) && saved.inputs.length > 0 ? saved.inputs : undefined,
            response: saved.response || null
          });
        } catch (_) {}
      }

      try { await sendNtfyNotification(title, message, session_id, type); } catch (_) {}
      const clientSaved = savedObjects.map(sanitizeNotificationForClient);
      return res.status(201).json({ recipients: Array.from(recipients), saved: clientSaved });
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
      timestamp: nowIso,
      session_id: null,
      is_active: isInteractive,
      ...(isInteractive ? interactiveFields : {})
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
        sound: !!sound,
        actions: Array.isArray(saved.actions) && saved.actions.length > 0 ? saved.actions : undefined,
        inputs: Array.isArray(saved.inputs) && saved.inputs.length > 0 ? saved.inputs : undefined,
        response: saved.response || null
      });
    } catch (_) {}
    try { await sendNtfyNotification(title, message, null, type); } catch (_) {}
    return res.status(201).json({ saved: sanitizeNotificationForClient(saved) });
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

// Cancel an interactive notification without deleting it
// POST /api/notifications/:id/cancel
router.post('/:id/cancel', (req, res) => {
  try {
    const user = req.user?.username;
    if (!user) {
      return res.status(401).json({
        ok: false,
        status: 'unauthorized',
        error: 'AUTH_REQUIRED',
        message: 'Authentication required'
      });
    }

    const { id } = req.params;
    const mgr = getManager();
    const notification = mgr.getById(user, id);
    if (!notification) {
      return res.status(404).json({
        ok: false,
        status: 'notification_not_found',
        error: 'NOT_FOUND',
        message: 'Notification not found'
      });
    }

    const actions = Array.isArray(notification.actions) ? notification.actions : [];
    const inputs = Array.isArray(notification.inputs) ? notification.inputs : [];
    const hasInteractive =
      typeof notification.callback_url === 'string' &&
      notification.callback_url &&
      (actions.length > 0 || inputs.length > 0);

    if (!hasInteractive) {
      return res.status(400).json({
        ok: false,
        status: 'not_interactive',
        error: 'NOT_INTERACTIVE',
        message: 'Notification is not interactive'
      });
    }

    if (notification.response) {
      return res.status(409).json({
        ok: false,
        status: 'already_responded',
        error: 'ALREADY_RESPONDED',
        message: 'Notification already has a response',
        response: notification.response
      });
    }

    const nowIso = new Date().toISOString();
    const cancelResponse = {
      at: nowIso,
      user,
      action_key: null,
      action_label: 'Canceled',
      status: 'canceled',
      inputs: {},
      masked_input_ids: []
    };

    const updated = mgr.setResponse(user, id, cancelResponse);
    if (!updated || !updated.response) {
      return res.status(500).json({
        ok: false,
        status: 'internal_error',
        error: 'INTERNAL_ERROR',
        message: 'Failed to persist cancellation'
      });
    }

    const clientNotification = sanitizeNotificationForClient(updated);

    try {
      if (global.connectionManager && typeof global.connectionManager.broadcast === 'function') {
        global.connectionManager.broadcast({
          type: 'notification_updated',
          user,
          notification_id: updated.id,
          is_active: updated.is_active,
          response: updated.response
        });
      }
    } catch (_) {}

    return res.status(200).json({
      ok: true,
      status: 'canceled',
      notification: clientNotification
    });
  } catch (error) {
    logger.error(`Failed to cancel notification: ${error.message}`);
    res.status(500).json({
      ok: false,
      status: 'internal_error',
      error: 'INTERNAL_ERROR',
      message: 'Failed to cancel notification'
    });
  }
});

// Submit an interactive notification action via HTTP.
// POST /api/notifications/:id/action
router.post('/:id/action', async (req, res) => {
  try {
    const username = req.user?.username || config.DEFAULT_USERNAME;
    const { id } = req.params;
    const body = req.body || {};
    const actionKey = typeof body.action_key === 'string' ? body.action_key : '';
    const inputs = (body.inputs && typeof body.inputs === 'object') ? body.inputs : {};

    const result = await processInteractiveNotificationAction({
      username,
      notificationId: id,
      actionKey,
      rawInputs: inputs,
      source: 'HTTP'
    });

    const ok = !!result.ok;
    const status = result.status || (ok ? 'callback_succeeded' : 'internal_error');
    const errorCode = ok ? null : (result.error || 'CALLBACK_FAILED');

    // Map semantic status to HTTP status codes
    let httpCode = 200;
    if (!ok) {
      if (status === 'notification_not_found') httpCode = 404;
      else if (status === 'not_interactive') httpCode = 400;
      else if (status === 'already_responded') httpCode = 409;
      else if (status === 'missing_required_inputs' || status === 'invalid_action' || status === 'invalid_payload') {
        httpCode = 400;
      } else if (status === 'callback_failed') {
        httpCode = 502;
      } else {
        httpCode = 500;
      }
    }

    // Broadcast a WebSocket result so all of the user's tabs stay in sync.
    try {
      if (global.connectionManager && typeof global.connectionManager.broadcast === 'function') {
        global.connectionManager.broadcast({
          type: 'notification_action_result',
          user: username,
          notification_id: id,
          action_key: actionKey || null,
          ok,
          error: errorCode,
          status,
          http_status: result.httpStatus ?? null
        });
      }
    } catch (_) {}

    const responseBody = {
      ok,
      status
    };
    if (errorCode) responseBody.error = errorCode;
    if (result.response) responseBody.response = result.response;

    return res.status(httpCode).json(responseBody);
  } catch (error) {
    logger.error(`Failed to process interactive notification action: ${error.message}`);
    res.status(500).json({ ok: false, status: 'internal_error', error: 'INTERNAL_ERROR' });
  }
});

export default router;
