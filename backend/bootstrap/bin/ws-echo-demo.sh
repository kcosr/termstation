#!/usr/bin/env bash
# ws-echo-demo: Minimal HTTP + WebSocket echo server with an inline client UI
#
# Usage: ws-echo-demo.sh [port]
# Default port: 8080
#
# Notes:
# - Requires Node.js available as `node`
# - Serves an index page at `/` and echoes any WebSocket messages at `/ws`
# - The client JS connects using a relative path `./ws` so it works behind
#   the service proxy prefix (/api/sessions/:id/service/:port/)

set -euo pipefail

PORT="${1:-8080}"

if ! command -v node >/dev/null 2>&1; then
  echo "[ws-echo-demo] Node.js is required but not found in PATH" >&2
  echo "Please install Node or use a template/container that includes it." >&2
  exit 1
fi

TMPDIR="$(mktemp -d 2>/dev/null || mktemp -d -t ws_demo)"
cleanup() {
  rm -rf "$TMPDIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

SERVER_MJS="$TMPDIR/server.mjs"

cat >"$SERVER_MJS" <<'EOF'
import http from 'http';
import crypto from 'crypto';

const PORT = Number(process.env.PORT || 8080);

const INDEX_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>WS Echo Demo</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
    #log { height: 240px; overflow: auto; padding: .5rem; border: 1px solid #ccc; background: #fafafa; }
    .row { margin: .5rem 0; }
    input[type=text] { width: 70%; padding: .4rem; }
    button { padding: .4rem .7rem; }
    code { background: #f0f0f0; padding: 0 .25rem; }
  </style>
  <script>
    let ws = null;
    function log(line) {
      const el = document.getElementById('log');
      const p = document.createElement('div');
      p.textContent = line;
      el.appendChild(p);
      el.scrollTop = el.scrollHeight;
    }
    function wsUrl() {
      const loc = window.location;
      const proto = (loc.protocol === 'https:') ? 'wss:' : 'ws:';
      const base = loc.origin + (loc.pathname.endsWith('/') ? loc.pathname : loc.pathname + '/');
      return proto + '//' + loc.host + (loc.pathname.endsWith('/') ? loc.pathname : loc.pathname + '/') + 'ws';
    }
    function connect() {
      if (ws && ws.readyState === WebSocket.OPEN) return;
      const url = wsUrl();
      log('Connecting to ' + url + ' ...');
      ws = new WebSocket(url);
      ws.onopen = () => log('OPEN');
      ws.onmessage = (e) => log('RECV: ' + (typeof e.data === 'string' ? e.data : '[binary ' + e.data.size + ' bytes]'));
      ws.onclose = (e) => log('CLOSE ' + e.code + (e.reason ? (': ' + e.reason) : ''));
      ws.onerror = (e) => log('ERROR ' + (e?.message || ''));
    }
    function sendMsg() {
      const inp = document.getElementById('msg');
      const v = inp.value;
      if (!ws || ws.readyState !== WebSocket.OPEN) { log('Not connected'); return; }
      ws.send(v);
      log('SEND: ' + v);
      inp.value = '';
      inp.focus();
    }
    window.addEventListener('DOMContentLoaded', () => {
      document.getElementById('connect').addEventListener('click', connect);
      document.getElementById('send').addEventListener('click', sendMsg);
      document.getElementById('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });
    });
  </script>
  </head>
  <body>
    <h1>WebSocket Echo Demo</h1>
    <p>
      Served by a minimal Node server. WebSocket path is <code>./ws</code> so it works via the service proxy prefix.
    </p>
    <div class="row"><button id="connect">Connect</button></div>
    <div class="row"><input id="msg" type="text" placeholder="Type a message" /> <button id="send">Send</button></div>
    <div id="log"></div>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
    return;
  }
  res.statusCode = 404;
  res.end('Not found');
});

// Minimal WebSocket handshake + echo implementation (RFC 6455)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, socket) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(String(key).trim() + WS_GUID).digest('base64');
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      '\r\n'
    ];
    socket.write(headers.join('\r\n'));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Parse frames; handle multiple frames in buffer
      while (true) {
        if (buffer.length < 2) break;
        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = (b0 & 0x0f);
        const masked = (b1 & 0x80) !== 0;
        let len = (b1 & 0x7f);
        let offset = 2;
        if (len === 126) {
          if (buffer.length < offset + 2) break;
          len = buffer.readUInt16BE(offset); offset += 2;
        } else if (len === 127) {
          if (buffer.length < offset + 8) break;
          const hi = buffer.readUInt32BE(offset); const lo = buffer.readUInt32BE(offset + 4); offset += 8;
          // Only support up to 2^32-1 for demo
          if (hi !== 0) { socket.destroy(); return; }
          len = lo >>> 0;
        }
        let mask = null;
        if (masked) {
          if (buffer.length < offset + 4) break;
          mask = buffer.subarray(offset, offset + 4); offset += 4;
        }
        if (buffer.length < offset + len) break;
        let payload = buffer.subarray(offset, offset + len);
        if (masked && payload.length) {
          const out = Buffer.allocUnsafe(payload.length);
          for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
          payload = out;
        }
        buffer = buffer.subarray(offset + len);
        if (opcode === 0x8) {
          // Close
          try { socket.end(); } catch {}
          return;
        } else if (opcode === 0x9) {
          // Ping -> Pong
          sendFrame(socket, 0xA, payload);
        } else if (opcode === 0x1 || opcode === 0x2) {
          // Text or Binary -> Echo back
          sendFrame(socket, opcode, payload);
        } else {
          // Ignore other opcodes in demo
        }
        if (!fin) {
          // No continuation support in demo; close politely
          sendFrame(socket, 0x8, Buffer.from([0x03, 0xEA])); // 1002
          try { socket.end(); } catch {}
          return;
        }
      }
    });
    socket.on('error', () => { try { socket.destroy(); } catch {} });
  } catch (e) {
    try { socket.destroy(); } catch {}
  }
});

function sendFrame(sock, opcode, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const len = p.length;
  let header = null;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    // 64-bit length, high 32 bits first
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  try { sock.write(header); if (len) sock.write(p); } catch {}
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ws-echo-demo] Listening on http://0.0.0.0:${PORT} (WS path: /ws)`);
});
EOF

echo "[ws-echo-demo] Starting on port ${PORT} ..."
PORT="$PORT" exec node "$SERVER_MJS"

