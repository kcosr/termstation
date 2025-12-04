# termstation Backend - Node.js Implementation

This is a Node.js backend using `node-pty` for terminal session management.

## Features

- **PTY Management**: Uses `node-pty` library for cross-platform terminal session management
- **WebSocket Support**: Real-time communication with frontend clients
- **REST API**: Compatible with existing frontend API expectations
- **Session Management**: Create, attach, detach, resize, and terminate terminal sessions
- **Multi-client Support**: Multiple clients can attach to the same session
- **Session History**: Configurable session history preservation
- **Link Management**: Support for session-associated links
- **Template Support**: Template-based session creation
- **Auto Start Templates**: Optionally start sessions from templates at backend startup via a new template attribute
- **Graceful Shutdown**: Proper cleanup and client notification

## Dependencies

- **node-pty**: Cross-platform PTY bindings for Node.js
- **express**: Web framework for REST API endpoints
- **ws**: WebSocket library for real-time communication
- **cors**: Cross-Origin Resource Sharing middleware
- **uuid**: UUID generation for session IDs

## API Reference

The complete backend API reference (endpoints, parameters, permissions, WebSocket messages, and history streaming) has been moved to a dedicated document:

- See `doc/backend-api.md`

### Image Uploads (Drag & Drop / Paste)

The frontend can upload images for a session (used for drag-and-drop and paste). The backend saves uploads under the per-session artifacts tree and returns a path appropriate for the isolation mode:

- Storage (host): `<data_dir>/sessions/<sessionId>/workspace/.bootstrap/uploads/<filename>`
- Response:
  - Isolation `container`: `{ container_path: "/workspace/.bootstrap/uploads/<filename>" }`
  - Isolation `directory` or `none`: `{ path: "<absolute-host-path>/.bootstrap/uploads/<filename>" }`

Endpoint details and validation (allowed types, size caps) are documented in `doc/backend-api.md` (POST `/api/sessions/:sessionId/upload-image`).

## Usage

### Environment-Specific Startup

```bash
# Development (port 6620, prefix /terminals-dev)
npm run start:dev
# or with watch mode
npm run dev

# Test (port 6622, prefix /terminals-test)
npm run start:test

# Production (port 6624, prefix /terminals)
npm run start:prod
```

### Generic Startup

```bash
# Uses default configuration (development)
npm start

# Or set environment explicitly
TERMINAL_MANAGER_CONFIG=production node server.js
NODE_ENV=prod node server.js
```

## Testing

From the `backend/` directory:

```bash
npm install
npm test           # Run Vitest suite
npm run test:watch # Watch mode
npm run test:coverage
npm run test:clean # Remove temp test artifacts
```

## Configuration

The Node.js backend supports multiple environments with environment-specific ports.

### Environment Configurations

The backend supports three environments, each with specific ports:

- **Development** (`development`): Port 6620
- **Test** (`test`): Port 6622
- **Production** (`production`): Port 6624

### Configuration Files

Environment-specific configuration files are located in `config/`:

- `config/development.json` - Development environment settings
- `config/test.json` - Test environment settings
- `config/production.json` - Production environment settings

### Environment Variables

- `TERMINAL_MANAGER_CONFIG` - Configuration environment name (development, test, production)
- `NODE_ENV` - Alternative to TERMINAL_MANAGER_CONFIG (dev, test, prod)

### Configuration Options

Each configuration file includes:

- `environment` - Environment identifier
- `log_level` - Logging level (DEBUG/INFO)
- `cors_origins` - Allowed CORS origins
- `terminal` - Terminal settings (shell, dimensions, timeouts)
- `websocket` - WebSocket configuration
- `ntfy` - Notification settings
- `data_dir` - Root directory for mutable runtime data (defaults to `backend/data` when unset). Per-session artifacts (workspaces, bootstrap, logs, metadata) live under `<data_dir>/sessions`. Example: `/srv/devtools/data/termstation-api/data` with session artifacts in `/srv/devtools/data/termstation-api/data/sessions`.
- `listeners` - Network listeners configuration

#### Listeners (HTTP and local socket)

Use the `listeners` block to configure one or more listeners. Two types are supported:
- `http`: TCP host/port
- `socket`: Local socket (Unix domain socket on POSIX; named pipe on Windows)

Schema

```jsonc
{
  "listeners": {
    "http": { "enabled": true, "host": "127.0.0.1", "port": 6624 },
    "socket": {
      "enabled": true,
      // Optional endpoint accepts any of socket://, unix://, or pipe:// prefixes
      // Backend picks the OS-appropriate transport (unix on POSIX, pipe on Windows)
      // and uses the provided path/name as override; when omitted, defaults are used.
      // Example (POSIX):   "endpoint": "socket:///run/user/1000/termstation.sock"
      // Example (Windows): "endpoint": "pipe://\\\\.\\pipe\\termstation"
      "endpoint": "",
      // Platform-specific optional overrides
      "path": "/run/user/1000/termstation.sock", // POSIX (absolute) or Windows pipe path (e.g., \\\\ \\.\\pipe\\termstation)
      "chmod": "0600", // POSIX only; applied after bind
      "unlink_stale": true // POSIX only; unlink stale socket on startup
    }
  }
}
```

