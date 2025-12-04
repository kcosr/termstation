import * as fs from 'fs';
import * as path from 'path';

function readMountInfoLines() {
  try {
    const override = process.env.TERMSTATION_WORKSPACE_MOUNTINFO_OVERRIDE;
    if (override && typeof override === 'string') {
      return override.split('\n').map((l) => l.trim()).filter(Boolean);
    }
  } catch (_) {
    // Ignore override errors and fall back to /proc
  }

  try {
    const txt = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    return txt.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Create a classifier function that returns the bind mount mode ("rw" | "ro")
 * for workspace-relative paths, based on the template's bind_mounts array.
 *
 * This is the preferred method for backend-hosted workspace APIs since the
 * backend runs on the host and cannot see container mount namespaces via
 * /proc/self/mountinfo.
 *
 * @param {Array<{container_path?: string, containerPath?: string, readonly?: boolean}>} bindMounts
 *   Array of bind mount definitions from the template
 * @returns {(containerPath: string) => ('rw' | 'ro' | null)}
 */
export function createBindMountClassifierFromTemplate(bindMounts) {
  if (!Array.isArray(bindMounts) || bindMounts.length === 0) {
    return () => null;
  }

  const sep = path.sep;
  const mounts = [];

  for (const m of bindMounts) {
    if (!m) continue;
    const containerPathRaw = m.container_path || m.containerPath;
    if (typeof containerPathRaw !== 'string' || !containerPathRaw.trim()) continue;

    // Normalize container path (e.g., /workspace/.cargo)
    let containerPath;
    try {
      containerPath = path.posix.normalize(containerPathRaw.trim());
      // Ensure leading slash for consistent matching
      if (!containerPath.startsWith('/')) containerPath = '/' + containerPath;
    } catch (_) {
      continue;
    }

    // Determine mode: readonly === true means 'ro', otherwise 'rw'
    const mode = m.readonly === true ? 'ro' : 'rw';

    mounts.push({ containerPath, mode });
  }

  if (!mounts.length) {
    return () => null;
  }

  // Sort longest paths first so the most specific bind wins
  mounts.sort((a, b) => b.containerPath.length - a.containerPath.length);

  return (inputPath) => {
    if (!inputPath) return null;

    // Normalize input path to match container path format
    let p;
    try {
      p = path.posix.normalize(String(inputPath));
      if (!p.startsWith('/')) p = '/' + p;
    } catch (_) {
      return null;
    }

    for (const m of mounts) {
      // Exact match or path is under the mount point
      if (p === m.containerPath || p.startsWith(m.containerPath + '/')) {
        return m.mode;
      }
    }
    return null;
  };
}

/**
 * Create a classifier function that returns the bind mount mode ("rw" | "ro")
 * for absolute paths under the given root, based on /proc/self/mountinfo.
 *
 * Only sub-mounts beneath the root are considered; the root mount itself is
 * not treated as a bind mount for classification purposes.
 *
 * When no relevant mounts are found or mountinfo is unavailable, the returned
 * function always yields null.
 *
 * @param {string} root - Absolute workspace root path
 * @returns {(fullPath: string) => ('rw' | 'ro' | null)}
 * @deprecated Use createBindMountClassifierFromTemplate for backend-hosted APIs
 */
export function createBindMountClassifier(root) {
  let rootPath;
  try {
    rootPath = path.resolve(root || '/');
  } catch (_) {
    rootPath = '/';
  }
  const sep = path.sep;
  const lines = readMountInfoLines();
  if (!lines.length) {
    return () => null;
  }

  const mounts = [];

  for (const line of lines) {
    if (!line) continue;
    const dashIdx = line.indexOf(' - ');
    const pre = dashIdx === -1 ? line : line.slice(0, dashIdx);
    const preParts = pre.trim().split(/\s+/);
    if (preParts.length < 6) continue;

    const mountPointRaw = preParts[4];
    const optsRaw = preParts[5] || '';
    if (!mountPointRaw) continue;

    let mp;
    try {
      mp = path.resolve(mountPointRaw);
    } catch (_) {
      continue;
    }

    // Only consider mounts that live under the workspace root; skip the root itself.
    if (!mp.startsWith(rootPath + sep)) continue;

    let mode = null;
    const optsList = String(optsRaw).split(',');
    if (optsList.includes('ro')) {
      mode = 'ro';
    } else if (optsList.includes('rw')) {
      mode = 'rw';
    }

    // Fallback to super options (after " - ") when needed.
    if (!mode && dashIdx !== -1) {
      const tail = line.slice(dashIdx + 3).trim();
      const tailParts = tail.split(/\s+/);
      if (tailParts.length >= 3) {
        const superOpts = tailParts[2] || '';
        const superList = String(superOpts).split(',');
        if (superList.includes('ro')) {
          mode = 'ro';
        } else if (superList.includes('rw')) {
          mode = 'rw';
        }
      }
    }

    mounts.push({ mountPoint: mp, mode });
  }

  if (!mounts.length) {
    return () => null;
  }

  // Sort longest mount points first so the most specific bind wins.
  mounts.sort((a, b) => b.mountPoint.length - a.mountPoint.length);

  return (fullPath) => {
    if (!fullPath) return null;
    let p;
    try {
      p = path.resolve(fullPath);
    } catch (_) {
      return null;
    }
    for (const m of mounts) {
      if (p === m.mountPoint || p.startsWith(m.mountPoint + sep)) {
        return m.mode || null;
      }
    }
    return null;
  };
}

