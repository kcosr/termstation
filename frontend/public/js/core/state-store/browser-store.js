// Browser StateStore backed by localStorage under a single JSON key

const STATE_KEY = 'terminal_manager_state';

function readState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function writeState(obj) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(obj));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

export const BrowserStateStore = {
  kind: 'browser',
  async load() { return readState(); },
  loadSync() { return { ok: true, state: readState() }; },
  async save(state) { return writeState(state); },
  async get(key) {
    const state = readState();
    return key ? state[key] : state;
  },
  async set(key, value) {
    const state = readState();
    state[key] = value;
    return writeState(state);
  }
};