Defaults and behavior
- When `listeners` is absent, the server starts a single local `socket` listener:
  - POSIX: `path=<data_dir>/termstation.sock` (for example `backend/data/termstation.sock` when `data_dir` is unset)
  - Windows: `name=\\.\pipe\termstation`
- When `listeners` is present, only listeners with `enabled: true` are started. If all are explicitly disabled, no listeners are started.
- Environment suffix: when no explicit `path` is provided, non‑production environments append `-<environment>` to the default endpoint (e.g., `termstation-dev.sock`, `termstation-test.sock`, `\\.\pipe\termstation-test`). Production keeps the canonical name.
- `listeners.socket.endpoint` accepts `socket://`, `unix://`, or `pipe://` on any OS; the backend chooses the proper transport by OS and uses the provided body as override.
- Legacy keys `listen_mode`, `unix_socket_path`, and `pipe_name` are not supported.

Deployment notes
- The server sets the socket file mode (default `0600`) after binding on POSIX.
- On Linux, the socket path length is validated (sun_path ~108 bytes).
- On restart, a stale socket file is unlinked automatically when `unlink_stale` is true.

#### Service proxy and tunnel helper

- `proxy.tunnel_helper_path` (string, optional): Full path to a `ts-tunnel` binary on the backend host. When set and the file exists, the backend stages it into each session at `.bootstrap/bin/ts-tunnel` so isolated sessions can start the reverse tunnel helper automatically.
  - Default: `/usr/local/bin/ts-tunnel` when unspecified
  - Fallbacks when the configured path is missing:
    1. Bundled repository helper `backend/tools/ts-tunnel/bin/ts-tunnel-linux-x64` (copied as `ts-tunnel` if present)
    2. Any tools under `backend/bootstrap/bin` are copied wholesale to `.bootstrap/bin` (useful for custom packaging)
  - Startup: the generated `run.sh` appends `.bootstrap/bin` to `PATH` and will start `ts-tunnel` in the background when a `SESSION_TOK` is available. If the helper is missing or fails to start, the session proceeds without a tunnel (non‑fatal).
  - New: the environment variable `BOOTSTRAP_DIR` (base directory) is exported for all isolation modes:
    - `container`: `BOOTSTRAP_DIR=/workspace/.bootstrap` (also set for attach/exec helpers)
    - `directory`: `BOOTSTRAP_DIR=<workspace>/.bootstrap` (via run.sh)
    - `none` (host): `BOOTSTRAP_DIR=<backend>/bootstrap` (via inline env export and PTY environment)

#### Workspace service feature flag

- `features.workspace_service_enabled` (boolean, optional): global gate for the per-session Workspace file API.
  - Default: `false` when omitted.
  - Effective enablement per session additionally requires the template to declare `"workspace_service_enabled": true` and the session isolation mode to be `"container"` or `"directory"`. The backend exposes this as `workspace_service_enabled_for_session` on each session and serves a backend-hosted file API under `/api/sessions/:sessionId/workspace[...]`.

### Isolation Modes

Templates in `backend/config/templates.json` control isolation:

- `isolation` (string): `"none"`, `"directory"`, or `"container"`
- `container_image`, `container_working_dir`, `container_memory`, `container_cpus`, `container_network`, `container_cap_add`: Container options
  - `container_cap_add` (array of strings, optional): Linux capabilities to add to the container. Passed as `--cap-add` to the runtime. Applies only when `isolation: "container"` (or when container isolation is forced at session creation).
    - Format: capability names in uppercase with optional `CAP_` prefix, e.g., `NET_ADMIN`, `SYS_PTRACE`, or `CAP_NET_ADMIN`.
    - Common use cases: `NET_ADMIN` (iptables/VPN/tunnels), `SYS_PTRACE` (debugging/tracing), `NET_BIND_SERVICE` (bind ports <1024).
    - Inheritance: arrays replace parent values (do not concatenate). May be set inside `sandbox_overrides`/`isolation_overrides` and will apply when container isolation is active.
    - Example:
      ```json
      {
        "id": "wireguard-template",
        "isolation": "container",
        "container_cap_add": ["NET_ADMIN"],
        "command": "wg-quick up wg0"
      }
      ```
