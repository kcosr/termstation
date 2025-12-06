/**
 * WebSocket Message Handlers
 * Handles different types of WebSocket messages
 */

import { logger } from '../utils/logger.js';
import { config } from '../config-loader.js';
import { broadcastSessionUpdate } from '../utils/broadcast.js';
import { perSessionOpsLimiter, globalOpsLimiter } from '../utils/rate-limiters.js';

// Session update broadcasting handled via utility

export const messageHandlers = {
  // Handle client attachment to session
  async attach(clientId, message) {
    const { session_id } = message;

    if (!session_id) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: 'session_id required for attach'
      });
      return;
    }

    // Debug logging: who is attaching?
    try {
      const ws = global.connectionManager?.connections?.get(clientId);
      const uname = ws && ws.username ? ws.username : config.DEFAULT_USERNAME;
      logger.info(`[WS] attach request: client=${clientId} user='${uname}' session=${session_id}`);
    } catch (_) {}

    // Enforce privacy: only owner may attach to private sessions, unless admin
    try {
      const session = global.sessionManager.getSession(session_id);
      if (!session) {
        global.connectionManager.sendToClient(clientId, { type: 'error', message: `Session ${session_id} not found` });
        return;
      }
      const ws = global.connectionManager?.connections?.get(clientId);
      const requester = (ws && ws.username) ? ws.username : config.DEFAULT_USERNAME;
      const isAdmin = !!(ws && ws.permissions && ws.permissions.manage_all_sessions === true);
      if (session.visibility === 'private' && !isAdmin && String(session.created_by) !== String(requester)) {
        global.connectionManager.sendToClient(clientId, { type: 'error', message: 'Access denied to private session' });
        return;
      }
    } catch (_) {}

    // Get current history snapshot marker before attaching
    const session = global.sessionManager.getSession(session_id);
    const historyMarker = session ? session.outputSequenceNumber : null;
    const historyByteOffset = session && typeof session.outputHistory === 'string' ? session.outputHistory.length : 0;
    const shouldLoadHistory = session && session.load_history !== false;

    logger.info(`[WS] Processing attach: session=${session_id}, historyMarker=${historyMarker}, historyByteOffset=${historyByteOffset}, shouldLoadHistory=${shouldLoadHistory}`);

    const success = global.sessionManager.attachClientToSession(session_id, clientId, shouldLoadHistory, historyMarker);
    if (success) {
      global.connectionManager.attachClientToSession(clientId, session_id);

      const attachedMessage = {
        type: 'attached',
        session_id: session_id,
        history_marker: historyMarker, // Send marker for client to use in history sync
        history_byte_offset: historyByteOffset, // Send byte offset to filter history endpoint
        should_load_history: shouldLoadHistory
      };

      logger.info(`[WS] Sending attached message to client ${clientId}:`, attachedMessage);
      global.connectionManager.sendToClient(clientId, attachedMessage);

      // Output streaming is now handled by the centralized broadcaster
      // No need to set up per-client onData handlers
      logger.debug(`Client ${clientId} attached to session ${session_id}, using centralized broadcaster, history_marker: ${historyMarker}`);

      broadcastSessionUpdate(session, 'updated');
    } else {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: `Failed to attach to session ${session_id}`
      });
    }
  },

  // Handle client detachment from session
  async detach(clientId, message) {
    const { session_id } = message;

    if (session_id) {
      global.sessionManager.detachClientFromSession(session_id, clientId);
      global.connectionManager.detachClientFromSession(clientId, session_id);
      
      global.connectionManager.sendToClient(clientId, {
        type: 'detached',
        session_id: session_id
      });

      const session = global.sessionManager.getSession(session_id);
      if (session) {
        broadcastSessionUpdate(session, 'updated');
      }
    }
  },

  // Force-detach a specific client from a session
  async detach_client(clientId, message) {
    const { session_id, target_client_id } = message || {};

    if (!session_id || !target_client_id) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: 'session_id and target_client_id required for detach_client'
      });
      return;
    }

    const session = global.sessionManager.getSession(session_id);
    if (!session) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: `Session ${session_id} not found`
      });
      return;
    }

    // Only act if the target client is currently attached to this session
    const isAttached = session.connected_clients.has(target_client_id);
    if (!isAttached) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: `Client ${target_client_id} is not attached to session ${session_id}`
      });
      return;
    }

    // Detach in session and connection manager
    try {
      const actor = global.connectionManager?.connections?.get(clientId);
      const target = global.connectionManager?.connections?.get(target_client_id);
      logger.info(`[WS] detach_client: actor=${clientId} user='${actor?.username || config.DEFAULT_USERNAME}' target=${target_client_id} target_user='${target?.username || config.DEFAULT_USERNAME}' session=${session_id}`);
    } catch (_) {}

    global.sessionManager.detachClientFromSession(session_id, target_client_id);
    global.connectionManager.detachClientFromSession(target_client_id, session_id);

    // Notify the target client so its UI can update
    global.connectionManager.sendToClient(target_client_id, {
      type: 'detached',
      session_id
    });

    // Broadcast updated session info to everyone
    broadcastSessionUpdate(session, 'updated');
  },

  // Handle history sync completion from client
  async history_loaded(clientId, message) {
    const { session_id } = message;

    logger.info(`[WS] Received history_loaded from client ${clientId} for session ${session_id}`);

    if (!session_id) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: 'session_id required for history_loaded'
      });
      return;
    }

    const session = global.sessionManager.getSession(session_id);
    if (!session) {
      logger.warning(`[WS] Session ${session_id} not found for history_loaded`);
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: `Session ${session_id} not found`
      });
      return;
    }

    // Mark client as done loading history and get queued output
    const queuedOutput = session.markClientHistoryLoaded(clientId);

    // Send all queued output to the client
    if (queuedOutput && queuedOutput.length > 0) {
      logger.info(`[WS] Flushing ${queuedOutput.length} queued output chunks for client ${clientId} on session ${session_id}`);
      for (const data of queuedOutput) {
        global.connectionManager.sendToClient(clientId, {
          type: 'stdout',
          session_id: session_id,
          data: data,
          from_queue: true // Mark as queued output for debugging
        });
      }
    } else {
      logger.info(`[WS] No queued output for client ${clientId} on session ${session_id}`);
    }

    logger.info(`[WS] Client ${clientId} completed history loading for session ${session_id}`);
  },

  // Handle stdin input to session
  async stdin(clientId, message) {
    const { session_id } = message;

    // Do not apply op-count rate limiting to stdin.
    // Large pastes can legitimately produce very large single messages
    // or short bursts; gating here causes user-visible freezes.
    // Global DoS protection is handled at the WebSocket layer (maxPayload)
    // and by the PTY throughput itself.

    if (!session_id) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: 'session_id required for stdin'
      });
      return;
    }

    const session = global.sessionManager.getSession(session_id);
    if (!session) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: `Session ${session_id} not found`
      });
      return;
    }

    if (!session.interactive) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: `Session ${session_id} is not interactive - input rejected`
      });
      return;
    }

    if (!global.connectionManager.isClientAttachedToSession(clientId, session_id)) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: `Client not attached to session ${session_id} - input rejected`
      });
      return;
    }

    // Enforce shared read-only visibility: only owner can send input
    try {
      if (session.visibility === 'shared_readonly') {
        const ws = global.connectionManager?.connections?.get(clientId);
        const requester = (ws && ws.username) ? ws.username : config.DEFAULT_USERNAME;
        if (String(requester) !== String(session.created_by)) {
          global.connectionManager.sendToClient(clientId, {
            type: 'error',
            message: `Session ${session_id} is read-only for your account`
          });
          return;
        }
      }
    } catch (_) {}

    // Optional verbose logging of inbound stdin over WebSocket
    if (config.DEBUG_WS_STDIN) {
      try {
        const raw = (message && typeof message.data === 'string') ? message.data : String(message?.data ?? '');
        const preview = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
        logger.debug(`[WS STDIN] client ${clientId} -> session ${session_id} (${raw.length} chars): ${JSON.stringify(preview)}`);
      } catch (e) {
        // best-effort logging only
      }
    }

    // Record last user input time for stop_inputs grace window logic
    try {
      session.last_user_input_at = Date.now();
    } catch (_) { /* best-effort only */ }

    const inputSuccess = session.write(message.data || '');
    if (!inputSuccess) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: `Failed to send input to session ${session_id}`
      });
    }
  },

  // Handle terminal resize
  async resize(clientId, message) {
    const { session_id } = message;

    // Rate limiting: shared with stdin to prevent resize spam
    try {
      const sessionKey = `session:${session_id || 'unknown'}`;
      if (!globalOpsLimiter.allow('global')) {
        global.connectionManager.sendToClient(clientId, { type: 'error', message: 'Global rate limit exceeded (resize)' });
        return;
      }
      if (!perSessionOpsLimiter.allow(sessionKey)) {
        // Ignore silently to avoid flicker; but inform sender with a clear error
        global.connectionManager.sendToClient(clientId, { type: 'error', message: `Rate limit exceeded for session ${session_id}` });
        return;
      }
    } catch (_) { /* best-effort limiter */ }

    if (!session_id) {
      global.connectionManager.sendToClient(clientId, {
        type: 'error',
        message: 'session_id required for resize'
      });
      return;
    }

    const session = global.sessionManager.getSession(session_id);
    if (session) {
      // Only allow resize requests from clients that are actually attached
      const isAttached = global.connectionManager.isClientAttachedToSession(clientId, session_id);
      if (!isAttached) {
        try {
          logger.info(`[WS] Ignoring resize from non-attached client ${clientId} for session ${session_id}`);
        } catch (_) {}
        return;
      }

      // If no clients are attached at all, ignore resize to avoid shrinking PTY when hidden
      if (session.getConnectedClientCount && session.getConnectedClientCount() === 0) {
        try {
          logger.info(`[WS] Ignoring resize for session ${session_id} because no clients are attached`);
        } catch (_) {}
        return;
      }

      // Normalize and clamp dimensions to avoid pathological values
      let { cols = 80, rows = 24 } = message;
      cols = Number(cols);
      rows = Number(rows);
      if (!Number.isFinite(cols) || cols <= 0) cols = 80;
      if (!Number.isFinite(rows) || rows <= 0) rows = 24;
      // Apply a conservative minimum to prevent extremely narrow/short terminals
      // Align with frontend min sizing used in history view (approx 40x10)
      const minCols = 40;
      const minRows = 10;
      cols = Math.max(minCols, Math.floor(cols));
      rows = Math.max(minRows, Math.floor(rows));

      const resizeSuccess = session.resize(cols, rows);
      if (!resizeSuccess) {
        global.connectionManager.sendToClient(clientId, {
          type: 'error',
          message: `Failed to resize session ${session_id}`
        });
      }
    }
  },

  // Handle interactive notification actions from clients
  async notification_action(clientId, message) {
    const mgr = global.notificationManager;
    const connMgr = global.connectionManager;

    if (!connMgr || !mgr || typeof mgr.getById !== 'function' || typeof mgr.setResponse !== 'function') {
      try {
        connMgr?.sendToClient?.(clientId, {
          type: 'notification_action_result',
          notification_id: message?.notification_id || null,
          action_key: message?.action_key || null,
          ok: false,
          error: 'INTERACTIVE_NOTIFICATIONS_UNAVAILABLE',
          status: 'internal_error'
        });
      } catch (_) {}
      return;
    }

    const notificationId = typeof message?.notification_id === 'string'
      ? message.notification_id.trim()
      : '';
    const actionKey = typeof message?.action_key === 'string'
      ? message.action_key.trim()
      : '';
    const rawInputs = (message && message.inputs && typeof message.inputs === 'object')
      ? message.inputs
      : {};

    const sendResult = (payload) => {
      try {
        connMgr.sendToClient(clientId, {
          type: 'notification_action_result',
          notification_id: notificationId || null,
          action_key: actionKey || null,
          ok: false,
          error: payload.error || 'INVALID_ACTION',
          status: payload.status || 'invalid_payload'
        });
      } catch (_) {}
    };

    if (!notificationId || !actionKey) {
      sendResult({ error: 'INVALID_PAYLOAD', status: 'invalid_payload' });
      return;
    }

    // Resolve username from the WebSocket connection
    let username = config.DEFAULT_USERNAME;
    try {
      const ws = connMgr.connections?.get(clientId);
      if (ws && typeof ws.username === 'string' && ws.username) {
        username = ws.username;
      }
    } catch (_) {}

    let notification;
    try {
      notification = mgr.getById(username, notificationId);
    } catch (err) {
      logger.error(`[WS] notification_action: failed to load notification ${notificationId} for user '${username}': ${err.message}`);
      sendResult({ error: 'INTERNAL_ERROR', status: 'internal_error' });
      return;
    }

    if (!notification) {
      sendResult({ error: 'NOTIFICATION_NOT_FOUND', status: 'notification_not_found' });
      return;
    }

    const actions = Array.isArray(notification.actions) ? notification.actions : [];
    const inputsDef = Array.isArray(notification.inputs) ? notification.inputs : [];
    const hasInteractive =
      typeof notification.callback_url === 'string' &&
      notification.callback_url &&
      (actions.length > 0 || inputsDef.length > 0);

    if (!hasInteractive) {
      sendResult({ error: 'NOT_INTERACTIVE', status: 'not_interactive' });
      return;
    }

    if (notification.response) {
      sendResult({ error: 'ALREADY_RESPONDED', status: 'already_responded' });
      return;
    }

    const action = actions.find((a) => a && a.key === actionKey);
    if (!action) {
      sendResult({ error: 'INVALID_ACTION', status: 'invalid_action' });
      return;
    }

    // Build input definition map
    const defById = new Map();
    for (const def of inputsDef) {
      if (!def || typeof def !== 'object' || typeof def.id !== 'string') continue;
      const id = def.id;
      if (!id) continue;
      const type = (typeof def.type === 'string' && def.type.toLowerCase() === 'password')
        ? 'password'
        : 'string';
      const required = def.required === true;
      let maxLen = null;
      if (typeof def.max_length === 'number' && Number.isFinite(def.max_length) && def.max_length > 0) {
        maxLen = Math.floor(def.max_length);
      }
      defById.set(id, { ...def, id, type, required, max_length: maxLen });
    }

    const requiredIds = new Set();
    for (const def of defById.values()) {
      if (def.required) requiredIds.add(def.id);
    }
    if (Array.isArray(action.requires_inputs)) {
      for (const id of action.requires_inputs) {
        if (typeof id === 'string' && id) requiredIds.add(id);
      }
    }

    const allInputs = {};
    const publicInputs = {};
    const maskedInputIds = [];
    const missingRequired = [];

    for (const [id, def] of defById.entries()) {
      const rawVal = Object.prototype.hasOwnProperty.call(rawInputs, id) ? rawInputs[id] : undefined;
      let value = rawVal == null ? '' : String(rawVal);
      const maxLen = def.max_length;
      if (maxLen && value.length > maxLen) {
        value = value.slice(0, maxLen);
      }
      allInputs[id] = value;

      const isRequired = requiredIds.has(id);
      if (isRequired && (!value || !String(value).length)) {
        missingRequired.push(id);
      }

      if (def.type === 'password') {
        if (value && value.length > 0) maskedInputIds.push(id);
      } else if (value && value.length > 0) {
        publicInputs[id] = value;
      }
    }

    if (missingRequired.length > 0) {
      sendResult({
        error: 'MISSING_REQUIRED_INPUTS',
        status: 'missing_required_inputs'
      });
      return;
    }

    const callbackUrl = notification.callback_url;
    if (!callbackUrl) {
      sendResult({ error: 'MISSING_CALLBACK_URL', status: 'internal_error' });
      return;
    }

    const methodRaw = (notification.callback_method || 'POST').toUpperCase();
    const method = ['POST', 'PUT', 'PATCH'].includes(methodRaw) ? methodRaw : 'POST';
    const headers = {
      'Content-Type': 'application/json; charset=utf-8'
    };
    if (notification.callback_headers && typeof notification.callback_headers === 'object') {
      for (const [name, value] of Object.entries(notification.callback_headers)) {
        const key = String(name || '').trim();
        if (!key) continue;
        headers[key] = String(value ?? '');
      }
    }

    const callbackPayload = {
      notification_id: notification.id,
      user: username,
      action: actionKey,
      action_label: action.label || null,
      inputs: allInputs,
      session_id: notification.session_id || null,
      title: notification.title,
      message: notification.message,
      timestamp: notification.timestamp
    };

    let ok = false;
    let status = 'callback_succeeded';
    let errorCode = null;

    try {
      const resp = await fetch(callbackUrl, {
        method,
        headers,
        body: JSON.stringify(callbackPayload)
      });
      if (resp && resp.ok) {
        ok = true;
      } else {
        ok = false;
        status = 'callback_failed';
        errorCode = `HTTP_${resp ? resp.status : 'UNKNOWN'}`;
        logger.warning(
          `[WS] notification_action callback failed for notification ${notification.id} (user='${username}'): status=${resp ? resp.status : 'unknown'}`
        );
      }
    } catch (err) {
      ok = false;
      status = 'callback_failed';
      errorCode = 'NETWORK_ERROR';
      logger.error(
        `[WS] notification_action callback error for notification ${notification.id} (user='${username}'): ${err.message}`
      );
    }

    try {
      const responseSummary = {
        at: new Date().toISOString(),
        user: username,
        action_key: actionKey,
        action_label: action.label || null,
        inputs: publicInputs,
        masked_input_ids: maskedInputIds
      };
      mgr.setResponse(username, notificationId, responseSummary);
    } catch (err) {
      logger.error(
        `[WS] notification_action: failed to persist response for notification ${notification.id} (user='${username}'): ${err.message}`
      );
    }

    try {
      connMgr.sendToClient(clientId, {
        type: 'notification_action_result',
        notification_id: notificationId,
        action_key: actionKey,
        ok,
        error: ok ? null : (errorCode || 'CALLBACK_FAILED'),
        status
      });
    } catch (_) {}
  },

  // Handle ping/pong
  async ping(clientId, message) {
    global.connectionManager.sendToClient(clientId, {
      type: 'pong',
      timestamp: message.timestamp
    });
  }
};

export default messageHandlers;
