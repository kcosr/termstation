// Desktop StateStore using Electron preload IPC

const hasDesktop = () => !!(window.desktop && window.desktop.isElectron);

async function readAll() {
  if (!hasDesktop() || !window.desktop.state?.load) return {};
  const res = await window.desktop.state.load();
  return (res && res.ok && res.state) ? res.state : {};
}

function readAllSync() {
  if (!hasDesktop() || !window.desktop.state?.loadSync) return { ok: true, state: {} };
  return window.desktop.state.loadSync();
}

export const DesktopStateStore = {
  kind: 'desktop',
  async load() { return readAll(); },
  loadSync() { return readAllSync(); },
  async save(state) {
    if (!hasDesktop() || !window.desktop.state?.save) return { ok: false, error: 'desktop-bridge-missing' };
    try { console.log('[StateStore] desktop.save (IPC)'); } catch (_) {}
    return window.desktop.state.save(state);
  },
  async get(key) {
    const all = await readAll();
    return key ? all[key] : all;
  },
  async set(key, value) {
    const all = await readAll();
    all[key] = value;
    try { console.log(`[StateStore] desktop.set ${key}`); } catch (_) {}
    return this.save(all);
  }
};
