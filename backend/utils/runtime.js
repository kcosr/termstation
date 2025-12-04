/**
 * Runtime utilities for container engines (podman/docker)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config-loader.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

export function getRuntimeName() {
  return String(config.CONTAINER_RUNTIME || 'podman');
}

export function getRuntimeBin() {
  return String(config.CONTAINER_RUNTIME_BIN || 'podman');
}

export function isPodman() {
  return getRuntimeName() === 'podman';
}

export function supportsReplace() {
  // podman supports --replace on run; docker does not
  return isPodman();
}

export function volumeMountSuffix() {
  // SELinux relabel is :Z on podman; omit for docker to avoid incompatibilities
  return isPodman() ? ':Z' : '';
}

// Parse docker label string "k=v,foo=bar" -> { k: 'v', foo: 'bar' }
function parseDockerLabelsString(s) {
  const out = {};
  if (!s || typeof s !== 'string') return out;
  for (const part of s.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// Return normalized container list across runtimes
export async function listContainersNormalized(includeAll = false, user = null) {
  const bin = getRuntimeBin();
  const name = getRuntimeName();

  if (name === 'podman') {
    const args = ['ps'];
    if (includeAll) args.push('--all');
    args.push('--format', 'json');
    const { stdout } = await execFileAsync(bin, args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
    const parsed = stdout ? JSON.parse(stdout) : [];
    const list = Array.isArray(parsed) ? parsed : [];
    return list.map((c) => ({
      id: c.Id || c.ID || c.IdFull || null,
      name: Array.isArray(c.Names) ? c.Names[0] : (c.Names || c.Name || null),
      image: c.Image || c.ImageName || null,
      status: c.Status || c.State || null,
      created: c.Created || c.CreatedAt || null,
      ports: c.Ports || c.Port || null,
      labels: c.Labels || {},
      raw: c
    }));
  }

  // docker
  const args = ['ps'];
  if (includeAll) args.push('--all');
  args.push('--format', '{{json .}}');
  const { stdout } = await execFileAsync(bin, args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
  const lines = String(stdout || '').split('\n').filter(Boolean);
  const items = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const labels = parseDockerLabelsString(obj.Labels || '');
      items.push({
        id: obj.ID || null,
        name: obj.Names || obj.Name || null,
        image: obj.Image || null,
        status: obj.Status || null,
        created: obj.CreatedAt || obj.RunningFor || null,
        ports: obj.Ports || null,
        labels,
        raw: obj
      });
    } catch (_) {
      // skip bad line
    }
  }
  return items;
}

export function buildExecCommandForShell(containerName, shell = 'bash', user = null) {
  const bin = getRuntimeBin();
  // Inline script executed inside the container via sh -c.
  // - Source persistent .env for TermStation system environment variables
  // - Preserve existing PATH; append workspace tools
  // - Prefer absolute paths for shells to avoid PATH resolution issues
  // - Prefer bash when available; fallback to sh
  const inlineScript = 'BOOTSTRAP_DIR="/workspace/.bootstrap"; export BOOTSTRAP_DIR; ' +
    'ENV_FILE="$BOOTSTRAP_DIR/scripts/.env"; ' +
    'if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi; ' +
    'PATH="${PATH:+$PATH:}$BOOTSTRAP_DIR/bin"; export PATH; ' +
    'if [ -x /bin/bash ]; then exec /bin/bash -i; ' +
    'elif [ -x /usr/bin/bash ]; then exec /usr/bin/bash -i; ' +
    'elif [ -x /bin/sh ]; then exec /bin/sh -i; ' +
    'elif [ -x /usr/bin/sh ]; then exec /usr/bin/sh -i; ' +
    'else exec sh -i; fi';
  const escaped = inlineScript.replace(/'/g, `'\\''`);
  return `${bin} exec -it ${containerName} sh -c '${escaped}'`;
}

// Build a one-liner exec command inside a running container using bash -lc
// Ensures proper quoting of the provided command string
export function buildExecCommandForCommand(containerName, command, user = null) {
  const bin = getRuntimeBin();
  const cmd = String(command == null ? '' : command);
  // Wrap the provided command to source .env and expose PATH and BOOTSTRAP_DIR consistently
  const wrapper = `export BOOTSTRAP_DIR="/workspace/.bootstrap"; if [ -f "$BOOTSTRAP_DIR/scripts/.env" ]; then set -a; . "$BOOTSTRAP_DIR/scripts/.env"; set +a; fi; export PATH="\${PATH:+$PATH:}$BOOTSTRAP_DIR/bin"; ${cmd}`;
  // Safely single-quote for bash -lc
  const singleQuoted = wrapper.split("'").join("'\"'\"'");
  return `${bin} exec -it ${containerName} bash -lc '${singleQuoted}'`;
}

export async function stopContainer(ref, user = null, timeoutSeconds = config.CONTAINER_STOP_TIMEOUT_SECONDS) {
  const bin = getRuntimeBin();
  const args = ['stop', '-t', String(timeoutSeconds), ref];
  return execFileAsync(bin, args, { timeout: 20_000, maxBuffer: 10 * 1024 * 1024 });
}

// Return normalized list of local images across runtimes
// Each entry: { name, repository, tag, id, size, raw }
export async function listImagesNormalized(user = null) {
  const bin = getRuntimeBin();
  const name = getRuntimeName();

  // Helper to safely build image reference
  const makeRef = (repo, tag) => {
    const r = String(repo || '').trim();
    let t = String(tag || '').trim();
    if (!r) return '';
    if (!t || t === '<none>') t = 'latest';
    return `${r}:${t}`;
  };

  const hasExplicitTagOrDigest = (s) => {
    if (!s) return false;
    const str = String(s);
    if (str.includes('@')) return true; // digest present
    const lastSlash = str.lastIndexOf('/');
    const lastColon = str.lastIndexOf(':');
    return lastColon > lastSlash; // colon after last slash indicates tag
  };
  if (name === 'podman') {
    const args = ['images', '--format', 'json'];
    const { stdout } = await execFileAsync(bin, args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
    const parsed = stdout ? JSON.parse(stdout) : [];
    const list = Array.isArray(parsed) ? parsed : [];
    return list.map((c) => {
      // Prefer full name from Names[0] when available
      const namesRef = Array.isArray(c.Names) && c.Names[0] ? String(c.Names[0]) : '';
      let repo = c.Repository || '';
      let tag = c.Tag || '';
      if (!repo && c.ImageName) repo = c.ImageName;
      let ref = namesRef || '';
      if (!ref && repo) {
        if (hasExplicitTagOrDigest(repo)) ref = repo; else ref = makeRef(repo, tag);
      }
      return {
        name: ref || null,
        repository: repo || null,
        tag: tag || null,
        id: c.Id || c.ID || null,
        size: c.Size || null,
        raw: c
      };
    }).filter(e => e.name);
  }

  // docker
  const args = ['images', '--format', '{{json .}}'];
  const { stdout } = await execFileAsync(bin, args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
  const lines = String(stdout || '').split('\n').filter(Boolean);
  const items = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const repo = obj.Repository || '';
      const tag = obj.Tag || '';
      let ref = '';
      if (repo) {
        ref = hasExplicitTagOrDigest(repo) ? repo : makeRef(repo, tag);
      }
      if (!ref) continue;
      items.push({
        name: ref,
        repository: repo || null,
        tag: tag || null,
        id: obj.ID || null,
        size: obj.Size || null,
        raw: obj
      });
    } catch (_) {
      // skip bad line
    }
  }
  // De-duplicate by ref
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    if (it.name && !seen.has(it.name)) {
      seen.add(it.name);
      unique.push(it);
    }
  }
  return unique;
}

/**
 * Find containers that belong to the provided session IDs.
 * Matching is done primarily via label `session_id` (or `SESSION_ID`) and
 * secondarily via container name pattern `sandbox-<session_id>`.
 * Returns a list of normalized container objects from listContainersNormalized.
 */
