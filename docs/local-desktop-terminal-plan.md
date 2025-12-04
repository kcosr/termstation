# Local Desktop Terminal Support — Design Plan (Draft)

Author: Codex
Status: Draft updated with Claude review
Scope: Add support for local PTY-backed terminals in the Electron desktop app, rendered via xterm.js, independent of backend sessions

## Goals

- Launch local OS PTY from the Electron main process (desktop) and stream I/O to the renderer’s existing xterm.js views.
- Keep local sessions completely unknown to the backend API/WebSocket services.
- Ensure robust cleanup: terminate local PTYs on app shutdown and when their renderer view is closed.
- Clearly indicate in UI (header + sidebar) when a session is “local only”.
- Maximize reuse of existing terminal/session frontend code (xterm integration, view controller, shortcuts) with minimal divergence.
- Cross-platform shell selection and PTY attach (Windows, macOS, Linux).

## Non‑Goals (initial phase)

- No persistence/history for local sessions between app runs (ephemeral only to start).
- No backend awareness or synchronization of local sessions.
- No merging of local and remote session history in server storage.

## Architecture Overview

- Main process (Electron): Local PTY session manager creates and owns `node-pty` processes; exposes IPC handlers for lifecycle and I/O.
- Preload bridge: Safe, narrow, context-isolated API surface for the renderer to call into main and subscribe to PTY events.
- Renderer: A “LocalPTYClient” transport implementing the same message surface that `TerminalSession` expects (stdin, resize, attach, detach, terminate, output events). TerminalManager instantiates TerminalSession with this transport instead of the WebSocket one when creating local sessions.

### Key Idea: Transport Interface

Define and formalize a minimal transport contract used by `TerminalSession` so it can work with either the existing WebSocket service (remote sessions) or the new local PTY transport:

```
/**
 * @typedef {'stdin'|'resize'|'terminate'|'attach'|'history_loaded'} TerminalSendType
 * @typedef {{ send: (type: TerminalSendType, payload: any) => Promise<void>, on: (event: string, handler: Function) => void, off: (event: string, handler: Function) => void }} ITerminalTransport
 */
```

- `send(type, payload)` for: `stdin`, `resize`, `terminate`, `attach`, `history_loaded` (attach flow emulation).
- Event stream mapping to TerminalSession’s event bus events:
  - `ws-attached` (with `history_marker: 'LOCAL_SESSION_NO_HISTORY'` for local)
  - `ws-output` (pty data)
  - `ws-terminated`
  - `ws-error` (for PTY spawn/runtime failures)
  - Optionally: `ws-session_updated` (for dynamic title updates, if we mirror backend behavior).

This keeps `TerminalSession` unchanged; only the transport injection differs.

## IPC/API Design (Main ↔ Renderer)

- Channels (invoke):
  - `desktop:localpty-create` → { sessionId?, command?, cwd?, cols, rows, env?, interactive? } → { ok, sessionId, pid }
  - `desktop:localpty-stdin` → { sessionId, data } → { ok }
  - `desktop:localpty-resize` → { sessionId, cols, rows } → { ok }
  - `desktop:localpty-terminate` → { sessionId } → { ok }
  - `desktop:localpty-list` (optional debug) → { sessions: [...] }

- Channels (events via `webContents.send`):
  - `desktop:localpty-data` → { sessionId, data }
  - `desktop:localpty-exit` → { sessionId, code, signal }
  - `desktop:localpty-error` → { sessionId, error }
  - `desktop:localpty-updated` (optional for dynamic title) → { sessionId, dynamic_title }

Notes:
- Data is UTF-8 strings; no binary transport required initially.
- Backpressure: rely on xterm.js handling and short event queue; add throttling if needed.

## Main Process: Local PTY Session Manager

Responsibilities:
- Track in-memory map: sessionId → { pty, ownerWebContentsId, meta, createdAt }.
- Spawn PTY using `node-pty` with OS-specific shell resolution (see below).
- Stream `onData` to renderer via `desktop:localpty-data`.
- Handle `onExit` and fire `desktop:localpty-exit`, mark inactive, clean up references.
- Kill all active PTYs on app shutdown (`before-quit`), on main window close, and on uncaught-exception (best-effort).

