const { app, BrowserWindow, Menu, shell, ipcMain, dialog, screen, session, nativeTheme, protocol } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');
const { createServer, request: httpRequest } = require('http');
const net = require('net');
const fs = require('fs');
const url = require('url');
const persistence = require('./persistence');
const os = require('os');
const crypto = require('crypto');

// Optional verbose logging for the desktop API proxy (HTTP/WS);
// enable by setting DESKTOP_API_PROXY_DEBUG=1 in the environment.
const PROXY_DEBUG = (() => {
  try {
    const raw = String(process.env.DESKTOP_API_PROXY_DEBUG ?? '').trim().toLowerCase();
    if (!raw) return false;
    return raw === '1' || raw === 'true' || raw === 'yes';
  } catch (_) {
    return false;
  }
})();

// Runtime API proxy target (used before settings/authProfiles are persisted)
// Shape: { enabled: true, target: URL, basePath: string } or null
let _runtimeApiProxyTarget = null;

// Keep a global reference of the window object
let mainWindow;
// Track additional session windows (id -> { win, sessionId, title })
const _sessionWindows = new Map();

// Track how the frontend was loaded for the main window so child windows can match it
// type: 'url' for http/https/localhost server, 'file' for file:// index.html, otherwise 'unknown'
let _frontendBase = { type: 'unknown', url: null, indexPath: null };

function _normalizeBaseUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    try {
      // Fallback: strip hash/query if present
      const s = String(rawUrl || '');
      return s.split('#')[0].split('?')[0];
    } catch (_) { return null; }
  }
}

function _getFrontendIndexPathFromMain() {
  try {
    if (!mainWindow || !mainWindow.webContents) return null;
    const current = mainWindow.webContents.getURL();
    if (!current) return null;
    const u = new URL(current);
    if ((u.protocol || '').toLowerCase() === 'file:') {
      // Decode file URL to filesystem path
      return decodeURIComponent(u.pathname || '');
    }
  } catch (_) { /* ignore */ }
  return null;
}

// Helper: find a dedicated window for a given sessionId
function findSessionWindow(sessionId) {
  try {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) return null;
    for (const v of _sessionWindows.values()) {
      if (v && v.sessionId === sid && v.win && !v.win.isDestroyed()) return v;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Helper: broadcast that a session's dedicated window association changed
function broadcastSessionWindowChange(sessionId, windowId) {
  try {
    const payload = { sessionId: String(sessionId || ''), windowId: Number.isFinite(windowId) ? windowId : null };
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('desktop:session-window-changed', payload); } catch (_) {}
    }
  } catch (_) { /* ignore */ }
}
let _currentWindowEffects = { opacity: 1 };
let _rendererUiReady = false;
let _readyToShowFired = false;
let _showFallbackTimer = null;
let _saveWindowStateTimer = null;
// Per-session-window debounced save timers
const _sessionWindowSaveTimers = new Map(); // win.id -> Timer

// Global drag state for cross-window session drags
let _globalSessionDrag = { sessionId: null, clientId: null, startedAt: 0 };

// -----------------------------
// System font enumeration (desktop -> renderer IPC)
// -----------------------------

function listFontsWindows() {
  // Enumerate Windows installed fonts by reading registry value names from
  // both HKLM and HKCU under ...\Windows NT\CurrentVersion\Fonts.
  // Previous implementation mistakenly expanded PSChildName which always
  // returned the string 'Fonts'. Here we properly enumerate property names.
  try {
    // PowerShell approach (preferred): collect property names, excluding PS* members
    const psScript = [
      "$e = 'SilentlyContinue';",
      "$hklm = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -ErrorAction $e).psobject.Properties",
      "$hkcu = (Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -ErrorAction $e).psobject.Properties",
      "$names1 = @(); if ($hklm) { $names1 = $hklm | Where-Object { $_.Name -and ($_.Name -notmatch '^PS') } | Select-Object -ExpandProperty Name }",
      "$names2 = @(); if ($hkcu) { $names2 = $hkcu | Where-Object { $_.Name -and ($_.Name -notmatch '^PS') } | Select-Object -ExpandProperty Name }",
      "@($names1 + $names2) | Sort-Object -Unique"
    ].join(' ');
    let output = '';
    try {
      output = execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' });
    } catch (_) {
      output = '';
    }

    let names = [];
    if (output && typeof output === 'string') {
      names = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }

    // Fallback to reg.exe when PowerShell is unavailable or returns empty
    if (!names.length) {
      const parseRegQuery = (root) => {
        try {
          const regOut = execFileSync('reg.exe', ['query', root], { encoding: 'utf8' });
          const arr = [];
          for (const line of String(regOut || '').split(/\r?\n/)) {
            // Lines look like: "    Arial (TrueType)    REG_SZ    arial.ttf"
            const m = line.match(/^\s*([^\s].*?)\s+REG_\w+\s+/);
            if (m && m[1]) arr.push(m[1].trim());
          }
          return arr;
        } catch (_) {
          return [];
        }
      };
      const l1 = parseRegQuery('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts');
      const l2 = parseRegQuery('HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts');
      names = Array.from(new Set([].concat(l1, l2))).filter(Boolean);
    }

    const families = new Set();
    for (const raw of names) {
      // Strip type suffixes like "(TrueType)", "(OpenType)", etc.
      const cleaned = String(raw).replace(/\s*\(.*?\)\s*$/, '').trim();
      if (cleaned) families.add(cleaned);
    }
    return Array.from(families).sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return [];
  }
}

function listFontsLinux() {
  // Prefer fontconfig when available; otherwise return empty
  try {
    const output = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8' });
    const families = new Set();
    String(output || '')
      .split(/\r?\n/)
      .forEach(line => {
        line.split(',').map(s => s.trim()).filter(Boolean).forEach(f => families.add(f));
      });
    return Array.from(families).sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return [];
  }
}

function listFontsMac() {
  const { readdirSync, existsSync } = fs;
  const { join, extname, basename } = path;
  const dirs = [
    '/System/Library/Fonts',
    '/Library/Fonts',
    join(os.homedir() || '', 'Library/Fonts')
  ];
  const families = new Set();
  try {
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (/\.(ttf|otf|ttc|dfont)$/i.test(f)) {
            families.add(basename(f, extname(f)));
          }
        }
      } catch (_) { /* ignore directory errors */ }
    }
  } catch (_) { /* ignore */ }
  return Array.from(families).sort((a, b) => a.localeCompare(b));
}

function listSystemFonts() {
  try {
    switch (process.platform) {
      case 'win32': return listFontsWindows();
      case 'darwin': return listFontsMac();
      default: return listFontsLinux();
    }
  } catch (_) {
    return [];
  }
}

// -----------------------------
// Local PTY Session Manager (feature-flagged)
// -----------------------------

// Default local terminals to enabled when unset. Allow disabling via 0/false/off/no.
const ENABLE_LOCAL_TERMINALS = (() => {
  try {
    const raw = String(process.env.ENABLE_LOCAL_TERMINALS || '').trim().toLowerCase();
    if (!raw) return true; // default on when not provided
    return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
  } catch (_) {
    return true;
  }
})();
// Independently control whether node-pty is included in the build. Defaults to included.
const INCLUDE_NODE_PTY = (() => {
  try {
    const raw = String(process.env.INCLUDE_NODE_PTY || '').trim().toLowerCase();
    if (!raw) return true;
    return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
  } catch (_) { return true; }
})();
// Effective flag for enabling local terminals feature
const LOCAL_TERMINALS_ENABLED = ENABLE_LOCAL_TERMINALS && INCLUDE_NODE_PTY;
let _nodePty = null; // Lazy-loaded when feature is enabled

// sessionId -> { pty, ownerWindowId, createdAt, pid, buffers: { data: string, size: number },
//                flushTimer, flushIntervalMs, oscBuffer, dynamicTitle }
const _localPtySessions = new Map();

function lazyLoadNodePty() {
  if (_nodePty) return _nodePty;
  try {
    // Respect build-time exclusion flag to avoid require() when module is absent
    if (!INCLUDE_NODE_PTY) return null;
    // Load only when enabled to avoid native module issues when disabled
    _nodePty = require('node-pty');
  } catch (e) {
    _nodePty = null;
  }
  return _nodePty;
}

function resolveDefaultShell() {
  const plat = process.platform;
  if (plat === 'win32') {
    // Match backend default; prefer COMSPEC when set
    return process.env.COMSPEC && process.env.COMSPEC.trim() ? process.env.COMSPEC : 'cmd.exe';
  }
  // Prefer user shell when available; otherwise choose sensible defaults per OS
  const envShell = (process.env.SHELL || '').trim();
  if (envShell) return envShell;
  if (plat === 'darwin') return '/bin/zsh';
  if (plat === 'linux') return '/bin/bash';
  return '/bin/sh';
}

function validateCwd(cwd) {
  try {
    const fallbackHome = os.homedir() || process.env.HOME || '';
    const home = (fallbackHome && fs.existsSync(fallbackHome)) ? fallbackHome : (fs.existsSync(process.cwd()) ? process.cwd() : '/');
    if (!cwd || typeof cwd !== 'string') return home;
    const res = path.resolve(String(cwd));
    if (fs.existsSync(res)) return res;
    return home;
  } catch (_) {
    return process.cwd();
  }
}

function sanitizeEnv(input, cols, rows) {
  const out = {};
  let totalSize = 0;
  const MAX_TOTAL = 64 * 1024; // 64KB total
  const MAX_VALUE = 4096; // 4KB per value cap
  try {
    const src = (input && typeof input === 'object') ? input : {};
    for (const [k, v] of Object.entries(src)) {
      if (typeof k !== 'string') continue;
      let val = v;
      if (val === null || val === undefined) continue;
      if (typeof val !== 'string') {
        try { val = String(val); } catch (_) { continue; }
      }
      if (val.length > MAX_VALUE) val = val.slice(0, MAX_VALUE);
      const entrySize = k.length + val.length + 2;
      if (totalSize + entrySize > MAX_TOTAL) break;
      out[k] = val;
      totalSize += entrySize;
    }
  } catch (_) { /* ignore */ }

  // Defaults and enforced values
  out.TERM = out.TERM || 'xterm-256color';
  out.COLORTERM = out.COLORTERM || 'truecolor';
  if (Number.isFinite(cols) && cols > 0) out.COLUMNS = String(Math.floor(cols));
  if (Number.isFinite(rows) && rows > 0) out.LINES = String(Math.floor(rows));
  return Object.assign({}, process.env, out);
}

function parseOscTitleFromChunk(state, data) {
  // Maintain incomplete OSC sequences and update dynamicTitle when found
  try {
    if (typeof data !== 'string' || !data) return null;
    const MAX_OSC_BUFFER = 1024; // 1KB cap to avoid unbounded growth
    let combined = (state.oscBuffer || '') + data;
    const oscRe = /\u001b](?:0|2);([\s\S]*?)(?:\u0007|\u001b\\)/g; // BEL or ST terminated
    let match; let foundTitle = null;
    while ((match = oscRe.exec(combined)) !== null) {
      const t = (match[1] || '').trim();
      if (t) foundTitle = t; // last occurrence wins
    }
    const lastStart = combined.lastIndexOf('\u001b]');
    if (lastStart !== -1) {
      const hasTerminator = combined.indexOf('\u0007', lastStart + 2) !== -1 || combined.indexOf('\u001b\\', lastStart + 2) !== -1;
      state.oscBuffer = hasTerminator ? '' : combined.slice(lastStart);
      if (state.oscBuffer.length > MAX_OSC_BUFFER) {
        // Keep last MAX_OSC_BUFFER bytes only
        state.oscBuffer = state.oscBuffer.slice(-MAX_OSC_BUFFER);
      }
    } else {
      state.oscBuffer = '';
    }
    if (foundTitle && foundTitle !== state.dynamicTitle) {
      state.dynamicTitle = foundTitle;
      return foundTitle;
    }
  } catch (_) { /* ignore */ }
  return null;
}

function computeFlushInterval(bytesQueued) {
  // Base ~16ms, coarsen with backlog growth
  if (!Number.isFinite(bytesQueued) || bytesQueued <= 4096) return 16;
  if (bytesQueued > 512 * 1024) return 64;
  if (bytesQueued > 128 * 1024) return 32;
  return 16;
}

function scheduleFlush(sessionId) {
  const s = _localPtySessions.get(sessionId);
  if (!s) return;
  if (s.flushTimer) return; // already scheduled
  const interval = computeFlushInterval(s.buffers.size);
  s.flushIntervalMs = interval;
  s.flushTimer = setTimeout(() => {
    s.flushTimer = null;
    flushNow(sessionId);
  }, interval);
}

function flushNow(sessionId) {
  const s = _localPtySessions.get(sessionId);
  if (!s || !s.buffers || !s.buffers.size) return;
  let wc = null;
  try {
    const win = s.ownerWindowId ? BrowserWindow.fromId(s.ownerWindowId) : null;
    wc = win && !win.isDestroyed() ? win.webContents : null;
  } catch (_) {}
  const payload = { sessionId, data: s.buffers.data };
  if (wc && !wc.isDestroyed()) {
    try {
      wc.send('desktop:localpty-data', payload);
      // Clear buffer only after successful send
      s.buffers.data = '';
      s.buffers.size = 0;
      // Clear any pending no-owner cleanup since we now have a live owner
      try { if (s.noOwnerCleanupTimer) { clearTimeout(s.noOwnerCleanupTimer); s.noOwnerCleanupTimer = null; } } catch (_) {}
      s.noOwnerSince = null;
    } catch (_) {
      // Keep buffer on send failure for retry on next flush
    }
  } else {
    // Keep buffer for later delivery after reload/reattach (bounded by MAX_OUTPUT_BUFFER in onData)
    // Additionally, schedule a TTL cleanup to avoid indefinite retention when no owner exists
    if (!s.noOwnerSince) {
      s.noOwnerSince = Date.now();
      try {
        s.noOwnerCleanupTimer = setTimeout(() => {
          try {
            const st = _localPtySessions.get(sessionId);
            if (!st) return;
            // Drop buffer if still ownerless; PTY remains running
            st.buffers.data = '';
            st.buffers.size = 0;
          } catch (_) { /* ignore */ }
        }, 30 * 1000);
      } catch (_) { /* ignore */ }
    }
  }
}

