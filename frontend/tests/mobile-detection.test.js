import test from 'node:test';
import assert from 'node:assert/strict';
import { isMobileRuntime } from '../public/js/utils/mobile-runtime.js';

test('isMobileRuntime returns false for narrow desktop browsers', () => {
  assert.equal(isMobileRuntime({
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' },
    window: { innerWidth: 500, desktop: null }
  }), false);
});

test('isMobileRuntime returns false for Electron desktop', () => {
  assert.equal(isMobileRuntime({
    navigator: { userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/122.0.0.0 Electron/30.0.0 Safari/537.36' },
    window: { desktop: { isElectron: true } }
  }), false);
});

test('isMobileRuntime returns true for mobile browser user agents', () => {
  assert.equal(isMobileRuntime({
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' },
    window: {}
  }), true);
});

test('isMobileRuntime returns true for Capacitor runtimes', () => {
  assert.equal(isMobileRuntime({
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' },
    window: { Capacitor: {} }
  }), true);
});