- `env_vars`: Map of env vars injected into the container (supports `{var}` placeholders)
- `pre_commands`, `post_commands`: Arrays of shell commands executed inline (chained with `&&`) before/after the main command.
  - For container isolation, commands run inside the container via the orchestrator.
  - For directory isolation, commands run on the host via the same orchestrator from the workspace.
  - For none, commands run on the host as a single composite chain: `pre && main && post`.
 - `scheduled_input_rules`: Array of scheduled input rule specs to create when a session is started from this template (see doc/stdin-injection.md). Supports `type`, `offset_ms`/`interval_ms`, `data`, `stop_after`, and options (`submit`, `enter_style`, `raw`, `activity_policy`, `simulate_typing`, `typing_delay_ms`, `notify`).

#### File Writes (Workspace‑Relative)

Templates may declare files to be created before the main command runs using `write_files` (applied relative to the per-session workspace, which is also HOME):

```
{
  "id": "my-template",
  "isolation": "container",
  "write_files": [
    { "source": "AGENTS.md", "target": ".codex/AGENTS.md" }
  ]
}
```

Behavior:
- Reads `source` relative to the backend root directory (`backend/`). Absolute paths are allowed.
- Targets are workspace‑relative. Leading `/` is stripped; path traversal is rejected.
- Macro `{SESSION_WORKSPACE_DIR}` resolves to the effective workspace directory (`/workspace` in container isolation, the host workspace path in directory isolation, or the resolved template working directory when isolation is `none`). The same value is exported as the `SESSION_WORKSPACE_DIR` environment variable for all isolation modes (host sessions receive it via an inline `export`, container/directory via `run.sh`). A convenience `WORKSPACE_DIR` environment variable is also set automatically to the same value (or, when not available, to the effective HOME/workspace path for that isolation mode).
- Macro `{BOOTSTRAP_DIR}` resolves to the bootstrap base directory for the active isolation mode. Values:
  - container: `/workspace/.bootstrap`
  - directory: `<workspace>/.bootstrap`
  - none (host): `<backend>/bootstrap`
- If `source` is a file:
  - When `interpolate: true`, expands file includes of the form `{file:relative/path}` by inlining the referenced file content (same search rules). Missing include files are omitted (placeholder removed).
  - When `interpolate: true`, expands macros like `{SESSION_ID}` using the current template variables plus `config.TEMPLATE_VARS`. Unknown variables are treated as empty strings.
  - Writes the resulting content to the `target` path (container or workspace as applicable). Parent directories are created automatically.
- If `source` is a directory:
  - Copies the directory contents recursively into the absolute `target` directory (merged, not nested). Parent directory is created automatically.
  - Directory copies do not perform templating or include expansion; files are copied as-is.
  - When `mode`/`owner` are provided, they are applied recursively to the resulting target directory.

Notes:
- Applies to isolation `directory` and `container`.
- To inline literal content instead of a file, use `{"content": "...", "target": "/path"}`; add `"interpolate": true` to enable the same variable, include, and conditional processing as for file sources.
- Interpolation control: per entry, set `interpolate: true` to enable processing of variables, includes, and conditionals. Default is `false` for file entries (raw copy). Directory entries always copy bytes as-is.

#### In‑Place Include Expansion

Templates may also declare files whose `{file:...}` include markers should be expanded **after** `pre_commands` run but **before** the main command executes, using `expand_file_includes`:

```json
{
  "id": "my-template",
  "isolation": "container",
  "write_files": [
    { "source": "AGENTS.md", "target": ".codex/AGENTS.md", "interpolate": true }
  ],
  "pre_commands": [
    "echo \"Preparing workspace\""
  ],
  "expand_file_includes": [
    ".codex/AGENTS.md",
    "repo/README.md"
  ]
}
```

Behavior:
- Each entry in `expand_file_includes` is treated as a path to a file inside the effective session workspace (or container) whose contents should be post-processed.
- Paths may be absolute or workspace‑relative; they are passed through `processText`, so they may use the same `{VAR}` macros as other template fields (for example `{SESSION_WORKSPACE_DIR}` or `{BOOTSTRAP_DIR}`).
- For each path, the backend injects a call to the bootstrap helper `file-include.sh` so that, at runtime:
  - Any `{file:relative/path}` markers in the file are expanded in‑place.
  - Relative include paths are resolved relative to the directory of the file being processed.
  - When a file contains no `{file:...}` markers (or expansion produces no changes), it is left untouched (no rewrite).
- Expansion runs:
  - In host/directory isolation: from the generated `pre.sh`, immediately after user‑defined `pre_commands`.
  - In container isolation: from the container bootstrap `pre` script, immediately after user‑defined `pre_commands`.

### Isolation Overrides

Use `isolation_overrides` (if adopted) to define isolation‑specific overlays. During migration, container overlay continues to use legacy `sandbox_overrides` semantics when present.

- `isolation` controls runtime mode (`none`/`directory`/`container`).
- Overlays may be applied conditionally per isolation mode.
- Resolution order in the loader (compile-time):
  1. Resolve base template via current deep merge (including `extends`) into `final`.
  2. Resolve `sandbox_overrides` across the same inheritance chain into `overlay` using the same deep merge semantics.
  3. If `final.sandbox === true` and `overlay` is non-empty, apply `final = deepMerge(final, overlay)`.

