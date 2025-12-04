// Tests for merge_write_files semantics and multi-inheritance behavior

import { test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ts-wf-'));
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

async function runWriteFilesMergeTest() {
  const dir = makeTempConfigDir();
  try {
    const tpl = {
      templates: [
        { id: 'base', name: 'Base', write_files: [ { source: 'files/AGENTS.md', target: '/tmp/A' } ] },
        // Replace (default merge_write_files=false)
        { id: 'child-replace', extends: 'base', name: 'ChildReplace', write_files: [ { source: 'files/AGENTS.md', target: '/tmp/B' } ] },
        // Merge
        { id: 'child-merge', extends: 'base', name: 'ChildMerge', merge_write_files: true, write_files: [ { source: 'files/AGENTS.md', target: '/tmp/C' } ] },
        // Clear via []
        { id: 'child-clear', extends: 'base', name: 'ChildClear', write_files: [] },
        // Multiple inheritance
        { id: 'baseA', name: 'BaseA', write_files: [ { source: 'files/AGENTS.md', target: '/tmp/A1' } ] },
        { id: 'baseB', name: 'BaseB', merge_write_files: true, write_files: [ { source: 'files/AGENTS.md', target: '/tmp/B1' } ] },
        { id: 'child-mi-merge', name: 'ChildMiMerge', extends: ['baseA','baseB'], merge_write_files: true, write_files: [ { source: 'files/AGENTS.md', target: '/tmp/C1' } ] },
        { id: 'child-mi-replace', name: 'ChildMiReplace', extends: ['baseA','baseB'], merge_write_files: false, write_files: [ { source: 'files/AGENTS.md', target: '/tmp/C1' } ] }
      ]
    };
    writeFileSync(join(dir, 'templates.json'), JSON.stringify(tpl, null, 2));

    process.env.TERMSTATION_CONFIG_DIR = dir;
    const mod = await import('../../backend/template-loader.js');
    const loader = mod.templateLoader;

    const repl = loader.getTemplate('child-replace');
    if (!Array.isArray(repl.write_files) || repl.write_files.length !== 1 || repl.write_files[0].target !== '/tmp/B') {
      throw new Error('replace should use only child write_files');
    }

    const merg = loader.getTemplate('child-merge');
    if (!Array.isArray(merg.write_files) || merg.write_files.length !== 2) {
      throw new Error('merge should concatenate base + child write_files');
    }
    if (merg.write_files[0].target !== '/tmp/A' || merg.write_files[1].target !== '/tmp/C') {
      throw new Error('merge order should be base then child');
    }

    const clr = loader.getTemplate('child-clear');
    if (!Array.isArray(clr.write_files) || clr.write_files.length !== 0) {
      throw new Error('[] should clear write_files');
    }

    const mix = loader.getTemplate('child-mi-merge');
    const targetsMix = (mix.write_files || []).map(x => x.target);
    if (targetsMix.join(',') !== '/tmp/A1,/tmp/B1,/tmp/C1') {
      throw new Error('multi-inheritance merge order should be A1,B1,C1');
    }

    const mixr = loader.getTemplate('child-mi-replace');
    const targetsMixR = (mixr.write_files || []).map(x => x.target);
    if (targetsMixR.join(',') !== '/tmp/C1') {
      throw new Error('multi-inheritance replace should use only child list');
    }

    console.log('OK');
  } finally {
    try { const mod = await import('../../backend/template-loader.js'); mod.templateLoader?.cleanup?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('merge_write_files semantics and multi-inheritance', async () => {
  await runWriteFilesMergeTest();
});
