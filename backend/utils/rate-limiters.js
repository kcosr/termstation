/**
 * Shared singleton rate limiters used across WS and HTTP layers.
 * Keeping these here ensures limits are truly shared (no doubling).
 */
import { FixedWindowRateLimiter } from './rate-limiter.js';

// Global: ~300 ops/sec across all operations
export const globalOpsLimiter = new FixedWindowRateLimiter(300, 1000);

// Per-session: ~100 ops/sec for stdin/resize/terminate
export const perSessionOpsLimiter = new FixedWindowRateLimiter(100, 1000);

// Per-user session create: ~10/sec
export const perUserCreateLimiter = new FixedWindowRateLimiter(10, 1000);

