#!/usr/bin/env node
/**
 * termstation Frontend - Node.js server
 *
 * Serves static frontend assets and injects environment-specific config.js
 * Compatible with existing config.{dev|prod|test}.js files.
 *
 * - Config selection: argv[2] or env TERMINAL_MANAGER_CONFIG (default: dev)
 * - Port selection: env TERMSTATION_FRONTEND_PORT when set, otherwise an ephemeral port (0)
 * - Static root: ./public (migrated assets)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const publicRoot = path.resolve(__dirname, 'public');
const testsRoot = path.resolve(__dirname, 'tests');

// Use TERMSTATION_FRONTEND_CONFIG_DIR if set; default to the public root so
// config.js lives alongside the static assets.
let configDir = process.env.TERMSTATION_FRONTEND_CONFIG_DIR || publicRoot;
if (!path.isAbsolute(configDir)) configDir = path.resolve(process.cwd(), configDir);
const configFile = path.join(configDir, 'config.js');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function fileExists(filePath) {
  try { fs.accessSync(filePath, fs.constants.R_OK); return true; } catch { return false; }
}

if (!fileExists(configFile)) {
  console.error(`[frontend] Missing configuration file: ${configFile}`);
  console.error('[frontend] Provide TERMSTATION_FRONTEND_CONFIG_DIR or run from a directory that contains config.js');
  process.exit(1);
}

// Determine listen port:
// 1) Prefer explicit env TERMSTATION_FRONTEND_PORT when set and valid
// 2) Otherwise, let the OS choose an ephemeral port (0) and log the actual value

let requestedPort = 0;
try {
  const rawEnv = process.env.TERMSTATION_FRONTEND_PORT;
  if (rawEnv) {
    const n = parseInt(rawEnv, 10);
    if (Number.isFinite(n) && n > 0) {
      requestedPort = n;
    }
  }
} catch (_) {
  requestedPort = 0;
}

let requestedHost = '';
try {
  const rawBindEnv = process.env.TERMSTATION_FRONTEND_BIND_ADDRESS;
  if (rawBindEnv) {
    const h = String(rawBindEnv).trim();
    if (h) {
      requestedHost = h;
    }
  }
} catch (_) {
  requestedHost = '';
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
};

// Simple caching policy for static assets
// - Vendor libraries: 1 day
// - Config file: no cache
// - Default: 4 hours
const cacheRules = {
  // Specific vendor first
  '/js/vendor/': 'public, max-age=86400',
  '/icons/vendor/': 'public, max-age=86400',
  // All JS: 1 day (logger.js, core modules, etc.)
  '/js/': 'public, max-age=86400',
  // Exceptions
  '/config.js': 'no-cache, no-store, must-revalidate',
  '/version.js': 'no-cache, no-store, must-revalidate',
  // Default for everything else
  default: 'public, max-age=14400'
};

function getCacheHeader(pathname) {
  try {
    if (typeof pathname !== 'string') return cacheRules.default;
    for (const [pattern, cacheControl] of Object.entries(cacheRules)) {
      if (pattern === 'default') continue;
      if (pathname.startsWith(pattern)) return cacheControl;
    }
    return cacheRules.default;
  } catch (_) {
    return cacheRules.default;
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body) res.end(body); else res.end();
}

function serveFile(req, res, absolutePath, relativePath) {
  try {
    const ext = path.extname(absolutePath).toLowerCase();
    const type = mimeTypes[ext] || 'application/octet-stream';
    const st = fs.statSync(absolutePath);
    const lastModified = new Date(st.mtimeMs || st.mtime || Date.now()).toUTCString();
    const etag = `W/"${st.size}-${Math.floor(Number(st.mtimeMs || Date.now()))}"`;
    const cacheControl = getCacheHeader(relativePath || '');

    // Conditional requests: prefer ETag, then Last-Modified
    const inm = (req && req.headers && req.headers['if-none-match']) || '';
    const ims = (req && req.headers && req.headers['if-modified-since']) || '';
    if (inm && inm === etag) {
      return send(res, 304, {
        'Cache-Control': cacheControl,
        'ETag': etag,
        'Last-Modified': lastModified
      });
    }
    if (!inm && ims) {
      const imsTime = Date.parse(ims);
      if (Number.isFinite(imsTime) && st.mtimeMs <= imsTime) {
        return send(res, 304, {
          'Cache-Control': cacheControl,
          'ETag': etag,
          'Last-Modified': lastModified
        });
      }
    }

    const stream = fs.createReadStream(absolutePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': cacheControl,
      'ETag': etag,
      'Last-Modified': lastModified
    });
    stream.pipe(res);
    stream.on('error', () => send(res, 500, { 'Content-Type': 'text/plain' }, 'Internal Server Error'));
  } catch (e) {
    send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
  }
}

function safeJoin(base, target) {
  const targetPath = path.posix.normalize(target).replace(/^\/+/, '');
  return path.join(base, targetPath);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/config.js') {
    // Serve the selected environment config file as-is (no version injection)
    try {
      let content = readText(configFile);

      // Optionally inject backend API defaults from container env so the
      // frontend points to the correct backend by default when running
      // outside of a reverse proxy.
      // Priority: BACKEND_PUBLIC_BASE_URL > BACKEND_PUBLIC_PORT
      // BACKEND_PUBLIC_PORT is a convenience for local development where frontend
      // and backend are on the same host but different ports (e.g., frontend on 8080,
      // backend on 3000). It derives the URL from the current hostname + port.
      try {
        const pubBase = process.env.BACKEND_PUBLIC_BASE_URL;
        if (pubBase && typeof pubBase === 'string' && pubBase.trim()) {
          const safe = String(pubBase).trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          content += `\n// Injected by env: BACKEND_PUBLIC_BASE_URL\nwindow.TERMINAL_MANAGER_API_BASE_URL = '${safe}';\n`;
        } else {
          const rawPort = process.env.BACKEND_PUBLIC_PORT;
          const n = rawPort ? parseInt(rawPort, 10) : NaN;
          if (Number.isFinite(n) && n > 0) {
            // Derive API base from the current host and injected port on the client.
            content += `\n// Injected by env: BACKEND_PUBLIC_PORT\nwindow.TERMINAL_MANAGER_API_BASE_URL = 'http://' + (window.location.hostname || 'localhost') + ':${n}';\n`;
          }
        }
      } catch (_) { /* ignore env injection errors */ }
      return send(
        res,
        200,
        {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': cacheRules['/config.js']
        },
        content
      );
    } catch (e) {
      return send(res, 500, { 'Content-Type': 'text/plain' }, 'Failed to load config');
    }
  }

  if (url.pathname === '/version.js') {
    // Serve shared/version.js so web and backend share the same version source
    try {
      const sharedVersionPath = path.resolve(__dirname, '..', 'shared', 'version.js');
      const js = readText(sharedVersionPath);
      return send(res, 200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' }, js);
    } catch (e) {
      return send(res, 500, { 'Content-Type': 'text/plain' }, 'Failed to load version');
    }
  }

  // Serve tests from /tests/* if present (dev convenience)
  if (url.pathname.startsWith('/tests/')) {
    const testPath = url.pathname.replace(/^\/tests\//, '/');
    const absTest = safeJoin(testsRoot, testPath);
    if (absTest.startsWith(testsRoot) && fileExists(absTest) && fs.statSync(absTest).isFile()) {
      return serveFile(req, res, absTest, testPath);
    }
  }

  // Default static handling from public root
  let requestPath = decodeURIComponent(url.pathname);
  if (requestPath === '/' || requestPath === '') requestPath = '/index.html';
  const absolutePath = safeJoin(publicRoot, requestPath);

  // Ensure requested path stays under legacyRoot
  if (!absolutePath.startsWith(publicRoot)) {
    return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
  }

  if (fileExists(absolutePath) && fs.statSync(absolutePath).isFile()) {
    return serveFile(req, res, absolutePath, requestPath);
  }

  return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found');
});

function onShutdown(signal) {
  console.log(`\n[frontend] Caught ${signal}, shutting down...`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', onShutdown);
process.on('SIGTERM', onShutdown);

const bindAddress = requestedHost && requestedHost.trim() ? requestedHost.trim() : undefined;

const onListen = () => {
  const addr = server.address();
  let boundPort = requestedPort || 0;
  if (addr && typeof addr === 'object' && typeof addr.port === 'number') {
    boundPort = addr.port;
  }
  const displayHost = bindAddress || 'localhost';

  console.log('Starting termstation Frontend (Node.js)');
  console.log(`  Config dir: ${configDir}`);
  console.log(`  Config file: ${configFile}`);
  console.log(`  Static root: ${path.relative(process.cwd(), publicRoot)}`);
  console.log(`  Bind address: ${bindAddress || '(default)'}`);
  console.log(`  Port: ${boundPort}`);
  console.log(`  URL: http://${displayHost}:${boundPort}`);
};

if (bindAddress) {
  server.listen(requestedPort, bindAddress, onListen);
} else {
  server.listen(requestedPort, onListen);
}
