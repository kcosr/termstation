# termstation

A web-based terminal session manager built with Node.js/Express (backend) and vanilla JavaScript with xterm.js (frontend). This application provides a clean interface for managing multiple terminal sessions through a web browser.

## Features

### Core Functionality
- **Multiple Terminal Sessions**: Create and manage multiple terminal sessions simultaneously
- **Session Persistence**: Sessions remain active even when disconnecting/reconnecting
- **Session History**: View complete terminal history for terminated sessions with ANSI colors
- **Cross-Restart Persistence**: Session metadata and history survive server restarts
- **Real-time I/O**: Live terminal input/output via WebSocket
- **Multi-Client Support**: Multiple browsers can connect to the same session simultaneously

### User Interface
- **Dynamic Terminal Sizing**: Automatically calculates optimal terminal dimensions based on browser window
- **Session Filtering**: Active/Inactive tabs for easy session organization
- **Interactive History**: Terminated sessions display as read-only terminals with full ANSI color support
- **Smart Controls**: Terminate/Clear buttons only visible for active sessions
- **Confirmation Modals**: Safe session termination with styled confirmation dialogs
- **Modern UI**: Responsive dark theme interface with intuitive navigation

### Technical Features
- **Event-Driven Architecture**: Modular frontend with EventBus for loose coupling
- **Automatic Deployment Detection**: Seamlessly works in development and nginx production environments
- **Broadcasting System**: WebSocket message broadcasting for real-time collaboration
- **Error Recovery**: Comprehensive fallbacks and error handling throughout the stack

## Architecture

### Backend (Node.js/Express)
- **REST API**: Session CRUD operations and management endpoints
- **WebSocket Gateway**: Real-time terminal I/O with multi-client broadcasting using ws
- **PTY Integration**: node-pty for terminal emulation and persistence
- **Session Persistence**: JSON metadata + raw script logs for cross-restart survival
- **Event-Driven I/O**: Event-based process monitoring with broadcasting pattern
- **Template System**: Command templates with dynamic parameter population
  - Supports select parameters with dynamic options via shell commands or scripts
  - Commands receive template parameters and config-provided vars as env (both lower/upper case)
- Placeholders like `{repo}` or `{SCRIPTS_DIR}` are interpolated before execution

#### Isolation Workspace Bootstrap

- On session creation for isolation `container` or `directory`, the backend materializes a per-session workspace at `logs/<sessionId>/workspace` containing:
  - `.bootstrap/scripts/run.sh`, `.bootstrap/scripts/main.sh`, optional `.bootstrap/scripts/pre.sh` and `.bootstrap/scripts/post.sh`
  - `write_files` applied workspace‑relative (files and directories)
- Optional `ts-tunnel.js` helper for service proxying
  - Sourced automatically into the workspace at `.bootstrap/bin/ts-tunnel.js` (from backend/bootstrap/bin)
  - `run.sh` starts the helper with Node when a session token is available; missing helper is non‑fatal
- Container mode mounts the workspace read‑write at `/workspace` and executes `/workspace/.bootstrap/scripts/run.sh` (no `/tmp` copy).
- Directory mode runs the same orchestrator from the host workspace path and sets `cwd` to the workspace.
- `run.sh`:
  - Exports env vars (including `SESSION_ID`, `SESSIONS_API_BASE_URL`, `SESSION_TOK`)
  - Runs `pre.sh`, `main.sh`, `post.sh` in order
  - Optionally starts the reverse‑tunnel helper when `forward_services` is true
- No network fetch or archive extraction is used.

##### Write Files Path Rules ($HOME only)

- Supported prefix: only `$HOME/` at the start of the path.
  - Targets (directory mode): leading `$HOME/` is stripped so paths are workspace‑relative. `${HOME}` and `~` are not supported.
  - Targets (container mode): `$HOME` expands inside the generated run script; other `$VAR` are escaped to avoid unintended expansion.
  - Sources: leading `$HOME/` expands to the host HOME. `${HOME}` and `~` are not supported.
  - Absolute paths are honored as‑is where applicable.
  - Bare `$HOME` (no trailing slash) is recognized in all cases where `$HOME/` is supported.
  - Example: `$HOME/.config/app/config.json`.

##### Working Directory Rules ($HOME only)

- Host sessions: only `$HOME` or `$HOME/...` expand to the user home. `~` and `${HOME}` are not supported.
- Container sessions: use absolute `container_working_dir` (e.g., `/workspace`); `$HOME`/`~` are not expanded there.

