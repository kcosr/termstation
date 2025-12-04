import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createTestConfig, writeTestTemplates, cleanupTestConfig } from './helpers/test-utils.mjs';

// Tests for user-sourced, forge-based, and static template parameter options.
// Uses a dedicated data_dir so identity state is isolated from other tests.

let configDir;
let templateLoader;
const dataDir = '/tmp/ts-template-parameter-options';

beforeAll(async () => {
  configDir = createTestConfig({ data_dir: dataDir });
  process.env.TERMSTATION_CONFIG_DIR = configDir;

  // Seed users/groups config for user-sourced parameter values
  const users = [
    {
      username: 'developer',
      groups: ['testers'],
      parameter_values: {
        repo: ['devtools/terminals-extra']
      }
    }
  ];
  const groups = [
    {
      name: 'testers',
      parameter_values: {
        repo: ['devtools/terminals']
      }
    }
  ];
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'users.json'), JSON.stringify(users, null, 2), 'utf8');
  writeFileSync(join(dataDir, 'groups.json'), JSON.stringify(groups, null, 2), 'utf8');

  // Seed minimal templates for tests
  const templates = [
    {
      id: 'ai-assistant-base',
      name: 'AI Assistant Base',
      command: 'echo base',
      parameters: [
        { name: 'repo', type: 'string', options_source: 'user' }
      ]
    },
    {
      id: 'codex',
      name: 'Codex',
      command: 'echo codex',
      parameters: [
        {
          name: 'model',
          type: 'string',
          options: [
            { value: 'gpt-5', label: 'gpt-5' },
            { value: 'gpt-5-codex', label: 'gpt-5-codex' }
          ]
        }
      ]
    },
    {
      id: 'forge-opts',
      name: 'Forge Options',
      command: 'echo forge',
      parameters: [
        { name: 'forge', type: 'string', options_source: 'forges' },
        { name: 'repo', type: 'string', options_source: 'forge', options_forge_key: 'list_repos' },
        { name: 'ssh_env', type: 'string', options_source: 'forge', options_forge_key: 'ssh_env_echo' }
      ]
    }
  ];
  writeTestTemplates(configDir, templates);

  // Inject simple forge configuration into test config
  const { config } = await import('../config-loader.js');
  config.FORGES = {
    gitea: {
      type: 'gitea',
      host: 'gitea',
      ssh_url: 'git@gitea:{repo}',
      https_url: 'https://gitea/{repo}',
      default_protocol: 'https',
      ssh_identity_file: '/tmp/test-ssh-key',
      list_repos: 'printf \"devtools/alpha\\nacme/beta\\n\"',
      // Echo out the SSH-related environment that should be populated
      // for daemon-run forge commands.
      ssh_env_echo: 'printf \"%s:%s\\n\" \"${SSH_IDENTITY_FILE:-}\" \"${GIT_SSH_COMMAND:-}\"'
    }
  };
  config.DEFAULT_FORGE = 'gitea';

  ({ templateLoader } = await import('../template-loader.js'));
});

afterAll(() => {
  try { templateLoader.cleanup?.(); } catch {}
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('template parameter options', () => {
  it('user-sourced repo options union group and user values', () => {
    const result = templateLoader.getParameterOptions('ai-assistant-base', 'repo', {}, { username: 'developer' });
    expect(result && Array.isArray(result.options), 'options array should be present').toBe(true);
    const values = result.options.map((o) => o.value);
    expect(values).toEqual(['devtools/terminals', 'devtools/terminals-extra']);
  });

  it('user-sourced repo options empty for unknown user', () => {
    const result = templateLoader.getParameterOptions('ai-assistant-base', 'repo', {}, { username: 'no-such-user' });
    expect(result && Array.isArray(result.options), 'options array should be present').toBe(true);
    expect(result.options.length).toBe(0);
  });

  it('static select options remain unchanged for model parameter', () => {
    const result = templateLoader.getParameterOptions('codex', 'model', {});
    expect(result && Array.isArray(result.options), 'options array should be present').toBe(true);
    const values = result.options.map((o) => o.value);
    expect(values).toEqual(['gpt-5', 'gpt-5-codex']);
  });

  it('forge options_source "forges" returns configured forge names', () => {
    const result = templateLoader.getParameterOptions('forge-opts', 'forge', {});
    expect(result && Array.isArray(result.options), 'options array should be present').toBe(true);
    const values = result.options.map((o) => o.value);
    expect(values).toEqual(['gitea']);
  });

  it('forge options_source "forge" executes forge list_repos command', () => {
    const result = templateLoader.getParameterOptions('forge-opts', 'repo', {});
    expect(result && Array.isArray(result.options), 'options array should be present').toBe(true);
    const values = result.options.map((o) => o.value);
    expect(values).toEqual(['devtools/alpha', 'acme/beta']);
  });

  it('forge ssh_identity_file is passed to forge commands via SSH env', () => {
    const result = templateLoader.getParameterOptions('forge-opts', 'ssh_env', {});
    expect(result && Array.isArray(result.options), 'options array should be present').toBe(true);
    expect(result.options.length).toBe(1);

    const value = result.options[0].value;
    const [identity, gitCmd] = String(value).split(':');

    expect(identity).toBe('/tmp/test-ssh-key');
    expect(gitCmd).toContain('ssh -o StrictHostKeyChecking=accept-new -i /tmp/test-ssh-key');
  });
});
