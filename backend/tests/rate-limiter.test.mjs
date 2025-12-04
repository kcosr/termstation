import { test, expect } from 'vitest';
import { FixedWindowRateLimiter } from '../utils/rate-limiter.js';

// Basic unit-style checks for FixedWindowRateLimiter

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runRateLimiterTest() {
  const rl = new FixedWindowRateLimiter(5, 200); // 5 ops/200ms

  // Consume within window
  for (let i = 0; i < 5; i++) {
    expect(rl.allow('k1'), `should allow ${i + 1}`).toBe(true);
  }
  expect(rl.allow('k1'), 'should reject when over limit').toBe(false);

  // Different key unaffected
  expect(rl.allow('k2'), 'other key allowed').toBe(true);

  // Wait for window reset and try again
  await sleep(210);
  expect(rl.allow('k1'), 'should allow after window reset').toBe(true);
}

test('FixedWindowRateLimiter basic behavior', async () => {
  await runRateLimiterTest();
});

