/**
 * Authentication middleware for HTTP Basic Auth
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config-loader.js';
import { createSessionToken, verifySessionToken, parseCookies, setSessionCookie, clearSessionCookie, authenticateRequestByCookie as utilCookieAuth } from '../utils/session-cookie.js';
import { verifyAccessToken as verifyTunnelToken } from '../utils/session-access-token.js';
import { resolveBooleanDomain } from '../utils/access-resolver.js';
import { FEATURE_KEYS, PERMISSION_KEYS, FEATURE_DEFAULTS, PERMISSION_DEFAULTS } from '../constants/access-keys.js';
import { usersConfigCache, groupsConfigCache } from '../utils/json-config-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load users from users.json
let users = [];
let groups = [];
// Canonical keys imported from constants


function loadUsers() {
  if (!config.AUTH_ENABLED) {
    logger.info('Authentication disabled in configuration');
    users = [];
    groups = [];
    return;
  }
  
  try {
    const rawUsers = usersConfigCache.get();
    users = Array.isArray(rawUsers) ? rawUsers : [];
    const withHashes = users.filter(u => typeof u?.password_hash === 'string');
    const withoutHashes = users.filter(u => !(typeof u?.password_hash === 'string' && u.password_hash.startsWith('pbkdf2$')));
    logger.info(`Loaded ${users.length} users for authentication (${withHashes.length} hashed)`);
    if (withoutHashes.length > 0) {
      logger.error(`Found ${withoutHashes.length} user(s) without valid password_hash; these users cannot authenticate until migrated.`);
    }
  } catch (error) {
    logger.error(`Failed to load users.json: ${error.message}`);
    users = [];
  }
  // Load groups
  try {
    const rawGroups = groupsConfigCache.get();
    const parsed = Array.isArray(rawGroups) ? rawGroups : [];
    if (Array.isArray(parsed)) {
      groups = parsed;
      logger.info(`Loaded ${groups.length} group definitions`);
    } else {
      groups = [];
    }
  } catch (error) {
    // groups are optional; default to none
    logger.warning(`No groups loaded or invalid groups.json: ${error.message}`);
    groups = [];
  }

  // Canonical indices are embedded above; nothing to load.
}

// Convenience helper for runtime lookups: always read latest users/groups
function loadUsersAndGroups() {
  try {
    const usersListRaw = usersConfigCache.get();
    const groupsListRaw = groupsConfigCache.get();
    const usersList = Array.isArray(usersListRaw) ? usersListRaw : [];
    const groupsList = Array.isArray(groupsListRaw) ? groupsListRaw : [];
    return {
      users: usersList,
      groups: groupsList
    };
  } catch (_) {
    return { users: [], groups: [] };
  }
}

// Load users on module initialization (for startup validation and logging)
loadUsers();

function coalescePermissionsObject(obj) {
  try { return (obj && typeof obj === 'object') ? obj : {}; } catch (_) { return {}; }
}

function resolveUserProfile(u, groupDefsOverride = null) {
  const username = String(u?.username || '').trim();
  const userGroups = Array.isArray(u?.groups) ? u.groups.map(g => String(g || '').trim()).filter(Boolean) : [];
  const out = {
    username,
    groups: userGroups,
    permissions: {},
    features: {},
    prompt_for_reset: !!u?.prompt_for_reset
  };
  // Build group inputs in order
  const groupFeatureInputs = [];
  const groupPermissionInputs = [];
  const sourceGroups = Array.isArray(groupDefsOverride) ? groupDefsOverride : groups || [];
  for (const gname of userGroups) {
    try {
      const g = sourceGroups.find(gg => gg && String(gg.name) === gname);
      if (!g) continue;
      if (g?.features != null) groupFeatureInputs.push(g.features);
      if (g?.permissions != null) groupPermissionInputs.push(g.permissions);
    } catch (_) {}
  }

  // Resolve via shared boolean-domain resolver
  try { out.features = resolveBooleanDomain({ keys: FEATURE_KEYS, groupInputs: groupFeatureInputs, userInput: u?.features, defaults: FEATURE_DEFAULTS }); } catch (_) {}
  try { out.permissions = resolveBooleanDomain({ keys: PERMISSION_KEYS, groupInputs: groupPermissionInputs, userInput: u?.permissions, defaults: PERMISSION_DEFAULTS }); } catch (_) {}

  return out;
}

/**
 * HTTP Basic Auth middleware
 */
