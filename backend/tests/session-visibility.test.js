import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let handleSessionVisibilityUpdate;
let originalSessionManager;
let originalConnectionManager;
let configDir;

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  const { createSessionVisibilityHandler } = await import('../routes/handlers/session-visibility.js');
  handleSessionVisibilityUpdate = createSessionVisibilityHandler((req, session) => {
    if (req?.user?.permissions?.manage_all_sessions === true) return true;
    return String(session?.created_by || '') === String(req?.user?.username || '');
  });

  originalSessionManager = global.sessionManager;
  originalConnectionManager = global.connectionManager;

  global.connectionManager = {
    connections: new Map(),
    detachClientFromSession: () => {},
    sendToClient: () => {},
    broadcast: () => {}
  };
});

afterAll(() => {
  global.sessionManager = originalSessionManager;
  global.connectionManager = originalConnectionManager;
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('session visibility handler', () => {
it('updates visibility for terminated sessions and persists metadata', async () => {
  const sessionId = 'terminated-session-1';
  let persisted = false;

  const terminatedSession = {
    session_id: sessionId,
    created_by: 'owner',
    visibility: 'private',
    is_active: false,
    connected_clients: new Set(),
    toResponseObject() {
      return { session_id: this.session_id, visibility: this.visibility };
    }
  };

  global.sessionManager = {
    getSession: () => null,
    async getSessionIncludingTerminated(id) {
      return id === sessionId ? terminatedSession : null;
    },
    async saveTerminatedSessionMetadata(session, options) {
      if (session === terminatedSession && options?.force) {
        persisted = true;
      }
    },
    detachClientFromSession: () => {}
  };

  const res = createResponse();

  await handleSessionVisibilityUpdate({
    params: { sessionId },
    body: { visibility: 'public' },
    user: { username: 'owner' }
  }, res);

  expect(res.statusCode).toBe(200);
  expect(terminatedSession.visibility).toBe('public');
  expect(res.body.visibility).toBe('public');
  expect(res.body.previous).toBe('private');
  expect(persisted).toBe(true);
});

it('rejects visibility change for non-owner on terminated session', async () => {
  const sessionId = 'terminated-session-2';

  const terminatedSession = {
    session_id: sessionId,
    created_by: 'owner',
    visibility: 'private',
    is_active: false,
    toResponseObject() {
      return { session_id: this.session_id, visibility: this.visibility };
    }
  };

  global.sessionManager = {
    getSession: () => null,
    async getSessionIncludingTerminated(id) {
      return id === sessionId ? terminatedSession : null;
    },
    async saveTerminatedSessionMetadata() {
      throw new Error('should not be called');
    },
    detachClientFromSession: () => {}
  };

  const res = createResponse();

  await handleSessionVisibilityUpdate({
    params: { sessionId },
    body: { visibility: 'public' },
    user: { username: 'intruder' }
  }, res);

  expect(res.statusCode).toBe(403);
  expect(terminatedSession.visibility).toBe('private');
});

});
