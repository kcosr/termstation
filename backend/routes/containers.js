/**
 * Containers API Routes
 * Lists running containers for connection actions
 */

import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { config } from '../config-loader.js';
import { listContainersNormalized, buildExecCommandForShell, buildExecCommandForCommand, stopContainer, getRuntimeBin, getRuntimeName } from '../utils/runtime.js';
import { workspaceManager } from '../managers/workspace-manager.js';

export const router = express.Router();

const execFileAsync = promisify(execFile);

async function listWithRuntime(includeAll = false) {
  return listContainersNormalized(includeAll, config.CONTAINER_RUNTIME_USER || 'developer');
}

// GET /api/containers - list containers from configured runtime
router.get('/', async (req, res) => {
  try {
    if (global.isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down', status: 'shutting_down' });
    }

    const list = await listWithRuntime(false);
    const containers = (Array.isArray(list) ? list : []).map((c) => ({
      id: c.id,
      name: c.name,
      image: c.image,
      status: c.status,
      created: c.created,
      ports: c.ports,
      session_id: (c.labels && (c.labels.session_id || c.labels.SESSION_ID)) || null,
      labels: c.labels || null,
      raw: c.raw,
    }));

    logger.info(`[API] GET /api/containers -> ${containers.length} found via ${config.CONTAINER_RUNTIME} as ${config.CONTAINER_RUNTIME_USER}`);
    return res.json({ containers });
  } catch (error) {
    logger.error(`[API] /api/containers error: ${error.message}`);
    res.status(500).json({ error: 'Failed to list containers', details: error.message });
  }
});

