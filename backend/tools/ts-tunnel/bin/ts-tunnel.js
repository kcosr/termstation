#!/usr/bin/env node
// ts-tunnel: Reverse WebSocket tunnel helper
// - Connects to Termstation backend tunnel endpoint and multiplexes TCP streams
// - Reads env: SESSION_ID, SESSIONS_BASE_URL, SESSION_TOK (legacy: SESSION_TUNNEL_TOKEN)
// - Protocol frames (binary): [type:1][id:4 BE][payload]
//   - type 0x01: data, type 0x02: end

import net from 'net';
import { URL } from 'url';
import WebSocket from 'ws';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--session-id') out.sessionId = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--insecure') out.insecure = true;
    else if (a === '--secure' || a === '--no-insecure') out.insecure = false;
    // Basic auth is no longer used; token query param is sufficient for tunnel auth
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else out._.push(a);
  }
  return out;
}

function envOr(key, def = '') { return process.env[key] || def; }

function buildTunnelUrl({ apiBaseUrl, sessionId, token }) {
  // apiBaseUrl should be the API base (e.g., https://pc/termstation-api/ or https://host:port/api/)
  // Convert http→ws and https→wss; do not append '/api/' implicitly.
  const baseStr = String(apiBaseUrl || '').replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  const url = new URL(baseStr);
  let prefix = url.pathname || '';
  if (!prefix.endsWith('/')) prefix += '/';
  return `${url.origin}${prefix}sessions/${encodeURIComponent(sessionId)}/tunnel?token=${encodeURIComponent(token)}`;
}

