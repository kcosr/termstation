/**
 * Shared JSON config cache helper.
 *
 * Responsibilities:
 * - Resolve config path via resolveConfigPath(name) or an explicit filePath
 * - Maintain an in-memory cache of parsed JSON and last-known mtime
 * - Watch the file with fs.watch and debounced reload
 * - Provide a minimal mtime-based fallback reload on get()
 * - Preserve last-known-good value on parse errors
 *
 * Public API:
 * - get()        → returns current cached value (never throws)
 * - reloadNow()  → synchronous reload, returns { ok, value, mtime, error }
 * - getMeta()    → returns { mtime, lastReloadTime, version, lastError }
 * - cleanup()    → close watcher and timers (used in tests/shutdown)
 */

import { watch, statSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { dirname } from 'path';
import { resolveConfigPath, loadJsonAt, config, USERS_STATE_FILE, GROUPS_STATE_FILE } from '../config-loader.js';
import { logger } from './logger.js';

export class JsonConfigCache {
  constructor(name, options = {}) {
    this.name = String(name || '');
    this.defaultValue = options.defaultValue;
    this.label = options.label || this.name;
    this.filePath = options.filePath || resolveConfigPath(this.name);
    this.minReloadIntervalMs = Number.isFinite(options.minReloadIntervalMs)
      ? options.minReloadIntervalMs
      : 1000;

    this.value = this.defaultValue;
    this.lastMtime = null;
    this.lastReloadTime = 0;
    this.version = 0;
    this.lastError = null;

    this.fileWatcher = null;
    this.reloadDebounceTimeout = null;
    this._initialized = false;
  }

  _logDebug(message) {
    try {
      logger.debug?.(`[ConfigCache:${this.label}] ${message}`);
    } catch (_) {
      // logger may not implement debug; ignore
    }
  }

  _updateValue(newValue, mtime, reason) {
    this.value = newValue;
    this.lastMtime = mtime || this.lastMtime;
    this.lastReloadTime = Date.now();
    this.version += 1;
    this.lastError = null;
    const mtimeIso = this.lastMtime && typeof this.lastMtime.toISOString === 'function'
      ? this.lastMtime.toISOString()
      : String(this.lastMtime || '');
    logger.info(`[ConfigCache:${this.label}] Reloaded (${reason}); mtime=${mtimeIso}`);
  }

  _reloadFromDisk(reason) {
    const filePath = this.filePath;
    try {
      const stats = statSync(filePath);
      const mtime = stats.mtime;

      // Skip only when mtime regresses (clock skew or unusual FS behavior).
      // Equal mtimes still trigger a reload so we don't miss atomic rewrites
      // that keep the same timestamp.
      if (this.lastMtime && mtime < this.lastMtime && reason !== 'initial') {
        this._logDebug(`Skipping reload (${reason}); mtime unchanged`);
        return {
          ok: true,
          skipped: true,
          value: this.value,
          mtime: this.lastMtime,
          error: null
        };
      }

      const data = loadJsonAt(filePath);
      this._updateValue(data, mtime, reason);
      return {
        ok: true,
        skipped: false,
        value: this.value,
        mtime: this.lastMtime,
        error: null
      };
    } catch (e) {
      this.lastError = e;
      const code = e && e.code ? String(e.code) : '';
      if (code === 'ENOENT') {
        logger.error(`[ConfigCache:${this.label}] File not found at ${filePath}: ${e.message}`);
      } else {
        logger.error(`[ConfigCache:${this.label}] Failed to reload (${reason}): ${e.message}`);
      }
      // Preserve last-known-good value and mtime
      return {
        ok: false,
        skipped: false,
        value: this.value,
        mtime: this.lastMtime,
        error: e
      };
    }
  }

  _ensureInitialized() {
    if (this._initialized) return;
    this._initialized = true;
    this._reloadFromDisk('initial');
    this._setupWatcher();
  }

  _setupWatcher() {
    try {
      this.fileWatcher = watch(this.filePath, (eventType) => {
        if (eventType !== 'change' && eventType !== 'rename') {
          return;
        }
        // Debounce rapid editor writes
        if (this.reloadDebounceTimeout) {
          clearTimeout(this.reloadDebounceTimeout);
        }
        this.reloadDebounceTimeout = setTimeout(() => {
          this._reloadFromDisk('watch');
        }, 400);
      });
      logger.info(`[ConfigCache:${this.label}] File watcher enabled`);
    } catch (e) {
      logger.error(`[ConfigCache:${this.label}] Error setting up file watcher: ${e.message}`);
      // Continue without watcher; mtime fallback in get() still applies.
    }
  }

  _checkMtimeAndReloadIfStale() {
    try {
      const stats = statSync(this.filePath);
      const mtime = stats.mtime;
      if (!this.lastMtime || mtime > this.lastMtime) {
        const now = Date.now();
        if (now - this.lastReloadTime >= this.minReloadIntervalMs) {
          return this._reloadFromDisk('stat');
        }
      }
    } catch (e) {
      this.lastError = e;
      logger.error(`[ConfigCache:${this.label}] Error during mtime check: ${e.message}`);
    }
    return {
      ok: true,
      skipped: true,
      value: this.value,
      mtime: this.lastMtime,
      error: null
    };
  }

  /**
   * Get the current cached value.
   * Never throws; returns default or last-known-good value on failure.
   */
  get() {
    this._ensureInitialized();
    this._checkMtimeAndReloadIfStale();
    return this.value;
  }

  /**
   * Force an immediate reload from disk.
   * Returns an object with { ok, value, mtime, error }.
   */
  reloadNow() {
    this._ensureInitialized();
    return this._reloadFromDisk('manual');
  }

  /**
   * Return metadata about the cache.
   */
  getMeta() {
    return {
      mtime: this.lastMtime,
      lastReloadTime: this.lastReloadTime,
      version: this.version,
      lastError: this.lastError
    };
  }

  /**
   * Cleanup watcher and timers. Primarily used by tests/shutdown.
   */
  cleanup() {
    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch (_) {}
      this.fileWatcher = null;
    }
    if (this.reloadDebounceTimeout) {
      clearTimeout(this.reloadDebounceTimeout);
      this.reloadDebounceTimeout = null;
    }
  }
}

