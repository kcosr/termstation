# Backend API Reference

This document provides a comprehensive reference for the termstation backend API exposed by the Node.js server in `backend/`.

Listeners
- The backend can listen on TCP and/or a local socket concurrently.
- Configure in `config.json` under the `listeners` block:
  - `listeners.http`: `{ enabled: boolean, host: string, port: number }`
  - `listeners.socket`: `{ enabled: boolean, endpoint?: string, path?: string, chmod?: string|number, unlink_stale?: boolean }`
    - `endpoint`: accepts any of `socket://`, `unix://`, or `pipe://` prefixes. The backend chooses the OS‑appropriate transport (unix on POSIX; pipe on Windows) and uses the provided body as the override.
    - POSIX: `path` (absolute) when provided overrides the default; `chmod` defaults to `0600`; `unlink_stale` defaults to true.
    - Windows: `path` overrides the default (defaults to `\\.\pipe\termstation`).
- If `listeners` is absent, a single local socket listener is started by default (OS‑appropriate path/name).
- Environment suffix: when `listeners.socket.path` is not provided, the backend appends `-<environment>` to the default endpoint for non‑production environments (e.g., `termstation-test.sock`, `\\.\pipe\termstation-test`). Production keeps the canonical name.
- WebSockets share the same servers in all modes. When using a socket/pipe client, ensure a `Host` header is set so URL parsing works (`req.headers.host`).

- Base path: `/api`
- Auth: cookie-based for HTTP endpoints and token/cookie for WebSocket; see `doc/authentication.md`.
- All endpoints return JSON unless otherwise noted.
- Errors return appropriate HTTP status codes with a JSON body `{ error, message|details, ... }`.
- Rate limiting: certain operations return HTTP 429 `{ error: 'RATE_LIMITED', details: '...' }`.
- Visibility and permissions: some operations are governed by per-user permissions and session visibility.

See also:
- Authentication: `doc/authentication.md`
- Stdin injection details: `doc/stdin-injection.md`

## Sessions

Base: `/api/sessions`

Session ID vs Alias
- Endpoints that take `:sessionId` accept either the real session UUID or a configured alias.
- Aliases are optional and defined per template via `session_alias` (string). They must be URL‑safe slugs matching `[A-Za-z0-9._-]+`.
- The server resolves by ID first; if not found, it falls back to alias lookup. Standard access/visibility checks apply after resolution.
- Aliases are registered at session creation and automatically unregistered when the session ends. The alias registry is in‑memory and not persisted across restarts.

Session object fields (additions)
- All endpoints that return a “full session object” now also include:
  - `ephemeral_bind_mounts` (array of strings, optional):
    - Present only for container‑isolated sessions that declare template `bind_mounts`.
    - Each entry is an absolute host path under `<data_dir>/sessions/<session_id>/...` corresponding to ephemeral files or directories bind‑mounted into the container (for example, files under `/workspace/...`).
    - Paths are computed at session creation time from template `bind_mounts.container_path` and are used by the backend’s termination logic to perform best‑effort cleanup via `podman unshare rm -rf`.
    - This field is informational for API consumers; it is not intended to be mutated by clients.
  - `workspace_host_path` (string, optional):
    - Present for sessions whose `isolation_mode` is `container` or `directory`.
    - Absolute host filesystem path to the per‑session workspace directory (layout: `<SESSIONS_DIR>/<session_id>/workspace`).
    - This value is primarily intended for tooling and UI affordances (for example, “Copy workspace path”); clients should treat it as read‑only metadata.
  - `workspace_service_enabled_for_session` (boolean, optional):
    - Indicates whether the per-session Workspace file API is enabled for this session.
    - Computed from global feature flags, template `workspace_service_enabled`, and the effective isolation mode (`container`/`directory` only).
  - `workspace_service_port` (number or null, optional):
    - Legacy field exposing a computed per-session TCP port used by older container-side workspace helpers.
    - Preserved for compatibility and debugging only; current deployments should not rely on it for routing, and it may be `null` even when the Workspace API is enabled.
  - `workspace_service_available` (boolean, optional):
    - Convenience flag for UIs to determine whether the Workspace tab should be shown.
    - True when the service is enabled and the backing workspace directory exists on disk; false when disabled or when the directory is missing (for example after cleanup).

- POST `/` — Create a new session (template-based only)
  - Body:
    - `template_id` (string, required): ID of a template the user is allowed to use
    - `template_parameters` (object, optional): key/value parameters used by the template (strings). Unknown keys OK, reserved keys rejected
    - `isolation_mode` (string, optional): override the template's isolation at runtime. One of `none`, `directory`, `container`. When omitted, the template default determines behavior. If the template defines `isolation_modes`, the override must be one of the allowed modes or the server returns `400` with `{ error: 'INVALID_ISOLATION_MODE', allowed_modes: [...] }`
    - `title` (string, optional)
    - `workspace` (string, optional; default `Default` or template default)
    - `visibility` (string, optional; one of `public`, `private`, `shared_readonly`; default `private`)
    - Terminal sizing (optional): `cols` (number), `rows` (number)
    - `fork_from_session_id` (string, optional): fork metadata and history seeding; allowed when requester can access the source session
    - Scheduled input rules (optional; see doc/stdin-injection.md):
      - `scheduled_input_rules` (array) OR `scheduled_inputs: { rules: [...] }` OR `scheduled_inputs_json` (stringified JSON)
    - Stop inputs (optional; overrides template defaults when provided):
      - `stop_inputs` (array, optional): Array of stop input prompts. Each item may include:
        - `id` (string, optional): If omitted, auto-generated UUID
        - `prompt` (string, required): The prompt text to inject
        - `armed` (boolean, optional): Whether this prompt is armed (default `true`)
        - `source` (string, optional): `"template"` or `"user"` (default `"template"`)
      - `stop_inputs_enabled` (boolean, optional): Whether stop inputs are enabled (default `true` unless template sets `false`)
      - `stop_inputs_rearm_remaining` (number, optional): Initial rearm counter value (also accepts `stop_inputs_rearm` as alias)
  - Behavior:
    - Direct non-template command sessions are disabled (API returns 400)
    - Enforces global and per-user create rate limits
    - Enforces global/per-user/per-group session limits when configured
    - Computes effective parameter defaults and persists on the session
    - Stop inputs: When `stop_inputs`, `stop_inputs_enabled`, or `stop_inputs_rearm_remaining` are provided in the request body, they override template defaults. If not provided, template values are used. IDs are auto-generated when omitted.
    - Validates constrained select parameters: when a template parameter is `type: "select"` with a constrained options list (either static `options` or user/group-driven options via `options_source: "user"`), and a value is provided, the value must match one of the allowed options. Templates may opt out per-parameter by setting `strict_options: false` on that parameter (default is `true`). Command-based selects (`options_source: "command"` or with `command`/`command_file`) are not validated against a precomputed list.
    - For isolation `container` or `directory`, builds a per-session workspace directory (`logs/<sid>/workspace`) with orchestrator scripts; container mounts it at `/workspace` and runs `/workspace/.bootstrap/scripts/run.sh`
    - Auto-creates `workspace` if configured and broadcasting updates
  - Responses:
    - 200 with full session object (includes `isolation_mode: string`)
    - 400 on validation (e.g., template required, reserved parameter keys, invalid select value — `{ error: 'INVALID_PARAMETER_VALUE', code: 'INVALID_SELECT_VALUE', parameter, allowed_values }`)
    - 400 `INVALID_ISOLATION_MODE` when override or effective isolation is not allowed by the template (`allowed_modes` included in response)
    - 403 on template access denied
    - 429 rate-limited
    - 500 `USER_OPTIONS_RESOLUTION_FAILED` when user/group options cannot be resolved for a user-sourced select parameter (e.g., misconfigured `parameter_values` or config load failure)

