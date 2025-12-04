// Global-batched state persistence for StateStore
// Accumulates key updates and writes the full state once per window.

import { getStateStore } from './index.js';
import { appStore } from '../store.js';

let pending = Object.create(null);
let timer = null;
let defaultDelay = 200;

export function setBatchDelay(ms) {
  defaultDelay = Math.max(0, Number(ms) || 0);
}

export function queueStateSet(key, value, delay = defaultDelay) {
  try {
    pending[key] = value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const store = getStateStore();
        // Load current state, merge pending, then save once
        const res = store.loadSync && store.loadSync();
        const current = res && res.ok ? (res.state || {}) : {};
        const merged = { ...current, ...pending };
        // Renderer-side log to help identify hot paths (gated by settings)
        try {
          const dbg = !!(appStore?.getState?.()?.preferences?.debug?.stateStoreLogs);
          if (dbg) console.log('[StateStore] batch.save', Object.keys(pending));
        } catch (_) {}
        pending = Object.create(null);
        timer = null;
        await store.save(merged);
      } catch (e) {
        // swallow to avoid breaking UI flows
        pending = Object.create(null);
        timer = null;
      }
    }, delay);
  } catch (_) {}
}