#### Template Variables and Scripts

- Define per-environment template variables in `backend/config/*.json` under `template_vars`.
  - `SCRIPTS_DIR` is provided as a built-in macro pointing at the shared backend scripts directory (e.g., `<install-dir>/backend/scripts`). You can override it by setting `SCRIPTS_DIR` in `template_vars` if needed.
  - Example (test override):
    - `"template_vars": { "SCRIPTS_DIR": "/srv/termstation-test/backend/scripts", "branch_cache_dir": "/srv/sandbox/.cache/repos" }`
- Use variables in templates:
  - Paths: `"command": "{SCRIPTS_DIR}/list-branches.sh --limit 25"`
  - Scripts receive variables as env: `$SCRIPTS_DIR`, `$branch_cache_dir`, `$BRANCH_CACHE_DIR`
- Dynamic option dependencies:
  - Add `"depends_on": ["repo"]` so the frontend reloads only when a dependency changes.
- Reserved keys:
  - Template parameter names must not collide with keys in `template_vars`.
  - Session creation requests cannot override reserved keys; the API returns 400 with `reserved_keys`.

#### Macros, Unresolved Values, and Types

- Placeholder syntax uses `{var}`. Unknown variables resolve to an empty string.
- Unresolved semantics (used by link skipping and conditionals):
  - Considered unresolved: `undefined`, `null`, empty string `""`, and whitespace-only strings (e.g., `"   "`).
  - Numbers are allowed; `0` is treated as a valid value and renders as `"0"`.
  - Booleans, arrays, and objects are treated as unresolved for substitution to avoid output like `"false"` or `"[object Object]"`.
  - `NaN` is treated as unresolved.
- Link behavior with `skip_if_unresolved: true`:
  - The backend scans both `url` and `name` for placeholders. If any referenced variable is unresolved, the link is omitted.
  - Links without placeholders are never skipped, even if `skip_if_unresolved` is `true`.
- Substitution trimming:
  - Whitespace-only values collapse to empty during macro substitution. Example: `"ID={issue_id}"` with `issue_id: "   "` renders as `"ID="`.

#### Shared Scripts

- Scripts live under `backend/scripts`. Example: `list-branches.sh`
  - Maintains a cached clone under `branch_cache_dir` (configurable)
  - Lists branches sorted by last commit date (`git for-each-ref`)
  - Supports `--limit N` (default 25)
  - Reads `repo` from env (`$repo`/`$REPO`)

### Frontend (JavaScript/xterm.js)
- **Modular Architecture**: Component-based design with clear separation of concerns
- **Environment Detection**: Automatic configuration for development vs nginx deployment
- **Event-Driven Communication**: EventBus pattern for loose coupling between modules
- **Terminal Rendering**: xterm.js for both live sessions and historical playback
- **State Management**: Session lifecycle tracking with UI state synchronization

### Key Design Decisions
#### Authentication
See doc/authentication.md for the full authentication strategy, including API cookie auth, WebSocket auth flows (in‑band and token), the login modal UX, and security considerations.

#### Session Persistence Strategy
- Uses Unix `script` command for reliable terminal recording
- Separates metadata (JSON) from raw output (log files) for efficient querying
- Session history survives server restarts and can be viewed with full ANSI rendering

#### Multi-Client Broadcasting
- Single master reader per session prevents file descriptor conflicts
- WebSocket message broadcasting enables real-time collaboration
- Client connections are stateless - clients can attach/detach freely

#### Production vs Development Configuration
- Frontend auto-detects deployment environment (nginx prefix vs direct access)
- Unified codebase works seamlessly in both development and production

### Versioning
- **Single source of truth**: The `VERSION` file contains the semantic version (e.g., `1.0.0`).
- **Build number**: Computed automatically from `git rev-list --count HEAD` at build time.
- **Generated files**: `scripts/gen-build-info.mjs` generates `shared/build-info.generated.{mjs,cjs}` with version, build, and commit info.
- **API**: `/api/info` returns `{ version, build, commit, ... }`.
- **Frontend**: Shows `v1.0.0` with a tooltip displaying build number and commit.
- **How to bump**: Use `node scripts/bump-version.js patch|minor|major` for releases, then run a desktop build or `node scripts/gen-build-info.mjs`.
- See `VERSIONING.md` for full documentation including release workflow and app store policies.
- nginx proxy handles static file serving and API routing separation

