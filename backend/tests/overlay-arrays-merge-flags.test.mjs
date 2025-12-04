// Validate array merge flags and clear semantics inside sandbox_overrides

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

async function runOverlayArraysMergeFlagsTest() {
  const dir = makeTempConfigDir();
  try {
    const tpl = {
      templates: [
        {
          id: 'base',
          name: 'Base',
          sandbox: true,
          command: 'echo base',
          pre_commands: ['echo Pbase'],
          write_files: [ { source: 'files/X', target: '/tmp/X' } ]
        },
        {
          id: 'child-replace-pre',
          extends: 'base',
          sandbox: true,
          sandbox_overrides: {
            merge_pre_commands: false,
            pre_commands: ['echo Pchild']
          }
        },
        {
          id: 'child-merge-wf',
          extends: 'base',
          sandbox: true,
          sandbox_overrides: {
            merge_write_files: true,
            write_files: [ { source: 'files/Y', target: '/tmp/Y' } ]
          }
        },
        {
          id: 'child-clear-pre',
          extends: 'base',
          sandbox: true,
          sandbox_overrides: {
            pre_commands: []
          }
        }
      ]
    };
    writeFileSync(join(dir, 'templates.json'), JSON.stringify(tpl, null, 2));

    process.env.TERMSTATION_CONFIG_DIR = dir;
    const mod = await import('../../backend/template-loader.js');
    const loader = mod.templateLoader;

    const replacePre = loader.getTemplate('child-replace-pre');
    if (!replacePre) throw new Error('child-replace-pre not found');
    if (replacePre.pre_commands.join(' ') !== 'echo Pchild') {
      throw new Error(`merge_pre_commands=false should replace base; got ${JSON.stringify(replacePre.pre_commands)}`);
    }

    const mergeWf = loader.getTemplate('child-merge-wf');
    if (!mergeWf || !Array.isArray(mergeWf.write_files) || mergeWf.write_files.length !== 2) {
      throw new Error('merge_write_files=true should concatenate write_files');
    }

    const clearPre = loader.getTemplate('child-clear-pre');
    if (!clearPre || !Array.isArray(clearPre.pre_commands) || clearPre.pre_commands.length !== 0) {
      throw new Error('[] in overlay should clear pre_commands');
    }

    console.log('OK');
  } finally {
    try { (await import('../../backend/template-loader.js')).templateLoader?.cleanup?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('array merge flags and clear semantics inside sandbox_overrides', async () => {
  await runOverlayArraysMergeFlagsTest();
});
