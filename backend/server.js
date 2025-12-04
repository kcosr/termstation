#!/usr/bin/env node

/**
 * termstation Backend
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import net from 'net';

// Configuration and loaders
import { config } from './config-loader.js';
import { templateLoader } from './template-loader.js';

// Utilities
import { logger } from './utils/logger.js';
import { usersConfigCache, groupsConfigCache } from './utils/json-config-cache.js';

// Managers
import { SessionManager } from './managers/session-manager.js';
import { ConnectionManager } from './managers/connection-manager.js';
import { InputScheduler } from './managers/input-scheduler.js';

// Routes
import sessionsRouter from './routes/sessions.js';
import serviceProxyRouter from './routes/service-proxy.js';
import systemRouter from './routes/system.js';
import workspacesRouter from './routes/workspaces.js';
import containersRouter from './routes/containers.js';
import usersRouter from './routes/users.js';
import notificationsRouter from './routes/notifications.js';

// Authentication middleware
import { basicAuth } from './middleware/auth.js';
import { resolveBooleanDomain } from './utils/access-resolver.js';
import { PERMISSION_KEYS, PERMISSION_DEFAULTS } from './constants/access-keys.js';
import { authenticateRequestByCookie } from './utils/session-cookie.js';
import { verifySessionToken } from './utils/session-cookie.js';

// WebSocket handlers
import { messageHandlers } from './websocket/handlers.js';
import { NotificationManager } from './managers/notification-manager.js';
import { stopContainersForSessionIds } from './utils/runtime.js';
import http from 'http';
import { runAutoStartTemplates } from './services/auto-start.js';
import { handleServiceProxyUpgrade } from './service-proxy-upgrade.js';

// Early configuration sanity checks
try {
  const mode = String(config.TERMINATED_HISTORY_VIEW_MODE || 'text').trim().toLowerCase();
  const helper = (config.PTY_TO_HTML_PATH || '').trim();
  if (mode === 'html' && !helper) {
    logger.warning('[Config] TERMINATED_HISTORY_VIEW_MODE is set to \"html\" but PTY_TO_HTML_PATH is empty; terminated sessions will not have HTML history until configured.');
  }
} catch (_) {
  // Best-effort only; do not block startup
}

// Initialize managers
const sessionManager = new SessionManager();
const connectionManager = new ConnectionManager();
const inputScheduler = new InputScheduler();
const notificationManager = new NotificationManager();

// Make managers globally available for routes and handlers
global.sessionManager = sessionManager;
global.connectionManager = connectionManager;
global.notificationManager = notificationManager;
global.inputScheduler = inputScheduler;

// Global shutdown state
global.isShuttingDown = false;

// Express app setup
const app = express();
// Multiple listeners will be created from this app
const servers = [];

// Honor reverse proxy headers (e.g., X-Forwarded-Proto) so req.secure reflects HTTPS
// This complements explicit header checks used in cookie helpers
app.set('trust proxy', true);

// CORS middleware
// Reflect request Origin when config uses "*" so that credentials work.
let corsOriginOption;
try {
  const allowed = config.CORS_ORIGINS;
  if (allowed === '*' || (Array.isArray(allowed) && allowed.includes('*'))) {
    // Reflect the request origin (required when credentials are enabled)
    corsOriginOption = true;
  } else if (Array.isArray(allowed)) {
    corsOriginOption = function (origin, callback) {
      // Allow non-CORS requests (e.g., curl without Origin)
      if (!origin) return callback(null, true);
      return callback(null, allowed.includes(origin));
    };
  } else if (typeof allowed === 'string' && allowed) {
    corsOriginOption = allowed;
  } else {
    corsOriginOption = true; // safe default for local app usage
  }
} catch (_) {
  corsOriginOption = true;
}

const corsOptions = {
  origin: corsOriginOption,
  credentials: Boolean(config.CORS_CREDENTIALS),
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
// Ensure preflight requests are handled
app.options('*', cors(corsOptions));

// Mount service-proxy routes BEFORE body parsers so request bodies are not consumed.
// This preserves raw streaming for POST/PUT/PATCH proxied into container services.
try {
  if (config.PROXY_CONTAINER_SERVICES !== false) {
    app.use('/api/sessions', basicAuth, serviceProxyRouter);
  }
} catch (_) {
  app.use('/api/sessions', basicAuth, serviceProxyRouter);
}

// Increase body limits to support base64 image uploads (decoded cap is configurable)
try {
  const mb = Number(config.API_JSON_LIMIT_MB);
  const limitStr = (Number.isFinite(mb) && mb > 0) ? `${mb}mb` : '48mb';
  app.use(express.json({ limit: limitStr }));
  app.use(express.urlencoded({ extended: true, limit: limitStr }));
} catch (_) {
  app.use(express.json({ limit: '48mb' }));
  app.use(express.urlencoded({ extended: true, limit: '48mb' }));
}

// API Routes (with authentication)
app.use('/api/sessions', basicAuth, sessionsRouter);
app.use('/api/workspaces', basicAuth, workspacesRouter);
app.use('/api', basicAuth, systemRouter);
app.use('/api/containers', basicAuth, containersRouter);
app.use('/api/user', basicAuth, usersRouter);
app.use('/api/notifications', basicAuth, notificationsRouter);

// WebSocket Server
// Increase maxPayload to accommodate binary tunnel frames carrying TCP data.
// Use noServer so it can attach to multiple HTTP servers.
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientId = url.pathname.split('/').pop();
  // Tunnel WS path: /api/sessions/:id/tunnel or /:id/tunnel
  const path = url.pathname || '';
    const tunnelMatch = (() => {
      const m1 = path.match(/^\/api\/sessions\/([^\/]+)\/tunnel$/);
      if (m1) return m1;
      const m2 = path.match(/^\/([^\/]+)\/tunnel$/);
      if (m2) return m2;
      return null;
    })();

  if (tunnelMatch) {
    // Handle tunnel authentication using session token or fallback to cookie
    (async () => {
      try {
        // Resolve alias → real session id when applicable
        const sessionIdRaw = tunnelMatch[1];
        const sessionId = (global.sessionManager?.resolveIdFromAliasOrId?.(sessionIdRaw) || sessionIdRaw);
        const { verifyAccessToken: verifyTunnelToken } = await import('./utils/session-access-token.js');
        const token = url.searchParams.get('token') || '';
        const ver = token ? verifyTunnelToken(token, sessionId) : { ok: false };
        if (!ver.ok) {
          try { ws.close(1008, 'Invalid session token'); } catch (_) {}
          return;
        }
        // Require an ACTIVE session for tunnel handshake; reject if session is missing or terminated
        try {
          const s = global.sessionManager?.getSession(sessionId);
          if (!s || !s.is_active) {
            try { ws.close(1008, 'Session not active'); } catch (_) {}
            return;
          }
        } catch (_) {
          try { ws.close(1008, 'Session not active'); } catch (_) {}
          return;
        }
        // Register tunnel
        const { tunnelManager } = await import('./managers/tunnel-manager.js');
        tunnelManager.register(sessionId, ws);
        try { logger.info(`Tunnel connected for session ${sessionId}`); } catch (_) {}
        ws.on('close', () => {
          try { tunnelManager.unregister(sessionId); } catch (_) {}
        });
      } catch (e) {
        try { logger.error(`Tunnel WS error: ${e.message}`); } catch (_) {}
        try { ws.close(1011, 'Internal error'); } catch (_) {}
      }
    })();
    return; // Do not continue with regular client WS handling
  }
  
  if (config.AUTH_ENABLED) {
    logger.info(`WebSocket connection established for client ${clientId}, awaiting authentication`);
    
    // Mark connection as unauthenticated initially
    ws.isAuthenticated = false;
    ws.clientId = clientId;
    ws.username = null;

    try {
      const search = url.searchParams;
      const wsToken = search.get('ws_token');
      if (wsToken) {
        const ver = verifySessionToken(wsToken);
        if (ver && ver.ok && ver.payload && ver.payload.username) {
          ws.isAuthenticated = true;
          ws.username = ver.payload.username;
          logger.info(`WebSocket token authentication successful for client ${clientId}, user: ${ws.username}`);
          try { ws.permissions = resolvePermissionsForUsername(ws.username); } catch (_) { ws.permissions = {}; }
          try { ws.send(JSON.stringify({ type: 'auth_success', message: 'Authentication successful' })); } catch (_) {}
        }
      }
    } catch (_) {}

    if (!ws.isAuthenticated) {
      const cookieAuth = authenticateRequestByCookie(req);
      if (cookieAuth && cookieAuth.ok && cookieAuth.username) {
        ws.isAuthenticated = true;
        ws.username = cookieAuth.username;
        logger.info(`WebSocket cookie authentication successful for client ${clientId}, user: ${ws.username}`);
        try { ws.permissions = resolvePermissionsForUsername(ws.username); } catch (_) { ws.permissions = {}; }
        try { ws.send(JSON.stringify({ type: 'auth_success', message: 'Authentication successful' })); } catch (_) {}
      }
    }

    if (!ws.isAuthenticated) {
      logger.warning(`WebSocket authentication failed for client ${clientId}: No valid token or session`);
      try { ws.close(1008, 'Authentication required'); } catch (_) {}
      return;
    }
  } else {
    logger.info(`WebSocket connection established for client ${clientId} (auth disabled)`);
    
    // Authentication disabled: still try to extract username from Authorization header for identification
    let extractedUsername = config.DEFAULT_USERNAME;
    try {
      const authHeader = req.headers['authorization'];
      if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Basic ')) {
        const base64Credentials = authHeader.substring(6);
        const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
        const [uname] = credentials.split(':');
        if (uname && uname.trim()) {
          extractedUsername = uname.trim();
        }
      }
    } catch (_) {}

    // Mark as authenticated and store client identity
    ws.isAuthenticated = true;
    ws.clientId = clientId;
    ws.username = extractedUsername;
    try { ws.permissions = resolvePermissionsForUsername(ws.username); } catch (_) { ws.permissions = {}; }
  }
  
  connectionManager.addConnection(clientId, ws);

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      const { type } = message;

      // Optionally enable debug logging for inbound messages via LOG_LEVEL
      // (Removed verbose per-message info logging)
      
      // Handle authentication message first
      if (type === 'auth') {
        const { username } = message;

        if (!config.AUTH_ENABLED) {
          if (typeof username === 'string' && username.trim()) {
            ws.username = username.trim();
          }
          ws.isAuthenticated = true;
          logger.info(`WebSocket identification set for client ${clientId}; username='${ws.username}' (auth disabled)`);
          connectionManager.sendToClient(clientId, {
            type: 'auth_success',
            message: 'Authentication not required'
          });
        } else {
          logger.warning(`WebSocket received legacy auth message for client ${clientId}; ignoring`);
        }
        return;
      }
      
      // For all other messages, check if authenticated (only if auth is enabled)
      if (config.AUTH_ENABLED && !ws.isAuthenticated) {
        logger.warning(`WebSocket message rejected for unauthenticated client ${clientId}`);
        ws.close(1008, 'Authentication required');
        return;
      }

      // Route message to appropriate handler
      const handler = messageHandlers[type];
      if (handler) {
        await handler(clientId, message);
      } else {
        connectionManager.sendToClient(clientId, {
          type: 'error',
          message: `Unknown message type: ${type}`
        });
      }
    } catch (error) {
      logger.error(`WebSocket message error for client ${clientId}: ${error.message}`);
      connectionManager.sendToClient(clientId, {
        type: 'error',
        message: 'Invalid message format'
      });
    }
  });

  ws.on('close', () => {
    logger.info(`WebSocket disconnected for client ${clientId}`);
    
    const affectedSessionIds = sessionManager.cleanupClientSessions(clientId);
    connectionManager.removeConnection(clientId);
    
    // Broadcast session updates for affected sessions
    for (const sessionId of affectedSessionIds) {
      const session = sessionManager.getSession(sessionId);
      if (session) {
        const sessionData = session.toResponseObject();
        connectionManager.broadcast({
          type: 'session_updated',
          update_type: 'updated',
          session_data: sessionData
        });
      }
    }
  });

  ws.on('error', (error) => {
    logger.error(`WebSocket error for client ${clientId}: ${error.message}`);
    
    const affectedSessionIds = sessionManager.cleanupClientSessions(clientId);
    connectionManager.removeConnection(clientId);
    
    // Broadcast session updates for affected sessions
    for (const sessionId of affectedSessionIds) {
      const session = sessionManager.getSession(sessionId);
      if (session) {
        const sessionData = session.toResponseObject();
        connectionManager.broadcast({
          type: 'session_updated',
          update_type: 'updated',
          session_data: sessionData
        });
      }
    }
  });
});

// Session termination callback
sessionManager.setSessionTerminatedCallback(async (sessionId) => {
  logger.info(`Session ${sessionId} terminated naturally`);
  try { global.inputScheduler?.onSessionTerminated(sessionId); } catch (_) {}
  const session = sessionManager.getSession(sessionId);
  if (session) {
    // Broadcast termination before cleanup
    const sessionData = session.toResponseObject();
    connectionManager.broadcast({
      type: 'session_updated',
      update_type: 'terminated',
      session_data: sessionData
    });

    // Create persisted notifications for the session owner and all currently attached users,
    // then broadcast per-user so their connected clients see it.
    try {
      const users = new Set();
      const owner = String(session.created_by || '').trim();
      if (owner) users.add(owner);
      try {
        for (const clientId of session.connected_clients || []) {
          const ws = global.connectionManager?.connections?.get(clientId);
          const uname = ws && ws.username ? String(ws.username).trim() : '';
          if (uname) users.add(uname);
        }
      } catch (_) {}

      const exitCode = (typeof session.exit_code === 'number') ? session.exit_code : null;
      const okExit = exitCode === 0 || exitCode === null;
      const ntype = okExit ? 'info' : 'error';
      const title = 'Session Ended';
      const displayTitle = session.title || session.dynamic_title || session.session_id;
      const message = exitCode == null
        ? `Session ${displayTitle} has ended.`
        : `Session ${displayTitle} has ended with exit code ${exitCode}.`;

      for (const username of users) {
        const saved = notificationManager.add(username, {
          title,
          message,
          notification_type: ntype,
          timestamp: new Date().toISOString(),
          session_id: session.session_id,
          is_active: false
        });
        connectionManager.broadcast({
          type: 'notification',
          user: username,
          title: saved.title,
          message: saved.message,
          notification_type: saved.notification_type,
          session_id: saved.session_id,
          server_id: saved.id,
          is_active: saved.is_active,
          timestamp: saved.timestamp
        });
      }
    } catch (e) {
      logger.warning(`Failed to emit persisted termination notifications: ${e.message}`);
    }
    
    // Handle session termination and history preservation
    await sessionManager.terminateSession(sessionId);
  }
});

// Attach upgrade handling to a server (service proxy first, then app WS)
function attachUpgradeHandlers(srv) {
  srv.on('upgrade', async (req, socket, head) => {
    try {
      try {
        const u = new URL(req.url, `http://${req.headers.host || 'local'}`);
        const conn = String(req.headers['connection'] || '');
        const up = String(req.headers['upgrade'] || '');
        logger.info(`[Upgrade] incoming path='${u.pathname}' query='${u.search || ''}' connection='${conn}' upgrade='${up}'`);
      } catch (_) { /* best-effort */ }
      const handled = await handleServiceProxyUpgrade(req, socket, head);
      if (handled) {
        try { logger.info('[Upgrade] handled by service-proxy upgrade bridge'); } catch (_) {}
        return;
      }
      try { logger.info('[Upgrade] not a service-proxy path; delegating to app WS'); } catch (_) {}
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (_) {
      try { socket.destroy(); } catch (_) {}
    }
  });
}