function cleanupSession(sessionId) {
  const s = _localPtySessions.get(sessionId);
  if (!s) return;
  try { if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; } } catch (_) {}
  try { if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; } } catch (_) {}
  try { if (s.noOwnerCleanupTimer) { clearTimeout(s.noOwnerCleanupTimer); s.noOwnerCleanupTimer = null; } } catch (_) {}
  try { s.noOwnerSince = null; } catch (_) {}
  try { if (s.pty) { /* leave process termination to caller */ } } catch (_) {}
  _localPtySessions.delete(sessionId);
}

function killSession(sessionId, force = false) {
  const s = _localPtySessions.get(sessionId);
  if (!s || !s.pty) { cleanupSession(sessionId); return false; }
  try {
    if (process.platform === 'win32') {
      s.pty.kill();
    } else {
      s.pty.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch (_) { /* ignore */ }
  return true;
}

function listSessions() {
  const arr = [];
  for (const [sid, s] of _localPtySessions.entries()) {
    arr.push({ sessionId: sid, pid: s.pid || null, createdAt: s.createdAt });
  }
  return arr;
}

// -----------------------------
// Window state persistence (size/position)
// -----------------------------

function loadWindowStateFromDisk() {
  try {
    const sr = persistence.readStateFromDisk();
    const state = (sr && sr.ok && sr.state) ? sr.state : {};
    const ws = (state && typeof state.window === 'object') ? state.window : {};

    const bounds = {};
    if (Number.isFinite(ws.width) && ws.width > 0) bounds.width = Math.max(400, Math.floor(ws.width));
    if (Number.isFinite(ws.height) && ws.height > 0) bounds.height = Math.max(200, Math.floor(ws.height));
    if (Number.isFinite(ws.x) && Number.isFinite(ws.y)) {
      bounds.x = Math.floor(ws.x);
      bounds.y = Math.floor(ws.y);
    }
    const maximized = !!ws.maximized;
    const fullscreen = !!ws.fullscreen;
    return { bounds, maximized, fullscreen };
  } catch (_) {
    return { bounds: {}, maximized: false, fullscreen: false };
  }
}

function saveWindowStateToDiskImmediate(force = false) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Skip saving while minimized unless explicitly forced (e.g., on close)
    if (!force && typeof mainWindow.isMinimized === 'function' && mainWindow.isMinimized()) {
      return;
    }
    const sr = persistence.readStateFromDisk();
    const state = (sr && sr.ok && sr.state) ? sr.state : {};
    const ws = (state && typeof state.window === 'object') ? state.window : {};

    const useNormalBounds = !!(mainWindow.isMaximized() || mainWindow.isFullScreen());
    const b = useNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();

    ws.x = Number(b.x) || 0;
    ws.y = Number(b.y) || 0;
    ws.width = Math.max(400, Number(b.width) || 400);
    ws.height = Math.max(200, Number(b.height) || 200);
    ws.maximized = !!mainWindow.isMaximized();
    ws.fullscreen = !!mainWindow.isFullScreen();

    state.window = ws;
    persistence.writeStateToDisk(state);
  } catch (_) { /* ignore */ }
}

function scheduleSaveWindowState(force = false) {
  try { clearTimeout(_saveWindowStateTimer); } catch (_) {}
  _saveWindowStateTimer = setTimeout(() => {
    saveWindowStateToDiskImmediate(force);
  }, 250);
}

// -----------------------------
// Per-index session window bounds persistence
// -----------------------------

function loadSessionWindowBoundsFromDisk(index) {
  try {
    const n = Number(index) || 0;
    if (!(n > 0)) return {};
    const sr = persistence.readStateFromDisk();
    const state = (sr && sr.ok && sr.state) ? sr.state : {};
    const all = (state && typeof state.session_windows === 'object') ? state.session_windows : {};
    const ws = (all && typeof all[String(n)] === 'object') ? all[String(n)] : {};
    const bounds = {};
    if (Number.isFinite(ws.width) && ws.width > 0) bounds.width = Math.max(400, Math.floor(ws.width));
    if (Number.isFinite(ws.height) && ws.height > 0) bounds.height = Math.max(200, Math.floor(ws.height));
    if (Number.isFinite(ws.x) && Number.isFinite(ws.y)) {
      bounds.x = Math.floor(ws.x);
      bounds.y = Math.floor(ws.y);
    }
    return { bounds };
  } catch (_) {
    return { bounds: {} };
  }
}

function saveSessionWindowBoundsToDiskImmediate(win, index, force = false) {
  try {
    if (!win || win.isDestroyed()) return;
    if (!force && typeof win.isMinimized === 'function' && win.isMinimized()) return;
    const sr = persistence.readStateFromDisk();
    const state = (sr && sr.ok && sr.state) ? sr.state : {};
    const all = (state && typeof state.session_windows === 'object') ? state.session_windows : {};

    const b = (typeof win.isMaximized === 'function' && win.isMaximized()) || (typeof win.isFullScreen === 'function' && win.isFullScreen())
      ? win.getNormalBounds() : win.getBounds();

    const entry = {
      index: Number(index) || 0,
      x: Number(b.x) || 0,
      y: Number(b.y) || 0,
      width: Math.max(400, Number(b.width) || 400),
      height: Math.max(200, Number(b.height) || 200)
    };

    const key = String(Number(index) || 0);
    if (!all || typeof all !== 'object') state.session_windows = {};
    state.session_windows = Object.assign({}, all, { [key]: entry });
    persistence.writeStateToDisk(state);
  } catch (_) { /* ignore */ }
}

function scheduleSaveSessionWindowBounds(win, index, force = false) {
  try {
    const key = win && Number.isFinite(win.id) ? win.id : null;
    if (!key) return;
    const existing = _sessionWindowSaveTimers.get(key);
    try { if (existing) clearTimeout(existing); } catch (_) {}
    const t = setTimeout(() => saveSessionWindowBoundsToDiskImmediate(win, index, force), 250);
    _sessionWindowSaveTimers.set(key, t);
  } catch (_) { /* ignore */ }
}

// Compute the lowest available positive index not currently used by open session windows
function getLowestAvailableSessionIndex() {
  try {
    const used = new Set();
    for (const v of _sessionWindows.values()) {
      if (v && Number.isFinite(v.index) && v.index > 0) used.add(v.index);
    }
    let i = 1;
    while (used.has(i)) i++;
    return i;
  } catch (_) { return 1; }
}

// Ensure restored window bounds are visible on at least one display.
function clampBoundsToVisible(bounds) {
  try {
    if (!bounds || typeof bounds !== 'object') return bounds;
    const havePos = Number.isFinite(bounds.x) && Number.isFinite(bounds.y);
    const haveSize = Number.isFinite(bounds.width) && Number.isFinite(bounds.height);
    if (!haveSize) return bounds; // Width/height required for meaningful checks

    const displays = (typeof screen?.getAllDisplays === 'function') ? screen.getAllDisplays() : [];
    const areas = displays.map(d => d.workArea || d.bounds || { x: 0, y: 0, width: 0, height: 0 });
    if (!areas.length) return bounds; // No screen info, do nothing

    const minW = 400;
    const minH = 200;
    let w = Math.max(minW, Math.floor(bounds.width));
    let h = Math.max(minH, Math.floor(bounds.height));

    const rectIntersects = (a, b) => (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y);

    // If no position, just clamp size to not exceed primary work area, leave placement to Electron
    if (!havePos) {
      const primary = screen.getPrimaryDisplay();
      const area = primary?.workArea || primary?.bounds || areas[0];
      w = Math.min(w, Math.max(minW, area.width || w));
      h = Math.min(h, Math.max(minH, area.height || h));
      return { width: w, height: h };
    }

    const target = { x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: w, height: h };
    const intersects = areas.some(a => rectIntersects(target, a));
    if (intersects) {
      // Also clamp size if larger than any display's workArea (choose the first that intersects)
      const a = areas.find(a => rectIntersects(target, a)) || areas[0];
      const cw = Math.min(w, Math.max(minW, a.width || w));
      const ch = Math.min(h, Math.max(minH, a.height || h));
      return { x: target.x, y: target.y, width: cw, height: ch };
    }

    // Not intersecting any display: pick the nearest display (by center distance) and move window inside it
    const center = { cx: target.x + Math.floor(target.width / 2), cy: target.y + Math.floor(target.height / 2) };
    const dist2 = (a, b) => {
      const acx = a.x + Math.floor(a.width / 2);
      const acy = a.y + Math.floor(a.height / 2);
      return (acx - b.cx) * (acx - b.cx) + (acy - b.cy) * (acy - b.cy);
    };
    let best = areas[0];
    let bestD = dist2(best, center);
    for (let i = 1; i < areas.length; i++) {
      const d = dist2(areas[i], center);
      if (d < bestD) { best = areas[i]; bestD = d; }
    }
    // Clamp size to fit inside chosen work area
    const cw = Math.min(w, Math.max(minW, best.width || w));
    const ch = Math.min(h, Math.max(minH, best.height || h));
    // Center within the chosen display's work area
    const nx = best.x + Math.max(0, Math.floor((best.width - cw) / 2));
    const ny = best.y + Math.max(0, Math.floor((best.height - ch) / 2));
    return { x: nx, y: ny, width: cw, height: ch };
  } catch (_) {
    return bounds;
  }
}

// Development mode and flags
const isDev = process.argv.includes('--dev');
const autoOpenDevTools = isDev || String(process.env.OPEN_DEVTOOLS).trim() === '1';
const allowInvalidCertsEnv = process.env.ALLOW_INVALID_CERTS?.trim() !== '0';
let runtimeAllowInvalidCerts = allowInvalidCertsEnv;

// Backstop: if env requests it, let Chromium ignore certificate errors
if (allowInvalidCertsEnv) {
  try { app.commandLine.appendSwitch('ignore-certificate-errors'); } catch (_) {}
}

// Ensure userData path uses 'TermStation' directory instead of default product name
// Do this BEFORE any persistence read/write so both use the same location.
try {
  const appDataBase = app.getPath('appData');
  const desired = path.join(appDataBase, 'TermStation');
  app.setPath('userData', desired);
} catch (_) { /* ignore */ }

// Apply persisted setting from settings.json if present (overrides env default)
try {
  const fromDisk = (function(){ try { return persistence.readSettingsFromDisk(); } catch(_) { return null; } })();
  const persisted = fromDisk && fromDisk.ok ? fromDisk.settings : null;
  const diskFlag = persisted && persisted.preferences && persisted.preferences.desktop ? persisted.preferences.desktop.allowInvalidCerts : undefined;
  if (typeof diskFlag === 'boolean') {
    runtimeAllowInvalidCerts = diskFlag === true;
  }
} catch (_) { /* ignore */ }

// Resolve frontend config directory; default to packaged frontend public root (contains config.js)
let FRONTEND_CONFIG_DIR = process.env.TERMSTATION_FRONTEND_CONFIG_DIR || '';
if (!FRONTEND_CONFIG_DIR) {
  const packagedDefault = path.join(__dirname, '..', 'frontend', 'public');
  FRONTEND_CONFIG_DIR = packagedDefault;
}
if (!path.isAbsolute(FRONTEND_CONFIG_DIR)) {
  FRONTEND_CONFIG_DIR = path.resolve(process.cwd(), FRONTEND_CONFIG_DIR);
}

// Validate that the config directory exists and contains config.js
if (!fs.existsSync(FRONTEND_CONFIG_DIR) || !fs.statSync(FRONTEND_CONFIG_DIR).isDirectory()) {
  console.error(`Frontend config directory does not exist or is not a directory: '${FRONTEND_CONFIG_DIR}'`);
  console.error('Set TERMSTATION_FRONTEND_CONFIG_DIR to an absolute directory containing config.js');
  app.quit();
  process.exit(1);
}
const configJsPath = path.join(FRONTEND_CONFIG_DIR, 'config.js');
if (!fs.existsSync(configJsPath)) {
  console.error(`Config file not found: ${configJsPath}`);
  console.error('The frontend config directory must contain a config.js file');
  app.quit();
  process.exit(1);
}

// FRONTEND_URL controls how the frontend is loaded:
// - unset / "local" (default): host packaged frontend on an ephemeral localhost HTTP server
// - "file": load packaged frontend via file:// where supported
// - anything else: treated as a full URL and loaded directly
const FRONTEND_URL = process.env.FRONTEND_URL || null;

// userData path already set above

