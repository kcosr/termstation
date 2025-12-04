/**
 * Shared text templating utilities for conditionals, includes, and macros.
 *
 * Processing order:
 *  1) Evaluate conditional blocks: `{% if ... %} ... {% elif ... %} ... {% else %} ... {% endif %}`
 *  2) Expand `{file:relative/path}` includes (recursively processed through the same pipeline)
 *  3) Substitute `{var}` macros (unknown variables => empty string)
 */

import { readFileSync, statSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BACKEND_ROOT = dirname(__dirname); // backend/
// Default search path: backend root only (no config dir)
const DEFAULT_BASE_DIRS = [BACKEND_ROOT];
const LOG_IS_DEBUG = String(config?.LOG_LEVEL || '').toUpperCase() === 'DEBUG';

function debugLog(msg) {
  if (LOG_IS_DEBUG) console.log(`[template-text] ${msg}`);
}

function safeResolve(pathLike, baseDirs = DEFAULT_BASE_DIRS) {
  try {
    if (!pathLike || typeof pathLike !== 'string') return null;
    const p = String(pathLike).trim();
    if (isAbsolute(p)) {
      try { statSync(p); return p; } catch { return null; }
    }
    for (const base of baseDirs) {
      const candidate = join(base, p);
      try { statSync(candidate); return candidate; } catch {}
    }
  } catch {}
  return null;
}

function readTextFile(filePath) {
  try { return readFileSync(filePath, 'utf8'); } catch { return null; }
}

// ---------------------- Conditionals ----------------------

function tokenizeDirectives(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{%', i);
    if (start === -1) {
      tokens.push({ type: 'text', value: text.slice(i) });
      break;
    }
    if (start > i) tokens.push({ type: 'text', value: text.slice(i, start) });
    const end = text.indexOf('%}', start + 2);
    if (end === -1) {
      // Unbalanced; treat remainder as text
      tokens.push({ type: 'text', value: text.slice(start) });
      break;
    }
    const inner = text.slice(start + 2, end).trim();
    tokens.push({ type: 'tag', value: inner });
    i = end + 2;
  }
  return tokens;
}

function parseConditionalBlocks(tokens, idx = 0, depth = 0, maxDepth = 20) {
  if (depth > maxDepth) {
    debugLog(`Max conditional nesting exceeded at depth ${depth}`);
    // Flatten remaining tokens to text
    let text = '';
    for (let i = idx; i < tokens.length; i++) text += tokens[i].value || '';
    return { out: text, next: tokens.length };
  }
  let out = '';
  while (idx < tokens.length) {
    const t = tokens[idx++];
    if (!t) break;
    if (t.type === 'text') {
      out += t.value;
      continue;
    }
    // Tag
    const tag = String(t.value || '').trim();
    if (tag.startsWith('if ')) {
      // Parse IF block with optional ELIF/ELSE
      const branches = [];
      let elseBody = '';
      // Accumulate IF body
      let accum = '';
      while (idx < tokens.length) {
        const nt = tokens[idx++];
        if (!nt) break;
        if (nt.type === 'text') { accum += nt.value; continue; }
        const raw = String(nt.value || '').trim();
        if (raw.startsWith('elif ')) {
          branches.push({ expr: tag.slice(3).trim(), body: accum });
          accum = '';
          // Update tag for next compare
          t.value = raw; // reuse t variable idea; we'll handle at end
          // Replace current tag context
          // Continue accumulating for this ELIF until next branch marker
          // We simulate by resetting tag to current 'elif'
          // But need to nest again: We'll collect sequentially
          let subAccum = '';
          while (idx < tokens.length) {
            const nxt = tokens[idx++];
            if (!nxt) break;
            if (nxt.type === 'text') { subAccum += nxt.value; continue; }
            const r2 = String(nxt.value || '').trim();
            if (r2.startsWith('elif ') || r2 === 'else' || r2 === 'endif') {
              branches.push({ expr: raw.slice(5).trim(), body: subAccum });
              subAccum = '';
              if (r2.startsWith('elif ')) {
                // Move sliding window; set raw to new elif and continue
                // We need to continue handling additional elif/else/end.
                // Easiest: set tokens back one step and let outer loop handle
                idx--; // step back to reprocess this tag in outer scope below
                accum = ''; // reset
                // Now enter a mode to finish collecting remaining branches
                // We'll jump to a helper to finish branches
                const finish = consumeBranches(tokens, idx, depth, maxDepth, r2);
                // finish returns { branchesAppend, elseBody, nextIdx }
                branches.push(...finish.branchesPre);
                elseBody = finish.elseBody;
                idx = finish.nextIdx;
                break;
              } else if (r2 === 'else') {
                // Collect else body until endif
                const afterElse = collectUntil(tokens, idx, 'endif');
                elseBody = afterElse.body;
                idx = afterElse.nextIdx;
                break;
              } else if (r2 === 'endif') {
                // Done with if/elif chain
                break;
              }
            } else {
              // Nested IF
              if (r2.startsWith('if ')) {
                // Recurse by reassembling tokens for this nested block
                // Step back one to let recursive call consume properly
                idx--; 
                const nested = parseConditionalBlocks(tokens, idx, depth + 1, maxDepth);
                subAccum += nested.out;
                idx = nested.next;
              } else {
                // Unknown tag - treat literally
                subAccum += `{% ${nxt.value} %}`;
              }
            }
          }
          // branches already handled by consumeBranches
          continue;
        }
        if (raw === 'else') {
          branches.push({ expr: tag.slice(3).trim(), body: accum });
          accum = '';
          // Collect else until endif
          const afterElse = collectUntil(tokens, idx, 'endif');
          elseBody = afterElse.body;
          idx = afterElse.nextIdx;
          break;
        }
        if (raw === 'endif') {
          branches.push({ expr: tag.slice(3).trim(), body: accum });
          accum = '';
          break;
        }
        // Nested IF
        if (raw.startsWith('if ')) {
          // step back one token so nested call can consume
          idx--;
          const nested = parseConditionalBlocks(tokens, idx, depth + 1, maxDepth);
          accum += nested.out;
          idx = nested.next;
          continue;
        }
        // Unknown tag - treat literally
        accum += `{% ${nt.value} %}`;
      }
      // Evaluate branches
      const selected = pickBranch(branches, elseBody);
      out += selected;
      continue;
    }
    if (tag === 'elif' || tag === 'else' || tag === 'endif') {
      // Signal to caller that we hit a boundary
      // Step back one so caller sees it
      idx--; 
      return { out, next: idx };
    }
    // Unknown tag, emit literally
    out += `{% ${tag} %}`;
  }
  return { out, next: idx };
}

function collectUntil(tokens, idx, terminalTag) {
  let body = '';
  while (idx < tokens.length) {
    const t = tokens[idx++];
    if (!t) break;
    if (t.type === 'text') { body += t.value; continue; }
    const raw = String(t.value || '').trim();
    if (raw === terminalTag) break;
    if (raw.startsWith('if ')) {
      // nested block
      const nested = parseConditionalBlocks(tokens, idx - 1, 1, 20); // reuse parser
      body += nested.out;
      idx = nested.next;
      continue;
    }
    body += `{% ${t.value} %}`;
  }
  return { body, nextIdx: idx };
}

function consumeBranches(tokens, idx, depth, maxDepth, firstTagRaw) {
  const branchesPre = [];
  let currentExpr = firstTagRaw.slice(5).trim();
  let body = '';
  let elseBody = '';
  while (idx < tokens.length) {
    const t = tokens[idx++];
    if (!t) break;
    if (t.type === 'text') { body += t.value; continue; }
    const raw = String(t.value || '').trim();
    if (raw.startsWith('elif ')) {
      branchesPre.push({ expr: currentExpr, body });
      currentExpr = raw.slice(5).trim();
      body = '';
      continue;
    }
    if (raw === 'else') {
      branchesPre.push({ expr: currentExpr, body });
      const afterElse = collectUntil(tokens, idx, 'endif');
      elseBody = afterElse.body;
      idx = afterElse.nextIdx;
      break;
    }
    if (raw === 'endif') {
      branchesPre.push({ expr: currentExpr, body });
      body = '';
      break;
    }
    if (raw.startsWith('if ')) {
      // nested
      idx--; 
      const nested = parseConditionalBlocks(tokens, idx, depth + 1, maxDepth);
      body += nested.out;
      idx = nested.next;
      continue;
    }
    body += `{% ${t.value} %}`;
  }
  return { branchesPre, elseBody, nextIdx: idx };
}

function evalExpr(expr, vars) {
  try {
    const s = String(expr || '').trim();
    const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/);
    if (!m) return false;
    const name = m[1];
    const rest = m[2].trim();
    const val = String(vars?.[name] ?? '');

    if (rest === 'exists') return Object.prototype.hasOwnProperty.call(vars || {}, name) && String(vars[name] ?? '') !== '';
    if (rest === 'empty') return val === '';
    if (rest === 'nonempty') return val !== '';

    let mm;
    if ((mm = rest.match(/^(eq|ne|contains|starts_with|ends_with|matches)\s+"((?:[^"\\]|\\.)*)"$/))) {
      const op = mm[1];
      const rhs = mm[2].replace(/\\"/g, '"');
      switch (op) {
        case 'eq': return val === rhs;
        case 'ne': return val !== rhs;
        case 'contains': return val.includes(rhs);
        case 'starts_with': return val.startsWith(rhs);
        case 'ends_with': return val.endsWith(rhs);
        case 'matches': {
          if (rhs.length > 200) return false;
          try { return new RegExp(rhs).test(val); } catch { return false; }
        }
        default: return false;
      }
    }
    if ((mm = rest.match(/^(in|not_in)\s+\[(.*)\]$/))) {
      const op = mm[1];
      const listRaw = mm[2];
      const items = parseQuotedList(listRaw);
      const contains = items.includes(val);
      return op === 'in' ? contains : !contains;
    }
  } catch (e) {
    debugLog(`Expression error '${expr}': ${e?.message || e}`);
    return false;
  }
  return false;
}