### Template Isolation Constraints

Templates may optionally declare an allowed set of isolation modes via a new field:

```
isolation_modes: ["none" | "directory" | "container", ...]
```

- When omitted, all three modes are allowed (default behavior).
- The server accepts a runtime `isolation_mode` override only if it is listed in `isolation_modes`.
- The final effective isolation (template default or override) must also be allowed by `isolation_modes`.
- Auto-start templates honor the same rules: disallowed overrides are ignored, and templates whose effective isolation is not allowed are skipped.

Frontend behavior driven by `isolation_modes`:
- New Session: the Isolation selector is shown only when there is more than one allowed mode. When exactly one mode is allowed, the selector is hidden and that mode is auto-applied to the create request.
- New Session: the `container_image` parameter is hidden unless the selected/effective isolation is `container`.
- Fork → Isolation: only the allowed modes are listed.

- GET `/` — List active sessions (plus some parents of active children)
  - Returns an array of session objects visible to the user; admins see all
  - Includes `has_active_children` for parents of active child sessions

- GET `/search` — Search sessions (GET variant)
  - Query params map to POST search body; see POST `/search`
  - Optional params:
    - `search_content` (boolean, default false): when true, also scan large history output files for matches (slower)
  
- GET `/:sessionId` — Get session details (active or terminated)
  - 403 when requester cannot access a private session they don’t own
  - 404 when session not found
  - Response includes `session_alias` when set

- DELETE `/:sessionId` — Terminate an active session
  - Requires terminate permission by visibility (owner for private/shared_readonly; public allowed)
  - 429 when rate-limited
  
- POST `/:sessionId/command-tabs/exec` — Execute a template-defined command tab (secure; no arbitrary commands)
  - Body:
    - `tab_index` (number, required): index into `session.command_tabs` (as provided by the template at session creation)
    - `client_id` (string, optional): origin client for UI context
  - Behavior:
    - The server looks up the command and optional `cwd` from `session.command_tabs[tab_index]`
    - For `isolation_mode = container`, the server locates the container for the parent session and uses a runtime exec with a guarded wrapper
    - For `isolation_mode = directory` or `none`, the server runs directly on the host with `working_directory` from the tab spec (or parent session)
    - Creates a child session with `parent_session_id`, `child_tab_type: 'command'`, and `show_in_sidebar: false`
    - Prevents clients from supplying arbitrary commands; only template-provided tabs are executable
    - Template field `refresh_on_view: true|false` controls whether a command tab re-runs on every view (true) or only on the first view unless manually refreshed (false)
  - Responses:
    - 200: full child session object
    - 400: invalid `tab_index`
    - 403: permission error (owner/admin required for host execution; `sandbox_login` required for containers)
    - 404: parent or target container not found

- POST `/:sessionId/resize` — Resize terminal
  - Body: `{ cols: number, rows: number }` (values clamped to sane minimums)
  - Requires the requester to be attached to the session over WS (server enforces reasonable constraints)
  
- POST `/:sessionId/input` — Inject input
  - Requires permission `inject_session_input`
  - Body:
    - `data` (string): bytes to write to stdin
    - `submit` (boolean, default true): send Enter after data
    - `enter_style` (string, default `cr`): `cr` | `lf` | `crlf`
    - `raw` (boolean, default false): send exactly as provided, do not auto-submit
    - `delay_ms` (number, default from config; additional Enter delay)
    - `simulate_typing` (boolean, default from config)
    - `typing_delay_ms` (number, default from config)
    - `activity_policy` (string, optional): `"defer"` (default), `"immediate"`, or `"suppress"`
      - `immediate`: inject regardless of current output activity
      - `suppress`: if the session is actively producing output, the request is accepted but suppressed; response indicates `{ suppressed: true }`
      - `defer`: when the session is actively producing output, the request is queued and will be injected once the session transitions to inactive
    - `notify` (boolean, optional): UI hint carried in WS payload; emission is not suppressed by this flag
    - Focus emulation: `stdin_injection.send_focus_in`, `stdin_injection.send_focus_out` (booleans)
  - Limits: optional per-session POST cap returns 429 when exceeded (applies when the input is actually injected, including deferred deliveries)
  - Behavior:
    - Always emits a `stdin_injected` WS event to connected clients (including the submitter), regardless of `notify`
    - Server does not persist input markers for this event; clients capture a render marker (timestamp + line) and POST it to `/:sessionId/markers`
  - Deferred inputs:
    - When `activity_policy: "defer"` (explicit or by default) and the session is actively producing output, the request is accepted and queued instead of injected immediately.
    - The response includes `{ ok: true, deferred: true, activity_policy, pending_id?, bytes?, deduped? }`:
      - `pending_id`: ID of the queued entry (omitted when deduped).
      - `bytes`: length of `data` (omitted when deduped).
      - `deduped: true` indicates the payload matched an existing queued entry and was discarded.
  