// Resolve current API proxy configuration from runtime hint or desktop settings (authProfiles)
function getApiProxyConfig() {
  // Prefer in-memory runtime target set explicitly by the renderer
  if (_runtimeApiProxyTarget && _runtimeApiProxyTarget.enabled && _runtimeApiProxyTarget.target) {
    if (PROXY_DEBUG) {
      try {
        console.log('[Desktop] API proxy config (runtime)', {
          target: _runtimeApiProxyTarget.target.href,
          basePath: _runtimeApiProxyTarget.basePath
        });
      } catch (_) {}
    }
    return _runtimeApiProxyTarget;
  }

  try {
    const res = persistence.readSettingsFromDisk();
    if (!res || !res.ok || !res.settings) return { enabled: false };
    const settings = res.settings;
    const ap = settings.authProfiles || {};
    const items = Array.isArray(ap.items) ? ap.items : [];
    const activeId = (ap && typeof ap.activeId === 'string') ? ap.activeId : '';
    if (!activeId || !items.length) return { enabled: false };
    let active = null;
    for (let i = 0; i < items.length; i += 1) {
      const p = items[i];
      if (p && p.id === activeId) { active = p; break; }
    }
    if (!active || !active.useApiProxy) {
      if (PROXY_DEBUG) {
        try { console.log('[Desktop] API proxy disabled: active profile has useApiProxy=false'); } catch (_) {}
      }
      return { enabled: false };
    }
    const rawBase = (active.apiUrl && typeof active.apiUrl === 'string') ? active.apiUrl.trim() : '';
    if (!rawBase) return { enabled: false };
    let target;
    try { target = new URL(rawBase); } catch (_) { return { enabled: false }; }
    const proto = String(target.protocol || '').toLowerCase();
    // Proxy is intended for HTTP-only backends; HTTPS backends should be accessed directly.
    if (proto !== 'http:') {
      if (PROXY_DEBUG) {
        try { console.log('[Desktop] API proxy disabled: active profile API URL is not http://', target.href); } catch (_) {}
      }
      return { enabled: false };
    }
    const basePath = String(target.pathname || '');
    const cfg = {
      enabled: true,
      target,
      basePath: basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
    };
    if (PROXY_DEBUG) {
      try { console.log('[Desktop] API proxy config (settings)', { target: target.href, basePath: cfg.basePath }); } catch (_) {}
    }
    return cfg;
  } catch (_) {
    return { enabled: false };
  }
}

function proxyApiRequest(req, res, parsedUrlObj) {
  const cfg = getApiProxyConfig();
  if (!cfg || !cfg.enabled || !cfg.target) {
    if (PROXY_DEBUG) {
      try {
        console.warn('[Desktop] API proxy requested but no config; path=', parsedUrlObj && parsedUrlObj.pathname);
      } catch (_) {}
    }
    try {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('API proxy is not configured');
    } catch (_) {}
    return;
  }

  const target = cfg.target;
  const upstreamPath = (() => {
    try {
      const incomingPath = parsedUrlObj && parsedUrlObj.pathname ? parsedUrlObj.pathname : '/';
      const basePath = cfg.basePath || '';
      const search = parsedUrlObj && typeof parsedUrlObj.search === 'string' ? parsedUrlObj.search : '';
      return `${basePath}${incomingPath}${search}`;
    } catch (_) {
      return (parsedUrlObj && parsedUrlObj.path) || parsedUrlObj.pathname || '/';
    }
  })();

  const headers = Object.assign({}, req.headers || {});
  // Ensure Host header matches backend expectations
  headers.host = target.host;

  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 80,
    method: req.method || 'GET',
    path: upstreamPath,
    headers
  };

  if (PROXY_DEBUG) {
    try {
      console.log('[Desktop] API proxy request', {
        method: options.method,
        path: options.path,
        target: `${options.protocol}//${options.hostname}:${options.port}`
      });
    } catch (_) {}
  }

  const proxyReq = httpRequest(options, (proxyRes) => {
    try {
      const outHeaders = Object.assign({}, proxyRes.headers || {});
      // Remove hop-by-hop headers
      delete outHeaders.connection;
      delete outHeaders['proxy-connection'];
      delete outHeaders['transfer-encoding'];
      delete outHeaders['keep-alive'];
      delete outHeaders['upgrade'];
      res.writeHead(proxyRes.statusCode || 502, outHeaders);
      proxyRes.pipe(res);
    } catch (e) {
      try {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('API proxy response error');
      } catch (_) {}
    }
  });

  // Prevent hung upstream connections from stalling the client indefinitely
  try {
    proxyReq.setTimeout(30000, () => {
      try { proxyReq.destroy(new Error('ETIMEDOUT')); } catch (_) {}
    });
  } catch (_) {}

  proxyReq.on('error', (err) => {
    try { console.error('[Desktop] API proxy error:', err && (err.message || err)); } catch (_) {}
    try {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('API proxy error');
    } catch (_) {}
  });

  try {
    req.pipe(proxyReq);
  } catch (_) {
    try { proxyReq.end(); } catch (_) {}
  }
}

// Static file server for frontend
function createStaticServer(publicRoot) {
  // Serve static assets from the frontend public directory
  // When packaged, this should point under process.resourcesPath; during dev, use repo path
  const publicPath = publicRoot && typeof publicRoot === 'string'
    ? path.resolve(publicRoot)
    : path.join(__dirname, '..', 'frontend', 'public');
  const configDir = FRONTEND_CONFIG_DIR; // directory containing config.js
  
  
  const server = createServer((req, res) => {
    // Parse the request URL
    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname;
    
    // Default to index.html for root requests
    if (pathname === '/') {
      pathname = '/index.html';
    }
    
    // API proxy: forward /api/* to the configured backend when enabled
    if (pathname && pathname.startsWith('/api/')) {
      proxyApiRequest(req, res, parsedUrl);
      return;
    }

    // Construct file path
    // Special route: serve environment configuration as-is from FRONTEND_CONFIG_DIR
    if (pathname === '/config.js') {
      try {
        const cfgFile = path.join(configDir, 'config.js');
        const content = fs.readFileSync(cfgFile, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        res.end(content);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to load config');
      }
      return;
    }

    // Optional: serve dev tests if present from /tests/*
    if (pathname.startsWith('/tests/')) {
      const testsRoot = path.join(__dirname, '..', 'frontend', 'tests');
      const rel = pathname.replace(/^\/tests\//, '/');
      const testPath = path.join(testsRoot, rel);
      const resolvedTest = path.resolve(testPath);
      const resolvedTestsRoot = path.resolve(testsRoot);
      if (resolvedTest.startsWith(resolvedTestsRoot) && fs.existsSync(resolvedTest) && fs.statSync(resolvedTest).isFile()) {
        const ext = path.extname(resolvedTest).toLowerCase();
        const contentTypes = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon'
        };
        const contentType = contentTypes[ext] || 'application/octet-stream';
        try {
          const data = fs.readFileSync(resolvedTest);
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(data);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
        return;
      }
    }

    let filePath = path.join(publicPath, pathname);
    
    // Security check - ensure file is within frontend directory
    const resolvedPath = path.resolve(filePath);
    const resolvedFrontendPath = path.resolve(publicPath);
    if (!resolvedPath.startsWith(resolvedFrontendPath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    
    // Check if file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // If file doesn't exist and it's not an API request, serve index.html (SPA routing)
        if (!pathname.startsWith('/api/')) {
          filePath = path.join(publicPath, 'index.html');
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
      }
      
      // Determine content type
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      };
      
      const contentType = contentTypes[ext] || 'application/octet-stream';
      
      // Read and serve the file
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        res.end(data);
      });
    });
  });
  
  return new Promise((resolve, reject) => {
    const onListening = () => {
      const addr = server.address();
      const port = addr && typeof addr.port === 'number' ? addr.port : '(unknown)';
      console.log(`Static server running on http://localhost:${port}`);
      resolve({ server, port });
    };

    server.once('error', (err) => {
      try { console.error('Failed to start static server for frontend:', err && (err.message || err)); } catch (_) {}
      try { server.close(); } catch (_) {}
      reject(err);
    });

    // Attach WebSocket proxy for /ws/* when API proxy is enabled
    try { attachApiWebSocketProxy(server); } catch (_) {}

    // Always use an ephemeral port to avoid conflicts
    server.listen(0, 'localhost', onListening);
  });
}

// No temp version injection in file:// mode; renderer falls back to desktop.appVersion if config lacks version.

function setupLocalConfigIntercept(publicRoot) {
  try {
    const publicDir = path.resolve(publicRoot || '');
    const expectedConfig = path.resolve(path.join(publicDir, 'config.js'));
    // Install a one-time intercept to serve ONLY public/config.js from the configured directory
    protocol.interceptFileProtocol('file', (request, callback) => {
      try {
        const u = new URL(request.url);
        const reqPath = path.resolve(decodeURIComponent(u.pathname || ''));
        if (reqPath === expectedConfig) {
          if (fs.existsSync(configJsPath)) {
            try { console.log(`[Desktop] file:// intercept: ${reqPath} -> ${configJsPath}`); } catch (_) {}
            return callback(configJsPath);
          }
        }
        return callback(reqPath);
      } catch (e) {
        try { return callback({ path: request.url }); } catch (_) { return callback(); }
      }
    });
  } catch (e) { /* ignore */ }
}

