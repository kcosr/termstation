import { beforeAll, afterAll, test, expect, vi } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let NotificationManager;
let validateInteractiveNotificationBody;
let messageHandlers;

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;

  ({ NotificationManager } = await import('../managers/notification-manager.js'));
  ({ validateInteractiveNotificationBody } = await import('../routes/notifications.js'));
  ({ messageHandlers } = await import('../websocket/handlers.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

test('validateInteractiveNotificationBody normalizes interactive fields', () => {
  const body = {
    title: 'Interactive test',
    message: 'Provide inputs',
    callback_url: 'https://example.com/callback',
    callback_method: 'put',
    inputs: [
      { id: 'api_key', label: 'API Key', type: 'secret', required: true, max_length: 999999 },
      { id: 'comment', label: 'Comment' }
    ],
    actions: [
      { key: 'approve', label: 'Approve', style: 'PRIMARY', requires_inputs: ['api_key', 'comment'] },
      { key: 'deny', label: 'Deny' }
    ]
  };

  const result = validateInteractiveNotificationBody(body);
  expect(result.error).toBeUndefined();
  expect(result.isInteractive).toBe(true);

  const interactive = result.interactive;
  expect(interactive.callback_url).toBe('https://example.com/callback');
  expect(interactive.callback_method).toBe('PUT');
  expect(Array.isArray(interactive.actions)).toBe(true);
  expect(Array.isArray(interactive.inputs)).toBe(true);
  expect(interactive.actions.length).toBe(2);
  expect(interactive.inputs.length).toBe(2);

  const apiKeyInput = interactive.inputs.find((i) => i.id === 'api_key');
  expect(apiKeyInput).toBeTruthy();
  expect(apiKeyInput.type).toBe('secret');
  expect(typeof apiKeyInput.max_length).toBe('number');
  expect(apiKeyInput.max_length).toBeLessThanOrEqual(4096);
});

test('validateInteractiveNotificationBody rejects actions that reference unknown inputs', () => {
  const body = {
    title: 'Bad interactive',
    message: 'Invalid requires_inputs',
    callback_url: 'https://example.com/callback',
    inputs: [
      { id: 'api_key', label: 'API Key' }
    ],
    actions: [
      { key: 'approve', label: 'Approve', requires_inputs: ['missing'] }
    ]
  };

  const result = validateInteractiveNotificationBody(body);
  expect(result.error).toBeDefined();
  expect(result.error.body.error).toBe('INVALID_INTERACTIVE_NOTIFICATION');
});

test('notification_action persists response summary and masks secrets', async () => {
  const mgr = new NotificationManager();
  global.notificationManager = mgr;

  const username = 'alice';
  const saved = mgr.add(username, {
    title: 'Interactive',
    message: 'Provide API key',
    notification_type: 'info',
    session_id: 'sess-1',
    is_active: true,
    callback_url: 'http://example.test/callback',
    callback_method: 'POST',
    callback_headers: { 'X-Test': 'ok' },
    actions: [
      { key: 'approve', label: 'Approve', requires_inputs: ['api_key', 'comment'] }
    ],
    inputs: [
      { id: 'api_key', label: 'API Key', type: 'secret', required: true, max_length: 64 },
      { id: 'comment', label: 'Comment', type: 'string', required: false }
    ]
  });

  const sentMessages = [];
  const connections = new Map();
  connections.set('client-1', {
    username,
    readyState: 1,
    send: (msg) => {
      try {
        sentMessages.push(JSON.parse(msg));
      } catch {
        // ignore parse errors in tests
      }
    }
  });

  global.connectionManager = {
    connections,
    sendToClient: (clientId, payload) => {
      const ws = connections.get(clientId);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(payload));
        return true;
      }
      return false;
    }
  };

  const fetchCalls = [];
  const originalFetch = global.fetch;
  global.fetch = vi.fn(async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200 };
  });

  try {
    await messageHandlers.notification_action('client-1', {
      type: 'notification_action',
      notification_id: saved.id,
      action_key: 'approve',
      inputs: {
        api_key: 'sk-secret',
        comment: 'Looks good'
      }
    });
  } finally {
    global.fetch = originalFetch;
    delete global.notificationManager;
    delete global.connectionManager;
  }

  expect(fetchCalls.length).toBe(1);
  const call = fetchCalls[0];
  expect(call.url).toBe('http://example.test/callback');
  const payload = JSON.parse(call.options.body);
  expect(payload.inputs.api_key).toBe('sk-secret');
  expect(payload.inputs.comment).toBe('Looks good');

  const updated = mgr.getById(username, saved.id);
  expect(updated).toBeTruthy();
  expect(updated.response).toBeTruthy();
  expect(updated.response.action_key).toBe('approve');
  expect(updated.response.inputs.comment).toBe('Looks good');
  expect(updated.response.inputs.api_key).toBeUndefined();
  expect(updated.response.masked_input_ids).toContain('api_key');
  expect(updated.is_active).toBe(false);

  const resultMsg = sentMessages.find((m) => m.type === 'notification_action_result');
  expect(resultMsg).toBeTruthy();
  expect(resultMsg.notification_id).toBe(saved.id);
  expect(resultMsg.action_key).toBe('approve');
  expect(resultMsg.ok).toBe(true);
  expect(resultMsg.status).toBe('callback_succeeded');
});

test('notification_action enforces single-use semantics', async () => {
  const mgr = new NotificationManager();
  global.notificationManager = mgr;

  const username = 'alice';
  const saved = mgr.add(username, {
    title: 'Interactive',
    message: 'Provide API key',
    notification_type: 'info',
    session_id: 'sess-1',
    is_active: true,
    callback_url: 'http://example.test/callback',
    callback_method: 'POST',
    actions: [
      { key: 'approve', label: 'Approve', requires_inputs: ['api_key'] }
    ],
    inputs: [
      { id: 'api_key', label: 'API Key', type: 'secret', required: true, max_length: 64 }
    ]
  });

  const sentMessages = [];
  const connections = new Map();
  connections.set('client-2', {
    username,
    readyState: 1,
    send: (msg) => {
      try {
        sentMessages.push(JSON.parse(msg));
      } catch {
        // ignore
      }
    }
  });

  global.connectionManager = {
    connections,
    sendToClient: (clientId, payload) => {
      const ws = connections.get(clientId);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(payload));
        return true;
      }
      return false;
    }
  };

  const originalFetch = global.fetch;
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
  global.fetch = fetchSpy;

  try {
    // First response is accepted
    await messageHandlers.notification_action('client-2', {
      type: 'notification_action',
      notification_id: saved.id,
      action_key: 'approve',
      inputs: { api_key: 'sk-secret' }
    });

    // Second attempt should be rejected without calling the callback again
    await messageHandlers.notification_action('client-2', {
      type: 'notification_action',
      notification_id: saved.id,
      action_key: 'approve',
      inputs: { api_key: 'sk-secret-2' }
    });
  } finally {
    global.fetch = originalFetch;
    delete global.notificationManager;
    delete global.connectionManager;
  }

  expect(fetchSpy).toHaveBeenCalledTimes(1);

  const lastMsg = sentMessages[sentMessages.length - 1];
  expect(lastMsg).toBeTruthy();
  expect(lastMsg.type).toBe('notification_action_result');
  expect(lastMsg.ok).toBe(false);
  expect(lastMsg.status).toBe('already_responded');
});