export async function findContainersForSessionIds(sessionIds = [], includeAll = false, user = null) {
  const ids = Array.isArray(sessionIds)
    ? sessionIds.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  if (ids.length === 0) return [];

  const runUser = user || config.CONTAINER_RUNTIME_USER || 'developer';
  const list = await listContainersNormalized(includeAll, runUser);
  const idSet = new Set(ids);

  const matches = [];
  for (const c of Array.isArray(list) ? list : []) {
    try {
      const labels = c?.labels || {};
      const sid = labels.session_id || labels.SESSION_ID || '';
      const name = String(c?.name || '');
      if (sid && idSet.has(String(sid))) {
        matches.push(c);
        continue;
      }
      // Fallback: explicit name match (sandbox-<sid>)
      for (const s of idSet) {
        if (name === `sandbox-${s}`) {
          matches.push(c);
          break;
        }
      }
    } catch (_) {
      // best-effort only
    }
  }

  // De-duplicate by name/id
  const seen = new Set();
  const unique = [];
  for (const c of matches) {
    const key = c?.name || c?.id || JSON.stringify(c);
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }
  return unique;
}

/**
 * Stop containers associated with the given session IDs.
 * Returns a summary object: { found, stopped: [refs], failed: [{ref, error}] }
 */
export async function stopContainersForSessionIds(sessionIds = [], options = {}) {
  const user = options.user || config.CONTAINER_RUNTIME_USER || 'developer';
  const timeoutSeconds = Number.isFinite(options.timeoutSeconds) ? options.timeoutSeconds : 10;

  const candidates = await findContainersForSessionIds(sessionIds, /* includeAll */ false, user);
  const targets = [];
  for (const c of candidates) {
    const ref = c?.name || c?.id;
    if (ref) targets.push(ref);
  }

  const stopped = [];
  const failed = [];
  for (const ref of targets) {
    try {
      await stopContainer(ref, user, timeoutSeconds);
      try { logger.info(`[Shutdown] Stopped container '${ref}' for session mapping`); } catch (_) {}
      stopped.push(ref);
    } catch (e) {
      try { logger.error(`[Shutdown] Failed to stop container '${ref}': ${e.message}`); } catch (_) {}
      failed.push({ ref, error: e?.message || String(e) });
    }
  }

  return { found: targets.length, stopped, failed };
}

