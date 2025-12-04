/**
 * ANSI/OSC Debug Utilities (gated)
 *
 * Lightweight helpers to inspect presence of ESC/OSC color sequences
 * during history replay and live output without changing behavior.
 *
 * Enable via Settings → Developer → "Terminal ANSI/OSC logs",
 * or with query param `ansiDebug=1`, or localStorage key `tm_ansi_debug=1`.
 */

import { appStore } from '../core/store.js';

function getDebugEnabled() {
  // 1) Settings flag takes precedence when available
  try {
    const enabled = appStore.getState('preferences.debug.ansiOscLogs');
    if (enabled === true) return true;
  } catch (_) {}
  // 2) Query param toggle
  try {
    const params = new URLSearchParams(window.location.search || '');
    if (params.get('ansiDebug') === '1') return true;
  } catch (_) {}
  // 3) LocalStorage toggle
  try {
    if (window.localStorage?.getItem('tm_ansi_debug') === '1') return true;
  } catch (_) {}
  return false;
}

function summarizeAnsi(text) {
  const ESC = '\x1b';
  const BEL = '\x07';
  const ST = '\x1b\\';
  const hasEsc = text.indexOf('\x1b') !== -1;
  const escCount = (text.match(/\x1b/g) || []).length;
  const belCount = (text.match(/\x07/g) || []).length;
  const stCount = (text.match(/\x1b\\/g) || []).length;
  const rgbCount = (text.match(/rgb:[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}/g) || []).length;

  // Match well-formed OSC 4/10/11/12/104/110/111/112 sequences (BEL or ST terminated)
  const oscColorRe = /\x1b\](?:4|10|11|12|104|110|111|112);[^\x07\x1b]*(?:\x07|\x1b\\)/g;
  const oscMatches = text.match(oscColorRe) || [];

  return { hasEsc, escCount, belCount, stCount, rgbCount, oscCount: oscMatches.length };
}

function extractRgbContexts(text, limit = 5, context = 48) {
  const out = [];
  let m;
  const re = /rgb:[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}/g;
  while ((m = re.exec(text)) && out.length < limit) {
    const start = Math.max(0, m.index - context);
    const end = Math.min(text.length, m.index + m[0].length + context);
    const snippet = text.slice(start, end);
    out.push(snippet);
  }
  return out;
}

function hexPreview(text, max = 256) {
  const slice = text.slice(0, max);
  const bytes = Array.from(slice, ch => ch.charCodeAt(0));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
}

export const AnsiDebug = {
  get enabled() { return getDebugEnabled(); },
  summarizeAnsi,
  extractRgbContexts,
  hexPreview,
  log(label, text) {
    if (!getDebugEnabled() || !text) return;
    try {
      const summary = summarizeAnsi(text);
      const rgbs = extractRgbContexts(text);
      // Only log a manageable amount
      console.log('[AnsiDebug]', label, summary);
      if (rgbs.length) {
        console.log('[AnsiDebug] sample rgb contexts:', rgbs);
      }
      console.log('[AnsiDebug] head hex:', hexPreview(text, 192));
    } catch (_) {}
  }
};

export default AnsiDebug;