## Installation

### Prerequisites
- Node.js 16+
- npm or yarn package manager
- Modern web browser with WebSocket support

### Backend Setup

1. Navigate to the backend directory:
```bash
cd backend
```

2. Install Node.js dependencies:
```bash
npm install
```

3. Run the backend server:
```bash
npm start
```

Available npm scripts:
```bash
# Start with default configuration
npm start

# Start with development config
npm run start:dev

# Start with test config  
npm run start:test

# Start with production config
npm run start:prod

# Start with auto-reload for development
npm run dev
```

The API server will start on the port specified in the configuration (default: 6624)

### Frontend Setup

The frontend must be served through a web server (not opened directly as a file) due to ES6 module CORS restrictions.

**Quick Start (root)**

From the repository root you can now start both backend and frontend together:

```bash
npm run start:dev   # or start:test / start:prod
```

You can still start them independently from their directories (see below).

**Recommended: Start both services**

```bash
# Start backend (in one terminal)
cd backend
npm start

# Start frontend (in another terminal)
cd frontend
# Serve using any static file server, for example:
npx serve -p 9000
```

**Alternative: Manual setup (not recommended)**

If you need to serve the frontend manually, you can use any web server, but you'll need to handle configuration manually:

1. Navigate to the frontend directory:
```bash
cd frontend
```

2. Serve the static files using any web server (example using `serve`):
```bash
npx serve -p 9000
```

3. Open your browser and navigate to the appropriate URL (e.g., `http://localhost:9000`)

**Important**: 
- Do NOT open `index.html` directly in the browser - this will cause CORS errors with ES6 modules
- Manual setup requires you to manually configure the backend API endpoints in the frontend configuration
- The start scripts automatically handle configuration and are the recommended approach

## Production Deployment

### nginx Configuration

For production deployment, the application is designed to run behind nginx with URL prefix routing:

- **Frontend**: Served at `/terminals/` (static files)
- **API**: Proxied to `/terminals-api/` (backend endpoints)
- **WebSocket**: Proxied to `/terminals-api/ws/` (real-time communication)

#### nginx Configuration Example

```nginx
# Terminal Manager Frontend (Static Files)
location = /terminals {
    return 301 /terminals/;
}

location /terminals/ {
    alias /path/to/terminal-manager/frontend/;
    try_files $uri $uri/ /terminals/index.html;
    index index.html;
}

# Terminal Manager API (Backend Proxy)
location = /terminals-api {
    return 301 /terminals-api/;
}

location /terminals-api/ {
    rewrite ^/terminals-api(/.*)$ $1 break;
    proxy_pass http://localhost:6624/;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_redirect off;
}

# Terminal Manager WebSocket (Real-time Communication)
location /terminals-api/ws/ {
    rewrite ^/terminals-api(/ws/.*)$ $1 break;
    proxy_pass http://localhost:6624;
    proxy_http_version 1.1;
    
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Required for WebSocket support
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    
    # WebSocket specific settings
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_connect_timeout 60s;
    
    proxy_buffering off;
    proxy_redirect off;
}
```

#### Production Checklist

1. **Backend**: Run backend on port 6624 (or configure port in server.js)
2. **nginx**: Configure location blocks for `/terminals/` and `/terminals-api/`
3. **SSL**: Use HTTPS/WSS for production (update WebSocket protocol)
4. **Authentication**: Implement user authentication and session isolation
5. **Resource Limits**: Configure appropriate resource limits and timeouts
6. **Monitoring**: Set up logging and monitoring for session management
7. **Process Manager**: Use PM2 or similar for Node.js process management

#### Environment Detection

The frontend automatically detects the deployment environment:

- **Development Mode**: Direct connection to `localhost:6624`
- **Production Mode**: Uses `/terminals-api` prefix when served from `/terminals/`

This allows the same codebase to work seamlessly in both environments without configuration changes.

#### Verbose Logging

- Console debug logs are suppressed by default. Set `localStorage.tm_verbose_logs = '1'` or append `?verboseLogs=1` to the URL when loading the app to re-enable them during troubleshooting.
- Administrators can also inject `window.TERMINAL_MANAGER_DEBUG_FLAGS = { verboseLogs: true }` before the app boots to opt in.

## Usage

### Creating a New Terminal Session