function ensureIdentityStateFile(kind, stateFile, configFile) {
  try {
    mkdirSync(config.DATA_DIR, { recursive: true });
  } catch (_) {}
  const hasState = existsSync(stateFile);
  const hasConfig = existsSync(configFile);
  if (hasState) {
    if (hasConfig) {
      logger.warning(`[IdentityConfig:${kind}] Using state file at ${stateFile}; ignoring config file at ${configFile}`);
    }
    return;
  }
  if (hasConfig) {
    try {
      const dir = dirname(stateFile);
      mkdirSync(dir, { recursive: true });
    } catch (_) {}
    try {
      copyFileSync(configFile, stateFile);
      logger.info(`[IdentityConfig:${kind}] Seeded state file from config: ${configFile} -> ${stateFile}`);
    } catch (e) {
      logger.error(`[IdentityConfig:${kind}] Failed to seed state file from config (${configFile} -> ${stateFile}): ${e.message}`);
    }
    return;
  }
  try {
    const dir = dirname(stateFile);
    mkdirSync(dir, { recursive: true });
  } catch (_) {}
  try {
    let content;
    if (kind === 'users') {
      content = [
        {
          username: 'admin',
          groups: ['admins']
        }
      ];
    } else if (kind === 'groups') {
      content = [
        {
          name: 'admins',
          permissions: '*',
          features: '*'
        }
      ];
    } else {
      content = [];
    }
    const json = JSON.stringify(content, null, 2);
    const payload = json.endsWith('\n') ? json : `${json}\n`;
    writeFileSync(stateFile, payload, 'utf8');
    logger.info(`[IdentityConfig:${kind}] Created default state file at ${stateFile}`);
  } catch (e) {
    logger.error(`[IdentityConfig:${kind}] Failed to create default state file at ${stateFile}: ${e.message}`);
  }
}

// Ensure identity state files exist in the backend data directory and, when present,
// copy legacy config files once into place.
ensureIdentityStateFile('users', USERS_STATE_FILE, resolveConfigPath('users.json'));
ensureIdentityStateFile('groups', GROUPS_STATE_FILE, resolveConfigPath('groups.json'));

// Shared caches for core JSON configs
export const templatesConfigCache = new JsonConfigCache('templates.json', {
  defaultValue: { templates: [] },
  label: 'templates.json'
});

export const usersConfigCache = new JsonConfigCache('users.json', {
  defaultValue: [],
  label: 'users.json',
  filePath: USERS_STATE_FILE
});

export const groupsConfigCache = new JsonConfigCache('groups.json', {
  defaultValue: [],
  label: 'groups.json',
  filePath: GROUPS_STATE_FILE
});

export const linksConfigCache = new JsonConfigCache('links.json', {
  defaultValue: { groups: [] },
  label: 'links.json'
});
