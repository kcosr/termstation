import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let dataDir;
let stubDir;
let stubPath;
let config;
let SessionManager;

beforeAll(async () => {
  // Create a temporary stub for pty-to-html that writes simple HTML to the requested output file.
  stubDir = mkdtempSync(join(tmpdir(), 'ts-html-stub-'));
  stubPath = join(stubDir, 'pty-to-html-stub.js');
  const stubSource = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let out = null;
let logFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' && i + 1 < args.length) {
    out = args[i + 1];
    i++;
  } else {
    logFile = args[i];
  }
}
if (!out || !logFile) {
  process.stderr.write('Missing -o or log file');
  process.exit(1);
}
let content = '';
try { content = fs.readFileSync(logFile, 'utf8'); } catch (_) {}
const html = '<html><body><pre>' + content.replace(/</g, '&lt;') + '</pre></body></html>';
fs.writeFileSync(out, html, 'utf8');
`;
  writeFileSync(stubPath, stubSource, { encoding: 'utf8' });
  chmodSync(stubPath, 0o755);

  dataDir = mkdtempSync(join(tmpdir(), 'ts-html-data-'));
  const overrides = {
    data_dir: dataDir
  };
  configDir = createTestConfig(overrides);
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ config } = await import('../config-loader.js'));
  ({ SessionManager } = await import('../managers/session-manager.js'));
});

afterAll(() => {
  try {
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  } catch (_) {}
  try {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  } catch (_) {}
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

function createTerminatedSessionStub(sessionId, logContent = 'hello\n') {
  const mgr = new SessionManager();
  const logsDir = config.SESSIONS_DIR;
  mkdirSync(logsDir, { recursive: true });

  const scriptLogFile = `${sessionId}.log`;
  const logPath = join(logsDir, scriptLogFile);
  writeFileSync(logPath, logContent, { encoding: 'utf8' });

  const now = new Date().toISOString();
  const session = {
    session_id: sessionId,
    session_alias: null,
    command: 'echo test',
    command_preview: undefined,
    working_directory: '/tmp',
    created_at: now,
    last_output_at: now,
    created_by: 'testuser',
    ended_at: now,
    exit_code: 0,
    terminal_size: { cols: 80, rows: 24 },
    script_logs_dir: logsDir,
    script_log_file: scriptLogFile,
    title: 'Test Session',
    dynamic_title: '',
    visibility: 'private',
    interactive: false,
    load_history: true,
    save_session_history: true,
    links: [],
    template_id: null,
    template_name: null,
    template_badge_label: null,
    isolation_mode: 'none',
    container_name: null,
    container_runtime: null,
    parent_session_id: null,
    template_parameters: {},
    workspace: 'Default',
    workspace_order: null,
    is_fork: false,
    forked_from_session_id: null,
    stop_inputs_enabled: true,
    stop_inputs: [],
    stop_inputs_rearm_remaining: 0,
    note: '',
    note_version: 0,
    note_updated_at: null,
    note_updated_by: null,
    ephemeral_bind_mounts: [],
    inputMarkers: [],
    renderMarkers: [],
    history_view_mode: 'text',
    has_html_history: false,
    history_html_file: null,
    save_workspace_dir: false,
    save_bootstrap_dir: false,
    is_active: false,
    _isTerminating: false,
    terminate() {
      this.is_active = false;
      this.ended_at = new Date().toISOString();
    },
    async finalizeHistory() {
      return;
    }
  };

  mgr.sessions.set(sessionId, session);
  return { mgr, session, logsDir, logPath };
}

describe('terminated session HTML history mode', () => {
  it('default text mode records text metadata and does not require HTML file', async () => {
    const originalMode = config.TERMINATED_HISTORY_VIEW_MODE;
    const originalKeep = config.HISTORY_HTML_KEEP_LOG;
    const originalPath = config.PTY_TO_HTML_PATH;
    config.TERMINATED_HISTORY_VIEW_MODE = 'text';
    config.HISTORY_HTML_KEEP_LOG = true;
    config.PTY_TO_HTML_PATH = stubPath;

    const { mgr, session, logsDir, logPath } = createTerminatedSessionStub('sess-text-1', 'text-mode\n');
    await mgr.terminateSession(session.session_id);

    const metadataPath = join(logsDir, `${session.session_id}.json`);
    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(metadata.history_view_mode).toBe('text');
    expect(metadata.has_html_history).toBe(false);
    expect(metadata.history_html_file).toBeNull();
    // Raw log remains and no HTML file is created
    expect(existsSync(logPath)).toBe(true);
    const htmlPath = join(logsDir, `${session.session_id}.html`);
    expect(existsSync(htmlPath)).toBe(false);

    config.TERMINATED_HISTORY_VIEW_MODE = originalMode;
    config.HISTORY_HTML_KEEP_LOG = originalKeep;
    config.PTY_TO_HTML_PATH = originalPath;
  });

  it('html mode with keep_log=true generates HTML alongside log and updates metadata', async () => {
    const originalMode = config.TERMINATED_HISTORY_VIEW_MODE;
    const originalKeep = config.HISTORY_HTML_KEEP_LOG;
    const originalPath = config.PTY_TO_HTML_PATH;
    config.TERMINATED_HISTORY_VIEW_MODE = 'html';
    config.HISTORY_HTML_KEEP_LOG = true;
    config.PTY_TO_HTML_PATH = stubPath;

    const { mgr, session, logsDir, logPath } = createTerminatedSessionStub('sess-html-keep', 'hello html\n');
    await mgr.terminateSession(session.session_id);

    const metadataPath = join(logsDir, `${session.session_id}.json`);
    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(metadata.history_view_mode).toBe('html');
    expect(metadata.has_html_history).toBe(true);
    expect(metadata.history_html_file).toBe(`${session.session_id}.html`);

    const htmlPath = join(logsDir, `${session.session_id}.html`);
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('hello html');
    // Log is preserved when keep_log=true
    expect(existsSync(logPath)).toBe(true);

    config.TERMINATED_HISTORY_VIEW_MODE = originalMode;
    config.HISTORY_HTML_KEEP_LOG = originalKeep;
    config.PTY_TO_HTML_PATH = originalPath;
  });

  it('html mode with keep_log=false removes log after successful conversion', async () => {
    const originalMode = config.TERMINATED_HISTORY_VIEW_MODE;
    const originalKeep = config.HISTORY_HTML_KEEP_LOG;
    const originalPath = config.PTY_TO_HTML_PATH;
    config.TERMINATED_HISTORY_VIEW_MODE = 'html';
    config.HISTORY_HTML_KEEP_LOG = false;
    config.PTY_TO_HTML_PATH = stubPath;

    const { mgr, session, logsDir, logPath } = createTerminatedSessionStub('sess-html-drop', 'drop-log\n');
    await mgr.terminateSession(session.session_id);

    const metadataPath = join(logsDir, `${session.session_id}.json`);
    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(metadata.history_view_mode).toBe('html');
    expect(metadata.has_html_history).toBe(true);
    expect(metadata.history_html_file).toBe(`${session.session_id}.html`);

    const htmlPath = join(logsDir, `${session.session_id}.html`);
    expect(existsSync(htmlPath)).toBe(true);
    // Log file should be removed when keep_log=false
    expect(existsSync(logPath)).toBe(false);

    config.TERMINATED_HISTORY_VIEW_MODE = originalMode;
    config.HISTORY_HTML_KEEP_LOG = originalKeep;
    config.PTY_TO_HTML_PATH = originalPath;
  });

  it('html mode with invalid PTY_TO_HTML_PATH marks HTML as unavailable without deleting log', async () => {
    const originalMode = config.TERMINATED_HISTORY_VIEW_MODE;
    const originalKeep = config.HISTORY_HTML_KEEP_LOG;
    const originalPath = config.PTY_TO_HTML_PATH;
    config.TERMINATED_HISTORY_VIEW_MODE = 'html';
    config.HISTORY_HTML_KEEP_LOG = true;
    config.PTY_TO_HTML_PATH = '/nonexistent/pty-to-html';

    const { mgr, session, logsDir, logPath } = createTerminatedSessionStub('sess-html-missing-bin', 'missing-bin\n');
    await mgr.terminateSession(session.session_id);

    const metadataPath = join(logsDir, `${session.session_id}.json`);
    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(metadata.history_view_mode).toBe('html');
    expect(metadata.has_html_history).toBe(false);
    expect(metadata.history_html_file).toBeNull();

    const htmlPath = join(logsDir, `${session.session_id}.html`);
    expect(existsSync(htmlPath)).toBe(false);
    // Log file remains on failure/misconfiguration
    expect(existsSync(logPath)).toBe(true);

    config.TERMINATED_HISTORY_VIEW_MODE = originalMode;
    config.HISTORY_HTML_KEEP_LOG = originalKeep;
    config.PTY_TO_HTML_PATH = originalPath;
  });

  it('html mode handles empty log files and still generates valid HTML', async () => {
    const originalMode = config.TERMINATED_HISTORY_VIEW_MODE;
    const originalKeep = config.HISTORY_HTML_KEEP_LOG;
    const originalPath = config.PTY_TO_HTML_PATH;
    config.TERMINATED_HISTORY_VIEW_MODE = 'html';
    config.HISTORY_HTML_KEEP_LOG = true;
    config.PTY_TO_HTML_PATH = stubPath;

    const { mgr, session, logsDir, logPath } = createTerminatedSessionStub('sess-html-empty', '');
    await mgr.terminateSession(session.session_id);

    const metadataPath = join(logsDir, `${session.session_id}.json`);
    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(metadata.history_view_mode).toBe('html');
    expect(metadata.has_html_history).toBe(true);
    expect(metadata.history_html_file).toBe(`${session.session_id}.html`);

    const htmlPath = join(logsDir, `${session.session_id}.html`);
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('<pre>');
    // Original log was empty, so the HTML should not contain any of the sample strings from other tests
    expect(html.includes('hello html')).toBe(false);

    // Log is preserved in keep_log=true mode, even when empty
    expect(existsSync(logPath)).toBe(true);

    config.TERMINATED_HISTORY_VIEW_MODE = originalMode;
    config.HISTORY_HTML_KEEP_LOG = originalKeep;
    config.PTY_TO_HTML_PATH = originalPath;
  });
});
