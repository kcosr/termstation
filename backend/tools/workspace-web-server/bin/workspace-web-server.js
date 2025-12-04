#!/usr/bin/env node

// Workspace web server helper
// - Exposes a lightweight JSON/HTTP API over a workspace directory (default: /workspace)
// - Intended to run inside a session container and be accessed via the
//   TermStation service proxy at `/api/sessions/:id/service/workspace/...`.
//
// Endpoints (all paths are resolved relative to the configured root and guarded
// against traversal outside that root):
//   GET    /api/list?path=<relative-or-absolute>      List directory entries
//   GET    /api/file?path=<relative-or-absolute>      Stream file contents
//   GET    /api/file?path=<...>&download=1            Stream file as attachment
//   PUT    /api/file?path=<relative-or-absolute>      Upload/overwrite a file
//   DELETE /api/file?path=<relative-or-absolute>      Delete a file (best-effort)
//
// A small informational document is returned for GET /.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = { port: 8000, dir: '/workspace' };
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0 && n <= 65535) out.port = Math.floor(n);
    } else if ((a === '--dir' || a === '--root') && i + 1 < args.length) {
      out.dir = String(args[++i] || '').trim() || out.dir;
    } else if (a === '--fg' || a === '--bg') {
      // Legacy flags ignored; kept for compatibility with older bootstrap scripts.
      if (i + 1 < args.length) i++;
    }
  }
  return out;
}

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

function sendJson(res, statusCode, payload) {
  try {
    const body = JSON.stringify(payload ?? {});
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (e) {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        error: 'SERIALIZATION_FAILED',
        message: String(e && e.message ? e.message : e)
      }));
    } catch (_) {
      // Best-effort; nothing else we can do.
    }
  }
}

function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, { ok: false, error: code || 'ERROR', message: message || '' });
}

function resolveSafePath(root, inputPath) {
  const raw = String(inputPath || '').replace(/\\/g, '/');
  const trimmed = raw.startsWith('/') ? raw.slice(1) : raw;
  const target = path.resolve(root, trimmed || '.');
  if (!target.startsWith(root)) return null;
  return target;
}

function normalizeLogicalPath(raw) {
  const s = String(raw || '');
  if (!s || s === '.') return '/';
  if (s.startsWith('/')) return s;
  return `/${s}`;
}