- Runtime toggle (UI/API):
  - The New Session modal exposes a "Use sandbox" checkbox for single-template selection.
  - The sessions API accepts an optional top-level boolean `sandbox`. When provided, it forces the effective sandbox mode for that run, independent of the template default.
  - At runtime, the backend applies `sandbox_overrides` when `sandbox === true` (from the override or the template default). When `sandbox === false`, the overlay is not applied.
  - Multiple inheritance still applies: overlay parents merge left→right, then child last.
- Merge semantics inside `sandbox_overrides` are identical to normal inheritance:
  - `parameters`/`links`: merged by key (`name`), last-writer wins on conflicts.
  - `pre_commands`/`post_commands`: concatenate by default; `merge_pre_commands=false` or `merge_post_commands=false` replaces instead; `[]` clears; `null` clears.
  - `fork_pre_commands`/`fork_post_commands`: replace by default; `merge_fork_pre_commands=true` or `merge_fork_post_commands=true` concatenates; `[]` clears; `null` clears.
  - `write_files`: replace by default; `merge_write_files=true` concatenates; `[]` clears; `null` clears.
  - `expand_file_includes`: replace by default; `merge_expand_file_includes=true` concatenates; `[]` clears; `null` clears.
  - Scalars/objects: last writer wins.
- Multiple inheritance is honored: parents merge left→right, child last. The overlay order matches the normal resolution order.

Example: override host defaults only when sandboxed

```
{
  "id": "codex-shared",
  "name": "Codex Shared",
  "command": "codex --model {model} \"{prompt}\"",   // host default
  "pre_commands": ["echo host-setup"],                  // host pre
  "parameters": [ { "name": "model", "default": "gpt-5" }, { "name": "prompt" } ],
  "sandbox_overrides": {
    "command": "codex --dangerously-bypass-approvals-and-sandbox --model {model} \"{prompt}\"",
    "merge_pre_commands": false,
    "pre_commands": ["echo container-setup"],
    "write_files": [
      { "source": "files/AGENTS.md", "target": "${HOME}/.codex/AGENTS.md" }
    ]
  }
}
```

Usage:
- If a child resolves to `isolation: none`, host defaults apply.
- If a child resolves to `isolation: container`, the container overlay applies; for `directory`, use workspace orchestration on host.

### Conditional Templating

Templated text fields support lightweight conditional blocks, file includes, and variable substitution with a shared processor used across all relevant fields.

Supported in:
- `write_files[].content` and `write_files[].source` (content after expansion)
- `command`
- `pre_commands[]`, `post_commands[]`
- `env_vars` values
- Links (`links[].url`, `links[].name`)
- Command tabs (`command_tabs[].name`, `command_tabs[].command`)

#### Links: Skip When Unresolved

Each template link object supports an optional boolean `skip_if_unresolved` flag. When set to `true`, the backend will omit that link if any `{var}` placeholders in the link's `url` or `name` do not resolve to a non-empty value at session creation time (after merging `config.TEMPLATE_VARS`, provided template parameters, and parameter defaults).

Example:

```
{
  "id": "example-template",
  "name": "Example",
  "links": [
    {
      "name": "Issue #{issue_id}",
      "url": "https://pc:8443/$REPO/-/issues/{issue_id}",
      "skip_if_unresolved": true
    },
    {
      "name": "Always Visible",
      "url": "https://pc:8443/$REPO",
      "skip_if_unresolved": false
    }
  ],
  "parameters": [
    { "name": "issue_id", "required": false }
  ]
}
```

In this example, if `issue_id` is not provided (and has no default), the first link is omitted rather than rendering with an empty `{issue_id}` segment.

#### Command Tabs (Container Only)

Templates can define command tabs that render as separate tabs next to the terminal. Each tab represents a simple one‑liner command that runs inside the session’s container when the tab is activated. Clicking the refresh button on a tab re‑runs the command.

Field: `command_tabs` — array of objects

Each object supports:
- `name` (string): Tab label
- `command` (string): One‑liner to execute (e.g., `git diff`)
- `show_active` (boolean, optional; default true): Visible while the session is active
- `show_inactive` (boolean, optional; default true): Visible after termination
- `skip_if_unresolved` (boolean, optional): Omit the tab when any `{var}` in `name` or `command` remains unresolved/blank after processing

Example:

```
{
  "id": "repo-checks",
  "name": "Repo Checks",
  "sandbox": true,
  "command": "bash",
  "command_tabs": [
    { "name": "Diff", "command": "git diff" },
    { "name": "Status", "command": "git status" }
  ]
}
```