Backpressure & throttling:
- Batch output per session (flush every ~16ms or when ≥4KB).
- If IPC backlog exceeds a threshold, coarsen batching to prevent UI jank.

Session ID & ownership:
- Generate `sessionId` via `crypto.randomUUID()` if not provided.
- Record `ownerWebContentsId` and reject control from other renderers.

Validation & env:
- Resolve and verify `cwd` (absolute + `fs.existsSync()`), fallback to HOME.
- Limit env types/sizes; set `TERM=xterm-256color` and `COLORTERM=truecolor`.

Graceful shutdown:
- On `before-quit`: SIGTERM, wait ~2000ms, then SIGKILL remaining (Unix). On Windows rely on `pty.kill()`.

Session lifecycle:
1. Renderer invokes `desktop:localpty-create` with desired `cols/rows`, `cwd`, `command` optional.
2. Main spawns PTY, returns `{ ok, sessionId, pid }`.
3. Renderer injects a `LocalPTYClient` into `TerminalSession` and immediately emits a synthetic `ws-attached` to reuse history/sync logic (with marker = `LOCAL_SESSION_NO_HISTORY` and `load_history=false`), then listens for data/exit/error events to forward to the event bus as `ws-output` / `ws-terminated` / `ws-error`.
4. Resize and stdin are routed via invoke to main.
5. Terminate → kill PTY, fire exit event.

## Preload Bridge

Expose a `window.desktop.localpty` object with:
- Methods returning Promises (wrapping `ipcRenderer.invoke`): `create`, `stdin`, `resize`, `terminate`, `list`.
- Event subscription helpers: `onData`, `onExit`, `onUpdated` that attach/remove IPC listeners safely.

Security:
- Context isolation remains enabled; no direct `node-pty` access in renderer.
- Validate payloads in main; ignore malformed sessionIds and sanitize `cwd`.
- Rate limit key invokes per session (~100 calls/sec) to prevent abuse.

## Renderer Integration

Add a `LocalPTYClient` with the same `send(type, payload)` signature the `TerminalSession` uses with WebSocketService:

- Map `send('stdin', { session_id, data })` → `window.desktop.localpty.stdin({ sessionId, data })`.
- Map `send('resize', { session_id, cols, rows })` → `window.desktop.localpty.resize({ sessionId, cols, rows })`.
- Map `send('terminate', { session_id })` → `window.desktop.localpty.terminate({ sessionId })`.
- Map `send('attach', { session_id })` to an immediate synthetic event:
  - Emit `ws-attached` with `{ session_id, history_marker: 'LOCAL_SESSION_NO_HISTORY' }`.
  - Set `sessionData.load_history=false` to skip history fetch.
- Map main events to TerminalSession’s event bus:
  - `desktop:localpty-data` → emit `ws-output`.
  - `desktop:localpty-exit` → emit `ws-terminated`.
  - `desktop:localpty-error` → emit `ws-error`.

This way, `TerminalSession` and `TerminalViewController` remain unchanged.

## UI/UX Changes

- Sidebar/session list: add a “laptop” icon or `LOCAL` badge; subtle background tint for local entries.
- Session header: show `LOCAL` pill and omit backend-only actions (links to history API, etc.).
- Creation: add “New Local Terminal” entry to New Session modal and toolbar. Defaults:
  - `command`: resolved default shell per OS.
  - `cwd`: user home.
  - `interactive`: true; `load_history`: false; `save_session_history`: false (local ephemeral).
- Termination behavior:
  - Local sessions auto-terminate on app exit.
  - Dedicated window for local session closes → terminate that PTY (configurable later).
- Keyboard shortcut: Cmd/Ctrl+Shift+N to open a new local terminal.
- Confirmation dialog when closing a tab/window with an active local session (with “Don’t ask again”).

## OS Detection and Shell Resolution

- Common env: `TERM=xterm-256color`, `COLUMNS`, `LINES` on spawn; pass-through `process.env`.
- macOS/Linux:
  - Shell: `process.env.SHELL || '/bin/bash'`.
  - Interactive: prefer `-l` (login); add `-i` if necessary per shell.
  - Command execution: `-lc <command>` (login + command).
  - CWD: `process.env.HOME` if not specified.