function makeFrame(type, id, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const buf = Buffer.allocUnsafe(1 + 4 + p.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(id >>> 0, 1);
  if (p.length) p.copy(buf, 5);
  return buf;
}

function log(...args) {
  if (globalThis.__verbose) console.log('[ts-tunnel]', ...args);
}

function errlog(...args) {
  console.error('[ts-tunnel]', ...args);
}

async function main() {
  const args = parseArgs(process.argv);
  globalThis.__verbose = !!(args.verbose || process.env.TUNNEL_DEBUG);

  let tunnelUrl = args.url || '';
  const sessionId = args.sessionId || envOr('SESSION_ID', '');
  const tokenEnv = envOr('SESSION_TOK', '');
  const legacyTokenEnv = envOr('SESSION_TUNNEL_TOKEN', '');
  if (!tokenEnv && legacyTokenEnv) {
    console.warn('[ts-tunnel] SESSION_TUNNEL_TOKEN is deprecated; use SESSION_TOK instead');
  }
  const token = args.token || tokenEnv || legacyTokenEnv;
  // Require explicit API base env/arg (no fallback to SESSIONS_BASE_URL)
  const apiBase = args.baseUrl || envOr('SESSIONS_API_BASE_URL', '');
  if (!tunnelUrl) {
    if (!apiBase || !sessionId || !token) {
      errlog('Missing env/args: require SESSION_ID, SESSIONS_API_BASE_URL, SESSION_TOK or --url');
      process.exit(2);
    }
    tunnelUrl = buildTunnelUrl({ apiBaseUrl: apiBase, sessionId, token });
  }

  // Default to insecure TLS (self-signed) unless explicitly disabled
  const insecure = (args.insecure !== undefined)
    ? !!args.insecure
    : (String(process.env.TUNNEL_INSECURE || 'true').toLowerCase() !== 'false');

  let stop = false;

  async function runOnce() {
    return new Promise((resolve) => {
      log('connecting to', tunnelUrl, insecure ? '(insecure TLS)' : '(strict TLS)');
      const wsOpts = {};
      if (insecure) wsOpts.rejectUnauthorized = false;
      const ws = new WebSocket(tunnelUrl, wsOpts);
      const sockets = new Map(); // id -> net.Socket
      const stats = new Map();   // id -> { up, down }

      function closeAllSockets() {
        for (const s of sockets.values()) {
          try { s.destroy(); } catch {}
        }
        sockets.clear();
      }

      ws.on('open', () => {
        log('connected');
      });

      ws.on('message', (data, isBinary) => {
        try {
          if (!isBinary) {
            // Control message: open / error / hello (text frames may arrive as Buffer)
            const text = (typeof data === 'string') ? data : Buffer.from(data).toString('utf8');
            const msg = JSON.parse(text);
            if (msg && msg.type === 'open' && Number.isInteger(msg.id)) {
              const id = msg.id >>> 0;
              const host = msg.host || '127.0.0.1';
              const port = Number(msg.port);
              if (!Number.isInteger(port) || port <= 0 || port > 65535) {
                try { ws.send(JSON.stringify({ type: 'err', id, message: 'invalid port' })); } catch {}
                return;
              }
              if (sockets.has(id)) {
                try { ws.send(JSON.stringify({ type: 'err', id, message: 'duplicate stream id' })); } catch {}
                return;
              }
              log(`stream ${id} open request -> ${host}:${port}`);
              // Plain TCP connect inside container
              const sock = net.connect({ host, port }, () => {
                log(`stream ${id} connected to ${host}:${port}`);
              });
              sockets.set(id, sock);
              stats.set(id, { up: 0, down: 0 });
              sock.on('data', (chunk) => {
                try {
                  ws.send(makeFrame(0x01, id, chunk), { binary: true });
                  const st = stats.get(id); if (st) st.up += chunk.length;
                  log(`stream ${id} -> ${chunk.length} bytes (total up=${st ? st.up : '?'})`);
                } catch (e) { /* ignore */ }
              });
              sock.on('end', () => {
                try {
                  ws.send(makeFrame(0x02, id, Buffer.alloc(0)), { binary: true });
                  const st = stats.get(id); log(`stream ${id} local socket end (totals up=${st ? st.up : 0} down=${st ? st.down : 0})`);
                } catch {}
              });
              sock.on('close', () => {
                sockets.delete(id);
              });
              sock.on('error', (e) => {
                try { ws.send(JSON.stringify({ type: 'err', id, message: e?.message || 'socket error' })); } catch {}
                try { sock.destroy(); } catch {}
                sockets.delete(id);
              });
              return;
            }
            return; // ignore other JSON control
          }
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (buf.length < 5) return;
          const type = buf.readUInt8(0);
          const id = buf.readUInt32BE(1);
          const payload = buf.subarray(5);
          const sock = sockets.get(id);
          if (!sock) {
            // No socket for this id — send error back
            try { ws.send(JSON.stringify({ type: 'err', id, message: 'no such stream' })); } catch {}
            return;
          }
          if (type === 0x01) {
            // Data to upstream
            try {
              const st = stats.get(id); if (st) st.down += payload.length;
              log(`stream ${id} <- ${payload.length} bytes (total down=${st ? st.down : '?'})`);
              sock.write(payload);
            } catch (e) {
              try { ws.send(JSON.stringify({ type: 'err', id, message: e?.message || 'write failed' })); } catch {}
              try { sock.destroy(); } catch {}
              sockets.delete(id);
            }
          } else if (type === 0x02) {
            // End-of-stream
            try { sock.end(); } catch {}
          }
        } catch (e) {
          errlog('message error', e?.message || e);
        }
      });

      ws.on('close', (code, reason) => {
        log('ws closed', code, reason?.toString?.() || '');
        closeAllSockets();
        resolve();
      });

      ws.on('error', (e) => {
        const msg = String(e?.message || '');
        errlog('ws error', msg);
        try { ws.close(); } catch {}
      });
    });
  }

  // Reconnect loop with backoff
  let delay = 1000;
  const maxDelay = 15000;
  while (!stop) {
    await runOnce();
    if (stop) break;
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(maxDelay, Math.floor(delay * 1.7));
  }
}

main().catch((e) => { errlog('fatal', e?.message || e); process.exit(1); });