Behavior:
- Supported only for `isolation: container` templates
- Executing a tab creates a hidden child session bound to the parent container; it does not appear in the sidebar and is shown only in the tab
- Refreshing a tab stops the prior child (if running) and starts a fresh run

Directives:
- `{% if expr %} ... {% endif %}`
- `{% if expr %} ... {% elif expr %} ... {% else %} ... {% endif %}`

Expressions (string-focused):
- `var eq "val"`, `var ne "val"`
- `var in ["a","b"]`, `var not_in ["a","b"]`
- `var contains "x"`, `var starts_with "x"`, `var ends_with "x"`
- `var matches "^re$"` (safe regex)
- `var exists`, `var empty`, `var nonempty`

Variables resolve from the merged context of `config.TEMPLATE_VARS`, provided template variables, and parameter defaults. Missing/unknown variables behave as empty string.

Processing order per field:
1. Evaluate conditional blocks (remove non-matching branches and strip markers)
2. Expand `{file:path}` includes; each included file is processed recursively by the same pipeline
   - Include paths support macro and environment variable expansion: `{file:{CONFIG_DIR}/templates/header.txt}` or `{file:$HOME/.config/settings.txt}`
   - Macros (`{VAR}`) are expanded first, then shell-style environment variables (`$VAR` or `${VAR}`)
   - Variables are resolved from the template context first, then from `process.env`
3. Perform `{var}` macro substitution on the final text (unknown variables => empty string)

Examples:
- Guard an include:
```
{% if model eq "gpt-5" %}
{file:path/to/file}
{% endif %}
```

- Inline optional flags in a command (note spaces inside blocks to keep spacing tidy when removed):
```
claude{% if model nonempty %} --model={model}{% endif %}{% if model_reasoning_effort nonempty %} --config model_reasoning_effort="{model_reasoning_effort}"{% endif %} "{prompt}"
```

- Include files using variables in the path:
```
{file:{CONFIG_DIR}/templates/header.txt}
{file:{BASE_DIR}/{ENVIRONMENT}/config.json}
{file:$HOME/.config/myapp/settings.txt}
```

Safety and limits:
- No `eval`; simple string expressions only.
- Include recursion depth: 5; Conditional nesting depth: 20.
- Malformed/unbalanced directives are treated as literal text and logged at DEBUG.

### Inheritance

Templates can inherit from other templates using the `extends` field.

- Single parent (existing): `"extends": "base-id"`
- Multiple parents (new): `"extends": ["baseA", "baseB"]`

Resolution:
- Parents are merged left-to-right using deep merge; later parents override earlier ones on conflicts.
- The child is then merged last and wins over all parents.
- Arrays merge as follows:
  - `parameters` and `links`: merged by key (`name`) with last-wins overlay
  - `pre_commands` and `post_commands`: concatenated (base first, then child) unless overridden by merge flags (see below)
  - `fork_pre_commands` and `fork_post_commands`: replace by default; can opt-in to merge with flags

Cycles and errors:
- Cyclic inheritance is detected and rejected.
- Missing parent IDs produce a load error for the affected template.

### Recipes: Sandbox vs Host Variants

A common pattern is to provide both sandboxed and non-sandboxed variants that share most configuration but differ in files and pre/post setup.

Shared base (common parameters/command):
```
{
  "id": "codex-shared",
  "extends": "ai-assistant-base",
  "env_vars": { "AGENT": "codex" },
  "parameters": [
    { "name": "model", "type": "select", "required": true, "default": "gpt-5" },
    { "name": "model_reasoning_effort", "type": "select", "required": true, "default": "high" }
  ],
  "command": "codex --model {model} --config model_reasoning_effort=\"{model_reasoning_effort}\" \"{prompt}\""
}
```

Sandbox variant (containerized; own pre/post and write_files):
```
{
  "id": "codex-sandbox",
  "extends": "codex-shared",
  "sandbox": true,
  "merge_pre_commands": false,
  "merge_post_commands": false,
  "write_files": [
    { "source": "files/AGENTS.md", "target": "${HOME}/.codex/AGENTS.md" }
  ],
  "pre_commands": [
    "echo preparing in container"
  ],
  "post_commands": [
    "echo done in container"
  ]
}
```

Host variant (non-sandbox; own pre/post executed on host):
```
{
  "id": "codex-host",
  "extends": "codex-shared",
  "merge_pre_commands": false,
  "merge_post_commands": false,
  "pre_commands": [
    "echo preparing on host"
  ],
  "post_commands": [
    "echo done on host"
  ]
}
```

Notes:
- Host `pre_commands`/`post_commands` run on the host as a single composite chain: `pre && main && post`.
- For non-sandbox templates, environment variables defined via `env_vars` are injected by prefixing inline `export` statements (e.g., `export VAR1="..." && export VAR2="..." && pre && main && post`). TerminalSession will wrap complex commands with `bash -c` as needed, so we do not nest an extra `bash -lc` in the template command.
- Use `merge_*` flags to avoid inheriting pre/post from parents; `[]` or `null` also clear.

