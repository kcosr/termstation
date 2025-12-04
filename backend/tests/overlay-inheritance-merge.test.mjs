// Validate multi-extends inheritance and overlay order

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

async function runOverlayInheritanceMergeTest() {
  const dir = makeTempConfigDir();
  try {
    const tpl = {
      templates: [
        {
          id: 'p1',
          name: 'P1',
          sandbox_overrides: { pre_commands: ['echo A'] }
        },
        {
          id: 'p2',
          name: 'P2',
          sandbox_overrides: { pre_commands: ['echo B'] }
        },
        {
          id: 'child',
          name: 'Child',
          extends: ['p1', 'p2'],
          sandbox: true,
          command: 'echo base',
          pre_commands: ['echo BASE'],
          sandbox_overrides: { pre_commands: ['echo C'] }
        }
      ]
    };
    writeFileSync(join(dir, 'templates.json'), JSON.stringify(tpl, null, 2));

    process.env.TERMSTATION_CONFIG_DIR = dir;
    const mod = await import('../../backend/template-loader.js');
    const loader = mod.templateLoader;

    const child = loader.getTemplate('child');
    if (!child) throw new Error('child not found');
    const pre = Array.isArray(child.pre_commands) ? child.pre_commands.map(String) : [];
    // Expected order: base pre_commands + overlay from p1, then p2, then child overlay
    const expected = ['echo BASE', 'echo A', 'echo B', 'echo C'];
    if (pre.join(' || ') !== expected.join(' || ')) {
      throw new Error(`overlay inheritance order incorrect; got: ${JSON.stringify(pre)}`);
    }
    console.log('OK');
  } finally {
    try { (await import('../../backend/template-loader.js')).templateLoader?.cleanup?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('multi-extends inheritance overlay order', async () => {
  await runOverlayInheritanceMergeTest();
});
