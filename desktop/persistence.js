const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// -----------------------------
// Utility functions
// -----------------------------

function formatError(e) {
  return String(e?.message || e);
}

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function saveJsonFile(filePath, data) {
  ensureDirectory(filePath);
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, json, 'utf8');
  return json;
}

// -----------------------------
// Settings persistence
// -----------------------------

function getSettingsFilePath() {
  try {
    const dir = app.getPath('userData');
    return path.join(dir, 'settings.json');
  } catch (_) {
    // Fallback to cwd if userData unavailable (should not happen in normal Electron runs)
    return path.join(process.cwd(), 'settings.json');
  }
}

function validateSettingsShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const keys = ['preferences', 'ui', 'api'];
  for (const k of keys) {
    if (obj[k] != null && typeof obj[k] !== 'object') return false;
  }
  return true;
}

function readSettingsFromDisk() {
  const file = getSettingsFilePath();
  try {
    if (!fs.existsSync(file)) return { ok: true, settings: null };
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!validateSettingsShape(parsed)) {
      return { ok: false, error: 'invalid-settings-shape' };
    }
    return { ok: true, settings: parsed };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

function writeSettingsToDisk(data) {
  const file = getSettingsFilePath();
  try {
    if (!validateSettingsShape(data)) {
      return { ok: false, error: 'invalid-settings-shape' };
    }
    saveJsonFile(file, data);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

async function exportSettings(mainWindow, data) {
  try {
    const defaultPath = getSettingsFilePath();
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Settings',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled) return { ok: false, canceled: true };
    const out = res.filePath;
    if (!out) return { ok: false, error: 'no-path' };
    const toWrite = validateSettingsShape(data) ? data : (readSettingsFromDisk().settings || {});
    saveJsonFile(out, toWrite);
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

async function importSettings(mainWindow) {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled) return { ok: false, canceled: true };
    const file = res.filePaths?.[0] || null;
    if (!file) return { ok: false, error: 'no-path' };
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!validateSettingsShape(parsed)) return { ok: false, error: 'invalid-settings-shape' };
    return { ok: true, settings: parsed, path: file };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

// -----------------------------
// State persistence
// -----------------------------

function getStateFilePath() {
  try {
    const dir = app.getPath('userData');
    return path.join(dir, 'state.json');
  } catch (_) {
    return path.join(process.cwd(), 'state.json');
  }
}

function validateStateShape(obj) {
  // Allow any plain object
  return !!obj && typeof obj === 'object' && !Array.isArray(obj);
}

function readStateFromDisk() {
  const file = getStateFilePath();
  try {
    if (!fs.existsSync(file)) return { ok: true, state: {} };
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!validateStateShape(parsed)) return { ok: false, error: 'invalid-state-shape' };
    return { ok: true, state: parsed };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

function writeStateToDisk(data) {
  const file = getStateFilePath();
  try {
    if (!validateStateShape(data)) return { ok: false, error: 'invalid-state-shape' };
    saveJsonFile(file, data);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

async function exportState(mainWindow, data) {
  try {
    const defaultPath = getStateFilePath();
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export State',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled) return { ok: false, canceled: true };
    const out = res.filePath;
    if (!out) return { ok: false, error: 'no-path' };
    const toWrite = validateStateShape(data) ? data : (readStateFromDisk().state || {});
    saveJsonFile(out, toWrite);
    return { ok: true, path: out };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

async function importState(mainWindow) {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import State',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled) return { ok: false, canceled: true };
    const file = res.filePaths?.[0] || null;
    if (!file) return { ok: false, error: 'no-path' };
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!validateStateShape(parsed)) return { ok: false, error: 'invalid-state-shape' };
    return { ok: true, state: parsed, path: file };
  } catch (e) {
    return { ok: false, error: formatError(e) };
  }
}

// -----------------------------
// Module exports
// -----------------------------

module.exports = {
  // Settings
  getSettingsFilePath,
  readSettingsFromDisk,
  writeSettingsToDisk,
  exportSettings,
  importSettings,
  
  // State
  getStateFilePath,
  readStateFromDisk,
  writeStateToDisk,
  exportState,
  importState,
  
  // Utilities (exported for testing or reuse)
  formatError,
  validateSettingsShape,
  validateStateShape
};
