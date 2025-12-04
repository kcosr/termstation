// Test that env_vars on non-sandbox templates wrap the pre/main/post composite
// and that bootstrap environment exports are prefixed correctly.

import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ts-hostenv-'));
  const config = {
    environment: 'test', host: '127.0.0.1', port: 6622, log_level: 'INFO',
    auth_enabled: false, default_username: 'tester', username_aliases: {},
    cors_origins: ['*'], cors_credentials: true,
    websocket: { ping_interval_ms: 30000, ping_timeout_ms: 10000 },
    terminal: { default_shell: '/bin/bash', default_working_dir: '~', default_cols: 80, default_rows: 24, max_sessions: 10, session_timeout_seconds: 60, cleanup_interval_seconds: 30, max_buffer_size: 10000, output_chunk_size: 4096 },
    logging: { level: 'INFO', format: '' },
    data_dir: join(dir, 'data'),
    sessions_base_url: 'http://localhost', sessions_api_base_url: 'http://localhost/api/',
    template_vars: {}, containers: {}, ntfy: { enabled: false }, stdin_injection: {}, scheduled_input: {}, session_activity: {}
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

async function runHostEnvWrappingTest() {
  const dir = makeTempConfigDir();
  try {
    const tpl = {
      templates: [
        {
          id: 'host-env', name: 'HostEnv', sandbox: false,
          env_vars: { TESTVAR: 'value' },
          pre_commands: ['echo PRE'],
          command: 'echo MID',
          post_commands: ['echo POST']
        }
      ]
    };
    writeFileSync(join(dir, 'templates.json'), JSON.stringify(tpl, null, 2));

    process.env.TERMSTATION_CONFIG_DIR = dir;
    const mod = await import('../../backend/template-loader.js');
    const loader = mod.templateLoader;
    const t = loader.getTemplate('host-env');
    const processed = t.processTemplate({});
    const cmd = processed.command || '';
    // After #1011 and subsequent changes: env exports include BOOTSTRAP_DIR/PATH
    // followed by inline export for TESTVAR and the pre/main/post chain.
    expect(cmd).toContain('export BOOTSTRAP_DIR="');
    expect(cmd).toContain('export PATH="$PATH:');
    expect(cmd).toContain('export TESTVAR="value"');
    expect(cmd).toContain('echo PRE && echo MID && echo POST');
    console.log('OK');
  } finally {
    try { const mod = await import('../../backend/template-loader.js'); mod.templateLoader?.cleanup?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('env_vars wrap pre/main/post composite for host templates', async () => {
  await runHostEnvWrappingTest();
});
