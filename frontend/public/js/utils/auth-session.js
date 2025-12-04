import { getApiOrigins } from '../core/config.js';

const resolveBaseUrl = (baseUrl) => {
  if (typeof baseUrl === 'string') {
    const trimmed = baseUrl.trim();
    if (trimmed) return trimmed;
  }
  const { apiBaseUrl } = getApiOrigins();
  return apiBaseUrl;
};

export const authSession = {
  async restoreCookies(baseUrl) {
    const resolvedBase = resolveBaseUrl(baseUrl);
    const candidates = [];
    if (resolvedBase) candidates.push(resolvedBase);
    try {
      const u = new URL(resolvedBase);
      if (u && u.origin) candidates.push(u.origin);
    } catch (_) {}
    // Deduplicate
    const uniq = Array.from(new Set(candidates.filter(Boolean)));
    try {
      if (window.desktop?.cookies?.restore && uniq.length) {
        let ok = false;
        for (const c of uniq) {
          try { const res = await window.desktop.cookies.restore(c); ok = ok || (res && res.ok); } catch (_) {}
        }
        return { ok };
      }
    } catch (_) {}
    return { ok: true };
  },
  async saveCookies(baseUrl) {
    const resolvedBase = resolveBaseUrl(baseUrl);
    const candidates = [];
    if (resolvedBase) candidates.push(resolvedBase);
    try {
      const u = new URL(resolvedBase);
      if (u && u.origin) candidates.push(u.origin);
    } catch (_) {}
    const uniq = Array.from(new Set(candidates.filter(Boolean)));
    try {
      if (window.desktop?.cookies?.save && uniq.length) {
        let ok = false;
        for (const c of uniq) {
          try { const res = await window.desktop.cookies.save(c); ok = ok || (res && res.ok); } catch (_) {}
        }
        return { ok };
      }
    } catch (_) {}
    return { ok: true };
  },
  async clearCookies(baseUrl) {
    const resolvedBase = resolveBaseUrl(baseUrl);
    const candidates = [];
    if (resolvedBase) candidates.push(resolvedBase);
    try {
      const u = new URL(resolvedBase);
      if (u && u.origin) candidates.push(u.origin);
    } catch (_) {}
    const uniq = Array.from(new Set(candidates.filter(Boolean)));
    try {
      if (window.desktop?.cookies?.clear && uniq.length) {
        let ok = false;
        for (const c of uniq) {
          try { const res = await window.desktop.cookies.clear(c); ok = ok || (res && res.ok); } catch (_) {}
        }
        return { ok };
      }
    } catch (_) {}
    return { ok: true };
  },
  setLoggedIn(flag) {
    try {
      if (flag) sessionStorage.setItem('tm_logged_in', '1');
      else sessionStorage.removeItem('tm_logged_in');
    } catch (_) {}
  }
};
