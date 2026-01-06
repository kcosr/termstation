/**
 * Tests for output history size limiting (issue #22 fix)
 * Ensures outputHistory doesn't grow beyond MAX_OUTPUT_HISTORY_SIZE
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let TerminalSession;
let config;

beforeEach(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  // Dynamic import to pick up test config
  const sessionModule = await import('../models/terminal-session.js');
  const configModule = await import('../config-loader.js');
  TerminalSession = sessionModule.TerminalSession;
  config = configModule.config;
});

afterEach(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('TerminalSession output history size limiting', () => {
  it('truncates outputHistory when it exceeds MAX_OUTPUT_HISTORY_SIZE', () => {
    // Create a session without starting the PTY
    const session = new TerminalSession({
      session_id: 'test-output-limit',
      interactive: false,
      load_history: false,
      save_session_history: false
    });

    // Use a small limit for testing (1KB)
    const testMaxSize = 1024;
    const originalMaxSize = config.MAX_OUTPUT_HISTORY_SIZE;
    config.MAX_OUTPUT_HISTORY_SIZE = testMaxSize;

    try {
      // Add data that exceeds the limit
      const chunk = 'A'.repeat(500);
      
      // First chunk - should fit
      session.logOutput(chunk);
      expect(session.outputHistory.length).toBe(500);

      // Second chunk - should fit
      session.logOutput(chunk);
      expect(session.outputHistory.length).toBe(1000);

      // Third chunk - would exceed 1024, should trigger truncation to ~75% (768)
      session.logOutput(chunk);
      // After truncation: target is 768, so we remove (1000+500-768)=732 bytes
      // New length should be 1500 - 732 = 768
      expect(session.outputHistory.length).toBeLessThanOrEqual(testMaxSize);
      expect(session.outputHistory.length).toBeGreaterThan(0);
    } finally {
      config.MAX_OUTPUT_HISTORY_SIZE = originalMaxSize;
    }
  });

  it('preserves most recent data when truncating', () => {
    const session = new TerminalSession({
      session_id: 'test-output-preserve',
      interactive: false,
      load_history: false,
      save_session_history: false
    });

    const testMaxSize = 100;
    const originalMaxSize = config.MAX_OUTPUT_HISTORY_SIZE;
    config.MAX_OUTPUT_HISTORY_SIZE = testMaxSize;

    try {
      // Add identifiable chunks
      session.logOutput('AAAA'); // 4 bytes
      session.logOutput('BBBB'); // 4 bytes  
      session.logOutput('CCCC'); // 4 bytes

      // Now add a large chunk that triggers truncation
      session.logOutput('D'.repeat(90));

      // The result should contain the most recent data (the D's)
      expect(session.outputHistory).toContain('DDDD');
      expect(session.outputHistory.length).toBeLessThanOrEqual(testMaxSize);
    } finally {
      config.MAX_OUTPUT_HISTORY_SIZE = originalMaxSize;
    }
  });

  it('appendHiddenHistoryMarker also respects size limit', () => {
    const session = new TerminalSession({
      session_id: 'test-marker-limit',
      interactive: false,
      load_history: false,
      save_session_history: false
    });

    const testMaxSize = 200;
    const originalMaxSize = config.MAX_OUTPUT_HISTORY_SIZE;
    config.MAX_OUTPUT_HISTORY_SIZE = testMaxSize;

    try {
      // Fill up most of the buffer
      session.logOutput('X'.repeat(180));

      // Add markers that would push over the limit
      for (let i = 0; i < 10; i++) {
        session.appendHiddenHistoryMarker('input', Date.now());
      }

      // Should not exceed the limit
      expect(session.outputHistory.length).toBeLessThanOrEqual(testMaxSize);
    } finally {
      config.MAX_OUTPUT_HISTORY_SIZE = originalMaxSize;
    }
  });
});
