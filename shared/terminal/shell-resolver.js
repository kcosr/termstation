/**
 * Shared terminal shell resolution and argument builders
 *
 * Exports:
 * - resolveDefaultShell(): string
 * - buildInteractiveArgs(shell: string): string[]
 * - buildCommandArgs(shell: string, command: string): string[]
 */

import os from 'os';
import fs from 'fs';
import path from 'path';

const isWin = process.platform === 'win32';

function which(executable) {
  const envPath = process.env.PATH || '';
  const pathExt = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD') : '';
  const exts = isWin ? pathExt.split(';').filter(Boolean) : [''];
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  // If absolute path is provided, check directly
  const tryFile = (filePath) => {
    try {
      const st = fs.statSync(filePath);
      return st.isFile();
    } catch (_) {
      return false;
    }
  };

  if (path.isAbsolute(executable)) {
    if (tryFile(executable)) return executable;
    if (isWin) {
      for (const ext of exts) {
        const fp = executable.endsWith(ext) ? executable : executable + ext;
        if (tryFile(fp)) return fp;
      }
    }
    return null;
  }

  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, executable.endsWith(ext) ? executable : executable + ext);
      if (tryFile(candidate)) return candidate;
    }
    if (!isWin) {
      const candidate = path.join(dir, executable);
      if (tryFile(candidate)) return candidate;
    }
  }
  return null;
}

function getShellFamily(shell) {
  const base = path.basename(String(shell || '')).toLowerCase();
  if (base === 'pwsh' || base === 'pwsh.exe') return 'pwsh';
  if (base === 'powershell' || base === 'powershell.exe') return 'powershell';
  if (base === 'cmd' || base === 'cmd.exe') return 'cmd';
  return 'posix';
}

export function resolveDefaultShell() {
  if (isWin) {
    // Detection order: pwsh.exe -> powershell.exe -> cmd.exe
    if (which('pwsh.exe')) return 'pwsh.exe';
    if (which('powershell.exe')) return 'powershell.exe';
    return 'cmd.exe';
  }
  // macOS/Linux
  const envShell = (process.env.SHELL || '').trim();
  return envShell || '/bin/bash';
}

export function buildInteractiveArgs(shell) {
  if (isWin) {
    const fam = getShellFamily(shell);
    if (fam === 'pwsh' || fam === 'powershell') {
      return ['-NoLogo', '-NoExit'];
    }
    return ['/K']; // cmd.exe
  }
  // POSIX
  return ['-l']; // login shell; interactive implied under PTY
}

export function
buildCommandArgs(shell, command) {
  if (isWin) {
    const fam = getShellFamily(shell);
    if (fam === 'pwsh' || fam === 'powershell') {
      return ['-Command', String(command ?? '')];
    }
    return ['/c', String(command ?? '')]; // cmd.exe
  }
  // POSIX
  return ['-lc', String(command ?? '')];
}

// Note: Callers should ensure environment defaults like TERM=xterm-256color
// and COLORTERM=truecolor are set when spawning terminals.

