// Tests for multiple inheritance (extends as array)

import { test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ts-mi-'));
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

async function runMultipleInheritanceTest() {
  const dir = makeTempConfigDir();
  try {
    const tpl = {
      templates: [
        { id: 'common', name: 'Common', parameters: [{ name: 'alpha', default: 'A' }], links: [{ name: 'L', url: 'X' }], pre_commands: ['echo C'] },
        { id: 'baseA', name: 'BaseA', extends: 'common', parameters: [{ name: 'beta', default: 'B' }], pre_commands: ['echo A'] },
        { id: 'baseB', name: 'BaseB', extends: 'common', parameters: [{ name: 'beta', default: 'B2' }, { name: 'gamma', default: 'G' }], pre_commands: ['echo B'] },
        { id: 'child', name: 'Child', extends: ['baseA','baseB'], post_commands: ['echo child'] }
      ]
    };
    writeFileSync(join(dir, 'templates.json'), JSON.stringify(tpl, null, 2));

    process.env.TERMSTATION_CONFIG_DIR = dir;
    const mod = await import('../../backend/template-loader.js');
    const loader = mod.templateLoader;

    const child = loader.getTemplate('child');
    // Parameters: expect alpha (from common), beta from baseB (overrides A), gamma from baseB
    const names = (child.parameters || []).map(p => p && p.name).filter(Boolean);
    if (!names.includes('alpha') || !names.includes('beta') || !names.includes('gamma')) throw new Error('parameter merge failed');
    const beta = (child.parameters || []).find(p => p.name === 'beta');
    if (!beta || beta.default !== 'B2') throw new Error('later parent should override earlier for parameters');

    // pre_commands merged baseA + baseB (order preserved), plus child's post_commands separate
    if (!Array.isArray(child.pre_commands)) throw new Error('pre_commands missing');
    const pre = child.pre_commands.join(' ');
    if (!(pre.includes('echo C') && pre.includes('echo A') && pre.includes('echo B'))) throw new Error('pre_commands merge across parents failed');

    // Links merged keyed by name; common appears once
    if (!Array.isArray(child.links) || child.links.length !== 1) throw new Error('links merge by key failed');

    console.log('OK');
  } finally {
    try { const mod = await import('../../backend/template-loader.js'); mod.templateLoader?.cleanup?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('multiple inheritance merges parameters, pre_commands, and links', async () => {
  await runMultipleInheritanceTest();
});
