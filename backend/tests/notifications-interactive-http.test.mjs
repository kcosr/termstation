import { beforeAll, afterAll, test, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let server;
let baseUrl;
let NotificationManager;
let notificationsRouter;

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;

  ({ NotificationManager } = await import('../managers/notification-manager.js'));
  const mod = await import('../routes/notifications.js');
  notificationsRouter = mod.default;

  const app = express();
  app.use(express.json());

  // Inject a fake authenticated user
  app.use((req, _res, next) => {
    req.user = { username: 'alice', permissions: { broadcast: true } };
    next();
  });

  // Initialize per-test NotificationManager and connectionManager
  const mgr = new NotificationManager();
  global.notificationManager = mgr;
  global.connectionManager = {
    broadcast: vi.fn()
  };

  app.use('/api/notifications', notificationsRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr && typeof addr.port === 'number' ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  delete global.notificationManager;
  delete global.connectionManager;
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

test('POST /api/notifications/:id/action returns ok and persists response summary', async () => {
  const mgr = global.notificationManager;

  const saved = mgr.add('alice', {
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

  const fetchCalls = [];
  const originalFetch = global.fetch;
  global.fetch = vi.fn(async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => null };
  });

  try {
    const resp = await originalFetch(`${baseUrl}/api/notifications/${encodeURIComponent(saved.id)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action_key: 'approve',
        inputs: {
          api_key: 'sk-secret',
          comment: 'Looks good'
        }
      })
    });

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('callback_succeeded');
    expect(body.error).toBeUndefined();
    expect(body.response).toBeTruthy();
    expect(body.response.action_key).toBe('approve');
    expect(body.response.inputs.comment).toBe('Looks good');
    expect(body.response.inputs.api_key).toBeUndefined();
    expect(Array.isArray(body.response.masked_input_ids)).toBe(true);
    expect(body.response.masked_input_ids).toContain('api_key');

    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0];
    expect(call.url).toBe('http://example.test/callback');

    const updated = mgr.getById('alice', saved.id);
    expect(updated).toBeTruthy();
    expect(updated.response).toBeTruthy();
    expect(updated.response.inputs.comment).toBe('Looks good');
    expect(updated.response.inputs.api_key).toBeUndefined();
    expect(updated.response.masked_input_ids).toContain('api_key');

    expect(global.connectionManager.broadcast).toHaveBeenCalled();
    const broadcastArgs = global.connectionManager.broadcast.mock.calls[0] || [];
    const payload = broadcastArgs[0];
    expect(payload.type).toBe('notification_action_result');
    expect(payload.notification_id).toBe(saved.id);
    expect(payload.action_key).toBe('approve');
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('callback_succeeded');
    expect(payload.user).toBe('alice');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/notifications/:id/action returns 404 when notification not found', async () => {
  const originalFetch = global.fetch;
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => null }));

  try {
    const resp = await originalFetch(`${baseUrl}/api/notifications/missing-id/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action_key: 'approve',
        inputs: {}
      })
    });

    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe('notification_not_found');
    expect(body.error).toBe('NOTIFICATION_NOT_FOUND');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/notifications/:id/action surfaces callback failure and still persists response summary', async () => {
  const mgr = global.notificationManager;

  const saved = mgr.add('alice', {
    title: 'Interactive',
    message: 'Provide API key',
    notification_type: 'info',
    session_id: 'sess-2',
    is_active: true,
    callback_url: 'http://example.test/callback-fail',
    callback_method: 'POST',
    actions: [
      { key: 'approve', label: 'Approve', requires_inputs: ['api_key'] }
    ],
    inputs: [
      { id: 'api_key', label: 'API Key', type: 'secret', required: true, max_length: 64 }
    ]
  });

  const originalFetch = global.fetch;
  global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => null }));

  try {
    const resp = await originalFetch(`${baseUrl}/api/notifications/${encodeURIComponent(saved.id)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action_key: 'approve',
        inputs: {
          api_key: 'sk-secret'
        }
      })
    });

    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe('callback_failed');
    expect(body.error).toBe('HTTP_403');
    expect(body.response).toBeTruthy();
    expect(Array.isArray(body.response.masked_input_ids)).toBe(true);
    expect(body.response.masked_input_ids).toContain('api_key');

    const updated = mgr.getById('alice', saved.id);
    expect(updated).toBeTruthy();
    expect(updated.response).toBeTruthy();
    expect(updated.response.action_key).toBe('approve');
    expect(updated.response.inputs.api_key).toBeUndefined();
    expect(updated.response.masked_input_ids).toContain('api_key');

    expect(global.connectionManager.broadcast).toHaveBeenCalled();
    const broadcastArgs = global.connectionManager.broadcast.mock.calls[global.connectionManager.broadcast.mock.calls.length - 1] || [];
    const payload = broadcastArgs[0];
    expect(payload.type).toBe('notification_action_result');
    expect(payload.notification_id).toBe(saved.id);
    expect(payload.action_key).toBe('approve');
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe('callback_failed');
    expect(payload.error).toBe('HTTP_403');
    expect(payload.http_status).toBe(403);
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/notifications/:id/cancel marks interactive notification as canceled and emits update', async () => {
  const mgr = global.notificationManager;

  const saved = mgr.add('alice', {
    title: 'Interactive',
    message: 'Needs input',
    notification_type: 'info',
    session_id: 'sess-cancel-1',
    is_active: true,
    callback_url: 'http://example.test/callback',
    callback_method: 'POST',
    actions: [
      { key: 'approve', label: 'Approve' }
    ],
    inputs: [
      { id: 'comment', label: 'Comment', type: 'string', required: false }
    ]
  });

  const originalFetch = global.fetch;

  try {
    const resp = await originalFetch(
      `${baseUrl}/api/notifications/${encodeURIComponent(saved.id)}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('canceled');
    expect(body.notification).toBeTruthy();
    expect(body.notification.is_active).toBe(false);
    expect(body.notification.response).toBeTruthy();
    expect(body.notification.response.status).toBe('canceled');
    expect(body.notification.response.action_label).toBe('Canceled');

    const updated = mgr.getById('alice', saved.id);
    expect(updated).toBeTruthy();
    expect(updated.is_active).toBe(false);
    expect(updated.response).toBeTruthy();
    expect(updated.response.status).toBe('canceled');
    expect(updated.response.action_label).toBe('Canceled');

    expect(global.connectionManager.broadcast).toHaveBeenCalled();
    const call = global.connectionManager.broadcast.mock.calls[
      global.connectionManager.broadcast.mock.calls.length - 1
    ] || [];
    const payload = call[0];
    expect(payload.type).toBe('notification_updated');
    expect(payload.notification_id).toBe(saved.id);
    expect(payload.user).toBe('alice');
    expect(payload.is_active).toBe(false);
    expect(payload.response).toBeTruthy();
    expect(payload.response.status).toBe('canceled');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/notifications/:id/cancel returns 404 when notification not found', async () => {
  const originalFetch = global.fetch;

  try {
    const resp = await originalFetch(
      `${baseUrl}/api/notifications/missing-id/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }
    );

    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe('notification_not_found');
    expect(body.error).toBe('NOT_FOUND');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/notifications/:id/cancel rejects non-interactive notifications', async () => {
  const mgr = global.notificationManager;

  const saved = mgr.add('alice', {
    title: 'Plain',
    message: 'Non-interactive',
    notification_type: 'info',
    session_id: 'sess-cancel-2',
    is_active: false
  });

  const originalFetch = global.fetch;

  try {
    const resp = await originalFetch(
      `${baseUrl}/api/notifications/${encodeURIComponent(saved.id)}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }
    );

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe('not_interactive');
    expect(body.error).toBe('NOT_INTERACTIVE');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/notifications/:id/cancel enforces single-use semantics for already responded notifications', async () => {
  const mgr = global.notificationManager;

  const saved = mgr.add('alice', {
    title: 'Interactive',
    message: 'Already responded',
    notification_type: 'info',
    session_id: 'sess-cancel-3',
    is_active: true,
    callback_url: 'http://example.test/callback',
    callback_method: 'POST',
    actions: [
      { key: 'approve', label: 'Approve' }
    ],
    inputs: []
  });

  // Seed an existing response
  mgr.setResponse('alice', saved.id, {
    at: new Date().toISOString(),
    user: 'alice',
    action_key: 'approve',
    action_label: 'Approve',
    status: 'callback_succeeded',
    inputs: {},
    masked_input_ids: []
  });

  const originalFetch = global.fetch;

  try {
    const resp = await originalFetch(
      `${baseUrl}/api/notifications/${encodeURIComponent(saved.id)}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }
    );

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe('already_responded');
    expect(body.error).toBe('ALREADY_RESPONDED');
    expect(body.response).toBeTruthy();
    expect(body.response.status).toBe('callback_succeeded');
  } finally {
    global.fetch = originalFetch;
  }
});
