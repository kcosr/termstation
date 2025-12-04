import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let TerminalSession;
let onSessionInactiveMock;

beforeEach(async () => {
  vi.useFakeTimers();
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  vi.resetModules();

  // Spy on onSessionInactive so we can verify when inactivity is detected.
  onSessionInactiveMock = vi.fn();
  vi.doMock('../utils/input-deferral.js', async () => {
    const actual = await vi.importActual('../utils/input-deferral.js');
    return {
      ...actual,
      onSessionInactive: onSessionInactiveMock
    };
  });

  // Stub node-pty so createPtyProcess does not spawn a real shell.
  vi.doMock('node-pty', () => {
    return {
      spawn: () => {
        return {
          onData: () => {},
          onExit: () => {},
          write: () => {},
          resize: () => {},
          kill: () => {}
        };
      }
    };
  });

  ({ TerminalSession } = await import('../models/terminal-session.js'));
});

afterEach(() => {
  vi.useRealTimers();
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
  vi.resetModules();
});

test('createPtyProcess + inactivity timer triggers deferred delivery for sessions with no PTY output', async () => {
  const session = new TerminalSession({
    session_id: 'idle-session',
    working_directory: process.cwd(),
    save_session_history: false
  });

  await session.createPtyProcess();

  expect(session.is_active).toBe(true);
  expect(session._outputActive).toBe(true);

  await vi.runAllTimersAsync();

  expect(onSessionInactiveMock).toHaveBeenCalledTimes(1);
  expect(onSessionInactiveMock).toHaveBeenCalledWith('idle-session');
});
