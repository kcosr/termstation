import { beforeAll, afterAll, test, expect } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  await import('../config-loader.js');
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

test('registerDeferredInput dedupes by key+content and lists entries', async () => {
  const mod = await import('../utils/input-deferral.js');
  const { registerDeferredInput, listDeferredInput, clearDeferredInputForSession } = mod;

  const sid = 'sess-def-1';
  clearDeferredInputForSession(sid);

  const first = registerDeferredInput(sid, {
    key: 'api-input',
    source: 'api',
    data: 'echo hi',
    options: { submit: true, raw: false, enter_style: 'cr', activity_policy: 'defer' }
  });
  expect(first).not.toBeNull();

  // Duplicate with same key/content is ignored
  const dup = registerDeferredInput(sid, {
    key: 'api-input',
    source: 'api',
    data: 'echo hi',
    options: { submit: true, raw: false, enter_style: 'cr', activity_policy: 'defer' }
  });
  expect(dup).toBeNull();

  const items = listDeferredInput(sid);
  expect(items.length).toBe(1);
  expect(items[0].key).toBe('api-input');
  expect(items[0].bytes).toBe('echo hi'.length);

  const cleared = clearDeferredInputForSession(sid);
  expect(cleared).toBe(1);
});

test('onSessionInactive decrements stop_inputs rearm counter when > 0', async () => {
  const mod = await import('../utils/input-deferral.js');
  const { onSessionInactive, clearDeferredInputForSession } = mod;

  const sessionId = 'sess-rearm-decrement';
  clearDeferredInputForSession(sessionId);

  const session = {
    session_id: sessionId,
    is_active: true,
    interactive: true,
    stop_inputs_enabled: true,
    stop_inputs: [
      { id: 'p1', prompt: 'echo hi', armed: true, source: 'template' }
    ],
    stop_inputs_rearm_remaining: 2,
    last_user_input_at: 0,
    created_by: 'testuser',
    connected_clients: new Set(),
    write: () => {}
  };

  const prevSessionManager = global.sessionManager;
  const prevConnectionManager = global.connectionManager;
  global.sessionManager = {
    getSession: (sid) => (sid === sessionId ? session : null)
  };
  global.connectionManager = {
    broadcast: () => {},
    sendToClient: () => {}
  };

  try {
    await onSessionInactive(sessionId);
  } finally {
    global.sessionManager = prevSessionManager;
    global.connectionManager = prevConnectionManager;
  }

  expect(session.stop_inputs_enabled).toBe(true);
  expect(session.stop_inputs_rearm_remaining).toBe(1);
});

test('onSessionInactive disables stop inputs when rearm counter is zero', async () => {
  const mod = await import('../utils/input-deferral.js');
  const { onSessionInactive, clearDeferredInputForSession } = mod;

  const sessionId = 'sess-rearm-disable';
  clearDeferredInputForSession(sessionId);

  const session = {
    session_id: sessionId,
    is_active: true,
    interactive: true,
    stop_inputs_enabled: true,
    stop_inputs: [
      { id: 'p1', prompt: 'echo hi', armed: true, source: 'template' }
    ],
    stop_inputs_rearm_remaining: 0,
    last_user_input_at: 0,
    created_by: 'testuser',
    connected_clients: new Set(),
    write: () => {}
  };

  const prevSessionManager = global.sessionManager;
  const prevConnectionManager = global.connectionManager;
  global.sessionManager = {
    getSession: (sid) => (sid === sessionId ? session : null)
  };
  global.connectionManager = {
    broadcast: () => {},
    sendToClient: () => {}
  };

  try {
    await onSessionInactive(sessionId);
  } finally {
    global.sessionManager = prevSessionManager;
    global.connectionManager = prevConnectionManager;
  }

  expect(session.stop_inputs_enabled).toBe(false);
  expect(session.stop_inputs_rearm_remaining).toBe(0);
});

