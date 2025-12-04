import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let TerminalSession;

beforeEach(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ TerminalSession } = await import('../models/terminal-session.js'));
});

afterEach(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('TerminalSession workspace service metadata', () => {
  it('propagates workspace_service_enabled_for_session to history and responses', () => {
    const session = new TerminalSession({
      session_id: 'ws-enabled',
      workspace_service_enabled_for_session: true,
      save_session_history: false
    });

    const resp = session.toResponseObject();
    const history = session.getHistory();

    expect(resp.workspace_service_enabled_for_session).toBe(true);
    expect(history.workspace_service_enabled_for_session).toBe(true);

    const sessionDisabled = new TerminalSession({
      session_id: 'ws-disabled',
      save_session_history: false
    });
    const respDisabled = sessionDisabled.toResponseObject();
    const historyDisabled = sessionDisabled.getHistory();

    expect(respDisabled.workspace_service_enabled_for_session).toBe(false);
    expect(historyDisabled.workspace_service_enabled_for_session).toBe(false);
  });

  it('propagates workspace_service_port to history and responses', () => {
    const session = new TerminalSession({
      session_id: 'ws-port',
      workspace_service_enabled_for_session: true,
      workspace_service_port: 45678,
      save_session_history: false
    });

    const resp = session.toResponseObject();
    const history = session.getHistory();

    expect(resp.workspace_service_port).toBe(45678);
    expect(history.workspace_service_port).toBe(45678);

    const sessionNoPort = new TerminalSession({
      session_id: 'ws-no-port',
      workspace_service_enabled_for_session: true,
      save_session_history: false
    });
    const respNoPort = sessionNoPort.toResponseObject();
    const historyNoPort = sessionNoPort.getHistory();

    expect(respNoPort.workspace_service_port).toBeNull();
    expect(historyNoPort.workspace_service_port).toBeNull();
  });
});
