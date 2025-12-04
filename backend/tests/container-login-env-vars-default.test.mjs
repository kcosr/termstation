import { test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createTestConfig,
  cleanupTestConfig
} from './helpers/test-utils.mjs';

test('container login does not persist custom env vars by default', async () => {
  const configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;

  try {
    const { buildSessionWorkspace } = await import('../services/session-workspace-builder.js');

    const sessionId = 'env-default-123';
    const template = {
      id: 'env-default',
      name: 'Env Default',
      command: 'echo main',
      pre_commands: [],
      post_commands: [],
      env_vars: {
        CUSTOM_VAR: 'custom-value',
        ANOTHER_VAR: 'another'
      }
    };
    const variables = {
      session_id: sessionId,
      _is_container_session: true,
      session_workspace_dir: '/workspace',
      _login_user: 'tester'
    };

    const { scriptsDir } = await buildSessionWorkspace({ sessionId, template, variables });
    const envPath = join(scriptsDir, '.env');
    const customPath = join(scriptsDir, '.env.custom');

    const envContent = readFileSync(envPath, 'utf8');
    const customContent = readFileSync(customPath, 'utf8');

    expect(envContent).toContain('SESSION_ID="env-default-123"');
    expect(envContent).toContain('TERMSTATION_USER="tester"');
    expect(envContent).not.toContain('CUSTOM_VAR=');
    expect(envContent).not.toContain('ANOTHER_VAR=');

    expect(customContent).toContain('CUSTOM_VAR="custom-value"');
    expect(customContent).toContain('ANOTHER_VAR="another"');
  } finally {
    cleanupTestConfig(configDir);
    delete process.env.TERMSTATION_CONFIG_DIR;
  }
});