- POST `/:sessionId/upload-image` — Upload an image for drag/drop and paste
  - Feature-gated by `image_uploads_enabled` (403 when disabled)
  - Body:
    - `filename` (string, required): original file name; sanitized on save
    - `content` (string, required): base64 data or full data URL
    - `mime_type` (string, optional): e.g., `image/png`
  - Validation:
    - Only image types are accepted: extensions { .png, .jpg, .jpeg, .gif, .webp, .svg, .bmp } or `mime_type` beginning with `image/`
    - Decoded size is capped by `config.UPLOADS_MAX_IMAGE_BYTES` (413 on overflow)
  - Storage location (host):
    - `<data_dir>/sessions/<sessionId>/workspace/.bootstrap/uploads/<sanitized-filename>`
  - Response shape depends on isolation mode:
    - `container`: `{ "container_path": "/workspace/.bootstrap/uploads/<filename>" }`
    - `directory` or `none`: `{ "path": "<absolute-host-path-to-workspace>/.bootstrap/uploads/<filename>" }`
  - Notes:
    - The frontend uses `container_path || path` to insert a usable path into the terminal input.
    - For data URLs in `content`, the server strips the header and decodes the base64 payload automatically.
  
- POST `/:sessionId/links` — Add one or more link tabs to a session
  - Body: `{ links: [{ url: string, name?: string, refresh_on_view?: boolean }] }`
  - Behavior: merges by URL; updates existing name or `refresh_on_view` when provided

- PATCH `/:sessionId/links` — Update a link tab
  - Body: `{ url: string, name?: string, refresh_on_view?: boolean }`
  - Broadcasts `link-updated` with `{ sessionId, url, name?, refresh_on_view? }`

- DELETE `/:sessionId/links?url=<url>` — Remove a link tab
  - Broadcasts `link-removed` with `{ sessionId, url }`

- GET `/:sessionId/input/rules` — List scheduled input rules
- POST `/:sessionId/input/rules` — Create rules array
- PATCH `/:sessionId/input/rules/:ruleId` — Update a rule
- DELETE `/:sessionId/input/rules/:ruleId` — Remove a rule
- DELETE `/:sessionId/input/rules` — Clear all rules
- POST `/:sessionId/input/rules/:ruleId/trigger` — Trigger immediately
  - See `doc/stdin-injection.md` for rule schema and options

- Deferred input management
  - `GET /:sessionId/deferred-input` — List queued deferred inputs
    - Visibility: same as `GET /:sessionId`.
    - Response:
      ```json
      {
        "session_id": "<SESSION_ID>",
        "items": [
          {
            "id": "<PENDING_ID>",
            "session_id": "<SESSION_ID>",
            "key": "api-input" | "rule:<RULE_ID>",
            "source": "api" | "scheduled" | "stop-inputs",
            "created_at": "2025-11-22T02:39:21.860Z",
            "bytes": 42,
            "activity_policy": "defer",
            "data_preview": "first 200 bytes…"
          }
        ]
      }
      ```
  - `DELETE /:sessionId/deferred-input/:pendingId` — Delete a single queued item
    - Auth: active, interactive session, `inject_session_input` permission, ownership/`manage_all_sessions`.
    - Responses:
      - `204` on success.
      - `404` when `pendingId` not found.
  - `DELETE /:sessionId/deferred-input` — Clear all queued items
    - Auth: same as above.
    - Response: `{ "cleared": <number-of-items> }`.
  
- PUT `/:sessionId/title` — Set session title
  - Body: `{ title: string }`
  
- PUT `/:sessionId/parameters` — Update effective template parameters
  - Body: `{ template_parameters: { ... } }`

- PUT `/:sessionId/workspace` — Move session to a workspace
  - Body: `{ workspace: string }`

- POST `/:sessionId/save-history` — Enable/disable history saving
  - Body: `{ save: boolean }`

