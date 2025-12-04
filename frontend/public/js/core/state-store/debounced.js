const timers = new Map();

export async function debouncedSet(key, value, delay = 200) {
  try {
    // Backwards-compatible API: delegate to global batcher
    const mod = await import('./batch.js');
    mod.queueStateSet(key, value, delay);
  } catch (_) {}
}
