import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let TerminalSession;
let config;
let spawnMock;

beforeEach(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  vi.resetModules();

  spawnMock = vi.fn(() => ({
    pid: 1234,
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {}
  }));

  vi.doMock('node-pty', () => ({
    spawn: spawnMock
  }));

  ({ TerminalSession } = await import('../models/terminal-session.js'));
  ({ config } = await import('../config-loader.js'));
});

afterEach(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
  vi.resetModules();
});

test('createPtyProcess exports SESSION_TOK and SESSIONS_API_BASE_URL for none isolation', async () => {
  const session = new TerminalSession({
    session_id: 'host-none-session',
    isolation_mode: 'none',
    session_token: 'tok-123',
    working_directory: process.cwd(),
    save_session_history: false
  });

  await session.createPtyProcess();

  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [, , spawnOptions] = spawnMock.mock.calls[0];
  expect(spawnOptions.env.SESSION_TOK).toBe('tok-123');
  expect(spawnOptions.env.SESSIONS_API_BASE_URL).toBe(config.SESSIONS_API_BASE_URL);
  expect(spawnOptions.env.SESSIONS_BASE_URL).toBe(config.SESSIONS_BASE_URL);
});