- Windows:
  - Detection order: `pwsh.exe` → `powershell.exe` → `cmd.exe`.
  - Interactive: use `-NoLogo -NoExit` for PowerShell; `cmd.exe /K`.
  - Command execution: PowerShell `-Command <cmd>`; `cmd.exe /c <cmd>`.

Extract now (Phase 1) shared helpers:
- `shared/terminal/shell-resolver.js` for shell resolution and command wrapping (migrated from backend logic).
- `shared/terminal/osc-parser.js` for OSC 0/2 dynamic title parsing.

## Reuse vs. Modularization

Short term (MVP):
- Implement a small main-process PTY manager using patterns from `backend/models/terminal-session.js`.
- Keep it self-contained under `desktop/` and avoid shared packaging complexity initially.

Follow‑up (shared module):
- Extract shell/command parsing and dynamic title parsing into `shared/terminal/`.
- Export a platform-neutral `spawnPty({ command, cwd, cols, rows, env })` helper and a `LocalTerminalSession` class usable by both backend and desktop.

## Cleanup and Lifecycle

- On `app.before-quit` and `window-all-closed`: iterate active PTYs and call `kill()`; wait briefly for exit.
- On renderer crash/disconnect: keep PTY alive up to ~30s to allow hot reload; terminate afterward if no owner reattaches.
- On dedicated local session window close (MVP): terminate associated PTY (with confirmation if enabled).
- Unix follow-up: consider process-group termination to clean child trees.

## Packaging and Build

- Add `node-pty` to `desktop/package.json` and document running `electron-rebuild` as needed (already covered in BUILD.md with electron-rebuild notes).
- No server deps required for local mode.
- Keep contextIsolation true; expose only narrow preload API.
 - Hide behind feature flag `ENABLE_LOCAL_TERMINALS=1` for gradual rollout.

## Testing Plan

- Manual:
  - macOS/Linux: open local terminal, run `env`, resize window, paste, Unicode, history scroll.
  - Windows: default to PowerShell; verify `dir`, `cls`, resize, code page behavior.
  - App exit → verify all local PTYs are terminated.
  - Dedicated window open/close behavior for a local session.
- Automated (unit-ish):
  - Main PTY manager: create/resize/terminate flows, invalid IDs rejected.
  - Preload bridge: basic invoke route tests (if test harness available).
  - Platform-specific tests (PowerShell/cmd on Windows; zsh/bash on Unix).
  - Unicode/emoji I/O and resize behavior.

## Risks / Considerations

- `node-pty` native bindings across platforms; ensure CI/build steps include `electron-rebuild`.
- Performance: IPC throughput; may need chunking/throttling for very high output.
- Security: limit allowed `cwd` to existing paths; sanitize inputs; keep APIs private to the app.
- UX: Avoid confusing backend sessions with locals; distinct visuals and actions.
 - Env hygiene: explicitly curate env; consider unsetting `ELECTRON_*` vars.

## Incremental Delivery (Revised)

Phase 1: Core Infrastructure
- Extract `shared/terminal/shell-resolver.js` and `shared/terminal/osc-parser.js` from backend patterns.
- IPC + PTY manager + preload bridge, behind `ENABLE_LOCAL_TERMINALS`.
- LocalPTYClient with the transport interface.
- Hidden developer toggle to spawn one local terminal.

Phase 2: MVP Release
- “New Local Terminal” UI + keyboard shortcut.
- Badges/indicators; confirmations on termination.
- Terminate-on-exit hooks.
- Basic automated tests across platforms.

Phase 3: Polish
- Dedicated window handling refinements (detach vs terminate option).
- Session filtering [All | Remote | Local].
- Optional history persistence with explicit opt-in.
- Performance tuning and flow control improvements.

## Open Questions and Decisions (Consensus)

- Transport injection: at `TerminalSession` (composition); TerminalManager remains agnostic.
- List placement: mixed with badge for MVP; add filter later.
- Windows default: PowerShell (pwsh → powershell → cmd).
- Dedicated window close: terminate (MVP), consider “move to main window” later.
- Local history persistence: not in MVP; revisit based on demand.

---
Draft updated incorporating Claude’s feedback; ready for implementation kickoff (Phase 1) upon approval.