function createWindow() {
  const restored = loadWindowStateFromDisk();
  // Create the browser window
  function getWindowIcon() {
    try {
      const svgIcon = path.join(__dirname, '..', 'frontend', 'icons', 'vendor', 'bootstrap-icons', 'terminal.svg');
      if (fs.existsSync(svgIcon)) return svgIcon; // Prefer the Sessions (terminal) toolbar SVG
    } catch (_) {}
    return path.join(__dirname, 'build', 'icon.png'); // Fallback
  }

  const initialBounds = Object.assign({ width: 1200, height: 800 }, restored.bounds);
  const finalBounds = clampBoundsToVisible(initialBounds);

  mainWindow = new BrowserWindow({
    width: finalBounds.width,
    height: finalBounds.height,
    x: finalBounds.x,
    y: finalBounds.y,
    minWidth: 400,
    minHeight: 200,
    backgroundColor: getInitialBackgroundColor(),
    // Hide menu bar on Windows (we don't use the app menu there)
    autoHideMenuBar: process.platform === 'win32',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: getWindowIcon(),
    show: false, // Don't show until ready
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default'
  });

  // Apply maximized state if previously saved
  try { if (restored.maximized) { mainWindow.maximize(); } } catch (_) {}
  // Apply fullscreen state if previously saved (after creation)
  try { if (restored.fullscreen) { mainWindow.setFullScreen(true); } } catch (_) {}

  // Watch for moves/resizes and persist window state (debounced)
  try {
    mainWindow.on('move', () => scheduleSaveWindowState(false));
    mainWindow.on('resize', () => scheduleSaveWindowState(false));
    mainWindow.on('maximize', () => saveWindowStateToDiskImmediate(false));
    mainWindow.on('unmaximize', () => saveWindowStateToDiskImmediate(false));
    mainWindow.on('enter-full-screen', () => saveWindowStateToDiskImmediate(false));
    mainWindow.on('leave-full-screen', () => saveWindowStateToDiskImmediate(false));
    // Ensure we persist even if app is closed while minimized
    mainWindow.on('close', () => saveWindowStateToDiskImmediate(true));
    // Save shortly after focus leaves the window (skip if minimized at that moment)
    mainWindow.on('blur', () => scheduleSaveWindowState(false));
  } catch (_) { /* ignore */ }

  // Helper to reflect fullscreen state into the DOM as a class
  const updateFullscreenClass = () => {
    if (!mainWindow || !mainWindow.webContents) return;
    const isFs = mainWindow.isFullScreen();
    const js = `try { document.documentElement.classList.toggle('is-fullscreen', ${isFs}); } catch (e) {}`;
    // Best-effort; ignore failures if contents not yet ready
    mainWindow.webContents.executeJavaScript(js).catch(() => {});
  };

  // Start the static server and load the app (remote URL or local file)
  const loadAndWire = (serverUrl, server) => {
    // Remember how we loaded the frontend so secondary windows can mirror it
    try { _frontendBase = { type: 'url', url: _normalizeBaseUrl(serverUrl), indexPath: null }; } catch (_) { _frontendBase = { type: 'url', url: serverUrl, indexPath: null }; }
    // Load the app from provided URL
    mainWindow.loadURL(serverUrl);
    
    // Defer showing the window until renderer signals UI readiness (with timeout fallback)
    const maybeShow = () => {
      if (!mainWindow || mainWindow.isVisible()) return;
      if (_readyToShowFired && (_rendererUiReady)) {
        try { clearTimeout(_showFallbackTimer); } catch (_) {}
        _showFallbackTimer = null;
        mainWindow.show();
        updateFullscreenClass();
        if (autoOpenDevTools) {
          mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
      }
    };

    mainWindow.once('ready-to-show', () => {
      _readyToShowFired = true;
      // Fallback: ensure window becomes visible within 800ms even if renderer never signals
      _showFallbackTimer = setTimeout(() => {
        if (!mainWindow) return;
        if (!mainWindow.isVisible()) {
          mainWindow.show();
          updateFullscreenClass();
          if (autoOpenDevTools) {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
          }
        }
      }, 800);
      maybeShow();
    });

    // Also update the fullscreen class as soon as the DOM is ready and after load
    // This covers initial launch where the window may already be fullscreen
    mainWindow.webContents.on('dom-ready', () => updateFullscreenClass());
    mainWindow.webContents.on('did-finish-load', () => {
      updateFullscreenClass();
      // Re-apply effects after reloads
      try { applyWindowEffects(_currentWindowEffects); } catch (_) {}
    });
    
  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
    try { clearTimeout(_showFallbackTimer); } catch (_) {}
    _showFallbackTimer = null;
    try { server && server.close && server.close(); } catch (_) {}
    // Close any child session windows when the main window is closed
    try {
      for (const { win } of _sessionWindows.values()) {
        try { if (win && !win.isDestroyed()) win.close(); } catch (_) {}
      }
      _sessionWindows.clear();
    } catch (_) {}
  });
    
    // Handle external links
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) {
        shell.openExternal(url);
      } else {
        console.warn('Blocked window.open to disallowed scheme:', url);
      }
      return { action: 'deny' };
    });
    
    // Prevent navigation to external sites (allow same-origin)
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
      try {
        const parsedUrl = new URL(navigationUrl);
        // Block external navigations but allow opening in the system browser
        const serverOrigin = (() => { try { return (new URL(serverUrl)).origin; } catch (_) { return String(serverUrl || ''); } })();
        if (parsedUrl.origin !== serverOrigin) {
          event.preventDefault();
          if (isAllowedExternalUrl(navigationUrl)) {
            shell.openExternal(navigationUrl);
          } else {
            console.warn('Blocked will-navigate to disallowed scheme:', navigationUrl);
          }
        }
      } catch (e) {
        // If URL parsing fails, block the navigation as a safety measure
        event.preventDefault();
        console.warn('Failed to parse navigation URL:', navigationUrl, e);
      }
    });
  };

  // Decide content source based on FRONTEND_URL
  const FRONTEND_URL_RAW = process.env.FRONTEND_URL || '';
  const FRONTEND_URL_NORM = String(FRONTEND_URL_RAW).trim().toLowerCase();
  const useLocalHttp = !FRONTEND_URL_NORM || FRONTEND_URL_NORM === 'local';
  const useFileMode = FRONTEND_URL_NORM === 'file';

  if (useLocalHttp || useFileMode) {
    // Prefer packaged resources; fall back to repo folder during dev runs
    const packagedPublic = path.join(process.resourcesPath || __dirname, 'frontend', 'public');
    const devPublic = path.join(__dirname, '..', 'frontend', 'public');
    const publicRoot = fs.existsSync(packagedPublic) ? packagedPublic : devPublic;
    try {
      const ppExists = fs.existsSync(packagedPublic);
      const dpExists = fs.existsSync(devPublic);
      const coreConfig = path.join(publicRoot, 'js', 'core', 'config.js');
      const hasCoreConfig = fs.existsSync(coreConfig);
      const coreConfigHead = hasCoreConfig ? (fs.readFileSync(coreConfig, 'utf8').split('\n').slice(0, 5).join('\n')) : '(missing)';
      console.log(`[Desktop] Local frontend mode (${useFileMode ? 'file://' : 'http://localhost:<ephemeral>'})`);
      console.log(`  process.resourcesPath=${process.resourcesPath}`);
      console.log(`  packagedPublic=${packagedPublic} (exists=${ppExists})`);
      console.log(`  devPublic=${devPublic} (exists=${dpExists})`);
      console.log(`  publicRoot=${publicRoot}`);
      console.log(`  core/config.js exists=${hasCoreConfig}`);
      console.log('  core/config.js head:\n' + coreConfigHead);
      console.log(`  FRONTEND_CONFIG_DIR=${FRONTEND_CONFIG_DIR}`);
    } catch (e) {
      try { console.warn('[Desktop] Failed to log local frontend diagnostics:', e && (e.message || e)); } catch (_) {}
    }

    const startLocalHttp = () => {
      createStaticServer(publicRoot).then(({ server, port }) => {
        const serverUrl = `http://localhost:${port}`;
        loadAndWire(serverUrl, server);
      }).catch((e) => {
        const msg = 'Failed to start local static server for frontend: ' + (e && (e.message || e));
        try { console.error(msg); } catch (_) {}
        try { dialog.showErrorBox('TermStation', msg + '\n\nSet FRONTEND_URL to a remote URL to load from the server.'); } catch (_) {}
      });
    };

    if (useFileMode && process.platform !== 'win32') {
      const indexPath = path.join(publicRoot, 'index.html');
      try { _frontendBase = { type: 'file', url: null, indexPath }; } catch (_) { /* ignore */ }
      // Intercept config.js to serve from FRONTEND_CONFIG_DIR without an HTTP server
      setupLocalConfigIntercept(publicRoot);

      // Defer showing the window until renderer signals UI readiness (with timeout fallback)
      mainWindow.once('ready-to-show', () => {
        _readyToShowFired = true;
        _showFallbackTimer = setTimeout(() => {
          if (!mainWindow) return;
          if (!mainWindow.isVisible()) {
            mainWindow.show();
            if (autoOpenDevTools) {
              mainWindow.webContents.openDevTools({ mode: 'detach' });
            }
          }
        }, 2000);
      });

      // Security: external links only via shell; block cross-scheme navigations
      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedExternalUrl(url)) {
          shell.openExternal(url);
        } else {
          console.warn('Blocked window.open to disallowed scheme:', url);
        }
        return { action: 'deny' };
      });
      mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        try {
          const parsedUrl = new URL(navigationUrl);
          const proto = String(parsedUrl.protocol || '').toLowerCase();
          if (proto !== 'file:') {
            event.preventDefault();
            if (isAllowedExternalUrl(navigationUrl)) {
              shell.openExternal(navigationUrl);
            } else {
              console.warn('Blocked will-navigate to disallowed scheme:', navigationUrl);
            }
          }
        } catch (e) {
          // If URL parsing fails, block the navigation as a safety measure
          event.preventDefault();
          console.warn('Failed to parse navigation URL:', navigationUrl, e);
        }
      });

      try {
        mainWindow.loadFile(indexPath);
      } catch (e) {
        const msg = 'Failed to load local frontend via file://: ' + (e && (e.message || e));
        try { console.error(msg); } catch (_) {}
        try { dialog.showErrorBox('TermStation', msg + '\n\nSet FRONTEND_URL to a remote URL to load from the server.'); } catch (_) {}
      }
    } else {
      if (useFileMode && process.platform === 'win32') {
        try { console.warn('[Desktop] FRONTEND_URL=file is not supported on Windows; falling back to local HTTP server.'); } catch (_) {}
      }
      // Host over localhost HTTP to avoid file:// restrictions (and to provide a consistent default on all platforms)
      startLocalHttp();
    }
  } else {
    console.log('Loading frontend from FRONTEND_URL:', FRONTEND_URL_RAW);
    loadAndWire(FRONTEND_URL_RAW, null);
  }

  // Track fullscreen transitions and update class accordingly
  mainWindow.on('enter-full-screen', () => updateFullscreenClass());
  mainWindow.on('leave-full-screen', () => updateFullscreenClass());
  // Ensure class reflects state when window becomes visible
  mainWindow.on('show', () => updateFullscreenClass());
}

// Create a new BrowserWindow for a specific session (secondary window)
function createSessionWindow({ sessionId, title }) {
  if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId required');

  const myIndex = getLowestAvailableSessionIndex();
  const restored = loadSessionWindowBoundsFromDisk(myIndex);
  const initialBounds = Object.assign({ width: 1200, height: 800 }, restored.bounds);
  const finalBounds = clampBoundsToVisible(initialBounds);

  const child = new BrowserWindow({
    width: finalBounds.width,
    height: finalBounds.height,
    x: finalBounds.x,
    y: finalBounds.y,
    minWidth: 400,
    minHeight: 200,
    backgroundColor: getInitialBackgroundColor(),
    autoHideMenuBar: process.platform === 'win32',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default'
  });

  if (title && typeof title === 'string') {
    try { child.setTitle(`TermStation — ${title}`); } catch (_) {}
  } else {
    try { child.setTitle(`TermStation — ${sessionId}`); } catch (_) {}
  }

  // Inherit current zoom factor from the main window so visual scale matches
  try {
    if (mainWindow && mainWindow.webContents && child && child.webContents) {
      const z = typeof mainWindow.webContents.getZoomFactor === 'function'
        ? Number(mainWindow.webContents.getZoomFactor())
        : NaN;
      if (Number.isFinite(z) && typeof child.webContents.setZoomFactor === 'function') {
        child.webContents.setZoomFactor(z);
      }
    }
  } catch (_) { /* ignore zoom copy failures */ }

  // Load in minimal window mode to avoid duplicating full UI (header/sidebar)
  // Pass a hint via query param understood by the frontend to hide chrome
  // Provide a unique client id for this renderer to avoid websocket/client collisions
  const uniqueClient = `win-${child.id}-${Date.now()}`;
  // Apply current effects to child immediately to avoid flash
  try { setWindowOpacityFor(child, (_currentWindowEffects && _currentWindowEffects.opacity) ? _currentWindowEffects.opacity : 1); } catch (_) {}

  // Choose loading strategy to match the main window
  const baseType = _frontendBase && _frontendBase.type ? _frontendBase.type : 'unknown';
  if (baseType === 'file') {
    // Load the same local index.html with query parameters
    let indexPath = (_frontendBase && _frontendBase.indexPath) ? _frontendBase.indexPath : null;
    if (!indexPath) indexPath = _getFrontendIndexPathFromMain();
    // Security: external links only via shell; block cross-scheme navigations
    child.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) {
        shell.openExternal(url);
      } else {
        console.warn('Blocked window.open to disallowed scheme:', url);
      }
      return { action: 'deny' };
    });
    child.webContents.on('will-navigate', (event, navigationUrl) => {
      try {
        const parsedUrl = new URL(navigationUrl);
        const proto = String(parsedUrl.protocol || '').toLowerCase();
        if (proto !== 'file:') {
          event.preventDefault();
          if (isAllowedExternalUrl(navigationUrl)) {
            shell.openExternal(navigationUrl);
          } else {
            console.warn('Blocked will-navigate to disallowed scheme:', navigationUrl);
          }
        }
      } catch (e) {
        // If URL parsing fails, block the navigation as a safety measure
        event.preventDefault();
        console.warn('Failed to parse navigation URL:', navigationUrl, e);
      }
    });
    try {
      if (indexPath) {
        child.loadFile(indexPath, {
          query: {
            session_id: String(sessionId),
            window: '1',
            ui: 'window',
            client: String(uniqueClient)
          }
        });
      } else {
        // As a last resort, let the renderer compute URL from window.location origin
        const urlFromMain = (function() {
          try {
            const current = mainWindow && mainWindow.webContents ? mainWindow.webContents.getURL() : '';
            const u = new URL(current);
            return `${u.origin}${u.pathname}`;
          } catch (_) { return null; }
        })();
        const base = urlFromMain || 'https://termstation';
        const targetUrl = `${base}?session_id=${encodeURIComponent(sessionId)}&window=1&ui=window&client=${encodeURIComponent(uniqueClient)}`;
        child.loadURL(targetUrl);
      }
    } catch (e) {
      console.error('Failed to load child window (file mode):', e && (e.message || e));
    }
  } else {
    // URL-based (remote or local HTTP) — derive base from main window URL
    let baseUrl = (_frontendBase && _frontendBase.url) ? _frontendBase.url : null;
    if (!baseUrl) {
      try {
        const current = mainWindow && mainWindow.webContents ? mainWindow.webContents.getURL() : '';
        const u = new URL(current);
        baseUrl = `${u.origin}${u.pathname}`;
      } catch (_) {
        baseUrl = 'https://termstation'; // fallback
      }
    }
    const targetUrl = `${baseUrl}?session_id=${encodeURIComponent(sessionId)}&window=1&ui=window&client=${encodeURIComponent(uniqueClient)}`;
    // Security: external links only via shell
    child.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) {
        shell.openExternal(url);
      } else {
        console.warn('Blocked window.open to disallowed scheme:', url);
      }
      return { action: 'deny' };
    });
    child.webContents.on('will-navigate', (event, navigationUrl) => {
      try {
        const parsedUrl = new URL(navigationUrl);
        const baseOrigin = (new URL(baseUrl)).origin;
        // Block external navigations but allow same-origin
        if (parsedUrl.origin !== baseOrigin) {
          event.preventDefault();
          if (isAllowedExternalUrl(navigationUrl)) {
            shell.openExternal(navigationUrl);
          } else {
            console.warn('Blocked will-navigate to disallowed scheme:', navigationUrl);
          }
        }
      } catch (e) {
        // If URL parsing fails, block the navigation as a safety measure
        event.preventDefault();
        console.warn('Failed to parse navigation URL:', navigationUrl, e);
      }
    });
    // Load the deep link URL
    child.loadURL(targetUrl);
  }

  // Defer showing the child window until its renderer signals UI ready,
  // with a fallback timer in case the signal never arrives.
  let childReadyToShow = false;
  child.once('ready-to-show', () => {
    childReadyToShow = true;
    // Intentionally do not show here; we wait for 'desktop:ui-ready' from this renderer.
  });
  // Fallback: if UI ready isn't signaled within 2000ms after load, show anyway
  child.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      try {
        if (!child.isDestroyed() && !child.isVisible()) {
          child.show();
        }
      } catch (_) {}
    }, 2000);
  });

  // Apply current effects (opacity) to new window as well
  child.webContents.on('did-finish-load', () => {
    try { applyWindowEffects(_currentWindowEffects); } catch (_) {}
  });

  // Note: loading performed above per mode

  // Track and clean up on close
  const id = child.id;
  _sessionWindows.set(id, { win: child, sessionId, title: title || null, index: myIndex });
  // Notify renderers that this session now has a dedicated window
  try { broadcastSessionWindowChange(sessionId, id); } catch (_) {}
  // Persist size/position for this indexed session window
  try {
    child.on('move', () => scheduleSaveSessionWindowBounds(child, myIndex, false));
    child.on('resize', () => scheduleSaveSessionWindowBounds(child, myIndex, false));
    child.on('close', () => saveSessionWindowBoundsToDiskImmediate(child, myIndex, true));
    child.on('blur', () => scheduleSaveSessionWindowBounds(child, myIndex, false));
  } catch (_) { /* ignore */ }
  child.on('closed', () => {
    try { _sessionWindows.delete(id); } catch (_) {}
    try {
      const t = _sessionWindowSaveTimers.get(id);
      if (t) { clearTimeout(t); _sessionWindowSaveTimers.delete(id); }
    } catch (_) {}
    // Notify renderers that this session's dedicated window has closed
    try { broadcastSessionWindowChange(sessionId, null); } catch (_) {}
    // If a local PTY session was owned by this window, transfer ownership back to mainWindow
    try {
      if (LOCAL_TERMINALS_ENABLED) {
        const s = _localPtySessions.get(sessionId);
        if (s && s.ownerWindowId === id && mainWindow && !mainWindow.isDestroyed()) {
          s.ownerWindowId = mainWindow.id;
          s.ownerWebContentsId = mainWindow.webContents ? mainWindow.webContents.id : s.ownerWebContentsId;
          s.ownershipSeq = (Number(s.ownershipSeq) | 0) + 1;
          try { flushNow(sessionId); } catch (_) {}
        }
      }
    } catch (_) { /* ignore */ }
  });

  return child;
}