// Start servers according to configuration
async function startListening() {
  const listeners = Array.isArray(config.LISTENERS) ? config.LISTENERS : [];
  const isWin = process.platform === 'win32';

  const logCommon = (listenLabel) => {
    logger.info(`termstation Backend started`);
    logger.info(`Environment: ${config.ENVIRONMENT}`);
    logger.info(`Authentication: ${config.AUTH_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`Listening: ${listenLabel}`);
    logger.info(`Platform: ${process.platform}, Default shell: ${config.DEFAULT_SHELL}`);
  };

  if (listeners.length === 0) {
    logger.warning('No listeners enabled; server will not accept connections');
    return;
  }

  for (const lst of listeners) {
    if (!lst || lst.enabled === false) continue;
    if (lst.type === 'http') {
      const srv = createServer(app);
      attachUpgradeHandlers(srv);
      servers.push(srv);
      const host = lst.host || '127.0.0.1';
      const port = Number(lst.port) || 6624;
      await new Promise((resolve) => {
        srv.listen(port, host, () => {
          const baseUrl = `http://${host}:${port}`;
          const wsUrl = `ws://${host}:${port}`;
          logger.info(`termstation Backend started`);
          logger.info(`Environment: ${config.ENVIRONMENT}`);
          logger.info(`Authentication: ${config.AUTH_ENABLED ? 'ENABLED' : 'DISABLED'}`);
          logger.info(`Server: ${baseUrl}`);
          logger.info(`WebSocket: ${wsUrl}`);
          logger.info(`Platform: ${process.platform}, Default shell: ${config.DEFAULT_SHELL}`);
          resolve();
        });
      });
    } else if (lst.type === 'socket') {
      if ((lst.mode === 'pipe') && !isWin) throw new Error('Pipe mode is only supported on Windows');
      if ((lst.mode === 'unix') && isWin) throw new Error('Unix socket mode is not supported on Windows');
      const srv = createServer(app);
      attachUpgradeHandlers(srv);
      servers.push(srv);

      if (lst.mode === 'unix') {
        const socketPath = String(lst.path || '').trim();
        if (!socketPath) throw new Error('listeners.socket.path is required for unix mode');
        const dir = path.dirname(socketPath);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { throw new Error(`Failed to create parent directory for UNIX socket: ${dir}. ${e.message}`); }
        if (fs.existsSync(socketPath) && (lst.unlink_stale !== false)) {
          const shouldUnlink = await new Promise((resolve, reject) => {
            try {
              const sock = net.connect({ path: socketPath });
              let settled = false;
              const timer = setTimeout(() => { if (settled) return; settled = true; try { sock.destroy(); } catch (_) {} resolve(true); }, 300);
              sock.once('connect', () => { if (settled) return; settled = true; clearTimeout(timer); try { sock.end(); } catch (_) {} reject(new Error(`UNIX socket already in use at ${socketPath}`)); });
              sock.once('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); const code = err && err.code ? String(err.code) : ''; if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EPIPE') { resolve(true); } else { reject(new Error(`Failed to connect to existing UNIX socket ${socketPath}: ${err.message || code}`)); } });
            } catch (e) { resolve(true); }
          });
          if (shouldUnlink) {
            try { fs.unlinkSync(socketPath); logger.info(`[UDS] Unlinked stale socket at ${socketPath}`); } catch (e) { if (e && e.code !== 'ENOENT') { throw new Error(`Failed to unlink stale UNIX socket at ${socketPath}: ${e.message}`); } }
          }
        }
        await new Promise((resolve) => {
          srv.listen({ path: socketPath }, () => {
            try {
              let mode = lst.chmod;
              if (typeof mode === 'string') { try { mode = parseInt(mode, 8); } catch (_) { mode = 0o600; } }
              if (typeof mode !== 'number' || !Number.isFinite(mode)) mode = 0o600;
              fs.chmodSync(socketPath, mode);
              logger.info(`[UDS] chmod ${mode.toString(8)} set on ${socketPath}`);
            } catch (e) {
              logger.warning(`[UDS] Failed to chmod on ${socketPath}: ${e.message}`);
            }
            logCommon(`socket:${socketPath}`);
            resolve();
          });
        });
        const cleanup = () => {
          try { fs.unlinkSync(socketPath); logger.info(`[UDS] Unlinked socket on shutdown: ${socketPath}`); } catch (e) { if (e && e.code !== 'ENOENT') { logger.warning(`[UDS] Failed to unlink socket on shutdown: ${e.message}`); } }
        };
        srv.on('close', cleanup);
      } else if (lst.mode === 'pipe') {
        const pipePath = String(lst.path || '').trim();
        if (!pipePath) throw new Error('listeners.socket.path is required for pipe mode on Windows');
        await new Promise((resolve) => {
          srv.listen(pipePath, () => { logCommon(`socket:${pipePath}`); resolve(); });
        });
      }
    }
  }
}