- Links management
  - POST `/:sessionId/links` — Add links
  - PATCH `/:sessionId/links` — Update a link
  - DELETE `/:sessionId/links` — Remove a link

  Link object shape (session-level):
  - `{ "url": string, "name"?: string, "link_id"?: string, "refresh_on_view"?: boolean, "show_active"?: boolean, "show_inactive"?: boolean, "show_url_bar"?: boolean, "pass_theme_colors"?: boolean, "refresh_on_view_active"?: boolean, "refresh_on_view_inactive"?: boolean }`
    - `link_id` (optional; string) is a stable backend-assigned identifier for template-defined links. When present, clients should prefer the ID-based pre-view endpoints instead of positional indices.
    - `refresh_on_view` (optional; default `false`) controls whether the corresponding URL tab in the UI refreshes its content whenever the tab is visited/switched to.
    - `show_active` / `show_inactive` (optional; default `true`) control visibility while the session is active vs terminated.
    - `show_url_bar` (optional; default `true`) allows templates to hide the in-tab URL bar for embedded content.
    - `pass_theme_colors` (optional; default `false`) enables passing current theme colors to template-defined pre-view commands; it is ignored for user-added links.
    - `refresh_on_view_active` / `refresh_on_view_inactive` (optional; default `false`) allow separate “refresh on view” behavior depending on session state.
    - The `pre_view_command` attribute is reserved for template-defined links and is ignored when supplied to this endpoint.

  Examples:
  - POST body:
    ```json
    { "links": [ { "url": "https://example.com", "name": "Example", "refresh_on_view": true } ] }
    ```
  - PATCH body:
    ```json
    { "url": "https://example.com", "name": "New Name", "refresh_on_view": true }
    ```

  Template-defined links may additionally include:
  - `pre_view_command` (string, optional; template-only):
    - Shell command to generate HTML content for a “chat” link before the tab is opened.
    - Processed using the shared template text engine, with unknown macros resolving to empty strings.
  - `output_filename` (string, optional; template-only):
    - Templated name for the generated HTML file (before sanitization); if omitted, the backend defaults to `link-<idx>.html`.

  Pre-view endpoints:
  - POST `/:sessionId/links/id/:linkId/generate` — Generate HTML for a template-defined link (preferred)
    - `linkId` must match the `link_id` property of a template-defined link in `session.links`.
    - Body (optional): `{ "theme"?: { "<key>": "<color>", ... }, "fonts"?: { "ui"?: string, "code"?: string } }`
    - Behavior:
      - Requires the requester to be able to view the session (same as `GET /:sessionId`).
      - Rejects non-template links (`NOT_TEMPLATE_LINK`) and links without a defined `pre_view_command` (`NO_PRE_VIEW_COMMAND`).
      - Resolves the link by `link_id` and returns `LINK_NOT_FOUND` when the id does not exist for the session.
      - Runs the template-defined `pre_view_command` with a 5s timeout when present. The command receives:
        - Environment variables and `{var}` macros:
          - `SESSION_ID` / `session_id`
          - `SESSION_DIR` / `session_dir` — `<SESSIONS_DIR>/<session_id>`
          - `WORKSPACE_DIR` / `workspace_dir` — `<SESSION_DIR>/workspace`
          - `OUTPUT_HTML` / `output_html` — absolute path to the generated HTML file under `<SESSION_DIR>/links`.
        - When the link has `pass_theme_colors: true`, each entry under `theme` becomes a macro/env var `THEME_<KEY>`, where `<KEY>` is uppercased and non-alphanumeric characters are mapped to `_` (for example, `{ theme: { "bg_primary": "#112233" } }` → `THEME_BG_PRIMARY="#112233"`). This scheme is fully generic and applies to any key provided by the frontend.
        - TermStation’s own themes expose a core palette via CSS custom properties on `document.documentElement`; the frontend normalizes these to theme keys by stripping the leading `--` and replacing `-` with `_`, then forwards them under `theme`:
          - `--bg-primary` → `bg_primary` → `{THEME_BG_PRIMARY}` / `THEME_BG_PRIMARY`
          - `--bg-secondary` → `bg_secondary` → `{THEME_BG_SECONDARY}` / `THEME_BG_SECONDARY`
          - `--bg-tertiary` → `bg_tertiary` → `{THEME_BG_TERTIARY}` / `THEME_BG_TERTIARY`
          - `--bg-hover` → `bg_hover` → `{THEME_BG_HOVER}` / `THEME_BG_HOVER`
          - `--text-primary` → `text_primary` → `{THEME_TEXT_PRIMARY}` / `THEME_TEXT_PRIMARY`
          - `--text-secondary` → `text_secondary` → `{THEME_TEXT_SECONDARY}` / `THEME_TEXT_SECONDARY`
          - `--text-dim` → `text_dim` → `{THEME_TEXT_DIM}` / `THEME_TEXT_DIM`
          - `--border-color` → `border_color` → `{THEME_BORDER_COLOR}` / `THEME_BORDER_COLOR`
          - `--accent-color` → `accent_color` → `{THEME_ACCENT_COLOR}` / `THEME_ACCENT_COLOR`
          - `--accent-hover` → `accent_hover` → `{THEME_ACCENT_HOVER}` / `THEME_ACCENT_HOVER`
          - `--danger-color` → `danger_color` → `{THEME_DANGER_COLOR}` / `THEME_DANGER_COLOR`
          - `--success-color` → `success_color` → `{THEME_SUCCESS_COLOR}` / `THEME_SUCCESS_COLOR`
          - `--warning-color` → `warning_color` → `{THEME_WARNING_COLOR}` / `THEME_WARNING_COLOR`
        - When the link has `pass_theme_colors: true`, optional `fonts.ui` / `fonts.code` fields are exposed as template macros `{THEME_FONT_UI}` / `{THEME_FONT_CODE}` and corresponding environment variables `THEME_FONT_UI` / `THEME_FONT_CODE`. Font strings are trimmed and stripped of control characters; missing values default to empty strings.
      - Unknown macros resolve to empty strings via the shared `processText` pipeline.
      - The output filename is derived from the link’s `output_filename` when provided (after templating), otherwise from `link-<idx>.html`. The backend sanitizes filenames by stripping path separators, removing leading dots, and forcing a `.html` extension. Files are always written under `<SESSIONS_DIR>/<session_id>/links/` to survive workspace cleanup.
    - Responses:
      - `200` with `{ "html_url": "/api/sessions/:sessionId/links/id/:linkId/html" }` on success when `link_id` is available (falls back to the index-based HTML URL shape when not).
      - `400` on invalid IDs or unsupported links (`INVALID_LINK_ID`, `NOT_TEMPLATE_LINK`, `NO_PRE_VIEW_COMMAND`, `INVALID_COMMAND`).
      - `403` when the requester cannot view the session.
      - `404` when the session or link id is not found (`SESSION_NOT_FOUND`, `LINK_NOT_FOUND`).
      - `500` when command execution fails (`COMMAND_FAILED`) or on unexpected I/O errors.

    - Example error responses:
      ```json
      {
        "error": "LINK_NOT_FOUND",
        "details": "Link id not found"
      }
      ```
      ```json
      {
        "error": "COMMAND_FAILED",
        "details": "Command failed: bash -lc \"...\""
      }
      ```

  - POST `/:sessionId/links/:idx/generate` — Generate HTML for a template-defined link (legacy, index-based)
    - Body (optional): `{ "theme"?: { "<key>": "<color>", ... }, "fonts"?: { "ui"?: string, "code"?: string } }`
    - Behavior:
      - Requires the requester to be able to view the session (same as `GET /:sessionId`).
      - Rejects non-template links (`NOT_TEMPLATE_LINK`) and links without a defined `pre_view_command` (`NO_PRE_VIEW_COMMAND`).
      - Runs the template-defined `pre_view_command` with a 5s timeout when present. The command receives:
        - Environment variables and `{var}` macros:
          - `SESSION_ID` / `session_id`
          - `SESSION_DIR` / `session_dir` — `<SESSIONS_DIR>/<session_id>`
          - `WORKSPACE_DIR` / `workspace_dir` — `<SESSION_DIR>/workspace`
          - `OUTPUT_HTML` / `output_html` — absolute path to the generated HTML file under `<SESSION_DIR>/links`.
        - When the link has `pass_theme_colors: true`, each entry under `theme` becomes a macro/env var `THEME_<KEY>`, where `<KEY>` is uppercased and non-alphanumeric characters are mapped to `_` (for example, `{ theme: { "bg_primary": "#112233" } }` → `THEME_BG_PRIMARY="#112233"`). This scheme is fully generic and applies to any key provided by the frontend.
        - TermStation’s own themes expose a core palette via CSS custom properties on `document.documentElement`; the frontend normalizes these to theme keys by stripping the leading `--` and replacing `-` with `_`, then forwards them under `theme`:
          - `--bg-primary` → `bg_primary` → `{THEME_BG_PRIMARY}` / `THEME_BG_PRIMARY`
          - `--bg-secondary` → `bg_secondary` → `{THEME_BG_SECONDARY}` / `THEME_BG_SECONDARY`
          - `--bg-tertiary` → `bg_tertiary` → `{THEME_BG_TERTIARY}` / `THEME_BG_TERTIARY`
          - `--bg-hover` → `bg_hover` → `{THEME_BG_HOVER}` / `THEME_BG_HOVER`
          - `--text-primary` → `text_primary` → `{THEME_TEXT_PRIMARY}` / `THEME_TEXT_PRIMARY`
          - `--text-secondary` → `text_secondary` → `{THEME_TEXT_SECONDARY}` / `THEME_TEXT_SECONDARY`
          - `--text-dim` → `text_dim` → `{THEME_TEXT_DIM}` / `THEME_TEXT_DIM`
          - `--border-color` → `border_color` → `{THEME_BORDER_COLOR}` / `THEME_BORDER_COLOR`
          - `--accent-color` → `accent_color` → `{THEME_ACCENT_COLOR}` / `THEME_ACCENT_COLOR`
          - `--accent-hover` → `accent_hover` → `{THEME_ACCENT_HOVER}` / `THEME_ACCENT_HOVER`
          - `--danger-color` → `danger_color` → `{THEME_DANGER_COLOR}` / `THEME_DANGER_COLOR`
          - `--success-color` → `success_color` → `{THEME_SUCCESS_COLOR}` / `THEME_SUCCESS_COLOR`
          - `--warning-color` → `warning_color` → `{THEME_WARNING_COLOR}` / `THEME_WARNING_COLOR`
        - When the link has `pass_theme_colors: true`, optional `fonts.ui` / `fonts.code` fields are exposed as template macros `{THEME_FONT_UI}` / `{THEME_FONT_CODE}` and corresponding environment variables `THEME_FONT_UI` / `THEME_FONT_CODE`. Font strings are trimmed and stripped of control characters; missing values default to empty strings.
      - Unknown macros resolve to empty strings via the shared `processText` pipeline.
      - The output filename is derived from the link’s `output_filename` when provided (after templating), otherwise from `link-<idx>.html`. The backend sanitizes filenames by stripping path separators, removing leading dots, and forcing a `.html` extension. Files are always written under `<SESSIONS_DIR>/<session_id>/links/` to survive workspace cleanup.
    - Responses:
      - `200` with `{ "html_url": "/api/sessions/:sessionId/links/id/:linkId/html" }` on success when `link_id` is available for the target link (falls back to `/api/sessions/:sessionId/links/:idx/html` when not).
      - `400` on invalid indices or unsupported links (`INVALID_LINK_INDEX`, `NOT_TEMPLATE_LINK`, `NO_PRE_VIEW_COMMAND`, `INVALID_COMMAND`).
      - `403` when the requester cannot view the session.
      - `404` when the session or link index is not found.
      - `500` when command execution fails (`COMMAND_FAILED`) or on unexpected I/O errors.

    - Example error responses:
      ```json
      {
        "error": "NOT_TEMPLATE_LINK",
        "details": "Pre-view generation is allowed only for template links"
      }
      ```
      ```json
      {
        "error": "COMMAND_FAILED",
        "details": "Command failed: bash -lc \"...\""
      }
      ```

  - GET `/:sessionId/links/id/:linkId/html` — Serve previously generated HTML for a link resolved by `link_id`
    - Behavior:
      - Requires the requester to be able to view the session.
      - Resolves the template link by `link_id` and uses the same sanitized path used by the generate endpoint and returns its contents as `text/html`.
    - Responses:
      - `200` with HTML body when the file exists.
      - `404` (`HTML_NOT_FOUND`) when the file is missing or the link id cannot be resolved.
      - `500` (`IO_ERROR` or `READ_FAILED`) on unexpected filesystem errors.

    - Example error responses:
      ```json
      {
        "error": "HTML_NOT_FOUND",
        "details": "Generated HTML not found"
      }
      ```

  - GET `/:sessionId/links/:idx/html` — Serve previously generated HTML for a link (legacy, index-based)
    - Behavior:
      - Requires the requester to be able to view the session.
      - Looks up the same sanitized path used by the generate endpoint and returns its contents as `text/html`.
    - Responses:
      - `200` with HTML body when the file exists.
      - `404` (`HTML_NOT_FOUND`) when the file is missing.
      - `500` (`IO_ERROR` or `READ_FAILED`) on unexpected filesystem errors.

    - Example error responses:
      ```json
      {
        "error": "HTML_NOT_FOUND",
        "details": "Generated HTML not found"
      }
      ```
      ```json
      {
        "error": "READ_FAILED",
        "details": "Unexpected I/O error reading generated HTML"
      }
      ```

