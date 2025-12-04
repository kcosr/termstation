# Authentication Strategy and Flows

This document describes the complete authentication model for the TermStation application across HTTP API and WebSocket (WS), the frontend UX, and security considerations.

## Overview
- HTTP API uses Basic Auth only for the initial credential check. On success, the server issues a signed, HttpOnly session cookie (`ts_session`).
- Subsequent API calls use the session cookie. Passwords are never persisted in the browser.
- WebSockets authenticate by validating a short‑lived token appended to the WS URL (`?ws_token=…`).
- If no token is present, the server attempts to reuse the session cookie as a fallback; connections without either are rejected.
- The frontend always uses a blocking login modal and exposes API configuration (full base URL) in the same modal.
- On backend restart, the session secret is regenerated, invalidating previous cookies (by design). This prompts re‑authentication on page reload.

## Credentials & Password Hashing
- Credentials live in the backend data directory `users.json` file (by default `backend/data/users.json`) using `password_hash` fields only.
- Hashing: PBKDF2-SHA256 with per-user salt, 150k iterations; constant-time compare on verify.
- Plaintext passwords are not accepted.

### Generating `password_hash` values for `users.json`
Use the helper script to generate a properly formatted PBKDF2 password hash line.

Script: `backend/scripts/generate_password_hash.js`

Examples:

- Generate a full `password_hash` line for the password “SuperSecret!” (default 150k iterations, 16‑byte salt):

```bash
backend/scripts/generate_password_hash.js --password='SuperSecret!'
# or positional
backend/scripts/generate_password_hash.js 'SuperSecret!'
```

Output:
```
Salt (hex): 5b8f3d...c1
password_hash: pbkdf2$150000$5b8f3d...c1$3a4d...e9
```

Copy the `password_hash: ...` value (everything after the colon) into `users.json` and define permissions via the structured model (supports wildcard `"*"` to enable all canonical permissions defined in code at `backend/middleware/auth.js`, with explicit `false` overriding):

```json
[
  {
    "username": "admin",
    "password_hash": "pbkdf2$150000$5b8f3d...c1$3a4d...e9",
    "groups": ["admins"],
    "permissions": { "impersonate": true, "manage_all_sessions": true },
    "features": {}
  }
]
```

- Generate only a random salt (rarely needed on its own):

```bash
backend/scripts/generate_password_hash.js --salt-only --saltlen=16
```

Advanced options:
- `--iter=<number>` (default 150000)
- `--saltlen=<bytes>` (default 16)
- `--digest=sha256` (PBKDF2 digest algorithm; keep at sha256)

Notes:
- Never store plaintext passwords in `users.json`.
- Legacy boolean flags like `allow_impersonate` and `manage_all_sessions` are no longer supported in configuration. Use the structured `permissions` object (and optional `groups`) instead.

## Password Reset
- Logged-in users can reset their own password via the “Reset password…” entry in the header account dropdown when the `password_reset_enabled` feature is enabled for their profile.
- The frontend shows a modal with fields:
  - Current password
  - New password
  - Confirm new password
- On submit:
  - The browser temporarily sets Basic Auth with the current username and current password and calls `POST /api/user/reset-password` with `{ "new_password": "NewSecret" }`.
  - The backend re-verifies the supplied current password against the runtime `users.json` in the backend data directory (ignoring any existing cookie) before updating the `password_hash`.
  - The backend rejects resets where the new password matches the existing password and returns an error.
- A per-user `prompt_for_reset` flag in `users.json` can be set to `true` to require a password change at next login:
  - After successful auth, the frontend loads `/api/user/me`; when `prompt_for_reset: true`, it opens the password reset modal in a blocking mode (no cancel/escape).
  - On successful reset, the backend clears `prompt_for_reset` for that user and the frontend updates its `auth.prompt_for_reset` state so the modal does not re-open.

## HTTP API Authentication
Middleware protects all `/api/**` routes:

1) Basic Auth (first request only)
- If `Authorization: Basic …` present, validate username/password against the runtime `users.json` in the backend data directory.
- On success, issue `ts_session` (HttpOnly, SameSite=Lax, Secure when HTTPS) with default TTL (24h) and attach `req.user`.

2) Session Cookie
- If `ts_session` cookie is present, verify signature and expiry and re-validate that the user still exists.
- On success, attach `req.user` and slide-refresh the cookie to extend Max-Age.

3) Otherwise: 401
- Respond `401 Authentication required`. If the request includes `X-No-Auth-Prompt: 1`, the `WWW-Authenticate` header is suppressed to avoid browser credential popups.

### Cookie Details
- Name: `ts_session`
- Flags: HttpOnly, SameSite=Lax; Secure when HTTPS is detected (`req.secure` or `x-forwarded-proto=https`).
- TTL: default 24h; slide refresh on verified requests.
- Signing secret: generated at backend startup (ephemeral per process). Cookies become invalid on restart.

## WebSocket Authentication
The server expects authentication when `auth_enabled=true`.

### Token-based WS handshake (primary)
- Client calls `GET /api/ws-token` (short-lived token ~10s) and appends `?ws_token=…` to the WS URL when connecting.
- Server validates `ws_token` during the WS handshake, immediately marks the socket authenticated, and emits `auth_success`.
- Client listens for `auth_success` and finalizes auth without sending credentials over the socket.

### Session cookie fallback
- If no token is provided, the server attempts to authenticate the socket using the existing `ts_session` cookie.
- Successful cookie validation triggers the same `auth_success` message; otherwise the server closes the socket with code `1008`.