function parseQuotedList(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    // skip spaces and commas
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] !== '"') {
      // invalid token; skip until next comma
      while (i < s.length && s[i] !== ',') i++;
      continue;
    }
    i++; // skip opening quote
    let str = '';
    let esc = false;
    while (i < s.length) {
      const ch = s[i++];
      if (esc) { str += ch; esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') break;
      str += ch;
    }
    out.push(str);
    // skip until next comma
    while (i < s.length && s[i] !== ',') i++;
    if (i < s.length && s[i] === ',') i++;
  }
  return out;
}

function pickBranch(branches, elseBody) {
  for (const b of branches) {
    const ok = evalExpr(b.expr, {}); // placeholder; replaced in evaluateConditionals with bound vars
    if (ok) return b.body;
  }
  return elseBody || '';
}

export function evaluateConditionals(text, vars, opts = {}) {
  try {
    const src = String(text || '');
    if (!src.includes('{%')) return src;

    // Normalize control-only lines so `{% if %}` / `{% else %}` / `{% endif %}`
    // do not leave behind extra blank lines after evaluation. When a control
    // tag occupies an entire line, we strip just its trailing newline so the
    // tag becomes adjacent to the following content instead of owning its own
    // line.
    const normalized = src.replace(
      /^[ \t]*\{%\s*(if\b.*|elif\b.*|else\b|endif\b)\s*%}[ \t]*\r?\n/gm,
      (m) => m.replace(/\r?\n$/, '')
    );

    const tokens = tokenizeDirectives(normalized);
    const maxDepth = Number(opts.maxConditionalDepth || 20);
    // Rebind pickBranch to use provided vars
    const savedPick = pickBranch;
    // Monkey patch pickBranch eval to have vars
    const pickWithVars = (branches, elseBody) => {
      for (const b of branches) {
        const ok = evalExpr(b.expr, vars);
        if (LOG_IS_DEBUG) debugLog(`IF '${b.expr}' => ${ok}`);
        if (ok) return b.body;
      }
      return elseBody || '';
    };
    // Local wrapper replicating parse but using pickWithVars
    function parseWithVars(tokensArg, idx = 0, depth = 0) {
      if (depth > maxDepth) {
        debugLog(`Max conditional nesting exceeded at depth ${depth}`);
        let rem = '';
        for (let i = idx; i < tokensArg.length; i++) rem += tokensArg[i].value || '';
        return { out: rem, next: tokensArg.length };
      }
      let out = '';
      while (idx < tokensArg.length) {
        const t = tokensArg[idx++];
        if (!t) break;
        if (t.type === 'text') { out += t.value; continue; }
        const tag = String(t.value || '').trim();
        if (tag.startsWith('if ')) {
          // Collect branches using the original parser to keep structure
          // We'll reuse tokenize/collect helpers to avoid infinite recursion
          const startIdx = idx; // point after IF tag
          // We need a lightweight re-implementation here for reliability
          const branches = [];
          let body = '';
          let elseBody = '';
          let collecting = 'if';
          let currentExpr = tag.slice(3).trim();
          while (idx < tokensArg.length) {
            const nt = tokensArg[idx++];
            if (!nt) break;
            if (nt.type === 'text') { body += nt.value; continue; }
            const raw = String(nt.value || '').trim();
            if (raw.startsWith('if ')) {
              idx--; // nested
              const nested = parseWithVars(tokensArg, idx, depth + 1);
              body += nested.out; idx = nested.next; continue;
            }
            if (raw.startsWith('elif ')) {
              branches.push({ expr: currentExpr, body });
              currentExpr = raw.slice(5).trim();
              body = '';
              collecting = 'elif';
              continue;
            }
            if (raw === 'else') {
              branches.push({ expr: currentExpr, body });
              body = '';
              // collect else till endif
              const rest = collectUntil(tokensArg, idx, 'endif');
              elseBody = rest.body; idx = rest.nextIdx; collecting = 'end';
              break;
            }
            if (raw === 'endif') {
              branches.push({ expr: currentExpr, body });
              body = '';
              collecting = 'end';
              break;
            }
            // Unknown tag literal
            body += `{% ${nt.value} %}`;
          }
          if (collecting !== 'end') {
            // Unbalanced; treat literally
            out += `{% ${tag} %}`;
            idx = startIdx;
            continue;
          }
          out += pickWithVars(branches, elseBody);
          continue;
        }
        if (tag === 'elif' || tag === 'else' || tag === 'endif') {
          idx--; return { out, next: idx };
        }
        out += `{% ${tag} %}`;
      }
      return { out, next: idx };
    }
    return parseWithVars(tokens, 0, 0).out;
  } catch (e) {
    debugLog(`Conditional evaluation error: ${e?.message || e}`);
    return String(text || '');
  }
}

