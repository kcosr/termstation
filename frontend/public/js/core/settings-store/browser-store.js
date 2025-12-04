// Browser (web) settings store backed by localStorage

const STORAGE_KEY = 'terminal_manager_settings';

export const BrowserSettingsStore = {
  kind: 'browser',
  async load() {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      return s ? JSON.parse(s) : null;
    } catch (_) {
      return null;
    }
  },
  // Synchronous load for early bootstrap use
  loadSync() {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      return { ok: true, settings: s ? JSON.parse(s) : null };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  },
  async save(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }
};

