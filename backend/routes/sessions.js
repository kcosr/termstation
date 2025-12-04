/**
 * Session API Routes
 * Handles all session-related HTTP endpoints
 */

import express from 'express';
// config imported below along with loadJson
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { config, CONFIG_ENV_DIR } from '../config-loader.js';
import { templateLoader } from '../template-loader.js';
import { isTemplateAllowedForUser } from '../utils/template-access.js';
import { logger } from '../utils/logger.js';
import { workspaceManager } from '../managers/workspace-manager.js';
import { processText } from '../utils/template-text.js';
import { validateDirectShellUser } from '../utils/user-validator.js';
import { appUserExists } from '../middleware/auth.js';
import { spawnSync } from 'child_process';
import { broadcastSessionUpdate } from '../utils/broadcast.js';
import { injectSessionInput } from '../utils/session-input.js';
import {
  registerDeferredInput,
  listDeferredInput,
  deleteDeferredInput,
  clearDeferredInputForSession
} from '../utils/input-deferral.js';
import { getRuntimeBin, findContainersForSessionIds, buildExecCommandForCommand } from '../utils/runtime.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createAccessToken as createTunnelToken, verifyAccessToken as verifyTunnelToken } from '../utils/session-access-token.js';
import { buildSessionWorkspace } from '../services/session-workspace-builder.js';
import { copyDirRecursiveSync } from '../utils/fs-utils.js';
import {
  serializeSessionForHistoryList,
  serializeSessionForPaginatedHistory,
  serializeSessionForSearch
} from '../utils/session-serializer.js';
import { getSearchableHistoryText } from '../utils/history-search.js';
import { createSessionVisibilityHandler } from './handlers/session-visibility.js';
import { rewriteLinksForFork } from '../utils/link-rewriter.js';
import { globalOpsLimiter as rlGlobal, perSessionOpsLimiter as rlPerSession, perUserCreateLimiter as rlCreatePerUser } from '../utils/rate-limiters.js';
import { usersConfigCache, groupsConfigCache } from '../utils/json-config-cache.js';
import { isWorkspaceServiceEnabledForSession, computeWorkspaceServicePort } from '../utils/workspace-service-flags.js';
import { canAccessSessionFromRequest } from '../utils/session-access.js';
import { sanitizeOutputFilename } from '../utils/session-links.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const router = express.Router();
const execFileAsync = promisify(execFile);

// Access control helpers
const getRequestUsername = (req) => (req?.user?.username) || config.DEFAULT_USERNAME;
const hasManageAllSessions = (req) => (req?.user?.permissions?.manage_all_sessions === true);
const hasInjectPermission = (req) => (req?.user?.permissions?.inject_session_input === true);
const isPrivate = (session) => session?.visibility === 'private';
const isSharedRO = (session) => session?.visibility === 'shared_readonly';
const mustOwnSession = (req, session) => {
  if (hasManageAllSessions(req)) return true;
  return String(session?.created_by || '') === String(getRequestUsername(req));
};

// Termination permission by visibility
const canTerminateSession = (req, session) => {
  if (!session) return false;
  if (hasManageAllSessions(req)) return true;
  if (isPrivate(session)) return mustOwnSession(req, session);
  if (isSharedRO(session)) return mustOwnSession(req, session); // shared read-only: owner only
  return true; // public
};

// Clear history permission by visibility
const canClearHistory = (req, session) => {
  if (!session) return false;
  if (hasManageAllSessions(req)) return true;
  if (isPrivate(session)) return mustOwnSession(req, session);
  if (isSharedRO(session)) return mustOwnSession(req, session); // shared read-only: owner only
  return true; // public
};

// Edit note permission by visibility
const canEditNote = (req, session) => {
  if (!session) return false;
  if (hasManageAllSessions(req)) return true;
  if (isPrivate(session)) return mustOwnSession(req, session);
  if (isSharedRO(session)) return mustOwnSession(req, session); // shared read-only: owner only
  return true; // public
};

// Resolve the absolute host path for a session's workspace directory
const resolveSessionWorkspaceHostPath = (sessionId) => {
  const base = path.isAbsolute(config.SESSIONS_DIR)
    ? config.SESSIONS_DIR
    : path.join(process.cwd(), config.SESSIONS_DIR);
  return path.join(base, String(sessionId), 'workspace');
};

// Shared helpers for the backend-hosted workspace API
const normalizeWorkspaceLogicalPath = (raw) => {
  const s = String(raw || '');
  if (!s || s === '.') return '/';
  if (s.startsWith('/')) return s;
  return `/${s}`;
};

const resolveSafeWorkspacePath = (root, inputPath) => {
  const raw = String(inputPath || '').replace(/\\/g, '/');
  const trimmed = raw.startsWith('/') ? raw.slice(1) : raw;
  const target = path.resolve(root, trimmed || '.');
  if (!target.startsWith(root)) return null;
  return target;
};

async function resolveWorkspaceContext(req, res) {
  const sessionIdRaw = req.params.sessionId;
  const sid = String(sessionIdRaw || '').trim();
  if (!sid) {
    res.status(400).json({
      ok: false,
      error: 'INVALID_SESSION_ID',
      message: 'Session id is required'
    });
    return null;
  }

  let session = global.sessionManager.getSession(sid);
  if (!session) {
    try {
      session = await global.sessionManager.getSessionIncludingTerminated(sid);
    } catch (error) {
      logger.error(`[API] Workspace: failed to resolve session ${sid}: ${error?.message || error}`);
      res.status(500).json({
        ok: false,
        error: 'SESSION_RESOLVE_FAILED',
        message: 'Failed to resolve session'
      });
      return null;
    }
  }

  if (!session) {
    res.status(404).json({
      ok: false,
      error: 'SESSION_NOT_FOUND',
      message: 'Session not found'
    });
    return null;
  }

  if (!canAccessSessionFromRequest(req, session)) {
    res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'Forbidden'
    });
    return null;
  }

  // Respect existing feature flag / template gating for workspace service.
  const enabled = session.workspace_service_enabled_for_session === true;
  if (!enabled) {
    res.status(503).json({
      ok: false,
      error: 'WORKSPACE_SERVICE_DISABLED',
      message: 'Workspace service not enabled for session'
    });
    return null;
  }

  const root = resolveSessionWorkspaceHostPath(session.session_id || sid);
  try {
    const st = await fs.promises.stat(root);
    if (!st || !st.isDirectory()) {
      res.status(404).json({
        ok: false,
        error: 'WORKSPACE_NOT_FOUND',
        message: 'Workspace directory not found'
      });
      return null;
    }
  } catch (_) {
    res.status(404).json({
      ok: false,
      error: 'WORKSPACE_NOT_FOUND',
      message: 'Workspace directory not found'
    });
    return null;
  }

  return { session, root, sessionId: sid };
}

// Compute per-session ephemeral bind-mounted host paths for cleanup.
// Derive candidates under the session's data directory based on template bind_mounts.container_path.
const computeEphemeralBindMountsForSession = (template, sessionId) => {
  const mounts = [];
  try {
    if (!template || !Array.isArray(template.bind_mounts) || !sessionId) {
      return mounts;
    }
    const sid = String(sessionId);
    const baseSessionsDir = path.isAbsolute(config.SESSIONS_DIR)
      ? config.SESSIONS_DIR
      : path.join(process.cwd(), config.SESSIONS_DIR);
    const sessionRoot = path.join(baseSessionsDir, sid);
    const normalize = (p) => path.resolve(p);
    const isUnderSessionRoot = (p) => {
      try {
        const resolved = normalize(p);
        const root = normalize(sessionRoot);
        return resolved === root || resolved.startsWith(root + path.sep);
      } catch (_) {
        return false;
      }
    };

    for (const m of template.bind_mounts) {
      if (!m) continue;
      const containerPathRaw = m.container_path || m.containerPath;
      if (typeof containerPathRaw !== 'string' || !containerPathRaw.trim()) continue;
      const containerPath = containerPathRaw.trim();
      const rel = containerPath.startsWith('/')
        ? containerPath.slice(1)
        : containerPath;
      const hostCandidate = path.join(baseSessionsDir, sid, rel);
      if (isUnderSessionRoot(hostCandidate)) mounts.push(hostCandidate);
    }
  } catch (_) {
    return mounts;
  }
  return mounts;
};

