/**
 * Service proxy WebSocket upgrade handler.
 * Handles:
 *   - /api/sessions/:id/service/:port[/...]
 *   - /:id/service/:port[/...]
 */

import { config } from './config-loader.js';
import { logger } from './utils/logger.js';
import { authenticateRequestByCookie } from './utils/session-cookie.js';
import { tunnelManager } from './managers/tunnel-manager.js';
import { canAccessSession } from './utils/session-access.js';

export async function handleServiceProxyUpgrade(req, socket, head) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
    const pathname = url.pathname || '';

    // Match numeric service paths
    let match = null;

    let m = pathname.match(/^\/api\/sessions\/([^\/]+)\/service\/(\d+)\/(.*)$/);
    if (!m) {
      const m2 = pathname.match(/^\/api\/sessions\/([^\/]+)\/service\/(\d+)$/);
      if (m2) m = [m2[0], m2[1], m2[2], ''];
    }
    if (!m) {
      const m3 = pathname.match(/^\/([^\/]+)\/service\/(\d+)\/(.*)$/);
      if (m3) m = [m3[0], m3[1], m3[2], m3[3]];
      else {
        const m4 = pathname.match(/^\/([^\/]+)\/service\/(\d+)$/);
        if (m4) m = [m4[0], m4[1], m4[2], ''];
      }
    }
    if (m) {
      match = {
        sessionIdRaw: m[1],
        portStr: m[2],
        pathSuffix: m[3] || ''
      };
    }

    if (!match) {
      try { logger.info(`[Upgrade] service-proxy: path not matched '${pathname}'`); } catch (_) {}
      return false; // not our path
    }

    const sessionIdRaw = match.sessionIdRaw;
    const sessionId = (global.sessionManager?.resolveIdFromAliasOrId?.(sessionIdRaw) || sessionIdRaw);
    const pathSuffix = match.pathSuffix || '';

    const portStr = match.portStr;
    const port = Number(portStr);

    try {
      logger.info(
        `[Upgrade] service-proxy: matched session='${sessionId}' `
        + `service=service port='${port}' `
        + `pathSuffix='${pathSuffix}'`
      );
    } catch (_) {}

    // Access check: only allow if session exists and user may view; reuse auth middleware result on req
    let session = global.sessionManager.getSession(sessionId);
    if (!session) {
      try { session = await global.sessionManager.getSessionIncludingTerminated(sessionId); } catch (_) {}
    }
    if (!session || !session.is_active) {
      try { logger.info(`[Upgrade] service-proxy: session not active '${sessionId}'`); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      return true;
    }

    // Access control: ensure the requester can access this session
    try {
      let reqUser = null;

      // Token auth for WS upgrade: allow `?token=` as alternative to cookie/basic
      try {
        const { verifyAccessToken: verifyTunnelToken } = await import('./utils/session-access-token.js');
        const token = url.searchParams.get('token') || '';
        const ver = token ? verifyTunnelToken(token, sessionId) : { ok: false };
        if (ver.ok) {
          // Map to session owner
          const owner = String(session.created_by || '').trim();
          if (owner) reqUser = { username: owner, permissions: {} };
        }
      } catch (_) { /* fall through */ }

      if (!reqUser) {
        if (config.AUTH_ENABLED) {
          // Prefer cookie-based session token for auth
          const byCookie = authenticateRequestByCookie(req);
          if (!byCookie || !byCookie.ok || !byCookie.username) {
            try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch (_) {}
            try { socket.destroy(); } catch (_) {}
            return true;
          }
          reqUser = { username: byCookie.username, permissions: {} };
        } else {
          // Auth disabled; extract username from Basic if present, else default
          let extracted = config.DEFAULT_USERNAME;
          try {
            const authHeader = req.headers['authorization'];
            if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Basic ')) {
              const base64Credentials = authHeader.substring(6);
              const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
              const [uname] = credentials.split(':');
              if (uname && uname.trim()) extracted = uname.trim();
            }
          } catch (_) {}
          reqUser = { username: extracted, permissions: {} };
        }
      }

      const canAccess = canAccessSession(reqUser, session);
      if (!canAccess) {
        try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch (_) {}
        try { socket.destroy(); } catch (_) {}
        return true;
      }
    } catch (_) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      return true;
    }

    // Validate port and tunnel
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      try { socket.destroy(); } catch (_) {}
      return true;
    }
    if (!tunnelManager.hasTunnel(sessionId)) {
      try { socket.destroy(); } catch (_) {}
      return true;
    }

    // Open stream to container service and bridge raw bytes
    const stream = tunnelManager.openStream(sessionId, { port });
    try {
      const conn = String(req.headers['connection'] || '');
      const up = String(req.headers['upgrade'] || '');
      logger.info(
        `[Upgrade] service-proxy: bridging upgrade service=service `
        + `-> GET '/${pathSuffix}' upgrade='${up}' connection='${conn}'`
      );
    } catch (_) {}

    // Compose a minimal HTTP/1.1 upgrade request to upstream service
    const targetPath = '/' + (pathSuffix || '');
    const lines = [];
    lines.push(`GET ${targetPath}${url.search || ''} HTTP/1.1`);
    // Copy the upgrade headers from client request
    const headers = { ...req.headers };
    headers.host = `127.0.0.1:${port}`;
    // Normalize hop-by-hop (do not remove 'connection' so Upgrade handshakes remain intact)
    delete headers['proxy-authorization'];
    delete headers['proxy-authenticate'];
    delete headers.te;
    delete headers.trailers;
    delete headers['transfer-encoding'];
    // Ensure Connection header is set for Upgrade if client omitted it
    try {
      const hasUpgrade = (String(headers.upgrade || '') !== '');
      if (hasUpgrade && !('connection' in headers)) {
        headers.connection = 'Upgrade';
      }
    } catch (_) {}
    // Ensure Upgrade is preserved
    for (const [k, v] of Object.entries(headers)) {
      lines.push(`${k}: ${v}`);
    }
    lines.push('\r\n');
    try { stream.write(Buffer.from(lines.join('\r\n'), 'utf8')); } catch (_) {}
    // Write any buffered head data
    if (head && head.length) {
      try { stream.write(head); } catch (_) {}
    }
    // Pipe both ways
    stream.on('error', () => { try { socket.destroy(); } catch (_) {} });
    stream.pipe(socket);
    socket.pipe(stream);
    return true;
  } catch (e) {
    try { socket.destroy(); } catch (_) {}
    return true;
  }
}
