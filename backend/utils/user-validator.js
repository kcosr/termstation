/**
 * User Validation Utilities
 * Validates system users and group memberships for Phase 2 authentication
 */

import * as child_process from 'child_process';
import { logger } from './logger.js';
import { resolveSystemUsername } from './username-alias.js';

/**
 * Check if a user exists on the system
 * @param {string} username - The username to check
 * @returns {boolean} - True if user exists
 */
export function systemUserExists(username) {
  try {
    const sysUser = resolveSystemUsername(username);
    // Use execFileSync to avoid shell interpolation vulnerabilities
    child_process.execFileSync('id', ['-u', String(sysUser)], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Check if a user is a member of a specific group
 * @param {string} username - The username to check
 * @param {string} groupname - The group to check membership for
 * @returns {boolean} - True if user is in the group
 */
export function userInGroup(username, groupname) {
  try {
    // Use execFileSync and parse output robustly across implementations
    const sysUser = resolveSystemUsername(username);
    const result = child_process.execFileSync('groups', [String(sysUser)], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
    const text = String(result || '').trim();
    const afterColon = text.includes(':') ? text.split(':').slice(1).join(':') : text; // handle both formats
    const userGroups = afterColon.trim().split(/\s+/).filter(Boolean);
    return userGroups.includes(String(groupname));
  } catch (error) {
    return false;
  }
}

/**
 * Validate if a user can access direct shell functionality
 * User must exist on system (web authentication already handled access control)
 * @param {string} username - The username to validate
 * @returns {Object} - Validation result with success boolean and message
 */
export function validateDirectShellUser(username) {
  if (!username || typeof username !== 'string' || username.trim() === '') {
    return {
      success: false,
      message: 'Username is required'
    };
  }

  const cleanUsername = username.trim();

  // Check if user exists on system
  if (!systemUserExists(cleanUsername)) {
    return {
      success: false,
      // Intentionally reference the presented username to avoid leaking any alias target
      message: `System user '${cleanUsername}' does not exist`
    };
  }

  return {
    success: true,
    message: `User '${cleanUsername}' is valid for direct shell access`
  };
}