test('onSessionInactive skips stop inputs when session is too new (within session_start_grace_ms)', async () => {
  const mod = await import('../utils/input-deferral.js');
  const { onSessionInactive, clearDeferredInputForSession } = mod;

  const sessionId = 'sess-start-grace-skip';
  clearDeferredInputForSession(sessionId);

  // Session created 5 seconds ago (5000ms), default grace is 15000ms
  const recentCreatedAt = new Date(Date.now() - 5000).toISOString();

  const session = {
    session_id: sessionId,
    is_active: true,
    interactive: true,
    stop_inputs_enabled: true,
    stop_inputs: [
      { id: 'p1', prompt: 'echo hi', armed: true, source: 'template' }
    ],
    stop_inputs_rearm_remaining: 5,
    last_user_input_at: 0,
    created_at: recentCreatedAt,
    created_by: 'testuser',
    connected_clients: new Set(),
    write: () => {}
  };

  const prevSessionManager = global.sessionManager;
  const prevConnectionManager = global.connectionManager;
  global.sessionManager = {
    getSession: (sid) => (sid === sessionId ? session : null)
  };
  global.connectionManager = {
    broadcast: () => {},
    sendToClient: () => {}
  };

  try {
    await onSessionInactive(sessionId);
  } finally {
    global.sessionManager = prevSessionManager;
    global.connectionManager = prevConnectionManager;
  }

  // Rearm counter should NOT have decremented because injection was skipped
  expect(session.stop_inputs_enabled).toBe(true);
  expect(session.stop_inputs_rearm_remaining).toBe(5);
});

test('onSessionInactive injects stop inputs when session is old enough (beyond session_start_grace_ms)', async () => {
  const mod = await import('../utils/input-deferral.js');
  const { onSessionInactive, clearDeferredInputForSession } = mod;

  const sessionId = 'sess-start-grace-inject';
  clearDeferredInputForSession(sessionId);

  // Session created 20 seconds ago (20000ms), default grace is 15000ms
  const oldCreatedAt = new Date(Date.now() - 20000).toISOString();

  const session = {
    session_id: sessionId,
    is_active: true,
    interactive: true,
    stop_inputs_enabled: true,
    stop_inputs: [
      { id: 'p1', prompt: 'echo hi', armed: true, source: 'template' }
    ],
    stop_inputs_rearm_remaining: 5,
    last_user_input_at: 0,
    created_at: oldCreatedAt,
    created_by: 'testuser',
    connected_clients: new Set(),
    write: () => {}
  };

  const prevSessionManager = global.sessionManager;
  const prevConnectionManager = global.connectionManager;
  global.sessionManager = {
    getSession: (sid) => (sid === sessionId ? session : null)
  };
  global.connectionManager = {
    broadcast: () => {},
    sendToClient: () => {}
  };

  try {
    await onSessionInactive(sessionId);
  } finally {
    global.sessionManager = prevSessionManager;
    global.connectionManager = prevConnectionManager;
  }

  // Rearm counter should have decremented because injection was performed
  expect(session.stop_inputs_enabled).toBe(true);
  expect(session.stop_inputs_rearm_remaining).toBe(4);
});

test('onSessionInactive concatenates multiple deferred inputs with newlines', async () => {
  const mod = await import('../utils/input-deferral.js');
  const { registerDeferredInput, onSessionInactive, clearDeferredInputForSession } = mod;

  const sessionId = 'sess-multi-defer';
  clearDeferredInputForSession(sessionId);

  // Register multiple deferred inputs
  registerDeferredInput(sessionId, {
    key: 'input-1',
    source: 'api',
    data: 'T1',
    options: { submit: true, raw: false, enter_style: 'cr', activity_policy: 'defer' }
  });

  registerDeferredInput(sessionId, {
    key: 'input-2',
    source: 'api',
    data: 'T2',
    options: { submit: true, raw: false, enter_style: 'cr', activity_policy: 'defer' }
  });

  registerDeferredInput(sessionId, {
    key: 'input-3',
    source: 'api',
    data: 'T3',
    options: { submit: true, raw: false, enter_style: 'cr', activity_policy: 'defer' }
  });

  let writtenData = '';
  const session = {
    session_id: sessionId,
    is_active: true,
    interactive: true,
    stop_inputs_enabled: false,
    stop_inputs: [],
    created_by: 'testuser',
    connected_clients: new Set(),
    write: (data) => { writtenData += data; }
  };

  const prevSessionManager = global.sessionManager;
  const prevConnectionManager = global.connectionManager;
  global.sessionManager = {
    getSession: (sid) => (sid === sessionId ? session : null)
  };
  global.connectionManager = {
    broadcast: () => {},
    sendToClient: () => {}
  };

  try {
    await onSessionInactive(sessionId);
    // Give async writes time to complete
    await new Promise(resolve => setTimeout(resolve, 300));
  } finally {
    global.sessionManager = prevSessionManager;
    global.connectionManager = prevConnectionManager;
  }

  // The written data should contain all three inputs separated by newlines
  expect(writtenData).toContain('T1\nT2\nT3');
});