// ---------------------- Includes ----------------------

export function expandIncludes(text, vars, opts = {}) {
  const baseDirs = Array.isArray(opts.baseDirs) && opts.baseDirs.length ? opts.baseDirs : DEFAULT_BASE_DIRS;
  const maxDepth = Number(opts.maxIncludeDepth || 5);
  const envForPath = (vars && typeof vars === 'object') ? vars : {};

  function expandPathMacrosAndEnv(raw) {
    try {
      // First apply macro-style placeholders (e.g., {CONFIG_DIR})
      let out = substituteMacros(String(raw || ''), envForPath);
      // Then expand simple shell-style env vars using provided vars first, then process.env
      out = out.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
        const key = braced || bare;
        if (!key) return '';
        if (Object.prototype.hasOwnProperty.call(envForPath, key)) {
          const v = envForPath[key];
          return v == null ? '' : String(v);
        }
        const envVal = process.env[key];
        return envVal == null ? '' : String(envVal);
      });
      return out.trim();
    } catch (_) {
      return String(raw || '').trim();
    }
  }

  const recur = (t, depth) => {
    if (!t || depth > maxDepth) return String(t || '');
    const s = String(t);
    let out = '';
    let idx = 0;
    const marker = '{file:';
    while (idx < s.length) {
      const start = s.indexOf(marker, idx);
      if (start === -1) {
        out += s.slice(idx);
        break;
      }
      out += s.slice(idx, start);
      let j = start + marker.length;
      let braceDepth = 0;
      let end = -1;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (ch === '{') {
          braceDepth++;
        } else if (ch === '}') {
          if (braceDepth === 0) {
            end = j;
            break;
          }
          braceDepth--;
        }
      }
      if (end === -1) {
        // Unbalanced; emit the rest literally
        out += s.slice(start);
        break;
      }
      const fnameRaw = s.slice(start + marker.length, end);
      const fname = expandPathMacrosAndEnv(fnameRaw);
      const resolved = safeResolve(fname, baseDirs);
      if (resolved) {
        const content = readTextFile(resolved);
        if (content != null) {
          try {
            out += processText(content, vars, { ...opts, _includeDepth: depth + 1 });
          } catch (e) {
            debugLog(`Include processing failed for ${fname}: ${e?.message || e}`);
          }
        }
      }
      idx = end + 1;
    }
    return out;
  };
  return recur(text, Number(opts._includeDepth || 0));
}

