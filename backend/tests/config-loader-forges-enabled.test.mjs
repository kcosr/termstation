import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let configDir;
let loadConfig;

beforeAll(async () => {
  configDir = createTestConfig({
    forges: {
      gitea: {
        type: 'gitea',
        host: 'gitea',
        ssh_url: 'git@gitea:{repo}',
        https_url: 'https://gitea/{repo}',
        default_protocol: 'https'
      },
      github_disabled: {
        type: 'github',
        host: 'github.com',
        ssh_url: 'git@github.com:{repo}',
        https_url: 'https://github.com/{repo}',
        default_protocol: 'ssh',
        enabled: false
      },
      gitlab_explicit_true: {
        type: 'gitlab',
        host: 'gitlab',
        ssh_url: 'git@gitlab:{repo}',
        https_url: 'https://gitlab/{repo}',
        default_protocol: 'ssh',
        enabled: true
      }
    },
    default_forge: 'gitea'
  });

  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ loadConfig } = await import('../config-loader.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('Config forge enabled flag', () => {
  it('loads only forges with enabled !== false', () => {
    const cfg = loadConfig();

    expect(cfg.FORGES.gitea).toBeTruthy();
    expect(cfg.FORGES.gitlab_explicit_true).toBeTruthy();
    expect(cfg.FORGES.github_disabled).toBeUndefined();
  });
});

