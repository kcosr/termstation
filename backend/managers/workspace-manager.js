/**
 * Workspace Manager
 * Provides simple persistent storage for named workspaces
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';
import { config } from '../config-loader.js';

export class WorkspaceManager {
  constructor() {
    this.dataDir = config.DATA_DIR;
    this.workspacesFile = path.join(this.dataDir, 'workspaces.json');
    // Map of username -> Map(name -> meta)
    this.userWorkspaces = new Map();
    // Seed list used for first-time users when legacy global format is present
    this._legacySeed = [];
    this._initialized = false;
    this._init();
  }

  _init() {
    try {
      // Ensure data directory exists for workspace metadata
      fs.mkdirSync(this.dataDir, { recursive: true });

      // Try to load existing workspaces file
      if (fs.existsSync(this.workspacesFile)) {
        const data = JSON.parse(fs.readFileSync(this.workspacesFile, 'utf8'));
        if (data && data.users && typeof data.users === 'object') {
          // New per-user format
          for (const [username, payload] of Object.entries(data.users)) {
            const entries = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
            const map = new Map();
            // Always include Default in-memory
            map.set('Default', { pinned: false, note: '', note_version: 0, note_updated_at: null, note_updated_by: null });
            for (const w of entries) {
              if (!w || !w.name) continue;
              const trimmed = String(w.name).trim();
              if (!trimmed) continue;
              const meta = {
                pinned: !!w.pinned,
                note: typeof w.note === 'string' ? w.note : '',
                note_version: Number.isInteger(w.note_version) && w.note_version >= 0 ? w.note_version : 0,
                note_updated_at: w.note_updated_at || null,
                note_updated_by: w.note_updated_by || null
              };
              // Do not duplicate implicit Default unless explicitly stored (e.g., for notes)
              if (trimmed.toLowerCase() === 'default') {
                // Merge metadata onto Default entry
                const d = map.get('Default') || {};
                map.set('Default', { ...d, ...meta });
              } else {
                map.set(trimmed, meta);
              }
            }
            this.userWorkspaces.set(username, map);
          }
        } else {
          // Legacy format: global array
          const entries = Array.isArray(data)
            ? data.map(n => ({ name: String(n), pinned: false }))
            : Array.isArray(data?.workspaces)
              ? data.workspaces.map(w => (typeof w === 'string' ? { name: w, pinned: false } : { name: String(w.name), pinned: !!w.pinned }))
              : [];
          // Store as seed for new users
          this._legacySeed = entries
            .map(w => ({ name: String(w.name || '').trim(), pinned: !!w.pinned }))
            .filter(w => w.name && w.name.toLowerCase() !== 'default');
        }
      }
      this._initialized = true;
      logger.info(`[WorkspaceManager] Initialized (per-user). Users loaded: ${this.userWorkspaces.size}`);
    } catch (err) {
      logger.error(`[WorkspaceManager] Failed to initialize: ${err.message}`);
      // Keep in-memory default set
    }
  }

  _save() {
    try {
      const users = {};
      for (const [username, map] of this.userWorkspaces.entries()) {
        const list = [];
        for (const [name, meta] of map.entries()) {
          // Persist Default only when it has meaningful metadata (pinned or note)
          const isDefault = String(name).toLowerCase() === 'default';
          const hasMeaning = !!meta?.pinned || (typeof meta?.note === 'string' && meta.note.trim().length > 0) || (Number.isInteger(meta?.note_version) && meta.note_version > 0);
          if (!isDefault || hasMeaning) {
            list.push({
              name,
              pinned: !!meta.pinned,
              note: typeof meta.note === 'string' ? meta.note : '',
              note_version: Number.isInteger(meta.note_version) ? meta.note_version : 0,
              note_updated_at: meta.note_updated_at || null,
              note_updated_by: meta.note_updated_by || null
            });
          }
        }
        users[username] = { workspaces: list };
      }
      const data = { users };
      const tmp = `${this.workspacesFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: 'w' });
      fs.renameSync(tmp, this.workspacesFile);
    } catch (err) {
      logger.error(`[WorkspaceManager] Failed to save workspaces: ${err.message}`);
      throw err;
    }
  }

  // Ensure a user map exists and seeded
  _ensureUser(username) {
    const u = (username || '').trim() || 'anonymous';
    if (!this.userWorkspaces.has(u)) {
      const map = new Map();
      // Always include Default
      map.set('Default', { pinned: false, note: '', note_version: 0, note_updated_at: null, note_updated_by: null });
      // Seed from legacy global if present
      for (const w of this._legacySeed) {
        const nm = String(w.name || '').trim();
        if (nm && nm.toLowerCase() !== 'default') {
          map.set(nm, { pinned: !!w.pinned, note: '', note_version: 0, note_updated_at: null, note_updated_by: null });
        }
      }
      this.userWorkspaces.set(u, map);
      // Persist creation for first user entry
      try { this._save(); } catch (_) {}
    }
    return this.userWorkspaces.get(u);
  }

  getAllForUser(username) {
    const map = this._ensureUser(username);
    return Array.from(map.entries()).map(([name, meta]) => ({ name, pinned: !!meta.pinned, note: meta.note || '', note_version: Number.isInteger(meta.note_version) ? meta.note_version : 0, note_updated_at: meta.note_updated_at || null, note_updated_by: meta.note_updated_by || null }));
  }

  addForUser(username, name) {
    const map = this._ensureUser(username);
    const trimmed = (name || '').trim();
    if (!trimmed) {
      const e = new Error('Workspace name is required');
      e.code = 'INVALID_NAME';
      throw e;
    }
    if (trimmed.toLowerCase() === 'default') {
      const e = new Error('Use Default implicitly; no need to add');
      e.code = 'INVALID_NAME';
      throw e;
    }
    if (map.has(trimmed)) {
      const e = new Error('Workspace already exists');
      e.code = 'ALREADY_EXISTS';
      throw e;
    }
    map.set(trimmed, { pinned: false, note: '', note_version: 0, note_updated_at: null, note_updated_by: null });
    this._save();
    logger.info(`[WorkspaceManager] Added workspace '${trimmed}' for user '${username}'`);
    return trimmed;
  }

  renameForUser(username, oldName, newName) {
    const map = this._ensureUser(username);
    const from = (oldName || '').trim();
    const to = (newName || '').trim();
    if (!from) {
      const e = new Error('Old name required');
      e.code = 'INVALID_NAME';
      throw e;
    }
    if (!to) {
      const e = new Error('New name required');
      e.code = 'INVALID_NAME';
      throw e;
    }
    if (from.toLowerCase() === 'default') {
      const e = new Error('Cannot rename Default');
      e.code = 'FORBIDDEN';
      throw e;
    }
    if (to.toLowerCase() === 'default') {
      const e = new Error('Cannot rename to Default');
      e.code = 'INVALID_NAME';
      throw e;
    }
    if (!map.has(from)) {
      const e = new Error('Workspace not found');
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (map.has(to)) {
      const e = new Error('Target name already exists');
      e.code = 'ALREADY_EXISTS';
      throw e;
    }
    const meta = map.get(from) || { pinned: false, note: '', note_version: 0, note_updated_at: null, note_updated_by: null };
    map.delete(from);
    map.set(to, meta);
    this._save();
    logger.info(`[WorkspaceManager] Renamed workspace '${from}' -> '${to}' for user '${username}'`);
    return to;
  }

  removeForUser(username, name) {
    const map = this._ensureUser(username);
    const trimmed = (name || '').trim();
    if (!trimmed) {
      const e = new Error('Workspace name required');
      e.code = 'INVALID_NAME';
      throw e;
    }
    if (trimmed.toLowerCase() === 'default') {
      const e = new Error('Cannot delete Default workspace');
      e.code = 'FORBIDDEN';
      throw e;
    }
    if (!map.has(trimmed)) {
      const e = new Error('Workspace not found');
      e.code = 'NOT_FOUND';
      throw e;
    }
    map.delete(trimmed);
    this._save();
    logger.info(`[WorkspaceManager] Deleted workspace '${trimmed}' for user '${username}'`);
    return true;
  }

  setPinnedForUser(username, name, pinned) {
    const map = this._ensureUser(username);
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed.toLowerCase() === 'default') {
      const e = new Error('Cannot change pin for Default or invalid name');
      e.code = 'FORBIDDEN';
      throw e;
    }
    const meta = map.get(trimmed);
    if (!meta) {
      const e = new Error('Workspace not found');
      e.code = 'NOT_FOUND';
      throw e;
    }
    meta.pinned = !!pinned;
    map.set(trimmed, meta);
    this._save();
    logger.info(`[WorkspaceManager] ${pinned ? 'Pinned' : 'Unpinned'} workspace '${trimmed}' for user '${username}'`);
    return { name: trimmed, pinned: meta.pinned };
  }

  setOrderForUser(username, orderNames) {
    const map = this._ensureUser(username);
    if (!Array.isArray(orderNames) || orderNames.length === 0) {
      const e = new Error('Order must be a non-empty array');
      e.code = 'INVALID_ORDER';
      throw e;
    }
    const normalized = orderNames.map(n => String(n || '').trim()).filter(Boolean);
    // Validate same set of names
    const currentNames = new Set(map.keys());
    const incoming = new Set(normalized);
    if (currentNames.size !== incoming.size) {
      const e = new Error('Order list must include all workspaces exactly once');
      e.code = 'INVALID_ORDER';
      throw e;
    }
    for (const name of currentNames) {
      if (!incoming.has(name)) {
        const e = new Error(`Missing workspace in order: ${name}`);
        e.code = 'INVALID_ORDER';
        throw e;
      }
    }
    // Rebuild map in new order
    const newMap = new Map();
    for (const name of normalized) {
      const meta = map.get(name);
      newMap.set(name, meta || { pinned: false });
    }
    this.userWorkspaces.set((username || '').trim() || 'anonymous', newMap);
    this._save();
    logger.info(`[WorkspaceManager] Reordered workspaces for user '${username}'`);
    return this.getAllForUser(username);
  }

  // Workspace notes API
  getNoteSnapshotForUser(username, name) {
    const map = this._ensureUser(username);
    const ws = (name || '').trim() || 'Default';
    const meta = map.get(ws) || { pinned: false, note: '', note_version: 0, note_updated_at: null, note_updated_by: null };
    return {
      content: typeof meta.note === 'string' ? meta.note : '',
      version: Number.isInteger(meta.note_version) ? meta.note_version : 0,
      updated_at: meta.note_updated_at || null,
      updated_by: meta.note_updated_by || null,
      name: ws
    };
  }

  updateNoteForUser(username, name, content, options = {}) {
    const map = this._ensureUser(username);
    const ws = (name || '').trim() || 'Default';
    if (!map.has(ws)) {
      // If updating Default or a new workspace, ensure existence (except Default implicit)
      if (ws.toLowerCase() === 'default') {
        map.set('Default', { pinned: false, note: '', note_version: 0, note_updated_at: null, note_updated_by: null });
      } else {
        map.set(ws, { pinned: false, note: '', note_version: 0, note_updated_at: null, note_updated_by: null });
      }
    }
    const meta = map.get(ws);
    const expected = Number.isInteger(options.expectedVersion) ? options.expectedVersion : meta.note_version;
    const current = Number.isInteger(meta.note_version) ? meta.note_version : 0;
    if (expected !== current) {
      const err = new Error('Workspace note version conflict');
      err.code = 'NOTE_VERSION_CONFLICT';
      err.context = { latest: this.getNoteSnapshotForUser(username, ws) };
      throw err;
    }
    meta.note = typeof content === 'string' ? content : '';
    meta.note_version = current + 1;
    meta.note_updated_at = new Date().toISOString();
    if (options && typeof options.updatedBy === 'string') meta.note_updated_by = options.updatedBy;
    map.set(ws, meta);
    this._save();
    return this.getNoteSnapshotForUser(username, ws);
  }
}

// Export singleton instance
export const workspaceManager = new WorkspaceManager();