### Inline Repo Execution

To execute the template command from an optional repository path parameter (e.g., `repo`) in both host and sandbox modes, prepend a conditional `cd` as part of your `pre_commands` or main `command`:

```
{% if repo nonempty %}echo cd "{repo}"; cd "{repo}";{% endif %} your-command ...
```

This ensures consistent behavior for host and sandbox runs without relying on external working directory injection. The `echo cd "{repo}"` line provides a visible log hint in the session output.

### Clear Semantics and Merge Flags (Summary)

For `pre_commands`, `post_commands`, `fork_pre_commands`, `fork_post_commands`, and `write_files`:

- Missing: inherit base value
- `null`: clear (override to none)
- `[]`: clear (override to none)

Merge flags on the overriding node control concatenation:

- `merge_pre_commands` (default `true`): when `false`, child replaces base
- `merge_post_commands` (default `true`): when `false`, child replaces base
- `merge_fork_pre_commands` (default `false`): when `true`, child concatenates with base
- `merge_fork_post_commands` (default `false`): when `true`, child concatenates with base

Write files:
- `merge_write_files` (default `false`): when `true`, `write_files` concatenates base + child (base first, then child). When `false`, child replaces base.
  - Under multiple inheritance, parents merge left→right according to each parent’s flag; the child flag applies last.

### Merge Behavior for pre/post and fork overrides

To reduce duplication and provide precise control over inherited setup/teardown commands, the loader supports both merge controls and consistent clear semantics:

- Clear semantics (consistent):
  - Missing field: inherit from base
  - `null`: clear (override to none)
  - `[]`: clear (override to none)

- Merge controls (optional booleans on the overriding node):
  - `merge_pre_commands` (default `true`): when `false`, child `pre_commands` replaces base rather than concatenating
  - `merge_post_commands` (default `true`): when `false`, child `post_commands` replaces base rather than concatenating
  - `merge_fork_pre_commands` (default `false`): when `true`, `fork_pre_commands` concatenates base + child
  - `merge_fork_post_commands` (default `false`): when `true`, `fork_post_commands` concatenates base + child

Notes:
- Concatenation order is base first, then child.
- `fork_pre_commands`/`fork_post_commands` are used when forking sessions; when present, they override the regular `pre_commands`/`post_commands` for the forked session.

### Containers / Runtime Configuration

Container engine and host mappings can be controlled via config and env variables.

- `containers.runtime` (string): Select container engine. Supported: `podman`, `docker`.
  - Env override: `CONTAINER_RUNTIME`.
  - When not set, the backend prefers Docker if available, otherwise Podman.
- `containers.runtime_user` (string): OS user to run container commands as (used with `sudo -u`).
- `containers.stop_timeout_seconds` (number, optional): Graceful stop timeout (seconds) passed to the container
  runtime (e.g., `podman stop -t N` / `docker stop -t N`) when stopping containers.
  - Env override: `CONTAINER_STOP_TIMEOUT_SECONDS`.
  - When not set or invalid (non‑positive/non‑numeric), defaults to `2` seconds.
- `containers.add_hosts` (array of strings): Additional host mappings to inject into all sandbox containers,
  each in the form `"host:ip"` (e.g., `"gitlab:10.89.1.2"`). Applied for both Docker and Podman.
- `containers.preserve_template_env_vars_for_login` (boolean, optional): When `true`, duplicate template-defined
  `env_vars` into the persistent per-session `.env` file for container sessions so that attach/exec helpers can
  restore them when logging into an existing container. Defaults to `false`; enabling this makes template env vars
  persist on disk in the per-session workspace.

Exposed template variables:
- `CONTAINER_RUNTIME`: Resolved engine name (`podman` or `docker`).
- `RUNTIME_BIN`: Absolute path to the resolved engine binary.

### Container API Access

Container-isolated sessions need to reach the backend API. Two methods are supported:

1. **Network URL (default)**: Containers use `container_sessions_api_base_url` or fall back to `sessions_api_base_url`.
2. **Unix socket adapter (opt-in)**: The backend's Unix socket is bind-mounted into containers, and `socat` bridges a local TCP port to the socket.

Config options:
- `container_sessions_api_base_url` (string, optional): API base URL for container sessions (e.g., `http://host.containers.internal:6624/api/`). When not set, containers use `sessions_api_base_url`.
- `container_use_socket_adapter` (boolean, optional): When `true`, bind-mount the Unix socket into containers and use `socat` to bridge a local TCP port to the socket. Default: `false`.
- `container_socket_adapter_port` (number, optional): TCP port for the in-container socat adapter. Default: `7777`.

Example config for socket adapter:
```json
{
  "listeners": {
    "socket": { "enabled": true, "chmod": "0600" }
  },
  "container_use_socket_adapter": true
}
```

