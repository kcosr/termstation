/**
 * Notification Manager
 * Per-user notification store with disk persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config-loader.js';
import { logger } from '../utils/logger.js';

// Max value length we will persist for interactive inputs
const INTERACTIVE_MAX_INPUT_VALUE_LENGTH = 4096;

function genId() {
  try {
    // Prefer crypto if available
    const bytes = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : null;
    if (bytes) return bytes;
  } catch (_) {}
  return `n_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalize a raw notification record (from disk or runtime payload)
 * into the canonical in-memory shape used by NotificationManager.
 */
function normalizeNotificationRecord(raw) {
  const nowIso = new Date().toISOString();
  const n = raw && typeof raw === 'object' ? raw : {};

  const base = {
    id: String(n.id || genId()),
    title: String(n.title || 'Notification'),
    message: String(n.message || ''),
    notification_type: String(n.notification_type || 'info'),
    timestamp: n.timestamp || nowIso,
    session_id: n.session_id || null,
    is_active: n.is_active !== false,
    read: !!n.read
  };

  let callback_url = null;
  if (typeof n.callback_url === 'string') {
    const trimmed = n.callback_url.trim();
    if (trimmed) callback_url = trimmed;
  }

  let callback_method = null;
  if (typeof n.callback_method === 'string') {
    const trimmed = n.callback_method.trim();
    if (trimmed) callback_method = trimmed.toUpperCase();
  }

  let callback_headers;
  if (n.callback_headers && typeof n.callback_headers === 'object' && !Array.isArray(n.callback_headers)) {
    const out = {};
    for (const [name, value] of Object.entries(n.callback_headers)) {
      const key = String(name || '').trim();
      if (!key) continue;
      out[key] = String(value ?? '');
    }
    if (Object.keys(out).length > 0) {
      callback_headers = out;
    }
  }

  let actions = null;
  if (Array.isArray(n.actions) && n.actions.length > 0) {
    const normalized = [];
    const seenKeys = new Set();
    for (const rawAction of n.actions) {
      if (!rawAction || typeof rawAction !== 'object') continue;
      const key = typeof rawAction.key === 'string' ? rawAction.key.trim() : '';
      const label = typeof rawAction.label === 'string' ? rawAction.label.trim() : '';
      if (!key || !label) continue;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const action = { key, label };
      if (typeof rawAction.style === 'string' && rawAction.style.trim()) {
        action.style = rawAction.style.trim();
      }
      if (Array.isArray(rawAction.requires_inputs) && rawAction.requires_inputs.length > 0) {
        const ids = [];
        for (const id of rawAction.requires_inputs) {
          const v = typeof id === 'string' ? id.trim() : '';
          if (v && !ids.includes(v)) ids.push(v);
        }
        if (ids.length > 0) action.requires_inputs = ids;
      }
      normalized.push(action);
    }
    if (normalized.length > 0) actions = normalized;
  }

  let inputs = null;
  if (Array.isArray(n.inputs) && n.inputs.length > 0) {
    const normalized = [];
    const seenIds = new Set();
    for (const rawInput of n.inputs) {
      if (!rawInput || typeof rawInput !== 'object') continue;
      let id = typeof rawInput.id === 'string' ? rawInput.id.trim() : '';
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      let label = typeof rawInput.label === 'string' ? rawInput.label.trim() : '';
      if (!label) label = id;
      let type = typeof rawInput.type === 'string' ? rawInput.type.trim().toLowerCase() : 'string';
      if (type !== 'password') type = 'string';
      const required = rawInput.required === true;
      const placeholder = (typeof rawInput.placeholder === 'string' && rawInput.placeholder.trim())
        ? rawInput.placeholder
        : undefined;
      let max_length;
      if (rawInput.max_length !== undefined && rawInput.max_length !== null) {
        const nVal = Number(rawInput.max_length);
        if (Number.isFinite(nVal) && nVal > 0) {
          const clamped = Math.min(Math.floor(nVal), INTERACTIVE_MAX_INPUT_VALUE_LENGTH);
          max_length = clamped;
        }
      }
      const input = { id, label, type, required };
      if (placeholder) input.placeholder = placeholder;
      if (max_length !== undefined) input.max_length = max_length;
      normalized.push(input);
    }
    if (normalized.length > 0) inputs = normalized;
  }

  let response = null;
  if (n.response && typeof n.response === 'object') {
    const rawResponse = n.response;
    const at = (typeof rawResponse.at === 'string' && rawResponse.at) ? rawResponse.at : nowIso;
    const user = typeof rawResponse.user === 'string' ? rawResponse.user : '';
    const action_key = typeof rawResponse.action_key === 'string' ? rawResponse.action_key : '';
    const action_label = (typeof rawResponse.action_label === 'string' && rawResponse.action_label)
      ? rawResponse.action_label
      : null;
    const inputsMap = {};
    if (rawResponse.inputs && typeof rawResponse.inputs === 'object') {
      for (const [k, v] of Object.entries(rawResponse.inputs)) {
        if (v === undefined || v === null) continue;
        inputsMap[String(k)] = typeof v === 'string' ? v : String(v);
      }
    }
    const maskedIds = Array.isArray(rawResponse.masked_input_ids)
      ? rawResponse.masked_input_ids
          .map((v) => (typeof v === 'string' ? v : String(v)))
          .filter((v) => v)
      : [];
    response = {
      at,
      user,
      action_key,
      action_label,
      inputs: inputsMap,
      masked_input_ids: maskedIds
    };
  }

  const out = {
    ...base,
    callback_url,
    callback_method,
    actions,
    inputs,
    response
  };
  if (callback_headers) {
    out.callback_headers = callback_headers;
  }
  return out;
}