export function basicAuth(req, res, next) {
  // Allow short-lived token authentication on any API route.
  // Accept token via query parameter `token` or header `x-session-token`.
  try {
    const tokenParam = (req.query && (req.query.token || req.query.Token || req.query.TOKEN)) || null;
    const tokenHeader = req.headers && (req.headers['x-session-token'] || req.headers['x-token']);
    const token = (typeof tokenHeader === 'string' && tokenHeader.trim()) ? tokenHeader.trim() : (typeof tokenParam === 'string' ? tokenParam : null);
    if (token) {
      const ver = verifyTunnelToken(token);
      if (ver && ver.ok && ver.payload && ver.payload.session_id) {
        // Resolve session owner as acting user, require an ACTIVE session (not terminated)
        let session = null;
        try { session = global.sessionManager?.getSession(ver.payload.session_id); } catch (_) { session = null; }
        if (session && session.is_active && session.created_by) {
          const username = String(session.created_by).trim();
          // Load full profile (groups, features, permissions) for the session owner
          try {
            if (config.AUTH_ENABLED) {
              const { users: runtimeUsers, groups: runtimeGroups } = loadUsersAndGroups();
              const userDef = (runtimeUsers || []).find((u) => u && String(u.username) === username);
              if (userDef) {
                const resolved = resolveUserProfile(userDef, runtimeGroups);
                req.user = { ...resolved };
              } else {
                // Fallback minimal profile when user record missing
                req.user = { username, groups: [], permissions: {}, features: {}, prompt_for_reset: false };
              }
            } else {
              // When auth is disabled, attach a minimal profile
              req.user = { username, groups: [], permissions: {}, features: {}, prompt_for_reset: false };
            }
          } catch (_) {
            // On any failure, proceed with a minimal profile
            req.user = { username, groups: [], permissions: {}, features: {}, prompt_for_reset: false };
          }
          return next();
        }
      }
    }
  } catch (_) { /* fall through to cookie/basic */ }

  // When authentication is disabled, behave as if authenticated as DEFAULT_USERNAME (or provided Basic user)
  // Load full profile (groups, features, permissions) from users.json/groups.json so RBAC applies consistently.
  if (!config.AUTH_ENABLED) {
    const authHeader = req.headers.authorization;
    let username = config.DEFAULT_USERNAME;
    // Allow overriding via Basic header to impersonate an existing user during local dev
    if (authHeader && authHeader.startsWith('Basic ')) {
      try {
        const base64Credentials = authHeader.substring(6);
        const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
        const [extractedUsername] = credentials.split(':');
        if (extractedUsername && extractedUsername.trim()) username = extractedUsername.trim();
      } catch (error) {
        logger.warning(`Failed to extract username when auth disabled: ${error.message}`);
      }
    }

    try {
      // Load users/groups directly (do not rely on loadUsers which skips when AUTH is disabled)
      const usersListRaw = usersConfigCache.get();
      const groupsListRaw = groupsConfigCache.get();
      const usersList = Array.isArray(usersListRaw) ? usersListRaw : [];
      const groupsList = Array.isArray(groupsListRaw) ? groupsListRaw : [];
      const userDef = (usersList || []).find(u => u && String(u.username) === String(username));
      if (userDef) {
        // Resolve features/permissions via group+user inputs
        const userGroups = Array.isArray(userDef.groups) ? userDef.groups.map(g => String(g || '').trim()).filter(Boolean) : [];
        const groupFeatureInputs = [];
        const groupPermissionInputs = [];
        for (const gname of userGroups) {
          try {
            const g = (groupsList || []).find(gg => gg && String(gg.name) === gname);
            if (!g) continue;
            if (g.features != null) groupFeatureInputs.push(g.features);
            if (g.permissions != null) groupPermissionInputs.push(g.permissions);
          } catch (_) {}
        }
        const features = resolveBooleanDomain({ keys: FEATURE_KEYS, groupInputs: groupFeatureInputs, userInput: userDef.features, defaults: FEATURE_DEFAULTS });
        const permissions = resolveBooleanDomain({ keys: PERMISSION_KEYS, groupInputs: groupPermissionInputs, userInput: userDef.permissions, defaults: PERMISSION_DEFAULTS });
        req.user = { username, groups: userGroups, features, permissions, prompt_for_reset: !!userDef.prompt_for_reset };
      } else {
        // Fallback minimal profile when DEFAULT_USERNAME is not present in users.json
        req.user = { username, groups: [], permissions: {}, features: {}, prompt_for_reset: false };
      }
    } catch (e) {
      // If config files not available, proceed with a minimal default user
      req.user = { username, groups: [], permissions: {}, features: {}, prompt_for_reset: false };
    }

    logger.info(`Auth disabled: acting as user '${req.user.username}' (groups=${(req.user.groups||[]).join(',')}) for ${req.method} ${req.path}`);
    return next();
  }
  
  // First, try session cookie authentication (using shared helper)
  try {
    const ver = utilCookieAuth(req);
    if (ver && ver.ok && ver.username) {
      const { users: runtimeUsers, groups: runtimeGroups } = loadUsersAndGroups();
      const u = (runtimeUsers || []).find(usr => usr && usr.username === ver.username);
      if (u) {
        const resolved = resolveUserProfile(u, runtimeGroups);
        req.user = { ...resolved };
        try { const t = createSessionToken(u); setSessionCookie(res, t, req); } catch (_) {}
        logger.debug(`Cookie authentication successful for ${req.method} ${req.path}: user '${u.username}'`);
        return next();
      }
    }
  } catch (_) {}

  const authHeader = req.headers.authorization;
  
  const noPrompt = String(req.headers['x-no-auth-prompt'] || '').trim() === '1';
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    logger.warning(`Authentication failed for ${req.method} ${req.path}: No Basic auth header provided`);
    if (!noPrompt) res.set('WWW-Authenticate', 'Basic realm="termstation"');
    res.status(401).json({
      error: 'Authentication required',
      message: 'Please provide valid credentials'
    });
    return;
  }

  try {
    // Extract and decode Base64 credentials
    const base64Credentials = authHeader.substring(6); // Remove 'Basic '
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    if (!username || !password) {
      logger.warning(`Authentication failed for ${req.method} ${req.path}: Invalid credentials format`);
      if (!noPrompt) res.set('WWW-Authenticate', 'Basic realm="termstation"');
      res.status(401).json({
        error: 'Invalid credentials format',
        message: 'Please provide valid username and password'
      });
      return;
    }

    // Check credentials against users.json (hashed preferred; plaintext supported for backward compatibility)
    const { users: runtimeUsers, groups: runtimeGroups } = loadUsersAndGroups();
    const user = (runtimeUsers || []).find(u => u && u.username === username);
    
    if (!user) {
      logger.warning(`Authentication failed for ${req.method} ${req.path}: Invalid username '${username}'`);
      if (!noPrompt) res.set('WWW-Authenticate', 'Basic realm="termstation"');
      res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid username or password'
      });
      return;
    }

    // Verify password
    if (!verifyPassword(user, password)) {
      logger.warning(`Authentication failed for ${req.method} ${req.path}: Invalid password for user '${username}'`);
      if (!noPrompt) res.set('WWW-Authenticate', 'Basic realm="termstation"');
      res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid username or password'
      });
      return;
    }

    // Add user info to request for use in routes
    const resolved = resolveUserProfile(user, runtimeGroups);
    req.user = { ...resolved };
    // Issue session cookie so subsequent requests and WebSocket can authenticate without resending Basic
    try {
      const token = createSessionToken(user);
      setSessionCookie(res, token, req);
    } catch (_) {}
    logger.info(`Authentication successful for ${req.method} ${req.path}: user '${username}'`);
    next();
    
  } catch (error) {
    logger.error(`Authentication error for ${req.method} ${req.path}: ${error.message}`);
    res.status(500).json({
      error: 'Authentication error',
      message: 'Internal server error during authentication'
    });
  }
}