1. Click the "+ New" button in the sidebar
2. Configure the session:
   - **Command**: The shell or command to run (default: `/bin/bash`)
   - **Working Directory**: Starting directory for the terminal (supports `~` expansion)
3. Click "Create" to start the session

**Note**: Terminal dimensions are automatically calculated based on the browser window size.

### Managing Sessions

#### Session States and Filtering
- **Active Tab**: Shows running terminal sessions that can be interacted with
- **Inactive Tab**: Shows terminated sessions that can be viewed as read-only history

#### Session Operations
- **Attach to Session**: Click on any active session in the sidebar to connect
- **View History**: Click on any inactive session to view complete terminal history with ANSI colors
- **Clear Terminal**: Clear the current terminal display (active sessions only)
- **Terminate Session**: End a running session with confirmation dialog (active sessions only)

#### Multi-Client Support
Multiple browser windows can connect to the same active session simultaneously, enabling real-time collaboration.

#### Session Persistence
- **Active Sessions**: Survive browser disconnections and can be reconnected
- **Session History**: All terminal output is preserved and viewable after session termination
- **Cross-Restart**: Session data persists across backend server restarts

### Keyboard Shortcuts

All standard terminal keyboard shortcuts work as expected:
- `Ctrl+C`: Interrupt current process
- `Ctrl+D`: End of input (usually exits shell)
- `Ctrl+L`: Clear screen
- Tab completion, history navigation, etc.

#### Links Menu
- Open global links menu: `Cmd+Shift+L` (mac) or `Alt+Shift+L` (others)
- In the links search input:
  - `ArrowDown`: Move focus to the first visible result
  - `Enter` (single result): Open the single visible result
  - `Enter` (multiple results, group matching enabled): Toggle between including group-name matches and direct-only matches. Any subsequent edit to the search resets to your preference mode. Press `Enter` again when there is a single result to open it
  - `Esc` with text: Clear the search and keep focus in the input (does not close)
- `Esc` with empty input: Close the links menu

Note: The session toolbar links dropdown is disabled by default. Enable it in Settings → Links → "Show session links menu". The global header links menu remains available regardless of this setting.

#### Quick Template Search
- Open quick search overlay: `Cmd+Shift+M` (mac) or `Alt+Shift+M` (others)
- Type to filter templates by name, group, description, or shortcut token
- `ArrowDown`: Focus the first result (also shows the list when the query is empty)
- `Enter`: Open the New Session modal with the selected template
- `Shift+Enter`: Create a session immediately with the selected template (skips modal). If required parameters are missing and have no defaults, the server returns a clear validation error

#### Deferred and Stop Inputs
- Open/close deferred + stop inputs dropdown: `Cmd+Shift+S` (mac) or `Alt+Shift+S` (others)
- Toggle stop inputs enabled for the active session: `Cmd+S` (mac) or `Alt+S` (others)

#### Sidebar
- Toggle sidebar visibility: `Cmd+Shift+/` (mac) or `Alt+Shift+/` (others)

## API Documentation

### REST Endpoints

#### Create Session
```
POST /api/sessions
Body: {
  "command": "/bin/bash",
  "working_directory": "/home/user",
  "cols": 80,
  "rows": 24
}
```

#### List Sessions
```
GET /api/sessions
```

#### List Sessions with History
```
GET /api/sessions/history/all
```
Returns both active and terminated sessions with metadata.

#### Get Session Details
```
GET /api/sessions/{session_id}
```

#### Get Session History
```
GET /api/sessions/{session_id}/history
```
Returns session metadata and complete terminal output for terminated sessions.

#### Terminate Session
```
DELETE /api/sessions/{session_id}
```

#### Resize Session
```
POST /api/sessions/{session_id}/resize
Body: {
  "cols": 100,
  "rows": 30
}
```

### WebSocket Protocol

**Development**: `ws://localhost:6624/ws/{client_id}`
**Production**: `ws://your-domain.com/terminals-api/ws/{client_id}`

The frontend automatically constructs the correct WebSocket URL based on the deployment environment.

#### Client to Server Messages

```javascript
// Attach to session
{
  "action": "attach",
  "session_id": "uuid"
}

// Send input
{
  "action": "stdin",
  "session_id": "uuid",
  "data": "ls -la\n"
}

// Resize terminal
{
  "action": "resize",
  "session_id": "uuid",
  "cols": 100,
  "rows": 30
}

// Detach from session
{
  "action": "detach",
  "session_id": "uuid"
}
```