// Create session
router.post('/', async (req, res) => {
  try {
    let replaceWorkspacePlaceholder = (value) => value;
    // Rate limiting: apply coarse guard at API boundary
    const username = String(req?.user?.username || config.DEFAULT_USERNAME);
    if (!rlGlobal.allow('global')) {
      return res.status(429).json({ error: 'RATE_LIMITED', details: 'Global create rate limit exceeded' });
    }
    if (!rlCreatePerUser.allow(`create:${username}`)) {
      return res.status(429).json({ error: 'RATE_LIMITED', details: `Create rate limit exceeded for user ${username}` });
    }
    logger.info(`Session creation request received from user '${req.user?.username || config.DEFAULT_USERNAME}': ${JSON.stringify({
      template_id: req.body.template_id,
      template_parameters: req.body.template_parameters,
      command: req.body.command,
      working_directory: req.body.working_directory,
      title: req.body.title,
      interactive: req.body.interactive,
      cols: req.body.cols,
      rows: req.body.rows,
      workspace: req.body.workspace
    }, null, 2)}`);

    // Determine requested workspace (empty string means Default)
    const requestedWorkspace = (req.body.workspace === undefined || req.body.workspace === null)
      ? ''
      : String(req.body.workspace).trim();

    // Effective username (supports impersonation when permitted)
    let effectiveUsername = req.user?.username || config.DEFAULT_USERNAME;
    try {
      const asUserRaw = req.body?.as_user;
      if (typeof asUserRaw === 'string' && asUserRaw.trim()) {
        const asUser = asUserRaw.trim();
        // Allow "impersonation" to the same authenticated user (common when using session tokens)
        if (asUser === (req.user?.username || config.DEFAULT_USERNAME)) {
          // Validate username format (alnum plus _ . -)
          if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(asUser)) {
            return res.status(400).json({ error: 'Invalid as_user value' });
          }
          if (!appUserExists(asUser)) {
            return res.status(400).json({ error: `Impersonation target user '${asUser}' does not exist` });
          }
          effectiveUsername = asUser;
          logger.info(`[API] Using as_user matching authenticated user ('${effectiveUsername}')`);
        } else if (req.user && (req.user.permissions?.impersonate === true)) {
          // Elevated impersonation to a different user requires explicit permission
          // Validate username format (alnum plus _ . -)
          if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(asUser)) {
            return res.status(400).json({ error: 'Invalid as_user value' });
          }
          // Validate that the impersonation target exists in app users
          if (!appUserExists(asUser)) {
            return res.status(400).json({ error: `Impersonation target user '${asUser}' does not exist` });
          }
          effectiveUsername = asUser;
          logger.info(`[API] Impersonation enabled; using as_user='${effectiveUsername}' for session creation`);
        } else {
          return res.status(403).json({ error: 'Impersonation not allowed for this user' });
        }
      }
    } catch (e) {
      logger.warning(`[API] as_user processing failed: ${e.message}`);
    }

    let sessionOptions = {
      cols: req.body.cols,
      rows: req.body.rows,
      title: req.body.title,
      visibility: (['public','private','shared_readonly'].includes(req.body.visibility)) ? req.body.visibility : 'private',
      created_by: effectiveUsername // Use effective username (impersonated when allowed)
    };

    // Parent/child semantics (accepted for server-initiated child sessions)
    try {
      const parentIdRaw = typeof req.body?.parent_session_id === 'string' ? req.body.parent_session_id.trim() : '';
      if (parentIdRaw) sessionOptions.parent_session_id = parentIdRaw;
    } catch (_) {}
    try {
      const childTabTypeRaw = typeof req.body?.child_tab_type === 'string' ? req.body.child_tab_type.trim() : '';
      if (childTabTypeRaw) sessionOptions.child_tab_type = childTabTypeRaw;
    } catch (_) {}
    try {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'show_in_sidebar')) {
        sessionOptions.show_in_sidebar = req.body.show_in_sidebar !== false;
      }
    } catch (_) {}

    // Isolation override from request body (preferred)
    let isolationOverride = undefined;
    try {
      const rawIso = req.body && Object.prototype.hasOwnProperty.call(req.body, 'isolation_mode')
        ? String(req.body.isolation_mode).trim().toLowerCase()
        : undefined;
      if (rawIso && ['none','directory','container'].includes(rawIso)) isolationOverride = rawIso;
      try { logger.info(`[API] Requested isolation override: ${isolationOverride || '(none)'}`); } catch (_) {}
    } catch (_) {}

    // Optional: fork from an existing session. Allow fork when requester can access the source
    // session (owner, admin, or any viewer for shared_readonly/public sessions).
    let forkFromSession = null;
    const forkFromId = (typeof req.body?.fork_from_session_id === 'string') ? req.body.fork_from_session_id.trim() : '';
    const forkSourceId = forkFromId || '';
    if (forkSourceId) {
      try {
        const s = await global.sessionManager.getSessionIncludingTerminated(forkSourceId);
        if (!s) return res.status(404).json({ error: 'FORK_SOURCE_NOT_FOUND', details: 'Source session not found' });
        // Previously restricted to owners; now permit forking from any session the user can access.
        // Private sessions still require ownership; shared_readonly/public are viewable by all and thus forkable.
        if (!canAccessSessionFromRequest(req, s)) {
          return res.status(403).json({ error: 'FORBIDDEN', details: 'You do not have access to fork this session' });
        }
        // Allow forking from active or terminated sessions
        forkFromSession = s;
        try {
          logger.info(`[API] Fork requested from ${forkSourceId}: ` +
            `source_isolation=${s?.isolation_mode || 'none'}, ` +
            `source_workspace='${s?.workspace || 'Default'}', ` +
            `save_workspace_dir=${s?.save_workspace_dir === true}, ` +
            `save_bootstrap_dir=${s?.save_bootstrap_dir === true}`);
        } catch (_) {}
        // If template_id not provided, hydrate from source
        if (!req.body.template_id) {
          req.body.template_id = s.template_id;
        }
        // Always hydrate template parameters from source unless explicitly provided
        if (!req.body.template_parameters) {
          req.body.template_parameters = s.template_parameters || {};
        }
        // Default workspace/title to source when not provided
        if (!req.body.workspace && s.workspace) req.body.workspace = s.workspace;
        if (!req.body.title && s.title) req.body.title = s.title;
        // Default visibility to source when not explicitly provided
        if (!req.body.visibility && s.visibility) req.body.visibility = s.visibility;
        // If isolation override not provided, inherit from source session
        try {
          if (!isolationOverride) {
            const inheritedIsolation = String(s?.isolation_mode || '').trim().toLowerCase();
            if (['none','directory','container'].includes(inheritedIsolation)) {
              isolationOverride = inheritedIsolation;
              try { logger.info(`[API] Inherited isolation_mode '${isolationOverride}' from fork source ${forkSourceId}`); } catch (_) {}
            }
          }
        } catch (_) {}
      } catch (e) {
        return res.status(500).json({ error: 'FAILED_TO_FORK', details: e?.message || String(e) });
      }
    }

    // Handle template-based session creation
    if (req.body.template_id) {
      logger.info(`Processing template-based session: template_id=${req.body.template_id}`);
      
      const template = templateLoader.getTemplate(req.body.template_id);
      if (!template) {
        logger.error(`Template '${req.body.template_id}' not found`);
        return res.status(400).json({ error: `Template '${req.body.template_id}' not found` });
      }

      // Enforce template access controls
      try {
        const allowed = isTemplateAllowedForUser(req.user, template.id);
        if (!allowed) {
          logger.warning(`Template access denied for user '${req.user?.username || config.DEFAULT_USERNAME}': ${template.id}`);
          return res.status(403).json({ error: 'Forbidden', details: 'Template not allowed' });
        }
      } catch (e) {
        logger.warning(`Failed to evaluate template access for '${template.id}': ${e.message}`);
        return res.status(500).json({ error: 'Failed to evaluate template access' });
      }

      logger.info(`Found template: name='${template.name}', original_command='${template.command}'`);

      // Resolve allowed isolation modes for this template (omitted => all allowed)
      const allowedIsolationModes = (function resolveAllowed(tpl){
        try {
          const arr = Array.isArray(tpl?.isolation_modes) ? tpl.isolation_modes.map(m => String(m).toLowerCase()) : null;
          return (arr && arr.length) ? Array.from(new Set(arr.filter(v => ['none','directory','container'].includes(v)))) : ['none','directory','container'];
        } catch (_) { return ['none','directory','container']; }
      })(template);
      const isAllowed = (m) => allowedIsolationModes.includes(String(m || '').toLowerCase());

      // Validate requested isolation override against allowed list
      if (isolationOverride && !isAllowed(isolationOverride)) {
        return res.status(400).json({
          error: 'INVALID_ISOLATION_MODE',
          detail: `Isolation mode '${isolationOverride}' is not allowed for template '${template.id}'`,
          allowed_modes: allowedIsolationModes
        });
      }

      // Process template with parameters. To ensure first-run has a unique container name/label,
      // generate a session_id now and include it in the first pass.
      // Caller-provided parameters (may be partial)
      const providedParams = req.body.template_parameters || {};
      const paramValues = { ...providedParams };

      // Resolve effective parameter values (provided + defaults) before processing the template
      const resolveWithDefaults = (tpl, provided) => {
        try {
          const out = { ...provided };
          const paramsArr = Array.isArray(tpl.parameters) ? tpl.parameters : [];
          for (const p of paramsArr) {
            const name = p && p.name;
            if (!name) continue;
            const hasKey = Object.prototype.hasOwnProperty.call(out, name);
            const rawVal = hasKey ? out[name] : undefined;
            const isBlank = rawVal === undefined || rawVal === null || (typeof rawVal === 'string' && rawVal.trim() === '');
            if (isBlank && Object.prototype.hasOwnProperty.call(p, 'default')) {
              out[name] = String(p.default);
            } else if (hasKey) {
              out[name] = String(rawVal);
            }
          }
          return out;
        } catch (_) {
          return { ...provided };
        }
      };
      const effectiveParamValues = resolveWithDefaults(template, paramValues);
      // No services map merging; port-based service proxy uses :port from URL
      // Reject parameters that attempt to override reserved template vars from config
      try {
        const reserved = new Set(Object.keys((config.TEMPLATE_VARS || {})));
        const conflicts = Object.keys(paramValues || {}).filter(k => reserved.has(k));
        if (conflicts.length > 0) {
          logger.error(`Template parameter conflict: reserved keys provided: ${conflicts.join(', ')}`);
          return res.status(400).json({
            error: 'Reserved template variables cannot be overridden',
            reserved_keys: conflicts
          });
        }
      } catch (_) {}
      const initialSessionId = uuidv4();
      const workspaceBaseDir = path.isAbsolute(config.SESSIONS_DIR)
        ? config.SESSIONS_DIR
        : path.join(process.cwd(), config.SESSIONS_DIR);
      const sessionWorkspaceHostPath = path.join(workspaceBaseDir, String(initialSessionId), 'workspace');

      // Always inject config TEMPLATE_VARS into template processing
      // Validate required parameters after resolving defaults
      try {
        const required = Array.isArray(template.parameters) ? template.parameters.filter(p => p && p.required) : [];
        const missing = [];
        for (const p of required) {
          const name = p && p.name;
          if (!name) continue;
          const val = effectiveParamValues[name];
          const blank = (val === undefined || val === null || (typeof val === 'string' && val.trim() === ''));
          if (blank) missing.push(name);
        }
        if (missing.length > 0) {
          return res.status(400).json({
            error: 'VALIDATION_ERROR',
            code: 'MISSING_TEMPLATE_PARAMETERS',
            detail: `Missing required parameters: ${missing.join(', ')}`,
            context: {
              template_id: template.id,
              template_name: template.name,
              missing_parameters: missing
            }
          });
        }
        // Enforce membership for select parameters with constrained options.
        // Rule: when a parameter is defined as type 'select' with a constrained options list
        //       (static or user-sourced) and the client provided a non-empty value,
        //       the value must match one of the allowed options (unless strict_options === false).
        try {
          const selectParams = Array.isArray(template.parameters)
            ? template.parameters.filter(p => p && String(p.type || '') === 'select')
            : [];
          for (const p of selectParams) {
            const name = p && p.name;
            if (!name) continue;
            // Allow templates to disable enforcement explicitly with strict_options: false (default true)
            try {
              const hasStrict = Object.prototype.hasOwnProperty.call(p, 'strict_options');
              const strictFlag = hasStrict ? !!p.strict_options : true;
              if (!strictFlag) continue; // skip enforcement when strict_options is false
            } catch (_) { /* ignore and enforce by default */ }

            // Determine options source: default to 'static' when not specified.
            const srcRaw = p.options_source;
            const src = (typeof srcRaw === 'string' && srcRaw.trim())
              ? srcRaw.trim().toLowerCase()
              : 'static';

            // Skip command-sourced selects here; their options are dynamic and may be expensive to resolve.
            if (src === 'command' || p.command || p.command_file) continue;

            // Resolve allowed options based on source.
            let optionsArr = [];
            if (src === 'user') {
              try {
                const res = templateLoader.getParameterOptions(req.body.template_id, name, {}, req.user || null);
                optionsArr = Array.isArray(res?.options) ? res.options : [];
              } catch (e) {
                // On failure to resolve user-sourced options, reject the request.
                try { logger.warning(`[API] User-sourced select validation failed for ${name}: ${e?.message || e}`); } catch (_) {}
                return res.status(500).json({
                  error: 'INVALID_PARAMETER_OPTIONS',
                  code: 'USER_OPTIONS_RESOLUTION_FAILED',
                  parameter: name,
                  detail: `Failed to resolve allowed options for '${name}' from user/group configuration`
                });
              }
            } else {
              // Static options list from template config
              optionsArr = Array.isArray(p.options) ? p.options : [];
            }
            if (optionsArr.length === 0) continue; // nothing to enforce

            // Only enforce when the caller explicitly provided a value
            const hasProvided = Object.prototype.hasOwnProperty.call(paramValues || {}, name);
            if (!hasProvided) continue;
            let provided = paramValues[name];
            if (provided === undefined || provided === null) continue;
            provided = String(provided);
            if (provided.trim() === '') continue;

            // Build allowed set from options: accept strings or { value, label }
            const allowed = new Set();
            const allowedList = [];
            for (const o of optionsArr) {
              const v = (o && typeof o === 'object') ? (o.value ?? o.label) : o;
              const sv = (v === undefined || v === null) ? '' : String(v);
              if (!allowed.has(sv)) {
                allowed.add(sv);
                allowedList.push(sv);
              }
            }
            if (!allowed.has(provided)) {
              return res.status(400).json({
                error: 'INVALID_PARAMETER_VALUE',
                code: 'INVALID_SELECT_VALUE',
                parameter: name,
                detail: `Invalid value for '${name}': '${provided}'. Allowed: one of configured options`,
                allowed_values: allowedList
              });
            }
          }
        } catch (e) {
          // Non-fatal: do not block on unexpected enforcement errors
          try { logger.warning(`[API] Static select validation failed non-fatally: ${e?.message || e}`); } catch (_) {}
        }
      } catch (_) { /* fall through if validation fails unexpectedly */ }

      // Use fork-specific overrides when forking, if present on the template
      const tplForProcessing = (function selectTemplateForProcessing(tpl) {
        try {
          if (!forkSourceId) return tpl;
          // Treat explicit presence (even empty arrays) as an override signal
          const hasFork = (Object.prototype.hasOwnProperty.call(tpl, 'fork_command')
            || Object.prototype.hasOwnProperty.call(tpl, 'fork_pre_commands')
            || Object.prototype.hasOwnProperty.call(tpl, 'fork_post_commands'));
          if (!hasFork) return tpl;
          const clone = Object.assign(Object.create(Object.getPrototypeOf(tpl)), tpl);
          if (Object.prototype.hasOwnProperty.call(tpl, 'fork_pre_commands')) {
            clone.pre_commands = Array.isArray(tpl.fork_pre_commands) ? tpl.fork_pre_commands : [];
          }
          if (Object.prototype.hasOwnProperty.call(tpl, 'fork_post_commands')) {
            clone.post_commands = Array.isArray(tpl.fork_post_commands) ? tpl.fork_post_commands : [];
          }
          if (Object.prototype.hasOwnProperty.call(tpl, 'fork_command')) {
            clone.command = (typeof tpl.fork_command === 'string') ? tpl.fork_command : (tpl.command || '');
          }
          return clone;
        } catch (_) { return tpl; }
      })(template);

      // Build a template instance with overlay applied based on runtime isolation override when provided
      const templateForRun = (function selectTemplateForRun() {
        try {
          if (!isolationOverride) return tplForProcessing;
          return templateLoader.getTemplateWithIsolation(req.body.template_id, isolationOverride) || tplForProcessing;
        } catch (_) { return tplForProcessing; }
      })();

      const effectiveIsolation = isolationOverride || (templateForRun && templateForRun.isolation) || 'none';

      const workspaceServiceEnabledForSession = isWorkspaceServiceEnabledForSession({
        template: templateForRun,
        isolationMode: effectiveIsolation,
        globalConfig: config
      });

      let workspaceServicePort = null;
      try {
        if (workspaceServiceEnabledForSession && (effectiveIsolation === 'container' || effectiveIsolation === 'directory')) {
          workspaceServicePort = computeWorkspaceServicePort(initialSessionId);
        }
      } catch (_) {
        workspaceServicePort = null;
      }

      // Ensure effective isolation is allowed for this template
      if (!isAllowed(effectiveIsolation)) {
        return res.status(400).json({
          error: 'INVALID_ISOLATION_MODE',
          detail: `Effective isolation '${effectiveIsolation}' is not allowed for template '${template.id}'`,
          allowed_modes: allowedIsolationModes
        });
      }

      // Generate a single session token (used for tunnel and file downloads)
      let sessionUnifiedToken = null;
      try {
        const ttl = Number.isInteger(Number(config.SESSION_TOKEN_TTL_SECONDS)) && config.SESSION_TOKEN_TTL_SECONDS >= 0
          ? Number(config.SESSION_TOKEN_TTL_SECONDS)
          : 0; // default: no expiration (0 = session-lifetime only)
        sessionUnifiedToken = createTunnelToken({ sessionId: initialSessionId, ttlSeconds: ttl });
      } catch (_) { sessionUnifiedToken = null; }

      const sessionWorkspaceVariable = (function resolveWorkspaceVariable() {
        if (effectiveIsolation === 'container') return '/workspace';
        if (effectiveIsolation === 'directory') return sessionWorkspaceHostPath;
        return WORKSPACE_MACRO_PLACEHOLDER;
      })();

      // Compute bootstrap base directory for template interpolation
      const bootstrapDirVariable = (function resolveBootstrapDir() {
        try {
          if (effectiveIsolation === 'container') return '/workspace/.bootstrap';
          if (effectiveIsolation === 'directory') return path.join(sessionWorkspaceHostPath, '.bootstrap');
          // isolation 'none': use backend-managed bootstrap directory
          return path.join(__dirname, '..', 'bootstrap');
        } catch (_) { return ''; }
      })();

      const firstPassParams = {
        ...(config.TEMPLATE_VARS || {}),
        ...effectiveParamValues,
        session_id: initialSessionId,
        // Single canonical variable name for token
        session_token: sessionUnifiedToken || '',
        session_title: (req.body && typeof req.body.title === 'string') ? req.body.title : '',
        _login_user: effectiveUsername,
        _default_username: config.DEFAULT_USERNAME,
        session_workspace_dir: sessionWorkspaceVariable,
        // Internal macro for template interpolation
        bootstrap_dir: bootstrapDirVariable,
        workspace_service_port: workspaceServicePort,
        // Uppercase system macro variants
        SESSION_ID: initialSessionId,
        SESSION_TOK: sessionUnifiedToken || '',
        SESSION_TITLE: (req.body && typeof req.body.title === 'string') ? req.body.title : '',
        SESSION_WORKSPACE_DIR: sessionWorkspaceVariable,
        BOOTSTRAP_DIR: bootstrapDirVariable,
        WORKSPACE_SERVICE_PORT: workspaceServicePort,
        CONFIG_DIR: CONFIG_ENV_DIR
      };

      logger.info(`Template variables for processing (first pass): ${JSON.stringify(firstPassParams, null, 2)}`);

      // Pass firstPassParams directly (not a copy) so that forge-injected variables
      // (FORGE_CLONE_URL, FORGE_REPO_URL, etc.) are added to it and available
      // for buildSessionWorkspace later. config.TEMPLATE_VARS is already merged
      // into firstPassParams above, so no need to spread it again here.
      const processedTemplate = templateForRun.processTemplate(firstPassParams);

      const resolvedWorkspaceDir = (function resolveWorkspaceDir() {
        if (effectiveIsolation === 'container') return '/workspace';
        if (effectiveIsolation === 'directory') return sessionWorkspaceHostPath;
        const wd = processedTemplate?.working_directory;
        if (typeof wd === 'string' && wd.trim()) return wd;
        return '';
      })();

      if (sessionWorkspaceVariable === WORKSPACE_MACRO_PLACEHOLDER && resolvedWorkspaceDir) {
        firstPassParams.session_workspace_dir = resolvedWorkspaceDir;
        firstPassParams.SESSION_WORKSPACE_DIR = resolvedWorkspaceDir;
      }

      replaceWorkspacePlaceholder = (value) => {
        if (typeof value !== 'string') return value;
        if (!value.includes(WORKSPACE_MACRO_PLACEHOLDER)) return value;
        return resolvedWorkspaceDir
          ? value.split(WORKSPACE_MACRO_PLACEHOLDER).join(resolvedWorkspaceDir)
          : value.split(WORKSPACE_MACRO_PLACEHOLDER).join('');
      };

      // Build per-session workspace (for container and directory isolation); non-fatal on error
      let builtWorkspace = null;
      try {
        if (effectiveIsolation === 'container' || effectiveIsolation === 'directory') {
          builtWorkspace = await buildSessionWorkspace({ sessionId: initialSessionId, template: tplForProcessing, variables: firstPassParams });
          try {
            logger.info(`[API] Session ${initialSessionId}: built workspace for isolation='${effectiveIsolation}' at hostPath='${sessionWorkspaceHostPath}'`);
          } catch (_) {}
          if (forkFromSession) {
            try {
              const base = path.isAbsolute(config.SESSIONS_DIR)
                ? config.SESSIONS_DIR
                : path.join(process.cwd(), config.SESSIONS_DIR);
              const srcDir = path.join(base, String(forkFromSession.session_id), 'workspace');
              const dstDir = path.join(base, String(initialSessionId), 'workspace');
              try {
                logger.debug && logger.debug(`[API] Fork workspace copy starting: source=${forkFromSession.session_id} -> target=${initialSessionId}, effectiveIsolation=${effectiveIsolation}, srcDir='${srcDir}', dstDir='${dstDir}'`);
              } catch (_) {}
              const st = fs.statSync(srcDir);
              if (st && st.isDirectory()) {
                const entries = fs.readdirSync(srcDir, { withFileTypes: true });
                let copiedDirs = 0;
                let copiedFiles = 0;
                let skippedBootstrapEntries = 0;
                let failedEntries = 0;
                try {
                  logger.debug && logger.debug(`[API] Fork workspace source '${srcDir}' has ${entries.length} top-level entries (excluding .bootstrap when copying)`);
                } catch (_) {}
                // Copy everything except the orchestrator directory (.bootstrap)
                for (const entry of entries) {
                  if (!entry) continue;
                  if (entry.name === '.bootstrap') {
                    skippedBootstrapEntries++;
                    continue;
                  }
                  const s = path.join(srcDir, entry.name);
                  const d = path.join(dstDir, entry.name);
                  try {
                    if (entry.isDirectory()) {
                      copyDirRecursiveSync(s, d);
                      copiedDirs++;
                      try {
                        logger.debug && logger.debug(`[API] Fork workspace: copied directory '${s}' -> '${d}'`);
                      } catch (_) {}
                    } else if (entry.isFile()) {
                      try { fs.mkdirSync(path.dirname(d), { recursive: true }); } catch (_) {}
                      try {
                        fs.copyFileSync(s, d);
                        copiedFiles++;
                        try {
                          logger.debug && logger.debug(`[API] Fork workspace: copied file '${s}' -> '${d}'`);
                        } catch (_) {}
                      } catch (fileErr) {
                        failedEntries++;
                        try {
                          logger.warning(`[API] Fork workspace: failed to copy file '${s}' -> '${d}': ${fileErr?.message || fileErr}`);
                        } catch (_) {}
                      }
                    }
                  } catch (entryErr) {
                    failedEntries++;
                    try {
                      logger.warning(`[API] Fork workspace: error while copying entry '${entry?.name || '<unknown>'}' from '${srcDir}' to '${dstDir}': ${entryErr?.message || entryErr}`);
                    } catch (_) {}
                  }
                }
                try {
                  logger.debug && logger.debug(
                    `[API] Fork workspace copy summary for source=${forkFromSession.session_id} -> target=${initialSessionId}: `
                    + `copiedDirs=${copiedDirs}, copiedFiles=${copiedFiles}, `
                    + `skippedBootstrapEntries=${skippedBootstrapEntries}, failedEntries=${failedEntries}`
                  );
                } catch (_) {}
                try {
                  logger.debug && logger.debug(`[API] Fork workspace copy completed for source=${forkFromSession.session_id} -> target=${initialSessionId}`);
                } catch (_) {}
              } else {
                try {
                  logger.warning(`[API] Fork workspace source path is not a directory; skipping copy. srcDir='${srcDir}'`);
                } catch (_) {}
              }
            } catch (copyErr) {
              try {
                logger.warning(`[API] Fork workspace copy failed for source=${forkFromSession?.session_id} -> target=${initialSessionId}: ${copyErr?.message || copyErr}`);
              } catch (_) {}
            }
          } else if (forkSourceId) {
            try {
              logger.warning(`[API] Fork workspace: forkSourceId='${forkSourceId}' provided but forkFromSession is null when building workspace for new session ${initialSessionId}`);
            } catch (_) {}
          }
        } else if (forkFromSession) {
          try {
            logger.debug && logger.debug(`[API] Fork workspace: skipping host workspace build/copy for new session ${initialSessionId} because effectiveIsolation='${effectiveIsolation}'`);
          } catch (_) {}
        }
      } catch (e) {
        logger.warning(`[API] Failed to build session workspace for ${initialSessionId}: ${e?.message || e}`);
      }
      
      logger.info(`Processed template result: ${JSON.stringify({
        command: processedTemplate.command,
        working_directory: processedTemplate.working_directory,
        interactive: processedTemplate.interactive,
        load_history: processedTemplate.load_history,
        save_session_history: processedTemplate.save_session_history,
        links_count: processedTemplate.links.length
      }, null, 2)}`);
      
      // Merge template parameter defaults so session carries effective values used by the template
      const resolvedTemplateParameters = resolveWithDefaults(template, paramValues);

      // Optionally compute session alias from template
      let computedAlias = '';
      try {
        const aliasTpl = typeof templateForRun?.session_alias === 'string' ? templateForRun.session_alias : '';
        if (aliasTpl && aliasTpl.trim()) {
          const raw = processText(aliasTpl, { ...(config?.TEMPLATE_VARS || {}), ...firstPassParams }, { baseDirs: [__dirname] });
          const candidate = String(raw || '').trim();
          if (candidate && /^[A-Za-z0-9._-]+$/.test(candidate)) {
            computedAlias = candidate;
          }
        }
      } catch (_) { computedAlias = ''; }

      try {
        logger.info(`[API] Template ${template.id}: stop_inputs=${JSON.stringify(template.stop_inputs || [])}`);
      } catch (_) {}

      // Resolve stop inputs: use request body if provided, otherwise fall back to template
      // Note: IDs are optional - if not provided, they will be auto-generated by TerminalSession
      // (same behavior as when adding stop inputs via the GUI)
      const resolveStopInputs = () => {
        // If request body provides stop_inputs, use them
        if (Object.prototype.hasOwnProperty.call(req.body, 'stop_inputs')) {
          const provided = req.body.stop_inputs;
          if (Array.isArray(provided)) {
            // IDs are optional - TerminalSession will auto-generate them if missing
            return provided;
          }
          // If explicitly set to null/undefined, use empty array
          return [];
        }
        // Otherwise, use template's stop_inputs if available
        return Array.isArray(template.stop_inputs) ? template.stop_inputs : undefined;
      };

      const resolveStopInputsEnabled = () => {
        // If request body provides stop_inputs_enabled, use it
        if (Object.prototype.hasOwnProperty.call(req.body, 'stop_inputs_enabled')) {
          return req.body.stop_inputs_enabled !== false;
        }
        // Otherwise, use template's stop_inputs_enabled
        return template.stop_inputs_enabled !== false;
      };

      const resolvedStopInputs = resolveStopInputs();
      const resolvedStopInputsEnabled = resolveStopInputsEnabled();

      // Log stop inputs resolution for debugging
      try {
        if (Object.prototype.hasOwnProperty.call(req.body, 'stop_inputs')) {
          logger.info(`[API] Session ${initialSessionId}: stop_inputs provided in request body: ${JSON.stringify(resolvedStopInputs || [])}`);
        }
        if (Object.prototype.hasOwnProperty.call(req.body, 'stop_inputs_enabled')) {
          logger.info(`[API] Session ${initialSessionId}: stop_inputs_enabled provided in request body: ${resolvedStopInputsEnabled}`);
        }
      } catch (_) {}

      // Build session options from template (without links yet)
      sessionOptions = {
        ...sessionOptions,
        command: replaceWorkspacePlaceholder(processedTemplate.command),
        working_directory: replaceWorkspacePlaceholder(processedTemplate.working_directory),
        interactive: processedTemplate.interactive,
        load_history: processedTemplate.load_history,
        save_session_history: processedTemplate.save_session_history,
        capture_activity_transitions: template.capture_activity_transitions === true,
        save_workspace_dir: template.save_workspace_dir === true,
        template_id: req.body.template_id,
        template_name: template.name,
        template_badge_label: (typeof template.badge_label === 'string' && template.badge_label.trim()) ? template.badge_label.trim() : null,
        isolation_mode: (function(){
          if (isolationOverride) return isolationOverride;
          if (templateForRun && templateForRun.isolation) return templateForRun.isolation;
          return 'none';
        })(),
        // Stop inputs: use request body if provided, otherwise template defaults
        stop_inputs: resolvedStopInputs,
        stop_inputs_enabled: resolvedStopInputsEnabled,
        // Optional stop_inputs_rearm_remaining from request body (if provided)
        ...(Object.prototype.hasOwnProperty.call(req.body, 'stop_inputs_rearm_remaining')
          ? { stop_inputs_rearm_remaining: req.body.stop_inputs_rearm_remaining }
          : Object.prototype.hasOwnProperty.call(req.body, 'stop_inputs_rearm')
            ? { stop_inputs_rearm_remaining: req.body.stop_inputs_rearm }
            : {}),
        // Capture per-session ephemeral bind-mounted host paths for cleanup (best-effort)
        ephemeral_bind_mounts: computeEphemeralBindMountsForSession(template, initialSessionId),
        workspace_service_enabled_for_session: workspaceServiceEnabledForSession,
        workspace_service_port: workspaceServicePort,
        // Persist effective parameters (provided + defaults) on the session
        template_parameters: resolvedTemplateParameters,
        session_id: initialSessionId,
        // Optional alias (safe slug only)
        ...(computedAlias ? { session_alias: computedAlias } : {})
      };
      try {
        logger.info(`[API] Session ${initialSessionId}: options.stop_inputs=${JSON.stringify(sessionOptions.stop_inputs || [])}`);
      } catch (_) {}
      // Surface fork metadata to the session object so clients can detect it
      if (forkFromSession) {
        sessionOptions.is_fork = true;
        sessionOptions.forked_from_session_id = forkSourceId;
      }

      // Apply workspace: when forking and no explicit workspace provided, preserve source workspace;
      // otherwise fall back to the template's default workspace, then Default.
      // For directory isolation, run orchestrator from host workspace and set cwd
      try {
        if (sessionOptions.isolation_mode === 'directory') {
          const wsPath = sessionWorkspaceHostPath;
          sessionOptions.command = `bash -lc 'bash "${wsPath}/.bootstrap/scripts/run.sh"'`;
          sessionOptions.working_directory = wsPath;
        }
      } catch (_) { /* non-fatal */ }

      if (!requestedWorkspace) {
        const fromFork = forkFromSession && typeof forkFromSession.workspace === 'string' && forkFromSession.workspace.trim()
          ? forkFromSession.workspace.trim()
          : '';
        const fromTemplate = typeof template.default_workspace === 'string' ? template.default_workspace.trim() : '';
        sessionOptions.workspace = fromFork || fromTemplate || 'Default';
      }

      try {
        if (effectiveIsolation === 'none' && resolvedWorkspaceDir) {
          const sanitized = resolvedWorkspaceDir.replace(/"/g, '\\"');
          sessionOptions.command = `export SESSION_WORKSPACE_DIR="${sanitized}" WORKSPACE_DIR="${sanitized}" && ${sessionOptions.command}`;
        }
      } catch (_) { /* non-fatal */ }

      try { sessionOptions.session_workspace_dir = firstPassParams.session_workspace_dir || ''; } catch (_) { sessionOptions.session_workspace_dir = ''; }
      try { sessionOptions.bootstrap_dir = firstPassParams.bootstrap_dir || bootstrapDirVariable || ''; } catch (_) { sessionOptions.bootstrap_dir = ''; }
    } else {
      // Direct command sessions are no longer supported; templates are mandatory
      logger.warning('Rejected direct command session creation: template_id is required');
      return res.status(400).json({ error: 'Template required', details: 'Direct command sessions are disabled' });
    }

    // Enforce session limits (global, per-user, and per-group) before heavy processing
    try {
      // Helper: parse a numeric limit; return null when not applicable
      const parseLimit = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
      };

      // Global cap from config (applies to active sessions only)
      try {
        const globalCap = parseLimit(config.MAX_SESSIONS);
        if (globalCap !== null) {
          const activeCount = (global.sessionManager?.getActiveSessions?.() || []).length;
          if (activeCount >= globalCap) {
            return res.status(429).json({
              error: 'MAX_SESSIONS_EXCEEDED',
              scope: 'global',
              detail: `Global active sessions limit reached: ${activeCount}/${globalCap}`
            });
          }
        }
      } catch (_) { /* non-fatal */ }

      // Resolve effective user profile and groups from config files
      let userRecord = null;
      let userGroups = [];
      try {
        const usersRaw = usersConfigCache.get();
        const users = Array.isArray(usersRaw) ? usersRaw : [];
        userRecord = users.find(u => u && String(u.username) === String(effectiveUsername));
        if (userRecord && Array.isArray(userRecord.groups)) {
          userGroups = userRecord.groups.map(g => String(g || '').trim()).filter(Boolean);
        }
      } catch (_) { userRecord = null; userGroups = []; }

      // Build user->groups map for current active sessions (for group total calculations)
      let groupDefs = [];
      let userToGroups = new Map();
      try {
        const groupsRaw = groupsConfigCache.get();
        const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
        groupDefs = groups;
      } catch (_) { groupDefs = []; }
      try {
        const usersRaw = usersConfigCache.get();
        const users = Array.isArray(usersRaw) ? usersRaw : [];
        for (const u of users) {
          if (!u || !u.username) continue;
          const uname = String(u.username);
          const groupsArr = Array.isArray(u.groups) ? u.groups.map(g => String(g || '').trim()).filter(Boolean) : [];
          userToGroups.set(uname, groupsArr);
        }
      } catch (_) { /* optional */ }

      // Compute per-user limit: min of user.max_sessions and each group.max_sessions_per_user
      const perUserLimits = [];
      try {
        const uCap = userRecord ? parseLimit(userRecord.max_sessions) : null;
        if (uCap !== null) perUserLimits.push(uCap);
      } catch (_) {}
      try {
        for (const gname of userGroups) {
          const g = groupDefs.find(gg => gg && String(gg.name) === String(gname));
          if (!g) continue;
          const cap = parseLimit(g.max_sessions_per_user);
          if (cap !== null) perUserLimits.push(cap);
        }
      } catch (_) {}
      const perUserCap = perUserLimits.length > 0 ? Math.min(...perUserLimits) : null;
      if (perUserCap !== null) {
        const userActive = (global.sessionManager?.getActiveSessions?.() || []).filter(s => String(s?.created_by || '') === String(effectiveUsername)).length;
        if (userActive >= perUserCap) {
          return res.status(429).json({
            error: 'MAX_SESSIONS_EXCEEDED',
            scope: 'user',
            username: effectiveUsername,
            detail: `Active sessions limit reached for user '${effectiveUsername}': ${userActive}/${perUserCap}`
          });
        }
      }

      // Compute per-group total limits for each group the user belongs to
      // Count active sessions per group based on owners' group membership
      const active = (global.sessionManager?.getActiveSessions?.() || []);
      const groupCounts = new Map();
      for (const s of active) {
        const owner = String(s?.created_by || '');
        const groupsArr = userToGroups.get(owner) || [];
        for (const gname of groupsArr) {
          const k = String(gname);
          groupCounts.set(k, (groupCounts.get(k) || 0) + 1);
        }
      }
      for (const gname of userGroups) {
        const g = groupDefs.find(gg => gg && String(gg.name) === String(gname));
        if (!g) continue;
        const cap = parseLimit(g.max_sessions_total);
        if (cap === null) continue;
        const cur = groupCounts.get(String(gname)) || 0;
        if (cur >= cap) {
          return res.status(429).json({
            error: 'MAX_SESSIONS_EXCEEDED',
            scope: 'group',
            group: gname,
            detail: `Active sessions limit reached for group '${gname}': ${cur}/${cap}`
          });
        }
      }
    } catch (e) {
      // Best-effort enforcement; on unexpected errors, proceed without blocking
      logger.warning(`[API] Session limit check failed (non-fatal): ${e?.message || e}`);
    }

    // Phase 2: Command decision logic for container vs direct shells
    try {
      const authenticatedUsername = req.user?.username || config.DEFAULT_USERNAME;
      const isContainerIsolation = sessionOptions.isolation_mode === 'container';
      
      if (isContainerIsolation) {
        // Sandbox mode: run container runtime commands as the backend user (no sudo prefix)
        logger.info('Container isolation command will run as backend user without sudo');
      } else {
        // Direct shell mode: validate the authenticated user for direct shell access
        const validation = validateDirectShellUser(authenticatedUsername);
        if (!validation.success) {
          const msg = `Direct shell access denied for '${authenticatedUsername}': ${validation.message}`;
          logger.error(msg);
          const err = new Error(msg);
          // mark error for proper HTTP 400 handling at route catch
          err.statusCode = 400;
          throw err;
        }
        // Template loader will handle command user resolution via template.user
        logger.info(`Non-container command validated for user '${authenticatedUsername}'`);
      }
    } catch (e) {
      if (e.message && e.message.includes('Direct shell access denied')) {
        // Re-throw validation errors to return 400 to client
        throw e;
      }
      logger.warning(`Failed to analyze/adjust command for user authentication: ${e.message}`);
    }

    // If workspace was explicitly provided (including 'Default'), respect it
    if (requestedWorkspace || sessionOptions.workspace === undefined) {
      sessionOptions.workspace = (requestedWorkspace && requestedWorkspace.toLowerCase() !== 'default')
        ? requestedWorkspace
        : 'Default';
    }

    // Ensure title set after potential fork hydration (preserve source title when not provided)
    try {
      if (!sessionOptions.title && typeof req.body?.title === 'string' && req.body.title.trim()) {
        sessionOptions.title = req.body.title.trim();
      }
    } catch (_) { /* non-fatal */ }

    // Interactive sessions: fallback to `su` when sudo would prompt for a password
    try {
      const isInteractive = sessionOptions.interactive !== false;
      const isContainerIsolation = sessionOptions.isolation_mode === 'container';
      if (!isContainerIsolation) {
      const cmd = String(sessionOptions.command || '');
      // Match leading sudo with a -u <user> (flags can be in any order), capturing the remainder command
      const sudoRe = /^\s*sudo\b[^\n]*?\s-u\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)\s+([\s\S]*)$/;
      const m = isInteractive ? cmd.match(sudoRe) : null;
      if (m) {
        const targetUser = m[1];
        const remainder = m[2] || '';
        let osUser = '';
        try { osUser = os.userInfo().username || ''; } catch (_) {}
        if (targetUser && osUser && targetUser !== osUser) {
          // Test if sudo can run non-interactively without a password requirement
          const test = spawnSync('sudo', ['-n', '-u', targetUser, 'true'], { encoding: 'utf8' });
          const stderr = (test.stderr || '') + (test.stdout || '');
          const needsPassword = test.status !== 0 && /password\s+is\s+required/i.test(stderr);
          if (needsPassword) {
            // Build an su-based command so the PTY can prompt for a password
            const escaped2 = String(remainder).split("'").join("'\"'\"'");
            const remEsc = escaped2; // already safely single-quoted convertible content
            const suCmd = `su - ${targetUser} -c 'exec bash -ilc '"'"'${remEsc}'"'"''`;
            logger.info(`Interactive session will use su fallback for user '${targetUser}' (sudo requires password)`);
            sessionOptions.command = suCmd;
            sessionOptions._suFallbackUser = targetUser;
          }
        }
      }
      }
    } catch (e) {
      logger.warning(`Failed to apply sudo→su fallback logic: ${e.message}`);
    }

    // If forking, pre-copy prior history log and seed metadata file BEFORE the PTY opens it.
    try {
      if (forkFromSession) {
        const base = path.isAbsolute(config.SESSIONS_DIR)
          ? config.SESSIONS_DIR
          : path.join(process.cwd(), config.SESSIONS_DIR);
        try { fs.mkdirSync(base, { recursive: true }); } catch (_) {}
        // History log
        try {
          const oldLog = path.join(base, `${forkFromSession.session_id}.log`);
          const newLog = path.join(base, `${initialSessionId}.log`);
          try {
            const st = fs.statSync(oldLog);
            if (st && st.isFile()) {
              try { fs.copyFileSync(oldLog, newLog); } catch (_) {}
            }
          } catch (_) { /* ok if old log missing */ }
        } catch (_) { /* non-fatal */ }

        // Metadata seed: copy prior metadata json, update for the new session id
        try {
          const oldMeta = path.join(base, `${forkFromSession.session_id}.json`);
          const newMeta = path.join(base, `${initialSessionId}.json`);
          const raw = fs.readFileSync(oldMeta, 'utf8');
          try {
            const parsed = JSON.parse(raw);
            const nowIso = new Date().toISOString();
            const seeded = {
              ...parsed,
              session_id: initialSessionId,
              created_at: nowIso,
              last_output_at: nowIso,
              ended_at: null,
              exit_code: null,
              // ensure log file reference matches new session id
              script_log_file: `${initialSessionId}.log`,
              // preserve/carry forward useful context; hydrate from request when provided
              template_id: req.body?.template_id || parsed.template_id,
              template_parameters: req.body?.template_parameters || parsed.template_parameters || {},
              workspace: (req.body?.workspace || parsed.workspace || 'Default'),
              title: (typeof req.body?.title === 'string') ? req.body.title : (parsed.title || ''),
              // ensure ownership reflects the forking user on the new session metadata
              created_by: effectiveUsername,
              // mark fork relationship
              is_fork: true,
              forked_from_session_id: forkFromSession.session_id
            };
            const tmp = `${newMeta}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(seeded, null, 2), 'utf8');
            try { fs.renameSync(tmp, newMeta); } catch (_) { /* best-effort */ }
          } catch (_) {
            // If parsing fails, skip metadata seed silently
          }
        } catch (_) { /* non-fatal */ }
      }
    } catch (e) { logger.warning(`[API] Fork pre-copy of history/metadata failed: ${e?.message || e}`); }

    // Ensure the new session uses the generated initialSessionId, so IDs match bootstrap/log overlays
    try { sessionOptions.session_id = initialSessionId; } catch (_) {}

    logger.info(`Final session options: ${JSON.stringify({
      command: sessionOptions.command,
      working_directory: sessionOptions.working_directory,
      interactive: sessionOptions.interactive,
      template_id: sessionOptions.template_id,
      template_name: sessionOptions.template_name,
      workspace: sessionOptions.workspace,
      isolation_mode: sessionOptions.isolation_mode,
      session_workspace_dir: sessionOptions.session_workspace_dir
    }, null, 2)}`);

    const session = await global.sessionManager.createSession(sessionOptions);

    // Optional: configure scheduled input rules at creation time
    try {
      const usernameForRules = getRequestUsername(req);
      const scheduler = getScheduler?.() || global.inputScheduler;
      const rawSpecFromBody = (function resolveRulesSpec(body) {
        if (!body) return null;
        // Prefer explicit array field
        if (Array.isArray(body.scheduled_input_rules)) return body.scheduled_input_rules;
        // Accept object with { rules: [...] }
        if (body.scheduled_inputs && Array.isArray(body.scheduled_inputs.rules)) return body.scheduled_inputs.rules;
        // Accept pre-stringified JSON
        if (typeof body.scheduled_inputs_json === 'string' && body.scheduled_inputs_json.trim()) {
          try {
            const parsed = JSON.parse(body.scheduled_inputs_json);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && Array.isArray(parsed.rules)) return parsed.rules;
          } catch (_) { /* ignore parse errors */ }
        }
        return null;
      })(req.body || {});

      // From template (backend templates.json)
      let rawSpecFromTemplate = null;
      try {
        if (req.body && req.body.template_id) {
          const tpl = templateLoader.getTemplate(req.body.template_id);
          if (tpl && Array.isArray(tpl.scheduled_input_rules)) {
            rawSpecFromTemplate = tpl.scheduled_input_rules;
          }
        }
      } catch (_) {}

      // Combine both sources
      const combinedSpec = [
        ...(Array.isArray(rawSpecFromTemplate) ? rawSpecFromTemplate : []),
        ...(Array.isArray(rawSpecFromBody) ? rawSpecFromBody : [])
      ];

      if (scheduler && combinedSpec && Array.isArray(combinedSpec) && combinedSpec.length > 0) {
        const MAX_SPAN = 7 * 24 * 60 * 60 * 1000; // 7 days
        const clamp = (v, min, max) => {
          const n = Math.floor(Number(v));
          if (!Number.isFinite(n)) return null;
          if (n < min) return min;
          if (n > max) return max;
          return n;
        };
        // Merge variables for template text processing in rule.data
        const paramValues = req.body?.template_parameters || {};
        const mergedVars = {
          ...(config?.TEMPLATE_VARS || {}),
          ...(paramValues || {}),
          session_id: session.session_id,
          session_title: (session && typeof session.title === 'string') ? session.title : (typeof req.body?.title === 'string' ? req.body.title : ''),
          _login_user: usernameForRules,
          _default_username: config.DEFAULT_USERNAME
        };

        for (const item of combinedSpec) {
          try {
            if (!item || typeof item !== 'object') continue;
            const tRaw = String(item.type || '').toLowerCase();
            if (tRaw !== 'offset' && tRaw !== 'interval') continue;
            const type = tRaw;
            const rawData = typeof item.data === 'string' ? item.data : '';
            // Interpolate template variables in rule data when provided via template or payload
            let data = rawData;
            try {
              data = processText(String(rawData || ''), mergedVars, { baseDirs: [__dirname] });
            } catch (_) { /* non-fatal */ }
            let offset_ms = undefined;
            let interval_ms = undefined;
            if (type === 'offset') {
              const v = item.offset_ms ?? (Number(item.offset_s) * 1000);
              const off = clamp(v, 0, MAX_SPAN);
              if (off === null) continue;
              offset_ms = off;
            } else {
              const v = item.interval_ms ?? (Number(item.interval_s) * 1000);
              const iv = clamp(v, 1000, MAX_SPAN);
              if (iv === null) continue;
              interval_ms = iv;
            }
            // Support both flat UI-style fields and backend options object
            const flat = item || {};
            const opts = item.options && typeof item.options === 'object' ? item.options : {};
            const normalizedOptions = {
              submit: flat.submit !== undefined ? !!flat.submit : (opts.submit === undefined ? true : !!opts.submit),
              enter_style: (typeof flat.enter_style === 'string' && flat.enter_style) ? String(flat.enter_style) : (typeof opts.enter_style === 'string' ? String(opts.enter_style) : 'cr'),
              raw: flat.raw !== undefined ? !!flat.raw : !!opts.raw,
              activity_policy: (() => {
                const v = (typeof flat.activity_policy === 'string' && flat.activity_policy)
                  ? flat.activity_policy
                  : (typeof opts.activity_policy === 'string' ? opts.activity_policy : 'immediate');
                const low = String(v).toLowerCase();
                return (low === 'suppress' || low === 'defer') ? low : 'immediate';
              })(),
              simulate_typing: flat.simulate_typing !== undefined ? !!flat.simulate_typing : !!opts.simulate_typing,
              typing_delay_ms: (() => {
                const n = Number(flat.typing_delay_ms ?? opts.typing_delay_ms);
                return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
              })(),
              notify: flat.notify !== undefined ? !!flat.notify : (opts.notify === undefined ? true : !!opts.notify)
            };
            const stop_after = (type === 'interval' && Number.isFinite(Number(item.stop_after)) && Number(item.stop_after) > 0)
              ? Math.floor(Number(item.stop_after))
              : undefined;

            // Add the rule and start its timer
            try {
              const rule = await scheduler.addRule(session, {
                type,
                offset_ms,
                interval_ms,
                data,
                options: normalizedOptions,
                stop_after,
                created_by: usernameForRules
              });
              // Broadcast rule added notification (mirrors /input/rules POST)
              try {
                const resp = normalizeRuleForResponse ? normalizeRuleForResponse(rule) : rule;
                global.connectionManager?.broadcast?.({
                  type: 'scheduled_input_rule_updated',
                  action: 'added',
                  session_id: session.session_id,
                  rule: resp,
                  rule_id: resp?.id || resp?.rule_id,
                  next_run_at: resp?.next_run_at,
                  paused: !!resp?.paused
                });
              } catch (_) {}
            } catch (e) {
              logger.warning(`[API Create] Failed to add scheduled rule during session creation: ${e?.message || e}`);
            }
          } catch (e) {
            // Continue processing other rules
            try { logger.warning(`[API Create] Skipping invalid scheduled input rule: ${e?.message || e}`); } catch (_) {}
          }
        }
      }
    } catch (e) {
      try { logger.warning(`[API Create] Scheduled input rules processing failed: ${e?.message || e}`); } catch (_) {}
    }
    
    // Set up the output broadcaster for this session
    const suFallbackUser = typeof sessionOptions._suFallbackUser === 'string'
      ? sessionOptions._suFallbackUser.trim()
      : '';
    let suBannerSent = false;

    const sendSuBanner = () => {
      if (suBannerSent || !suFallbackUser) {
        return;
      }
      const banner = `User: ${suFallbackUser}\n`;
      try {
        session.logOutput(banner);
      } catch (e) {
        logger.warning(`Failed to log su fallback banner for session ${session.session_id}: ${e.message}`);
      }
      global.sessionManager.broadcastSessionOutput(session.session_id, banner);
      suBannerSent = true;
    };

    // Emit immediately so it appears before su writes "Password:" to the PTY
    sendSuBanner();

    session.outputBroadcaster = (sessionId, data) => {
      sendSuBanner();
      global.sessionManager.broadcastSessionOutput(sessionId, data);
    };
    
    // Process template links and update command with the real session ID if this was a template-based session
    if (req.body.template_id) {
      const template = templateLoader.getTemplate(req.body.template_id);
      const paramValues = req.body.template_parameters || {};
      
      // Add the real session_id to template parameters
      const templateVarsWithSessionId = {
        ...paramValues,
        session_id: session.session_id,
        session_title: (session && typeof session.title === 'string') ? session.title : '',
        _login_user: effectiveUsername,
        _default_username: config.DEFAULT_USERNAME,
        session_workspace_dir: sessionOptions.session_workspace_dir || '',
        // Uppercase system macro variants
        SESSION_ID: session.session_id,
        SESSION_TITLE: (session && typeof session.title === 'string') ? session.title : '',
        SESSION_WORKSPACE_DIR: sessionOptions.session_workspace_dir || '',
        BOOTSTRAP_DIR: sessionOptions.bootstrap_dir || '',
        CONFIG_DIR: CONFIG_ENV_DIR
      };
      
      // Process the template again to get everything with correct session ID
      const processedTemplateWithSessionId = template.processTemplate({ ...(config.TEMPLATE_VARS || {}), ...templateVarsWithSessionId });
      
      // Update the session's command with the correctly processed command that includes session_id
      session.command = replaceWorkspacePlaceholder(processedTemplateWithSessionId.command);
      logger.info(`Updated session ${session.session_id} command with session ID: ${session.command}`);

      // Build a human-friendly preview of the in-container commands (pre + main + post)
      try {
        const varsForPreview = { ...(config?.TEMPLATE_VARS || {}), ...templateVarsWithSessionId };
        const preList = Array.isArray(template.pre_commands)
          ? template.pre_commands.map(c => replaceWorkspacePlaceholder(processText(String(c || ''), varsForPreview, { baseDirs: [__dirname] }))).filter(Boolean)
          : [];
        const mainCmd = replaceWorkspacePlaceholder(processText(String(template.command || ''), varsForPreview, { baseDirs: [__dirname] }));
        const postList = Array.isArray(template.post_commands)
          ? template.post_commands.map(c => replaceWorkspacePlaceholder(processText(String(c || ''), varsForPreview, { baseDirs: [__dirname] }))).filter(Boolean)
          : [];
        const previewParts = [];
        if (preList.length) previewParts.push(...preList);
        if (mainCmd) previewParts.push(mainCmd);
        if (postList.length) previewParts.push(...postList);
        // Join with ' && ' to keep single-line readability in UI tooltips/headers
        session.command_preview = previewParts.join(' && ');
      } catch (e) {
        logger.warning(`Failed to build command preview for session ${session.session_id}: ${e?.message || e}`);
      }
      // Apply the same sudo→su fallback for display if applicable (interactive sessions only)
      try {
        const isInteractive = session.interactive !== false;
        const isContainer = session.isolation_mode === 'container';
        if (!isContainer) {
        const cmd2 = String(session.command || '');
        const sudoRe2 = /^\s*sudo\b[^\n]*?\s-u\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)\s+([\s\S]*)$/;
        const m2 = isInteractive ? cmd2.match(sudoRe2) : null;
        if (m2) {
          const targetUser = m2[1];
          const remainder = m2[2] || '';
          let osUser = '';
          try { osUser = os.userInfo().username || ''; } catch (_) {}
          if (targetUser && osUser && targetUser !== osUser) {
            const test = spawnSync('sudo', ['-n', '-u', targetUser, 'true'], { encoding: 'utf8' });
            const stderr = (test.stderr || '') + (test.stdout || '');
            const needsPassword = test.status !== 0 && /password\s+is\s+required/i.test(stderr);
            if (needsPassword) {
              const remEsc2 = String(remainder).split("'").join("'\"'\"'");
              const suCmd2 = `su - ${targetUser} -c 'exec bash -ilc '"'"'${remEsc2}'"'"''`;
              session.command = suCmd2;
              sessionOptions._suFallbackUser = sessionOptions._suFallbackUser || targetUser;
              logger.info(`Adjusted displayed command for session ${session.session_id} to su fallback`);
            }
          }
        }
        }
      } catch (e) {
        logger.warning(`Failed to apply sudo→su fallback to displayed command: ${e.message}`);
      }
      
      // If sandbox template, set deterministic container association details
      try {
        if (sessionOptions.isolation_mode === 'container') {
          session.isolation_mode = 'container';
          session.container_name = `sandbox-${session.session_id}`;
          session.container_runtime = config.CONTAINER_RUNTIME;
        } else {
          session.isolation_mode = sessionOptions.isolation_mode || 'none';
        }
      } catch (e) {
        logger.warning(`Failed to set sandbox container association: ${e.message}`);
      }
      
      // Add the correctly processed links to the session
      if (processedTemplateWithSessionId.links && processedTemplateWithSessionId.links.length > 0) {
        const normalizedLinks = processedTemplateWithSessionId.links.map(link => ({
          ...link,
          url: replaceWorkspacePlaceholder(link?.url || ''),
          name: replaceWorkspacePlaceholder(link?.name || link?.url || '')
        }));
        session.addLinks(normalizedLinks, { allowTemplateFields: true });
        logger.info(`Added ${processedTemplateWithSessionId.links.length} links to session ${session.session_id} with correct session ID`);
      }
      // Attach processed command tabs (frontend renders as tabs)
      try {
        const tabs = Array.isArray(processedTemplateWithSessionId.command_tabs)
          ? processedTemplateWithSessionId.command_tabs.map(t => ({
              ...t,
              name: replaceWorkspacePlaceholder(t?.name || ''),
              command: replaceWorkspacePlaceholder(t?.command || ''),
              cwd: (typeof t?.cwd === 'string' && t.cwd) ? replaceWorkspacePlaceholder(t.cwd) : undefined,
              refresh_on_view: t && t.refresh_on_view === true
            }))
          : [];
        if (tabs.length > 0) {
          session.command_tabs = tabs;
          logger.info(`Added ${tabs.length} command tabs to session ${session.session_id}`);
        }
      } catch (e) {
        logger.warning(`[API] Failed to process command_tabs: ${e?.message || e}`);
      }
      // Preserve/merge attributes from source when forking
      try {
        if (forkFromSession) {
          // Ensure visibility matches the source session if not overridden earlier
          if (!req.body?.visibility && forkFromSession.visibility) {
            session.visibility = forkFromSession.visibility;
          }
          // Merge prior links from source, but re-evaluate with the new session context
          // so any references to the old session_id are updated and any macros are re-processed.
          try {
            const prevLinks = Array.isArray(forkFromSession.links) ? forkFromSession.links : [];
            if (prevLinks.length > 0) {
              const mergedVars = {
                ...(config?.TEMPLATE_VARS || {}),
                ...(session?.template_parameters || {}),
                session_id: session.session_id,
                session_title: (typeof session?.title === 'string' ? session.title : ''),
                _login_user: (req?.user?.username) || config.DEFAULT_USERNAME,
                _default_username: config.DEFAULT_USERNAME
              };
              const rewritten = rewriteLinksForFork(prevLinks, {
                oldSessionId: forkFromSession.session_id,
                newSessionId: session.session_id,
                variables: mergedVars,
                baseDirs: [__dirname]
              });
              if (rewritten.length > 0) session.addLinks(rewritten, { allowTemplateFields: true });
            }
          } catch (_) { /* ignore */ }
        }
      } catch (e) {
        logger.warning(`[API] Fork attribute preservation failed: ${e?.message || e}`);
      }
    }

    logger.info(`Session created successfully: id=${session.session_id}, active=${session.is_active}`);
    
    broadcastSessionUpdate(session, 'created');
    
    // Ensure workspace exists for the owner if a non-Default workspace was specified (auto-create on session create)
    try {
      const wsName = String(session.workspace || 'Default').trim();
      if (wsName && wsName.toLowerCase() !== 'default') {
        try {
          const created = workspaceManager.addForUser(session.created_by, wsName);
          // Broadcast updated workspace list
          try {
            if (global.connectionManager) {
              global.connectionManager.broadcast({
                type: 'workspaces_updated',
                workspaces: workspaceManager.getAllForUser(session.created_by),
                action: 'created',
                name: created,
                user: session.created_by
              });
            }
          } catch (e) {
            logger.warning(`[API] Failed to broadcast workspaces_updated after auto-create '${wsName}': ${e.message}`);
          }
        } catch (e) {
          // Ignore if it already exists; log other errors
          if (e && e.code !== 'ALREADY_EXISTS') {
            logger.warning(`[API] Failed to ensure workspace '${wsName}': ${e.message}`);
          }
        }
      }
    } catch (e) {
      logger.warning(`[API] Workspace auto-create check failed: ${e.message}`);
    }
    
    res.json(session.toResponseObject());
  } catch (error) {
    // Return 400 for direct shell validation failures
    if (error && (error.statusCode === 400 || (error.message && /Direct shell access denied/.test(error.message)))) {
      logger.warning(`Session creation denied: ${error.message}`);
      return res.status(400).json({ error: 'Direct shell access denied', details: error.message });
    }
    logger.error(`Error creating session: ${error && error.message ? error.message : error}`);
    if (error && error.stack) logger.error(`Error stack: ${error.stack}`);
    res.status(500).json({
      error: 'SERVER_ERROR',
      code: 'CREATE_SESSION_FAILED',
      detail: error && error.message ? error.message : 'Failed to create session',
      context: {
        template_id: req.body && req.body.template_id,
        workspace: req.body && req.body.workspace,
        as_user: req.body && req.body.as_user
      }
    });
  }
});

// List sessions
router.get('/', async (req, res) => {
  const username = getRequestUsername(req);
  let sessions = [...global.sessionManager.getActiveSessions()];
  if (!hasManageAllSessions(req)) {
    sessions = sessions.filter(s => !isPrivate(s) || String(s.created_by) === String(username));
  }

  // Track active child sessions so we can surface their parents even if terminated
  const parentChildCount = new Map();
  for (const session of sessions) {
    const parentId = session?.parent_session_id;
    if (parentId) {
      parentChildCount.set(parentId, (parentChildCount.get(parentId) || 0) + 1);
    }
  }

  for (const parentId of parentChildCount.keys()) {
    const existing = sessions.find((s) => s.session_id === parentId);
    if (existing) continue;

    let parentSession = global.sessionManager.getSession(parentId);
    if (!parentSession) {
      try {
        parentSession = await global.sessionManager.getSessionIncludingTerminated(parentId);
      } catch (e) {
        logger.warning(`[API] Failed to load parent session ${parentId} for child aggregation: ${e.message}`);
      }
    }

    if (!parentSession) continue;
    // Respect listing policy: allow admins to include parents, otherwise require owner or non-private
    if (!hasManageAllSessions(req) && isPrivate(parentSession) && String(parentSession.created_by) !== String(username)) continue;

    sessions.push(parentSession);
  }

  // Final guard: re-apply visibility filter in case any sessions were appended above
  if (!hasManageAllSessions(req)) {
    sessions = sessions.filter(s => !isPrivate(s) || String(s.created_by) === String(username));
  }

  const parentIdsWithChildren = new Set(parentChildCount.keys());
  const response = sessions.map((session) => {
    const payload = session.toResponseObject();
    if (parentIdsWithChildren.has(payload.session_id)) {
      payload.has_active_children = true;
    }
    try {
      logger.debug(`[API] list sessions: ${payload.session_id} capture_activity_transitions=${payload.capture_activity_transitions} load_history=${payload.load_history}`);
    } catch (_) {}
    return payload;
  });

  res.json(response);
});

// Search sessions endpoint (GET alias placed before '/:sessionId' to avoid route conflicts)
router.get('/search', async (req, res) => {
  try {
    const normalized = normalizeFromGet(req.query || {});
    const matches = await performSessionSearch(req, normalized);
    res.json(matches);
  } catch (error) {
    logger.error(`Error searching sessions (GET): ${error.message}`);
    res.status(500).json({ error: 'Failed to search sessions', details: error.message });
  }
});

// Get session details
router.get('/:sessionId', async (req, res) => {
  let session = global.sessionManager.getSession(req.params.sessionId);

  if (!session) {
    try {
      session = await global.sessionManager.getSessionIncludingTerminated(req.params.sessionId);
    } catch (error) {
      logger.warning(`[API] Failed to load terminated session ${req.params.sessionId}: ${error.message}`);
    }
  }

  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccessSessionFromRequest(req, session)) return res.status(403).json({ error: 'Forbidden' });
  res.json(session.toResponseObject());
});

// Deprecated: HTTP fetch for container.zip removed (bootstrap now mounted directly)

// Terminate session
router.delete('/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = global.sessionManager.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!canTerminateSession(req, session)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    // Rate limiting shared with WS ops
    if (!rlGlobal.allow('global')) {
      return res.status(429).json({ error: 'RATE_LIMITED', details: 'Global terminate rate limit exceeded' });
    }
    if (!rlPerSession.allow(`session:${sessionId}`)) {
      return res.status(429).json({ error: 'RATE_LIMITED', details: `Terminate rate limit exceeded for session ${sessionId}` });
    }
    // Broadcast termination prior to teardown so UIs can reflect state immediately
    broadcastSessionUpdate(session, 'terminated');

    // Optional retention is handled by skipping deletion of the session artifacts directory

    // If this was a sandbox-backed session, attempt to stop the associated container
    // Use the session_id mapping via labels or name fallback (sandbox-<session_id>)
    try {
      if (session.isolation_mode === 'container') {
        const { stopContainersForSessionIds } = await import('../utils/runtime.js');
        const summary = await stopContainersForSessionIds([sessionId], { timeoutSeconds: config.CONTAINER_STOP_TIMEOUT_SECONDS });
        try {
          logger.info(`[API Terminate] Container stop summary for ${sessionId}: found=${summary.found}, stopped=${summary.stopped.length}, failed=${summary.failed.length}`);
        } catch (_) {}
      }
    } catch (e) {
      // Non-fatal: continue termination even if container stop fails
      try { logger.warning(`[API Terminate] Failed to stop sandbox container for ${sessionId}: ${e?.message || e}`); } catch (_) {}
    }

    // Terminate the PTY/session and persist metadata when enabled
    await global.sessionManager.terminateSession(sessionId);
    return res.json({ message: 'Session terminated successfully' });
  } catch (error) {
    logger.error(`[API Terminate] Error terminating session ${sessionId}: ${error?.message || error}`);
    return res.status(500).json({ error: 'Failed to terminate session', details: error?.message || String(error) });
  }
});

// Resize session
router.post('/:sessionId/resize', (req, res) => {
  const session = global.sessionManager.getSession(req.params.sessionId);
  if (session) {
    if (!canAccessSessionFromRequest(req, session)) return res.status(403).json({ error: 'Forbidden' });
    // Normalize and clamp dimensions to avoid pathological sizes
    let { cols = 80, rows = 24 } = req.body || {};
    cols = Number(cols);
    rows = Number(rows);
    if (!Number.isFinite(cols) || cols <= 0) cols = 80;
    if (!Number.isFinite(rows) || rows <= 0) rows = 24;
    const minCols = 40;
    const minRows = 10;
    cols = Math.max(minCols, Math.floor(cols));
    rows = Math.max(minRows, Math.floor(rows));

    const success = session.resize(cols, rows);
    if (success) {
      res.json({ message: 'Session resized successfully' });
    } else {
      res.status(500).json({ error: 'Failed to resize session' });
    }
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Inject input into a session (HTTP API)
router.post('/:sessionId/input', async (req, res) => {
  // Permission gate: requires explicit inject_session_input permission
  if (!hasInjectPermission(req)) {
    return res.status(403).json({ error: 'Forbidden', details: 'inject_session_input permission required' });
  }

  const sessionId = req.params.sessionId;
  const session = global.sessionManager.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (!session.is_active) {
    return res.status(409).json({ error: 'Session not active' });
  }
  if (!session.interactive) {
    return res.status(400).json({ error: 'Session is not interactive' });
  }
  const body = req.body || {};
  const notify = (body.notify === undefined) ? true : (body.notify === true);
  const by = (typeof body.by === 'string' && body.by) ? String(body.by) : getRequestUsername(req);
  const activityPolicyRaw = typeof body.activity_policy === 'string' ? body.activity_policy.toLowerCase() : '';
  const activity_policy = (activityPolicyRaw === 'suppress' || activityPolicyRaw === 'immediate')
    ? activityPolicyRaw
    : 'defer';

  // For defer policy while output is active, queue instead of injecting immediately
  try {
    if (activity_policy === 'defer' && session._outputActive === true) {
      const dataStr = (typeof body.data === 'string') ? body.data : '';
      const options = {
        data: dataStr,
        raw: body.raw === true,
        submit: (body.submit === undefined) ? true : (body.submit === true),
        enter_style: (typeof body.enter_style === 'string') ? body.enter_style : 'cr',
        delay_ms: body.delay_ms,
        simulate_typing: body.simulate_typing,
        typing_delay_ms: body.typing_delay_ms,
        notify,
        by,
        source: 'api',
        rule_id: undefined,
        activity_policy
      };
      const entry = registerDeferredInput(sessionId, {
        key: 'api-input',
        source: 'api',
        data: dataStr,
        options
      });
      if (!entry) {
        // Duplicate deferred input for this key/content; report as accepted but deduped
        return res.json({ ok: true, deferred: true, deduped: true, activity_policy });
      }
      return res.json({
        ok: true,
        deferred: true,
        activity_policy,
        pending_id: entry.id,
        bytes: typeof dataStr === 'string' ? dataStr.length : 0
      });
    }
  } catch (e) {
    logger.warning(`[API STDIN] failed to register deferred input for session=${sessionId}: ${e?.message || e}`);
  }

  try {
    const result = await injectSessionInput(session, {
      data: (typeof body.data === 'string') ? body.data : '',
      raw: body.raw === true,
      submit: (body.submit === undefined) ? true : (body.submit === true),
      enter_style: (typeof body.enter_style === 'string') ? body.enter_style : 'cr',
      delay_ms: body.delay_ms,
      simulate_typing: body.simulate_typing,
      typing_delay_ms: body.typing_delay_ms,
      notify,
      by,
      source: 'api',
      rule_id: undefined,
      activity_policy
    });
    return res.json(result);
  } catch (e) {
    if (e && typeof e.status === 'number') {
      if (e.status === 429) {
        return res.status(429).json({ error: 'Input limit reached', details: e.details || '' });
      }
      return res.status(e.status).json({ error: e.message || 'Failed to inject input' });
    }
    logger.error(`[API STDIN] unexpected error for session=${sessionId}: ${e?.message || e}`);
    return res.status(500).json({ error: 'Failed to inject input' });
  }
});

// Append a client-reported render marker (timestamp + line)
router.post('/:sessionId/markers', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const session = await global.sessionManager.getSessionIncludingTerminated(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // Owner or admin only
    if (!mustOwnSession(req, session) && !hasManageAllSessions(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { t, line } = req.body || {};
    const T = Number.isFinite(Number(t)) ? Math.floor(Number(t)) : Date.now();
    const L = Number.isFinite(Number(line)) ? Math.max(0, Math.floor(Number(line))) : 0;
    // Do not persist line 0 markers (client-only start marker)
    if (L === 0) {
      return res.status(202).json({ ok: true, t: T, line: L, ignored: true });
    }
    if (!Array.isArray(session.renderMarkers)) session.renderMarkers = [];
    session.renderMarkers.push({ t: T, line: L });
    // Enforce a bounded list to prevent unbounded growth
    try {
      const maxMarkers = Number.isFinite(Number(config.MAX_RENDER_MARKERS))
        ? Math.max(0, Math.floor(Number(config.MAX_RENDER_MARKERS)))
        : 2000;
      if (maxMarkers > 0 && session.renderMarkers.length > maxMarkers) {
        const excess = session.renderMarkers.length - maxMarkers;
        session.renderMarkers.splice(0, excess);
      }
    } catch (_) {}
    // Persist immediately if terminated; for active sessions, include in session_updated broadcast
    try {
      if (!session.is_active) {
        await global.sessionManager.saveTerminatedSessionMetadata(session, { force: true });
      }
    } catch (_) {}
    try { broadcastSessionUpdate(session, 'updated'); } catch (_) {}
    return res.status(201).json({ ok: true, t: T, line: L });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to append marker' });
  }
});

// List deferred input queue for a session
router.get('/:sessionId/deferred-input', async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = await global.sessionManager.getSessionIncludingTerminated(sessionId, { loadFromDisk: false });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!canAccessSessionFromRequest(req, session)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const items = listDeferredInput(sessionId);
    return res.json({ session_id: sessionId, items });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to list deferred input', details: e?.message || String(e) });
  }
});

// Delete a single deferred entry
router.delete('/:sessionId/deferred-input/:pendingId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const pendingId = req.params.pendingId;
  const check = ensureSessionActiveInteractive(req, res, sessionId);
  if (!check.ok) return res.status(check.code).json(check.body);

  try {
    const removed = deleteDeferredInput(sessionId, pendingId);
    if (!removed) return res.status(404).json({ error: 'Deferred input not found' });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to delete deferred input', details: e?.message || String(e) });
  }
});

// Clear all deferred entries for a session
router.delete('/:sessionId/deferred-input', async (req, res) => {
  const sessionId = req.params.sessionId;
  const check = ensureSessionActiveInteractive(req, res, sessionId);
  if (!check.ok) return res.status(check.code).json(check.body);
  try {
    const count = clearDeferredInputForSession(sessionId);
    return res.status(200).json({ cleared: count });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to clear deferred input', details: e?.message || String(e) });
  }
});

// Execute a template-defined command tab for a session (no arbitrary commands accepted)
// Body: { tab_index: number, client_id?: string }
router.post('/:sessionId/command-tabs/exec', async (req, res) => {
  try {
    if (global.isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down', status: 'shutting_down' });
    }
    const parentId = String(req.params.sessionId || '').trim();
    if (!parentId) return res.status(400).json({ error: 'Missing sessionId' });

    const parent = await global.sessionManager.getSessionIncludingTerminated(parentId);
    if (!parent) return res.status(404).json({ error: 'Parent session not found' });

    // Determine isolation to choose execution strategy
    const iso = String(parent.isolation_mode || 'none').toLowerCase();

    // Enforce permissions: owner/admin for direct shells; sandbox_login for containers
    if (iso === 'container') {
      const allowed = req?.user?.permissions?.sandbox_login === true;
      if (!allowed) {
        return res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_ERROR', message: 'Sandbox login permission required' });
      }
    } else {
      if (!mustOwnSession(req, parent) && !hasManageAllSessions(req)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // Validate requested command tab index
    const idxRaw = req.body?.tab_index;
    const idx = Number.isFinite(Number(idxRaw)) ? Math.floor(Number(idxRaw)) : NaN;
    if (!Number.isFinite(idx) || idx < 0) {
      return res.status(400).json({ error: 'Invalid tab_index' });
    }
    const tabs = Array.isArray(parent.command_tabs) ? parent.command_tabs : [];
    if (idx >= tabs.length) {
      return res.status(404).json({ error: 'Command tab not found' });
    }
    const spec = tabs[idx] || {};
    const name = (typeof spec?.name === 'string' && spec.name.trim()) ? spec.name.trim() : 'Command';
    const oneLiner = (typeof spec?.command === 'string') ? spec.command : '';
    const cwdSpec = (typeof spec?.cwd === 'string') ? spec.cwd : '';

    let sessionOptions = {
      interactive: true,
      title: name,
      created_by: req.user?.username || config.DEFAULT_USERNAME,
      workspace: parent.workspace || 'Default',
      parent_session_id: parent.session_id,
      child_tab_type: 'command',
      show_in_sidebar: false
    };

    if (iso === 'container') {
      // Resolve container for this parent session
      const matches = await findContainersForSessionIds([parent.session_id], false, config.CONTAINER_RUNTIME_USER || 'developer');
      if (!Array.isArray(matches) || matches.length === 0) {
        return res.status(404).json({ error: 'Container not found for parent session' });
      }
      const parseTime = (t) => {
        if (!t) return 0;
        if (typeof t === 'number') return t > 1e12 ? t : t * 1000;
        const num = Number(t);
        if (!Number.isNaN(num) && num !== 0) return num > 1e12 ? num : num * 1000;
        const ms = Date.parse(t);
        return Number.isNaN(ms) ? 0 : ms;
      };
      const isRunning = (s) => /up|running/i.test(String(s || ''));
      const best = matches
        .slice()
        .sort((a, b) => {
          const ar = isRunning(a.status) ? 1 : 0;
          const br = isRunning(b.status) ? 1 : 0;
          if (ar !== br) return br - ar; // running first
          const at = parseTime(a.created);
          const bt = parseTime(b.created);
          return bt - at; // newest first
        })[0];
      const containerRef = best?.name || best?.id;
      if (!containerRef) {
        return res.status(404).json({ error: 'Container not found for parent session' });
      }
      const cmd = buildExecCommandForCommand(containerRef, oneLiner, config.CONTAINER_RUNTIME_USER || 'developer');
      Object.assign(sessionOptions, {
        command: cmd,
        working_directory: config.DEFAULT_WORKING_DIR,
        container_name: containerRef,
        container_runtime: config.CONTAINER_RUNTIME
      });
    } else {
      // Direct host/directory execution; use template-defined cwd or parent's cwd
      const cwd = (cwdSpec && cwdSpec.trim()) ? cwdSpec.trim() : (parent.working_directory || config.DEFAULT_WORKING_DIR);
      const commandToRun = (oneLiner && oneLiner.trim()) ? oneLiner : config.DEFAULT_SHELL;
      Object.assign(sessionOptions, {
        command: commandToRun,
        working_directory: cwd,
        isolation_mode: parent.isolation_mode || 'none'
      });
    }

    const session = await global.sessionManager.createSession(sessionOptions);
    session.outputBroadcaster = (sessionId, data) => {
      global.sessionManager.broadcastSessionOutput(sessionId, data);
    };

    // Broadcast creation
    try { broadcastSessionUpdate(session, 'created'); } catch (_) {}

    const payload = session.toResponseObject();
    const originClientId = typeof req.body?.client_id === 'string' ? req.body.client_id : null;
    if (originClientId) payload.origin_client_id = originClientId;

    return res.json(payload);
  } catch (e) {
    try { logger.error(`[API] /api/sessions/:id/command-tabs/exec error: ${e?.message || e}`); } catch (_) {}
    const status = e?.statusCode || e?.status || 500;
    return res.status(status).json({ error: 'Failed to run command tab', details: e?.message || String(e) });
  }
});

// Upload an image from the browser and copy it into a sandbox container mapped to this session
// Body: { filename: string, content: base64 string, mime_type?: string }
// Returns: { container_path: string }
router.post('/:sessionId/upload-image', async (req, res) => {
  // Feature gate: image uploads must be enabled for this user
  try {
    const enabled = req?.user?.features && req.user.features.image_uploads_enabled === true;
    if (!enabled) {
      return res.status(403).json({ error: 'Image uploads feature disabled', code: 'FEATURE_DISABLED' });
    }
  } catch (_) {}
  try {
    if (global.isShuttingDown) {
      return res.status(503).json({ error: 'Server shutting down' });
    }

    const sessionId = String(req.params.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'Invalid session id' });

    const session = global.sessionManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!canAccessSessionFromRequest(req, session)) return res.status(403).json({ error: 'Forbidden' });
    if (!session.is_active) return res.status(409).json({ error: 'Session not active' });
    if (!session.interactive) return res.status(400).json({ error: 'Session is not interactive' });
    // Allow uploads for container, directory, and none isolation modes.
    const iso = String(session.isolation_mode || '').toLowerCase();
    if (iso !== 'container' && iso !== 'directory' && iso !== 'none') return res.status(400).json({ error: 'Uploads not supported for this isolation mode' });

    const body = req.body || {};
    const filenameRaw = String(body.filename || '').trim();
    const mimeType = String(body.mime_type || '').trim().toLowerCase();
    const contentBase64 = String(body.content || '').trim();

    if (!filenameRaw || !contentBase64) {
      return res.status(400).json({ error: 'filename and content are required' });
    }

    // Enforce image types
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
    const extMatch = (filenameRaw.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
    const isImageMime = mimeType.startsWith('image/');
    if (!isImageMime && !allowedExt.has(extMatch)) {
      return res.status(400).json({ error: 'Only image files are allowed' });
    }

    // Soft pre-check: approximate decoded size from base64 length against configured cap
    try {
      const approxLen = Math.floor(contentBase64.length * 0.75);
      const MAX = Number(config.UPLOADS_MAX_IMAGE_BYTES) || (32 * 1024 * 1024);
      if (approxLen > MAX) {
        return res.status(413).json({ error: 'File too large', details: `Max ${Math.floor(MAX / (1024*1024))}MB` });
      }
    } catch (_) {}

    // Sanitize filename
    const sanitize = (name) => {
      const base = name.replace(/[^A-Za-z0-9._-]/g, '_');
      // prevent leading dots
      return base.replace(/^\.+/, '');
    };
    const filename = sanitize(filenameRaw) || `image_${Date.now()}${extMatch || ''}`;

    // Decode base64 (support data URL style or raw base64)
    let base64Data = contentBase64;
    const commaIdx = contentBase64.indexOf(',');
    if (contentBase64.startsWith('data:') && commaIdx !== -1) {
      base64Data = contentBase64.slice(commaIdx + 1);
    }
    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid base64 content' });
    }
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty file content' });
    }
    // Hard cap on decoded content size
    const MAX_BYTES = Number(config.UPLOADS_MAX_IMAGE_BYTES) || (32 * 1024 * 1024);
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: 'File too large', details: `Max ${Math.floor(MAX_BYTES / (1024*1024))}MB` });
    }

    // Write directly to the session workspace's .bootstrap directory on the host.
    // The workspace is bind-mounted into the container at /workspace,
    // so files written to workspace/.bootstrap/uploads are visible at
    // /workspace/.bootstrap/uploads inside the container.
    try {
      const base = path.isAbsolute(config.SESSIONS_DIR)
        ? config.SESSIONS_DIR
        : path.join(process.cwd(), config.SESSIONS_DIR);
      const hostUploadsDir = path.join(base, sessionId, 'workspace', '.bootstrap', 'uploads');
      fs.mkdirSync(hostUploadsDir, { recursive: true });
      const hostPath = path.join(hostUploadsDir, filename);
      fs.writeFileSync(hostPath, buffer);
      if (iso === 'container') {
        const containerPath = `/workspace/.bootstrap/uploads/${filename}`;
        return res.json({ container_path: containerPath });
      }
      // Directory or None isolation: return absolute host path in the workspace
      return res.json({ path: hostPath });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to write upload to host mount', details: e?.message || String(e) });
    }
  } catch (error) {
    try { logger.error(`[API] upload-image error: ${error?.message || error}`); } catch (_) {}
    return res.status(500).json({ error: 'Failed to upload image', details: error?.message || String(error) });
  }
});

// ------------------------------
// Scheduled Input Rules Endpoints
// ------------------------------

function ensureSessionActiveInteractive(req, res, sessionId) {
  const session = global.sessionManager.getSession(sessionId);
  if (!session) {
    return { ok: false, code: 404, body: { error: 'Session not found' } };
  }
  if (!session.is_active) {
    return { ok: false, code: 409, body: { error: 'Session not active' } };
  }
  if (!session.interactive) {
    return { ok: false, code: 400, body: { error: 'Session is not interactive' } };
  }
  // Ownership/permission checks
  if (!hasInjectPermission(req)) {
    return { ok: false, code: 403, body: { error: 'Forbidden', details: 'inject_session_input permission required' } };
  }
  if (!hasManageAllSessions(req) && !mustOwnSession(req, session)) {
    return { ok: false, code: 403, body: { error: 'Forbidden' } };
  }
  return { ok: true, session };
}

function getScheduler() {
  const sch = global.inputScheduler;
  return sch;
}

function previewData(s, n = 100) {
  try {
    if (typeof s !== 'string') return '';
    return s.length > n ? (s.slice(0, n) + '…') : s;
  } catch (_) { return ''; }
}

function clampInt(val, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < min) return null;
  if (i > max) return null;
  return i;
}

function normalizeRuleForResponse(rule) {
  if (!rule || typeof rule !== 'object') return rule;
  const r = { ...rule };
  if (!('data_preview' in r)) {
    if (typeof r.data === 'string') r.data_preview = previewData(r.data, 100);
  }
  // Avoid leaking full data by default; keep options + data_preview visible
  if ('data' in r) delete r.data;
  return r;
}

// List scheduled input rules
router.get('/:sessionId/input/rules', async (req, res) => {
  const sessionId = req.params.sessionId;
  const check = ensureSessionActiveInteractive(req, res, sessionId);
  if (!check.ok) return res.status(check.code).json(check.body);

  const scheduler = getScheduler();
  if (!scheduler || typeof scheduler.listRules !== 'function') {
    return res.status(501).json({ error: 'Scheduler unavailable' });
  }

  try {
    const rules = await scheduler.listRules(sessionId);
    const out = (Array.isArray(rules) ? rules : []).map(normalizeRuleForResponse);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to list rules', details: e?.message || String(e) });
  }
});

// Create scheduled input rule
router.post('/:sessionId/input/rules', async (req, res) => {
  const sessionId = req.params.sessionId;
  const check = ensureSessionActiveInteractive(req, res, sessionId);
  if (!check.ok) return res.status(check.code).json(check.body);
  const session = check.session;

  const scheduler = getScheduler();
  if (!scheduler || typeof scheduler.addRule !== 'function' || typeof scheduler.listRules !== 'function') {
    return res.status(501).json({ error: 'Scheduler unavailable' });
  }

  const body = req.body || {};
  // Validate type and timing
  const type = String(body.type || '').toLowerCase();
  if (!['offset', 'interval'].includes(type)) {
    return res.status(400).json({ error: 'Invalid rule type' });
  }
  const MAX_SPAN = 7 * 24 * 60 * 60 * 1000; // 7 days
  let offsetMs = undefined;
  let intervalMs = undefined;
  if (type === 'offset') {
    const v = clampInt(body.offset_ms, 0, MAX_SPAN);
    if (v === null) return res.status(400).json({ error: 'Invalid offset_ms' });
    offsetMs = v;
  } else if (type === 'interval') {
    const v = clampInt(body.interval_ms, 1000, MAX_SPAN);
    if (v === null) return res.status(400).json({ error: 'Invalid interval_ms' });
    intervalMs = v;
    // Optional stop_after: number of times to run before stopping (1..1,000,000)
    if (body.stop_after !== undefined && body.stop_after !== null) {
      const turns = clampInt(body.stop_after, 1, 1000000);
      if (turns === null) return res.status(400).json({ error: 'Invalid stop_after' });
      body.stop_after = turns;
    }
  }

  // Data validation
  const rawData = (typeof body.data === 'string') ? body.data : '';
  const maxBytes = Number(config.SCHEDULED_INPUT_MAX_BYTES_PER_RULE) || 8192;
  const bytes = Buffer.byteLength(rawData, 'utf8');
  if (bytes === 0) return res.status(400).json({ error: 'data is required' });
  if (bytes > maxBytes) return res.status(413).json({ error: 'data too large', max: maxBytes });

  // Enforce per-session rules cap
  try {
    const existing = await scheduler.listRules(sessionId);
    const maxRules = Number(config.SCHEDULED_INPUT_MAX_RULES_PER_SESSION) || 20;
    if (Array.isArray(existing) && existing.length >= maxRules) {
      return res.status(400).json({ error: 'Rule limit reached', max: maxRules });
    }
  } catch (_) {}

  const options = (body.options && typeof body.options === 'object') ? body.options : {};
  // Normalize option keys
  const normalizedOptions = {
    raw: options.raw === true,
    submit: options.submit === undefined ? true : options.submit === true,
    enter_style: (typeof options.enter_style === 'string' ? options.enter_style : undefined),
    activity_policy: (() => {
      const v = typeof options.activity_policy === 'string' ? options.activity_policy : 'immediate';
      const low = String(v).toLowerCase();
      return (low === 'suppress' || low === 'defer') ? low : 'immediate';
    })(),
    simulate_typing: options.simulate_typing === true,
    typing_delay_ms: (Number.isFinite(Number(options.typing_delay_ms)) && Number(options.typing_delay_ms) >= 0)
      ? Math.floor(Number(options.typing_delay_ms))
      : undefined,
    notify: options.notify === true
  };

  const createdBy = getRequestUsername(req);

  try {
    const rule = await scheduler.addRule(sessionId, {
      type,
      offset_ms: offsetMs,
      interval_ms: intervalMs,
      data: rawData,
      options: normalizedOptions,
      stop_after: (type === 'interval' && Number.isInteger(body.stop_after)) ? body.stop_after : undefined,
      created_by: createdBy
    });
    const resp = normalizeRuleForResponse(rule);
    // Broadcast rule added
    try {
      global.connectionManager?.broadcast?.({
        type: 'scheduled_input_rule_updated',
        action: 'added',
        session_id: sessionId,
        rule: resp,
        rule_id: resp?.id || resp?.rule_id,
        next_run_at: resp?.next_run_at,
        paused: !!resp?.paused
      });
    } catch (_) {}
    return res.status(201).json({ rule: resp });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to create rule', details: e?.message || String(e) });
  }
});

// Update scheduled input rule
router.patch('/:sessionId/input/rules/:ruleId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const ruleId = req.params.ruleId;
  const check = ensureSessionActiveInteractive(req, res, sessionId);
  if (!check.ok) return res.status(check.code).json(check.body);

  const scheduler = getScheduler();
  if (!scheduler || typeof scheduler.updateRule !== 'function') {
    return res.status(501).json({ error: 'Scheduler unavailable' });
  }

  const body = req.body || {};
  const patch = {};
  const MAX_SPAN = 7 * 24 * 60 * 60 * 1000;
  if (body.paused !== undefined) patch.paused = (body.paused === true);
  if (body.offset_ms !== undefined) {
    const v = clampInt(body.offset_ms, 0, MAX_SPAN);
    if (v === null) return res.status(400).json({ error: 'Invalid offset_ms' });
    patch.offset_ms = v;
  }
  if (body.interval_ms !== undefined) {
    const v = clampInt(body.interval_ms, 1000, MAX_SPAN);
    if (v === null) return res.status(400).json({ error: 'Invalid interval_ms' });
    patch.interval_ms = v;
  }
  if (body.options && typeof body.options === 'object') {
    patch.options = { ...body.options };
  }

  try {
    const updated = await scheduler.updateRule(sessionId, ruleId, patch);
    if (!updated) return res.status(404).json({ error: 'Rule not found' });
    const resp = normalizeRuleForResponse(updated);
    // Broadcast rule updated
    try {
      global.connectionManager?.broadcast?.({
        type: 'scheduled_input_rule_updated',
        action: 'updated',
        session_id: sessionId,
        rule: resp,
        rule_id: resp?.id || ruleId,
        next_run_at: resp?.next_run_at,
        paused: !!resp?.paused
      });
    } catch (_) {}
    return res.json({ rule: resp });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update rule', details: e?.message || String(e) });
  }
});

// Remove a rule
router.delete('/:sessionId/input/rules/:ruleId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const ruleId = req.params.ruleId;
  const check = ensureSessionActiveInteractive(req, res, sessionId);
  if (!check.ok) return res.status(check.code).json(check.body);

  const scheduler = getScheduler();
  if (!scheduler || typeof scheduler.removeRule !== 'function') {
    return res.status(501).json({ error: 'Scheduler unavailable' });
  }

  try {
    const removed = await scheduler.removeRule(sessionId, ruleId);
    if (!removed) return res.status(404).json({ error: 'Rule not found' });
    // Broadcast rule removed
    try {
      global.connectionManager?.broadcast?.({
        type: 'scheduled_input_rule_updated',
        action: 'removed',
        session_id: sessionId,
        rule_id: ruleId
      });
    } catch (_) {}
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to remove rule', details: e?.message || String(e) });
  }
});

// Clear all rules
router.delete('/:sessionId/input/rules', async (req, res) => {
  const sessionId = req.params.sessionId;
  const check = ensureSessionActiveInteractive(req, res, sessionId);
  if (!check.ok) return res.status(check.code).json(check.body);

  const scheduler = getScheduler();
  if (!scheduler || typeof scheduler.clearRules !== 'function') {
    return res.status(501).json({ error: 'Scheduler unavailable' });
  }

  try {
    await scheduler.clearRules(sessionId);
    // Broadcast cleared
    try {
      global.connectionManager?.broadcast?.({
        type: 'scheduled_input_rule_updated',
        action: 'cleared',
        session_id: sessionId
      });
    } catch (_) {}
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'Failed to clear rules', details: e?.message || String(e) });
  }
});

// Manually trigger a rule
router.post('/:sessionId/input/rules/:ruleId/trigger', async (req, res) => {
  const sessionId = req.params.sessionId;
  const ruleId = req.params.ruleId;
  const check = ensureSessionActiveInteractive(req, res, sessionId);
  if (!check.ok) return res.status(check.code).json(check.body);

  const scheduler = getScheduler();
  if (!scheduler || typeof scheduler.triggerRule !== 'function') {
    return res.status(501).json({ error: 'Scheduler unavailable' });
  }

  try {
    const by = getRequestUsername(req);
    const resu = await scheduler.triggerRule(sessionId, ruleId, { by });
    // Broadcast fired
    try {
      global.connectionManager?.broadcast?.({
        type: 'scheduled_input_rule_updated',
        action: 'fired',
        session_id: sessionId,
        rule_id: ruleId,
        next_run_at: (resu && resu.next_run_at) ? resu.next_run_at : undefined
      });
    } catch (_) {}
    return res.status(202).json({ triggered: true });
  } catch (e) {
    if (e && (e.code === 'RULE_NOT_FOUND' || e.message === 'Rule not found')) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    return res.status(500).json({ error: 'Failed to trigger rule', details: e?.message || String(e) });
  }
});

// Set session title
router.put('/:sessionId/title', (req, res) => {
  const session = global.sessionManager.getSession(req.params.sessionId);
  if (session) {
    if (!mustOwnSession(req, session)) return res.status(403).json({ error: 'Forbidden' });
    session.title = req.body.title || '';
    broadcastSessionUpdate(session, 'updated');
    res.json({ message: 'Session title updated successfully' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Update session template parameters (merge allowed keys)
router.put('/:sessionId/parameters', async (req, res) => {
  let session;
  try {
    session = await global.sessionManager.getSessionIncludingTerminated(req.params.sessionId);
  } catch (error) {
    logger.error(`[API] Failed to load session ${req.params.sessionId} for parameters update: ${error?.message || error}`);
    return res.status(500).json({ error: 'Failed to update parameters' });
  }

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  // Allow note edits according to visibility (public: any user; private/shared_readonly: owner only)
  if (!canEditNote(req, session)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const body = req.body || {};
  const params = (body.template_parameters && typeof body.template_parameters === 'object' && !Array.isArray(body.template_parameters))
    ? body.template_parameters
    : (body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : null);
  if (!params) {
    return res.status(400).json({ error: 'template_parameters object is required' });
  }

  // Allowlist of keys we permit updating via API
  const allowedKeys = new Set(['issue_id', 'repo']);
  try {
    const current = session.template_parameters || {};
    const updated = { ...current };
    for (const [k, v] of Object.entries(params)) {
      if (!allowedKeys.has(k)) continue;
      // Normalize to string for consistent search behavior
      if (v === null || v === undefined) {
        delete updated[k];
      } else {
        updated[k] = String(v);
      }
    }
    session.template_parameters = updated;

    if (!session.is_active) {
      try {
        await global.sessionManager.saveTerminatedSessionMetadata(session, { force: true });
      } catch (persistError) {
        logger.warning(`[API] Failed to persist parameter metadata for terminated session ${session.session_id}: ${persistError?.message || persistError}`);
      }
    }

    broadcastSessionUpdate(session, 'updated');
    return res.json({ template_parameters: session.template_parameters });
  } catch (error) {
    logger.error(`[API] Failed to update template parameters for ${req.params.sessionId}: ${error?.message || error}`);
    return res.status(500).json({ error: 'Failed to update parameters' });
  }
});

// Backend-hosted workspace file API
async function handleWorkspaceInfo(req, res) {
  const ctx = await resolveWorkspaceContext(req, res);
  if (!ctx) return;
  const { sessionId, root } = ctx;
  const encodedSid = encodeURIComponent(sessionId);
  res.json({
    ok: true,
    service: 'workspace',
    root,
    api: {
      list: `/api/sessions/${encodedSid}/workspace/list?path=/`,
      file: `/api/sessions/${encodedSid}/workspace/file?path=/path/to/file`
    }
  });
}

async function handleWorkspaceList(req, res) {
  const ctx = await resolveWorkspaceContext(req, res);
  if (!ctx) return;
  const { root } = ctx;
  const requestedPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : '/';
  const target = resolveSafeWorkspacePath(root, requestedPath);
  if (!target) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_PATH',
      message: 'Path is outside workspace root'
    });
  }
  try {
    const st = await fs.promises.stat(target);
    if (!st || !st.isDirectory()) {
      return res.status(404).json({
        ok: false,
        error: 'NOT_FOUND',
        message: 'Directory not found'
      });
    }
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const rel = path.relative(root, target) || '';
    const logicalPath = normalizeWorkspaceLogicalPath(rel);
    const outEntries = [];
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string') continue;
      const name = entry.name;
      const isHidden = name.startsWith('.');
      const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false;
      const childRel = rel ? path.posix.join(rel.replace(/\\/g, '/'), name) : name;
      outEntries.push({
        name,
        type: isDir ? 'directory' : 'file',
        path: normalizeWorkspaceLogicalPath(childRel.replace(/\\/g, '/')),
        hidden: isHidden
      });
    }
    return res.json({
      ok: true,
      path: logicalPath,
      entries: outEntries
    });
  } catch (error) {
    logger.error(`[API] Workspace: list failed: ${error?.message || error}`);
    return res.status(500).json({
      ok: false,
      error: 'READDIR_FAILED',
      message: 'Error reading directory'
    });
  }
}

async function handleWorkspaceGetFile(req, res) {
  const ctx = await resolveWorkspaceContext(req, res);
  if (!ctx) return;
  const { root } = ctx;
  const requestedPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : '';
  if (!requestedPath) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_PATH',
      message: '`path` query parameter is required'
    });
  }
  const target = resolveSafeWorkspacePath(root, requestedPath);
  if (!target) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_PATH',
      message: 'Path is outside workspace root'
    });
  }
  try {
    const st = await fs.promises.stat(target);
    if (!st || !st.isFile()) {
      return res.status(404).json({
        ok: false,
        error: 'NOT_FOUND',
        message: 'File not found'
      });
    }
    const ext = path.extname(target).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const download = String(req.query.download || '') === '1';
    res.status(200);
    res.setHeader('Content-Type', contentType);
    if (download) {
      const baseName = path.basename(target).replace(/"/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}"`);
    }
    const stream = fs.createReadStream(target);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'READ_FAILED',
          message: 'Error reading file'
        });
      } else {
        try { res.end(); } catch (_) {}
      }
    });
    stream.pipe(res);
  } catch (error) {
    logger.error(`[API] Workspace: file read failed: ${error?.message || error}`);
    return res.status(500).json({
      ok: false,
      error: 'READ_FAILED',
      message: 'Error reading file'
    });
  }
}