// Create application menu
function createMenu() {
  // On Windows, we don't use an application menu. Remove it entirely.
  if (process.platform === 'win32') {
    try { Menu.setApplicationMenu(null); } catch (_) {}
    return;
  }
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Terminal',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.executeJavaScript(`
                if (window.app && window.app.modules && window.app.modules.terminal) {
                  window.app.modules.terminal.createNewSession();
                }
              `);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectall' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => setZoomAll(1)
        },
        {
          label: 'Zoom In',
          accelerator: process.platform === 'darwin' ? 'CmdOrCtrl+Plus' : 'CmdOrCtrl+=',
          click: () => adjustZoomAll(0.1)
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => adjustZoomAll(-0.1)
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Session Manager',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Session Manager',
              message: 'Session Manager Desktop',
              detail: 'A desktop application for managing terminal sessions.\n\nBuilt with Electron and the Session Manager web application.'
            });
          }
        },
        {
          label: 'Learn More',
          click: () => {
            shell.openExternal('https://github.com/your-repo/terminal-manager');
          }
        }
      ]
    }
  ];

  // macOS specific menu adjustments
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideothers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });

    // Window menu
    template[4].submenu = [
      { role: 'close' },
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { role: 'front' }
    ];
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// -----------------------------
// Global Zoom Controls
// -----------------------------

function getFocusedOrMainWindow() {
  try {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) return focused;
  } catch (_) {}
  try { if (mainWindow && !mainWindow.isDestroyed()) return mainWindow; } catch (_) {}
  return null;
}

function getZoomFactor(win) {
  try { return Number(win?.webContents?.getZoomFactor?.()) || 1; } catch (_) { return 1; }
}

function clampZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.3, Math.min(3, n));
}

function setZoomAll(factor) {
  const z = clampZoom(factor);
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents?.setZoomFactor?.(z); } catch (_) {}
    }
  } catch (_) {}
}

function adjustZoomAll(delta) {
  const baseWin = getFocusedOrMainWindow();
  const current = baseWin ? getZoomFactor(baseWin) : 1;
  const next = clampZoom(current + (Number(delta) || 0));
  setZoomAll(next);
}

// App event handlers
app.whenReady().then(() => {
  createWindow();
  createMenu();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// -----------------------------
// Fullscreen IPC (renderer <-> main)
// -----------------------------

ipcMain.handle('desktop:get-fullscreen', async (evt) => {
  try {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const fs = !!(win && typeof win.isFullScreen === 'function' && win.isFullScreen());
    return { ok: true, fullscreen: fs };
  } catch (e) {
    return { ok: false, fullscreen: false };
  }
});

ipcMain.handle('desktop:set-fullscreen', async (evt, enable) => {
  try {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win) return { ok: false };
    const next = !!enable;
    win.setFullScreen(next);
    return { ok: true, fullscreen: next };
  } catch (e) {
    return { ok: false };
  }
});

ipcMain.handle('desktop:toggle-fullscreen', async (evt) => {
  try {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win) return { ok: false };
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return { ok: true, fullscreen: next };
  } catch (e) {
    return { ok: false };
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  // Forward console output from any WebContents (window, webview, etc.)
  try {
    contents.on('console-message', (e, level, message, line, sourceId) => {
      const type = (typeof contents.getType === 'function' ? contents.getType() : 'unknown');
      const levelMap = { 0: 'log', 1: 'warn', 2: 'error', 3: 'debug', 4: 'info' };
      const lvl = levelMap[level] || String(level);
      const src = sourceId ? `${sourceId}:${line}` : `line ${line}`;
      const prefix = `[renderer:${type}:${lvl}]`;
      if (lvl === 'error') {
        console.error(prefix, message, `(${src})`);
      } else if (lvl === 'warn') {
        console.warn(prefix, message, `(${src})`);
      } else if (lvl === 'debug') {
        console.debug(prefix, message, `(${src})`);
      } else if (lvl === 'info') {
        console.info(prefix, message, `(${src})`);
      } else {
        console.log(prefix, message, `(${src})`);
      }
    });

    // Also surface navigation failures from renderer/webview
    contents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const type = (typeof contents.getType === 'function' ? contents.getType() : 'unknown');
      console.error(`[renderer:${type}] did-fail-load`, {
        errorCode, errorDescription, validatedURL, isMainFrame
      });
    });
  } catch (_) {}

  // Note: DevTools is opened via Settings control; no global context-menu inspect.

  // Security: prevent new window creation; route to external browser
  contents.on('new-window', (event, navigationUrl) => {
    event.preventDefault();
    if (isAllowedExternalUrl(navigationUrl)) {
      shell.openExternal(navigationUrl);
    } else {
      console.warn('Blocked new-window to disallowed scheme:', navigationUrl);
    }
  });
});

// URL allowlist for external opening
function isAllowedExternalUrl(urlStr) {
  try {
    const u = new URL(String(urlStr));
    const p = String(u.protocol || '').toLowerCase();
    return p === 'http:' || p === 'https:' || p === 'mailto:';
  } catch (_) {
    // Fallback simple check for mailto: without full URL parsing
    try { return String(urlStr).toLowerCase().startsWith('mailto:'); } catch (_) { return false; }
  }
}

// IPC handlers for renderer requests
  ipcMain.handle('desktop:apply-font-settings-all', async (_evt, payload) => {
  try {
    const size = Number.isFinite(payload?.fontSize) ? Math.max(6, Math.min(64, Math.floor(payload.fontSize))) : 14;
    const fam = typeof payload?.fontFamily === 'string' ? payload.fontFamily : 'monospace';
    const js = `try { if (window.app && window.app.modules && window.app.modules.terminal && typeof window.app.modules.terminal.updateAllTerminalFonts === 'function') { window.app.modules.terminal.updateAllTerminalFonts(${size}, ${JSON.stringify(fam)}); } } catch (_) {}`;
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (w && !w.isDestroyed()) await w.webContents.executeJavaScript(js, true).catch(() => {}); } catch (_) {}
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'unexpected-error' };
  }
});
  ipcMain.handle('desktop:open-devtools', async () => {
  try {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    return true;
  } catch (e) {
    console.error('Failed to open DevTools via IPC:', e);
    return false;
  }
});

// IPC: query dedicated window for a session
ipcMain.handle('desktop:get-session-window', async (_evt, payload) => {
  try {
    const sessionId = (payload && typeof payload.sessionId === 'string') ? payload.sessionId.trim() : '';
    if (!sessionId) return { ok: false, error: 'invalid-session-id' };
    const found = findSessionWindow(sessionId);
    return { ok: true, windowId: found && found.win ? found.win.id : null };
  } catch (e) {
    return { ok: false, error: 'unexpected-error' };
  }
});

// IPC: focus dedicated window for a session (if present)
ipcMain.handle('desktop:focus-session-window', async (_evt, payload) => {
  try {
    const sessionId = (payload && typeof payload.sessionId === 'string') ? payload.sessionId.trim() : '';
    if (!sessionId) return { ok: false, error: 'invalid-session-id' };
    const found = findSessionWindow(sessionId);
    if (found && found.win && !found.win.isDestroyed()) {
      try {
        const isMin = typeof found.win.isMinimized === 'function' ? found.win.isMinimized() : false;
        const isVis = typeof found.win.isVisible === 'function' ? found.win.isVisible() : true;
        if (isMin) {
          try { found.win.restore(); } catch (_) {}
        }
        if (!isVis) {
          try { found.win.show(); } catch (_) {}
        }
        try { if (typeof found.win.moveTop === 'function') found.win.moveTop(); } catch (_) {}
        try { found.win.focus(); } catch (_) {}
      } catch (_) {}
      return { ok: true, windowId: found.win.id, focused: true };
    }
    return { ok: true, windowId: null, focused: false };
  } catch (e) {
    return { ok: false, error: 'unexpected-error' };
  }
});

// IPC: focus the main window (restore/show/moveTop/focus)
ipcMain.handle('desktop:focus-main-window', async () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const isMin = typeof mainWindow.isMinimized === 'function' ? mainWindow.isMinimized() : false;
        const isVis = typeof mainWindow.isVisible === 'function' ? mainWindow.isVisible() : true;
        if (isMin) {
          try { mainWindow.restore(); } catch (_) {}
        }
        if (!isVis) {
          try { mainWindow.show(); } catch (_) {}
        }
        try { if (typeof mainWindow.moveTop === 'function') mainWindow.moveTop(); } catch (_) {}
        try { mainWindow.focus(); } catch (_) {}
        return { ok: true, focused: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }
    return { ok: false, error: 'no-main-window' };
  } catch (e) {
    return { ok: false, error: 'unexpected-error' };
  }
});

// IPC: update the session association for the current BrowserWindow (used by dedicated windows)
ipcMain.handle('desktop:set-window-session', async (evt, payload) => {
  try {
    const sessionId = (payload && typeof payload.sessionId === 'string') ? payload.sessionId.trim() : '';
    if (!sessionId) return { ok: false, error: 'invalid-session-id' };
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: 'no-window' };
    // Ignore main window: mapping is only for secondary windows
    if (mainWindow && win.id === mainWindow.id) return { ok: true, ignored: true };
    const id = win.id;
    const existing = _sessionWindows.get(id) || { win, sessionId: null, title: null, index: null };
    const oldSessionId = existing.sessionId || null;
    if (oldSessionId === sessionId) return { ok: true, unchanged: true };
    _sessionWindows.set(id, { win, sessionId, title: existing.title || null, index: existing.index });
    try { if (oldSessionId) broadcastSessionWindowChange(oldSessionId, null); } catch (_) {}
    try { broadcastSessionWindowChange(sessionId, id); } catch (_) {}

    // If a local PTY session with this id exists, transfer ownership to this renderer automatically
    try {
      if (LOCAL_TERMINALS_ENABLED) {
        const s = _localPtySessions.get(sessionId);
        if (s) {
          // Update both window and webContents ownership so flush/send targets this window
          const ownerWcId = evt?.sender?.id || s.ownerWebContentsId;
          const ownerWin = (() => { try { return BrowserWindow.fromWebContents(evt.sender); } catch (_) { return null; } })();
          const ownerWindowId = ownerWin && Number.isFinite(ownerWin.id) ? ownerWin.id : s.ownerWindowId;
          s.ownerWebContentsId = ownerWcId;
          s.ownerWindowId = ownerWindowId;
          s.ownershipSeq = (Number(s.ownershipSeq) | 0) + 1;
          // Emit updated event to refresh dynamic title for the new owner
          try {
            if (s.dynamicTitle) {
              const { webContents } = require('electron');
              const wc = s.ownerWebContentsId ? webContents.fromId(s.ownerWebContentsId) : null;
              if (wc && !wc.isDestroyed()) {
                wc.send('desktop:localpty-updated', { sessionId, dynamic_title: s.dynamicTitle });
              }
            }
          } catch (_) { /* ignore */ }
          // Flush any buffered output to the new owner immediately
          try { flushNow(sessionId); } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
    return { ok: true, windowId: id, sessionId };
  } catch (e) {
    return { ok: false, error: 'unexpected-error' };
  }
});

// IPC: cross-window drag tracking for sessions
ipcMain.handle('desktop:drag-start-session', async (_evt, payload) => {
  try {
    const sessionId = (payload && typeof payload.sessionId === 'string') ? payload.sessionId.trim() : '';
    const clientId = (payload && typeof payload.clientId === 'string') ? payload.clientId.trim() : '';
    if (!sessionId) return { ok: false, error: 'invalid-session-id' };
    _globalSessionDrag = { sessionId, clientId: clientId || null, startedAt: Date.now() };
    return { ok: true };
  } catch (e) { return { ok: false, error: 'unexpected-error' }; }
});

ipcMain.handle('desktop:drag-end-session', async () => {
  try { _globalSessionDrag = { sessionId: null, clientId: null, startedAt: 0 }; return { ok: true }; }
  catch (e) { return { ok: false, error: 'unexpected-error' }; }
});

ipcMain.handle('desktop:drag-get-session', async () => {
  try {
    const now = Date.now();
    const isStale = _globalSessionDrag && _globalSessionDrag.startedAt && (now - _globalSessionDrag.startedAt > 15000);
    if (isStale) {
      _globalSessionDrag = { sessionId: null, clientId: null, startedAt: 0 };
      return { ok: true, drag: null };
    }
    return { ok: true, drag: Object.assign({}, _globalSessionDrag) };
  }
  catch (e) { return { ok: false, error: 'unexpected-error' }; }
});

// IPC: close dedicated window for a session (if present)
ipcMain.handle('desktop:close-session-window', async (_evt, payload) => {
  try {
    const sessionId = (payload && typeof payload.sessionId === 'string') ? payload.sessionId.trim() : '';
    if (!sessionId) return { ok: false, error: 'invalid-session-id' };
    const found = findSessionWindow(sessionId);
    if (found && found.win && !found.win.isDestroyed()) {
      const id = found.win.id;
      try { found.win.close(); } catch (_) {}
      try { _sessionWindows.delete(id); } catch (_) {}
      try { broadcastSessionWindowChange(sessionId, null); } catch (_) {}
      return { ok: true, closed: true };
    }
    return { ok: true, closed: false };
  } catch (e) {
    return { ok: false, error: 'unexpected-error' };
  }
});

// IPC: open external URL in default browser
  ipcMain.handle('desktop:open-external', async (_evt, navigationUrl) => {
  try {
    if (typeof navigationUrl === 'string' && navigationUrl.trim().length > 0) {
      if (!isAllowedExternalUrl(navigationUrl)) {
        console.warn('Blocked external open (scheme not allowed):', navigationUrl);
        return false;
      }
      await shell.openExternal(navigationUrl);
      return true;
    }
  } catch (e) {
    console.error('Failed to open external link via IPC:', navigationUrl, e);
  }
  return false;
});

// IPC: open a local path in the native file explorer (Finder/Explorer/etc.)
ipcMain.handle('desktop:open-path', async (_evt, targetPath) => {
  try {
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return { ok: false, error: 'invalid-path' };
    }
    const normalized = path.normalize(targetPath.trim());
    // Security: reject path traversal attempts
    if (/(^|[\\/])\.\.(?:[\\/]|$)/.test(normalized)) {
      return { ok: false, error: 'path-traversal-rejected' };
    }
    // Require absolute path
    if (!path.isAbsolute(normalized)) {
      return { ok: false, error: 'path-must-be-absolute' };
    }
    // Use shell.openPath to open in native file manager
    const result = await shell.openPath(normalized);
    // shell.openPath returns empty string on success, error message otherwise
    if (result === '') {
      return { ok: true };
    }
    return { ok: false, error: result || 'open-failed' };
  } catch (e) {
    console.error('[main] desktop:open-path error:', e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

// IPC: enumerate installed system fonts (used by Settings -> Display)
  ipcMain.handle('desktop:list-fonts', async () => {
  try {
    const fonts = listSystemFonts();
    return { ok: true, fonts };
  } catch (e) {
    return { ok: false, fonts: [], error: String(e && e.message ? e.message : e) };
  }
});

// IPC: renderer signals that UI is ready to be shown
  ipcMain.on('desktop:ui-ready', (evt) => {
  try {
    const senderWin = BrowserWindow.fromWebContents(evt.sender);
    if (senderWin && !senderWin.isDestroyed()) {
      // If this signal is from the main window, use the main gating logic
      if (mainWindow && senderWin.id === mainWindow.id) {
        _rendererUiReady = true;
        if (!mainWindow.isVisible() && _readyToShowFired) {
          try { clearTimeout(_showFallbackTimer); } catch (_) {}
          _showFallbackTimer = null;
          mainWindow.show();
          if (autoOpenDevTools) {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
          }
        }
        return;
      }
      // Otherwise, this is a dedicated (child) window; show it now
      if (!senderWin.isVisible()) {
        try { senderWin.show(); } catch (_) {}
      }
      return;
    }
  } catch (_) { /* ignore */ }
});

// IPC: open a new window focused on a specific session
ipcMain.handle('desktop:open-session-window', async (_evt, payload) => {
  try {
    const sessionId = (payload && typeof payload.sessionId === 'string') ? payload.sessionId.trim() : '';
    const title = (payload && typeof payload.title === 'string') ? payload.title.trim() : '';
    if (!sessionId) return { ok: false, error: 'invalid-session-id' };
    // If a window for this session already exists, focus it
    try {
      const existing = Array.from(_sessionWindows.values()).find(w => w && w.sessionId === sessionId && w.win && !w.win.isDestroyed());
      if (existing) {
        try { existing.win.show(); existing.win.focus(); } catch (_) {}
        return { ok: true, windowId: existing.win.id, focused: true };
      }
    } catch (_) { /* continue to create */ }
    const win = createSessionWindow({ sessionId, title });
    return { ok: true, windowId: win.id };
  } catch (e) {
    console.error('Failed to open session window:', e && (e.message || e));
    return { ok: false, error: 'failed-to-open-window' };
  }
});

// IPC: get/set Allow Insecure Certificates (runtime)
ipcMain.handle('desktop:get-allow-insecure-certs', async () => {
  return !!runtimeAllowInvalidCerts;
});

ipcMain.handle('desktop:set-allow-insecure-certs', async (_evt, enable) => {
  runtimeAllowInvalidCerts = !!enable;
  return runtimeAllowInvalidCerts;
});

// Handle certificate errors
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // Allow only when the runtime flag is enabled (env or persisted setting)
  if (runtimeAllowInvalidCerts) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
});

console.log('Session Manager Desktop starting...');
console.log('Development mode:', isDev);
const configEnv = String(process.env.CONFIG_ENV || process.env.NODE_ENV || 'production');
console.log('Config environment:', configEnv);
console.log('Allow invalid certificates:', runtimeAllowInvalidCerts);

// Utilities to manage desktop window visual effects (opacity)
function setWindowOpacityFor(win, opacity) {
  const o = Math.max(0.2, Math.min(1, Number(opacity) || 1));
  try { if (win && typeof win.setOpacity === 'function') win.setOpacity(o); } catch (_) {}
  // Fallback: apply to terminal content area only via JS (for platforms where window opacity is a no-op)
  try {
    if (win && win.webContents) {
      const js = `
        (function(){
          var targetOpacity = ${o.toFixed(3)};
          function apply(){
            try {
              var el = document.getElementById('terminal-content-area');
              if (el) { el.style.opacity = targetOpacity; el.style.pointerEvents = 'auto'; return true; }
            } catch (_) {}
            setTimeout(apply, 50);
            return false;
          }
          return apply();
        })();`;
      win.webContents.executeJavaScript(js).catch(() => {});
    }
  } catch (_) {}
}

function setWindowOpacity(opacity) {
  try { if (mainWindow && !mainWindow.isDestroyed()) setWindowOpacityFor(mainWindow, opacity); } catch (_) {}
  try {
    for (const { win } of _sessionWindows.values()) {
      if (win && !win.isDestroyed()) setWindowOpacityFor(win, opacity);
    }
  } catch (_) {}
}

async function applyWindowEffects(effects) {
  const next = Object.assign({}, _currentWindowEffects);
  if (effects && typeof effects === 'object') {
    if (effects.opacity != null) next.opacity = Math.max(0.2, Math.min(1, Number(effects.opacity) || 1));
  }
  _currentWindowEffects = next;

  // Opacity (all windows)
  setWindowOpacity(next.opacity);
}

// IPC: window visual effects
ipcMain.handle('desktop:get-window-effects', async () => {
  return Object.assign({}, _currentWindowEffects);
});

ipcMain.handle('desktop:set-window-effects', async (_evt, effects) => {
  try {
    await applyWindowEffects({ opacity: effects?.opacity });
    return true;
  } catch (e) {
    console.error('Failed to set window effects:', e);
    return false;
  }
});

// -----------------------------
// Settings persistence handlers
// -----------------------------

ipcMain.handle('desktop:settings-load', async () => {
  return persistence.readSettingsFromDisk();
});

ipcMain.on('desktop:settings-load-sync', (evt) => {
  try {
    evt.returnValue = persistence.readSettingsFromDisk();
  } catch (e) {
    evt.returnValue = { ok: false, error: persistence.formatError(e) };
  }
});

ipcMain.handle('desktop:settings-save', async (_evt, data) => {
  return persistence.writeSettingsToDisk(data);
});

ipcMain.handle('desktop:settings-path', async () => {
  return persistence.getSettingsFilePath();
});

ipcMain.handle('desktop:settings-export', async (_evt, data) => {
  return persistence.exportSettings(mainWindow, data);
});

ipcMain.handle('desktop:settings-import', async () => {
  return persistence.importSettings(mainWindow);
});

// Save a blob/file to disk with a save dialog
ipcMain.handle('desktop:save-blob-file', async (evt, payload) => {
  try {
    const { filename, data, mimeType } = payload || {};
    if (!filename || typeof data !== 'string') {
      return { ok: false, error: 'missing-params' };
    }
    // data should be a base64 string
    const buffer = Buffer.from(data, 'base64');
    // Get the window that made the request
    const sender = evt && evt.sender ? evt.sender : null;
    const win = sender ? BrowserWindow.fromWebContents(sender) : mainWindow;
    // Show save dialog (let OS remember last used directory)
    const result = await dialog.showSaveDialog(win, {
      defaultPath: filename,
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    // Write the file
    fs.writeFileSync(result.filePath, buffer);
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    console.error('[main] desktop:save-blob-file error:', e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

// Save a blob/file to temp directory and open it with default app
ipcMain.handle('desktop:download-and-open', async (evt, payload) => {
  try {
    const { filename, data } = payload || {};
    if (!filename || typeof data !== 'string') {
      return { ok: false, error: 'missing-params' };
    }
    // data should be a base64 string
    const buffer = Buffer.from(data, 'base64');
    // Create temp subdirectory for TermStation files
    const tempDir = path.join(app.getPath('temp'), 'termstation-workspace');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    // Generate unique filename with counter if exists
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let finalPath = path.join(tempDir, filename);
    let counter = 0;
    while (fs.existsSync(finalPath)) {
      counter++;
      finalPath = path.join(tempDir, `${base} (${counter})${ext}`);
    }
    // Write the file
    fs.writeFileSync(finalPath, buffer);
    // Open with default application using file:// URL (matches Finder behavior better)
    const fileUrl = url.pathToFileURL(finalPath).href;
    await shell.openExternal(fileUrl);
    return { ok: true, filePath: finalPath };
  } catch (e) {
    console.error('[main] desktop:download-and-open error:', e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

// Reload the current window on request from renderer (safe hard reload)
ipcMain.handle('desktop:reload-window', async (evt) => {
  try {
    // Prefer reloading the window that initiated the request
    const sender = evt && evt.sender ? evt.sender : null;
    const win = sender ? BrowserWindow.fromWebContents(sender) : null;
    if (win && !win.isDestroyed()) {
      // Mark this renderer as reloaded-after-restart so it can adjust behavior on boot
      try { await win.webContents.executeJavaScript("try { sessionStorage.setItem('tm_post_restart_reload','1'); } catch (_) {}", true); } catch (_) {}
      win.reload();
      return true;
    }
    // Fallback to main window if sender is unavailable
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { await mainWindow.webContents.executeJavaScript("try { sessionStorage.setItem('tm_post_restart_reload','1'); } catch (_) {}", true); } catch (_) {}
      mainWindow.reload();
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
});

// -----------------------------
// Cookie persistence (for API auth)
// -----------------------------

function originFromBaseUrl(baseUrl) {
  try {
    const raw = typeof baseUrl === 'string' ? baseUrl.trim() : String(baseUrl || '');
    if (!raw) return null;
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

const formatCookieError = (error) => {
  try {
    if (!error) return 'unexpected-error';
    return String(error && error.message ? error.message : error);
  } catch (_) {
    return 'unexpected-error';
  }
};

const runWithCookieOrigin = async (baseUrl, handler) => {
  const origin = originFromBaseUrl(baseUrl);
  if (!origin) return { ok: false, error: 'invalid-origin' };
  try {
    return await handler(origin);
  } catch (error) {
    return { ok: false, error: formatCookieError(error) };
  }
};

  ipcMain.handle('desktop:cookies-save', async (_evt, baseUrl) => {
  return runWithCookieOrigin(baseUrl, async (origin) => {
    const cookies = await session.defaultSession.cookies.get({ url: origin });
    const minimal = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate
    }));
    const stateRes = persistence.readStateFromDisk();
    const state = stateRes && stateRes.ok ? (stateRes.state || {}) : {};
    state.auth_cookies = state.auth_cookies || {};
    state.auth_cookies[origin] = minimal;
    const wr = persistence.writeStateToDisk(state);
    if (!wr || !wr.ok) return { ok: false, error: (wr && wr.error) || 'write-failed' };
    return { ok: true, count: minimal.length };
  });
});

// IPC: expose app version to preload/renderer without touching page globals
try {
  ipcMain.on('desktop:get-app-version-sync', (evt) => {
    try { evt.returnValue = app.getVersion ? app.getVersion() : ''; }
    catch (_) { try { evt.returnValue = ''; } catch (_) {} }
  });
} catch (_) { /* ignore */ }

ipcMain.handle('desktop:cookies-restore', async (_evt, baseUrl) => {
  return runWithCookieOrigin(baseUrl, async (origin) => {
    const sr = persistence.readStateFromDisk();
    if (!sr || !sr.ok) return { ok: false, error: 'state-read-failed' };
    const cookies = (sr.state && sr.state.auth_cookies && sr.state.auth_cookies[origin]) || [];
    for (const c of cookies) {
      try {
        await session.defaultSession.cookies.set({
          url: origin,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate && isFinite(c.expirationDate) ? c.expirationDate : (Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30)
        });
      } catch (_) { /* continue */ }
    }
    return { ok: true, count: cookies.length };
  });
});

ipcMain.handle('desktop:cookies-clear', async (_evt, baseUrl) => {
  return runWithCookieOrigin(baseUrl, async (origin) => {
    const sr = persistence.readStateFromDisk();
    let state = (sr && sr.ok && sr.state) ? sr.state : {};
    if (state.auth_cookies && state.auth_cookies[origin]) {
      try { delete state.auth_cookies[origin]; } catch (_) {}
      persistence.writeStateToDisk(state);
    }
    const cookies = await session.defaultSession.cookies.get({ url: origin });
    for (const c of cookies) {
      try {
        await session.defaultSession.cookies.remove(origin, c.name);
      } catch (_) { /* ignore */ }
    }
    return { ok: true };
  });
});

// -----------------------------
// State persistence handlers
// -----------------------------

ipcMain.handle('desktop:state-load', async () => persistence.readStateFromDisk());
ipcMain.on('desktop:state-load-sync', (evt) => {
  try {
    evt.returnValue = persistence.readStateFromDisk();
  } catch (e) {
    evt.returnValue = { ok: false, error: persistence.formatError(e) };
  }
});
ipcMain.handle('desktop:state-save', async (_evt, data) => persistence.writeStateToDisk(data));
ipcMain.handle('desktop:state-path', async () => persistence.getStateFilePath());

ipcMain.handle('desktop:state-export', async (_evt, data) => {
  return persistence.exportState(mainWindow, data);
});

ipcMain.handle('desktop:state-import', async () => {
  return persistence.importState(mainWindow);
});

// -----------------------------
// Local PTY IPC (feature-flag guarded)
// -----------------------------

function isOwner(evt, sessionId) {
  try {
    const s = _localPtySessions.get(sessionId);
    if (!s) return false;
    const win = evt && evt.sender ? BrowserWindow.fromWebContents(evt.sender) : null;
    const senderWindowId = win && Number.isFinite(win.id) ? win.id : null;
    return senderWindowId && s.ownerWindowId === senderWindowId;
  } catch (_) { return false; }
}

function buildSpawnTarget(command) {
  const shellPath = resolveDefaultShell();
  const cmd = (typeof command === 'string') ? command.trim() : '';
  // No explicit command: start an interactive login shell for POSIX; default shell for Windows.
  if (!cmd) {
    if (process.platform === 'win32') {
      return { file: shellPath, args: [] };
    }
    // Use login shell so PATH and login env are loaded (zsh/bash -l)
    return { file: shellPath, args: ['-l'] };
  }
  // Non-empty command: wrap via shell execution
  if (process.platform === 'win32') return { file: shellPath, args: ['/c', cmd] };
  return { file: shellPath, args: ['-c', cmd] };
}

if (LOCAL_TERMINALS_ENABLED) {
  // Create
  ipcMain.handle('desktop:localpty-create', async (evt, payload) => {
    if (!LOCAL_TERMINALS_ENABLED) return { ok: false, error: 'feature-disabled' };
    if (!lazyLoadNodePty()) return { ok: false, error: 'node-pty-unavailable' };
    try {
      const cols = Math.max(2, Math.min(5000, Number(payload && payload.cols) || 80));
      const rows = Math.max(2, Math.min(2000, Number(payload && payload.rows) || 24));
      const cwd = validateCwd(payload && payload.cwd);
      const env = sanitizeEnv(payload && payload.env, cols, rows);
      const { file, args } = buildSpawnTarget(payload && payload.command);

      const sessionId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      let ownerWindowId = null;
      try { const win = BrowserWindow.fromWebContents(evt.sender); ownerWindowId = win && Number.isFinite(win.id) ? win.id : null; } catch (_) { ownerWindowId = null; }

      const pty = _nodePty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        handleFlowControl: true
      });
      const state = {
        pty,
        ownerWindowId: ownerWindowId,
        createdAt,
        pid: pty.pid,
        buffers: { data: '', size: 0 },
        flushTimer: null,
        flushIntervalMs: 16,
        oscBuffer: '',
        dynamicTitle: '',
        // Ownership tracking and buffer retention controls
        ownershipSeq: 0,
        noOwnerSince: null,
        noOwnerCleanupTimer: null
      };
      _localPtySessions.set(sessionId, state);

      const MAX_OUTPUT_BUFFER = 1024 * 1024; // 1MB cap for buffered output per session
      pty.onData((data) => {
        try {
          const s = _localPtySessions.get(sessionId);
          if (!s) return;
          const str = (typeof data === 'string') ? data : String(data || '');
          s.buffers.data += str;
          s.buffers.size += Buffer.byteLength(str, 'utf8');
          // Apply cap: drop oldest data when exceeding limit
          if (s.buffers.size > MAX_OUTPUT_BUFFER) {
            // Retain last half to reduce churn
            const keepBytes = Math.floor(MAX_OUTPUT_BUFFER / 2);
            const current = Buffer.from(s.buffers.data, 'utf8');
            const slice = current.slice(current.length - keepBytes);
            s.buffers.data = slice.toString('utf8');
            s.buffers.size = Buffer.byteLength(s.buffers.data, 'utf8');
          }
          const maybeTitle = parseOscTitleFromChunk(s, str);
          if (maybeTitle) {
            try {
              const win = s.ownerWindowId ? BrowserWindow.fromId(s.ownerWindowId) : null;
              const wc = win && !win.isDestroyed() ? win.webContents : null;
              if (wc && !wc.isDestroyed()) {
                wc.send('desktop:localpty-updated', { sessionId, dynamic_title: s.dynamicTitle });
              }
            } catch (_) { /* ignore */ }
          }
          if (s.buffers.size >= 4096) {
            flushNow(sessionId);
          } else {
            scheduleFlush(sessionId);
          }
        } catch (_) { /* ignore */ }
      });

      pty.onExit(({ exitCode, signal }) => {
        try { flushNow(sessionId); } catch (_) {}
        try {
          const s = _localPtySessions.get(sessionId);
          // Cancel any pending SIGKILL timer
          try { if (s && s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; } } catch (_) {}
          // Notify owner renderer
          try {
            const win = s && s.ownerWindowId ? BrowserWindow.fromId(s.ownerWindowId) : null;
            const wc = win && !win.isDestroyed() ? win.webContents : null;
            if (wc && !wc.isDestroyed()) {
              wc.send('desktop:localpty-exit', { sessionId, code: exitCode, signal });
            }
          } catch (_) { /* ignore */ }
          // Broadcast to all windows so non-owners (e.g., main window) can update UI state
          try {
            for (const w of BrowserWindow.getAllWindows()) {
              try { w.webContents.send('desktop:localpty-exit', { sessionId, code: exitCode, signal }); } catch (_) {}
            }
          } catch (_) { /* ignore */ }
        } catch (_) { /* ignore */ }
        cleanupSession(sessionId);
      });

      // node-pty does not consistently emit 'error', but guard just in case
      try {
        pty.on('error', (err) => {
          try {
            const s = _localPtySessions.get(sessionId);
            const win = s && s.ownerWindowId ? BrowserWindow.fromId(s.ownerWindowId) : null;
            const wc = win && !win.isDestroyed() ? win.webContents : null;
            if (wc && !wc.isDestroyed()) {
              wc.send('desktop:localpty-error', { sessionId, error: String(err && err.message || err || 'error') });
            }
          } catch (_) { /* ignore */ }
        });
      } catch (_) { /* ignore */ }

      return { ok: true, sessionId, pid: pty.pid };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // Stdin
  ipcMain.handle('desktop:localpty-stdin', async (evt, payload) => {
    if (!LOCAL_TERMINALS_ENABLED) return { ok: false, error: 'feature-disabled' };
    const sessionId = payload && payload.sessionId;
    const s = _localPtySessions.get(sessionId);
    if (!s) return { ok: false, error: 'not-found' };
    if (!isOwner(evt, sessionId)) return { ok: false, error: 'not-owner' };
    try {
      const data = (typeof payload.data === 'string') ? payload.data : String(payload.data || '');
      s.pty.write(data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // Resize
  ipcMain.handle('desktop:localpty-resize', async (evt, payload) => {
    if (!LOCAL_TERMINALS_ENABLED) return { ok: false, error: 'feature-disabled' };
    const sessionId = payload && payload.sessionId;
    const s = _localPtySessions.get(sessionId);
    if (!s) return { ok: false, error: 'not-found' };
    if (!isOwner(evt, sessionId)) return { ok: false, error: 'not-owner' };
    try {
      const cols = Math.max(2, Math.min(5000, Number(payload && payload.cols) || 80));
      const rows = Math.max(2, Math.min(2000, Number(payload && payload.rows) || 24));
      s.pty.resize(cols, rows);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // Terminate
  ipcMain.handle('desktop:localpty-terminate', async (evt, payload) => {
    if (!LOCAL_TERMINALS_ENABLED) return { ok: false, error: 'feature-disabled' };
    const sessionId = payload && payload.sessionId;
    const s = _localPtySessions.get(sessionId);
    if (!s) return { ok: false, error: 'not-found' };
    if (!isOwner(evt, sessionId)) return { ok: false, error: 'not-owner' };
    try {
      killSession(sessionId, false);
      try { if (s.killTimer) { clearTimeout(s.killTimer); } } catch (_) {}
      s.killTimer = setTimeout(() => { try { killSession(sessionId, true); } catch (_) {} }, 1000);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // Debug list
  ipcMain.handle('desktop:localpty-list', async (evt) => {
    if (!LOCAL_TERMINALS_ENABLED) return { sessions: [] };
    try {
      let ownerWindowId = null;
      try { const win = evt && evt.sender ? BrowserWindow.fromWebContents(evt.sender) : null; ownerWindowId = win && Number.isFinite(win.id) ? win.id : null; } catch (_) {}
      const sessions = listSessions().filter(s => {
        const st = _localPtySessions.get(s.sessionId);
        return st && st.ownerWindowId === ownerWindowId;
      });
      return { sessions };
    } catch (_) {
      return { sessions: [] };
    }
  });

  // Broadcast local manual title updates across all renderer windows
  ipcMain.handle('desktop:local-title-updated', async (_evt, payload) => {
    try {
      const sessionId = (payload && typeof payload.sessionId === 'string') ? payload.sessionId.trim() : '';
      const title = (payload && typeof payload.title === 'string') ? payload.title : '';
      if (!sessionId) return { ok: false, error: 'invalid-session-id' };
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        try {
          if (win && !win.isDestroyed()) {
            win.webContents.send('desktop:local-title-updated', { sessionId, title });
          }
        } catch (_) { /* ignore */ }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'unexpected-error' };
    }
  });

  // Transfer ownership of a local PTY session to the requesting renderer
  ipcMain.handle('desktop:localpty-transfer-owner', async (evt, payload) => {
    if (!LOCAL_TERMINALS_ENABLED) return { ok: false, error: 'feature-disabled' };
    try {
      const sessionId = (payload && typeof payload.sessionId === 'string') ? payload.sessionId.trim() : '';
      if (!sessionId) return { ok: false, error: 'invalid-session-id' };
      const s = _localPtySessions.get(sessionId);
      if (!s) return { ok: false, error: 'not-found' };
      const newOwnerWcId = evt && evt.sender ? evt.sender.id : null;
      const newOwnerWin = (() => { try { return BrowserWindow.fromWebContents(evt.sender); } catch (_) { return null; } })();
      const newOwnerWindowId = newOwnerWin && Number.isFinite(newOwnerWin.id) ? newOwnerWin.id : null;
      if (!newOwnerWcId || !newOwnerWindowId) return { ok: false, error: 'no-sender' };
      // Update owner (both window and webContents) and notify new owner of current dynamic title (if any)
      s.ownerWebContentsId = newOwnerWcId;
      s.ownerWindowId = newOwnerWindowId;
      s.ownershipSeq = (Number(s.ownershipSeq) | 0) + 1;
      try {
        if (s.dynamicTitle) {
          const { webContents } = require('electron');
          const wc = webContents.fromId(newOwnerWcId);
          if (wc && !wc.isDestroyed()) {
            wc.send('desktop:localpty-updated', { sessionId, dynamic_title: s.dynamicTitle });
          }
        }
      } catch (_) { /* ignore */ }
      // Flush any buffered output to the new owner immediately
      try { flushNow(sessionId); } catch (_) { /* ignore */ }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'unexpected-error' };
    }
  });

  // Graceful shutdown on app quit (Unix: SIGTERM then SIGKILL)
  app.on('before-quit', () => {
    try {
      for (const sid of Array.from(_localPtySessions.keys())) {
        try { killSession(sid, false); } catch (_) {}
      }
      setTimeout(() => {
        for (const sid of Array.from(_localPtySessions.keys())) {
          try { killSession(sid, true); } catch (_) {}
        }
      }, 1000);
    } catch (_) { /* ignore */ }
  });

  // Cleanup sessions owned by windows that are closed (not on reload)
  app.on('browser-window-created', (_ev, win) => {
    try {
      const cleanupForWindowClosed = () => {
        try {
          const wid = win && Number.isFinite(win.id) ? win.id : null;
          if (wid == null) return;
          for (const [sid, s] of _localPtySessions.entries()) {
            if (s.ownerWindowId !== wid) continue;
            // If the main window is available, reassign ownership back to main instead of killing
            if (mainWindow && !mainWindow.isDestroyed()) {
              try {
                s.ownerWindowId = mainWindow.id;
                s.ownerWebContentsId = mainWindow.webContents ? mainWindow.webContents.id : s.ownerWebContentsId;
                s.ownershipSeq = (Number(s.ownershipSeq) | 0) + 1;
                flushNow(sid);
              } catch (_) { /* ignore */ }
            } else {
              // No main window to reassign to — terminate the PTY to avoid orphan
              try { killSession(sid, false); } catch (_) {}
              try {
                if (s.killTimer) clearTimeout(s.killTimer);
                s.killTimer = setTimeout(() => {
                  try { killSession(sid, true); } catch (_) {}
                  try { cleanupSession(sid); } catch (_) {}
                }, 1000);
              } catch (_) {}
            }
          }
        } catch (_) { /* ignore */ }
      };
      // Important: Do not kill on webContents destroyed (reload). Only when the window closes.
      win.on('closed', cleanupForWindowClosed);
    } catch (_) { /* ignore */ }
  });

  // Best-effort cleanup on unexpected errors
  process.on('uncaughtException', () => {
    try {
      for (const sid of Array.from(_localPtySessions.keys())) {
        try { killSession(sid, true); } catch (_) {}
      }
    } catch (_) {}
  });
  process.on('unhandledRejection', () => {
    try {
      for (const sid of Array.from(_localPtySessions.keys())) {
        try { killSession(sid, true); } catch (_) {}
      }
    } catch (_) {}
  });
} else {
  // Handlers return disabled when feature flag is off
  const disabled = async () => ({ ok: false, error: 'feature-disabled' });
  ipcMain.handle('desktop:localpty-create', disabled);
  ipcMain.handle('desktop:localpty-stdin', disabled);
  ipcMain.handle('desktop:localpty-resize', disabled);
  ipcMain.handle('desktop:localpty-terminate', disabled);
  ipcMain.handle('desktop:localpty-list', async () => ({ sessions: [] }));
}

// -----------------------------
// UDS HTTP bridge (desktop only)
// -----------------------------

function buildCookieHeaderFromJar(origin) {
  try {
    const list = session.defaultSession.cookies.get({ url: origin });
    // cookies.get returns a Promise
    return Promise.resolve(list).then((cookies) => {
      try {
        const parts = [];
        for (const c of cookies) {
          if (!c || !c.name) continue;
          parts.push(`${c.name}=${c.value || ''}`);
        }
        return parts.join('; ');
      } catch (_) { return ''; }
    });
  } catch (_) {
    return Promise.resolve('');
  }
}

function parseSetCookie(headerValue) {
  // Minimal parser to extract name/value and attributes we care about
  try {
    const raw = String(headerValue || '');
    const parts = raw.split(/;\s*/);
    if (!parts.length) return null;
    const [nv, ...attrs] = parts;
    const eq = nv.indexOf('=');
    if (eq <= 0) return null;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1);
    const out = { name, value, httpOnly: false, secure: false, sameSite: 'lax', path: '/', expirationDate: undefined };
    for (const a of attrs) {
      const [kRaw, vRaw] = a.split('=');
      const k = String(kRaw || '').trim().toLowerCase();
      const v = (vRaw == null) ? '' : String(vRaw).trim();
      if (k === 'httponly') out.httpOnly = true;
      else if (k === 'secure') out.secure = true;
      else if (k === 'samesite') out.sameSite = (/^strict$/i.test(v) ? 'strict' : (/^none$/i.test(v) ? 'no_restriction' : 'lax'));
      else if (k === 'path' && v) out.path = v;
      else if (k === 'expires' && v) {
        const t = Date.parse(v);
        if (Number.isFinite(t)) out.expirationDate = Math.floor(t / 1000);
      }
    }
    return out;
  } catch (_) { return null; }
}

const BRIDGE_COOKIE_ORIGIN = 'http://local';

ipcMain.handle('desktop:http-request', async (_evt, options) => {
  try {
    const opts = (options && typeof options === 'object') ? options : {};
    const socketPath = String(opts.socketPath || '').trim();
    const method = String(opts.method || 'GET').toUpperCase();
    let reqPath = String(opts.path || '/');
    if (!reqPath.startsWith('/')) reqPath = '/' + reqPath;
    const headers = Object.assign({}, opts.headers || {});
    // Ensure Host header for backend expectations
    if (!headers.Host && !headers.host) headers.Host = 'local';
    // Attach cookies from Electron jar unless explicitly provided
    const jarCookie = await buildCookieHeaderFromJar(BRIDGE_COOKIE_ORIGIN);
    if (jarCookie && !headers.Cookie && !headers.cookie) {
      headers.Cookie = jarCookie;
    }
    const body = (typeof opts.body === 'string') ? opts.body : undefined;

    const reqOptions = { socketPath, path: reqPath, method, headers, timeout: 30000 }; // 30s default

    const resData = await new Promise((resolve, reject) => {
      const req = httpRequest(reqOptions, (res) => {
        const chunks = [];
        res.setEncoding('utf8');
        res.on('data', (c) => chunks.push(c));
        res.on('end', async () => {
          // Persist Set-Cookie into Electron jar for subsequent requests
          try {
            const setCookie = res.headers['set-cookie'];
            const arr = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
            for (const line of arr) {
              const parsed = parseSetCookie(line);
              if (parsed && parsed.name) {
                await session.defaultSession.cookies.set({
                  url: BRIDGE_COOKIE_ORIGIN,
                  name: parsed.name,
                  value: parsed.value,
                  path: parsed.path || '/',
                  secure: !!parsed.secure,
                  httpOnly: !!parsed.httpOnly,
                  sameSite: parsed.sameSite || 'lax',
                  expirationDate: parsed.expirationDate
                });
              }
            }
          } catch (_) { /* ignore cookie set errors */ }

          resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: chunks.join('') });
        });
      });
      req.on('error', (err) => reject(err));
      req.on('timeout', () => { try { req.destroy(new Error('ETIMEDOUT')); } catch (_) {} });
      if (body != null) req.write(body);
      req.end();
    });

    return { ok: resData.status >= 200 && resData.status < 400, status: resData.status, headers: resData.headers, body: resData.body };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// -----------------------------
// UDS WebSocket bridge (desktop only)
// -----------------------------

const _wsConnections = new Map(); // id -> { ws, ownerWcId }

// -----------------------------
// HTTP API WebSocket proxy (desktop local frontend only)
// -----------------------------

function attachApiWebSocketProxy(server) {
  let WebSocketImpl = null;
  let WebSocketServer = null;
  try {
    const wsMod = require('ws');
    WebSocketImpl = wsMod.WebSocket || wsMod;
    WebSocketServer = wsMod.WebSocketServer || wsMod.Server;
  } catch (_) {
    return; // ws module not available; skip WS proxy
  }

  if (!WebSocketServer || !WebSocketImpl) return;

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (client, req) => {
    const cfg = getApiProxyConfig();
    if (!cfg || !cfg.enabled || !cfg.target) {
      try { client.close(1011, 'API proxy not configured'); } catch (_) {}
      return;
    }
    const target = cfg.target;
    const basePath = cfg.basePath || '';
    const reqUrl = req && typeof req.url === 'string' ? req.url : '/';
    let upstreamPath = '/ws';
    try {
      const parsed = url.parse(reqUrl);
      upstreamPath = (basePath || '') + (parsed.pathname || '/ws') + (parsed.search || '');
    } catch (_) {
      upstreamPath = (basePath || '') + reqUrl;
    }

    const upstreamUrl = `ws://${target.host}${upstreamPath}`;
    const headers = Object.assign({}, req.headers || {});
    headers.host = target.host;

    let upstream;
    try {
      upstream = new WebSocketImpl(upstreamUrl, { headers });
    } catch (_) {
      try { client.close(1011, 'Upstream WS connect failed'); } catch (_) {}
      return;
    }

    if (PROXY_DEBUG) {
      try {
        console.log('[Desktop] API WS proxy connect', { upstreamUrl });
      } catch (_) {}
    }

    const safeClose = (ws, code, reason) => {
      try {
        if (ws && ws.readyState === WebSocketImpl.OPEN) {
          ws.close(code, reason);
        }
      } catch (_) {}
    };

    client.on('message', (msg) => {
      try {
        if (upstream && upstream.readyState === WebSocketImpl.OPEN) {
          upstream.send(msg);
        }
      } catch (_) {}
    });
    upstream.on('message', (msg) => {
      try {
        if (client && client.readyState === WebSocketImpl.OPEN) {
          client.send(msg);
        }
      } catch (_) {}
    });

    client.on('close', (code, reason) => {
      safeClose(upstream, code || 1000, reason || '');
    });
    upstream.on('close', (code, reason) => {
      safeClose(client, code || 1000, reason || '');
    });
    client.on('error', () => {
      safeClose(upstream, 1011, 'Client error');
    });
    upstream.on('error', () => {
      safeClose(client, 1011, 'Upstream error');
    });
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const parsed = url.parse(req.url || '/');
      if (!parsed.pathname || !parsed.pathname.startsWith('/ws/')) {
        return;
      }
      const cfg = getApiProxyConfig();
      if (!cfg || !cfg.enabled) {
        try { socket.destroy(); } catch (_) {}
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (_) {
      try { socket.destroy(); } catch (_) {}
    }
  });
}

