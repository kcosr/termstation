/**
 * Session access control utilities.
 * Provides consistent authorization checks across HTTP routes and WebSocket handlers.
 */

import { config } from '../config-loader.js';

/**
 * Check if a user has manage_all_sessions permission.
 * @param {object|null} user - The user object (from req.user or extracted)
 * @returns {boolean}
 */
export function hasManageAllSessions(user) {
  return user?.permissions?.manage_all_sessions === true;
}

/**
 * Check if a session has private visibility.
 * @param {object|null} session - The session object
 * @returns {boolean}
 */
export function isPrivateSession(session) {
  return session?.visibility === 'private';
}

/**
 * Get username from a user object, falling back to default.
 * @param {object|null} user - The user object
 * @returns {string}
 */
export function getUsername(user) {
  return user?.username || config.DEFAULT_USERNAME;
}

/**
 * Check if a user can access a session.
 * - Admins with manage_all_sessions can access all sessions
 * - Private sessions are only accessible by their owner
 * - shared_readonly and public sessions are accessible by everyone
 *
 * @param {object|null} user - The user object (from req.user or extracted)
 * @param {object|null} session - The session to check access for
 * @returns {boolean}
 */
export function canAccessSession(user, session) {
  if (!session) return false;
  if (hasManageAllSessions(user)) return true;
  if (isPrivateSession(session)) {
    return String(session.created_by) === String(getUsername(user));
  }
  // shared_readonly and public are visible to all
  return true;
}

/**
 * Check if a request can access a session.
 * Convenience wrapper that extracts user from req.
 *
 * @param {object} req - Express request object
 * @param {object|null} session - The session to check access for
 * @returns {boolean}
 */
export function canAccessSessionFromRequest(req, session) {
  return canAccessSession(req?.user, session);
}