/**
 * Reload users from users.json
 */
export function reloadUsers() {
  try { usersConfigCache.reloadNow(); } catch (_) {}
  try { groupsConfigCache.reloadNow(); } catch (_) {}
  loadUsers();
}

/**
 * Validate user credentials
 */
export function appUserExists(username) {
  try {
    if (!username) return false;
    const u = String(username).trim();
    if (!u) return false;
    const listRaw = usersConfigCache.get();
    const list = Array.isArray(listRaw) ? listRaw : [];
    return Array.isArray(list) && list.some((usr) => usr && String(usr.username) === u);
  } catch (_) { return false; }
}

// Export a helper to extract cookie-authenticated username (for WebSocket)
export function authenticateRequestByCookie(req) { return utilCookieAuth(req); }

/**
 * Verify a supplied password against a user record supporting hashed or plaintext.
 * Supports:
 *  - password_hash formatted as: "pbkdf2$<iterations>$<salt_hex>$<hash_hex>"
 *  - password (plaintext) for backward compatibility
 */
export function verifyPassword(user, suppliedPassword) {
  try {
    if (!user) return false;
    if (typeof user.password_hash !== 'string' || !user.password_hash.startsWith('pbkdf2$')) {
      // No valid hash present; user cannot authenticate
      return false;
    }
    const parts = user.password_hash.split('$');
    if (parts.length !== 4) return false;
    const iter = parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    if (!Number.isFinite(iter) || iter <= 0 || salt.length === 0 || expected.length === 0) return false;
    const derived = crypto.pbkdf2Sync(String(suppliedPassword), salt, iter, expected.length, 'sha256');
    // constant time compare
    return crypto.timingSafeEqual(derived, expected);
  } catch (_) {
    return false;
  }
}

// ---- helpers ----
// No external indices are loaded; canonical keys live in this file.