// POST /api/containers/attach - create a session attached to a container
router.post('/attach', async (req, res) => {
  try {
    if (global.isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down', status: 'shutting_down' });
    }

    // Enforce permission: sandbox_login
    try {
      const allowed = req?.user?.permissions?.sandbox_login === true;
      if (!allowed) {
        return res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_ERROR', message: 'Sandbox login permission required' });
      }
    } catch (_) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    const nameRaw = req.body?.name;
    if (!nameRaw || typeof nameRaw !== 'string' || !nameRaw.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const name = nameRaw.trim();

    // Validate container exists for the configured user (best-effort)
    let exists = false;
    let matchedContainer = null;
    try {
      const list = await listWithRuntime(false);
      for (const c of list) {
        const id = c.id || '';
        const nm = c.name || '';
        if (id.startsWith(name) || nm === name) {
          exists = true;
          matchedContainer = c;
          break;
        }
      }
    } catch (e) {
      // If listing fails, proceed to attempt exec anyway
      logger.debug(`[API] attach: container list check failed: ${e.message}`);
    }

    if (!exists) {
      logger.warning(`[API] attach: container '${name}' not found for user ${config.CONTAINER_RUNTIME_USER}`);
      return res.status(404).json({ error: `Container '${name}' not found` });
    }

    const extractParentFromRef = (value) => {
      if (!value || typeof value !== 'string') return null;
      const match = value.match(/sandbox-([a-f0-9-]{6,})/i);
      return match && match[1] ? match[1] : null;
    };

    const parentFromBodyRaw = typeof req.body?.parent_session_id === 'string'
      ? req.body.parent_session_id.trim()
      : '';

    let parentSessionId = parentFromBodyRaw || null;
    if (!parentSessionId) {
      const labels = matchedContainer?.labels || matchedContainer?.Labels || {};
      const labelParent = labels.session_id || labels.SESSION_ID;
      if (typeof labelParent === 'string' && labelParent.trim()) {
        parentSessionId = labelParent.trim();
      }
    }

    if (!parentSessionId) {
      const nameSource = matchedContainer?.name || name;
      parentSessionId = extractParentFromRef(nameSource) || extractParentFromRef(name);
    }

    if (parentSessionId) {
      logger.info(`[API] attach: resolved parent session '${parentSessionId}' for container '${name}'`);
    } else {
      logger.warning(`[API] attach: unable to resolve parent session for container '${name}'`);
    }

    // Build server-enforced command (run as configured container user)
    const user = config.CONTAINER_RUNTIME_USER || 'developer';
    const command = buildExecCommandForShell(name, 'bash', user);

    // Determine a friendly default title for child container sessions that matches UI tab labeling
    let defaultTitle = `container:${name}`;
    try {
      if (parentSessionId) {
        const existing = Array.isArray(global.sessionManager?.getAllSessions?.())
          ? global.sessionManager.getAllSessions().filter(s => s && s.parent_session_id === parentSessionId)
          : [];
        const nextIndex = (existing && existing.length > 0) ? (existing.length + 1) : 1;
        defaultTitle = nextIndex > 1 ? `Shell ${nextIndex}` : 'Shell';
      }
    } catch (_) { /* keep fallback */ }

    // Create a terminal session via the SessionManager directly
    const sessionOptions = {
      command,
      working_directory: config.DEFAULT_WORKING_DIR,
      interactive: true,
      title: defaultTitle,
      created_by: req.user?.username || config.DEFAULT_USERNAME,
      workspace: 'Default',
      container_name: name,
      container_runtime: config.CONTAINER_RUNTIME,
      parent_session_id: parentSessionId
    };

    const session = await global.sessionManager.createSession(sessionOptions);
    session.outputBroadcaster = (sessionId, data) => {
      global.sessionManager.broadcastSessionOutput(sessionId, data);
    };

    // Broadcast creation to all clients
    const originClientId = typeof req.body?.client_id === 'string' ? req.body.client_id : null;
    const sessionData = session.toResponseObject();
    if (originClientId) {
      sessionData.origin_client_id = originClientId;
    }

    try {
      const payload = {
        type: 'session_updated',
        update_type: 'created',
        session_data: sessionData
      };
      global.connectionManager.broadcast(payload);
    } catch (e) {
      logger.warning(`[API] attach: broadcast failed: ${e.message}`);
    }

    // Ensure workspace exists for the owner (auto-create only when not 'Default')
    try {
      const wsName = 'Default';
      // Default workspace is implicit; no need to add/broadcast
    } catch (e) {
      logger.warning(`[API] attach: workspace ensure outer failed: ${e.message}`);
    }

    logger.info(`[API] Container attach created session ${session.session_id} for '${name}' as ${user} in workspace 'Default'`);
    return res.json(sessionData);
  } catch (error) {
    logger.error(`[API] /api/containers/attach error: ${error.message}`);
    res.status(500).json({ error: 'Failed to attach container', details: error.message });
  }
});

export default router;

// POST /api/containers/exec - create a session to run a one-liner command in a container
router.post('/exec', async (req, res) => {
  try {
    if (global.isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down', status: 'shutting_down' });
    }

    // Enforce permission: sandbox_login (reuse login permission for exec)
    try {
      const allowed = req?.user?.permissions?.sandbox_login === true;
      if (!allowed) {
        return res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_ERROR', message: 'Sandbox login permission required' });
      }
    } catch (_) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    const nameRaw = req.body?.name;
    const cmdRaw = req.body?.command;
    if (!nameRaw || typeof nameRaw !== 'string' || !nameRaw.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!cmdRaw || typeof cmdRaw !== 'string' || !cmdRaw.trim()) {
      return res.status(400).json({ error: 'command is required' });
    }
    const name = nameRaw.trim();
    const oneLiner = cmdRaw.trim();

    // Validate container exists (best-effort)
    let exists = false;
    let matchedContainer = null;
    try {
      const list = await listWithRuntime(false);
      for (const c of list) {
        const id = c.id || '';
        const nm = c.name || '';
        if (id.startsWith(name) || nm === name) {
          exists = true;
          matchedContainer = c;
          break;
        }
      }
    } catch (e) {
      logger.debug(`[API] exec: container list check failed: ${e.message}`);
    }

    if (!exists) {
      logger.warning(`[API] exec: container '${name}' not found for user ${config.CONTAINER_RUNTIME_USER}`);
      return res.status(404).json({ error: `Container '${name}' not found` });
    }

    // Determine parent session id (by label or provided)
    const extractParentFromRef = (value) => {
      if (!value || typeof value !== 'string') return null;
      const match = value.match(/sandbox-([a-f0-9-]{6,})/i);
      return match && match[1] ? match[1] : null;
    };
    const parentFromBodyRaw = typeof req.body?.parent_session_id === 'string'
      ? req.body.parent_session_id.trim()
      : '';
    let parentSessionId = parentFromBodyRaw || null;
    if (!parentSessionId) {
      const labels = matchedContainer?.labels || matchedContainer?.Labels || {};
      const labelParent = labels.session_id || labels.SESSION_ID;
      if (typeof labelParent === 'string' && labelParent.trim()) {
        parentSessionId = labelParent.trim();
      }
    }
    if (!parentSessionId) {
      const nameSource = matchedContainer?.name || name;
      parentSessionId = extractParentFromRef(nameSource) || extractParentFromRef(name);
    }

    // Title for the child session (optional explicit title, else from command)
    const titleRaw = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    let defaultTitle = titleRaw || oneLiner.split('\n')[0].slice(0, 80) || 'Command';

    // Build the exec command
    const command = buildExecCommandForCommand(name, oneLiner, config.CONTAINER_RUNTIME_USER || 'developer');

    const sessionOptions = {
      command,
      working_directory: config.DEFAULT_WORKING_DIR,
      interactive: true,
      title: defaultTitle,
      created_by: req.user?.username || config.DEFAULT_USERNAME,
      workspace: 'Default',
      container_name: name,
      container_runtime: config.CONTAINER_RUNTIME,
      parent_session_id: parentSessionId,
      // Mark as a special child from a command tab and hide in sidebar lists
      child_tab_type: 'command',
      show_in_sidebar: false
    };

    const session = await global.sessionManager.createSession(sessionOptions);
    session.outputBroadcaster = (sessionId, data) => {
      global.sessionManager.broadcastSessionOutput(sessionId, data);
    };

    const originClientId = typeof req.body?.client_id === 'string' ? req.body.client_id : null;
    const sessionData = session.toResponseObject();
    if (originClientId) {
      sessionData.origin_client_id = originClientId;
    }

    try {
      const payload = {
        type: 'session_updated',
        update_type: 'created',
        session_data: sessionData
      };
      global.connectionManager.broadcast(payload);
    } catch (e) {
      logger.warning(`[API] exec: broadcast failed: ${e.message}`);
    }

    logger.info(`[API] Container exec created child session ${session.session_id} for '${name}'`);
    return res.json(sessionData);
  } catch (error) {
    logger.error(`[API] /api/containers/exec error: ${error.message}`);
    res.status(500).json({ error: 'Failed to exec in container', details: error.message });
  }
});

// GET /api/containers/lookup?session_id=<sid>&include_stopped=true|false
router.get('/lookup', async (req, res) => {
  try {
    if (global.isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down', status: 'shutting_down' });
    }

    const sidRaw = req.query?.session_id;
    const includeStopped = String(req.query?.include_stopped || 'false').toLowerCase() === 'true';
    if (!sidRaw || typeof sidRaw !== 'string' || !sidRaw.trim()) {
      return res.status(400).json({ error: 'session_id is required' });
    }
    const sid = sidRaw.trim();

    // Fetch containers (optionally including stopped)
    const list = await listWithRuntime(includeStopped);

    // Normalize and filter matches by label
    const normalize = (c) => ({
      id: c.Id || c.ID || c.IdFull || null,
      name: Array.isArray(c.Names) ? c.Names[0] : (c.Names || c.Name || null),
      image: c.Image || c.ImageName || null,
      status: c.Status || c.State || null,
      created: c.Created || c.CreatedAt || null,
      ports: c.Ports || c.Port || null,
      labels: c.labels || null,
      raw: c.raw,
    });

    const matches = [];
    for (const c of list) {
      const labels = c?.Labels || {};
      const s1 = labels.session_id;
      const s2 = labels.SESSION_ID;
      if (s1 === sid || s2 === sid) {
        matches.push(normalize(c));
      }
    }

    if (matches.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Helper to parse created time
    const parseTime = (t) => {
      if (!t) return 0;
      if (typeof t === 'number') return t > 1e12 ? t : t * 1000;
      const num = Number(t);
      if (!Number.isNaN(num) && num !== 0) return num > 1e12 ? num : num * 1000;
      const ms = Date.parse(t);
      return Number.isNaN(ms) ? 0 : ms;
    };
    const isRunning = (s) => /up|running/i.test(String(s || ''));

    // Choose best match: running first, then newest by created
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

    logger.info(`[API] GET /api/containers/lookup sid=${sid} -> ${matches.length} matches, best=${best?.id || best?.name || 'n/a'}`);
    return res.json({ best_match: best, matches });
  } catch (error) {
    logger.error(`[API] /api/containers/lookup error: ${error.message}`);
    res.status(500).json({ error: 'Failed to lookup container', details: error.message });
  }
});

// POST /api/containers/stop - stop a container by name or id
router.post('/stop', async (req, res) => {
  try {
    if (global.isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down', status: 'shutting_down' });
    }

    const nameRaw = req.body?.name || req.body?.id || req.body?.name_or_id;
    if (!nameRaw || typeof nameRaw !== 'string' || !nameRaw.trim()) {
      return res.status(400).json({ error: 'name (or id) is required' });
    }
    const ref = nameRaw.trim();

    // Execute stop as configured user for the chosen runtime
    const user = config.CONTAINER_RUNTIME_USER || 'developer';
    try {
      const { stdout, stderr } = await stopContainer(ref, user);
      logger.info(`[API] POST /api/containers/stop '${ref}' -> success`);
      return res.json({ status: 'stopped', ref, stdout: stdout || '', stderr: stderr || '' });
    } catch (e) {
      logger.error(`[API] /api/containers/stop '${ref}' failed: ${e.message}`);
      return res.status(500).json({ error: `Failed to stop container '${ref}'`, details: e.message });
    }
  } catch (error) {
    logger.error(`[API] /api/containers/stop error: ${error.message}`);
    res.status(500).json({ error: 'Failed to stop container', details: error.message });
  }
});

// POST /api/containers/terminate-all - remove all containers and volumes for the configured runtime user
router.post('/terminate-all', async (req, res) => {
  try {
    if (global.isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down', status: 'shutting_down' });
    }

    // Enforce permission: terminate_containers
    try {
      const allowed = req?.user?.permissions?.terminate_containers === true;
      if (!allowed) {
        return res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_ERROR', message: 'terminate_containers permission required' });
      }
    } catch (_) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    // Check if there are any containers using the same listing used by the page
    let count = 0;
    try {
      const list = await listWithRuntime(false);
      count = Array.isArray(list) ? list.length : 0;
    } catch (e) {
      // If listing fails, continue with termination attempt
      logger.debug(`[API] terminate-all: list check failed: ${e.message}`);
    }

    const runUser = config.CONTAINER_RUNTIME_USER || 'developer';
    const bin = getRuntimeBin();
    const name = getRuntimeName();

    // Build robust cleanup script for either podman or docker
    // - remove all containers (if any)
    // - remove all volumes (if any)
    // Use bash -lc for command substitution and ensure non-fatal on empty lists
    // Note: do not join with '&&' across if/then blocks; use newlines
    const cleanupScript = `set -e
ids=$(${bin} ps -aq 2>/dev/null || true)
if [ -n "$ids" ]; then
  ${bin} rm -f $ids >/dev/null 2>&1 || true
fi
vols=$(${bin} volume ls -q 2>/dev/null || true)
if [ -n "$vols" ]; then
  ${bin} volume rm $vols >/dev/null 2>&1 || true
fi`;

    try {
      // Execute cleanup as the current backend user. Containers are started rootless
      // under the backend user (see buildRunCommand mapping of UID/GID), so sudo is
      // not required and may fail when passwordless sudo is not configured.
      const { stdout, stderr } = await execFileAsync('bash', ['-lc', cleanupScript], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
      logger.info(`[API] POST /api/containers/terminate-all -> success via ${name} (pre-count=${count})`);
      return res.json({ status: 'ok', runtime: name, user: runUser, pre_count: count, stdout: stdout || '', stderr: stderr || '' });
    } catch (e) {
      logger.error(`[API] /api/containers/terminate-all failed: ${e.message}`);
      return res.status(500).json({ error: 'Failed to terminate containers', details: e.message });
    }
  } catch (error) {
    logger.error(`[API] /api/containers/terminate-all error: ${error.message}`);
    res.status(500).json({ error: 'Failed to terminate containers', details: error.message });
  }
});
