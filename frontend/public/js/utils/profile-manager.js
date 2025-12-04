import { getSettingsStore } from '../core/settings-store/index.js';

const genId = () => {
  try {
    const rnd = Math.random().toString(36).slice(2, 8);
    return `prof_${Date.now().toString(36)}_${rnd}`;
  } catch (_) {
    return `prof_${Date.now()}`;
  }
};

const sanitizeUrl = (url) => {
  if (!url || typeof url !== 'string') return '';
  let s = url.trim();
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
};

const readSettings = async () => {
  try {
    const store = getSettingsStore();
    const settings = await store.load();
    return settings || {};
  } catch (_) {
    return {};
  }
};

const writeSettings = async (next) => {
  try {
    const store = getSettingsStore();
    return await store.save(next);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
};

const toLabel = (p) => {
  const full = sanitizeUrl(p.apiUrl);
  return p.username ? `${p.username}@${full}` : full;
};

export const profileManager = {
  async list() {
    const s = await readSettings();
    const items = (s.authProfiles && Array.isArray(s.authProfiles.items)) ? s.authProfiles.items : [];
    return items.map((p) => ({ ...p, apiUrl: sanitizeUrl(p.apiUrl), label: toLabel(p) }));
  },
  async getActiveId() {
    const s = await readSettings();
    return s.authProfiles && s.authProfiles.activeId ? s.authProfiles.activeId : '';
  },
  async getPreviousId() {
    const s = await readSettings();
    return s.authProfiles && s.authProfiles.previousId ? s.authProfiles.previousId : '';
  },
  async getActive() {
    const [items, id] = await Promise.all([this.list(), this.getActiveId()]);
    return items.find((p) => p.id === id) || null;
  },
  async setActive(id) {
    const s = await readSettings();
    const items = (s.authProfiles && Array.isArray(s.authProfiles.items)) ? s.authProfiles.items : [];
    const currentActive = (s.authProfiles && s.authProfiles.activeId) || '';
    // Persist previousId to enable quick toggle between last two used profiles
    s.authProfiles = { items, activeId: id || '', previousId: currentActive || '' };
    return writeSettings(s);
  },
  async upsert({ username, apiUrl, name, useApiProxy }) {
    const s = await readSettings();
    const items = (s.authProfiles && Array.isArray(s.authProfiles.items)) ? s.authProfiles.items : [];
    const normalizedUrl = sanitizeUrl(apiUrl);
    const uname = (username || '').trim();
    // Find existing by (url, username)
    let found = items.find((p) => sanitizeUrl(p.apiUrl) === normalizedUrl && (p.username || '') === uname);
    const now = Date.now();
    if (found) {
      const desiredName = (name || found.name || normalizedUrl || '').trim();
      found.name = desiredName;
      found.lastUsedAt = now;
      if (typeof useApiProxy === 'boolean') {
        found.useApiProxy = !!useApiProxy;
      }
    } else {
      const desiredName = (name || normalizedUrl || '').trim();
      found = {
        id: genId(),
        name: desiredName,
        username: uname,
        apiUrl: normalizedUrl,
        lastUsedAt: now,
        useApiProxy: !!useApiProxy
      };
      items.push(found);
    }
    s.authProfiles = { items, activeId: found.id };
    const res = await writeSettings(s);
    return res && res.ok ? found : null;
  },
  async remove(id) {
    const s = await readSettings();
    const items = (s.authProfiles && Array.isArray(s.authProfiles.items)) ? s.authProfiles.items : [];
    const next = items.filter((p) => p.id !== id);
    let activeId = (s.authProfiles && s.authProfiles.activeId) || '';
    if (activeId === id) activeId = next.length ? next[0].id : '';
    s.authProfiles = { items: next, activeId };
    return writeSettings(s);
  }
};
