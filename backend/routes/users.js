import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import { usersConfigCache } from '../utils/json-config-cache.js';
import { config, USERS_STATE_FILE } from '../config-loader.js';
import { verifyPassword } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

export const router = express.Router();

// Return the authenticated user's resolved profile (username, groups, permissions, features, prompt_for_reset)
router.get('/me', (req, res) => {
  try {
    const u = req.user || {};
    // Only expose the structured fields; omit any compatibility flags
    const payload = {
      username: u.username || '',
      groups: Array.isArray(u.groups) ? u.groups : [],
      permissions: (u.permissions && typeof u.permissions === 'object') ? u.permissions : {},
      features: (u.features && typeof u.features === 'object') ? u.features : {},
      prompt_for_reset: !!u.prompt_for_reset
    };
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load user profile' });
  }
});

// Allow a logged-in user to reset their own password.
// Gated by feature flag `password_reset_enabled` on the resolved user profile.
// Requires current credentials via Basic Auth header; cookies alone are not sufficient.
router.post('/reset-password', (req, res) => {
  try {
    const user = req.user || {};
    const features = (user && user.features) || {};
    const enabled = features.password_reset_enabled === true;
    if (!config.AUTH_ENABLED) {
      return res.status(400).json({
        error: 'AUTH_DISABLED',
        message: 'Password reset is not available when authentication is disabled'
      });
    }
    if (!enabled) {
      return res.status(403).json({
        error: 'FEATURE_DISABLED',
        message: 'Password reset is disabled for this user'
      });
    }

    const authHeader = String(req.headers.authorization || req.headers.Authorization || '').trim();
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return res.status(400).json({
        error: 'BASIC_AUTH_REQUIRED',
        message: 'Password reset requires current credentials via Basic authentication'
      });
    }

    let basicUsername = '';
    let oldPassword = '';
    try {
      const base64Credentials = authHeader.substring(6);
      const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
      const parts = credentials.split(':');
      basicUsername = (parts[0] || '').trim();
      oldPassword = (parts[1] || '').trim();
    } catch (_) {
      basicUsername = '';
      oldPassword = '';
    }
    if (!basicUsername || !oldPassword) {
      return res.status(400).json({
        error: 'INVALID_BASIC_AUTH',
        message: 'Current username and password are required'
      });
    }

    const effectiveUsername = typeof user.username === 'string' ? String(user.username).trim() : '';
    if (effectiveUsername && basicUsername !== effectiveUsername) {
      return res.status(403).json({
        error: 'USERNAME_MISMATCH',
        message: 'Password reset is only allowed for the currently authenticated user'
      });
    }

    const body = req.body || {};
    const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
    if (!newPassword || !newPassword.trim()) {
      return res.status(400).json({
        error: 'INVALID_NEW_PASSWORD',
        message: 'New password must be provided'
      });
    }

    // Load latest users from config cache
    let usersListRaw;
    try {
      usersListRaw = usersConfigCache.get();
    } catch (_) {
      usersListRaw = [];
    }
    const usersList = Array.isArray(usersListRaw) ? usersListRaw.slice() : [];
    const idx = usersList.findIndex((u) => u && String(u.username) === basicUsername);
    if (idx === -1) {
      logger.warning(`[PasswordReset] Unknown username in reset request: '${basicUsername}'`);
      return res.status(401).json({
        error: 'AUTH_FAILED',
        message: 'Invalid username or password'
      });
    }

    const userRecord = usersList[idx];

    // Verify old password against stored hash
    if (!verifyPassword(userRecord, oldPassword)) {
      logger.warning(`[PasswordReset] Invalid current password for user '${basicUsername}'`);
      return res.status(401).json({
        error: 'AUTH_FAILED',
        message: 'Invalid username or password'
      });
    }

    // Prevent reusing the existing password
    if (verifyPassword(userRecord, newPassword)) {
      return res.status(400).json({
        error: 'PASSWORD_REUSED',
        message: 'New password must be different from the current password'
      });
    }

    // Generate a new PBKDF2 hash for the new password
    const iterations = 150000;
    const saltLen = 16;
    const salt = crypto.randomBytes(saltLen);
    const derived = crypto.pbkdf2Sync(String(newPassword), salt, iterations, 32, 'sha256');
    const saltHex = salt.toString('hex');
    const hashHex = derived.toString('hex');
    const newHash = `pbkdf2$${iterations}$${saltHex}$${hashHex}`;

    const updatedUser = {
      ...userRecord,
      password_hash: newHash,
      prompt_for_reset: false
    };
    usersList[idx] = updatedUser;

    // Persist updated users.json to disk (state directory)
    const usersPath = USERS_STATE_FILE;
    try {
      const json = JSON.stringify(usersList, null, 2);
      // Ensure trailing newline for readability
      const payload = json.endsWith('\n') ? json : `${json}\n`;
      fs.writeFileSync(usersPath, payload, 'utf8');
    } catch (err) {
      logger.error(`[PasswordReset] Failed to write users config at ${usersPath}: ${err.message}`);
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'Failed to persist new password'
      });
    }

    try {
      usersConfigCache.reloadNow();
    } catch (_) {}

    logger.info(`[PasswordReset] Password updated for user '${basicUsername}'`);
    return res.json({
      ok: true,
      username: updatedUser.username,
      prompt_for_reset: !!updatedUser.prompt_for_reset
    });
  } catch (e) {
    logger.error(`[PasswordReset] Unexpected error: ${e && e.message ? e.message : e}`);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'Failed to reset password'
    });
  }
});

export default router;
