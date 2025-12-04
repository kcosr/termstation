/**
 * History Streamer Utility
 * Streams raw session history into a xterm.js terminal with optional filters,
 * CRLF expansion, progress callbacks, and accurate marker placement based on
 * raw activity transition offsets.
 */

import { apiService } from '../services/api.service.js';
import { appStore } from '../core/store.js';
import { applyAnsiFilters } from './ansi-filters.js';

/**
 * Stream session history into a terminal.
 *
 * @param {Object} opts
 * @param {Terminal} opts.terminal - xterm.js terminal instance
 * @param {string} opts.sessionId - Session identifier
 * @param {Array} [opts.transitions] - Activity transitions with raw char_offset
 * @param {Function} [opts.ensureTransitions] - async () => transitions[] when none provided
 * @param {AbortSignal} [opts.signal] - Abort signal to cancel stream
 * @param {Function} [opts.onProgress] - ({ receivedBytes, contentLength, percent }) => void
 * @param {Function} [opts.onMarker] - (marker, meta) => void
 * @returns {Promise<{ receivedBytes: number, contentLength: number|null }>}
 */
export async function streamHistoryToTerminal(opts = {}) {
  const terminal = opts.terminal;
  const sessionId = String(opts.sessionId || '');
  const signal = opts.signal;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const onMarker = typeof opts.onMarker === 'function' ? opts.onMarker : null;
  // Optional byte range limit (inclusive end)
  const rangeEnd = Number.isFinite(Number(opts.rangeEnd)) ? Math.max(0, Math.floor(Number(opts.rangeEnd))) : null;
  // Optional byte offset to start from (filters history to only return data after this offset)
  const sinceOffset = Number.isFinite(Number(opts.sinceOffset)) && Number(opts.sinceOffset) >= 0 ? Math.floor(Number(opts.sinceOffset)) : null;
  // Optional createdAt timestamp for injected initial marker (ms)
  let createdAtMs = null;
  try {
    const v = opts.createdAt;
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) createdAtMs = Math.floor(n);
      else {
        const t = Date.parse(String(v));
        if (Number.isFinite(t)) createdAtMs = t;
      }
    }
  } catch (_) { createdAtMs = null; }

  if (!terminal || !sessionId) {
    throw new Error('streamHistoryToTerminal: terminal and sessionId are required');
  }

  // Resolve transitions
  let transitions = Array.isArray(opts.transitions) ? opts.transitions.slice() : [];
  if ((!transitions || transitions.length === 0) && typeof opts.ensureTransitions === 'function') {
    try { const t = await opts.ensureTransitions(); if (Array.isArray(t)) transitions = t.slice(); } catch (_) {}
  }

  // Ensure an initial marker at the start of output (offset 0)
  try {
    const hasZero = transitions.some(t => (Number(t?.char_offset) || 0) === 0);
    if (!hasZero) {
      transitions.unshift({ char_offset: 0, state: 'active', t: (createdAtMs ?? Date.now()), seq: 0 });
    }
  } catch (_) {}

  // Prepare filter flags
  let filterOsc = true;
  let collapseRgb = true;
  try {
    const state = appStore.getState();
    const tPrefs = state?.preferences?.terminal || {};
    filterOsc = tPrefs.filterOscColors !== false;
    collapseRgb = tPrefs.collapseNakedRgbRuns !== false;
  } catch (_) {}

  // Determine Content-Length via HEAD (best-effort)
  let contentLength = null;
  try {
    const headUrl = `${apiService.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/history/raw`;
    const headResp = await fetch(headUrl, { method: 'HEAD', credentials: apiService.getCredentialsMode(), signal });
    if (headResp && headResp.ok) {
      const len = headResp.headers.get('Content-Length');
      const n = Number(len);
      if (Number.isFinite(n)) contentLength = n;
    }
  } catch (_) {}

  const { reader, contentLength: respLen } = await apiService.streamSessionHistory(sessionId, { signal, rangeEnd, sinceOffset });
  if (respLen != null) contentLength = respLen;

  const enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  let receivedBytes = 0;

  // Prepare marker offsets
  const rawOffsets = (Array.isArray(transitions) ? transitions : [])
    .map(t => {
      const ro = Math.max(0, Number(t?.char_offset) || 0);
      return { raw: ro, meta: { state: 'active', t: t.t || Date.now(), seq: t.seq || 0, raw: ro } };
    })
    .sort((a, b) => a.raw - b.raw);
  let nextMarkerIdx = 0;
  let rawSeen = 0;

  // Detect in-band hidden input markers injected in history: ESC ]133;ts:<kind>;t=<ms> BEL|ST
  // These should not render; strip them and emit onMarker immediately.
  const TS_MARKER_RE = /\x1b\]133;ts:([^;\x07\x1b]+);t=([0-9]+)(?:\x07|\x1b\\)/g;
  const TS_PREFIX = "\x1b]133;ts:";
  let tsCarry = '';

  const updateProgress = () => {
    if (!onProgress) return;
    const pct = contentLength ? Math.min(100, Math.round((receivedBytes / contentLength) * 100)) : null;
    onProgress({ receivedBytes, contentLength, percent: pct });
  };
  updateProgress();

  // Alt-screen tracking: suppress visible composed marker lines when alternate screen is active
  let altScreen = false;
  const scanAltScreen = (s) => {
    try {
      if (!s) return;
      const re = /\x1b\[\?(?:1049|1047|47)([hl])/g; // h=enter alt, l=exit alt
      let m;
      while ((m = re.exec(s)) !== null) {
        const op = m[1];
        if (op === 'h') altScreen = true; else if (op === 'l') altScreen = false;
      }
    } catch (_) {}
  };
  const writeFiltered = (s) => {
    if (!s) return;
    // Scan for alt screen toggles on the raw string BEFORE filtering
    scanAltScreen(s);
    let w = s;
    if (filterOsc || collapseRgb) w = applyAnsiFilters(w, { filterOscColors: filterOsc, collapseRgbRuns: collapseRgb });
    w = w.replace(/\n/g, '\r\n');
    terminal.write(w);
  };

  // If first marker is at byte 0, place it before writing any output so it anchors to the top of the buffer
  try {
    if (rawOffsets && rawOffsets.length && rawOffsets[0].raw === 0) {
      const m0 = terminal.registerMarker(0);
      if (m0 && onMarker) onMarker(m0, { ...rawOffsets[0].meta, kind: 'start', ord: 0 });
      nextMarkerIdx = 1;
      // Initialize ordinal baseline: start is 0
      var initialStartPlaced = true;
      var ord = 0;
    } else {
      var initialStartPlaced = false;
      var ord = -1;
    }
  } catch (_) {
    var initialStartPlaced = false;
    var ord = -1;
  }

  // Stream loop
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    done = !!d;
    if (!value) continue;
    try { receivedBytes += enc ? enc.encode(value).length : value.length; } catch (_) { receivedBytes += value.length; }
    updateProgress();

    // Prepend any carried partial marker from previous chunk
    let remaining = tsCarry ? (tsCarry + value) : value;
    tsCarry = '';
    while (remaining && nextMarkerIdx < rawOffsets.length) {
      const target = rawOffsets[nextMarkerIdx].raw;
      if (target <= rawSeen) {
        const m = terminal.registerMarker(0);
        if (m && onMarker) onMarker(m, rawOffsets[nextMarkerIdx].meta);
        nextMarkerIdx++;
        continue;
      }
      const need = target - rawSeen;
      if (remaining.length <= need) break;
      const prefix = remaining.slice(0, need);
      writeFiltered(prefix);
      rawSeen += prefix.length;
      remaining = remaining.slice(need);
      const mk = terminal.registerMarker(0);
      if (mk && onMarker) onMarker(mk, rawOffsets[nextMarkerIdx].meta);
      nextMarkerIdx++;
      await new Promise(r => setTimeout(r, 0));
    }
    if (remaining) {
      // Process in-band markers within the chunk, writing text that precedes
      // each marker BEFORE registering the marker so the marker anchors at the
      // correct line. Abort immediately after hitting a target (consumer aborts).
      let chunk = remaining;
      let cursor = 0;
      TS_MARKER_RE.lastIndex = 0;
      let m;
      while ((m = TS_MARKER_RE.exec(chunk)) !== null) {
        const idx = m.index;
        const pre = chunk.slice(cursor, idx);
        if (pre) { writeFiltered(pre); rawSeen += pre.length; }
        // Emit marker for this in-band tag (after writing preceding text)
        try {
          const kind = m[1] || 'input';
          const t = Number(m[2]) || Date.now();
          // Skip emitting an extra 'start' marker if we already placed one at offset 0
          if (kind === 'start') {
            if (!initialStartPlaced && ord < 0) {
              // Backfill start if somehow not placed
              const mk0 = terminal.registerMarker(0);
              if (mk0 && onMarker) onMarker(mk0, { state: 'active', t, seq: 0, raw: rawSeen, kind: 'start', ord: 0 });
              ord = 0;
              initialStartPlaced = true;
            }
          } else {
            if (ord < 0) ord = initialStartPlaced ? 0 : 0; // baseline to 0
            ord += 1; // first input becomes 1
            const mk = terminal.registerMarker(0);
            if (mk && onMarker) onMarker(mk, { state: 'active', t, seq: 0, raw: rawSeen, kind, ord });
          }
        } catch (_) {}
        cursor = idx + m[0].length;
        // If consumer aborted (e.g., seekToOrdinal reached), stop immediately
        if (signal && signal.aborted) {
          done = true;
          break;
        }
      }
      if (!done) {
        // Handle any trailing text after the last full marker
        let tail = chunk.slice(cursor);
        // Detect incomplete marker at the end and carry it to next iteration
        const prefIdx = chunk.lastIndexOf(TS_PREFIX);
        if (prefIdx !== -1 && prefIdx >= cursor) {
          // If from prefIdx to end we do not have a terminator (BEL or ST), carry it over
          const suffix = chunk.slice(prefIdx);
          const hasTerm = /\x07|\x1b\\/.test(suffix);
          if (!hasTerm) {
            // Exclude the carried suffix from writing now
            tail = chunk.slice(cursor, prefIdx);
            tsCarry = suffix;
          }
        }
        if (tail) { writeFiltered(tail); rawSeen += tail.length; }
      }
    }
    // Honor aborts promptly after processing this chunk
    if (signal && signal.aborted) break;
    await new Promise(r => setTimeout(r, 0));
  }

  return { receivedBytes, contentLength };
}
