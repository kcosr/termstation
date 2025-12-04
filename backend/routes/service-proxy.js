/**
 * Service Proxy Routes
 * Proxies HTTP requests into a session's container service via reverse tunnel
 */

import express from 'express';
import { logger } from '../utils/logger.js';
import { tunnelManager } from '../managers/tunnel-manager.js';
// Service name mapping removed; the :port in the URL selects target port
import { config } from '../config-loader.js';
import { perSessionOpsLimiter as rlPerSession } from '../utils/rate-limiters.js';
import { canAccessSessionFromRequest } from '../utils/session-access.js';

export const router = express.Router({ mergeParams: true });

// Map alias to real session id for :sessionId in this router
router.param('sessionId', (req, _res, next, value) => {
  try {
    const v = String(value || '').trim();
    if (!v) return next();
    // Preserve the raw value from the URL (alias or id) for prefix/header computation
    try { req._tsRawSessionId = v; } catch (_) {}
    // Resolve alias to real id for all internal lookups
    const resolved = (global.sessionManager?.resolveIdFromAliasOrId?.(v) || v);
    req.params.sessionId = resolved;
  } catch (_) {}
  next();
});

// Helper: build forward headers and strip hop-by-hop
function buildForwardHeaders(req, prefixPath) {
  const hopByHop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade']);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (!k) continue;
    if (hopByHop.has(k.toLowerCase())) continue;
    // Override Host downstream only if present; otherwise set later
    if (k.toLowerCase() === 'host') continue;
    headers[k] = v;
  }
  // Forward headers
  try { headers['x-forwarded-proto'] = req.secure ? 'https' : (String(req.headers['x-forwarded-proto'] || '').toLowerCase() || 'http'); } catch (_) {}
  try { headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers['host'] || ''; } catch (_) {}
  try { const fwdFor = (req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']) + ', ' : '') + (req.ip || req.socket?.remoteAddress || ''); headers['x-forwarded-for'] = fwdFor; } catch (_) {}
  if (prefixPath) headers['x-forwarded-prefix'] = prefixPath;
  return headers;
}

// Use Node's http client over a custom connection that is the tunnel stream
import http from 'http';

function patchSocketLike(stream) {
  // Provide no-op socket APIs expected by http.ClientRequest
  const s = stream;
  s.setTimeout = s.setTimeout || (() => {});
  s.setNoDelay = s.setNoDelay || (() => {});
  s.setKeepAlive = s.setKeepAlive || (() => {});
  s.address = s.address || (() => ({ address: '127.0.0.1', family: 'IPv4', port: 0 }));
  // Additional net.Socket-like surface to satisfy http.request expectations
  s.cork = s.cork || (() => {});
  s.uncork = s.uncork || (() => {});
  s.ref = s.ref || (() => s);
  s.unref = s.unref || (() => s);
  try { if (s.remoteAddress == null) s.remoteAddress = '127.0.0.1'; } catch (_) {}
  try { if (s.remotePort == null) s.remotePort = 0; } catch (_) {}
  try { if (s.localAddress == null) s.localAddress = '127.0.0.1'; } catch (_) {}
  try { if (s.localPort == null) s.localPort = 0; } catch (_) {}
  try { if (s.connecting == null) s.connecting = false; } catch (_) {}
  try {
    if (!s.__ts_connected_once && typeof s.emit === 'function') {
      s.__ts_connected_once = true;
      process.nextTick(() => { try { s.emit('connect'); } catch (_) {} });
    }
  } catch (_) {}
  // http.request waits for a 'connect' event on sockets created via createConnection.
  // Our tunnel stream is already logically connected; emit 'connect' on next tick to unblock request write.
  return s;
}

async function proxyViaTunnel({
  req,
  res,
  sessionId,
  sessionIdRaw,
  targetPort,
  clientPrefixBasePath
}) {
  try {
    if (global.isShuttingDown) return res.status(503).json({ error: 'Server shutting down' });

    let session = global.sessionManager.getSession(sessionId);
    if (!session) {
      try { session = await global.sessionManager.getSessionIncludingTerminated(sessionId); } catch (_) {}
    }
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (!canAccessSessionFromRequest(req, session)) return res.status(403).json({ error: 'Forbidden' });

    const serviceLabel = 'service';

    const effectivePort = targetPort;
    if (!Number.isInteger(effectivePort) || effectivePort <= 0 || effectivePort > 65535) {
      return res.status(400).json({ error: 'Invalid port' });
    }

    if (!tunnelManager.hasTunnel(sessionId)) {
      return res.status(503).json({ error: 'Service tunnel unavailable' });
    }

    // Compute internal path and headers
    const startedAt = Date.now();
    const rid = Math.floor(Math.random() * 1e9);
    const clientPrefix = clientPrefixBasePath || `/api/sessions/${encodeURIComponent(sessionIdRaw)}/service/${encodeURIComponent(String(effectivePort))}`;

    // Compute target path (portion after the prefix). Prefer Express wildcard capture if available
    let targetPath = '/';
    try {
      // When matched via '/:sessionId/service/:port/*', Express sets params[0] to the suffix
      const captured = req?.params && Object.prototype.hasOwnProperty.call(req.params, '0') ? req.params['0'] : '';
      const pathOnly = (captured || '/');
      targetPath = (pathOnly.startsWith('/') ? pathOnly : ('/' + pathOnly));
      // Preserve search if present in originalUrl
      const originalUrl = String(req.originalUrl || req.url || '');
      const qIndex = originalUrl.indexOf('?');
      const search = qIndex >= 0 ? originalUrl.slice(qIndex) : '';
      // If the captured already includes query (unlikely), avoid duplicating
      if (!targetPath.includes('?')) targetPath = targetPath + search;
    } catch (_) {
      try {
        const originalUrl = String(req.originalUrl || req.url || '');
        const prefixIndex = originalUrl.indexOf(clientPrefix);
        let after = prefixIndex >= 0 ? originalUrl.slice(prefixIndex + clientPrefix.length) : '/';
        const qsIndex = after.indexOf('?');
        const pathOnly = qsIndex >= 0 ? after.slice(0, qsIndex) : after;
        const search = qsIndex >= 0 ? after.slice(qsIndex) : '';
        let pathSuffix = pathOnly || '/';
        if (!pathSuffix.startsWith('/')) pathSuffix = '/' + pathSuffix;
        targetPath = pathSuffix + search;
      } catch (_) {
        targetPath = '/';
      }
    }

    const pathForLog = (() => {
      const qIndex = targetPath.indexOf('?');
      const base = qIndex >= 0 ? targetPath.slice(0, qIndex) : targetPath;
      return base || '/';
    })();

    try {
      logger.info(
        `[Proxy ${rid}] Begin session=${sessionId} service=${serviceLabel} method=${req.method} `
        + `path='${pathForLog}' -> 127.0.0.1:${effectivePort}${targetPath}`
      );
    } catch (_) {}

    // Rate limiting per session using existing limiter
    try {
      if (!rlPerSession.allow(`service-proxy:${sessionId}`)) {
        return res.status(429).json({
          error: 'RATE_LIMITED',
          details: `Proxy rate limit exceeded for session ${sessionId}`
        });
      }
    } catch (_) {}

    // Open tunnel stream to in-container service
    const stream = tunnelManager.openStream(sessionId, { port: effectivePort });
    patchSocketLike(stream);
    try { logger.info(`[Proxy ${rid}] Tunnel stream opened service=${serviceLabel} 127.0.0.1:${effectivePort}`); } catch (_) {}

    // Proactive error/close handling on the tunnel stream so callers don't hang
    let responded = false;
    const failIfPossible = (status, body) => {
      if (responded) return;
      responded = true;
      try { res.status(status).json(body); } catch (_) { try { res.end(); } catch (_) {} }
      try { stream.destroy(); } catch (_) {}
    };
    stream.once('error', (err) => {
      failIfPossible(502, { error: 'Bad gateway', details: err?.message || 'tunnel error' });
    });
    stream.once('close', () => {
      // If stream closed before any response, treat as upstream failure
      if (!responded && !res.headersSent) {
        failIfPossible(502, { error: 'Bad gateway', details: 'tunnel closed' });
      }
    });

    // Build headers
    const headers = buildForwardHeaders(req, clientPrefix);
    headers.host = `127.0.0.1:${effectivePort}`;

    // Create upstream HTTP request over the tunnel stream
    // Custom agent that always returns our tunnel stream as the connection
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (opts, cb) => {
      try { logger.info(`[Proxy ${rid}] Agent.createConnection -> using tunnel stream for 127.0.0.1:${effectivePort}`); } catch (_) {}
      if (typeof cb === 'function') {
        process.nextTick(() => cb(null, stream));
        return stream;
      }
      return stream;
    };

    const options = {
      method: req.method,
      path: targetPath,
      headers,
      agent,
    };

    let bytesUp = 0;
    let bytesDown = 0;
    try {
      // Count request body bytes (if any)
      req.on('data', (chunk) => { bytesUp += Buffer.byteLength(chunk); });
    } catch (_) {}

    const upstreamReq = http.request(options, (upstreamRes) => {
      // Filter hop-by-hop headers from upstream before responding to client
      const hopByHop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade']);
      const outHeaders = {};
      for (const [k, v] of Object.entries(upstreamRes.headers || {})) {
        if (hopByHop.has(String(k).toLowerCase())) continue;
        outHeaders[k] = v;
      }
      try { res.status(upstreamRes.statusCode || 502); } catch (_) {}
      try { for (const [k, v] of Object.entries(outHeaders)) res.setHeader(k, v); } catch (_) {}
      try { res.flushHeaders(); } catch (_) {}
      try {
        upstreamRes.on('data', (chunk) => {
          bytesDown += Buffer.byteLength(chunk);
        });
      } catch (_) {}
      upstreamRes.on('end', () => {
        try {
          logger.info(
            `[Proxy ${rid}] Upstream ended service=${serviceLabel} `
            + `status=${upstreamRes.statusCode} bytes_down=${bytesDown}`
          );
        } catch (_) {}
      });
      upstreamRes.pipe(res);
      responded = true;
    });

    // Additional visibility for request lifecycle
    try {
      upstreamReq.on('socket', (sock) => {
        try {
          const same = (sock === stream);
          const ra = sock && (sock.remoteAddress || '');
          const rp = sock && (sock.remotePort || '');
          logger.info(
            `[Proxy ${rid}] Request socket assigned service=${serviceLabel}; `
            + `sending request (uses_tunnel=${same}) remote=${ra}:${rp}`
          );
        } catch (_) {}
      });
      upstreamReq.on('finish', () => {
        try { logger.info(`[Proxy ${rid}] Request finished sending service=${serviceLabel}; bytes_up=${bytesUp}`); } catch (_) {}
      });
    } catch (_) {}

    upstreamReq.on('error', (err) => {
      try { logger.warning(`[Proxy] Upstream error for session ${sessionId} service=${serviceLabel} port ${effectivePort}: ${err.message}`); } catch (_) {}
      if (!res.headersSent) {
        try { res.status(502).json({ error: 'Bad gateway', details: err.message }); } catch (_) { try { res.end(); } catch (_) {} }
      } else {
        try { res.end(); } catch (_) {}
      }
      try { stream.destroy(); } catch (_) {}
    });

    // Apply a conservative timeout so clients don't hang indefinitely if upstream won't connect
    const timeoutMs = 15000;
    try {
      upstreamReq.setTimeout(timeoutMs, () => {
        try { upstreamReq.destroy(new Error('upstream timeout')); } catch (_) {}
      });
    } catch (_) {}

    // Pipe request body (or end immediately for typical GET/HEAD/OPTIONS w/o body)
    const meth = String(req.method || 'GET').toUpperCase();
    const hasBodyHeader = ('content-length' in (req.headers || {})) || ('transfer-encoding' in (req.headers || {}));
    if ((meth === 'GET' || meth === 'HEAD' || meth === 'OPTIONS' || meth === 'DELETE') && !hasBodyHeader) {
      try { upstreamReq.end(); } catch (_) {}
    } else if (req.readableEnded) {
      upstreamReq.end();
    } else {
      req.pipe(upstreamReq);
    }

    // Finalize logging once response is sent
    try {
      res.on('finish', () => {
        const dur = Date.now() - startedAt;
        try {
          logger.info(
            `[Proxy ${rid}] Completed service=${serviceLabel} status=${res.statusCode} `
            + `bytes_up=${bytesUp} bytes_down=${bytesDown} duration_ms=${dur}`
          );
        } catch (_) {}
      });
    } catch (_) {}
  } catch (e) {
    try { logger.error(`[Proxy] Error in service proxy: ${e.message}`); } catch (_) {}
    res.status(500).json({ error: 'Proxy failed', details: e.message });
  }
}

// Export helpers for tests only (not part of public API surface)
export { proxyViaTunnel as _proxyViaTunnelForTest, canAccessSessionFromRequest as _canAccessSessionForTest };

// New form: /api/sessions/:sessionId/service/:port/* and without trailing segment
router.all('/:sessionId/service/:port/*', async (req, res) => {
  const sessionId = req.params.sessionId; // resolved id
  const sessionIdRaw = (req._tsRawSessionId || req.params.sessionId); // raw alias or id from URL
  const rawPort = req.params.port;
  const targetPort = Number(rawPort);
  return proxyViaTunnel({
    req,
    res,
    sessionId,
    sessionIdRaw,
    targetPort,
  });
});

// Handle base path without trailing slash or suffix
router.all('/:sessionId/service/:port', async (req, res) => {
  try {
    // Delegate to the same logic by appending a trailing slash context in-place
    req.url = req.url + '/';
  } catch (_) {}
  // Re-enter the router by calling next() into the wildcard route
  try { return router.handle(req, res); } catch (e) { try { res.status(500).json({ error: 'Proxy failed', details: e.message }); } catch (_) {} }
});

export default router;