#### Server to Client Messages

```javascript
// Terminal output
{
  "type": "stdout",
  "session_id": "uuid",
  "data": "output text..."
}

// Session terminated
{
  "type": "session_terminated",
  "session_id": "uuid"
}

// Error message
{
  "type": "error",
  "message": "error description"
}
```

## Configuration

The application uses configuration files for customizing behavior and environment-specific settings.

### Configuration Architecture

The configuration system consists of:
- **Backend Configuration**: Environment variables and config files control backend behavior
- **Frontend JavaScript Configuration Files**: Located in `frontend/` directory for each environment  
- **Template Configuration**: JSON files defining command templates with parameters

### Backend Configuration

The Node.js backend can be configured through:
- Environment variables (e.g., `TERMINAL_MANAGER_CONFIG`)
- Command-line arguments
- Default settings in the code

### Template Configuration

Templates are defined in `backend/config/templates.json`. Each template can specify:
- **id**: Unique template identifier
- **name**: Display name for the template
- **command**: Command to execute
- **parameters**: Array of parameter definitions
  - Parameters can have static options or dynamic options populated via command execution
  - Dynamic options are fetched when a parameter has a `command` property

Additional optional fields supported by the backend template system:
- **sandbox**: Run the command inside a container (podman)
- **container_image**, **container_working_dir**, **container_memory**, **container_cpus**, **container_network**: Container options
- **env_vars**: Map of environment variables to inject (supports `{var}` placeholders)
- **pre_commands**, **post_commands**: Arrays of shell commands to run before/after the main command (run inline, chained with `&&`)
 - **scheduled_input_rules**: Array of scheduled input rules to create when sessions are started from this template. Each rule supports:
   - `type`: `"offset"` or `"interval"`
   - `data`: string to send (supports template variable interpolation like `{session_id}`, `{var}`)
   - `offset_ms` (for `offset`) or `interval_ms` (for `interval`); `offset_s`/`interval_s` aliases also supported
   - `stop_after` (interval only): number of sends before stopping
   - Option flags either flat or nested under `options`: `submit`, `enter_style`, `raw`, `activity_policy`, `simulate_typing`, `typing_delay_ms`, `notify`

Example with scheduled inputs:
```json
{
  "id": "demo",
  "name": "Demo",
  "scheduled_input_rules": [
    { "type": "offset", "offset_ms": 2000, "data": "echo 'Session {session_id} ready'\n", "submit": true, "notify": true },
    { "type": "interval", "interval_s": 60, "data": "date\n", "options": { "submit": true, "notify": false, "activity_policy": "defer" }, "stop_after": 10 }
  ]
}
```

Example template with dynamic options:
```json
{
  "id": "deploy-sm",
  "name": "Deploy Session Manager",
  "parameters": [
    {
      "name": "branch",
      "label": "Branch",
      "type": "select",
      "command": "git for-each-ref --format='%(refname:short)' refs/heads",
      "description": "Select branch to deploy"
    }
  ]
}
```

### Configuration Settings Reference

#### Backend Settings

The Node.js backend supports the following configuration options:

**Server Settings:**
- Default port: 6624
- WebSocket support enabled
- CORS configured for development

**Session Management:**
- Supports multiple concurrent terminal sessions
- Session persistence across restarts
- Automatic cleanup of terminated sessions

**Template System:**
- Templates defined in `backend/config/templates.json`
- Dynamic parameter population via command execution
- Support for multiple parameter types (string, select, boolean)

## IPC Throughput and Limits

To keep the application responsive under heavy load, the backend applies conservative backpressure and rate limiting:

- Stdout batching: flushes up to 64KB per event loop tick, deferring the rest to subsequent ticks. This prevents a single chatty PTY from starving the event loop and UI updates.
- Backlog ceiling: per-session stdout backlog is capped at ~1MB. When exceeded, oldest buffered output is dropped (log warning) until under the cap.
- Operation rate limits (coarse, fixed window):
  - Per-session: ~100 ops/sec for stdin, resize, and terminate.
  - Per-user create: ~10 session creates/sec.
  - Global: ~300 ops/sec across all operations.
  - Implemented via shared singletons to ensure consistent limits across WS and HTTP.

These limits are enforced server-side for WebSocket and HTTP endpoints. They are intentionally conservative and primarily guard against accidental floods. Tune values in code if your deployment profile warrants higher throughput.

