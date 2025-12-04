/**
 * Username alias resolution utilities
 * Maps a presented username to an underlying system account when needed.
 */

import { config } from '../config-loader.js';

/**
 * Resolve the system username to use for OS-level operations
 * (e.g., sudo -u, id/groups). Falls back to the provided username if no alias exists.
 * @param {string} username
 * @returns {string}
 */
export function resolveSystemUsername(username) {
  try {
    const u = String(username || '').trim();
    if (!u) return u;
    const map = (config && config.USERNAME_ALIASES) || {};
    const alias = map[u];
    return (typeof alias === 'string' && alias.trim()) ? alias.trim() : u;
  } catch (_) {
    return String(username || '').trim();
  }
}