- Notes (feature-gated by `notes_enabled`)
  - GET `/:sessionId/note` — Get note snapshot
  - PUT `/:sessionId/note` — Update note `{ content, version }`

- Stop inputs (template- and user-managed, feature is always available; UI integration is separate)
  - `GET /:sessionId/stop-inputs` — Get stop inputs configuration
    - Visibility: same as `GET /:sessionId`.
    - Response:
      ```json
      {
        "session_id": "<SESSION_ID>",
        "stop_inputs_enabled": true,
        "stop_inputs_rearm_remaining": 0,
        "stop_inputs_rearm_max": 10,
        "stop_inputs": [
          {
            "id": "<UUID>",
            "prompt": "Remember to check the logs",
            "armed": true,
            "source": "template" | "user"
          }
        ]
      }
      ```
  - `PUT /:sessionId/stop-inputs` — Replace stop inputs for an active session
    - Auth: owner or `manage_all_sessions`.
    - Body:
      ```json
      {
        "stop_inputs": [
          { "id": "<optional>", "prompt": "string", "armed": true, "source": "template" | "user" }
        ],
        "stop_inputs_rearm_remaining": 0
      }
      ```
    - Behavior: normalizes entries, generates IDs when absent, and sets `source` default to `"template"` when not `"user"`.
    - Broadcasts `session_updated` with the updated session object.
  - `POST /:sessionId/stop-inputs/enabled` — Toggle or set global stop inputs enabled flag
    - Auth: owner or `manage_all_sessions`.
    - Body:
      - Optional: `{ "enabled": boolean, "stop_inputs_rearm_remaining": 0 }` (when `enabled` is omitted, the flag is toggled).
    - Response:
      ```json
      {
        "session_id": "<SESSION_ID>",
        "stop_inputs_enabled": true,
        "stop_inputs_rearm_remaining": 0,
        "stop_inputs_rearm_max": 10
      }
      ```
    - Broadcasts `session_updated`.
  - `POST /:sessionId/stop-inputs/:promptId/toggle` — Toggle or set a single prompt’s `armed` state
    - Auth: owner or `manage_all_sessions`.
    - Body:
      - Optional: `{ "armed": boolean }` (when omitted, `armed` is toggled).
    - Responses:
      - `200` with the updated configuration (same shape as `GET /stop-inputs`).
      - `404` when the prompt ID is not found.

