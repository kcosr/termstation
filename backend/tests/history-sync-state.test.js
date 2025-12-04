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

describe('TerminalSession history sync state', () => {
  it('markClientHistoryLoaded clears queued state after history fetch', () => {
    const session = new TerminalSession({
      session_id: 'test-session',
      save_session_history: false
    });

    session.markClientLoadingHistory('client-1', 7);
    session.queueOutputForClient('client-1', 'output-chunk');

    expect(session.clientHistorySync.size).toBe(1);

    const queued = session.markClientHistoryLoaded('client-1');

    expect(queued).toEqual(['output-chunk']);
    expect(session.clientHistorySync.size).toBe(0);
  });

  it('detachClient clears pending history sync state', () => {
    const session = new TerminalSession({
      session_id: 'test-session-detach'
    });

    session.markClientLoadingHistory('client-2', 3);
    session.connected_clients.add('client-2');

    session.detachClient('client-2');

    expect(session.clientHistorySync.size).toBe(0);
  });
});