async function handleWorkspacePutFile(req, res) {
  // Check if user has workspace_uploads_enabled feature
  const uploadsEnabled = req?.user?.features?.workspace_uploads_enabled === true;
  if (!uploadsEnabled) {
    return res.status(403).json({
      ok: false,
      error: 'FEATURE_DISABLED',
      message: 'Workspace uploads are not enabled for this user'
    });
  }
  const ctx = await resolveWorkspaceContext(req, res);
  if (!ctx) return;
  const { root } = ctx;
  const requestedPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : '';
  if (!requestedPath) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_PATH',
      message: '`path` query parameter is required'
    });
  }
  const target = resolveSafeWorkspacePath(root, requestedPath);
  if (!target) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_PATH',
      message: 'Path is outside workspace root'
    });
  }
  const dirName = path.dirname(target);
  try {
    await fs.promises.mkdir(dirName, { recursive: true });
  } catch (error) {
    logger.error(`[API] Workspace: mkdir failed: ${error?.message || error}`);
    return res.status(500).json({
      ok: false,
      error: 'MKDIR_FAILED',
      message: 'Failed to create parent directory'
    });
  }
  try {
    const writeStream = fs.createWriteStream(target);
    let bytes = 0;
    writeStream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'WRITE_FAILED',
          message: 'Failed to write file'
        });
      } else {
        try { res.end(); } catch (_) {}
      }
    });
    writeStream.on('finish', () => {
      res.status(201).json({
        ok: true,
        path: normalizeWorkspaceLogicalPath(path.relative(root, target) || ''),
        bytes
      });
    });
    req.on('data', (chunk) => {
      bytes += chunk.length;
    });
    req.on('error', () => {
      try { writeStream.destroy(); } catch (_) {}
    });
    req.pipe(writeStream);
  } catch (error) {
    logger.error(`[API] Workspace: write failed: ${error?.message || error}`);
    return res.status(500).json({
      ok: false,
      error: 'WRITE_FAILED',
      message: 'Failed to write file'
    });
  }
}

