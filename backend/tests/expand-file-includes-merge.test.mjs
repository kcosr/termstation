// Tests for merge_expand_file_includes semantics and multi-inheritance behavior

import { test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ts-efi-'));
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

async function runExpandFileIncludesMergeTest() {
  const dir = makeTempConfigDir();
  try {
    const tpl = {
      templates: [
        { id: 'base', name: 'Base', expand_file_includes: [ 'A.txt' ] },
        // Replace (default merge_expand_file_includes=false)
        { id: 'child-replace', extends: 'base', name: 'ChildReplace', expand_file_includes: [ 'B.txt' ] },
        // Merge via canonical flag
        { id: 'child-merge', extends: 'base', name: 'ChildMerge', merge_expand_file_includes: true, expand_file_includes: [ 'C.txt' ] },
        // Clear via []
        { id: 'child-clear', extends: 'base', name: 'ChildClear', expand_file_includes: [] },
        // Multiple inheritance
        { id: 'baseA', name: 'BaseA', expand_file_includes: [ 'A1.txt' ] },
        { id: 'baseB', name: 'BaseB', merge_expand_file_includes: true, expand_file_includes: [ 'B1.txt' ] },
        { id: 'child-mi-merge', name: 'ChildMiMerge', extends: ['baseA','baseB'], merge_expand_file_includes: true, expand_file_includes: [ 'C1.txt' ] },
        { id: 'child-mi-replace', name: 'ChildMiReplace', extends: ['baseA','baseB'], merge_expand_file_includes: false, expand_file_includes: [ 'C1.txt' ] }
      ]
    };
    writeFileSync(join(dir, 'templates.json'), JSON.stringify(tpl, null, 2));

    process.env.TERMSTATION_CONFIG_DIR = dir;
    const mod = await import('../../backend/template-loader.js');
    const loader = mod.templateLoader;

    const repl = loader.getTemplate('child-replace');
    if (!Array.isArray(repl.expand_file_includes) || repl.expand_file_includes.length !== 1 || repl.expand_file_includes[0] !== 'B.txt') {
      throw new Error('replace should use only child expand_file_includes');
    }

    const merg = loader.getTemplate('child-merge');
    if (!Array.isArray(merg.expand_file_includes) || merg.expand_file_includes.length !== 2) {
      throw new Error('merge should concatenate base + child expand_file_includes');
    }
    if (merg.expand_file_includes[0] !== 'A.txt' || merg.expand_file_includes[1] !== 'C.txt') {
      throw new Error('merge order should be base then child for expand_file_includes');
    }

    const clr = loader.getTemplate('child-clear');
    if (!Array.isArray(clr.expand_file_includes) || clr.expand_file_includes.length !== 0) {
      throw new Error('[] should clear expand_file_includes');
    }

    const mix = loader.getTemplate('child-mi-merge');
    const pathsMix = (mix.expand_file_includes || []).slice();
    if (pathsMix.join(',') !== 'A1.txt,B1.txt,C1.txt') {
      throw new Error('multi-inheritance merge order should be A1.txt,B1.txt,C1.txt for expand_file_includes');
    }

    const mixr = loader.getTemplate('child-mi-replace');
    const pathsMixR = (mixr.expand_file_includes || []).slice();
    if (pathsMixR.join(',') !== 'C1.txt') {
      throw new Error('multi-inheritance replace should use only child expand_file_includes list');
    }

    console.log('OK');
  } finally {
    try { const mod = await import('../../backend/template-loader.js'); mod.templateLoader?.cleanup?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('merge_expand_file_includes semantics and multi-inheritance', async () => {
  await runExpandFileIncludesMergeTest();
});

