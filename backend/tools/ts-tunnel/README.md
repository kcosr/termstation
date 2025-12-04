ts-tunnel — Reverse WebSocket Tunnel Helper

Summary
- Small helper that runs inside a sandbox container and maintains a reverse WebSocket tunnel to the Termstation backend. The backend multiplexes HTTP/WS proxy streams over this connection to reach in-container services (e.g., `127.0.0.1:3000`).

How it works
- On start, reads env vars: `SESSIONS_API_BASE_URL`, `SESSION_ID`, and `SESSION_TOK` (legacy: `SESSION_TUNNEL_TOKEN`).
- Builds `wss://.../api/sessions/:id/tunnel?token=...` from those values and connects.
- Listens for JSON control messages: `{ type: 'open', id, host, port }` from the server and opens a TCP socket to `host:port` inside the container.
- Bridges data both ways using binary frames: `[type:1][id:4][payload...]` where `type` is `0x01` for data, `0x02` for end-of-stream.
- On socket connect/error/close, reports state back to server (error is sent as a JSON string message `{type:'err', id, message}`).

Usage
- Preferred: the backend provides a bundled Node script at `.bootstrap/bin/ts-tunnel.js` per session; no system install required.
- Build locally if Bun is available and you want to update the bundle:
  - `bun build backend/tools/ts-tunnel/bin/ts-tunnel.js --target=node --minify --outfile backend/bootstrap/bin/ts-tunnel.js`
- Environment required in the container (provided automatically by the backend when services are configured):
  - `SESSION_ID`
  - `SESSIONS_API_BASE_URL` (e.g., `https://pc/termstation-api/`)
  - `SESSION_TOK` (legacy: `SESSION_TUNNEL_TOKEN`)

CLI options (optional overrides)
- `--url <wss-url>`: Full tunnel WebSocket URL; bypasses env-based construction.
- `--base-url <base>`: API base URL (http/https), used to construct the tunnel URL.
- `--session-id <id>` and `--token <token>`: Explicit session and token.
- `--insecure`: Skip TLS certificate verification (use only in trusted/test envs).
- `--verbose`: Enable debug logs.

Example
```
ENV SESSION_ID=... \
    SESSIONS_API_BASE_URL=https://pc/termstation-api/ \
    SESSION_TOK=... \
    PATH=/usr/local/bin:$PATH

nohup node .bootstrap/bin/ts-tunnel.js >/proc/1/fd/1 2>&1 &
```

Notes
- The backend auto-starts the helper from `.bootstrap/bin/ts-tunnel.js` when a `SESSION_TOK` is available; missing helper is non‑fatal.
- The helper requires `SESSIONS_API_BASE_URL`; it no longer falls back to `SESSIONS_BASE_URL`.
