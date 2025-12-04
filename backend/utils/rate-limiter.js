/**
 * Simple fixed-window rate limiter helper
 *
 * Usage:
 *   const rl = new FixedWindowRateLimiter(100, 1000); // 100 ops / 1s
 *   if (!rl.allow('key')) reject();
 *
 * Rationale:
 * - Fixed window is sufficient for coarse limits on interactive ops
 * - Keeps implementation minimal; avoids timer churn per token
 */
export class FixedWindowRateLimiter {
  /**
   * @param {number} limitPerWindow - max operations per window
   * @param {number} windowMs - window size in ms (default 1000)
   */
  constructor(limitPerWindow, windowMs = 1000) {
    this.limit = Math.max(0, Number(limitPerWindow) | 0);
    this.windowMs = Math.max(1, Number(windowMs) | 0);
    /** @type {Map<string, {count:number, start:number}>} */
    this.buckets = new Map();
    this._lastSweep = 0;
    this._calls = 0;
  }

  /**
   * Attempt to consume 1 operation for the given key
   * @param {string} key
   * @returns {{allowed:boolean, remaining:number, resetMs:number}}
   */
  tryConsume(key) {
    const now = Date.now();
    // Opportunistic sweep to prevent unbounded bucket growth
    // Sweep at most once per window or every 1024 calls
    const needSweep = (now - this._lastSweep) >= this.windowMs || (++this._calls % 1024) === 0;
    if (needSweep) {
      for (const [k, b] of this.buckets) {
        if ((now - (b?.start || 0)) >= this.windowMs) {
          this.buckets.delete(k);
        }
      }
      this._lastSweep = now;
    }
    const k = String(key || '');
    const b = this.buckets.get(k);
    if (!b || (now - b.start) >= this.windowMs) {
      // Reset window
      const start = now;
      const count = 1;
      this.buckets.set(k, { count, start });
      return { allowed: true, remaining: Math.max(0, this.limit - count), resetMs: this.windowMs };
    }
    if (b.count < this.limit) {
      b.count += 1;
      return { allowed: true, remaining: Math.max(0, this.limit - b.count), resetMs: Math.max(0, this.windowMs - (now - b.start)) };
    }
    // Rejected
    return { allowed: false, remaining: 0, resetMs: Math.max(0, this.windowMs - (now - b.start)) };
  }

  /**
   * Convenience boolean API
   * @param {string} key
   * @returns {boolean}
   */
  allow(key) {
    return this.tryConsume(key).allowed;
  }
}
