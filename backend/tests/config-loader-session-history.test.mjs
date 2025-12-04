import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let configDir;
let loadConfig;
let baseConfig;

beforeAll(async () => {
  configDir = createTestConfig();
  const configPath = join(configDir, 'config.json');
  baseConfig = JSON.parse(readFileSync(configPath, 'utf8'));

  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ loadConfig } = await import('../config-loader.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

function writeConfig(overrides) {
  const configPath = join(configDir, 'config.json');
  const next = { ...baseConfig, ...overrides };
  writeFileSync(configPath, JSON.stringify(next, null, 2));
}

describe('Config session_history block', () => {
  it('defaults to text mode when session_history is missing', () => {
    // Ensure session_history is absent
    const { session_history, ...without } = baseConfig;
    writeConfig(without);
    const cfg = loadConfig();

    expect(cfg.TERMINATED_HISTORY_VIEW_MODE).toBe('text');
    expect(cfg.HISTORY_HTML_KEEP_LOG).toBe(true);
    expect(cfg.PTY_TO_HTML_PATH).toBe('');
  });

  it('reads all fields from session_history when present', () => {
    writeConfig({
      session_history: {
        view_mode: 'html',
        keep_raw_log: false,
        pty_to_html_path: '/usr/local/bin/pty-to-html'
      }
    });

    const cfg = loadConfig();
    expect(cfg.TERMINATED_HISTORY_VIEW_MODE).toBe('html');
    expect(cfg.HISTORY_HTML_KEEP_LOG).toBe(false);
    expect(cfg.PTY_TO_HTML_PATH).toBe('/usr/local/bin/pty-to-html');
  });

  it('applies defaults for omitted session_history fields', () => {
    writeConfig({
      session_history: {
        view_mode: 'html'
      }
    });

    const cfg = loadConfig();
    expect(cfg.TERMINATED_HISTORY_VIEW_MODE).toBe('html');
    expect(cfg.HISTORY_HTML_KEEP_LOG).toBe(true);
    expect(cfg.PTY_TO_HTML_PATH).toBe('');
  });
});