async function handleWorkspaceDeleteFile(req, res) {
  const ctx = await resolveWorkspaceContext(req, res);
  if (!ctx) return;
  const { root } = ctx;
  const requestedPath = typeof req.query.path === 'string' && req.query.path ? req.query.path : '';
  if (!requestedPath) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_PATH',
      message: '`path` query parameter is required'
    });
  }
  const target = resolveSafeWorkspacePath(root, requestedPath);
  if (!target) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_PATH',
      message: 'Path is outside workspace root'
    });
  }
  try {
    const st = await fs.promises.stat(target);
    if (!st) {
      return res.status(404).json({
        ok: false,
        error: 'NOT_FOUND',
        message: 'File not found'
      });
    }
    if (st.isDirectory()) {
      return res.status(400).json({
        ok: false,
        error: 'IS_DIRECTORY',
        message: 'Refusing to delete directory via file API'
      });
    }
    await fs.promises.unlink(target);
    return res.json({
      ok: true,
      path: normalizeWorkspaceLogicalPath(path.relative(root, target) || '')
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return res.status(404).json({
        ok: false,
        error: 'NOT_FOUND',
        message: 'File not found'
      });
    }
    logger.error(`[API] Workspace: delete failed: ${error?.message || error}`);
    return res.status(500).json({
      ok: false,
      error: 'UNLINK_FAILED',
      message: 'Failed to delete file'
    });
  }
}