export class NotificationManager {
  constructor() {
    // Map<username, Array<Notification>>
    this.store = new Map();
    this.dataDir = config.DATA_DIR;
    this.file = path.join(this.dataDir, 'notifications.json');
    this._saveTimer = null;
    this._saveDelay = 400; // debounce writes
    this._initialized = false;
    // Retention policy
    this._maxPerUser = 500; // cap list length per user
    this._maxAgeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    this._init();
  }

  _init() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (data && data.users && typeof data.users === 'object') {
          for (const [username, payload] of Object.entries(data.users)) {
            const list = this._coerceList(payload);
            this.store.set(username, list);
          }
        }
      }
      this._initialized = true;
      logger.info(`[NotificationManager] Initialized. Users loaded: ${this.store.size}`);
    } catch (err) {
      logger.error(`[NotificationManager] Failed to initialize: ${err.message}`);
    }
  }

  _coerceList(payload) {
    try {
      const arr = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.notifications)
          ? payload.notifications
          : [];
      return arr.map((n) => normalizeNotificationRecord(n));
    } catch (_) {
      return [];
    }
  }

  _saveImmediate() {
    try {
      const users = {};
      for (const [username, list] of this.store.entries()) {
        users[username] = { notifications: list };
      }
      const out = { users };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { flag: 'w' });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      logger.error(`[NotificationManager] Failed to save: ${err.message}`);
    }
  }

  _scheduleSave() {
    try { if (this._saveTimer) clearTimeout(this._saveTimer); } catch (_) {}
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveImmediate();
    }, this._saveDelay);
  }

  flush() {
    if (this._saveTimer) {
      try { clearTimeout(this._saveTimer); } catch (_) {}
      this._saveTimer = null;
    }
    this._saveImmediate();
  }

  /**
   * Create and store a notification for a user.
   * @param {string} username
   * @param {Object} payload
   * @returns {Object} saved notification
   */
  add(username, payload = {}) {
    const user = String(username || '').trim();
    if (!user) throw new Error('username required');

    const now = new Date().toISOString();
    const raw = {
      ...payload,
      title: payload.title || 'Notification',
      message: payload.message || '',
      notification_type: payload.notification_type || 'info',
      timestamp: payload.timestamp || now,
      session_id: payload.session_id || null,
      is_active: payload.is_active !== false,
      read: false
    };
    const n = normalizeNotificationRecord(raw);

    const list = this.store.get(user) || [];
    // Newest-first ordering
    list.unshift(n);
    // Apply retention: age-based and count-based
    const nowMs = Date.now();
    const pruned = list.filter(item => {
      try {
        const ts = new Date(item.timestamp).getTime();
        if (Number.isFinite(ts)) return (nowMs - ts) <= this._maxAgeMs;
      } catch (_) {}
      return true; // if malformed timestamp, keep (avoid accidental drops)
    }).slice(0, this._maxPerUser);
    this.store.set(user, pruned);
    this._scheduleSave();
    return n;
  }

  /**
   * Get notifications for a user.
   * @param {string} username
   */
  list(username) {
    const user = String(username || '').trim();
    if (!user) return [];
    return [...(this.store.get(user) || [])];
  }

  /**
   * Get a single notification by id for a user.
   * Returns a shallow copy or null when not found.
   * @param {string} username
   * @param {string} id
   */
  getById(username, id) {
    const user = String(username || '').trim();
    const targetId = String(id || '').trim();
    if (!user || !targetId) return null;
    const list = this.store.get(user);
    if (!list || list.length === 0) return null;
    const item = list.find((n) => n && n.id === targetId);
    return item ? { ...item } : null;
  }

  /**
   * Persist a response summary for an interactive notification.
   * Sets response and marks the notification as inactive.
   * Returns a shallow copy of the updated notification, or null when not found.
   * Does not overwrite an existing response.
   * @param {string} username
   * @param {string} id
   * @param {Object} response
   */
  setResponse(username, id, response) {
    const user = String(username || '').trim();
    const targetId = String(id || '').trim();
    if (!user || !targetId) return null;
    const list = this.store.get(user);
    if (!list || list.length === 0) return null;
    const idx = list.findIndex((n) => n && n.id === targetId);
    if (idx === -1) return null;

    const existing = list[idx];
    if (existing.response) {
      // Single-use semantics: do not overwrite an existing response
      return { ...existing };
    }

    const safeResponse = response && typeof response === 'object'
      ? {
          at: response.at,
          user: response.user,
          action_key: response.action_key,
          action_label: response.action_label ?? null,
          inputs: response.inputs || {},
          masked_input_ids: Array.isArray(response.masked_input_ids)
            ? response.masked_input_ids
            : []
        }
      : null;

    const updated = {
      ...existing,
      response: safeResponse,
      is_active: false
    };
    list[idx] = updated;
    this._scheduleSave();
    return { ...updated };
  }

  /**
   * Mark a notification as read for a user.
   * @param {string} username
   * @param {string} id
   * @returns {boolean}
   */
  markRead(username, id) {
    const user = String(username || '').trim();
    const list = this.store.get(user);
    if (!list) return false;
    const idx = list.findIndex((n) => n && n.id === id);
    if (idx === -1) return false;
    if (!list[idx].read) list[idx].read = true;
    this._scheduleSave();
    return true;
  }

  /**
   * Delete a notification for a user.
   * @param {string} username
   * @param {string} id
   * @returns {boolean}
   */
  delete(username, id) {
    const user = String(username || '').trim();
    const list = this.store.get(user);
    if (!list) return false;
    const before = list.length;
    const filtered = list.filter((n) => n && n.id !== id);
    this.store.set(user, filtered);
    const changed = filtered.length < before;
    if (changed) this._scheduleSave();
    return changed;
  }

  /**
   * Mark all notifications as read for a user.
   * @param {string} username
   * @returns {number} count of updated notifications
   */
  markAllRead(username) {
    const user = String(username || '').trim();
    const list = this.store.get(user);
    if (!list || list.length === 0) return 0;
    let updated = 0;
    for (const n of list) {
      if (n && !n.read) { n.read = true; updated++; }
    }
    if (updated > 0) this._scheduleSave();
    return updated;
  }

  /**
   * Delete all notifications for a user.
   * @param {string} username
   * @returns {number} number of deleted notifications
   */
  clearAll(username) {
    const user = String(username || '').trim();
    const list = this.store.get(user) || [];
    const count = list.length;
    this.store.set(user, []);
    if (count > 0) this._scheduleSave();
    return count;
  }
}

export default NotificationManager;
