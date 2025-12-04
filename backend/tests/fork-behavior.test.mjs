import { test } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestConfig, writeTestTemplates, cleanupTestConfig } from './helpers/test-utils.mjs';

// Minimal smoke test to validate that forking a template with fork_pre_commands defined
// results in pre.sh reflecting fork_pre_commands (or being omitted when empty),
// and that overlaying prior bootstrap does not reintroduce old scripts.

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

async function runForkBehaviorTest() {
  const configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;

  const templates = [
    {
      id: 'claude',
      name: 'Claude',
      command: 'echo main',
      pre_commands: ['echo PRE_ORIGINAL'],
      fork_pre_commands: [],
      fork_post_commands: [],
      fork_command: 'echo forked'
    }
  ];
  writeTestTemplates(configDir, templates);

  const { templateLoader } = await import('../template-loader.js');
  const { buildSessionWorkspace } = await import('../services/session-workspace-builder.js');
  const { resolveConfigPath, config } = await import('../config-loader.js');

  try {
    const tpl = templateLoader.getTemplate('claude');
    if (!tpl) {
      throw new Error(`[fork-test] template "claude" not found; templates file: ${resolveConfigPath('templates.json')}`);
    }

    // Emulate the sessions route fork selection logic
    const forkSourceId = '00000000-0000-0000-0000-000000000000';
    void forkSourceId; // unused but retained for clarity
    const clone = Object.assign(Object.create(Object.getPrototypeOf(tpl)), tpl);
    if (Object.prototype.hasOwnProperty.call(tpl, 'fork_pre_commands')) {
      clone.pre_commands = Array.isArray(tpl.fork_pre_commands) ? tpl.fork_pre_commands : [];
    }
    if (Object.prototype.hasOwnProperty.call(tpl, 'fork_post_commands')) {
      clone.post_commands = Array.isArray(tpl.fork_post_commands) ? tpl.fork_post_commands : [];
    }
    if (Object.prototype.hasOwnProperty.call(tpl, 'fork_command')) {
      clone.command = (typeof tpl.fork_command === 'string') ? tpl.fork_command : (tpl.command || '');
    }

    const sessionId = '11111111-1111-1111-1111-111111111111';
    await buildSessionWorkspace({ sessionId, template: clone, variables: { session_id: sessionId } });
    const dir = path.join(config.SESSIONS_DIR, sessionId, 'workspace', '.bootstrap');
    const preSh = readFileSafe(path.join(dir, 'scripts', 'pre.sh'));
    if (preSh && preSh.trim()) {
      throw new Error(`[fork-test] Expected empty or missing pre.sh for forked claude, got content: ${preSh.slice(0, 200)}`);
    }
  } finally {
    try { templateLoader.cleanup?.(); } catch {}
    cleanupTestConfig(configDir);
    delete process.env.TERMSTATION_CONFIG_DIR;
  }
}

test('forked template does not reintroduce pre.sh content', async () => {
  await runForkBehaviorTest();
});