When `container_use_socket_adapter` is enabled:
- The socket is mounted at `/workspace/.bootstrap/api.sock` inside containers
- The generated `run.sh` starts `socat TCP-LISTEN:<port>,fork,reuseaddr UNIX-CONNECT:/workspace/.bootstrap/api.sock`
- `SESSIONS_API_BASE_URL` is set to `http://127.0.0.1:<port>/api/` inside containers
- Container images **must** have `socat` installed (session startup will fail if missing)

SELinux notes (Podman on RHEL/Fedora):
- The socket mount uses the shared SELinux label (`:z`) to allow access from multiple containers
- You may need a custom SELinux policy module to allow `container_t` to connect to sockets owned by `unconfined_t`:
  ```
  allow container_t unconfined_t:unix_stream_socket connectto;
  allow container_t container_file_t:sock_file write;
  allow container_t container_var_run_t:sock_file write;
  ```

### Template RBAC

Per-user and per-group control over which templates can be listed and used.

Config fields (in the runtime users/groups files under the backend data directory, e.g. `backend/data/users.json` and `backend/data/groups.json`):
- `allow_templates`: `"*"` or `[templateId, ...]`
- `deny_templates`: `"*"` or `[templateId, ...]`

Resolution logic:
1) Universe of known template IDs is derived from `backend/config/templates.json`.
2) Groups (in the user’s `groups[]` order):
   - `groupAllow = "*"` if any group has `allow_templates == "*"`; otherwise the union of all group allow lists (preserve order: groups order, then per‑group order; dedupe).
   - `groupDeny = "*"` if any group has `deny_templates == "*"`; otherwise the union of all group deny lists.
   - `AllowedAfterGroups = groupAllow − groupDeny`.
3) User overrides:
   - If `user.allow_templates == "*"`: append all templates to `AllowedAfterGroups` (dedupe).
   - Else append `user.allow_templates` (dedupe).
   - If `user.deny_templates == "*"`: final = empty; else remove `user.deny_templates` from the current allowed set.
4) Deny wins whenever both allow and deny apply to the same template.

Ordering (for display): append in group order (per‑group order, dedupe), then append user allows (dedupe), then apply denies (removal preserves remaining order).

Unknown template IDs in `allow_templates`/`deny_templates` are ignored (logged at DEBUG).

Enforcement points:
- `GET /api/templates`: returns only the resolved allowed set for the authenticated user.
- `POST /api/sessions` (template-based): rejects any `template_id` not in the resolved allowed set (HTTP 403).

Default policy: if no allows are configured at group or user level, the user has access to no templates.

### Template parameter options

Select-type template parameters can choose where their options come from, and can be driven by per-user/per-group config.

Config fields:
- In the runtime users/groups files under the backend data directory (e.g. `backend/data/users.json` and `backend/data/groups.json`):
  - `parameter_values`: object mapping logical keys to arrays of strings (e.g., `"repo"` → list of repositories).

Example group definition:

```json
{
  "name": "developers",
  "parameter_values": {
    "repo": [
      "devtools/terminals",
      "productivity/time-tracker"
    ]
  }
}
```

Template parameter fields (for `"type": "select"`):
- `options_source` (string, optional): `"static"` (default when omitted), `"command"`, or `"user"`.
  - `"static"`: use the parameter’s `options` array.
  - `"command"`: execute `command` or `command_file` to compute options.
  - `"user"`: derive options from `parameter_values` in users/groups.
- `options_user_key` (string, optional): logical key to look up in `parameter_values` when `options_source: "user"`; defaults to the parameter name.

Example user-driven parameter:

```json
{
  "name": "repo",
  "label": "Repository",
  "type": "select",
  "options_source": "user",
  "options_user_key": "repo"
}
```

Resolution for `options_source: "user"`:
- Load the request user’s profile and groups.
- Build an ordered union of `parameter_values[options_user_key]` from each group (in group order), then from the user record.
- De-duplicate while preserving the first occurrence of each value.

### Feature Flags

Feature flags are resolved from group and user definitions with support for a wildcard.

- Canonical feature keys are defined in code at `backend/constants/access-keys.js` (export `FEATURE_KEYS`).
- Groups and users may define `features` as an object of booleans, or the wildcard string `"*"`.
- Wildcard expansion: when any group or the user sets `features: "*"`, the system enables all known feature keys for that user. Explicit `false` values in group/user definitions override the wildcard for specific keys.

Current flags of note:
- `notes_enabled`: enables session notes API (GET/PUT `/:sessionId/note`).
- `image_uploads_enabled`: enables image upload API used by drag-and-drop/paste (POST `/:sessionId/upload-image`).
- `local_terminal_enabled`: enables the desktop (Electron) local terminal feature in the UI. Defaults OFF; members of the `admins` group (which uses `features: "*"`) will have it enabled automatically.
 - `config_reload_enabled`: enables the admin-only Settings control and backend API to reload templates/users/groups/links from disk without restarting the server (POST `/api/system/reload-config`).

