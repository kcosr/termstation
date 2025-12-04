import { test, expect } from 'vitest';

// Smoke tests for frontend websocket stdin_injected handler.
// Provides minimal shims for browser globals so the frontend modules
// can be imported in a Node/Vitest environment without throwing.

function createStubElement() {
  return {
    parentNode: null,
    appendChild: () => {},
    insertBefore: () => {},
    addEventListener: () => {},
    contains: () => false,
    querySelector: () => createStubElement(),
    classList: { add: () => {}, remove: () => {} },
    style: {},
    setAttribute: () => {}
  };
}

const body = createStubElement();
const documentStub = {
  body,
  head: createStubElement(),
  getElementById: () => null,
  querySelector: () => body,
  createElement: () => createStubElement(),
  createElementNS: () => createStubElement(),
  addEventListener: () => {}
};
body.parentNode = body;

global.document = documentStub;
global.window = {
  __DEBUG__: false,
  matchMedia: () => ({
    matches: false,
    addListener: () => {},
    removeListener: () => {}
  }),
  location: {
    reload: () => {}
  },
  desktop: {}
};
const _store = new Map();
global.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); }
};

test('handlers index exports stdin_injected mapping', async () => {
  const { handlers } = await import('../../frontend/public/js/modules/websocket/handlers/index.js');
  expect(typeof handlers).toBe('object');
  expect(typeof handlers['stdin_injected']).toBe('function');
});

test('stdin-injected handler executes without throwing', async () => {
  const { stdinInjectedHandler } = await import('../../frontend/public/js/modules/websocket/handlers/stdin-injected-handler.js');
  const msg = { type: 'stdin_injected', session_id: 'sess-1', by: 'tester', bytes: 3, submit: false, enter_style: 'cr', raw: false };
  // Should not throw even with minimal context
  stdinInjectedHandler.handle(msg, {});
  expect(true).toBe(true);
});