- Search (POST variant)
  - POST `/search` — Search by text and parameters
  - Body:
    ```json
    {
      "query": "deploy",
      "filter_type": "active" | "inactive" | "all",
      "scope": "active" | "inactive" | "all",
      "params": { "issue_id": "712", "repo": "devtools/terminals" },
      "ids_only": true,
      "search_content": false
    }
    ```
  - Notes:
    - When `search_content` is `true`, the backend also scans large terminal history output for matches (slower). Default is `false` (metadata-only).

- History
  - GET `/:sessionId/history` — Returns metadata only
  - GET `/:sessionId/history/html` — Streams pre-rendered HTML history (`text/html`) for terminated sessions when available
  - HEAD `/:sessionId/history/raw` — Returns `Content-Length` when known
  - GET `/:sessionId/history/raw` — Streams `text/plain` content
    - Supports `Range: bytes=start-end`
    - Query: `tail_bytes=n`, `since_offset=n`
- DELETE `/:sessionId/history` — Clear history (owner/admin per visibility)

- Render markers (client-reported)
  - POST `/:sessionId/markers` — Append a render marker captured by the client UI
    - Body: `{ t: number (epoch ms), line: number (0-based) }`
    - AuthZ: owner or admin (same as other session-mutating endpoints)
    - Behavior: appends to in-memory `render_markers` for active sessions; persists immediately for terminated sessions; broadcasts `session_updated`
    - Notes: the client typically reports the current xterm buffer line at the time of input submission, allowing reliable seek by line after reloads

- History listing
  - GET `/history/all` — List all sessions (active + terminated) with history metadata
    - Filters by visibility (private sessions are only visible to their owner or admins)
    - Returns an array of session objects (serialized via history list view)
  - GET `/history/paginated` — Paginated terminated sessions for history view
    - Query params:
      - `page` (number, default 1)
      - `limit` (number, default 50)
      - `search` (string): search across `session_id`, `command`, `working_directory`, `title`, `template_name`
      - `template` (string): filter by `template_name`
      - `sortBy` (string, default `created_at`): field to sort by
      - `sortOrder` (string, default `desc`): `asc` or `desc`
      - `dateFilter` (string, default `all`): `all`, `today`, `week`, `month`
    - Returns: `{ sessions: [...], pagination: { page, limit, total, totalPages, hasNext, hasPrev }, filters: { availableTemplates } }`

- Visibility
  - PUT `/:sessionId/visibility` — Update session visibility `{ visibility: 'public'|'private'|'shared_readonly' }`

### Service Proxy

Base: `/api/sessions/:sessionId/service/:port`

- ALL methods are proxied into a TCP service inside the session’s sandbox container via a reverse tunnel
- Example: `GET /api/sessions/abc123/service/8080/health`
- Access control: same as session visibility (owner-only for private unless admin)
- Errors: `503` when tunnel unavailable; `502` on upstream failure/timeout

- WebSocket support: The same path supports WebSocket upgrades and streams over the reverse tunnel.
  - Example (wscat): `wscat -c "wss://<host>/api/sessions/<sid>/service/8080/socket?token=<access-token>"`
  - Auth: either include `?token=<access-token>` (from session access token helpers) or rely on cookies when authenticated in the browser.
  - Tokens: By default, session access tokens do not include a time-based expiration and remain valid for the lifetime of the session. Administrators can configure a positive TTL via `session_token.ttl_seconds`.
  - Headers: hop-by-hop headers are normalized; the `Connection: Upgrade` header is preserved for compatibility and added when missing if `Upgrade` is present.

## Workspaces

Base: `/api/workspaces`

- GET `/` — List user workspaces (merged with names from visible sessions)
- PUT `/order` — Set workspace order `{ order: ["Default", "Builds", ...] }`
- PUT `/:name/sessions/order` — Reorder sessions in a workspace `{ order: [sessionId, ...] }`
- POST `/` — Create `{ name }` (auto-broadcasts updates)
- PUT `/:name` — Rename `{ new_name }` (and update sessions)
- DELETE `/:name` — Delete and re-associate sessions to `Default`
- PATCH `/:name` — Update attributes (currently `pinned`)
- Notes (feature-gated by `notes_enabled`)
  - GET `/:name/note`
  - PUT `/:name/note` `{ content, version }`

## Containers

Base: `/api/containers`

- GET `/` — List containers for the configured runtime `{ containers: [...] }`
- POST `/attach` — Create a session attached to an existing container
  - Requires permission `sandbox_login`
  - Body: `{ name, parent_session_id? }`
- POST `/exec` — Run a one‑liner command inside a running container (creates a child session)
  - Requires permission `sandbox_login`
  - Body:
    - `name` (string, required): container name or short ID
    - `command` (string, required): one‑liner to execute via `bash -lc '…'`
    - `parent_session_id` (string, optional): parent session to associate (auto‑resolved from container labels/name when omitted)
    - `title` (string, optional): friendly title for the child session; defaults to a truncated command preview
  - Behavior:
    - Executes in the container user context configured by the backend runtime
    - Creates a terminal child session associated with the parent (when resolvable)
    - Intended for UI command tabs; the child may be hidden from certain views
  - Responses:
    - 200: full child session object (standard session shape)
    - 400: missing name or command
    - 403: missing permission `sandbox_login`
    - 404: container not found
    - 500: runtime failure
- GET `/lookup?session_id=<sid>` — Find containers matching a session
- POST `/stop` — Stop container `{ name | id | name_or_id }`
- POST `/terminate-all` — Remove all containers and volumes (requires `terminate_containers`)

## System

Base: `/api`

- GET `/info` — System info `{ version, platform, arch, node_version, uptime, ... }`
- POST `/auth/logout` — Clear auth cookie
- POST `/auth/reset-token` — Rotate server secret and set a fresh cookie (feature-gated by `cookie_token_reset_enabled`)
- POST `/system/reload-config` — Reload templates/users/groups/links config from disk (feature-gated by `config_reload_enabled`)
- GET `/ws-token` — Short-lived WS token for handshake `{ token }`
- GET `/tunnel-helper/:platform-:arch` — Helper download (returns 404 until configured)
- GET `/templates` — List templates allowed for the user
- GET `/links` — List global links
- GET `/templates/:templateId/parameters/:parameterName/options` — Dynamic options
- POST `/templates/:templateId/parameters/:parameterName/options` — Dynamic options (POST variant)
- POST `/notifications` — Create notification for current user, or broadcast to users attached to a session when `session_id` is provided (requires `broadcast` permission)
- POST `/shutdown` — Broadcast shutdown and exit after delay
- GET `/health` — Health check `{ status: 'healthy' }`

