/**
 * Interactive Notification Actions
 * Shared logic for processing interactive notification actions (HTTP + WebSocket).
 */

import { config } from '../config-loader.js';
import { logger } from '../utils/logger.js';

/**
 * Process an interactive notification action for a user.
 *
 * Returns a structured result that can be used by both HTTP and WebSocket layers:
 *   {
 *     ok: boolean,
 *     status: string,
 *     error: string|null,
 *     httpStatus: number|null,
 *     response: Object|null   // persisted response summary (non-secret inputs only)
 *   }
 *
 * This function is side-effectful:
 *   - Invokes the notification callback URL.
 *   - Persists a response summary via NotificationManager.setResponse.
 *
 * @param {Object} params
 * @param {string} params.username
 * @param {string} params.notificationId
 * @param {string} params.actionKey
 * @param {Object} params.rawInputs
 * @param {string} [params.source] - For logging context, e.g. 'WS' or 'HTTP'
 * @returns {Promise<{ ok: boolean, status: string, error: string|null, httpStatus: number|null, response: any|null }>}
 */
export async function processInteractiveNotificationAction({
  username,
  notificationId,
  actionKey,
  rawInputs,
  source = 'WS'
}) {
  const mgr = global.notificationManager;
  const logPrefix = source === 'HTTP' ? '[HTTP]' : '[WS]';

  if (!mgr || typeof mgr.getById !== 'function' || typeof mgr.setResponse !== 'function') {
    return {
      ok: false,
      status: 'internal_error',
      error: 'INTERACTIVE_NOTIFICATIONS_UNAVAILABLE',
      httpStatus: null,
      response: null
    };
  }

  const notificationIdTrimmed = typeof notificationId === 'string' ? notificationId.trim() : '';
  const actionKeyTrimmed = typeof actionKey === 'string' ? actionKey.trim() : '';
  const inputs = (rawInputs && typeof rawInputs === 'object') ? rawInputs : {};

  if (!notificationIdTrimmed || !actionKeyTrimmed) {
    return {
      ok: false,
      status: 'invalid_payload',
      error: 'INVALID_PAYLOAD',
      httpStatus: null,
      response: null
    };
  }

  const user = (typeof username === 'string' && username) ? username : config.DEFAULT_USERNAME;

  let notification;
  try {
    notification = mgr.getById(user, notificationIdTrimmed);
  } catch (err) {
    logger.error(`${logPrefix} notification_action: failed to load notification ${notificationIdTrimmed} for user '${user}': ${err.message}`);
    return {
      ok: false,
      status: 'internal_error',
      error: 'INTERNAL_ERROR',
      httpStatus: null,
      response: null
    };
  }

  if (!notification) {
    return {
      ok: false,
      status: 'notification_not_found',
      error: 'NOTIFICATION_NOT_FOUND',
      httpStatus: null,
      response: null
    };
  }

  const actions = Array.isArray(notification.actions) ? notification.actions : [];
  const inputsDef = Array.isArray(notification.inputs) ? notification.inputs : [];
  const hasInteractive =
    typeof notification.callback_url === 'string' &&
    notification.callback_url &&
    (actions.length > 0 || inputsDef.length > 0);

  if (!hasInteractive) {
    return {
      ok: false,
      status: 'not_interactive',
      error: 'NOT_INTERACTIVE',
      httpStatus: null,
      response: null
    };
  }

  if (notification.response) {
    // Single-use semantics: do not invoke callback again.
    return {
      ok: false,
      status: 'already_responded',
      error: 'ALREADY_RESPONDED',
      httpStatus: null,
      response: notification.response || null
    };
  }

  const action = actions.find((a) => a && a.key === actionKeyTrimmed);
  if (!action) {
    return {
      ok: false,
      status: 'invalid_action',
      error: 'INVALID_ACTION',
      httpStatus: null,
      response: null
    };
  }

  // Build input definition map
  const defById = new Map();
  for (const def of inputsDef) {
    if (!def || typeof def !== 'object' || typeof def.id !== 'string') continue;
    const id = def.id;
    if (!id) continue;
    const type = (typeof def.type === 'string' && def.type.toLowerCase() === 'secret')
      ? 'secret'
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
    const rawVal = Object.prototype.hasOwnProperty.call(inputs, id) ? inputs[id] : undefined;
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

    if (def.type === 'secret') {
      if (value && value.length > 0) maskedInputIds.push(id);
    } else if (value && value.length > 0) {
      publicInputs[id] = value;
    }
  }

  if (missingRequired.length > 0) {
    return {
      ok: false,
      status: 'missing_required_inputs',
      error: 'MISSING_REQUIRED_INPUTS',
      httpStatus: null,
      response: null
    };
  }

  const callbackUrl = notification.callback_url;
  if (!callbackUrl) {
    return {
      ok: false,
      status: 'internal_error',
      error: 'MISSING_CALLBACK_URL',
      httpStatus: null,
      response: null
    };
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
    user,
    action: actionKeyTrimmed,
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
  let httpStatus = null;

  const controller = new AbortController();
  const timeoutMs = 10000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(callbackUrl, {
      method,
      headers,
      body: JSON.stringify(callbackPayload),
      signal: controller.signal
    });
    httpStatus = typeof resp?.status === 'number' ? resp.status : null;
    if (resp && resp.ok) {
      ok = true;
    } else {
      ok = false;
      status = 'callback_failed';
      errorCode = `HTTP_${resp ? resp.status : 'UNKNOWN'}`;
      logger.warning(
        `${logPrefix} notification_action callback failed for notification ${notification.id} (user='${user}'): status=${resp ? resp.status : 'unknown'}`
      );
    }
  } catch (err) {
    ok = false;
    status = 'callback_failed';
    if (err && err.name === 'AbortError') {
      errorCode = 'TIMEOUT';
      logger.error(
        `${logPrefix} notification_action callback timeout for notification ${notification.id} (user='${user}'): aborted after ${timeoutMs}ms`
      );
    } else {
      errorCode = 'NETWORK_ERROR';
      logger.error(
        `${logPrefix} notification_action callback error for notification ${notification.id} (user='${user}'): ${err?.message || err}`
      );
    }
  } finally {
    try { clearTimeout(timeoutId); } catch (_) {}
  }

  let responseSummary = null;
  try {
    responseSummary = {
      at: new Date().toISOString(),
      user,
      action_key: actionKeyTrimmed,
      action_label: action.label || null,
      status,
      inputs: publicInputs,
      masked_input_ids: maskedInputIds
    };
    const persisted = mgr.setResponse(user, notificationIdTrimmed, responseSummary);
    if (persisted && persisted.response) {
      responseSummary = persisted.response;
    }
  } catch (err) {
    logger.error(
      `${logPrefix} notification_action: failed to persist response for notification ${notification.id} (user='${user}'): ${err.message}`
    );
  }

  return {
    ok,
    status,
    error: ok ? null : (errorCode || 'CALLBACK_FAILED'),
    httpStatus,
    response: responseSummary
  };
}

export default {
  processInteractiveNotificationAction
};