// Kick off listener with error handling
startListening()
  .then(async () => {
    try {
      await runAutoStartTemplates({ logger });
    } catch (e) {
      try { logger.warning(`Auto-start templates failed: ${e?.message || e}`); } catch (_) {}
    }
  })
  .catch((e) => {
  logger.error(`Failed to start server: ${e.message}`);
  process.exit(1);
});

// Graceful shutdown (idempotent)
let shutdownStarted = false;
let shutdownPromise = null;

async function performShutdown(trigger = 'SIGTERM') {
  if (shutdownStarted) {
    logger.info(`[Shutdown] ${trigger} received but shutdown already in progress; ignoring duplicate signal`);
    return shutdownPromise;
  }
  shutdownStarted = true;
  logger.info(`${trigger} received, shutting down gracefully...`);

  // Mark shutdown state so API endpoints can refuse new work
  global.isShuttingDown = true;

  // Clean up template loader file watcher
  try { templateLoader.cleanup(); } catch (e) { logger.warning(`Template loader cleanup failed: ${e.message}`); }

  // Stop activity monitor timers
  try { sessionManager.destroy?.(); } catch (e) { logger.warning(`Session manager destroy failed: ${e.message}`); }

  // Notify all connected clients once
  try {
    connectionManager.broadcast({
      type: 'shutdown',
      title: 'Server Shutdown',
      message: 'The terminal server is shutting down.',
      notification_type: 'warning'
    });
  } catch (_) {}

  // Allow a short window for the message to flush to clients
  await new Promise(resolve => setTimeout(resolve, 500));

  // Capture active sessions and container-isolated IDs BEFORE termination
  const activeSessionsSnapshot = sessionManager.getActiveSessions();
  const containerSessionIds = activeSessionsSnapshot
    .filter(s => s && s.isolation_mode === 'container')
    .map(s => s.session_id);

  // Optional retention is handled by skipping deletion of session artifacts directories

  // Terminate and persist sessions (await metadata writes)
  try {
    const terminations = activeSessionsSnapshot.map(async (s) => {
      try {
        await sessionManager.terminateSession(s.session_id);
      } catch (e) {
        logger.warning(`[Shutdown] Failed to terminate session ${s.session_id}: ${e.message}`);
      }
    });
    await Promise.allSettled(terminations);
  } catch (e) {
    logger.error(`[Shutdown] Error while terminating sessions: ${e.message}`);
  }

  // Stop containers mapped to the captured session IDs
  try {
    if (containerSessionIds.length > 0) {
      logger.info(`[Shutdown] Stopping containers for ${containerSessionIds.length} session(s)`);
      const summary = await stopContainersForSessionIds(containerSessionIds, { timeoutSeconds: config.CONTAINER_STOP_TIMEOUT_SECONDS });
      logger.info(`[Shutdown] Container stop summary: found=${summary.found}, stopped=${summary.stopped.length}, failed=${summary.failed.length}`);
    } else {
      logger.info('[Shutdown] No container sessions detected; skipping container stop');
    }
  } catch (e) {
    logger.error(`[Shutdown] Error while stopping containers: ${e.message}`);
  }

  // Flush notifications to disk
  try { notificationManager.flush(); } catch (e) { logger.warning(`Failed to flush notifications on shutdown: ${e.message}`); }

  // Close all listeners and exit
  try {
    await Promise.allSettled(servers.map((srv) => new Promise((resolve) => {
      try { srv.close(() => resolve()); } catch (_) { resolve(); }
    })));
  } catch (_) {}
  logger.info('All listeners closed');
  process.exit(0);
}

process.on('SIGTERM', () => { shutdownPromise = performShutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdownPromise = performShutdown('SIGINT'); });
// Resolve permissions for a given username using configured users/groups
function resolvePermissionsForUsername(username) {
  try {
    const usersRaw = usersConfigCache.get();
    const groupsRaw = groupsConfigCache.get();
    const users = Array.isArray(usersRaw) ? usersRaw : [];
    const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
    const u = (users || []).find(usr => usr && String(usr.username) === String(username));
    if (!u) return {};
    const userGroups = Array.isArray(u.groups) ? u.groups : [];
    const groupPermissionInputs = [];
    for (const gname of userGroups) {
      try {
        const g = (groups || []).find(gg => gg && String(gg.name) === String(gname));
        if (!g) continue;
        if (g.permissions != null) groupPermissionInputs.push(g.permissions);
      } catch (_) {}
    }
    return resolveBooleanDomain({
      keys: PERMISSION_KEYS,
      groupInputs: groupPermissionInputs,
      userInput: u.permissions,
      defaults: PERMISSION_DEFAULTS
    });
  } catch (_) {
    return {};
  }
}
