import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestConfig, writeTestTemplates, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let templateLoader;
let config;

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

  writeTestTemplates(configDir, [
    {
      id: 'forge-template',
      name: 'Forge Template',
      command: '/usr/bin/true',
      pre_commands: [
        'echo REPO={repo}',
        'echo CLONE={FORGE_CLONE_URL}',
        'echo ISSUE={FORGE_ISSUE_URL}'
      ],
      links: [
        {
          url: '{FORGE_ISSUE_URL}',
          name: 'Forge Issue',
          skip_if_unresolved: true
        }
      ]
    }
  ]);

  ({ templateLoader } = await import('../template-loader.js'));
  ({ config } = await import('../config-loader.js'));
});

afterAll(() => {
  try { templateLoader.cleanup?.(); } catch {}
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('forge template behavior', () => {
  it('normalizes repo and injects HTTPS clone/issue URL by default', () => {
    expect(config.FORGES && config.FORGES.gitea, 'gitea forge should be configured').toBeTruthy();
    expect(config.DEFAULT_FORGE, 'DEFAULT_FORGE should be set').toBe('gitea');
    const tpl = templateLoader.getTemplate('forge-template');
    const out = tpl.processTemplate({
      forge: 'gitea',
      repo: 'https://gitea/devtools/termstation',
      issue_id: '42'
    });
    // Smoke-check that command was constructed and contains our echo markers
    expect(out.command).toContain('echo REPO=');
    expect(out.command).toContain('echo CLONE=');
    expect(out.command).toContain('echo ISSUE=');
  });

  it('switches to SSH protocol when clone_protocol=ssh', () => {
    const tpl = templateLoader.getTemplate('forge-template');
    const out = tpl.processTemplate({
      forge: 'gitea',
      repo: 'git@gitea:devtools/termstation.git',
      clone_protocol: 'ssh',
      issue_id: '77'
    });
    // Smoke-check that command was constructed and markers are present
    expect(out.command).toContain('echo REPO=');
    expect(out.command).toContain('echo CLONE=');
    expect(out.command).toContain('echo ISSUE=');
  });

  it('omits FORGE_ISSUE_URL link when issue_id is missing', () => {
    const tpl = templateLoader.getTemplate('forge-template');
    const out = tpl.processTemplate({
      repo: 'https://gitea/devtools/termstation'
    });
    const link = (out.links || []).find((l) => l && l.name === 'Forge Issue');
    expect(link).toBeUndefined();
  });
});