## Notifications

Base: `/api/notifications`

- GET `/` — List current user notifications `{ notifications: [...] }`
  - Returns an array of persisted notification objects for the authenticated user.
  - Basic fields:
    - `id`, `title`, `message`, `notification_type`, `timestamp`, `session_id`, `is_active`, `read`.
  - Interactive fields (optional, see below):
    - `actions`: array of `{ key, label, style?, requires_inputs? }`.
    - `inputs`: array of `{ id, label, type, required, placeholder?, max_length? }`.
    - `response`: optional summary of a completed interactive notification:
      - `at`: ISO timestamp when the response was recorded.
      - `user`: username that responded.
      - `action_key` / `action_label`: chosen action.
      - `inputs`: map of non-secret input ids → values.
      - `masked_input_ids`: array of input ids that were submitted as secrets (their values are **never** persisted).
  - Backend-only callback metadata (`callback_url`, `callback_method`, `callback_headers`) is not included in responses.
- POST `/` — Create a notification for current user (or broadcast to session participants)
  - Behavior:
    - With no `session_id`, creates a notification for the current user only.
    - With `session_id`, requires the `broadcast` permission and delivers to:
      - The session owner.
      - All currently attached users for that session (based on WebSocket connections).
  - Body (simple notifications — existing behavior):
    - `title` (string, required).
    - `message` (string, required).
    - `type` (string, optional): `info` | `warning` | `error` | `success` (default `info`).
    - `session_id` (string, optional): when present, see broadcast behavior above.
    - `sound` (boolean, optional): when true, frontend may play a notification sound.
  - Body (interactive notifications — optional extensions):
    - `callback_url` (string, required when any interactive fields are present)
      - Must be an `http` or `https` URL.
      - Reasonable length enforced; excessively long URLs are rejected.
    - `callback_method` (string, optional; default `POST`)
      - One of: `POST`, `PUT`, `PATCH` (case-insensitive).
    - `callback_headers` (object, optional)
      - Map of header name → value (strings).
      - Used only for the backend-to-backend callback HTTP request; not exposed to clients.
    - `inputs` (array, optional)
      - Each entry:
        - `id` (string, required, unique per notification).
        - `label` (string, required).
        - `type` (string, optional): `"string"` (default) or `"secret"` (never persisted, only forwarded to callbacks).
        - `required` (boolean, optional): whether this field is required.
        - `placeholder` (string, optional).
        - `max_length` (number, optional): server-side cap on accepted value length (clamped to a safe maximum).
    - `actions` (array, optional)
      - Each entry:
        - `key` (string, required, unique per notification).
        - `label` (string, required).
        - `style` (string, optional): `"primary" | "secondary" | "danger"` (UI hint only).
        - `requires_inputs` (string[], optional): list of input `id`s that must be supplied for this action.
    - A notification is considered *interactive* when `callback_url` is provided and at least one of `actions` or `inputs` is a non-empty array.
  - Validation:
    - `title` and `message` are always required.
    - `type` must be one of the allowed values.
    - When interactive fields are present:
      - `callback_url` is required and must use `http` or `https`.
      - `actions`/`inputs`, when provided, must be non-empty arrays of objects with the required fields.
      - `actions[].style`, when present, must be one of `primary|secondary|danger`.
      - `inputs[].type`, when present, must be one of `string|secret`.
      - `inputs[].max_length`, when present, must be a positive number; values are clamped to a safe limit.
      - Every id in `actions[].requires_inputs` must refer to an existing `inputs[].id`.
    - Validation failures return `400` with a structured error payload, for example:
      - `{ "error": "INVALID_INPUTS", "message": "inputs[0].id is required" }`.
  - Persistence:
    - Non-interactive notifications are stored as before, with `is_active: false`.
    - Interactive notifications persist:
      - `actions`, `inputs` definitions.
      - Callback metadata (`callback_url`, `callback_method`, `callback_headers`) for server-side use only.
      - `is_active: true` until the user responds via WebSocket.
  - Response:
    - Non-interactive:
      - When user-scoped: `{ saved }`.
      - When broadcast: `{ recipients: [...], saved: [...] }`.
    - Interactive:
      - Same shapes as above, but `saved` entries also include `actions`, `inputs`, and `response: null`.
      - Callback metadata is omitted from the JSON response.
- POST `/:id/action` — Submit an interactive notification action for the current user
  - Request body:
    - `action_key` (string, required) — key of the chosen action.
    - `inputs` (object, optional) — map of input ids → string values. Values are validated and truncated according to the `inputs[].max_length` and `required`/`requires_inputs` rules configured on the notification.
  - Behavior:
    - Looks up the notification for the authenticated user and id; returns `404`/`notification_not_found` when missing.
    - Verifies that the notification is interactive, has not already recorded a `response`, and that `action_key` exists.
    - Validates required inputs:
      - Global `inputs[].required === true`.
      - Action-specific `actions[].requires_inputs`.
    - Invokes the configured `callback_url` with a JSON payload containing:
      - Notification metadata (`notification_id`, `user`, `action`, `action_label`, `session_id`, `title`, `message`, `timestamp`).
      - `inputs` map including both secret and non-secret values (subject to max length truncation).
    - Persists a `response` summary in `NotificationManager` with:
      - `inputs`: non-secret input values only.
      - `masked_input_ids`: ids of any secret inputs that had values.
      - Marks the notification `is_active: false`.
    - Broadcasts a `notification_action_result` WebSocket message to the current user (all connected tabs) so UIs stay in sync.
  - Response body:
    - `{ ok: boolean, status: string, error?: string, response?: { at, user, action_key, action_label, inputs, masked_input_ids } }`
  - Status / error mapping:
    - `200` — `ok: true`, `status: "callback_succeeded"`.
    - `400` — validation failures (`status` one of: `invalid_payload`, `invalid_action`, `missing_required_inputs`, `not_interactive`).
    - `404` — `status: "notification_not_found"`.
    - `409` — `status: "already_responded"` when a response already exists.
    - `502` — `status: "callback_failed"` when the callback returns a non-2xx HTTP status or network/timeout error (e.g., `error: "HTTP_403"`).
    - `500` — unexpected internal errors (`status: "internal_error"`).
