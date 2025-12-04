import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let TerminalSession;
let serializeSessionForHistoryList;
let resolveSessionWorkspaceHostPath;

beforeAll(async () => {
  configDir = createTestConfig({
    features: {
      workspace_service_enabled: true
    }
  });
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ TerminalSession } = await import('../models/terminal-session.js'));
  ({ serializeSessionForHistoryList } = await import('../utils/session-serializer.js'));
  ({ resolveSessionWorkspaceHostPath } = await import('../services/session-workspace-builder.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('Workspace service availability and history summaries', () => {
  it('marks workspace_service_available false when workspace directory is missing', () => {
    const sessionId = 'ws-no-dir';
    const session = new TerminalSession({
      session_id: sessionId,
      isolation_mode: 'container',
      workspace_service_enabled_for_session: true,
      workspace_service_port: 45678,
      save_session_history: true
    });

    const wsPath = resolveSessionWorkspaceHostPath(sessionId);
    rmSync(wsPath, { recursive: true, force: true });

    const summary = serializeSessionForHistoryList(session);
    expect(summary.workspace_service_enabled_for_session).toBe(true);
    expect(summary.workspace_service_available).toBe(false);
  });

  it('marks workspace_service_available true when workspace directory exists', () => {
    const sessionId = 'ws-with-dir';
    const session = new TerminalSession({
      session_id: sessionId,
      isolation_mode: 'container',
      workspace_service_enabled_for_session: true,
      workspace_service_port: 45678,
      save_session_history: true
    });

    const wsPath = resolveSessionWorkspaceHostPath(sessionId);
    mkdirSync(wsPath, { recursive: true });

    const summary = serializeSessionForHistoryList(session);
    expect(summary.workspace_service_enabled_for_session).toBe(true);
    expect(summary.workspace_service_available).toBe(true);
  });
});
