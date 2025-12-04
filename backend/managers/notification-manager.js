/**
 * Notification Manager
 * Per-user notification store with disk persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config-loader.js';
import { logger } from '../utils/logger.js';

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
      return arr.map((n) => ({
        id: String(n?.id || genId()),
        title: String(n?.title || 'Notification'),
        message: String(n?.message || ''),
        notification_type: String(n?.notification_type || 'info'),
        timestamp: n?.timestamp || new Date().toISOString(),
        session_id: n?.session_id || null,
        is_active: n?.is_active !== false,
        read: !!n?.read,
      }));
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
    const n = {
      id: genId(),
      title: payload.title || 'Notification',
      message: payload.message || '',
      notification_type: payload.notification_type || 'info',
      timestamp: payload.timestamp || now,
      session_id: payload.session_id || null,
      is_active: payload.is_active !== false, // default true unless explicitly false
      read: false,
    };

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
