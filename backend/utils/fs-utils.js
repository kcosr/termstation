import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger.js';

export function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}

// Recursively copy directory contents (files, subdirectories, and symlinks when possible)
// - Creates destination directories as needed
// - Overwrites existing files in target
// - Best-effort symlink replication
// - On permission or IO errors for individual entries, logs a warning and continues
export function copyDirRecursiveSync(src, dst) {
  ensureDir(dst);
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (e) {
    try {
      logger.warning(`[FS] copyDirRecursiveSync: failed to read directory '${src}': ${e?.message || e}`);
    } catch (_) {}
    return;
  }

  for (const ent of entries) {
    if (!ent) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      try {
        ensureDir(d);
        copyDirRecursiveSync(s, d);
      } catch (e) {
        try {
          logger.warning(`[FS] copyDirRecursiveSync: failed to copy directory '${s}' -> '${d}': ${e?.message || e}`);
        } catch (_) {}
      }
    } else if (ent.isFile()) {
      try {
        ensureDir(path.dirname(d));
        fs.copyFileSync(s, d);
      } catch (e) {
        try {
          logger.warning(`[FS] copyDirRecursiveSync: failed to copy file '${s}' -> '${d}': ${e?.message || e}`);
        } catch (_) {}
      }
    } else if (ent.isSymbolicLink()) {
      try {
        const linkTarget = fs.readlinkSync(s);
        fs.symlinkSync(linkTarget, d);
      } catch (e) {
        try {
          logger.warning(`[FS] copyDirRecursiveSync: failed to copy symlink '${s}' -> '${d}': ${e?.message || e}`);
        } catch (_) {}
      }
    }
  }
}
