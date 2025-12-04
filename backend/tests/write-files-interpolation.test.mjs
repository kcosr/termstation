// Verify that write_files with { source, target, interpolate: true } applies interpolation
// in the host workspace builder.

import { test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ts-wf-intp-'));
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

async function runWriteFilesInterpolationTest() {
  const dir = makeTempConfigDir();
  try {
    process.env.TERMSTATION_CONFIG_DIR = dir;
    // Import after setting TERMSTATION_CONFIG_DIR so the loader binds to our temp config
    const { buildSessionWorkspace } = await import('../services/session-workspace-builder.js');

    const sessionId = 'TEST-INTERP-1';
    const variables = { session_id: sessionId, repo: 'devtools/terminals', issue_id: '123', branch: 'feature/x' };
    const template = {
      id: 'test-template',
      name: 'Test',
      // Interpolated copy of backend/files/AGENTS.md
      write_files: [ { source: 'files/AGENTS.md', target: '.codex/AGENTS.md', interpolate: true } ],
      pre_commands: [],
      post_commands: [],
      env_vars: {}
    };

    const { workspaceDir } = await buildSessionWorkspace({ sessionId, template, variables });
    const outPath = join(workspaceDir, '.codex', 'AGENTS.md');
    const content = readFileSync(outPath, 'utf8');

    // Basic assertions: placeholders should be resolved
    if (content.includes('{session_id}')) {
      throw new Error('Interpolation failed: {session_id} was not replaced');
    }
    if (!content.includes(`Session ID: ${sessionId}`)) {
      throw new Error('Interpolated content missing expected Session ID line');
    }
    if (!content.includes('Session URL: http://example-base?session_id=' + sessionId)) {
      throw new Error('Interpolated content missing expected Session URL');
    }

    // Spacing assertions: conditional lines should not leave extra blank lines
    const lines = content.split('\n');
    const linkIdx = lines.findIndex(l => l.startsWith('- Session Link:'));
    if (linkIdx === -1) {
      throw new Error('AGENTS.md missing Session Link line in interpolated output');
    }
    const repoIdx = lines.findIndex(l => l.startsWith('- Repo: '));
    const issueIdx = lines.findIndex(l => l.startsWith('- Issue ID: '));

    if (repoIdx !== linkIdx + 1) {
      throw new Error('Expected Repo line to follow Session Link without a blank line');
    }
    if (issueIdx !== repoIdx + 1) {
      throw new Error('Expected Issue ID line to follow Repo without a blank line');
    }

    const sessionId2 = 'TEST-INTERP-CONTENT-1';
    const variables2 = { session_id: sessionId2, repo: 'devtools/terminals', issue_id: '456', branch: 'feature/y' };
    const template2 = {
      id: 'test-template-content',
      name: 'TestContent',
      write_files: [ { content: 'Session={session_id}\nRepo={repo}\nIssue={issue_id}', target: 'inline.txt', interpolate: true } ],
      pre_commands: [],
      post_commands: [],
      env_vars: {}
    };

    const { workspaceDir: ws2 } = await buildSessionWorkspace({ sessionId: sessionId2, template: template2, variables: variables2 });
    const inlinePath = join(ws2, 'inline.txt');
    const inlineContent = readFileSync(inlinePath, 'utf8');

    if (inlineContent.includes('{session_id}')) {
      throw new Error('Interpolation failed for inline content: {session_id} was not replaced');
    }
    if (!inlineContent.includes(`Session=${sessionId2}`)) {
      throw new Error('Inline content missing expected Session line');
    }
    if (!inlineContent.includes('Repo=devtools/terminals')) {
      throw new Error('Inline content missing expected Repo line');
    }
    if (!inlineContent.includes('Issue=456')) {
      throw new Error('Inline content missing expected Issue line');
    }

    console.log('OK');
  } finally {
    try { const mod = await import('../template-loader.js'); mod.templateLoader?.cleanup?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('write_files interpolation in host workspace builder', async () => {
  await runWriteFilesInterpolationTest();
});