function createServer({ port, dir }) {
  const root = path.resolve(dir || '/workspace');

  const server = http.createServer((req, res) => {
    const urlStr = req.url || '/';
    let urlObj;
    try {
      urlObj = new URL(urlStr, 'http://127.0.0.1');
    } catch (_) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid URL');
    }

    const { pathname, searchParams } = urlObj;
    const method = (req.method || 'GET').toUpperCase();

    // Health / info endpoint
    if (method === 'GET' && (pathname === '/' || pathname === '')) {
      return sendJson(res, 200, {
        ok: true,
        service: 'workspace-web-server',
        root,
        api: {
          list: '/api/list?path=/',
          file: '/api/file?path=/path/to/file'
        }
      });
    }

    if (pathname === '/api/list' && method === 'GET') {
      const requestedPath = searchParams.get('path') || '/';
      const target = resolveSafePath(root, requestedPath);
      if (!target) return sendError(res, 400, 'INVALID_PATH', 'Path is outside workspace root');

      fs.stat(target, (err, stats) => {
        if (err || !stats || !stats.isDirectory()) {
          return sendError(res, 404, 'NOT_FOUND', 'Directory not found');
        }
        fs.readdir(target, { withFileTypes: true }, (readdirErr, entries) => {
          if (readdirErr) {
            return sendError(res, 500, 'READDIR_FAILED', 'Error reading directory');
          }
          const rel = path.relative(root, target) || '';
          const logicalPath = normalizeLogicalPath(rel);
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
              path: normalizeLogicalPath(childRel.replace(/\\/g, '/')),
              hidden: isHidden
            });
          }
          sendJson(res, 200, {
            ok: true,
            path: logicalPath,
            entries: outEntries
          });
        });
      });
      return;
    }

    if (pathname === '/api/file' && method === 'GET') {
      const requestedPath = searchParams.get('path') || '';
      if (!requestedPath) return sendError(res, 400, 'MISSING_PATH', '`path` query parameter is required');
      const target = resolveSafePath(root, requestedPath);
      if (!target) return sendError(res, 400, 'INVALID_PATH', 'Path is outside workspace root');

      fs.stat(target, (err, stats) => {
        if (err || !stats || !stats.isFile()) {
          return sendError(res, 404, 'NOT_FOUND', 'File not found');
        }
        const ext = path.extname(target).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const download = searchParams.get('download') === '1';
        const headers = { 'Content-Type': contentType };
        if (download) {
          const baseName = path.basename(target);
          headers['Content-Disposition'] = `attachment; filename="${baseName.replace(/"/g, '')}"`;
        }
        const stream = fs.createReadStream(target);
        stream.on('error', () => {
          sendError(res, 500, 'READ_FAILED', 'Error reading file');
        });
        res.writeHead(200, headers);
        stream.pipe(res);
      });
      return;
    }

    if (pathname === '/api/file' && (method === 'PUT' || method === 'POST')) {
      const requestedPath = searchParams.get('path') || '';
      if (!requestedPath) return sendError(res, 400, 'MISSING_PATH', '`path` query parameter is required');
      const target = resolveSafePath(root, requestedPath);
      if (!target) return sendError(res, 400, 'INVALID_PATH', 'Path is outside workspace root');

      const dirName = path.dirname(target);
      fs.mkdir(dirName, { recursive: true }, (mkdirErr) => {
        if (mkdirErr) {
          return sendError(res, 500, 'MKDIR_FAILED', 'Failed to create parent directory');
        }
        const writeStream = fs.createWriteStream(target);
        let bytes = 0;
        writeStream.on('error', () => {
          sendError(res, 500, 'WRITE_FAILED', 'Failed to write file');
        });
        writeStream.on('finish', () => {
          sendJson(res, 201, {
            ok: true,
            path: normalizeLogicalPath(path.relative(root, target) || ''),
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
      });
      return;
    }

    if (pathname === '/api/file' && method === 'DELETE') {
      const requestedPath = searchParams.get('path') || '';
      if (!requestedPath) return sendError(res, 400, 'MISSING_PATH', '`path` query parameter is required');
      const target = resolveSafePath(root, requestedPath);
      if (!target) return sendError(res, 400, 'INVALID_PATH', 'Path is outside workspace root');

      fs.stat(target, (err, stats) => {
        if (err || !stats) {
          return sendError(res, 404, 'NOT_FOUND', 'File not found');
        }
        if (stats.isDirectory()) {
          return sendError(res, 400, 'IS_DIRECTORY', 'Refusing to delete directory via file API');
        }
        fs.unlink(target, (unlinkErr) => {
          if (unlinkErr) {
            return sendError(res, 500, 'UNLINK_FAILED', 'Failed to delete file');
          }
          sendJson(res, 200, {
            ok: true,
            path: normalizeLogicalPath(path.relative(root, target) || '')
          });
        });
      });
      return;
    }

    // Fallback for unknown routes
    sendError(res, 404, 'NOT_FOUND', 'Route not found');
  });

  server.listen(port, '127.0.0.1', () => {
    // Minimal log suitable for containers; no extra verbosity.
    console.log(`[workspace-web-server] Serving '${root}' at http://127.0.0.1:${port}`);
  });

  server.on('error', (err) => {
    console.error('[workspace-web-server] Server error:', err.message || err);
    process.exitCode = 1;
  });

  return server;
}

export { parseArgs, createServer };

(function main() {
  const args = parseArgs(process.argv || []);
  createServer(args);
})();