### Timeouts and failures
- If the server does not validate any auth in ~5–6s, it closes the socket with code `1008` (policy violation, auth required).
- The client logs “Authentication failed – not reconnecting” and defers further attempts until login.

## Frontend UX

### Login Modal
- A blocking modal appears:
  - On initial page load for non-logged-in tab sessions.
  - Immediately after logout.
- Fields: Username, Password, and a collapsible API Settings section (single full API URL, including path prefix if proxied).
- On login submit:
  - Client sends one `GET /api/info` with Basic Auth to seed a cookie, then clears Basic header.
  - Client marks `ApiService` authenticated, requests a WS token, and connects WS with `?ws_token=…`, finalizing on `auth_success` from the handshake.

### Startup and Reload Behavior
- Fresh tab (no login): show auth modal before any API call and defer init.
- Reload with valid cookie:
  - `GET /api/info` (auth_enabled + user); then `GET /api/ws-token`.
  - WS connects with `?ws_token` and completes immediately on `auth_success`.
- Desktop cookie persistence (Electron):
  - The app persists API auth cookies to the desktop `state.json` (under `auth_cookies[origin]`) and restores them on launch.
  - On startup, cookies are restored before the first API call. If `GET /api/info` succeeds, the app proceeds without prompting for login.
  - All cross‑origin API requests from the desktop app use `credentials: 'include'` so browser cookies are sent to the API origin.
- Reload after backend restart (new secret):
  - `GET /api/info` → 401; show auth modal and defer WS.

### Header UI
- Right-aligned user badge (avatar initial). Dropdown opens inward to the left.
- Dropdown header shows environment badge, version, and a gear that opens Settings.
- Dropdown body shows “Signed in as …”, Login…, Logout.
- Notification bell appears to the left of the user badge.

### Logout Flow
- Client calls `POST /api/auth/logout` to clear the cookie.
- Clears Basic headers and the per‑tab login flag.
- Disconnects WS.
- Desktop (Electron): performs a safe hard reload of the window (`mainWindow.reload()` via preload IPC) after minimal cleanup; this guarantees a pristine renderer state.
- Web: performs `window.location.reload()` after logout for a pristine state.

## Endpoints Summary
- `GET /api/info` – returns `{version, auth_enabled, current_user, ...}`; requires Basic or cookie.
- `GET /api/ws-token` – returns `{token}` for WS handshake (short‑lived, ~10s).
- `POST /api/auth/logout` – clears the `ts_session` cookie.

## Security Considerations
- No persistence of user passwords in settings or storage; credentials exist only in memory during the login call.
- HttpOnly cookie protects against XSS; SameSite=Lax mitigates CSRF; add TLS for `Secure`.
- Ephemeral per‑process secret ensures restarts invalidate old sessions.
- WS tokens are short-lived, signed, and used only at handshake.
- All cookie uses re‑validate user existence to prevent stale accounts from lingering.
- Desktop cookie persistence stores cookie metadata in plaintext in the user's `state.json`. Treat this file as sensitive (same trust level as a browser profile). Logout prunes persisted cookies and the Electron cookie jar.

## API Base URL and Settings
- The login modal is the only place to edit the full API URL. Changes apply immediately after a successful login by refreshing runtime config and rebinding the API service.
- The Settings modal shows the active API URL as read-only so administrators can verify the endpoint without editing it there.
- The API URL defaults to `config.DEFAULT_API_URL`. For desktop builds, the injected config (`frontend/config.js`) can set `window.TERMINAL_MANAGER_API_BASE_URL` so Electron uses the same default as the web frontend behind a proxy (e.g., `https://termstation`).

## Implementation Notes
- Desktop cookie persistence is implemented via IPC:
  - Preload exposes `desktop.cookies.restore/save/clear(baseUrl)`.
  - Main process reads/writes `state.json` and the Electron cookie jar.
  - Renderer restores cookies on init, saves cookies after login, and clears on logout.
- Cross‑origin fetches use `credentials: 'include'` automatically when the API base origin differs from the app origin.
- Desktop can optionally load a remote web UI instead of the built‑in local frontend.
  - Set env `FRONTEND_URL` to a full URL (e.g., `https://termstation`) to load that URL in the Electron window.
  - When `FRONTEND_URL` is set to a URL (i.e., not `local` or `file`), the local HTTP/file frontend is not used.
- When using the built‑in local HTTP frontend (`FRONTEND_URL=local`), desktop can optionally route API and WebSocket traffic through a local HTTP proxy for HTTP‑only backends on other hosts. This is controlled per auth profile via a “Route API via local proxy” checkbox in the Login modal; when enabled with an `http://` API URL, the frontend calls `http://localhost:<port>/api/*` and `ws://localhost:<port>/ws/*`, and the desktop app forwards those to the configured backend URL so cookies continue to work.

## Error Handling
- HTTP 401 (API): UI shows auth modal; requests include `X-No-Auth-Prompt: 1` to avoid the browser login dialog.
- WS 1008 (auth failure): UI logs the failure and defers WS until login.

## Developer Notes
- Password hashing and verification live in `backend/middleware/auth.js`.
- Cookie helpers live in `backend/utils/session-cookie.js`.
- WS bootstrap and validation code is in `backend/server.js` (token + cookie handshake).
- Frontend auth modal: `frontend/public/js/modules/auth/auth-modal.js`.
- WS client: `frontend/public/js/services/websocket.service.js` with token and cookie fallback flows.
- Settings-based auth is removed; API config is in the auth modal.
