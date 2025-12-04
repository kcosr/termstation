import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let dataDir;
let config;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ts-histsearch-data-'));
  const overrides = { data_dir: dataDir };
  configDir = createTestConfig(overrides);
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ config } = await import('../config-loader.js'));
});

afterAll(() => {
  try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('history search prefers HTML when available', () => {
  it('uses HTML content when both HTML and .log exist', async () => {
    const { getSearchableHistoryText } = await import('../utils/history-search.js');
    const logsDir = config.SESSIONS_DIR;
    mkdirSync(logsDir, { recursive: true });

    const sessionId = 'sess-search-html-pref';
    const logPath = join(logsDir, `${sessionId}.log`);
    const htmlPath = join(logsDir, `${sessionId}.html`);

    writeFileSync(logPath, 'plain log content\n', 'utf8');
    // Include tags and entities that should be normalized for search
    const html = '<html><body><pre>Hello <span>WORLD</span> &amp; Universe</pre></body></html>';
    writeFileSync(htmlPath, html, 'utf8');

    const session = {
      session_id: sessionId,
      is_active: false,
      script_logs_dir: logsDir,
      script_log_file: `${sessionId}.log`,
      history_html_file: `${sessionId}.html`
    };

    const text = await getSearchableHistoryText(session);
    expect(typeof text).toBe('string');
    expect(text.toLowerCase()).toContain('hello world & universe'.toLowerCase());
  });

  it('falls back to .log when HTML is missing', async () => {
    const { getSearchableHistoryText } = await import('../utils/history-search.js');
    const logsDir = config.SESSIONS_DIR;
    mkdirSync(logsDir, { recursive: true });

    const sessionId = 'sess-search-no-html';
    const logPath = join(logsDir, `${sessionId}.log`);
    writeFileSync(logPath, 'only in log file\n', 'utf8');

    const session = {
      session_id: sessionId,
      is_active: false,
      script_logs_dir: logsDir,
      script_log_file: `${sessionId}.log`,
      history_html_file: null
    };

    const text = await getSearchableHistoryText(session);
    expect(text).toContain('only in log file');
  });

  it('ignores unsafe history_html_file values and uses default path', async () => {
    const { getSearchableHistoryText } = await import('../utils/history-search.js');
    const logsDir = config.SESSIONS_DIR;
    mkdirSync(logsDir, { recursive: true });

    const sessionId = 'sess-search-default-html';
    const logPath = join(logsDir, `${sessionId}.log`);
    const htmlPath = join(logsDir, `${sessionId}.html`);
    writeFileSync(logPath, 'log content\n', 'utf8');
    writeFileSync(htmlPath, '<pre>from default html path</pre>', 'utf8');

    const session = {
      session_id: sessionId,
      is_active: false,
      script_logs_dir: logsDir,
      script_log_file: `${sessionId}.log`,
      // Attempt a path traversal; should be ignored and default path used
      history_html_file: '../outside.html'
    };

    const text = await getSearchableHistoryText(session);
    expect(text).toContain('from default html path');
  });
});

