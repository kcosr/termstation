// Desktop (Electron) settings store via preload IPC bridge

const hasDesktop = () => !!(window.desktop && window.desktop.isElectron);

export const DesktopSettingsStore = {
  kind: 'desktop',
  async load() {
    try {
      if (!hasDesktop() || !window.desktop.settings?.load) return null;
      const res = await window.desktop.settings.load();
      return (res && res.ok) ? (res.settings || null) : null;
    } catch (_) {
      return null;
    }
  },
  loadSync() {
    try {
      if (!hasDesktop() || !window.desktop.settings?.loadSync) return { ok: true, settings: null };
      return window.desktop.settings.loadSync();
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  },
  async save(settings) {
    try {
      if (!hasDesktop() || !window.desktop.settings?.save) return { ok: false, error: 'desktop-bridge-missing' };
      const res = await window.desktop.settings.save(settings);
      return res && res.ok ? { ok: true } : { ok: false, error: (res && res.error) || 'save-failed' };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }
};

