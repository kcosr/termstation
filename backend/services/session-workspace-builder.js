/**
 * Session Workspace Builder
 * Materializes a per-session workspace on the host for both directory and container isolation modes.
 * Layout:
 *   <SESSIONS_DIR>/<session-id>/workspace/
 *     .bootstrap/scripts/{pre.sh,main.sh,post.sh,run.sh}
 *     .bootstrap/bin/ts-tunnel.js (optional)
 *     <write_files> (applied relative to workspace/)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { config } from '../config-loader.js';
import { processText } from '../utils/template-text.js';
import { copyDirRecursiveSync } from '../utils/fs-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function resolveSessionsDir() {
  return path.isAbsolute(config.SESSIONS_DIR)
    ? config.SESSIONS_DIR
    : path.join(process.cwd(), config.SESSIONS_DIR);
}

export function resolveSessionWorkspaceHostPath(sessionId) {
  const base = resolveSessionsDir();
  return path.join(base, String(sessionId), 'workspace');
}

function resolveSource(p, templateVars = {}) {
  if (!p || typeof p !== 'string') return null;

  // First interpolate template variables (e.g., {CONFIG_DIR})
  let s = processText(String(p).trim(), templateVars, { baseDirs: [path.join(__dirname, '..')] });

  // $HOME-only expansion for sources. Other forms (${HOME}, ~) are not supported.
  const homeDir = String(process.env.HOME || os.homedir() || '').trim();
  if (homeDir) {
    if (s === '$HOME') {
      s = homeDir;
    } else if (s.startsWith('$HOME/')) {
      s = homeDir.replace(/\/?$/, '/') + s.slice(6);
    }
  }

  if (path.isAbsolute(s)) {
    try { fs.statSync(s); return s; } catch (_) { return null; }
  }
  const candidates = [path.join(__dirname, '..', s), path.join(process.cwd(), s)];
  for (const c of candidates) {
    try { fs.statSync(c); return c; } catch (_) {}
  }
  return null;
}

function normalizeTargetRelative(target) {
  let t = String(target || '').trim();
  // $HOME-only: strip $HOME/ so targets are workspace-relative in directory mode
  if (t === '$HOME') {
    t = '';
  } else if (t.startsWith('$HOME/')) {
    t = t.slice(6);
  }
  // Also strip container workspace prefix to keep behavior consistent across modes
  t = t.replace(/^\/workspace\//, '');
  // Strip leading slash to force workspace-relative
  t = t.replace(/^\/+/, '');
  return t;
}

function safeJoin(baseDir, targetRelative) {
  // Normalize and ensure no traversal escapes the baseDir
  const rel = normalizeTargetRelative(targetRelative);
  const joined = path.join(baseDir, rel);
  const normalized = path.normalize(joined);
  const baseNorm = path.normalize(baseDir + path.sep);
  if (!normalized.startsWith(baseNorm)) {
    throw new Error(`Traversal outside workspace rejected: ${targetRelative}`);
  }
  return normalized;
}

function injectUppercaseSystemMacros(vars) {
  try {
    if (!vars || typeof vars !== 'object') return vars;
    const ensureUpper = (lower, upper) => {
      if (Object.prototype.hasOwnProperty.call(vars, lower) && vars[upper] === undefined) {
        vars[upper] = vars[lower];
      }
    };
    ensureUpper('session_id', 'SESSION_ID');
    ensureUpper('session_token', 'SESSION_TOK');
    ensureUpper('session_title', 'SESSION_TITLE');
    ensureUpper('session_workspace_dir', 'SESSION_WORKSPACE_DIR');
    ensureUpper('bootstrap_dir', 'BOOTSTRAP_DIR');
  } catch (_) { /* non-fatal */ }
  return vars;
}

