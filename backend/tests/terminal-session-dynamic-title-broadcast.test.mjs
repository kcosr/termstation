import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let TerminalSession;
let mockPtyProcess;

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    mockPtyProcess = {
      pid: 12345,
      _onData: null,
      _onExit: null,
      onData: vi.fn((cb) => { mockPtyProcess._onData = cb; }),
      onExit: vi.fn((cb) => { mockPtyProcess._onExit = cb; }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn()
    };
    return mockPtyProcess;
  })
}));

beforeEach(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ TerminalSession } = await import('../models/terminal-session.js'));
  global.connectionManager = { broadcast: vi.fn() };
});

afterEach(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
  delete global.connectionManager;
  mockPtyProcess = null;
  vi.clearAllMocks();
});

describe('TerminalSession OSC dynamic title broadcasts', () => {
  it('broadcasts dynamic title updates when no explicit title is set', async () => {
    const session = new TerminalSession({
      session_id: 'osc-broadcast-no-title',
      working_directory: '/tmp',
      save_session_history: false
    });

    await session.createPtyProcess();

    mockPtyProcess._onData('\u001b]0;Rotating title\u0007');

    expect(session.dynamic_title).toBe('Rotating title');
    expect(global.connectionManager.broadcast).toHaveBeenCalledTimes(1);
    expect(global.connectionManager.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_updated',
        update_type: 'updated',
        session_data: expect.objectContaining({
          session_id: 'osc-broadcast-no-title',
          dynamic_title: 'Rotating title'
        })
      })
    );
  });

  it('tracks dynamic title updates without broadcasting when an explicit title is set', async () => {
    const session = new TerminalSession({
      session_id: 'osc-broadcast-explicit-title',
      title: 'Pinned title',
      working_directory: '/tmp',
      save_session_history: false
    });

    await session.createPtyProcess();

    mockPtyProcess._onData('\u001b]0;Rotating title\u0007');

    expect(session.dynamic_title).toBe('Rotating title');
    expect(global.connectionManager.broadcast).not.toHaveBeenCalled();
  });
});
