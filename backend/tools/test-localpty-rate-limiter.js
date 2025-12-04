// Minimal unit test for a sliding window rate limiter (~100 ops/sec)
// This mirrors the helper embedded in desktop/preload.js for local PTY.

const assert = require('assert');

function createSessionRateLimiter(rate = 100, windowMs = 1000) {
  const buckets = new Map();
  const allow = (sessionId) => {
    const now = Date.now();
    const sid = String(sessionId || '').trim();
    if (!sid) return false;
    const b = buckets.get(sid) || { start: now, count: 0 };
    if (now - b.start >= windowMs) {
      b.start = now;
      b.count = 0;
    }
    if (b.count < rate) {
      b.count++;
      buckets.set(sid, b);
      return true;
    }
    return false;
  };
  const clear = () => buckets.clear();
  return { allow, clear };
}

// Tests
(function run() {
  const limiter = createSessionRateLimiter(100, 200); // use shorter window for test
  const sid = 'session-1';

  // First 100 should pass
  let ok = 0, fail = 0;
  for (let i = 0; i < 100; i++) {
    if (limiter.allow(sid)) ok++; else fail++;
  }
  assert.strictEqual(ok, 100, 'First 100 calls should be allowed');
  assert.strictEqual(fail, 0, 'No failures in first 100 calls');

  // 101st should fail
  assert.strictEqual(limiter.allow(sid), false, '101st call should be blocked');

  // After window elapses, should allow again
  setTimeout(() => {
    const ok2 = limiter.allow(sid);
    try {
      assert.strictEqual(ok2, true, 'Allow after window reset');
      console.log('ok');
    } catch (e) {
      console.error('fail:', e && e.message ? e.message : e);
      process.exit(1);
    }
  }, 220);
})();

