// Ensure sandbox_overrides are ignored when sandbox === false

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

async function runOverlayIgnoredWhenSandboxFalseTest() {
  const dir = makeTempConfigDir();
  try {
    const tpl = {
      templates: [
        {
          id: 'base',
          name: 'Base',
          command: 'echo host',
          sandbox_overrides: { command: 'echo sandbox' }
        },
        {
          id: 'child-host',
          extends: 'base',
          sandbox: false
        }
      ]
    };
    writeFileSync(join(dir, 'templates.json'), JSON.stringify(tpl, null, 2));

    process.env.TERMSTATION_CONFIG_DIR = dir;
    const mod = await import('../../backend/template-loader.js');
    const loader = mod.templateLoader;

    const child = loader.getTemplate('child-host');
    if (!child) throw new Error('child-host not found');
    if (child.sandbox) throw new Error('child-host expected sandbox=false');
    if (child.command !== 'echo host') throw new Error(`overlay should be ignored; got: ${child.command}`);
    console.log('OK');
  } finally {
    try { (await import('../../backend/template-loader.js')).templateLoader?.cleanup?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('sandbox_overrides ignored when sandbox === false', async () => {
  await runOverlayIgnoredWhenSandboxFalseTest();
});
