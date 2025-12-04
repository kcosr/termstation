import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let config;
let SessionManager;
let TerminalSession;

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ config } = await import('../config-loader.js'));
  ({ SessionManager } = await import('../managers/session-manager.js'));
  ({ TerminalSession } = await import('../models/terminal-session.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('workspace_service_port metadata persistence', () => {
  it('persists and reloads workspace_service_port for terminated sessions', async () => {
    const mgr = new SessionManager();
    const sessionId = 'ws-meta-1';
    const port = 48765;

    const session = new TerminalSession({
      session_id: sessionId,
      workspace_service_enabled_for_session: true,
      workspace_service_port: port,
      save_session_history: false
    });

    await mgr.saveTerminatedSessionMetadata(session, { force: true });

    const logsDir = config.SESSIONS_DIR;
    const metadataPath = join(logsDir, `${sessionId}.json`);
    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(metadata.workspace_service_enabled_for_session).toBe(true);
    expect(metadata.workspace_service_port).toBe(port);

    await mgr.loadTerminatedSessionsFromDisk();
    const reloaded = await mgr.getSessionIncludingTerminated(sessionId, { loadFromDisk: false });
    expect(reloaded).toBeTruthy();
    expect(reloaded.workspace_service_enabled_for_session).toBe(true);
    expect(reloaded.workspace_service_port).toBe(port);

    const history = await mgr.getSessionHistory(sessionId);
    expect(history.workspace_service_port).toBe(port);
  });
});