Example user definition using wildcard with an override:

```json
{
  "username": "kevin",
  "features": "*"  // all known features on
}
```

```json
{
  "username": "dev",
  "features": { "notes_enabled": false } // keep notes disabled even if a group uses wildcard
}
```

```json
{
  "username": "viewer",
  "features": { "image_uploads_enabled": false }
}
```

### Permissions

Permissions are resolved from group and user definitions with support for a wildcard, similar to features.

- Canonical permission keys are defined in code at `backend/constants/access-keys.js` (export `PERMISSION_KEYS`).
- Groups and users may define `permissions` as an object of booleans, or the wildcard string `"*"`.
- Wildcard expansion: when any group or the user sets `permissions: "*"`, the system enables all known permission keys for that user. Explicit `false` values in group/user definitions override the wildcard for specific keys.

Examples:

```json
{
  "username": "kevin",
  "permissions": "*"  // all known permissions on
}
```

```json
{
  "name": "moderators",
  "permissions": { "broadcast": false } // explicit false overrides wildcard from another group
}
```

### Session Limits

Control the number of active sessions allowed globally, per user, and per group.

- Global cap: `terminal.max_sessions` in `backend/config/*/config.json` limits total active sessions across all users. Omit or set to a negative/invalid value to disable.
- Per-user cap: add `max_sessions` (number) to a user in `users.json`. When set, the user cannot create a new session once their active session count reaches the cap.
- Per-group caps (in `groups.json`):
  - `max_sessions_per_user`: per-user cap applied to members of the group. When a user belongs to multiple groups, the most restrictive (smallest) per-user cap is enforced.
  - `max_sessions_total`: total active sessions cap for all members of the group combined.

Notes:
- Limits apply to active sessions only; terminated sessions do not count.
- When both user and group per-user caps are present, the smallest cap takes precedence.
- If no caps are defined for a user/group, no limit is enforced for that scope.
- Admins or service users can be exempt simply by not defining caps for their accounts/groups.

### Nginx Integration

The backend works with nginx reverse proxy. Nginx handles path stripping, so the backend serves all endpoints directly:

```nginx
# Development
location /terminals-api-dev/ {
    proxy_pass http://localhost:6620/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
}

# Test  
location /terminals-api-test/ {
    proxy_pass http://localhost:6622/;
    # ... same proxy settings
}

# Production
location /terminals-api/ {
    proxy_pass http://localhost:6624/;
    # ... same proxy settings
}
```


## Architecture

### Key Classes

1. **TerminalSession**: Manages individual PTY processes and session state
2. **SessionManager**: Handles session lifecycle and client attachments
3. **ConnectionManager**: Manages WebSocket connections and broadcasting

### Session Lifecycle

1. Client creates session via REST API
2. `TerminalSession` spawns PTY process using `node-pty`
3. Clients can attach via WebSocket to receive output
4. Input is sent through WebSocket `stdin` messages
5. Sessions can be resized, terminated, or naturally exit
6. Session history is preserved based on configuration

## Key Improvements

- **Native Node.js**: Better performance and resource utilization
- **Modern ES Modules**: Clean module system with import/export
- **Simplified Architecture**: More straightforward codebase
- **Better Error Handling**: Comprehensive error handling and logging
- **Cross-platform**: Works on Linux, macOS, and Windows

## Notification Persistence & Retention

- Notifications are stored per-user at `${DATA_DIR}/notifications.json` with debounced saves (temp+rename).
- Retention policy:
  - Max 30 days age per item
  - Max 500 items per user (newest kept)

 
### Auto Start Templates

Templates can opt-in to automatically start a session when the backend starts.

- Add `auto_start` to a template in `config/<env>/templates.json`.
- Accepted forms:
  - `true` — start with parameter defaults
  - Object with overrides:
    - `parameters` — map of template parameters to apply
    - `title` — session title
    - `workspace` — workspace name (defaults to template’s default or `Default`)
    - `visibility` — `private` | `public` | `shared_readonly` (default `private`)
    - `isolation_mode` — `none` | `directory` | `container` (override template)
    - `username` — username to run the session as (defaults to `config.default_username` or `developer`)

Example:
```jsonc
{
  "id": "assistant",
  "extends": "cursor",
  "name": "Assistant",
  "auto_start": {
    "parameters": { "repo": "productivity/assistant" },
    "title": "Assistant",
    "workspace": "Assistants",
    "visibility": "private",
    "isolation_mode": "container",
    "username": "alice"
  }
}
```

On startup, the backend resolves parameter defaults, prepares any required workspace for `container`/`directory` isolation, starts the session, and broadcasts the creation event.
