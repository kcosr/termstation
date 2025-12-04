/**
 * Test that forge-injected variables (FORGE_CLONE_URL, etc.) are properly
 * available to buildSessionWorkspace when creating container sessions.
 *
 * This test verifies the fix for the bug where FORGE_CLONE_URL was empty
 * in container pre_commands because:
 * 1. processTemplate was called with a copy of variables (spread operator)
 * 2. Forge injection added FORGE_CLONE_URL to that copy
 * 3. buildSessionWorkspace was called with the original variables (without forge vars)
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestConfig, writeTestTemplates, cleanupTestConfig } from './helpers/test-utils.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';

let configDir;
let templateLoader;
let config;
let buildSessionWorkspace;

beforeAll(async () => {
  configDir = createTestConfig({
    forges: {
      gitea: {
        type: 'gitea',
        host: 'gitea',
        ssh_url: 'git@gitea:{repo}',
        https_url: 'https://gitea/{repo}',
        default_protocol: 'https',
        repo_pattern: '^(?:https?://gitea/|git@gitea:|)([^/]+/[^/\\.]+?)(?:\\.git)?$',
        issue_url: 'https://gitea/{repo}/issues/{issue_id}',
        repo_url: 'https://gitea/{repo}'
      }
    },
    default_forge: 'gitea'
  });
  process.env.TERMSTATION_CONFIG_DIR = configDir;

  // Mimic the ai-assistant-base + claude inheritance structure
  writeTestTemplates(configDir, [
    {
      id: 'ai-assistant-base',
      name: 'AI Assistant Base',
      display: false,
      isolation: 'container',
      container_image: 'localhost/test-image',
      env_vars: {
        FORGE: '{FORGE}',
        FORGE_TYPE: '{FORGE_TYPE}'
      },
      pre_commands: [
        'if [ -n "{repo}" ]; then echo Cloning {repo}; git clone {FORGE_CLONE_URL} "{repo}"; fi',
        'if [ -n "{branch}" ] && [ -n "{repo}" ]; then git -C "{repo}" checkout {branch}; fi'
      ],
      parameters: [
        { name: 'forge', label: 'Forge', type: 'select', options_source: 'forges', required: false },
        { name: 'repo', label: 'Repository', type: 'string', required: false },
        { name: 'branch', label: 'Branch', type: 'string', required: false },
        { name: 'issue_id', label: 'Issue ID', type: 'string', required: false }
      ]
    },
    {
      id: 'claude',
      extends: 'ai-assistant-base',
      name: 'Claude',
      isolation: 'container',
      command: 'claude --dangerously-skip-permissions'
    }
  ]);

  // Force reimport to pick up new config
  const { templateLoader: tl } = await import('../template-loader.js');
  const { config: cfg } = await import('../config-loader.js');
  const { buildSessionWorkspace: bsw } = await import('../services/session-workspace-builder.js');
  templateLoader = tl;
  config = cfg;
  buildSessionWorkspace = bsw;
});

afterAll(() => {
  try { templateLoader.cleanup?.(); } catch {}
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('forge clone URL in container templates', () => {
  it('injects FORGE_CLONE_URL into workspace pre.sh when forge and repo are set', async () => {
    expect(config.FORGES?.gitea).toBeTruthy();
    expect(config.DEFAULT_FORGE).toBe('gitea');

    const tpl = templateLoader.getTemplate('claude');
    expect(tpl).toBeTruthy();
    expect(tpl.isolation).toBe('container');

    // Create variables object that will be mutated by processTemplate
    const variables = {
      forge: 'gitea',
      repo: 'kcosr/acl-proxy-legacy',
      branch: 'main',
      issue_id: '',
      session_id: 'test-forge-clone-123'
    };

    // Process template - this should inject FORGE_CLONE_URL into variables
    const processedTemplate = tpl.processTemplate(variables);

    // Verify forge injection happened in variables
    expect(variables.FORGE_CLONE_URL).toBe('https://gitea/kcosr/acl-proxy-legacy');
    expect(variables.FORGE).toBe('gitea');

    // Now build workspace using the same variables object (as sessions.js does)
    const { workspaceDir, scriptsDir } = await buildSessionWorkspace({
      sessionId: 'test-forge-clone-123',
      template: tpl,
      variables
    });

    // Read pre.sh and verify it contains the resolved clone URL
    const preSh = readFileSync(join(scriptsDir, 'pre.sh'), 'utf8');
    console.log('=== PRE.SH CONTENT ===');
    console.log(preSh);
    console.log('=== END PRE.SH ===');

    // The pre.sh should contain the actual clone URL, not an empty placeholder
    expect(preSh).toContain('https://gitea/kcosr/acl-proxy-legacy');
    expect(preSh).toContain('git clone https://gitea/kcosr/acl-proxy-legacy');

    // Custom env should include both FORGE and FORGE_TYPE for container sessions
    const customEnv = readFileSync(join(scriptsDir, '.env.custom'), 'utf8');
    expect(customEnv).toContain('FORGE="gitea"');
    expect(customEnv).toContain('FORGE_TYPE="gitea"');
  });

  it('uses SSH URL when clone_protocol=ssh', async () => {
    const tpl = templateLoader.getTemplate('claude');

    const variables = {
      forge: 'gitea',
      repo: 'devtools/termstation',
      clone_protocol: 'ssh',
      branch: 'main',
      session_id: 'test-forge-ssh-456'
    };

    tpl.processTemplate(variables);

    expect(variables.FORGE_CLONE_URL).toBe('git@gitea:devtools/termstation');

    const { scriptsDir } = await buildSessionWorkspace({
      sessionId: 'test-forge-ssh-456',
      template: tpl,
      variables
    });

    const preSh = readFileSync(join(scriptsDir, 'pre.sh'), 'utf8');
    console.log('=== SSH PRE.SH ===');
    console.log(preSh);
    console.log('=== END ===');

    expect(preSh).toContain('git@gitea:devtools/termstation');
  });

  it('defaults to gitea forge when forge param is empty', async () => {
    const tpl = templateLoader.getTemplate('claude');

    const variables = {
      forge: '',  // empty - should use default_forge
      repo: 'myorg/myrepo',
      branch: '',
      session_id: 'test-forge-default-789'
    };

    tpl.processTemplate(variables);

    // Should use default forge (gitea)
    expect(variables.FORGE_CLONE_URL).toBe('https://gitea/myorg/myrepo');
    expect(variables.FORGE).toBe('gitea');

    const { scriptsDir } = await buildSessionWorkspace({
      sessionId: 'test-forge-default-789',
      template: tpl,
      variables
    });

    const preSh = readFileSync(join(scriptsDir, 'pre.sh'), 'utf8');
    console.log('=== DEFAULT FORGE PRE.SH ===');
    console.log(preSh);
    console.log('=== END ===');

    expect(preSh).toContain('https://gitea/myorg/myrepo');
  });
});
