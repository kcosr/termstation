import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestConfig, writeTestTemplates, cleanupTestConfig } from './helpers/test-utils.mjs';
import { join } from 'path';

// Auto-start behavior: verify that templates marked auto_start with a session_alias
// result in sessions being created and aliases registered in SessionManager.

let configDir;
let runAutoStartTemplates;
let SessionManager;
let originalCreatePtyProcess;

describe('auto-start templates', () => {
  beforeEach(async () => {
    // Use a dedicated config directory with a known data_dir and working directory
    configDir = createTestConfig({ data_dir: '/tmp/ts-auto-start-alias' });
    process.env.TERMSTATION_CONFIG_DIR = configDir;

    const templates = [
      {
        id: 'alias-test',
        name: 'Alias Test',
        description: 'Auto-start template alias test',
        isolation: 'none',
        session_alias: 'alias-test',
        auto_start: true,
        interactive: true,
        load_history: false,
        save_session_history: false,
        command: "bash -lc 'echo ready; exec bash'",
        // Use an existing directory to avoid working directory errors
        working_directory: join(process.cwd(), '..'),
        parameters: []
      }
    ];
    writeTestTemplates(configDir, templates);

    ({ SessionManager } = await import('../managers/session-manager.js'));
    const { TerminalSession } = await import('../models/terminal-session.js');

    // Stub PTY creation so we don't depend on node-pty or a real shell
    originalCreatePtyProcess = TerminalSession.prototype.createPtyProcess;
    // eslint-disable-next-line no-param-reassign
    TerminalSession.prototype.createPtyProcess = async function stubCreatePtyProcess() {
      this.is_active = true;
      return;
    };

    ({ runAutoStartTemplates } = await import('../services/auto-start.js'));

    global.sessionManager = new SessionManager();
    global.connectionManager = null;
    global.inputScheduler = null;
  });

  afterEach(async () => {
    try {
      const mod = await import('../template-loader.js');
      mod.templateLoader?.cleanup?.();
    } catch {
      // ignore
    }
    // Restore original PTY creation behavior
    if (originalCreatePtyProcess) {
      const { TerminalSession } = await import('../models/terminal-session.js');
      // eslint-disable-next-line no-param-reassign
      TerminalSession.prototype.createPtyProcess = originalCreatePtyProcess;
    }
    cleanupTestConfig(configDir);
    delete process.env.TERMSTATION_CONFIG_DIR;
    global.sessionManager = undefined;
    global.connectionManager = undefined;
    global.inputScheduler = undefined;
  });

  it('registers session aliases from auto-start templates', async () => {
    await runAutoStartTemplates({ logger: console });

    const sessions = global.sessionManager.getAllSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const s = sessions.find(x => x && x.template_id === 'alias-test') || sessions[0];
    expect(s).toBeTruthy();
    expect(s.session_alias).toBe('alias-test');
    expect(global.sessionManager.resolveIdFromAliasOrId('alias-test')).toBe(s.session_id);
  });
});
