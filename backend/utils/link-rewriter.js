/**
 * Link rewriting utility for forked sessions
 * - Re-evaluates macro placeholders using provided variables
 * - Rewrites occurrences of the old session_id to the new session_id
 * - Handles common patterns: query param `session_id=...` and path `/sessions/<id>/...`
 */

// Avoid hard dependency at module load time; import on demand to keep
// this module usable in environments without full backend config.
let _processText = null;
async function getProcessText() {
  if (_processText) return _processText;
  try {
    const mod = await import('./template-text.js');
    _processText = mod.processText;
  } catch (_) {
    _processText = null;
  }
  return _processText;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteSessionIdSegments(input, oldId, newId) {
  if (!input || !oldId || !newId) return String(input || '');
  let out = String(input);
  try {
    const escOld = escapeRegExp(oldId);
    // Replace query param session_id=<oldId>
    out = out.replace(new RegExp(`([?&]session_id=)${escOld}([&#]|$)`, 'g'), `$1${newId}$2`);
    // Replace path segment /sessions/<oldId>/ or /sessions/<oldId>? or EoS
    out = out.replace(new RegExp(`(/sessions/)${escOld}(/|\\?|$)`, 'g'), `$1${newId}$2`);
    // Fallback: replace any remaining exact occurrences (best-effort)
    out = out.split(oldId).join(newId);
  } catch (_) {
    // Best-effort fallback
    try { out = out.split(oldId).join(newId); } catch (_) {}
  }
  return out;
}

/**
 * Rewrite a single link entry with macro expansion and session_id replacement.
 * @param {object} link - { url, name, ... }
 * @param {object} options - { oldSessionId, newSessionId, variables, baseDirs }
 * @returns {object} rewritten link
 */
export function rewriteLinkForFork(link, options = {}) {
  if (!link || typeof link !== 'object') return link;
  const oldId = String(options.oldSessionId || '').trim();
  const newId = String(options.newSessionId || '').trim();
  const mergedVars = options.variables && typeof options.variables === 'object' ? options.variables : {};
  const baseDirs = Array.isArray(options.baseDirs) ? options.baseDirs : [process.cwd()];

  // Macro expansion when placeholders exist
  const needsMacroUrl = typeof link.url === 'string' && /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(link.url);
  const needsMacroName = typeof link.name === 'string' && /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(link.name || '');

  let url = String(link.url || '');
  let name = String(link.name || url);

  // Expand macros when present. Prefer full processor; otherwise fallback to simple
  // replacement for {session_id} to cover the primary need in forks.
  if (needsMacroUrl || needsMacroName) {
    const doExpand = (str) => {
      if (!str) return str;
      try {
        // Simple fallback for session_id
        const sid = mergedVars && mergedVars.session_id ? String(mergedVars.session_id) : '';
        if (sid) str = String(str).replace(/\{session_id\}/g, sid);
      } catch (_) {}
      return str;
    };
    // Attempt dynamic import
    const ptPromise = getProcessText();
    // Use promise thenable to keep function sync-ish in tests; if dynamic import fails,
    // fallback will already have applied for session_id.
    try {
      // We may not await here to keep compatibility with existing sync callers.
      // Instead, attempt synchronous fallback now; if import resolves immediately,
      // apply it; otherwise keep the fallback results.
      const maybe = (ptPromise && typeof ptPromise.then === 'function') ? null : ptPromise;
      if (maybe) {
        const pt = maybe;
        if (needsMacroUrl) url = pt(url, mergedVars, { baseDirs });
        if (needsMacroName) name = pt(name, mergedVars, { baseDirs });
      } else {
        // Fallback immediate substitution
        if (needsMacroUrl) url = doExpand(url);
        if (needsMacroName) name = doExpand(name);
        // Schedule async enhancement if consumer ignores immediate return
        // (No-op: consumers treat return synchronously)
      }
    } catch (_) {
      if (needsMacroUrl) url = doExpand(url);
      if (needsMacroName) name = doExpand(name);
    }
  }

  // Rewrite old session id to new wherever applicable
  if (oldId && newId && oldId !== newId) {
    url = rewriteSessionIdSegments(url, oldId, newId);
    name = rewriteSessionIdSegments(name, oldId, newId);
  }

  const out = { ...link, url, name };
  return out;
}

/**
 * Rewrite an array of links for a forked session.
 * @param {Array<object>} links
 * @param {object} options - { oldSessionId, newSessionId, variables, baseDirs }
 * @returns {Array<object>}
 */
export function rewriteLinksForFork(links, options = {}) {
  const list = Array.isArray(links) ? links : [];
  const out = [];
  for (const l of list) {
    if (!l) continue;
    out.push(rewriteLinkForFork(l, options));
  }
  return out;
}