// Build a full host command to run a container and execute inner commands
// opts: { name, sessionId, image, workingDir, memory, cpus, network, mountHostPath,
//         envAssignments: array of KEY="VAL", pre: [strings], post: [strings], innerCommand: string }
export function buildRunCommand(opts = {}) {
  const bin = getRuntimeBin();
  const name = opts.name || '';
  const sid = opts.sessionId || '';
  const args = [bin, 'run', '-it', '--rm'];

  if (name) args.push('--name', name);
  if (sid) args.push('--label', `session_id=${sid}`);
  if (supportsReplace()) args.push('--replace');

  // Map container user to the backend process user (UID:GID), and keep host groups when supported
  const shouldMapUser = (function decideMapUser() {
    try {
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'mapUser')) return !!opts.mapUser;
      return config.CONTAINER_MAP_USER !== false;
    } catch (_) { return true; }
  })();
  if (shouldMapUser) {
    try {
      const uid = (typeof process.getuid === 'function') ? process.getuid() : null;
      const gid = (typeof process.getgid === 'function') ? process.getgid() : null;
      if (isPodman()) {
        args.push('--userns=keep-id');
        args.push('--group-add', 'keep-groups');
      }
      if (uid !== null && gid !== null) {
        args.push('-u', `${uid}:${gid}`);
      }
    } catch (_) { /* best-effort */ }
  }

  // Configurable host mappings (e.g., ["gitlab:10.89.1.2"]) for both docker and podman
  try {
    const extraHosts = Array.isArray(config.CONTAINER_ADD_HOSTS) ? config.CONTAINER_ADD_HOSTS : [];
    const re = /^[A-Za-z0-9.-]+:[0-9.]+$/; // basic host:ip validation
    for (const h of extraHosts) {
      const s = String(h || '').trim();
      if (!s) continue;
      if (!re.test(s)) {
        try { logger.warning(`Skipping invalid add_host entry: '${s}' (expected host:ip)`); } catch (_) {}
        continue;
      }
      args.push(`--add-host=${s}`);
    }
  } catch (_) {}

  // Mounts (directory mount for shared data)
  if (opts.mountHostPath) {
    const volSuffix = volumeMountSuffix();
    args.push('-v', `${opts.mountHostPath}:/mnt/shared${volSuffix}`);
  }

  // No default hardcoded mounts; callers may pass opts.mountHostPath or opts.fileMounts

  // File mounts: bind specific host files to specific container paths
  try {
    const volSuffixRaw = volumeMountSuffix(); // e.g., ':Z' for podman, '' for docker
    const fileMounts = Array.isArray(opts.fileMounts) ? opts.fileMounts : [];
    for (const m of fileMounts) {
      if (!m || !m.hostPath || !m.containerPath) continue;
      const host = String(m.hostPath).trim();
      const cont = String(m.containerPath).trim();
      if (!host || !cont) continue;
      const optsList = [];
      // SELinux labeling: :Z (private) vs :z (shared)
      // - selinuxShared: true -> use :z for shared access across containers
      // - default -> use :Z for private container access
      if (isPodman()) {
        if (m.selinuxShared) {
          optsList.push('z');
        } else {
          optsList.push('Z');
        }
      }
      if (m.readonly === true) optsList.push('ro');
      const optPart = optsList.length ? `:${optsList.join(',')}` : '';
      args.push('-v', `${host}:${cont}${optPart}`);
    }
  } catch (_) {}

  // Do not use container runtime '-w' working directory; handle via inner script
  if (opts.memory) args.push('--memory', String(opts.memory));
  if (opts.cpus) args.push('--cpus', String(opts.cpus));
  if (opts.network) args.push('--network', String(opts.network));
  // Add container capabilities when requested (e.g., NET_ADMIN)
  try {
    const caps = Array.isArray(opts.capAdd) ? opts.capAdd : [];
    const validCapPattern = /^(?:CAP_)?[A-Z][A-Z0-9_]*$/; // e.g., NET_ADMIN or CAP_NET_ADMIN
    const seen = new Set();
    for (const c of caps) {
      const cap = String(c || '').trim();
      if (!cap) continue;
      if (!validCapPattern.test(cap)) {
        try { logger.warning(`Skipping invalid capability name: '${cap}' (expected format: NET_ADMIN or CAP_NET_ADMIN)`); } catch (_) {}
        continue;
      }
      if (seen.has(cap)) {
        try { logger.debug && logger.debug(`Duplicate capability ignored: '${cap}'`); } catch (_) {}
        continue;
      }
      seen.add(cap);
      args.push(`--cap-add=${cap}`);
    }
  } catch (_) {}

  // Environment variables are now provided via an ephemeral .env file in the
  // bootstrap scripts directory. The run.sh script sources and deletes this
  // file at startup. This avoids exposing secrets in:
  // - docker/podman inspect output (from -e flags)
  // - process list / ps aux (from inline export statements)
  // See: services/session-workspace-builder.js

  // Tmpfs mounts: array of strings or objects { path, options }
  try {
    const listRaw = Array.isArray(opts.tmpfsMounts) ? opts.tmpfsMounts : [];
    for (const m of listRaw) {
      if (!m) continue;
      if (typeof m === 'string') {
        const p = m.trim();
        if (p) args.push('--tmpfs', p);
      } else {
        const p = String(m.path || m.container_path || m.containerPath || '').trim();
        const opt = m.options ? String(m.options).trim() : '';
        if (!p) continue;
        const spec = opt ? `${p}:${opt}` : p;
        args.push('--tmpfs', spec);
      }
    }
  } catch (_) {}

  args.push(opts.image || '');

  // Build inner bash script
  const escapeForDoubleQuotes = (s) => String(s || '').replace(/"/g, '\\"');
  const parts = [];
  parts.push('set -e');
  // Create and change to working directory inside the container, if specified
  if (opts.workingDir) {
    const wd = String(opts.workingDir);
    parts.push(`${escapeForDoubleQuotes(`mkdir -p ${wd}`)}`);
    parts.push(`${escapeForDoubleQuotes(`cd ${wd}`)}`);
  }
  // Environment variables are sourced from .env file by run.sh, not exported
  // inline here. This avoids exposing secrets in the process list.
  if (Array.isArray(opts.pre)) {
    for (const line of opts.pre) {
      const t = String(line || '').trim();
      if (t) parts.push(`${escapeForDoubleQuotes(t)}`);
    }
  }
  if (opts.innerCommand) {
    parts.push(`${escapeForDoubleQuotes(opts.innerCommand)}`);
  }
  if (Array.isArray(opts.post)) {
    for (const line of opts.post) {
      const t = String(line || '').trim();
      if (t) parts.push(`${escapeForDoubleQuotes(t)}`);
    }
  }
  const bashCmd = parts.join(' && ');
  args.push('bash', '-lc', `"${bashCmd}"`);

  const built = args.join(' ');

  // Host prelude (ensure mount path exists)
  const prelude = [];
  if (opts.mountHostPath) {
    prelude.push(`mkdir -p ${opts.mountHostPath}`);
  }
  if (prelude.length > 0) {
    const hostScript = ['set -e', ...prelude, built].join(' && ');
    const safeHostScript = hostScript.replace(/'/g, `'\\''`);
    return `bash -lc '${safeHostScript}'`;
  }
  return built;
}
