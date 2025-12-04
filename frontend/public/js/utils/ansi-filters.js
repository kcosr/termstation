/**
 * ANSI/OSC filters for terminal stream
 *
 * Provides deterministic filtering of well-formed OSC color sequences and
 * conservative collapsing of naked rgb payload runs observed as artifacts.
 */

const RE_OSC_COLOR = /\x1b\](?:4|10|11|12|104|110|111|112);[^\x07\x1b]*(?:\x07|\x1b\\)/g; // ESC ] ... BEL|ST
// Hidden marker sequences injected by backend: ESC ] 133;ts:<kind>;t=<ms> BEL|ST
const RE_OSC_TS_MARKER = /\x1b\]133;ts:[^;\x07\x1b]+;t=[0-9]+(?:\x07|\x1b\\)/g;

// Matches tokens like rgb:ffff/eeee/cccc10 or rgb:aaaa/bbbb/cccc11 (6 hex in 3rd, ending 10|11)
const RE_INVALID_RGB_TOKEN = /(?:^|[;\s])rgb:[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}(10|11)(?=(?:[;\s]|$))/g;

/**
 * Remove strict, well-formed OSC color sequences.
 */
export function stripOscColors(input) {
  if (!input || typeof input !== 'string') return input;
  return input.replace(RE_OSC_COLOR, '');
}

export function stripTsMarkers(input) {
  if (!input || typeof input !== 'string') return input;
  return input.replace(RE_OSC_TS_MARKER, '');
}

/**
 * Collapse likely artifact runs of naked rgb payloads.
 * Conditions to modify a line:
 *  - No OSC introducer (ESC ]) present in the line
 *  - At least `minCount` invalid rgb tokens (3rd channel ends with 10|11) present
 */
export function collapseNakedRgbRuns(input, { minCount = 6 } = {}) {
  if (!input || typeof input !== 'string') return input;
  // Fast path
  if (input.indexOf('rgb:') === -1) return input;
  const lines = input.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.indexOf('rgb:') === -1) continue;
    // Skip if it contains an OSC introducer to avoid touching valid OSC
    if (line.indexOf('\x1b]') !== -1) continue;
    // Short-circuit: if the line is too short to contain the minimum number
    // of invalid rgb tokens, skip scanning. Each token is ~>30 chars including
    // delimiters (e.g., ';rgb:ffff/eeee/cccc10').
    const MIN_TOKEN_APPROX_LEN = 30;
    if (line.length < (minCount * MIN_TOKEN_APPROX_LEN)) continue;
    let count = 0;
    RE_INVALID_RGB_TOKEN.lastIndex = 0;
    while (RE_INVALID_RGB_TOKEN.exec(line)) count++;
    if (count >= minCount) {
      lines[i] = line.replace(RE_INVALID_RGB_TOKEN, (m) => {
        // Remove preceding delimiter if present to avoid leftover ";" clutter
        if (m[0] === ';' || m[0] === ' ') return '';
        return '';
      });
      // Optionally trim redundant semicolons/spaces in the vicinity
      lines[i] = lines[i].replace(/;+\s*;+|\s{2,}/g, ' ').replace(/\s*;\s*/g, ';');
    }
  }
  return lines.join('\n');
}

/**
 * Apply filters based on options.
 */
export function applyAnsiFilters(input, { filterOscColors = true, collapseRgbRuns = true } = {}) {
  let out = input;
  if (filterOscColors) out = stripOscColors(out);
  // Always strip our hidden timeline markers
  out = stripTsMarkers(out);
  if (collapseRgbRuns) out = collapseNakedRgbRuns(out);
  return out;
}

export default {
  stripOscColors,
  stripTsMarkers,
  collapseNakedRgbRuns,
  applyAnsiFilters
};
