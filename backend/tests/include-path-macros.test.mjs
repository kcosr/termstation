// Verify that {file:...} include paths support macro and env expansion

import { test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ts-include-path-'));
  const config = {
    environment: 'test', host: '127.0.0.1', port: 6622, log_level: 'INFO',
    auth_enabled: false, default_username: 'tester', username_aliases: {},
    cors_origins: ['*'], cors_credentials: true,
    websocket: { ping_interval_ms: 30000, ping_timeout_ms: 10000 },
    terminal: { default_shell: '/bin/bash', default_working_dir: '~', default_cols: 80, default_rows: 24, max_sessions: 10, session_timeout_seconds: 60, cleanup_interval_seconds: 30, max_buffer_size: 10000, output_chunk_size: 4096 },
    logging: { level: 'INFO', format: '' },
    data_dir: join(dir, 'data'),
    sessions_base_url: 'http://example-base', sessions_api_base_url: 'http://example-base/api/',
    template_vars: {}, containers: {}, ntfy: { enabled: false }, stdin_injection: {}, scheduled_input: {}, session_activity: {}
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

async function runIncludePathMacrosTest() {
  const dir = makeTempConfigDir();
  try {
    process.env.TERMSTATION_CONFIG_DIR = dir;
    const { processText } = await import('../utils/template-text.js');

    const includesDir = join(dir, 'files');
    mkdirSync(includesDir, { recursive: true });
    const includePath = join(includesDir, 'inc.txt');
    writeFileSync(includePath, 'Included session {session_id}', 'utf8');

    const sessionId = 'INCLUDE-TEST-1';
    const text = 'Start {file:{CONFIG_DIR}/files/inc.txt} End';
    const rendered = processText(text, { CONFIG_DIR: dir, session_id: sessionId }, {});

    if (!rendered.includes('Start')) {
      throw new Error('Rendered text missing prefix');
    }
    if (!rendered.includes('End')) {
      throw new Error('Rendered text missing suffix');
    }
    if (!rendered.includes(`Included session ${sessionId}`)) {
      throw new Error('Include content did not have macros expanded');
    }
    if (rendered.includes('{CONFIG_DIR}')) {
      throw new Error('CONFIG_DIR macro was not expanded in include path');
    }

    // Test 2: Multiple levels of nesting {BASE}/{SUB}/file.txt
    const subDir = join(includesDir, 'subdir');
    mkdirSync(subDir, { recursive: true });
    const nestedPath = join(subDir, 'nested.txt');
    writeFileSync(nestedPath, 'Nested content: {session_id}', 'utf8');

    const text2 = 'Before {file:{BASE}/{SUB}/nested.txt} After';
    const rendered2 = processText(text2, { BASE: includesDir, SUB: 'subdir', session_id: sessionId }, {});

    if (!rendered2.includes('Before')) {
      throw new Error('Test 2: Missing prefix');
    }
    if (!rendered2.includes('After')) {
      throw new Error('Test 2: Missing suffix');
    }
    if (!rendered2.includes(`Nested content: ${sessionId}`)) {
      throw new Error('Test 2: Nested path content missing or macros not expanded');
    }
    if (rendered2.includes('{BASE}') || rendered2.includes('{SUB}')) {
      throw new Error('Test 2: Nested macros were not fully expanded');
    }

    // Test 3: Mixed macro and env vars {BASE}/$ENV_VAR/file.txt
    const envDir = join(includesDir, 'envtest');
    mkdirSync(envDir, { recursive: true });
    const envPath = join(envDir, 'env.txt');
    writeFileSync(envPath, 'Env content: {session_id}', 'utf8');

    process.env.TEST_INCLUDE_DIR = 'envtest';
    const text3 = 'Start {file:{BASE}/$TEST_INCLUDE_DIR/env.txt} End';
    const rendered3 = processText(text3, { BASE: includesDir, session_id: sessionId }, {});

    if (!rendered3.includes('Start')) {
      throw new Error('Test 3: Missing prefix');
    }
    if (!rendered3.includes('End')) {
      throw new Error('Test 3: Missing suffix');
    }
    if (!rendered3.includes(`Env content: ${sessionId}`)) {
      throw new Error('Test 3: Mixed macro/env path content missing or macros not expanded');
    }
    if (rendered3.includes('{BASE}') || rendered3.includes('$TEST_INCLUDE_DIR')) {
      throw new Error('Test 3: Mixed vars were not fully expanded');
    }

    console.log('OK');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('include paths support macro and env expansion', async () => {
  await runIncludePathMacrosTest();
});