export async function buildSessionWorkspace({ sessionId, template, variables }) {
  const base = resolveSessionsDir();
  const wsRoot = path.join(base, String(sessionId), 'workspace');
  const bootstrapDir = path.join(wsRoot, '.bootstrap');
  const scriptsDir = path.join(bootstrapDir, 'scripts');
  const binDir = path.join(bootstrapDir, 'bin');
  ensureDir(wsRoot);
  ensureDir(scriptsDir);
  ensureDir(binDir);

  // Apply write_files (workspace-relative)
  try {
    if (Array.isArray(template.write_files)) {
      const mergedVars = injectUppercaseSystemMacros({ ...(config?.TEMPLATE_VARS || {}), ...(variables || {}) });
      let idx = 0;
      for (const item of template.write_files) {
        if (!item || (!item.source && !item.content) || !item.target) continue;
        try {
          // Normalize targets like ${HOME}/... or ~/... to workspace-relative
          const dest = safeJoin(wsRoot, String(item.target));
          ensureDir(path.dirname(dest));
          if (item.content !== undefined) {
            const shouldInterpolate = item.interpolate === true;
            const raw = String(item.content ?? '');
            const text = shouldInterpolate
              ? processText(raw, mergedVars, { baseDirs: [path.join(__dirname, '..')] })
              : raw;
            await fs.promises.writeFile(dest, text, 'utf8');
            console.log(`[workspace] Copied content to ${dest}`);
          } else if (item.source) {
            const sourceStr = String(item.source);
            const resolved = resolveSource(sourceStr, mergedVars);
            if (!resolved) {
              console.error(`[workspace] Failed to resolve source: ${sourceStr} (interpolated: ${processText(sourceStr, mergedVars, { baseDirs: [path.join(__dirname, '..')] })})`);
              continue;
            }
            const st = fs.statSync(resolved);
            if (st && st.isDirectory()) {
              // Directories are copied as-is (no interpolation)
              copyDirRecursiveSync(resolved, dest);
              console.log(`[workspace] Copied directory ${resolved} -> ${dest}`);
            } else {
              // Files: optionally interpolate content when explicitly requested
              const shouldInterpolate = item.interpolate === true;
              if (shouldInterpolate) {
                try {
                  const raw = fs.readFileSync(resolved, 'utf8');
                  // Allow includes to resolve relative to backend root and the source file directory
                  const baseDirs = [path.join(__dirname, '..'), path.dirname(resolved)];
                  const out = processText(String(raw || ''), mergedVars, { baseDirs });
                  await fs.promises.writeFile(dest, out, 'utf8');
                  console.log(`[workspace] Copied and interpolated file ${resolved} -> ${dest}`);
                } catch (err) {
                  // Fallback to raw copy on interpolation failure
                  try {
                    await fs.promises.copyFile(resolved, dest);
                    console.log(`[workspace] Copied file ${resolved} -> ${dest} (interpolation failed, used raw copy)`);
                  } catch (copyErr) {
                    console.error(`[workspace] Failed to copy file ${resolved} -> ${dest}: ${copyErr.message}`);
                  }
                }
              } else {
                await fs.promises.copyFile(resolved, dest);
                console.log(`[workspace] Copied file ${resolved} -> ${dest}`);
              }
            }
          }
          if (item.mode) {
            try {
              await fs.promises.chmod(dest, String(item.mode));
            } catch (err) {
              console.error(`[workspace] Failed to set mode ${item.mode} on ${dest}: ${err.message}`);
            }
          }
          if (item.owner) {
            try {
              await fs.promises.chown(dest, Number(String(item.owner).split(':')[0]), Number(String(item.owner).split(':')[1] || 0));
            } catch (err) {
              console.error(`[workspace] Failed to set owner ${item.owner} on ${dest}: ${err.message}`);
            }
          }
        } catch (err) {
          console.error(`[workspace] Error processing write_files entry ${idx}: ${err.message}`);
        }
        idx++;
      }
    }
  } catch (err) {
    console.error(`[workspace] Error in write_files processing: ${err.message}`);
  }

  // Build orchestrator scripts
  const mergedTextVars = injectUppercaseSystemMacros({ ...(config?.TEMPLATE_VARS || {}), ...(variables || {}) });
  const preLines = Array.isArray(template.pre_commands)
    ? template.pre_commands.map(line => processText(String(line || ''), mergedTextVars, { baseDirs: [path.join(__dirname, '..')] })).filter(Boolean)
    : [];
  // After pre_commands, optionally expand in-place {file:...} markers in configured files
  if (Array.isArray(template.expand_file_includes) && template.expand_file_includes.length > 0) {
    for (const entry of template.expand_file_includes) {
      if (!entry) continue;
      const rawPath = typeof entry === 'string' ? entry : String(entry.target || '');
      if (!rawPath) continue;
      const processedPath = processText(String(rawPath || ''), mergedTextVars, { baseDirs: [path.join(__dirname, '..')] });
      if (!processedPath) continue;
      const escaped = String(processedPath).replace(/\"/g, '\\"');
      preLines.push(`"$BOOTSTRAP_DIR/bin/file-include.sh" "${escaped}"`);
    }
  }
  const postLines = Array.isArray(template.post_commands)
    ? template.post_commands.map(line => processText(String(line || ''), mergedTextVars, { baseDirs: [path.join(__dirname, '..')] })).filter(Boolean)
    : [];
  const mainCmd = processText(String(template.command || ''), mergedTextVars, { baseDirs: [path.join(__dirname, '..')] });

  const preSh = preLines.length ? ['#!/usr/bin/env bash', 'set -euo pipefail', ...preLines].join('\n') + '\n' : null;
  const postSh = postLines.length ? ['#!/usr/bin/env bash', 'set -euo pipefail', ...postLines].join('\n') + '\n' : null;
  const mainSh = ['#!/usr/bin/env bash', String(mainCmd)].join('\n') + '\n';

  if (preSh) {
    const p = path.join(scriptsDir, 'pre.sh');
    await fs.promises.writeFile(p, preSh, 'utf8');
    try { fs.chmodSync(p, 0o755); } catch (_) {}
  }
  if (postSh) {
    const p = path.join(scriptsDir, 'post.sh');
    await fs.promises.writeFile(p, postSh, 'utf8');
    try { fs.chmodSync(p, 0o755); } catch (_) {}
  }
  {
    const p = path.join(scriptsDir, 'main.sh');
    await fs.promises.writeFile(p, mainSh, 'utf8');
    try { fs.chmodSync(p, 0o755); } catch (_) {}
  }

  // Build run.sh (unified for host and container)
  // Split env vars into system (persistent) and custom (ephemeral)

  // Detect container sessions: prefer explicit flag, fall back to workspace path heuristic
  const isContainer = variables?._is_container_session === true ||
    String(variables?.session_workspace_dir || '').trim() === '/workspace';

  // Determine the appropriate SESSIONS_API_BASE_URL for this session
  let effectiveApiBaseUrl = String(config.SESSIONS_API_BASE_URL || '');
  let useSocketAdapter = false;
  const socketAdapterPort = String(config.CONTAINER_SOCKET_ADAPTER_PORT || 7777);

  if (isContainer && process.platform !== 'win32') {
    if (config.CONTAINER_USE_SOCKET_ADAPTER && config.LOCAL_UNIX_SOCKET_PATH) {
      // Socket adapter mode: use local socat bridge
      useSocketAdapter = true;
      let apiPrefix = '/api/';
      try {
        const u = new URL(effectiveApiBaseUrl);
        apiPrefix = u.pathname || '/api/';
      } catch (_) {}
      if (!apiPrefix) apiPrefix = '/';
      if (!apiPrefix.startsWith('/')) apiPrefix = '/' + apiPrefix;
      if (!apiPrefix.endsWith('/')) apiPrefix = apiPrefix + '/';
      effectiveApiBaseUrl = `http://127.0.0.1:${socketAdapterPort}${apiPrefix}`;
    } else if (config.CONTAINER_SESSIONS_API_BASE_URL) {
      // Container-specific URL configured (e.g., host.containers.internal)
      effectiveApiBaseUrl = config.CONTAINER_SESSIONS_API_BASE_URL;
    }
  }

  const systemEnvMap = {
    SESSION_ID: String(sessionId),
    TERMSTATION_USER: String(variables?._login_user || variables?._default_username || ''),
    SESSIONS_BASE_URL: String(config.SESSIONS_BASE_URL || ''),
    SESSIONS_API_BASE_URL: effectiveApiBaseUrl
  };
  if (variables?.session_token) systemEnvMap.SESSION_TOK = String(variables.session_token);
  if (variables?.session_workspace_dir) systemEnvMap.SESSION_WORKSPACE_DIR = String(variables.session_workspace_dir);

  // When using socket adapter, expose socket path and port for socat
  if (useSocketAdapter) {
    systemEnvMap.TERMSTATION_API_SOCKET = '/workspace/.bootstrap/api.sock';
    systemEnvMap.TERMSTATION_API_PORT = socketAdapterPort;
  }
  // Custom env vars from template (ephemeral - deleted after initial source)
  const customEnvMap = {};
  if (template.env_vars && typeof template.env_vars === 'object') {
    for (const [k, v] of Object.entries(template.env_vars)) {
      const value = processText(String(v ?? ''), mergedTextVars, { baseDirs: [path.join(__dirname, '..')] });
      if (value) customEnvMap[k] = value;
    }
  }
  // Persistent env map used for .env (system vars plus optional custom vars).
  // Custom env vars are only duplicated into .env for container sessions when
  // explicitly enabled via config (preserve_template_env_vars_for_login).
  const persistentEnvMap = { ...systemEnvMap };
  try {
    if (isContainer && config.CONTAINER_PRESERVE_TEMPLATE_ENV_VARS_FOR_LOGIN === true) {
      for (const [k, v] of Object.entries(customEnvMap)) {
        persistentEnvMap[k] = v;
      }
    }
  } catch (_) {
    // Fallback: leave persistent map as system-only
  }

  const lines = [];
  lines.push('#!/usr/bin/env bash');
  lines.push('set -euo pipefail');
  // Resolve paths based on the location of this script
  lines.push('BOOTSTRAP_DIR="$(cd "$(dirname "$0")/.." && pwd)"');
  lines.push('WS_DIR="$(cd "$BOOTSTRAP_DIR/.." && pwd)"');
  lines.push('BIN_DIR="$BOOTSTRAP_DIR/bin"');
  // Expose bootstrap base directory explicitly for convenience
  lines.push('export BOOTSTRAP_DIR');
  // Make system-provided bootstrap tools available in PATH (append)
  lines.push('export PATH="$PATH:$BIN_DIR"');
  // In-container TCP -> UDS adapter using socat (required when TERMSTATION_API_SOCKET is set)
  lines.push('UDS_ADAPTER_PID=""');
  lines.push('cleanup_uds_adapter() {');
  lines.push('  if [[ -n "$UDS_ADAPTER_PID" ]]; then');
  lines.push('    kill "$UDS_ADAPTER_PID" 2>/dev/null || true');
  lines.push('    wait "$UDS_ADAPTER_PID" 2>/dev/null || true');
  lines.push('  fi');
  lines.push('}');
  lines.push('trap cleanup_uds_adapter EXIT');
  lines.push('start_uds_adapter() {');
  lines.push('  local sock="${TERMSTATION_API_SOCKET:-}"');
  lines.push(`  local port="\${TERMSTATION_API_PORT:-${socketAdapterPort}}"`);
  lines.push('  if [[ -z "$sock" ]]; then return 0; fi');
  lines.push('  if [[ ! -S "$sock" ]]; then echo "[uds-adapter] FATAL: socket not found at $sock" >&2; exit 1; fi');
  lines.push('  if ! command -v socat &>/dev/null; then echo "[uds-adapter] FATAL: socat not found (required for socket adapter)" >&2; exit 1; fi');
  lines.push('  echo "[uds-adapter] bridging http://127.0.0.1:${port} -> $sock"');
  lines.push('  socat TCP-LISTEN:${port},fork,reuseaddr UNIX-CONNECT:${sock} &>/dev/null &');
  lines.push('  UDS_ADAPTER_PID=$!');
  lines.push('}');
  // Ensure we operate from the workspace and HOME points to workspace
  lines.push('cd "$WS_DIR"');
  lines.push('export HOME="$WS_DIR"');
  // Expose a generic WORKSPACE_DIR pointing at the effective workspace path
  lines.push('if [ -n "${SESSION_WORKSPACE_DIR:-}" ]; then');
  lines.push('  export WORKSPACE_DIR="$SESSION_WORKSPACE_DIR"');
  lines.push('else');
  lines.push('  export WORKSPACE_DIR="$WS_DIR"');
  lines.push('fi');
  // Source persistent .env file (TermStation system env vars - kept for login sessions)
  lines.push('ENV_FILE="$BOOTSTRAP_DIR/scripts/.env"');
  lines.push('if [ -f "$ENV_FILE" ]; then');
  lines.push('  set -a');
  lines.push('  . "$ENV_FILE"');
  lines.push('  set +a');
  lines.push('fi');
  // Source and delete ephemeral .env.custom file (template custom env_vars - sensitive)
  lines.push('CUSTOM_ENV_FILE="$BOOTSTRAP_DIR/scripts/.env.custom"');
  lines.push('if [ -f "$CUSTOM_ENV_FILE" ]; then');
  lines.push('  set -a');
  lines.push('  . "$CUSTOM_ENV_FILE"');
  lines.push('  set +a');
  lines.push('  rm -f "$CUSTOM_ENV_FILE"');
  lines.push('fi');
  // Start the UDS adapter when TERMSTATION_API_SOCKET is configured.
  lines.push('start_uds_adapter');
  // Tunnel helper (optional)
  lines.push('if [ -n "${SESSION_TOK:-}" ]; then');
  lines.push('  TUNNEL_BIN="$BIN_DIR/ts-tunnel.js"');
  lines.push('  if [ -x "$TUNNEL_BIN" ]; then');
  lines.push('    ("$TUNNEL_BIN" --session "$SESSION_ID" --api "$SESSIONS_API_BASE_URL" >"$BOOTSTRAP_DIR/ts-tunnel.log" 2>&1 &) || true');
  lines.push('  fi');
  lines.push('fi');
  // pre -> main -> post
  lines.push('[ -x "$BOOTSTRAP_DIR/scripts/pre.sh" ] && "$BOOTSTRAP_DIR/scripts/pre.sh" || true');
  lines.push('"$BOOTSTRAP_DIR/scripts/main.sh"');
  lines.push('[ -x "$BOOTSTRAP_DIR/scripts/post.sh" ] && "$BOOTSTRAP_DIR/scripts/post.sh" || true');

  const runSh = lines.join('\n') + '\n';
  {
    const p = path.join(scriptsDir, 'run.sh');
    await fs.promises.writeFile(p, runSh, 'utf8');
    try { fs.chmodSync(p, 0o755); } catch (_) {}
  }

  // Write persistent .env file with TermStation system env vars
  // This file is kept for login sessions (sourced by buildExecCommandForShell)
  {
    const envLines = [];
    for (const [k, v] of Object.entries(persistentEnvMap)) {
      const vv = String(v ?? '').replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
      envLines.push(`${k}="${vv}"`);
    }
    const p = path.join(scriptsDir, '.env');
    await fs.promises.writeFile(p, envLines.join('\n') + '\n', 'utf8');
    try { fs.chmodSync(p, 0o644); } catch (_) {}  // readable for login sessions
  }
  // Write ephemeral .env.custom file with template custom env_vars (if any)
  // This file is sourced and immediately deleted by run.sh for security
  if (Object.keys(customEnvMap).length > 0) {
    const customEnvLines = [];
    for (const [k, v] of Object.entries(customEnvMap)) {
      const vv = String(v ?? '').replace(/\\/g, '\\\\').replace(/\"/g, '\\"');
      customEnvLines.push(`${k}="${vv}"`);
    }
    const p = path.join(scriptsDir, '.env.custom');
    await fs.promises.writeFile(p, customEnvLines.join('\n') + '\n', 'utf8');
    try { fs.chmodSync(p, 0o600); } catch (_) {}  // restrictive permissions
  }

  // No profile fallback is generated; env and PATH are injected by run.sh (main)
  // and via exec wrapper for attach/login shells.

  // Copy backend-managed bootstrap tools (if available) into the session bin dir
  try {
    const toolsSrc = path.join(__dirname, '..', 'bootstrap', 'bin');
    const st = fs.statSync(toolsSrc);
    if (st && st.isDirectory()) {
      copyDirRecursiveSync(toolsSrc, binDir);
      // Ensure scripts in bin are executable
      try {
        const entries = fs.readdirSync(binDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent || !ent.isFile()) continue;
          if (/\.sh$/i.test(ent.name)) {
            try { fs.chmodSync(path.join(binDir, ent.name), 0o755); } catch (_) {}
          }
        }
      } catch (_) { /* best-effort */ }
    }
  } catch (_) { /* optional */ }

  // No external/system helper staging. ts-tunnel.js is provided via backend/bootstrap/bin copy.


  return { workspaceDir: wsRoot, scriptsDir };
}
