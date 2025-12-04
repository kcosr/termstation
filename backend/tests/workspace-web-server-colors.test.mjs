import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import http from 'http';
import { setTimeout as delay } from 'timers/promises';
import net from 'net';

function waitForReady(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const chunks = [];

    const onData = (buf) => {
      chunks.push(buf.toString('utf8'));
      const out = chunks.join('');
      if (out.includes('[workspace-web-server] Serving')) {
        cleanup();
        done = true;
        resolve();
      }
    };

    const onErr = (buf) => {
      chunks.push(buf.toString('utf8'));
    };

    const onExit = (code) => {
      if (done) return;
      cleanup();
      reject(new Error(`workspace-web-server exited early with code ${code ?? 'null'}; output:\n${chunks.join('')}`));
    };

    const cleanup = () => {
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onErr);
      proc.off('exit', onExit);
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onErr);
    proc.on('exit', onExit);

    setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new Error(`timeout waiting for workspace-web-server readiness; output:\n${chunks.join('')}`));
    }, timeoutMs).unref();
  });
}

async function fetchBody(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP request timeout'));
    });
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr && typeof addr.port === 'number' ? addr.port : 0;
      srv.close((err) => {
        if (err) {
          reject(err);
        } else if (!port) {
          reject(new Error('Failed to allocate an ephemeral port'));
        } else {
          resolve(port);
        }
      });
    });
  });
}

describe('workspace-web-server CLI legacy flags', () => {
  it('accepts fg/bg flags for backward compatibility and responds with JSON', async () => {
    const port = await getFreePort();
    const script = 'tools/workspace-web-server/bin/workspace-web-server.js';
    const fg = 'rgb(1, 2, 3)';
    const bg = '#112233';

    const proc = spawn('node', [script, '--port', String(port), '--dir', '.', '--fg', fg, '--bg', bg], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
      await waitForReady(proc);
      // Give Node a brief moment to start accepting connections even after the log line
      await delay(100);
      const body = await fetchBody(port);
      const parsed = JSON.parse(body);
      expect(parsed.ok).toBe(true);
      expect(parsed.service).toBe('workspace-web-server');
      expect(typeof parsed.root).toBe('string');
      expect(parsed.api && typeof parsed.api.list).toBe('string');
      expect(parsed.api && typeof parsed.api.file).toBe('string');
    } finally {
      try { proc.kill('SIGTERM'); } catch (_) {}
    }
  }, 15000);
});