// ---------------------- Macros ----------------------

export function substituteMacros(text, vars) {
  if (!text) return '';
  const s = String(text);
  // Replace any {Identifier} with value or empty string when missing
  return s.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key) => {
    const hasKey = vars && Object.prototype.hasOwnProperty.call(vars, key);
    if (!hasKey) return '';
    const v = vars[key];
    // Normalize values:
    // - undefined/null => ''
    // - strings => trim-only-whitespace to empty, otherwise as-is
    // - numbers (including 0) => String(number)
    // - booleans/objects/arrays => treated as empty to avoid 'false' or '[object Object]'
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') {
      return v.trim() === '' ? '' : v;
    }
    if (typeof v === 'number') {
      return Number.isNaN(v) ? '' : String(v);
    }
    // Everything else treated as empty
    return '';
  });
}

// ---------------------- Pipeline ----------------------

export function processText(text, vars, opts = {}) {
  try {
    const t = String(text || '');
    const hasCond = t.includes('{%');
    const hasIncl = t.includes('{file:');
    if (!hasCond && !hasIncl) {
      return substituteMacros(t, vars || {});
    }
    const step1 = hasCond ? evaluateConditionals(t, vars, opts) : t;
    const step2 = hasIncl ? expandIncludes(step1, vars, opts) : step1;
    const step3 = substituteMacros(step2, vars || {});
    return step3;
  } catch (e) {
    debugLog(`processText error: ${e?.message || e}`);
    return String(text || '');
  }
}

export default { processText, evaluateConditionals, expandIncludes, substituteMacros };
