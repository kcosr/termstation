import { beforeAll, afterAll, test, expect } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let config;

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ config } = await import('../config-loader.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

// Minimal Express-like response mock
function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    set(name, value) { this.headers[name] = value; return this; }
  };
}

// Test-only implementation of the POST /api/sessions/:id/input handler logic
async function handleInput(req, res) {
  // Permission gate
  if (!(req?.user?.permissions?.inject_session_input === true)) {
    return res.status(403).json({ error: 'Forbidden', details: 'inject_session_input permission required' });
  }

  const sessionId = req.params.sessionId;
  const session = global.sessionManager?.getSession?.(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.is_active) return res.status(409).json({ error: 'Session not active' });
  if (!session.interactive) return res.status(400).json({ error: 'Session is not interactive' });

  // Per-session API input message limit
  try {
    const maxPerSession = config.API_STDIN_MAX_MESSAGES_PER_SESSION;
    const currentCount = Number.isInteger(session.api_stdin_message_count)
      ? session.api_stdin_message_count
      : 0;
    if (Number.isInteger(maxPerSession) && maxPerSession >= 0) {
      if (currentCount >= maxPerSession) {
        return res.status(429).json({
          error: 'Input limit reached',
          details: `Session has reached the maximum number of input messages (${maxPerSession}) via the API`
        });
      }
      session.api_stdin_message_count = currentCount + 1;
    }
  } catch (_) { /* best-effort */ }

  const body = req.body || {};
  const data = (typeof body.data === 'string') ? body.data : '';
  const effectiveSubmit = (body.submit === undefined) ? true : (body.submit === true);
  const enterStyle = (typeof body.enter_style === 'string') ? body.enter_style.toLowerCase() : 'cr';
  const raw = body.raw === true;

  // Fire-and-forget delivery to PTY (stubbed)
  try { session.write?.(raw ? data : (data || '')); } catch (_) {}

  // Broadcast stdin_injected to connected clients
  try {
    const by = String(req?.user?.username || config.DEFAULT_USERNAME);
    const bytes = typeof data === 'string' ? data.length : 0;
    for (const clientId of (session.connected_clients || [])) {
      try {
        global.connectionManager?.sendToClient?.(clientId, {
          type: 'stdin_injected',
          session_id: sessionId,
          by,
          bytes,
          submit: effectiveSubmit,
          enter_style: enterStyle,
          raw
        });
      } catch (_) {}
    }
  } catch (_) {}

  return res.json({ ok: true, bytes: (typeof data === 'string' ? data.length : 0), submit: effectiveSubmit, enter_style: enterStyle, raw });
}

function makeSession(overrides = {}) {
  const s = {
    session_id: overrides.session_id || 'sess-1',
    is_active: overrides.is_active !== undefined ? overrides.is_active : true,
    interactive: overrides.interactive !== undefined ? overrides.interactive : true,
    created_by: overrides.created_by || 'tester',
    api_stdin_message_count: overrides.api_stdin_message_count ?? 0,
    connected_clients: new Set(overrides.connected_clients || []),
    writes: [],
    write: function (d) { this.writes.push(String(d ?? '')); return true; }
  };
  return s;
}

test('POST /:id/input guard: 403 when no inject permission', async () => {
  const res = createResponse();
  global.sessionManager = { getSession: () => makeSession() };
  const req = {
    params: { sessionId: 'x' },
    body: { data: 'echo hi', submit: false },
    user: { username: 'dev', permissions: {} }
  };
  await handleInput(req, res);
  expect(res.statusCode).toBe(403);
  expect(res.body?.error).toBe('Forbidden');
});

test('POST /:id/input guard: 404 when session missing', async () => {
  const res = createResponse();
  global.sessionManager = { getSession: () => null };
  const req = {
    params: { sessionId: 'missing' },
    body: { data: 'x' },
    user: { username: 'dev', permissions: { inject_session_input: true } }
  };
  await handleInput(req, res);
  expect(res.statusCode).toBe(404);
  expect(res.body?.error).toBe('Session not found');
});

test('POST /:id/input guard: 409 when session inactive', async () => {
  const res = createResponse();
  const sess = makeSession({ is_active: false });
  global.sessionManager = { getSession: () => sess };
  const req = {
    params: { sessionId: sess.session_id },
    body: { data: 'x' },
    user: { username: 'dev', permissions: { inject_session_input: true } }
  };
  await handleInput(req, res);
  expect(res.statusCode).toBe(409);
  expect(res.body?.error).toBe('Session not active');
});

test('POST /:id/input guard: 400 when session not interactive', async () => {
  const res = createResponse();
  const sess = makeSession({ interactive: false });
  global.sessionManager = { getSession: () => sess };
  const req = {
    params: { sessionId: sess.session_id },
    body: { data: 'x' },
    user: { username: 'dev', permissions: { inject_session_input: true } }
  };
  await handleInput(req, res);
  expect(res.statusCode).toBe(400);
  expect(res.body?.error).toBe('Session is not interactive');
});

test('POST /:id/input success: broadcasts stdin_injected (no cap: counter not incremented)', async () => {
  // Explicitly disable cap for this test to match intent
  const prevCap = config.API_STDIN_MAX_MESSAGES_PER_SESSION;
  config.API_STDIN_MAX_MESSAGES_PER_SESSION = null;
  const res = createResponse();
  const sess = makeSession({ connected_clients: ['c1', 'c2'] });
  global.sessionManager = { getSession: () => sess };
  const deliveries = [];
  global.connectionManager = { sendToClient: (cid, msg) => deliveries.push({ cid, msg }) };

  const req = {
    params: { sessionId: sess.session_id },
    body: { data: 'abc', submit: false },
    user: { username: 'dev', permissions: { inject_session_input: true } }
  };
  await handleInput(req, res);

  expect(res.statusCode).toBe(200);
  expect(res.body?.ok).toBe(true);
  expect(res.body?.bytes).toBe(3);
  expect(sess.writes.length > 0).toBe(true);
  expect(sess.api_stdin_message_count, 'no cap should not increment').toBe(0);
  // Broadcasts to all connected clients
  expect(deliveries.length).toBe(2);
  const types = new Set(deliveries.map(d => d.msg?.type));
  expect(types.has('stdin_injected')).toBe(true);
  // Restore previous cap
  config.API_STDIN_MAX_MESSAGES_PER_SESSION = prevCap;
});

test('POST /:id/input limit: returns 429 after cap and tracks counter', async () => {
  // Set a low cap for this test
  config.API_STDIN_MAX_MESSAGES_PER_SESSION = 2;
  const sess = makeSession();
  global.sessionManager = { getSession: () => sess };
  global.connectionManager = { sendToClient: () => {} };

  const commonReq = {
    params: { sessionId: sess.session_id },
    body: { data: 'x', submit: false },
    user: { username: 'dev', permissions: { inject_session_input: true } }
  };

  // First accepted
  let res1 = createResponse();
  await handleInput(commonReq, res1);
  expect(res1.statusCode).toBe(200);
  expect(sess.api_stdin_message_count).toBe(1);

  // Second accepted
  let res2 = createResponse();
  await handleInput(commonReq, res2);
  expect(res2.statusCode).toBe(200);
  expect(sess.api_stdin_message_count).toBe(2);

  // Third rejected
  let res3 = createResponse();
  await handleInput(commonReq, res3);
  expect(res3.statusCode).toBe(429);
  expect(res3.body?.error).toBe('Input limit reached');
  expect(sess.api_stdin_message_count).toBe(2);

  // Restore no cap
  config.API_STDIN_MAX_MESSAGES_PER_SESSION = null;
});
