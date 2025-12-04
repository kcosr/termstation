/**
 * Cookie utilities for managing session cookie client-side
 */

const SESSION_COOKIE_NAME = 'ts_session';

function trySetCookie(line) {
  try { document.cookie = line; } catch (_) { /* ignore */ }
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const k = String(v || '');
    if (!k) continue;
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/**
 * Attempt to clear a cookie by name for a variety of domain/path combinations.
 * Works only for the current document origin.
 * @param {string} name
 * @param {{ domains?: string[], paths?: string[] }} [options]
 */
export function clearCookie(name, options = {}) {
  if (!name || typeof document === 'undefined') return;
  const paths = Array.isArray(options.paths) && options.paths.length ? options.paths : ['/'];

  // Build domain candidates
  let domains = Array.isArray(options.domains) ? options.domains.slice() : [];
  try {
    const host = window.location.hostname || '';
    if (host) {
      domains.push(host);
      // Also attempt with a leading dot and the registrable suffix (best-effort)
      const parts = host.split('.');
      if (parts.length > 1) {
        const base = parts.slice(-2).join('.');
        domains.push(`.${host}`);
        domains.push(`.${base}`);
        domains.push(base);
      } else {
        domains.push(`.${host}`);
      }
    }
  } catch (_) {}
  domains = unique(domains);

  // Build attribute variants. Browsers ignore unknown attributes for deletion.
  const baseAttrs = [`${encodeURIComponent(name)}=`, 'Max-Age=0'];
  const samesiteVariants = [
    '',
    'SameSite=Lax',
    'SameSite=None; Secure'
  ];

  // Clear without domain first
  for (const p of paths) {
    for (const ss of samesiteVariants) {
      const parts = [...baseAttrs, `Path=${p}`];
      if (ss) parts.push(ss);
      trySetCookie(parts.join('; '));
    }
  }

  // Clear with domain variants
  for (const d of domains) {
    for (const p of paths) {
      for (const ss of samesiteVariants) {
        const parts = [...baseAttrs, `Path=${p}`, `Domain=${d}`];
        if (ss) parts.push(ss);
        trySetCookie(parts.join('; '));
      }
    }
  }
}

/**
 * Clear the session cookie for the given origin if it matches the current page origin.
 * If origin is omitted or equals window.location.origin, clears on this origin.
 * @param {string} [origin]
 */
export function clearSessionCookieForOrigin(origin) {
  try {
    const target = typeof origin === 'string' && origin.trim() ? origin.trim() : window.location.origin;
    if (!target) return false;
    // Only manipulate cookies for the current document origin
    if (target !== window.location.origin) return false;
    clearCookie(SESSION_COOKIE_NAME, { paths: ['/'] });
    return true;
  } catch (_) {
    return false;
  }
}

export const cookieUtils = { clearCookie, clearSessionCookieForOrigin };