router.get('/:sessionId/workspace', handleWorkspaceInfo);
router.get('/:sessionId/workspace/list', handleWorkspaceList);
router.get('/:sessionId/workspace/file', handleWorkspaceGetFile);
router.put('/:sessionId/workspace/file', handleWorkspacePutFile);
router.delete('/:sessionId/workspace/file', handleWorkspaceDeleteFile);

// Update session workspace
router.put('/:sessionId/workspace', async (req, res) => {
  const sessionId = req.params.sessionId;
  let session = global.sessionManager.getSession(sessionId);
  let sessionRetrievedFromHistory = false;

  if (!session) {
    try {
      session = await global.sessionManager.getSessionIncludingTerminated(sessionId);
      sessionRetrievedFromHistory = !!session && session.is_active === false;
    } catch (error) {
      logger.error(`[API] Failed to resolve session ${sessionId} for workspace update: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to update workspace' });
    }
  }

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  // Allow note edits according to visibility (public: any user; private/shared_readonly: owner only)
  if (!canEditNote(req, session)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const oldWorkspace = session.workspace || 'Default';
  const newWorkspace = (req.body.workspace || 'Default').trim();

  session.workspace = newWorkspace;

  if (session.is_active) {
    // Reset/append workspace order within the new workspace for active sessions
    try {
      const all = global.sessionManager.getAllSessions();
      const inTarget = all.filter(s => (s.workspace || 'Default') === newWorkspace);
      const maxOrder = inTarget.reduce((max, s) => {
        const o = typeof s.workspace_order === 'number' ? s.workspace_order : -1;
        return Math.max(max, o);
      }, -1);
      session.workspace_order = maxOrder + 1;
    } catch (e) {
      logger.warning(`[API] Failed to recompute workspace order for session ${sessionId}: ${e.message}`);
    }
  } else {
    // Terminated sessions do not participate in manual ordering
    session.workspace_order = null;
  }

  // Ensure target workspace exists for the owner (auto-create on move)
  try {
    if (newWorkspace && newWorkspace.toLowerCase() !== 'default') {
      try {
        const created = workspaceManager.addForUser(session.created_by, newWorkspace);
        if (created && global.connectionManager) {
          global.connectionManager.broadcast({
            type: 'workspaces_updated',
            workspaces: workspaceManager.getAllForUser(session.created_by),
            action: 'created',
            name: created,
            user: session.created_by
          });
        }
      } catch (e) {
        if (e && e.code !== 'ALREADY_EXISTS') {
          logger.warning(`[API] Failed to ensure workspace '${newWorkspace}': ${e.message}`);
        }
      }
    }
  } catch (e) {
    logger.warning(`[API] Workspace auto-create (move) check failed: ${e.message}`);
  }

  // Broadcast the update to all connected clients
  broadcastSessionUpdate(session, 'updated');

  if (!session.is_active || sessionRetrievedFromHistory) {
    try {
      await global.sessionManager.saveTerminatedSessionMetadata(session, { force: true });
    } catch (error) {
      logger.warning(`[API] Failed to persist metadata after workspace update for session ${sessionId}: ${error?.message || error}`);
    }
  }

  logger.info(`Session ${sessionId} moved from workspace '${oldWorkspace}' to '${newWorkspace}'`);

  res.json({
    message: 'Session workspace updated successfully',
    workspace: newWorkspace,
    previous: oldWorkspace
  });
});

// Set session save history
router.post('/:sessionId/save-history', (req, res) => {
  const session = global.sessionManager.getSession(req.params.sessionId);
  if (session) {
    if (!mustOwnSession(req, session)) return res.status(403).json({ error: 'Forbidden' });
    session.save_session_history = req.body.save_session_history;
    broadcastSessionUpdate(session, 'updated');
    res.json({ message: 'Session save history updated successfully' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Add session links
router.post('/:sessionId/links', (req, res) => {
  const session = global.sessionManager.getSession(req.params.sessionId);
  if (session) {
    if (!mustOwnSession(req, session)) return res.status(403).json({ error: 'Forbidden' });
    session.addLinks(req.body.links || [], { allowTemplateFields: false });
    broadcastSessionUpdate(session, 'links_added');
    res.json({ message: 'Links added successfully' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ------------------------------
// Template chat link pre-view API
// ------------------------------

export async function handleLinkPreViewGenerate(req, res) {
  try {
    const rawSessionId = req.params.sessionId;
    const sid = String(rawSessionId || '').trim();
    if (!sid) {
      return res.status(400).json({ error: 'INVALID_SESSION_ID', details: 'Session id is required' });
    }

    // Resolve session (active or terminated)
    let session = global.sessionManager.getSession(sid);
    if (!session) {
      try {
        session = await global.sessionManager.getSessionIncludingTerminated(sid);
      } catch (e) {
        logger.warning(`[API] Link pre-view: failed to resolve session ${sid}: ${e?.message || e}`);
      }
    }
    if (!session) {
      return res.status(404).json({ error: 'SESSION_NOT_FOUND', details: 'Session not found' });
    }

    if (!canAccessSessionFromRequest(req, session)) {
      return res.status(403).json({ error: 'FORBIDDEN', details: 'Forbidden' });
    }

    // Validate link index
    const idxRaw = req.params.linkIndex;
    const idxNum = Number(idxRaw);
    const idx = Number.isInteger(idxNum) && idxNum >= 0 ? idxNum : NaN;
    if (!Number.isInteger(idx)) {
      return res.status(400).json({ error: 'INVALID_LINK_INDEX', details: 'linkIndex must be a non-negative integer' });
    }
    const links = Array.isArray(session.links) ? session.links : [];
    if (idx < 0 || idx >= links.length) {
      return res.status(404).json({ error: 'LINK_NOT_FOUND', details: 'Link index out of range' });
    }
    const link = links[idx] || {};

    // Only template-defined links may run pre_view_command
    if (!link._template_link) {
      return res.status(400).json({ error: 'NOT_TEMPLATE_LINK', details: 'Pre-view generation is allowed only for template links' });
    }

    const rawCmd = typeof link._pre_view_command === 'string' ? link._pre_view_command : '';
    if (!rawCmd || !rawCmd.trim()) {
      return res.status(400).json({ error: 'NO_PRE_VIEW_COMMAND', details: 'Link does not define a pre_view_command' });
    }

    // Compute session directory and output HTML path under it
    const base = path.isAbsolute(config.SESSIONS_DIR)
      ? config.SESSIONS_DIR
      : path.join(process.cwd(), config.SESSIONS_DIR);
    const sessionId = session.session_id || sid;
    const sessionDir = path.join(base, String(sessionId));
    const linksDir = path.join(sessionDir, 'links');
    try {
      fs.mkdirSync(linksDir, { recursive: true });
    } catch (e) {
      logger.error(`[API] Link pre-view: failed to create links directory for ${sessionId}: ${e?.message || e}`);
      return res.status(500).json({ error: 'IO_ERROR', details: 'Failed to prepare links directory' });
    }

    const fallbackBase = `link-${idx}`;
    const sanitizedName = sanitizeOutputFilename(link.output_filename, fallbackBase);
    const outputPath = path.join(linksDir, sanitizedName);

    const workspaceDir = path.join(sessionDir, 'workspace');

    // Build variables/macros for command templating
    const mergedVars = {
      ...(config?.TEMPLATE_VARS || {}),
      session_id: sessionId,
      session_dir: sessionDir,
      workspace_dir: workspaceDir,
      output_html: outputPath,
      SESSION_ID: sessionId,
      SESSION_DIR: sessionDir,
      WORKSPACE_DIR: workspaceDir,
      OUTPUT_HTML: outputPath
    };

    // Optional theme colors and fonts
    const passTheme = link.pass_theme_colors === true;
    if (passTheme) {
      try {
        const theme = req?.body && typeof req.body.theme === 'object' && req.body.theme !== null
          ? req.body.theme
          : {};
        for (const [k, v] of Object.entries(theme)) {
          const key = String(k || '').trim();
          if (!key) continue;
          const suffix = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
          const macroName = `THEME_${suffix}`;
          const val = v == null ? '' : String(v);
          mergedVars[macroName] = val;
        }
      } catch (e) {
        logger.warning(`[API] Link pre-view: failed to process theme colors for ${sessionId}: ${e?.message || e}`);
      }

      try {
        const sanitizeFont = (value) => {
          if (value == null) return '';
          let s = String(value);
          // Drop ASCII control characters (including DEL) and trim.
          s = s.replace(/[\x00-\x1F\x7F]+/g, '');
          return s.trim();
        };

        const fonts = req?.body && typeof req.body.fonts === 'object' && req.body.fonts !== null
          ? req.body.fonts
          : {};

        const fontUi = sanitizeFont(fonts.ui);
        const fontCode = sanitizeFont(fonts.code);

        mergedVars.THEME_FONT_UI = fontUi || '';
        mergedVars.THEME_FONT_CODE = fontCode || '';
      } catch (e) {
        logger.warning(`[API] Link pre-view: failed to process theme fonts for ${sessionId}: ${e?.message || e}`);
        mergedVars.THEME_FONT_UI = '';
        mergedVars.THEME_FONT_CODE = '';
      }
    }

    // Interpolate pre_view_command with macros (unknown => empty string)
    const command = processText(String(rawCmd), mergedVars, { baseDirs: [__dirname] });
    if (!command || !command.trim()) {
      return res.status(400).json({ error: 'INVALID_COMMAND', details: 'Resolved pre_view_command is empty' });
    }

    const env = { ...process.env };
    // Propagate key variables as env vars
    env.SESSION_ID = sessionId;
    env.SESSION_DIR = sessionDir;
    env.WORKSPACE_DIR = workspaceDir;
    env.OUTPUT_HTML = outputPath;
    // Theme env vars (already prefixed THEME_*) from mergedVars
    Object.keys(mergedVars).forEach((k) => {
      if (/^THEME_[A-Z0-9_]+$/.test(k)) {
        env[k] = String(mergedVars[k] ?? '');
      }
    });

    // Prefer workspace directory as cwd when it exists; otherwise session dir.
    let cwd = sessionDir;
    try {
      const st = fs.statSync(workspaceDir);
      if (st && st.isDirectory()) {
        cwd = workspaceDir;
      }
    } catch (_) { /* best-effort */ }

    try {
      await execFileAsync('bash', ['-lc', command], {
        cwd,
        env,
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      logger.warning(`[API] Link pre-view command failed for session ${sessionId}, link ${idx}: ${msg}`);
      return res.status(500).json({ error: 'COMMAND_FAILED', details: msg });
    }

    const encodedSid = encodeURIComponent(sessionId);
    let htmlUrl = `/api/sessions/${encodedSid}/links/${idx}/html`;
    try {
      const linkId = typeof link.link_id === 'string' && link.link_id.trim() ? link.link_id.trim() : null;
      if (linkId) {
        htmlUrl = `/api/sessions/${encodedSid}/links/id/${encodeURIComponent(linkId)}/html`;
      }
    } catch (_) {
      // Fallback to index-based URL on any unexpected error
      htmlUrl = `/api/sessions/${encodedSid}/links/${idx}/html`;
    }
    return res.json({ html_url: htmlUrl });
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    logger.error(`[API] Link pre-view generation error: ${msg}`);
    return res.status(500).json({ error: 'SERVER_ERROR', details: msg });
  }
}

export async function handleLinkPreViewHtml(req, res) {
  try {
    const rawSessionId = req.params.sessionId;
    const sid = String(rawSessionId || '').trim();
    if (!sid) {
      return res.status(400).json({ error: 'INVALID_SESSION_ID', details: 'Session id is required' });
    }

    let session = global.sessionManager.getSession(sid);
    if (!session) {
      try {
        session = await global.sessionManager.getSessionIncludingTerminated(sid);
      } catch (e) {
        logger.warning(`[API] Link html: failed to resolve session ${sid}: ${e?.message || e}`);
      }
    }
    if (!session) {
      return res.status(404).json({ error: 'SESSION_NOT_FOUND', details: 'Session not found' });
    }

    if (!canAccessSessionFromRequest(req, session)) {
      return res.status(403).json({ error: 'FORBIDDEN', details: 'Forbidden' });
    }

    const idxRaw = req.params.linkIndex;
    const idxNum = Number(idxRaw);
    const idx = Number.isInteger(idxNum) && idxNum >= 0 ? idxNum : NaN;
    if (!Number.isInteger(idx)) {
      return res.status(400).json({ error: 'INVALID_LINK_INDEX', details: 'linkIndex must be a non-negative integer' });
    }

    const links = Array.isArray(session.links) ? session.links : [];
    if (idx < 0 || idx >= links.length) {
      return res.status(404).json({ error: 'LINK_NOT_FOUND', details: 'Link index out of range' });
    }
    const link = links[idx] || {};

    const base = path.isAbsolute(config.SESSIONS_DIR)
      ? config.SESSIONS_DIR
      : path.join(process.cwd(), config.SESSIONS_DIR);
    const sessionId = session.session_id || sid;
    const sessionDir = path.join(base, String(sessionId));
    const linksDir = path.join(sessionDir, 'links');
    const fallbackBase = `link-${idx}`;
    const sanitizedName = sanitizeOutputFilename(link.output_filename, fallbackBase);
    const htmlPath = path.join(linksDir, sanitizedName);

    try {
      const st = await fs.promises.stat(htmlPath);
      if (!st || !st.isFile()) {
        return res.status(404).json({ error: 'HTML_NOT_FOUND', details: 'Generated HTML not found' });
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        return res.status(404).json({ error: 'HTML_NOT_FOUND', details: 'Generated HTML not found' });
      }
      const msg = e && e.message ? e.message : String(e);
      logger.error(`[API] Link html: stat failed for ${htmlPath}: ${msg}`);
      return res.status(500).json({ error: 'IO_ERROR', details: msg });
    }

    // Stream-as-a-whole for simplicity: read file and write once.
    try {
      const buf = await fs.promises.readFile(htmlPath);
      res.status(200);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (typeof res.send === 'function') {
        res.send(buf);
      } else if (typeof res.end === 'function') {
        res.end(buf);
      } else {
        // Fallback for test-only response mocks
        res.body = buf.toString('utf8');
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      logger.error(`[API] Link html: read error for ${htmlPath}: ${msg}`);
      return res.status(500).json({ error: 'READ_FAILED', details: msg });
    }
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    logger.error(`[API] Link html endpoint error: ${msg}`);
    return res.status(500).json({ error: 'SERVER_ERROR', details: msg });
  }
}

export async function handleLinkPreViewGenerateById(req, res) {
  try {
    const rawSessionId = req.params.sessionId;
    const sid = String(rawSessionId || '').trim();
    if (!sid) {
      return res.status(400).json({ error: 'INVALID_SESSION_ID', details: 'Session id is required' });
    }

    // Resolve session (active or terminated)
    let session = global.sessionManager.getSession(sid);
    if (!session) {
      try {
        session = await global.sessionManager.getSessionIncludingTerminated(sid);
      } catch (e) {
        logger.warning(`[API] Link pre-view (id): failed to resolve session ${sid}: ${e?.message || e}`);
      }
    }
    if (!session) {
      return res.status(404).json({ error: 'SESSION_NOT_FOUND', details: 'Session not found' });
    }

    if (!canAccessSessionFromRequest(req, session)) {
      return res.status(403).json({ error: 'FORBIDDEN', details: 'Forbidden' });
    }

    const rawLinkId = String(req.params.linkId || '').trim();
    if (!rawLinkId) {
      return res.status(400).json({ error: 'INVALID_LINK_ID', details: 'linkId must be a non-empty string' });
    }

    const links = Array.isArray(session.links) ? session.links : [];
    const idx = links.findIndex((l) => l && typeof l.link_id === 'string' && l.link_id.trim() === rawLinkId);
    if (idx === -1) {
      return res.status(404).json({ error: 'LINK_NOT_FOUND', details: 'Link id not found' });
    }

    req.params.linkIndex = String(idx);
    return await handleLinkPreViewGenerate(req, res);
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    logger.error(`[API] Link pre-view (id) generation error: ${msg}`);
    return res.status(500).json({ error: 'SERVER_ERROR', details: msg });
  }
}

export async function handleLinkPreViewHtmlById(req, res) {
  try {
    const rawSessionId = req.params.sessionId;
    const sid = String(rawSessionId || '').trim();
    if (!sid) {
      return res.status(400).json({ error: 'INVALID_SESSION_ID', details: 'Session id is required' });
    }

    let session = global.sessionManager.getSession(sid);
    if (!session) {
      try {
        session = await global.sessionManager.getSessionIncludingTerminated(sid);
      } catch (e) {
        logger.warning(`[API] Link html (id): failed to resolve session ${sid}: ${e?.message || e}`);
      }
    }
    if (!session) {
      return res.status(404).json({ error: 'SESSION_NOT_FOUND', details: 'Session not found' });
    }

    if (!canAccessSessionFromRequest(req, session)) {
      return res.status(403).json({ error: 'FORBIDDEN', details: 'Forbidden' });
    }

    const rawLinkId = String(req.params.linkId || '').trim();
    if (!rawLinkId) {
      return res.status(400).json({ error: 'INVALID_LINK_ID', details: 'linkId must be a non-empty string' });
    }

    const links = Array.isArray(session.links) ? session.links : [];
    const idx = links.findIndex((l) => l && typeof l.link_id === 'string' && l.link_id.trim() === rawLinkId);
    if (idx === -1) {
      return res.status(404).json({ error: 'LINK_NOT_FOUND', details: 'Link id not found' });
    }

    req.params.linkIndex = String(idx);
    return await handleLinkPreViewHtml(req, res);
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    logger.error(`[API] Link html (id) endpoint error: ${msg}`);
    return res.status(500).json({ error: 'SERVER_ERROR', details: msg });
  }
}

router.post('/:sessionId/links/id/:linkId/generate', handleLinkPreViewGenerateById);
router.get('/:sessionId/links/id/:linkId/html', handleLinkPreViewHtmlById);
router.post('/:sessionId/links/:linkIndex/generate', handleLinkPreViewGenerate);
router.get('/:sessionId/links/:linkIndex/html', handleLinkPreViewHtml);

// Update session link
router.patch('/:sessionId/links', (req, res) => {
  const session = global.sessionManager.getSession(req.params.sessionId);
  if (session) {
    if (!mustOwnSession(req, session)) return res.status(403).json({ error: 'Forbidden' });
    const { url } = req.body;
    // Accept partial updates: name and/or refresh_on_view
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) updates.name = req.body.name;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'refresh_on_view')) updates.refresh_on_view = !!req.body.refresh_on_view;
    const success = session.updateLink(url, updates);
    if (success) {
      const payload = {
        type: 'link-updated',
        sessionId: req.params.sessionId,
        url: url
      };
      if (typeof updates.name === 'string') payload.name = updates.name;
      if (Object.prototype.hasOwnProperty.call(updates, 'refresh_on_view')) payload.refresh_on_view = !!updates.refresh_on_view;
      global.connectionManager.broadcast(payload);
      res.json({ message: 'Link updated successfully' });
    } else {
      res.status(404).json({ error: 'Link not found' });
    }
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Remove session link
router.delete('/:sessionId/links', (req, res) => {
  const session = global.sessionManager.getSession(req.params.sessionId);
  if (session) {
    if (!mustOwnSession(req, session)) return res.status(403).json({ error: 'Forbidden' });
    const url = req.query.url;
    const success = session.removeLink(url);
    if (success) {
      global.connectionManager.broadcast({
        type: 'link-removed',
        sessionId: req.params.sessionId,
        url: url
      });
      res.json({ message: 'Link removed successfully' });
    } else {
      res.status(404).json({ error: 'Link not found' });
    }
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Get session note
router.get('/:sessionId/note', async (req, res) => {
  // Feature gate: notes must be enabled for this user
  try {
    const enabled = req?.user?.features && req.user.features.notes_enabled === true;
    if (!enabled) {
      return res.status(403).json({ error: 'Notes feature disabled', code: 'FEATURE_DISABLED' });
    }
  } catch (_) {}
  try {
    const session = await global.sessionManager.getSessionIncludingTerminated(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSessionFromRequest(req, session)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const snapshot = session.getNoteSnapshot();
    res.json({ ...snapshot, session_id: session.session_id });
  } catch (error) {
    logger.error(`[API] Failed to load note for session ${req.params.sessionId}: ${error?.message || error}`);
    res.status(500).json({ error: 'Failed to load note' });
  }
});

// Get stop inputs configuration for a session
async function handleGetStopInputs(req, res) {
  try {
    const session = await global.sessionManager.getSessionIncludingTerminated(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!canAccessSessionFromRequest(req, session)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const inputsRaw = Array.isArray(session.stop_inputs) ? session.stop_inputs : [];
    const enabled = session.stop_inputs_enabled === false ? false : true;
    const normalized = inputsRaw.map(p => ({
      id: p.id,
      prompt: p.prompt,
      armed: p.armed !== false,
      source: p.source === 'user' ? 'user' : 'template'
    }));
    const rearmMax = Number.isFinite(Number(config.STOP_INPUTS_REARM_MAX)) && Number(config.STOP_INPUTS_REARM_MAX) >= 0
      ? Math.floor(Number(config.STOP_INPUTS_REARM_MAX))
      : 10;
    const rawRearm = Number(session.stop_inputs_rearm_remaining);
    const rearmRemaining = Number.isFinite(rawRearm) && rawRearm >= 0 ? Math.min(Math.floor(rawRearm), rearmMax) : 0;
    return res.json({
      session_id: session.session_id,
      stop_inputs_enabled: enabled,
      stop_inputs: normalized,
      stop_inputs_rearm_remaining: rearmRemaining,
      stop_inputs_rearm_max: rearmMax
    });
  } catch (error) {
    logger.error(`[API] Failed to load stop inputs for session ${req.params.sessionId}: ${error?.message || error}`);
    return res.status(500).json({ error: 'Failed to load stop inputs' });
  }
}

router.get('/:sessionId/stop-inputs', handleGetStopInputs);

// Replace stop inputs array for an active session
async function handlePutStopInputs(req, res) {
  const session = global.sessionManager.getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (!mustOwnSession(req, session) && !hasManageAllSessions(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const body = req.body || {};
  const arr = Array.isArray(body.stop_inputs) ? body.stop_inputs : [];
  const normalized = [];
  for (const item of arr) {
    if (!item) continue;
    const prompt = typeof item.prompt === 'string' ? item.prompt : '';
    if (!prompt) continue;
    const id = (typeof item.id === 'string' && item.id.trim()) ? item.id.trim() : uuidv4();
    const armed = item.armed === false ? false : true;
    const source = item.source === 'user' ? 'user' : 'template';
    normalized.push({ id, prompt, armed, source });
  }
  session.stop_inputs = normalized;
  // Optional: update rearm counter when provided
  try {
    const rearmMax = Number.isFinite(Number(config.STOP_INPUTS_REARM_MAX)) && Number(config.STOP_INPUTS_REARM_MAX) >= 0
      ? Math.floor(Number(config.STOP_INPUTS_REARM_MAX))
      : 10;
    let rawRearm;
    if (Object.prototype.hasOwnProperty.call(body, 'stop_inputs_rearm_remaining')) {
      rawRearm = body.stop_inputs_rearm_remaining;
    } else if (Object.prototype.hasOwnProperty.call(body, 'stop_inputs_rearm')) {
      rawRearm = body.stop_inputs_rearm;
    }
    if (rawRearm !== undefined) {
      const n = Number(rawRearm);
      session.stop_inputs_rearm_remaining = (Number.isFinite(n) && n >= 0)
        ? Math.min(Math.floor(n), rearmMax)
        : 0;
    }
  } catch (_) { /* best-effort */ }
  broadcastSessionUpdate(session, 'updated');
  const enabled = session.stop_inputs_enabled === false ? false : true;
  const rearmMax = Number.isFinite(Number(config.STOP_INPUTS_REARM_MAX)) && Number(config.STOP_INPUTS_REARM_MAX) >= 0
    ? Math.floor(Number(config.STOP_INPUTS_REARM_MAX))
    : 10;
  const rawRearm = Number(session.stop_inputs_rearm_remaining);
  const rearmRemaining = Number.isFinite(rawRearm) && rawRearm >= 0 ? Math.min(Math.floor(rawRearm), rearmMax) : 0;
  return res.json({
    session_id: session.session_id,
    stop_inputs_enabled: enabled,
    stop_inputs: normalized,
    stop_inputs_rearm_remaining: rearmRemaining,
    stop_inputs_rearm_max: rearmMax
  });
}

router.put('/:sessionId/stop-inputs', handlePutStopInputs);

// Toggle global stop_inputs_enabled flag
function handleToggleStopInputsEnabled(req, res) {
  const session = global.sessionManager.getSession(req.params.sessionId);
  if (session) {
    if (!mustOwnSession(req, session) && !hasManageAllSessions(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const enabledRaw = req.body && Object.prototype.hasOwnProperty.call(req.body, 'enabled')
      ? req.body.enabled
      : undefined;
    if (enabledRaw === undefined) {
      session.stop_inputs_enabled = session.stop_inputs_enabled === false ? true : false;
    } else {
      session.stop_inputs_enabled = enabledRaw !== false;
    }
    // Optional: update rearm counter when provided alongside enabled flag
    try {
      const body = req.body || {};
      let rawRearm;
      if (Object.prototype.hasOwnProperty.call(body, 'stop_inputs_rearm_remaining')) {
        rawRearm = body.stop_inputs_rearm_remaining;
      } else if (Object.prototype.hasOwnProperty.call(body, 'stop_inputs_rearm')) {
        rawRearm = body.stop_inputs_rearm;
      } else if (Object.prototype.hasOwnProperty.call(body, 'rearm_remaining')) {
        rawRearm = body.rearm_remaining;
      } else if (Object.prototype.hasOwnProperty.call(body, 'rearm')) {
        rawRearm = body.rearm;
      }
      if (rawRearm !== undefined) {
        const rearmMax = Number.isFinite(Number(config.STOP_INPUTS_REARM_MAX)) && Number(config.STOP_INPUTS_REARM_MAX) >= 0
          ? Math.floor(Number(config.STOP_INPUTS_REARM_MAX))
          : 10;
        const n = Number(rawRearm);
        session.stop_inputs_rearm_remaining = (Number.isFinite(n) && n >= 0)
          ? Math.min(Math.floor(n), rearmMax)
          : 0;
      }
    } catch (_) { /* best-effort */ }
    broadcastSessionUpdate(session, 'updated');
    const enabled = session.stop_inputs_enabled === false ? false : true;
    const rearmMax = Number.isFinite(Number(config.STOP_INPUTS_REARM_MAX)) && Number(config.STOP_INPUTS_REARM_MAX) >= 0
      ? Math.floor(Number(config.STOP_INPUTS_REARM_MAX))
      : 10;
    const rawRearm = Number(session.stop_inputs_rearm_remaining);
    const rearmRemaining = Number.isFinite(rawRearm) && rawRearm >= 0 ? Math.min(Math.floor(rawRearm), rearmMax) : 0;
    return res.json({
      session_id: session.session_id,
      stop_inputs_enabled: enabled,
      stop_inputs_rearm_remaining: rearmRemaining,
      stop_inputs_rearm_max: rearmMax
    });
  }
  return res.status(404).json({ error: 'Session not found' });
}

router.post('/:sessionId/stop-inputs/enabled', handleToggleStopInputsEnabled);

// Toggle an individual stop input's armed state
function handleToggleStopInput(req, res) {
  const session = global.sessionManager.getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (!mustOwnSession(req, session) && !hasManageAllSessions(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const inputId = req.params.inputId || req.params.promptId;
  const inputs = Array.isArray(session.stop_inputs) ? session.stop_inputs : [];
  const idx = inputs.findIndex(p => p && p.id === inputId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Stop input not found' });
  }
  const current = inputs[idx];
  const armedRaw = req.body && Object.prototype.hasOwnProperty.call(req.body, 'armed')
    ? req.body.armed
    : undefined;
  if (armedRaw === undefined) {
    current.armed = current.armed === false ? true : false;
  } else {
    current.armed = armedRaw !== false;
  }
  session.stop_inputs = inputs;
  broadcastSessionUpdate(session, 'updated');
  const enabled = session.stop_inputs_enabled === false ? false : true;
  const rearmMax = Number.isFinite(Number(config.STOP_INPUTS_REARM_MAX)) && Number(config.STOP_INPUTS_REARM_MAX) >= 0
    ? Math.floor(Number(config.STOP_INPUTS_REARM_MAX))
    : 10;
  const rawRearm = Number(session.stop_inputs_rearm_remaining);
  const rearmRemaining = Number.isFinite(rawRearm) && rawRearm >= 0 ? Math.min(Math.floor(rawRearm), rearmMax) : 0;
  return res.json({
    session_id: session.session_id,
    stop_inputs_enabled: enabled,
    stop_inputs: inputs,
    stop_inputs_rearm_remaining: rearmRemaining,
    stop_inputs_rearm_max: rearmMax
  });
}

router.post('/:sessionId/stop-inputs/:inputId/toggle', handleToggleStopInput);

// Update session note
router.put('/:sessionId/note', async (req, res) => {
  // Feature gate: notes must be enabled for this user
  try {
    const enabled = req?.user?.features && req.user.features.notes_enabled === true;
    if (!enabled) {
      return res.status(403).json({ error: 'Notes feature disabled', code: 'FEATURE_DISABLED' });
    }
  } catch (_) {}
  let session;
  try {
    session = await global.sessionManager.getSessionIncludingTerminated(req.params.sessionId);
  } catch (error) {
    logger.error(`[API] Failed to load session ${req.params.sessionId} for note update: ${error?.message || error}`);
    return res.status(500).json({ error: 'Failed to update note' });
  }

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  // Allow note edits according to visibility (public: any user; private/shared_readonly: owner only)
  if (!canEditNote(req, session)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { content, version } = req.body || {};
  if (content !== undefined && typeof content !== 'string') {
    return res.status(400).json({ error: 'Note content must be a string' });
  }
  if (version !== undefined && !Number.isInteger(version)) {
    return res.status(400).json({ error: 'Version must be an integer' });
  }

  const expectedVersion = Number.isInteger(version) ? version : session.note_version;

  try {
    const snapshot = session.updateNote(content ?? '', {
      expectedVersion,
      updatedBy: getRequestUsername(req)
    });

    if (!session.is_active) {
      try {
        await global.sessionManager.saveTerminatedSessionMetadata(session, { force: true });
      } catch (persistError) {
        logger.warning(`[API] Failed to persist note metadata for terminated session ${session.session_id}: ${persistError?.message || persistError}`);
      }
    }

    broadcastSessionUpdate(session, 'note_updated');

    res.json({ ...snapshot, session_id: session.session_id });
  } catch (error) {
    if (error && error.code === 'NOTE_VERSION_CONFLICT') {
      const latest = error.context?.latest || session.getNoteSnapshot();
      return res.status(409).json({
        error: 'Note update conflict',
        code: error.code,
        note: latest,
        context: { note: latest }
      });
    }

    logger.error(`[API] Failed to update note for session ${req.params.sessionId}: ${error?.message || error}`);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

// Shared helpers for search normalization and execution
function toBool(val, def = false) {
  if (typeof val === 'boolean') return val;
  if (val == null) return def;
  const s = String(val).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'n'].includes(s)) return false;
  return def;
}

function normalizeFromPost(body = {}) {
  const rawQuery = typeof body.query === 'string' ? body.query : '';
  const scope = typeof body.scope === 'string' && body.scope ? body.scope : undefined;
  const filterType = typeof body.filter_type === 'string' && body.filter_type ? body.filter_type : 'active';
  const idsOnly = toBool(body.ids_only, false);
  const params = (body.params && typeof body.params === 'object') ? body.params : {};
  const searchContent = toBool(body.search_content, false) || toBool(body.include_history, false);
  return {
    query: rawQuery,
    scope: (scope || filterType),
    params,
    ids_only: idsOnly,
    search_content: searchContent
  };
}

function normalizeFromGet(query = {}) {
  const rawQuery = typeof query.q === 'string' ? query.q : '';
  const scope = typeof query.scope === 'string' && query.scope ? query.scope : undefined;
  const filterType = typeof query.filter_type === 'string' && query.filter_type ? query.filter_type : 'active';
  const idsOnly = toBool(query.ids_only, false);
  const searchContent = toBool(query.search_content, false) || toBool(query.include_history, false);

  // Collect param.* and bare keys as filters
  const params = {};
  const allowedBareKeys = new Set(['issue_id', 'repo']);
  for (const [key, value] of Object.entries(query)) {
    if (key === 'q' || key === 'scope' || key === 'filter_type' || key === 'ids_only') continue;
    if (key.startsWith('param.')) {
      const k = key.slice('param.'.length);
      if (k) params[k] = Array.isArray(value) ? String(value[0]) : String(value);
      continue;
    }
    // Bare convenience keys (treat same as param.*) — allowlist to avoid accidental capture
    if (allowedBareKeys.has(key)) {
      params[key] = Array.isArray(value) ? String(value[0]) : String(value);
    }
  }

  return {
    query: rawQuery,
    scope: (scope || filterType),
    params,
    ids_only: idsOnly,
    search_content: searchContent
  };
}

async function performSessionSearch(req, normalized) {
  const { query, scope = 'active', params = {}, ids_only = false, search_content = false } = normalized || {};
  const haveQuery = typeof query === 'string' && query.trim().length > 0;
  const searchQuery = haveQuery ? query.trim().toLowerCase() : '';

  // Scope selection
  let sessions;
  if (scope === 'all') {
    sessions = await global.sessionManager.getAllSessionsIncludingTerminated();
  } else if (scope === 'inactive') {
    const allSessions = await global.sessionManager.getAllSessionsIncludingTerminated();
    sessions = allSessions.filter(s => !s.is_active);
  } else {
    sessions = global.sessionManager.getActiveSessions();
  }

  // Visibility filter first
  const filteredByVisibility = sessions.filter(s => canAccessSessionFromRequest(req, s));

  // Parameter filters (equality match on template_parameters)
  const entries = Object.entries(params || {}).filter(([k, v]) => k && v != null && String(v).length > 0);
  let filtered = filteredByVisibility;
  if (entries.length > 0) {
    filtered = filteredByVisibility.filter(session => {
      const tp = session?.template_parameters || {};
      for (const [k, v] of entries) {
        if (String(tp[k]) !== String(v)) return false;
      }
      return true;
    });
  }

  // If no query and no params, return empty (preserve old behavior of requiring a signal)
  if (!haveQuery && entries.length === 0) {
    return [];
  }

  // Apply text search when query is provided
  const results = [];
  for (const session of filtered) {
    let isMatch = !haveQuery; // when only filters provided, it's already a match
    if (haveQuery) {
      // Fast checks: command, title, dynamic_title
      const cmd = String(session.command || '').toLowerCase();
      const title = String(session.title || '').toLowerCase();
      const dyn = String(session.dynamic_title || '').toLowerCase();
      if (cmd.includes(searchQuery) || title.includes(searchQuery) || dyn.includes(searchQuery)) {
        isMatch = true;
      } else if (search_content) {
        // History lookup (slower; optional). Prefer pre-rendered HTML when available.
        try {
          const sess = await global.sessionManager.getSessionIncludingTerminated(session.session_id, { loadFromDisk: true });
          const content = await getSearchableHistoryText(sess);
          if (content && content.toLowerCase().includes(searchQuery)) {
            isMatch = true;
          }
        } catch (error) {
          logger.warning(`Could not search history for session ${session.session_id}: ${error.message}`);
        }
      }
    }

    if (isMatch) results.push(session);
  }

  // Sort newest first
  results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (ids_only) {
    return results.map(s => s.session_id);
  }
  return results.map(s => serializeSessionForSearch(s));
}

// Search sessions endpoint (POST)
router.post('/search', async (req, res) => {
  try {
    const normalized = normalizeFromPost(req.body || {});
    const matches = await performSessionSearch(req, normalized);
    res.json(matches);
  } catch (error) {
    logger.error(`Error searching sessions: ${error.message}`);
    res.status(500).json({ error: 'Failed to search sessions', details: error.message });
  }
});

// (moved earlier to avoid '/:sessionId' GET route conflict)

// History endpoints - moved from separate history router to fix NGINX prefix issue (Issue #358)

// Get all sessions including terminated (used by frontend for sessions with history)
router.get('/history/all', async (req, res) => {
  try {
    const username = getRequestUsername(req);
    const sessions = await global.sessionManager.getAllSessionsIncludingTerminated();
    const sessionList = sessions
      .filter(s => hasManageAllSessions(req) || !isPrivate(s) || String(s.created_by) === String(username))
      .map(session => serializeSessionForHistoryList(session));
    res.json(sessionList);
  } catch (error) {
    logger.error(`Error getting sessions with history: ${error.message}`);
    res.status(500).json({ error: 'Failed to get sessions with history', details: error.message });
  }
});

// Get paginated session history (metadata only - efficient for table view)
router.get('/history/paginated', async (req, res) => {
  try {
    const username = getRequestUsername(req);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    const template = req.query.template || '';
    const sortBy = req.query.sortBy || 'created_at';
    const sortOrder = req.query.sortOrder || 'desc';
    const dateFilter = req.query.dateFilter || 'all';
    
    // Get all terminated sessions (we only want inactive sessions for history view)
    const allSessions = await global.sessionManager.getAllSessionsIncludingTerminated();
    const terminatedSessions = allSessions
      .filter(session => !session.is_active)
      .filter(s => hasManageAllSessions(req) || !isPrivate(s) || String(s.created_by) === String(username));
    
    // Apply search filter
    let filteredSessions = terminatedSessions;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredSessions = terminatedSessions.filter(session => {
        return (
          (session.session_id && session.session_id.toLowerCase().includes(searchLower)) ||
          (session.command && session.command.toLowerCase().includes(searchLower)) ||
          (session.working_directory && session.working_directory.toLowerCase().includes(searchLower)) ||
          (session.title && session.title.toLowerCase().includes(searchLower)) ||
          (session.template_name && session.template_name.toLowerCase().includes(searchLower))
        );
      });
    }
    
    // Apply template filter
    if (template && template !== 'all') {
      filteredSessions = filteredSessions.filter(session => session.template_name === template);
    }
    
    // Apply date filter
    if (dateFilter !== 'all') {
      const now = new Date();
      let filterDate;
      
      switch (dateFilter) {
        case 'today':
          filterDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          filterDate = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
          break;
        case 'month':
          filterDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
      }
      
      if (filterDate) {
        filteredSessions = filteredSessions.filter(session => {
          // created_at is stored as an ISO 8601 string; parse directly
          const sessionDate = new Date(session.created_at);
          return sessionDate >= filterDate;
        });
      }
    }
    
    // Sort sessions
    filteredSessions.sort((a, b) => {
      let aValue = a[sortBy];
      let bValue = b[sortBy];
      
      // Handle null/undefined values
      if (aValue == null && bValue == null) return 0;
      if (aValue == null) return sortOrder === 'asc' ? -1 : 1;
      if (bValue == null) return sortOrder === 'asc' ? 1 : -1;
      
      let comparison = 0;
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        comparison = aValue.toLowerCase().localeCompare(bValue.toLowerCase());
      } else {
        comparison = aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      }
      
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    
    // Calculate pagination
    const total = filteredSessions.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const paginatedSessions = filteredSessions.slice(offset, offset + limit);
    
    // Format response (metadata only, no log content)
    const sessionList = paginatedSessions.map(session => serializeSessionForPaginatedHistory(session));
    
    // Get available templates for filter dropdown
    const availableTemplates = [...new Set(
      terminatedSessions
        .map(session => session.template_name)
        .filter(template => template && template.trim())
    )].sort();
    
    res.json({
      sessions: sessionList,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: {
        availableTemplates
      }
    });
  } catch (error) {
    logger.error(`Error getting paginated session history: ${error.message}`);
    res.status(500).json({ error: 'Failed to get paginated session history', details: error.message });
  }
});

// Get session history (metadata only)
router.get('/:sessionId/history', async (req, res) => {
  try {
    const history = await global.sessionManager.getSessionHistory(req.params.sessionId);
    if (history) {
      // Enforce privacy unless user can manage all sessions
      if (!hasManageAllSessions(req) && history.visibility === 'private' && String(history.created_by || '') !== String(getRequestUsername(req))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      // Remove bulky output payloads from JSON responses; metadata only
      try { if ('output_history' in history) delete history.output_history; } catch (_) {}
      res.json(history);
    } else {
      res.status(404).json({ error: 'Session history not found' });
    }
  } catch (error) {
    logger.error(`Error getting session history: ${error.message}`);
    res.status(500).json({ error: 'Failed to get session history', details: error.message });
  }
});

// Get pre-rendered HTML history for terminated sessions
router.get('/:sessionId/history/html', async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const session = await global.sessionManager.getSessionIncludingTerminated(sessionId, { loadFromDisk: true });
    if (!session) return res.status(404).json({ error: 'Session HTML history not found' });
    if (!canAccessSessionFromRequest(req, session)) return res.status(403).json({ error: 'Forbidden' });

    const htmlFile = (() => {
      try {
        if (session.history_html_file && typeof session.history_html_file === 'string' && session.history_html_file.trim()) {
          const base = session.history_html_file.trim();
          // Defensive guard: do not allow path separators in the stored filename
          if (base.includes('/') || base.includes('\\')) {
            return '__INVALID__';
          }
          return path.join(session.script_logs_dir, base);
        }
        return path.join(session.script_logs_dir, `${session.session_id}.html`);
      } catch (_) {
        return null;
      }
    })();

    if (!htmlFile) return res.status(404).json({ error: 'Session HTML history not found' });
    if (htmlFile === '__INVALID__') {
      return res.status(400).json({ error: 'Invalid session HTML history reference' });
    }

    try {
      const st = await fs.promises.stat(htmlFile).catch(() => null);
      if (!st || !st.isFile()) {
        return res.status(404).json({ error: 'Session HTML history not found' });
      }
    } catch (_) {
      return res.status(404).json({ error: 'Session HTML history not found' });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const stream = fs.createReadStream(htmlFile, { encoding: 'utf8' });
    stream.on('error', (e) => {
      try { logger.error(`[API] Failed to stream HTML history for ${sessionId}: ${e?.message || e}`); } catch (_) {}
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream session HTML history' });
      try { stream.destroy(); } catch (_) {}
    });
    return stream.pipe(res);
  } catch (error) {
    logger.error(`[API] Error getting HTML history for ${sessionId}: ${error?.message || error}`);
    return res.status(500).json({ error: 'Failed to stream session HTML history' });
  }
});

// Raw history streaming (HEAD): provide size hints when available
router.head('/:sessionId/history/raw', async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const session = await global.sessionManager.getSessionIncludingTerminated(sessionId, { loadFromDisk: true });
    if (!session) return res.status(404).end();
    if (!canAccessSessionFromRequest(req, session)) return res.status(403).end();

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Accept-Ranges', 'bytes');

    const fs = await import('fs');
    const path = await import('path');
    try {
      const logPath = session.script_log_file
        ? path.join(session.script_logs_dir, session.script_log_file)
        : null;
      if (logPath) {
        const st = await fs.promises.stat(logPath).catch(() => null);
        if (st && Number.isFinite(st.size)) res.setHeader('Content-Length', String(st.size));
      } else if (typeof session.outputHistory === 'string') {
        const bytes = Buffer.byteLength(session.outputHistory, 'utf8');
        res.setHeader('Content-Length', String(bytes));
      }
    } catch (_) { /* best-effort */ }
    return res.status(200).end();
  } catch (error) {
    logger.error(`[API] HEAD raw history failed for ${sessionId}: ${error?.message || error}`);
    return res.status(500).end();
  }
});

// Raw history streaming (GET): stream text/plain with Range support
router.get('/:sessionId/history/raw', async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const session = await global.sessionManager.getSessionIncludingTerminated(sessionId, { loadFromDisk: true });
    if (!session) return res.status(404).json({ error: 'Session history not found' });
    if (!canAccessSessionFromRequest(req, session)) return res.status(403).json({ error: 'Forbidden' });

    const fs = await import('fs');
    const path = await import('path');
    const rangeHeader = req.headers?.range ? String(req.headers.range) : '';
    const sinceOffset = (() => {
      const v = req.query && req.query.since_offset != null ? Number(req.query.since_offset) : null;
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
    })();
    const tailBytes = (() => {
      const v = req.query && req.query.tail_bytes != null ? Number(req.query.tail_bytes) : null;
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
    })();

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Accept-Ranges', 'bytes');

    // Prefer file-backed history when available
    const logPath = session.script_log_file
      ? path.join(session.script_logs_dir, session.script_log_file)
      : null;

    if (logPath) {
      const st = await fs.promises.stat(logPath).catch(() => null);
      if (!st || !Number.isFinite(st.size)) {
        return res.status(404).json({ error: 'Session history not found' });
      }
      const total = st.size;
      // If file exists but is empty, return 200 with empty body (avoid invalid stream range)
      if (total === 0) {
        res.setHeader('Content-Length', '0');
        return res.status(200).end('');
      }
      let start = 0;
      let end = total - 1;
      // Apply Range header
      if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
        const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
        if (m) {
          // Per HTTP spec, "bytes=-N" means last N bytes (suffix range)
          // "bytes=-0" should return empty content, not byte 0
          if (m[1] === '' && m[2] !== '') {
            // Suffix range: last N bytes
            const suffixLen = parseInt(m[2], 10);
            if (suffixLen === 0) {
              // bytes=-0 is a degenerate case; return full content instead of empty
              // This handles buggy clients that send bytes=-0 when they want all content
              start = 0;
              end = total - 1;
            } else {
              start = Math.max(0, total - suffixLen);
              end = total - 1;
            }
          } else {
            if (m[1] !== '') start = Math.max(0, Math.min(total - 1, parseInt(m[1], 10)));
            if (m[2] !== '') end = Math.max(start, Math.min(total - 1, parseInt(m[2], 10)));
          }
        }
      }
      // Apply query helpers (take precedence when present)
      if (sinceOffset !== null) {
        start = Math.max(0, Math.min(total, sinceOffset));
        end = total - 1;
      } else if (tailBytes !== null) {
        const tb = Math.min(total, tailBytes);
        start = Math.max(0, total - tb);
        end = total - 1;
      }
      const chunkSize = (end >= start) ? (end - start + 1) : 0;

      if (chunkSize < total) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      }
      res.setHeader('Content-Length', String(chunkSize));

      const stream = fs.createReadStream(logPath, { start, end, encoding: 'utf8' });
      stream.on('error', (e) => {
        try { logger.error(`[API] Stream error for ${sessionId}: ${e?.message || e}`); } catch (_) {}
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream history' });
        try { stream.destroy(); } catch (_) {}
      });
      return stream.pipe(res);
    }

    // Fallback to in-memory buffer for active sessions without file yet
    const raw = typeof session.outputHistory === 'string' ? session.outputHistory : '';
    const buf = Buffer.from(raw, 'utf8');
    const total = buf.length;
    let start = 0;
    let end = Math.max(0, total - 1);
    if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
      const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (m) {
        // Per HTTP spec, "bytes=-N" means last N bytes (suffix range)
        // "bytes=-0" should return empty content, not byte 0
        if (m[1] === '' && m[2] !== '') {
          // Suffix range: last N bytes
          const suffixLen = parseInt(m[2], 10);
          if (suffixLen === 0) {
            // bytes=-0 is a degenerate case; return full content instead of empty
            start = 0;
            end = Math.max(0, total - 1);
          } else {
            start = Math.max(0, total - suffixLen);
            end = Math.max(0, total - 1);
          }
        } else {
          if (m[1] !== '') start = Math.max(0, Math.min(total - 1, parseInt(m[1], 10)));
          if (m[2] !== '') end = Math.max(start, Math.min(total - 1, parseInt(m[2], 10)));
        }
      }
    }
    if (sinceOffset !== null) {
      start = Math.max(0, Math.min(total, sinceOffset));
      end = Math.max(0, total - 1);
    } else if (tailBytes !== null) {
      const tb = Math.min(total, tailBytes);
      start = Math.max(0, total - tb);
      end = Math.max(0, total - 1);
    }
    const slice = buf.subarray(start, end + 1);
    if (slice.length < total) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    }
    res.setHeader('Content-Length', String(slice.length));
    return res.end(slice);
  } catch (error) {
    logger.error(`[API] Failed to stream raw history for ${req.params.sessionId}: ${error?.message || error}`);
    return res.status(500).json({ error: 'Failed to stream session history' });
  }
});

// Delete session history
router.delete('/:sessionId/history', async (req, res) => {
  try {
    const sid = req.params.sessionId;
    // Determine session visibility/ownership
    let session = global.sessionManager.getSession(sid);
    if (!session) {
      // Try terminated sessions set by loading history
      const history = await global.sessionManager.getSessionHistory(sid);
      if (!history) return res.status(404).json({ error: 'Session history not found' });
      // Fabricate a minimal session-like object for permission check
      session = { visibility: history.visibility || 'private', created_by: history.created_by };
    }
    if (!canClearHistory(req, session)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const success = await global.sessionManager.deleteSessionHistory(sid);
    if (success) {
      res.json({ message: 'Session history deleted successfully' });
    } else {
      res.status(404).json({ error: 'Session history not found' });
    }
  } catch (error) {
    logger.error(`Error deleting session history: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete session history', details: error.message });
  }
});

// Update session visibility
const handleSessionVisibilityUpdate = createSessionVisibilityHandler(mustOwnSession);

router.put('/:sessionId/visibility', handleSessionVisibilityUpdate);

export default router;

// Test-only exports (not part of the public API surface)
export {
  handleWorkspaceInfo as _handleWorkspaceInfoForTest,
  handleWorkspaceList as _handleWorkspaceListForTest,
  handleWorkspaceGetFile as _handleWorkspaceGetFileForTest,
  handleWorkspacePutFile as _handleWorkspacePutFileForTest,
  handleWorkspaceDeleteFile as _handleWorkspaceDeleteFileForTest
};
const WORKSPACE_MACRO_PLACEHOLDER = '__SESSION_WORKSPACE_DIR__';
// Resolve :sessionId params by falling back to alias mapping when needed
router.param('sessionId', (req, _res, next, value) => {
  try {
    const v = String(value || '').trim();
    if (!v) return next();
    const resolved = global.sessionManager?.resolveIdFromAliasOrId?.(v) || v;
    req.params.sessionId = resolved;
  } catch (_) {}
  next();
});