function getOwnerWebContents(ownerWcId) {
  try { const { webContents } = require('electron'); return ownerWcId ? webContents.fromId(ownerWcId) : null; } catch (_) { return null; }
}

ipcMain.handle('desktop:ws-open', async (evt, options) => {
  const ownerWcId = evt && evt.sender ? evt.sender.id : null;
  try {
    const opts = (options && typeof options === 'object') ? options : {};
    const socketPath = String(opts.socketPath || '').trim();
    let wsPath = String(opts.path || '/');
    if (!wsPath.startsWith('/')) wsPath = '/' + wsPath;
    const headers = Object.assign({ Host: 'local' }, opts.headers || {});
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);

    let WebSocketImpl = null;
    try { WebSocketImpl = require('ws'); } catch (e) { return { ok: false, error: 'ws-module-missing' }; }

    const ws = new WebSocketImpl('ws://local' + wsPath, {
      headers,
      // Route handshake over UDS via custom createConnection
      createConnection: () => net.connect({ path: socketPath })
    });

    _wsConnections.set(id, { ws, ownerWcId });

    const forward = (type, payload) => {
      try {
        const wc = getOwnerWebContents(ownerWcId);
        if (wc && !wc.isDestroyed()) wc.send('desktop:ws-event', { id, type, payload });
      } catch (_) { /* ignore */ }
    };

    ws.on('open', () => forward('open'));
    ws.on('message', (data) => {
      let out;
      try { out = typeof data === 'string' ? data : data.toString('utf8'); } catch (_) { out = String(data); }
      forward('message', out);
    });
    ws.on('error', (err) => forward('error', String(err && err.message ? err.message : err)));
    ws.on('close', (code, reason) => {
      let r = '';
      try { r = typeof reason === 'string' ? reason : (reason ? reason.toString() : ''); } catch (_) { r = ''; }
      forward('close', { code, reason: r });
      try { _wsConnections.delete(id); } catch (_) {}
    });

    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('desktop:ws-send', async (_evt, payload) => {
  try {
    const id = String(payload && payload.id || '');
    const data = payload && payload.data != null ? payload.data : '';
    const rec = _wsConnections.get(id);
    if (!rec || !rec.ws) return { ok: false, error: 'not-found' };
    try { rec.ws.send(data); return { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  } catch (e) { return { ok: false, error: 'unexpected-error' }; }
});

ipcMain.handle('desktop:ws-close', async (_evt, payload) => {
  try {
    const id = String(payload && payload.id || '');
    const code = Number.isFinite(Number(payload && payload.code)) ? Number(payload.code) : 1000;
    const reason = String(payload && payload.reason || '');
    const rec = _wsConnections.get(id);
    if (!rec || !rec.ws) return { ok: false, error: 'not-found' };
    try { rec.ws.close(code, reason); return { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  } catch (e) { return { ok: false, error: 'unexpected-error' }; }
});

// Allow renderer to set/clear the runtime API proxy target for the current session.
ipcMain.handle('desktop:set-api-proxy-target', async (_evt, payload) => {
  try {
    const raw = payload && typeof payload.url === 'string' ? payload.url.trim() : '';
    if (!raw) {
      _runtimeApiProxyTarget = null;
      try { console.log('[Desktop] API proxy runtime target cleared'); } catch (_) {}
      return { ok: true, enabled: false };
    }
    let u;
    try { u = new URL(raw); } catch (e) {
      return { ok: false, error: 'invalid-url' };
    }
    const proto = String(u.protocol || '').toLowerCase();
    if (proto !== 'http:') {
      return { ok: false, error: 'only-http-supported' };
    }
    const basePath = (u.pathname && u.pathname !== '/') ? (u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname) : '';
    _runtimeApiProxyTarget = {
      enabled: true,
      target: u,
      basePath
    };
    try {
      console.log('[Desktop] API proxy runtime target set', {
        target: u.href,
        basePath
      });
    } catch (_) {}
    return { ok: true, enabled: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// Determine an initial background color that matches the user's theme as early as possible
function getInitialBackgroundColor() {
  let theme = null;
  try {
    const res = persistence.readSettingsFromDisk();
    if (res && res.ok && res.settings) {
      const settings = res.settings;
      let globalTheme = '';
      try {
        if (settings.ui && typeof settings.ui.theme === 'string') {
          globalTheme = String(settings.ui.theme || '').trim();
        }
      } catch (_) {}
      let overrideTheme = '';
      try {
        const ap = settings.authProfiles || {};
        const items = Array.isArray(ap.items) ? ap.items : [];
        const activeId = (ap && typeof ap.activeId === 'string') ? ap.activeId : '';
        if (activeId && items && items.length) {
          for (let i = 0; i < items.length; i += 1) {
            const p = items[i];
            if (!p || !p.id || p.id !== activeId) continue;
            const ov = p.overrides || {};
            const ui = ov.ui || {};
            if (typeof ui.theme === 'string' && ui.theme.trim() !== '') {
              overrideTheme = ui.theme.trim();
            }
            break;
          }
        }
      } catch (_) {}
      const chosen = overrideTheme || globalTheme;
      if (chosen && typeof chosen === 'string' && chosen.trim() !== '') {
        theme = chosen.trim();
      }
    }
  } catch (_) { /* ignore */ }
  const isAuto = !theme || theme === 'auto';
  const prefersDark = (() => { try { return !!nativeTheme.shouldUseDarkColors; } catch (_) { return true; } })();
  const effectiveTheme = isAuto ? (prefersDark ? 'dark' : 'light') : theme;
  const THEME_BG = {
    'dark': '#1e1e1e',
    'light': '#ffffff',
    'nord': '#2E3440',
    'dracula': '#282a36',
    'gruvbox-dark': '#282828',
    'gruvbox-light': '#fbf1c7',
    'solarized-dark': '#002b36',
    'solarized-light': '#fdf6e3',
    'monokai': '#272822',
    'tokyo-night': '#1a1b26',
    'one-dark': '#282c34',
    'night-owl': '#011627',
    'matrix': '#000000',
    'catppuccin-mocha': '#1e1e2e',
    'catppuccin-latte': '#eff1f5',
    'forest-dark': '#0f1f17',
    'forest-light': '#eaf4ec',
    'everforest-dark': '#2b3339',
    'everforest-light': '#f3f4f3'
  };
  const fromMap = THEME_BG[effectiveTheme];
  if (fromMap) return fromMap;
  return /light/i.test(effectiveTheme) ? '#ffffff' : '#1e1e1e';
}