- POST `/:id/cancel` — Cancel an interactive notification without deleting it
  - Auth:
    - Requires authentication.
  - Behavior:
    - Looks up the notification for the authenticated user and id; returns `404` / `notification_not_found` when missing.
    - Requires the notification to be interactive (has interactive metadata and a callback URL); otherwise returns `400` / `not_interactive`.
    - Rejects when the notification already has a recorded `response` with `409` / `already_responded`; the existing response is returned in the payload.
    - When valid and still interactive:
      - Persists a synthetic `response` summary in `NotificationManager` with:
        - `status: "canceled"`.
        - `action_key: null`.
        - `action_label: "Canceled"`.
        - Empty `inputs` and `masked_input_ids`.
      - Marks the notification `is_active: false`.
      - Broadcasts a `notification_updated` WebSocket message to the current user so UIs stay in sync.
  - Response body:
    - On success (`200`):
      - `{ ok: true, status: "canceled", notification: { ...updatedNotification } }` where `notification` is the sanitized notification returned to clients (callback metadata omitted, but includes `response`).
    - On error:
      - `401` — `{ ok: false, status: "unauthorized", error: "AUTH_REQUIRED" }` when not authenticated.
      - `400` — `{ ok: false, status: "not_interactive", error: "NOT_INTERACTIVE" }` when the notification is not interactive.
      - `404` — `{ ok: false, status: "notification_not_found", error: "NOT_FOUND" }` when the id is unknown for this user.
      - `409` — `{ ok: false, status: "already_responded", error: "ALREADY_RESPONDED", response }` when a response already exists.
      - `500` — `{ ok: false, status: "internal_error", error: "INTERNAL_ERROR" }` on unexpected failures.
- PATCH `/mark-all-read` — Mark all as read `{ ok: true, updated }`
- DELETE `/` — Clear all `{ ok: true, deleted }`
- PATCH `/:id` — Mark one as read `{ read: true }`
- DELETE `/:id` — Delete one `{ ok: true }`

## Users

Base: `/api/user`

- GET `/me` — Current user profile `{ username, groups, permissions, features, prompt_for_reset }`
- POST `/reset-password` — Reset current user's password (feature-gated)
  - Auth:
    - Requires authentication and the `password_reset_enabled` feature.
    - Requires HTTP Basic Auth with the current username and password; cookies alone are not sufficient.
  - Body: `{ "new_password": "NewSecret" }`
  - Behavior:
    - Verifies the supplied current password against `users.json` in the backend data directory.
    - Rejects when the new password matches the existing password.
    - Updates the user's `password_hash` in that runtime `users.json` and clears any `prompt_for_reset` flag.
  - Response: `{ ok: true, username, prompt_for_reset: false }`

## WebSocket

- URL: `/ws/:clientId` (mounted under server, proxied at `/terminals-api/ws/` in nginx). The backend also serves a tunnel WS at `/api/sessions/:id/tunnel`.
- Auth: via session cookie or short-lived token from `GET /api/ws-token` (query param `ws_token`)

Messages from client (JSON):
- `attach` — `{ type: 'attach', session_id }`
- `detach` — `{ type: 'detach', session_id }`
- `stdin` — `{ type: 'stdin', session_id, data }`
- `resize` — `{ type: 'resize', session_id, cols, rows }`
- `ping` — `{ type: 'ping', timestamp }`
- `detach_client` — `{ type: 'detach_client', session_id, target_client_id }`
- `history_loaded` — `{ type: 'history_loaded', session_id }`

Messages from server include:
- `auth_success`, `error`
- `attached`, `detached`
- `stdout` — streamed terminal output
- `pong`
- `session_updated` — broadcast updates
- `stdin_injected` — event after HTTP stdin injection
- `notification` — delivered via Notification Manager

## Visibility and Permissions

- Visibility values: `private`, `public`, `shared_readonly`
  - `private`: only owner (or admins) may view/act
  - `shared_readonly`: visible to all; only owner (or admins) may send input/modify
  - `public`: visible to all; most actions allowed

- Permissions are resolved from groups/users; see `backend/constants/access-keys.js` and config files for features/permissions. Examples of permission keys used by APIs:
  - `manage_all_sessions` — admin access
  - `inject_session_input` — required for POST `/input`
  - `broadcast` — required for system POST `/notifications` with `session_id`
  - `sandbox_login` — required for POST `/api/containers/attach`
  - `terminate_containers` — required for POST `/api/containers/terminate-all`

## History Streaming Details

- `GET /api/sessions/:id/history` returns only metadata; content is streamed by:
  - `GET /api/sessions/:id/history/raw` in text mode.
  - `GET /api/sessions/:id/history/html` in HTML mode (terminated sessions only).
- `HEAD /api/sessions/:id/history/raw` provides `Content-Length` when determinable.
- `GET /api/sessions/:id/history/raw` supports `Range` requests and helpers `tail_bytes` and `since_offset`.
- History view configuration (in `config.json` under `session_history`):
  - `session_history.view_mode`: `"text"` (default) or `"html"`.
    - `"text"`: terminated sessions use `/history/raw` streamed into xterm; no HTML is generated.
    - `"html"`: terminated sessions are expected to have pre-rendered HTML; the backend runs the external `pty-to-html` helper on termination.
  - `session_history.keep_raw_log` (boolean, default `true`):
    - When `true`, the `.log` file is preserved alongside `.html` on successful conversion.
    - When `false`, the `.log` file is deleted after successful HTML generation; `/history/raw` for that terminated session returns 404.
  - `session_history.pty_to_html_path` (string): absolute or relative path to the `pty-to-html` helper.
    - Required when `session_history.view_mode: "html"`.
    - When unset or failing (spawn error, non-zero exit, timeout), the backend does **not** fall back to text mode:
      - Metadata records `history_view_mode: "html"` and `has_html_history: false`.
      - `/history/html` returns 404 and the raw `.log` remains on disk for debugging.
- The legacy top-level keys `terminated_history_view_mode`, `history_html_keep_log`, and `pty_to_html_path` are no longer supported; configs must define the `session_history` block instead.

## Notes

- Many APIs broadcast updates over WebSocket (`session_updated`, `workspaces_updated`, `notification`, etc.). These are best-effort and should not be used as the sole source of truth by clients.
- For container service proxying, use the session tunnel WS to publish a reverse tunnel from the container. See runtime/bootstrap details in the backend README.
  
  
  
  
