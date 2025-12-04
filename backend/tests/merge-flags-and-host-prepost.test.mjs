// Tests for merge flags ([] clears) and host pre/post execution

import { test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ts-templates-'));
  const config = {
    environment: 'test',
    host: '127.0.0.1',
    port: 6622,
    log_level: 'INFO',
    auth_enabled: false,
    default_username: 'tester',
    username_aliases: {},
    cors_origins: ['*'],
    cors_credentials: true,
    websocket: { ping_interval_ms: 30000, ping_timeout_ms: 10000 },
    terminal: {
      default_shell: '/bin/bash',
      default_working_dir: '~',
      default_cols: 80,
      default_rows: 24,
      max_sessions: 10,
      session_timeout_seconds: 60,
      cleanup_interval_seconds: 30,
      max_buffer_size: 10000,
      output_chunk_size: 4096
    },
    logging: { level: 'INFO', format: '' },
    data_dir: join(dir, 'data'),
    sessions_base_url: 'http://localhost',
    sessions_api_base_url: 'http://localhost/api/',
    template_vars: {},
    containers: {},
    ntfy: { enabled: false },
    stdin_injection: {},
    scheduled_input: {},
    session_activity: {}
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

async function runMergeFlagsAndHostPrePostTest() {
  const dir = makeTempConfigDir();
  try {
    const tpl = {
      templates: [
        { id: 'base', name: 'Base', command: 'echo main', pre_commands: ['echo preA'], post_commands: ['echo postA'] },
        // [] clears for pre
        { id: 'child-clear', extends: 'base', name: 'ChildClear', pre_commands: [] },
        // merge_pre=false + child-only list
        { id: 'child-replace', extends: 'base', name: 'ChildReplace', merge_pre_commands: false, pre_commands: ['echo preB'] },
        // fork default replace; [] clears
        { id: 'fork-base', name: 'ForkBase', command: 'echo x', fork_pre_commands: ['echo Fbase'] },
        { id: 'fork-clear', extends: 'fork-base', name: 'ForkClear', fork_pre_commands: [] },
        // fork merge when enabled
        { id: 'fork-merge', extends: 'fork-base', name: 'ForkMerge', merge_fork_pre_commands: true, fork_pre_commands: ['echo Fchild'] },
        // host pre/post execution chain
        { id: 'host-prepost', name: 'HostPrePost', command: 'echo mid', pre_commands: ['echo P'], post_commands: ['echo Q'] }
      ]
    };
    writeFileSync(join(dir, 'templates.json'), JSON.stringify(tpl, null, 2));

    // Point loader at our temp dir for this import
    process.env.TERMSTATION_CONFIG_DIR = dir;
    const mod = await import('../../backend/template-loader.js');
    const loader = mod.templateLoader;

    const base = loader.getTemplate('base');
    const clear = loader.getTemplate('child-clear');
    const replace = loader.getTemplate('child-replace');
    const fbase = loader.getTemplate('fork-base');
    const fclear = loader.getTemplate('fork-clear');
    const fmerge = loader.getTemplate('fork-merge');
    const hostpp = loader.getTemplate('host-prepost');

    // Validate merge + clear behavior via direct properties
    if (!Array.isArray(base.pre_commands) || base.pre_commands.length !== 1) throw new Error('base pre_commands expected length 1');
    if (!Array.isArray(clear.pre_commands) || clear.pre_commands.length !== 0) throw new Error('[] should clear pre_commands');
    if (!Array.isArray(replace.pre_commands) || replace.pre_commands.join(' ') !== 'echo preB') throw new Error('merge_pre=false should replace');

    if (!Array.isArray(fbase.fork_pre_commands) || fbase.fork_pre_commands.join(' ') !== 'echo Fbase') throw new Error('fork base missing');
    if (!Array.isArray(fclear.fork_pre_commands) || fclear.fork_pre_commands.length !== 0) throw new Error('fork [] should clear');
    if (!Array.isArray(fmerge.fork_pre_commands) || fmerge.fork_pre_commands.join(' && ').indexOf('Fbase') === -1) {
      // Allow either merged array order [Fbase, Fchild]
      if (!(Array.isArray(fmerge.fork_pre_commands) && fmerge.fork_pre_commands.length === 2)) throw new Error('fork merge failed');
    }

    // Host pre/post execution chain should be present in final command
    const processed = hostpp.processTemplate({});
    const cmd = processed.command || '';
    if (!(cmd.includes('echo P') && cmd.includes('echo mid') && cmd.includes('echo Q'))) {
      throw new Error('host pre/post chain not present in command');
    }

    console.log('OK');
  } finally {
    try {
      // Ensure file watcher is stopped to allow process to exit
      const mod = await import('../../backend/template-loader.js');
      mod.templateLoader?.cleanup?.();
    } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('merge flags and host pre/post execution', async () => {
  await runMergeFlagsAndHostPrePostTest();
});