### Dev Verification (Smoke Checks)

- Spawn a session, then stream ~1MB burst to stdout (e.g., `yes x | head -c 1048576`). UI should stay responsive and data arrives in multiple batches.
- Spam stdin and resize via WebSocket or API; after limits are hit, server responds with clear errors (HTTP 429 for API; `error` messages over WS).
- After terminating a session, attempts to send stdin/resize should fail quickly with appropriate errors.
 - If stdout backlog trimming occurs (1MB cap), clients receive a `stdout_dropped` message containing `dropped_bytes`.


#### Frontend Configuration

The frontend configuration system:
- Uses JavaScript configuration files for different environments
- Automatically detects deployment environment (development vs production)
- Configures API endpoints and WebSocket connections dynamically

## Extending the Application

The application is designed with modularity in mind:

### Adding New Pages/Features

1. Create a new module in `frontend/js/modules/`
2. Register it in `app.js`
3. Add navigation button in `index.html`
4. Implement the module interface with `init()` and `onPageActive()` methods

### Backend Extensions

The backend can be extended with additional endpoints or WebSocket message handlers. The terminal session manager is decoupled from the API layer for easy modification.

## Security Considerations

⚠️ **This is a development version without authentication!**

For production use, implement:
- User authentication and authorization
- Session isolation per user
- Rate limiting
- Input sanitization
- HTTPS/WSS encryption
- CORS configuration
- Resource limits (CPU, memory, disk)

## Troubleshooting

### WebSocket Connection Failed
- Ensure the backend is running on the correct port
- Check browser console for CORS errors
    - Verify firewall settings

#### Display Settings
- `showActivityIndicator` (default: true) — Shows a small activity dot in the session list when output activity changes.
- `showContainerShellsInSidebar` (default: false) — When disabled, hides child container shells (Shell 1, Shell 2, …) under parent sessions in the sidebar. Container tabs continue to appear and function normally.

### Terminal Not Displaying Correctly
- Ensure xterm.js is loaded properly
- Check browser compatibility
- Try resizing the terminal with the "Fit" button

### Sessions Not Persisting
- Check backend logs for errors
- Verify PTY support on your system
- Ensure proper file permissions for `script_logs` directory
- Confirm `script` command is available on the system

### nginx/Production Deployment Issues
- Verify nginx location blocks are configured correctly for `/terminals/` and `/terminals-api/`
- Check nginx error logs for 502 Bad Gateway errors (backend not running)
- Ensure WebSocket upgrade headers are configured for `/terminals-api/ws/`
- Confirm backend is running on the expected port (default: 8999)
- Test API endpoints directly: `curl http://localhost:8999/api/sessions`

### Session History Not Loading
- Check that terminated sessions have corresponding `.json` and `.log` files in `script_logs/`
- Verify backend has read permissions for the script logs directory
- Ensure session history API endpoint returns valid data: `/api/sessions/{id}/history`

### Active/Inactive Session Filtering Issues
- Sessions may appear in wrong tab if backend session state is inconsistent
- Refresh the page to reload session states from the backend
- Check browser console for API errors when loading session list

## License

This project is provided as a reference implementation for educational purposes.

## Contributing

Feel free to submit issues and enhancement requests!
### Desktop State Persistence (Electron)

When running the Electron desktop app, a lightweight state store persists UI state to `state.json` under the app's userData directory. The following keys are relevant to local terminal sessions:

- `local_session_workspaces` — Map of local session ID → workspace name. Used to restore each local PTY session into the correct workspace across reloads.
- `workspace_session_selections` — Map of workspace name → last selected session ID. Used to restore selection when switching workspaces or after reload.
- `terminal_manual_order` — Per‑workspace arrays of session IDs capturing the sidebar manual order (respected by tabs as `visibleOrder`).

These entries are written via the frontend state‑store batcher and read during startup to rehydrate the UI without contacting the server for local‑only sessions.

### Developer: Rebuild helper bundles (agents.js and ts-tunnel.js)

Prerequisites:
- Bun installed and available on PATH
- Backend dependencies installed (commander is declared in backend/package.json)

Commands (from repo root):


Notes:
- These bundles run under Node inside the session; no npm install is needed in the session.
- The backend copies `backend/bootstrap/bin/*` into each session’s `.bootstrap/bin/`.
