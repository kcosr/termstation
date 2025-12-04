// Lightweight debug helper with centralized enable switch
// Usage: const log = createDebug('Terminal'); log.log('message', data);
import { getStateStore } from '../core/state-store/index.js';

function isEnabled() {
  // Default: ENABLED (temporary for diagnostics). Explicit false overrides.
  try { if (typeof window !== 'undefined' && (window.__DEBUG__ === false || window.DEBUG === false)) return false; } catch (_) {}
  try {
    const res = getStateStore().loadSync && getStateStore().loadSync();
    const st = res && res.ok ? (res.state || {}) : {};
    if (st['debug_enabled'] === false || st['debug_enabled'] === '0') return false;
  } catch (_) { /* ignore */ }
  return true;
}

export function createDebug(scope = 'debug') {
  const tag = `[${scope}]`;
  const api = {
    log: (...args) => { if (isEnabled()) { try { console.log(tag, ...args); } catch (_) {} } },
    warn: (...args) => { if (isEnabled()) { try { console.warn(tag, ...args); } catch (_) {} } },
    error: (...args) => { try { console.error(tag, ...args); } catch (_) {} },
  };
  // alias common method name used by some modules
  api.debug = api.log;
  return api;
}

// Back-compat singleton for modules importing `{ debug }`
export const debug = createDebug('debug');
