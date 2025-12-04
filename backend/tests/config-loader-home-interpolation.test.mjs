import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let configDir;
let loadConfig;
let originalHome;

beforeAll(async () => {
  originalHome = process.env.HOME;
  process.env.HOME = '/tmp/ts-home-interp';

  configDir = createTestConfig({
    data_dir: '$HOME/termstation-data',
    template_vars: {
      PATH_FROM_HOME: '$HOME/.local/bin'
    },
    session_history: {
      view_mode: 'html',
      keep_raw_log: true,
      pty_to_html_path: '$HOME/bin/pty-to-html'
    }
  });

  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ loadConfig } = await import('../config-loader.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe('Config $HOME interpolation', () => {
  it('expands $HOME in data_dir and template_vars', () => {
    const cfg = loadConfig();
    const expectedHome = '/tmp/ts-home-interp';

    expect(cfg.DATA_DIR).toBe(`${expectedHome}/termstation-data`);
    expect(cfg.TEMPLATE_VARS.PATH_FROM_HOME).toBe(`${expectedHome}/.local/bin`);
  });

  it('expands $HOME in nested config blocks', () => {
    const cfg = loadConfig();
    const expectedHome = '/tmp/ts-home-interp';

    expect(cfg.PTY_TO_HTML_PATH).toBe(`${expectedHome}/bin/pty-to-html`);
  });
}
);

