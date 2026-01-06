/**
 * Configuration loader for termstation Node.js Backend
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class Config {
  constructor(configData) {
    // Apply $HOME (and other simple env) interpolation across the raw
    // config object before any fields are read, so string paths like
    // "$HOME/termstation" are resolved once at load time.
    interpolateEnvInConfig(configData);
    this._config = configData;
    
    // Environment info
    this.ENVIRONMENT = configData.environment;

    // Backend data directory (for mutable runtime data like workspaces, sessions, and logs)
    const backendRoot = __dirname;
    const rawDataDir = (typeof configData.data_dir === 'string') ? configData.data_dir.trim() : '';
    const dataDir = rawDataDir
      ? (isAbsolute(rawDataDir) ? rawDataDir : resolve(backendRoot, rawDataDir))
      : join(backendRoot, 'data');
    
    // Server settings moved under listeners.http; top-level host/port are ignored

    // Listeners configuration (multi-listener): http and local socket (unix/pipe)
    try {
      const isWin = process.platform === 'win32';
      const resolveAutoUnixPath = () => {
        // Default to a socket inside the backend data directory alongside sessions/logs.
        // Example: <DATA_DIR>/termstation.sock
        return join(dataDir, 'termstation.sock');
      };
      const defaultPipe = "\\\\.\\pipe\\termstation";
      const parseBool = (v, d = false) => {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') { const s = v.trim().toLowerCase(); return s === '1' || s === 'true' || s === 'yes' || s === 'on'; }
        if (typeof v === 'number') return v !== 0;
        return d;
      };

      const listenersCfg = (configData && typeof configData.listeners === 'object') ? (configData.listeners || {}) : null;
      const envRaw = String(configData.environment || '').trim().toLowerCase();
      const envSuffix = (() => {
        if (!envRaw) return '';
        if (envRaw === 'prod' || envRaw === 'production') return '';
        if (envRaw === 'dev' || envRaw === 'development') return '-dev';
        if (envRaw === 'test') return '-test';
        // Fallback: sanitize env to a short suffix
        return '-' + envRaw.replace(/[^a-z0-9_-]+/g, '-');
      })();
      const appendUnixSuffix = (p) => {
        if (!envSuffix) return p;
        return p.endsWith('.sock') ? p.replace(/\.sock$/i, `${envSuffix}.sock`) : (p + envSuffix);
      };
      const listeners = [];

      if (!listenersCfg) {
        // Default behavior: listen on local socket with OS-appropriate endpoint
        if (isWin) {
          const pipePath = defaultPipe + envSuffix;
          listeners.push({ type: 'socket', mode: 'pipe', path: pipePath, enabled: true });
        } else {
          const socketPath = appendUnixSuffix(resolveAutoUnixPath());
          // Validate absolute and length (Linux)
          if (!isAbsolute(socketPath)) throw new Error(`UNIX socket path must be absolute: '${socketPath}'`);
          if (process.platform === 'linux') {
            const bytes = Buffer.byteLength(socketPath, 'utf8');
            const maxBytes = 107;
            if (bytes > maxBytes) throw new Error(`UNIX socket path too long for Linux sun_path (~108 bytes). Length=${bytes}, path='${socketPath}'`);
          }
          listeners.push({ type: 'socket', mode: 'unix', path: socketPath, chmod: '0600', unlink_stale: true, enabled: true });
        }
      } else {
        // Explicit listeners: only start those explicitly enabled=true
        const httpCfg = listenersCfg.http || {};
        if (parseBool(httpCfg.enabled, false)) {
          const host = (httpCfg.host && String(httpCfg.host).trim()) || '127.0.0.1';
          const rawPort = Number(httpCfg.port != null ? httpCfg.port : 6624);
          const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.floor(rawPort) : 6624;
          listeners.push({ type: 'http', host, port, enabled: true });
        }

        const socketCfg = listenersCfg.socket || {};
        if (parseBool(socketCfg.enabled, false)) {
          // Abstraction layer: accept endpoint with socket|unix|pipe prefix, and/or platform-specific keys
          const rawEndpoint = (socketCfg.endpoint && String(socketCfg.endpoint).trim()) || '';
          let endpointBody = '';
          if (rawEndpoint) {
            const m = rawEndpoint.match(/^\s*(socket|unix|pipe):\/\/(.*)$/i);
            endpointBody = m ? m[2] : rawEndpoint.replace(/^\s*/,'');
          }
          const providedPath = (socketCfg.path && String(socketCfg.path).trim()) || '';

          if (!isWin) {
            // POSIX: resolve unix socket path
            let socketPath = providedPath || (endpointBody || '');
            if (!socketPath) socketPath = appendUnixSuffix(resolveAutoUnixPath());
            if (!isAbsolute(socketPath)) throw new Error(`UNIX socket path must be absolute: '${socketPath}'`);
            if (process.platform === 'linux') {
              const bytes = Buffer.byteLength(socketPath, 'utf8');
              const maxBytes = 107;
              if (bytes > maxBytes) throw new Error(`UNIX socket path too long for Linux sun_path (~108 bytes). Length=${bytes}, path='${socketPath}'`);
            }
            const chmod = String(socketCfg.chmod || '0600').trim();
            const unlinkStale = parseBool(socketCfg.unlink_stale, true);
            listeners.push({ type: 'socket', mode: 'unix', path: socketPath, chmod, unlink_stale: unlinkStale, enabled: true });
          } else {
            // Windows: resolve named pipe path (use 'path' key as abstraction)
            let pipePath = providedPath || (endpointBody || '');
            if (!pipePath) pipePath = defaultPipe + envSuffix;
            listeners.push({ type: 'socket', mode: 'pipe', path: pipePath, enabled: true });
          }
        }
      }

      this.LISTENERS = listeners;
      // Expose the first local Unix socket path (if any) so other components
      // can derive bind mounts or workspace links dynamically from config.
      try {
        const firstUnix = (listeners || []).find(
          (lst) => lst && lst.type === 'socket' && lst.mode === 'unix' && lst.path
        );
        this.LOCAL_UNIX_SOCKET_PATH = firstUnix ? String(firstUnix.path) : '';
      } catch (_) {
        this.LOCAL_UNIX_SOCKET_PATH = '';
      }
      // Remove legacy single-listen fields
      this.LISTEN_MODE = undefined;
      this.UNIX_SOCKET_PATH = undefined;
      this.PIPE_NAME = undefined;
    } catch (e) {
      throw e;
    }
    
    // Authentication
    this.AUTH_ENABLED = configData.auth_enabled !== undefined ? configData.auth_enabled : false;
    // Default username when auth is disabled, or as a fallback
    this.DEFAULT_USERNAME = (configData.default_username && String(configData.default_username).trim()) || 'developer';
    
    // Username alias mapping for system operations (e.g., sudo -u, id/groups checks)
    // Example: { "john": "jsmith" }
    try {
      const rawAliases = configData.username_aliases || {};
      const map = {};
      const isValidSystemUsername = (v) => {
        if (typeof v !== 'string') return false;
        const s = v.trim();
        // Allow typical UNIX user pattern, including optional trailing '$' for service accounts
        return /^[a-z_][a-z0-9_-]*[$]?$/i.test(s);
      };
      if (rawAliases && typeof rawAliases === 'object') {
        for (const [presented, target] of Object.entries(rawAliases)) {
          const key = String(presented ?? '').trim();
          const val = String(target ?? '').trim();
          if (!key || !val) {
            console.warn(`[config] Skipping empty username_aliases entry: '${presented}' -> '${target}'`);
            continue;
          }
          if (!isValidSystemUsername(key) || !isValidSystemUsername(val)) {
            console.warn(`[config] Invalid username_aliases mapping; rejected: '${key}' -> '${val}'`);
            continue;
          }
          map[key] = val;
        }
      }
      this.USERNAME_ALIASES = map;
    } catch (_) {
      this.USERNAME_ALIASES = {};
    }
    
    // Logging
    this.LOG_LEVEL = configData.log_level;
    this.LOG_FORMAT = configData.logging?.format || '';
    
    // CORS
    this.CORS_ORIGINS = configData.cors_origins;
    this.CORS_CREDENTIALS = configData.cors_credentials;
    
    // Terminal settings
    if (process.platform === 'win32') {
      this.DEFAULT_SHELL = 'cmd.exe';
    } else {
      this.DEFAULT_SHELL = configData.terminal.default_shell;
    }
    
    if (configData.terminal.default_working_dir === '~') {
      this.DEFAULT_WORKING_DIR = homedir();
    } else {
      this.DEFAULT_WORKING_DIR = configData.terminal.default_working_dir;
    }
    
    this.DEFAULT_COLS = configData.terminal.default_cols;
    this.DEFAULT_ROWS = configData.terminal.default_rows;
    
    // Session management
    this.MAX_SESSIONS = configData.terminal.max_sessions;
    this.SESSION_TIMEOUT = configData.terminal.session_timeout_seconds;
    this.CLEANUP_INTERVAL = configData.terminal.cleanup_interval_seconds;
    
    // WebSocket settings (convert from milliseconds to seconds)
    this.WS_PING_INTERVAL = Math.floor(configData.websocket.ping_interval_ms / 1000);
    this.WS_PING_TIMEOUT = Math.floor(configData.websocket.ping_timeout_ms / 1000);

    // Debug flags for WebSocket I/O
    const wsCfg = configData.websocket || {};
    const parseBool = (v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        return s === '1' || s === 'true' || s === 'yes' || s === 'on';
      }
      if (typeof v === 'number') return v !== 0;
      return false;
    };
    // Allow environment variables to override when present
    const envDebugStdin = process.env.DEBUG_WS_STDIN;
    const envDebugStdout = process.env.DEBUG_WS_STDOUT;
    this.DEBUG_WS_STDIN = envDebugStdin !== undefined ? parseBool(envDebugStdin) : parseBool(wsCfg.debug_ws_stdin);
    this.DEBUG_WS_STDOUT = envDebugStdout !== undefined ? parseBool(envDebugStdout) : parseBool(wsCfg.debug_ws_stdout);
    
    // API stdin injection focus controls
    const injCfg = configData.stdin_injection || {};
    // Defaults: do not send focus codes unless explicitly enabled
    this.API_STDIN_SEND_FOCUS_IN = injCfg.send_focus_in !== undefined ? parseBool(injCfg.send_focus_in) : false;
    this.API_STDIN_SEND_FOCUS_OUT = injCfg.send_focus_out !== undefined ? parseBool(injCfg.send_focus_out) : false;
    // API stdin injection defaults (can be overridden per-request)
    // Whether to simulate typing by default when caller doesn't specify
    this.API_STDIN_DEFAULT_SIMULATE_TYPING = (injCfg.default_simulate_typing !== undefined)
      ? parseBool(injCfg.default_simulate_typing)
      : true;
    // Per-character delay (ms) when simulating typing and no explicit value is provided
    try {
      const n = Number(injCfg.default_typing_delay_ms);
      this.API_STDIN_DEFAULT_TYPING_DELAY_MS = (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 0;
    } catch (_) {
      this.API_STDIN_DEFAULT_TYPING_DELAY_MS = 0;
    }
    // Additional Enter delay (ms) for an optional second Enter when submit=true and caller did not pass delay_ms
    try {
      const n = Number(injCfg.default_delay_ms);
      this.API_STDIN_DEFAULT_DELAY_MS = (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 1000;
    } catch (_) {
      this.API_STDIN_DEFAULT_DELAY_MS = 1000;
    }
    // Per-session input message limit (HTTP API)
    try {
      const rawMax = injCfg.max_messages_per_session;
      const n = Number(rawMax);
      // Treat non-finite/negative/undefined as unlimited (null)
      this.API_STDIN_MAX_MESSAGES_PER_SESSION = (rawMax === undefined || rawMax === null)
        ? null
        : (Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);
    } catch (_) {
    this.API_STDIN_MAX_MESSAGES_PER_SESSION = null;
    }

    // Terminal output buffer
    this.MAX_BUFFER_SIZE = configData.terminal.max_buffer_size;
    this.OUTPUT_CHUNK_SIZE = configData.terminal.output_chunk_size;

    // Maximum size of in-memory output history buffer (bytes). Default 5MB.
    // This buffer is used briefly during client connection switching.
    try {
      const raw = configData.terminal.max_output_history_size;
      const n = Number(raw);
      this.MAX_OUTPUT_HISTORY_SIZE = (raw === undefined || raw === null)
        ? 5 * 1024 * 1024
        : (Number.isFinite(n) && n > 0 ? Math.floor(n) : 5 * 1024 * 1024);
    } catch (_) {
      this.MAX_OUTPUT_HISTORY_SIZE = 5 * 1024 * 1024;
    }

    // Scheduled input caps (env-overridable)
    // Default maximum rules per session: 20
    // Default maximum bytes per rule data: 8192
    try {
      const maxRulesEnv = process.env.SCHEDULED_INPUT_MAX_RULES_PER_SESSION;
      const n = Number(maxRulesEnv);
      this.SCHEDULED_INPUT_MAX_RULES_PER_SESSION = (maxRulesEnv === undefined || maxRulesEnv === null)
        ? 20
        : (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20);
    } catch (_) {
      this.SCHEDULED_INPUT_MAX_RULES_PER_SESSION = 20;
    }
    try {
      const maxBytesEnv = process.env.SCHEDULED_INPUT_MAX_BYTES_PER_RULE;
      const n = Number(maxBytesEnv);
      this.SCHEDULED_INPUT_MAX_BYTES_PER_RULE = (maxBytesEnv === undefined || maxBytesEnv === null)
        ? 8192
        : (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 8192);
    } catch (_) {
      this.SCHEDULED_INPUT_MAX_BYTES_PER_RULE = 8192;
    }

    // Scheduled input per-session message limit (separate from HTTP API)
    // Read from config file only; default to 50 when missing/invalid.
    try {
      const si = configData.scheduled_input || {};
      const rawMax = si.max_messages_per_session;
      const n = Number(rawMax);
      this.SCHEDULED_INPUT_MAX_MESSAGES_PER_SESSION = (rawMax === undefined || rawMax === null)
        ? 50
        : (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50);
    } catch (_) {
    this.SCHEDULED_INPUT_MAX_MESSAGES_PER_SESSION = 50;
    }

    // Session activity tracking (optional config block)
    try {
      const sa = configData.session_activity || {};
      const parseNum = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
      };
      const parseBool = (v, d = false) => {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') {
          const s = v.trim().toLowerCase();
          return s === '1' || s === 'true' || s === 'yes' || s === 'on';
        }
        if (typeof v === 'number') return v !== 0;
        return d;
      };
      // Activity transitions: active immediately on output; inactive after 1s of silence by default
      this.SESSION_ACTIVITY_INACTIVE_AFTER_MS = parseNum(sa.inactive_after_ms, 1000);
      // Minimum bytes written in a contiguous active period before recording an 'active' marker
      this.SESSION_ACTIVITY_MIN_BYTES_FOR_ACTIVE_MARKER = parseNum(sa.min_active_marker_bytes, 32);
      // Suppress activity triggered by output immediately after PTY resize (ms)
      this.SESSION_ACTIVITY_SUPPRESS_AFTER_RESIZE_MS = parseNum(sa.suppress_after_resize_ms, 250);
      // No global monitor; per-session timers handle transitions. Additional keys ignored.
    } catch (_) {
      this.SESSION_ACTIVITY_INACTIVE_AFTER_MS = 1000;
      this.SESSION_ACTIVITY_MIN_BYTES_FOR_ACTIVE_MARKER = 32;
      this.SESSION_ACTIVITY_SUPPRESS_AFTER_RESIZE_MS = 250;
      // No global monitor defaults needed
    }

    // Stop inputs configuration (optional config block)
    try {
      const si = configData.stop_inputs || {};
      const parseNum = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
      };
      this.STOP_INPUTS_GRACE_MS = parseNum(si.grace_ms, 2000);
      this.STOP_INPUTS_REARM_MAX = parseNum(si.rearm_max, 10);
      this.STOP_INPUTS_SESSION_START_GRACE_MS = parseNum(si.session_start_grace_ms, 15000);
    } catch (_) {
      this.STOP_INPUTS_GRACE_MS = 2000;
      this.STOP_INPUTS_REARM_MAX = 10;
      this.STOP_INPUTS_SESSION_START_GRACE_MS = 15000;
    }

    // Uploads configuration (image uploads via API)
    try {
      const uploads = configData.uploads || {};
      const parseNum = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
      };
      // Maximum decoded image size in MB (cap after base64 decoding)
      const envMaxImageMB = process.env.UPLOADS_MAX_IMAGE_MB;
      const cfgMaxImageMB = uploads.max_image_mb;
      const maxImageMB = envMaxImageMB !== undefined && envMaxImageMB !== null
        ? parseNum(envMaxImageMB, 32)
        : parseNum(cfgMaxImageMB, 32);
      this.UPLOADS_MAX_IMAGE_BYTES = maxImageMB * 1024 * 1024;

      // API JSON body limit in MB (raw request size). Default derives from image cap
      // Base64 overhead ~4/3 of decoded size; add small margin for JSON wrapper
      const envJsonLimitMB = process.env.API_JSON_LIMIT_MB;
      const derivedJsonLimit = Math.max(32, Math.ceil(maxImageMB * 4 / 3) + 2);
      this.API_JSON_LIMIT_MB = envJsonLimitMB !== undefined && envJsonLimitMB !== null
        ? parseNum(envJsonLimitMB, derivedJsonLimit)
        : derivedJsonLimit;
    } catch (_) {
      // Safe defaults
      this.UPLOADS_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
      this.API_JSON_LIMIT_MB = 46; // ~32MB decoded -> ~43MB base64 + margin
    }

    // Backend data directory (for mutable runtime data like workspaces)
    this.DATA_DIR = dataDir;
    this.SESSIONS_DIR = join(this.DATA_DIR, 'sessions');

    // Terminated session history view configuration
    try {
      const sh = configData.session_history || {};
      const rawMode = (typeof sh.view_mode === 'string') ? sh.view_mode : 'text';
      const normalizedMode = rawMode.trim().toLowerCase();
      this.TERMINATED_HISTORY_VIEW_MODE = normalizedMode === 'html' ? 'html' : 'text';

      const keepRaw = sh.keep_raw_log;
      this.HISTORY_HTML_KEEP_LOG = (keepRaw === undefined || keepRaw === null) ? true : !!keepRaw;

      const ptyPathRaw = (typeof sh.pty_to_html_path === 'string') ? sh.pty_to_html_path : '';
      this.PTY_TO_HTML_PATH = ptyPathRaw.trim();
    } catch (_) {
      this.TERMINATED_HISTORY_VIEW_MODE = 'text';
      this.HISTORY_HTML_KEEP_LOG = true;
      this.PTY_TO_HTML_PATH = '';
    }

    // Sessions base URLs
    // - SESSIONS_BASE_URL: site/base used for links (often frontend)
    // - SESSIONS_API_BASE_URL: API base (different host/path allowed). If not provided, derive from SESSIONS_BASE_URL + '/api/'.
    this.SESSIONS_BASE_URL = configData.sessions_base_url || '';
    const rawApiBase = configData.sessions_api_base_url || '';
    if (rawApiBase && typeof rawApiBase === 'string') {
      this.SESSIONS_API_BASE_URL = rawApiBase;
    } else {
      // Backward-compat derivation
      try {
        const u = new URL(this.SESSIONS_BASE_URL || 'http://localhost');
        let p = u.pathname || '/';
        if (!p.endsWith('/')) p += '/';
        if (!/\bapi\/$/.test(p)) p += 'api/';
        u.pathname = p;
        this.SESSIONS_API_BASE_URL = u.toString();
      } catch (_) {
        this.SESSIONS_API_BASE_URL = '';
      }
    }

    // Container-specific API configuration
    // - CONTAINER_SESSIONS_API_BASE_URL: API base URL for container-isolated sessions (e.g., http://host.containers.internal:6624/api/)
    //   If not provided, containers use SESSIONS_API_BASE_URL.
    // - CONTAINER_USE_SOCKET_ADAPTER: When true, bind-mount the Unix socket into containers and use socat to bridge
    //   a local TCP port to the socket. This allows containers to reach the backend via http://127.0.0.1:<port>/api/.
    // - CONTAINER_SOCKET_ADAPTER_PORT: TCP port for the in-container socat adapter (default: 7777)
    this.CONTAINER_SESSIONS_API_BASE_URL = (configData.container_sessions_api_base_url && typeof configData.container_sessions_api_base_url === 'string')
      ? configData.container_sessions_api_base_url
      : '';
    this.CONTAINER_USE_SOCKET_ADAPTER = configData.container_use_socket_adapter === true;
    try {
      const rawPort = configData.container_socket_adapter_port;
      const n = Number(rawPort);
      this.CONTAINER_SOCKET_ADAPTER_PORT = (Number.isFinite(n) && n > 0 && n <= 65535) ? Math.floor(n) : 7777;
    } catch (_) {
      this.CONTAINER_SOCKET_ADAPTER_PORT = 7777;
    }

    // Session access token TTL (seconds) for in-container bootstrap/tunnel usage
    // Default: 0 (no expiration, token valid as long as session is active)
    // Set to > 0 for time-based expiration
    try {
      const st = configData.session_token || {};
      const n = Number(st.ttl_seconds);
      this.SESSION_TOKEN_TTL_SECONDS = (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 0;
    } catch (_) {
      this.SESSION_TOKEN_TTL_SECONDS = 0;
    }

    // Feature flags and service proxy configuration
    try {
      const features = configData.features || {};
      this.PROXY_CONTAINER_SERVICES = (features.proxy_container_services === undefined) ? true : !!features.proxy_container_services;
      this.WORKSPACE_SERVICE_ENABLED = features.workspace_service_enabled === true;
    } catch (_) {
      this.PROXY_CONTAINER_SERVICES = true;
      this.WORKSPACE_SERVICE_ENABLED = false;
    }
    try {
      const proxyCfg = configData.service_proxy || {};
      // Port whitelist removed: all ports allowed (loopback enforced in tunnel manager)
      this.TUNNEL_HELPER_PATH = (typeof proxyCfg.tunnel_helper_path === 'string' && proxyCfg.tunnel_helper_path.trim())
        ? proxyCfg.tunnel_helper_path.trim()
        : '/usr/local/bin/ts-tunnel';
    } catch (_) {
      this.TUNNEL_HELPER_PATH = '/usr/local/bin/ts-tunnel';
    }

    // Parse forge configuration (optional)
    try {
      const rawForges = configData.forges && typeof configData.forges === 'object'
        ? (configData.forges || {})
        : {};
      const forges = {};
      const parseEnabled = (value) => {
        if (value === undefined || value === null) return true;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
          const s = value.trim().toLowerCase();
          if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
          if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
          return true;
        }
        if (typeof value === 'number') return value !== 0;
        return true;
      };
      for (const [name, forge] of Object.entries(rawForges || {})) {
        if (!forge || typeof forge !== 'object') continue;
        const enabled = parseEnabled(forge.enabled);
        if (!enabled) continue;
        forges[name] = forge;
      }
      this.FORGES = forges;
    } catch (_) {
      this.FORGES = {};
    }
    try {
      this.DEFAULT_FORGE = typeof configData.default_forge === 'string'
        ? configData.default_forge.trim()
        : '';
    } catch (_) {
      this.DEFAULT_FORGE = '';
    }
    try {
      if (this.DEFAULT_FORGE && !Object.prototype.hasOwnProperty.call(this.FORGES, this.DEFAULT_FORGE)) {
        console.warn(`[Config] default_forge "${this.DEFAULT_FORGE}" not found in forges`);
      }
      for (const [name, forge] of Object.entries(this.FORGES || {})) {
        if (!forge || typeof forge !== 'object') continue;
        const required = ['type', 'host', 'ssh_url', 'https_url', 'default_protocol'];
        for (const field of required) {
          if (!forge[field]) {
            console.warn(`[Config] forge "${name}" missing required field: ${field}`);
          }
        }
      }
    } catch (_) {
      // Best-effort validation only
    }

    // Template-level variables exposed for placeholder substitution
    // and dynamic option commands (e.g., SCRIPTS_DIR)
    // Also ensure SESSIONS_BASE_URL is available to templates for use in env_vars/links
    const baseTemplateVars = configData.template_vars || {};
    if (!('SESSIONS_BASE_URL' in baseTemplateVars)) baseTemplateVars.SESSIONS_BASE_URL = this.SESSIONS_BASE_URL || '';
    if (!('SESSIONS_API_BASE_URL' in baseTemplateVars)) baseTemplateVars.SESSIONS_API_BASE_URL = this.SESSIONS_API_BASE_URL || '';
    // Expose the resolved config directory for templates as CONFIG_DIR
    if (!('CONFIG_DIR' in baseTemplateVars)) baseTemplateVars.CONFIG_DIR = CONFIG_DIR;
    // Expose DEFAULT_FORGE so templates can reference it directly
    if (!('DEFAULT_FORGE' in baseTemplateVars)) baseTemplateVars.DEFAULT_FORGE = this.DEFAULT_FORGE || '';
    // Expose SCRIPTS_DIR as a built-in pointing at the shared backend scripts directory.
    // This is used by templates and dynamic option commands (e.g., list-branches, chat-to-html).
    // For backward compatibility, an existing lowercase template_vars.scripts_dir override is
    // still honored, but we no longer populate scripts_dir automatically.
    try {
      const backendRoot = __dirname;
      const rawScriptsDir = (() => {
        if (baseTemplateVars.SCRIPTS_DIR) return String(baseTemplateVars.SCRIPTS_DIR);
        if (baseTemplateVars.scripts_dir) return String(baseTemplateVars.scripts_dir);
        return 'scripts';
      })();
      let resolvedScriptsDir = rawScriptsDir;
      if (resolvedScriptsDir && !isAbsolute(resolvedScriptsDir)) {
        resolvedScriptsDir = resolve(backendRoot, resolvedScriptsDir);
      }
      baseTemplateVars.SCRIPTS_DIR = resolvedScriptsDir;
    } catch (_) {
      // Best-effort; if resolution fails, leave any existing values untouched.
    }
    
    // Ntfy.sh integration
    const ntfyConfig = configData.ntfy || {};
    this.NTFY_ENABLED = ntfyConfig.enabled || false;
    this.NTFY_URL = ntfyConfig.url || '';
    this.NTFY_TOPIC = ntfyConfig.topic || '';
    this.NTFY_FRONTEND_URL = ntfyConfig.frontend_url || '';

    // Containers/runtime integration
    // Configurable stop timeout for container runtime (seconds); default 2 when not provided or invalid
    try {
      const rawStopTimeout = process.env.CONTAINER_STOP_TIMEOUT_SECONDS || (configData.containers && configData.containers.stop_timeout_seconds);
      const parsed = Number(rawStopTimeout);
      this.CONTAINER_STOP_TIMEOUT_SECONDS = (Number.isFinite(parsed) && parsed > 0) ? parsed : 2;
    } catch (_) {
      this.CONTAINER_STOP_TIMEOUT_SECONDS = 2;
    }
    const containersCfg = configData.containers || {};
    // Allow environment override; default to 'developer' as requested for rootless Podman
    this.CONTAINER_RUNTIME_USER = process.env.CONTAINER_RUNTIME_USER || containersCfg.runtime_user || 'developer';
    
    // Container runtime selection and binary detection
    const detectRuntimeBin = (name) => {
      try {
        const detected = execSync(`command -v ${name}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
        if (detected) return detected;
      } catch (_) {}
      return name === 'docker' ? '/usr/bin/docker' : '/usr/bin/podman';
    };
    const detectPreferredRuntime = () => {
      // Prefer Docker by default when not configured, otherwise Podman
      try {
        const d = execSync('command -v docker', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
        if (d) return 'docker';
      } catch (_) {}
      try {
        const p = execSync('command -v podman', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
        if (p) return 'podman';
      } catch (_) {}
      return 'docker';
    };
    const runtimeRaw = process.env.CONTAINER_RUNTIME || containersCfg.runtime || '';
    const rt = String(runtimeRaw || '').trim().toLowerCase();
    this.CONTAINER_RUNTIME = (rt === 'docker' || rt === 'podman') ? rt : detectPreferredRuntime();
    this.CONTAINER_RUNTIME_BIN = detectRuntimeBin(this.CONTAINER_RUNTIME);

    // Optional: preserve template env_vars for container login/exec sessions
    // When true, template-defined env_vars are duplicated into the persistent
    // per-session .env file so that attach/exec helpers can restore them when
    // connecting to an existing container. Defaults to false for security.
    try {
      this.CONTAINER_PRESERVE_TEMPLATE_ENV_VARS_FOR_LOGIN =
        containersCfg.preserve_template_env_vars_for_login === true;
    } catch (_) {
      this.CONTAINER_PRESERVE_TEMPLATE_ENV_VARS_FOR_LOGIN = false;
    }

    // Optional: map backend UID/GID into the container and keep host groups (podman)
    // Default true for backward compatibility; set containers.map_user=false to disable
    try {
      this.CONTAINER_MAP_USER = (containersCfg.map_user === undefined) ? true : !!containersCfg.map_user;
    } catch (_) { this.CONTAINER_MAP_USER = true; }

    // Optional container add-host entries (e.g., ["gitlab:10.89.1.2"]) applied to all sandbox runs
    try {
      const addHosts = containersCfg.add_hosts;
      this.CONTAINER_ADD_HOSTS = Array.isArray(addHosts)
        ? addHosts.map(x => String(x).trim()).filter(x => x.length > 0)
        : [];
    } catch (_) {
      this.CONTAINER_ADD_HOSTS = [];
    }

    // Finalize template variables with runtime info
    baseTemplateVars.CONTAINER_RUNTIME = baseTemplateVars.CONTAINER_RUNTIME || this.CONTAINER_RUNTIME;
    baseTemplateVars.RUNTIME_BIN = baseTemplateVars.RUNTIME_BIN || this.CONTAINER_RUNTIME_BIN;
    this.TEMPLATE_VARS = baseTemplateVars;
  }
}

// Recursively walk the parsed config JSON object and expand simple
// shell-style environment placeholders in all string values.
// Currently this is primarily used to support $HOME interpolation
// in backend config.json, but it also respects other environment
// variables when present.
function interpolateEnvInConfig(root) {
  if (!root || typeof root !== 'object') return;

  const seen = new Set();
  const homeDir = process.env.HOME || homedir() || '';

  const expandString = (value) => {
    if (typeof value !== 'string') return value;
    if (!value.includes('$')) return value;
    return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
      const key = braced || bare;
      if (!key) return '';
      if (key === 'HOME') return homeDir;
      const envVal = process.env[key];
      return envVal == null ? '' : String(envVal);
    });
  };

  const recur = (node) => {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') {
      return expandString(node);
    }
    if (typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        node[i] = recur(node[i]);
      }
      return node;
    }

    for (const [k, v] of Object.entries(node)) {
      node[k] = recur(v);
    }
    return node;
  };

  recur(root);
}

// Determine config directory from TERMSTATION_CONFIG_DIR (absolute path).
// No fallback to legacy env-based locations.
const CONFIG_DIR = (() => {
  // Default to current working directory when env var not set
  let dir = process.env.TERMSTATION_CONFIG_DIR || process.cwd();
  // Normalize to absolute path
  if (!isAbsolute(dir)) dir = resolve(process.cwd(), dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Config directory does not exist or is not a directory: '${dir}'. Set TERMSTATION_CONFIG_DIR to an absolute directory.`);
  }
  return dir;
})();

// Resolve a config file path relative to TERMSTATION_CONFIG_DIR.
export function resolveConfigPath(name) {
  return join(CONFIG_DIR, name);
}

// Load and parse a JSON file at an absolute path (no indirection/includes).
export function loadJsonAt(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to load JSON at ${filePath}: ${e.message}`);
  }
}

export function loadJson(name) { return loadJsonAt(resolveConfigPath(name)); }

export function loadConfig() {
  const configFile = join(CONFIG_DIR, 'config.json');
  try {
    const configData = JSON.parse(readFileSync(configFile, 'utf8'));
    return new Config(configData);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Configuration file not found: ${configFile}`);
    }
    throw new Error(`Failed to load configuration: ${error.message}`);
  }
}

// Load the default config
export const config = loadConfig();

// Export the environment directory actually used (for other loaders)
export const CONFIG_ENV_DIR = CONFIG_DIR;

// Identity state file locations under the backend data directory.
export const USERS_STATE_FILE = join(config.DATA_DIR, 'users.json');
export const GROUPS_STATE_FILE = join(config.DATA_DIR, 'groups.json');
