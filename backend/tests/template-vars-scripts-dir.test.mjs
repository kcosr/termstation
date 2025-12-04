import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let configDir;
let loadConfig;
let ConfigClass;

beforeAll(async () => {
  configDir = createTestConfig({
    template_vars: {
      // Verify that a custom scripts_dir override is respected and mapped to SCRIPTS_DIR.
      scripts_dir: 'custom-scripts'
    }
  });
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  const mod = await import('../config-loader.js');
  loadConfig = mod.loadConfig;
  ConfigClass = mod.config.constructor;
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('template vars SCRIPTS_DIR', () => {
  it('exposes SCRIPTS_DIR pointing at backend scripts directory by default', async () => {
    // Construct a config instance directly from the base test config
    const baseConfigPath = join(__dirname, 'config/base-config.json');
    const baseConfig = JSON.parse(readFileSync(baseConfigPath, 'utf8'));
    const cfg = new ConfigClass(baseConfig);
    const scriptsDir = cfg.TEMPLATE_VARS.SCRIPTS_DIR;
    expect(typeof scriptsDir).toBe('string');
    expect(scriptsDir.endsWith('/scripts') || scriptsDir.endsWith('\\scripts')).toBe(true);
    // Best-effort: verify the directory exists
    const st = statSync(scriptsDir);
    expect(st.isDirectory()).toBe(true);
  });

  it('maps scripts_dir override into SCRIPTS_DIR and scripts_dir', () => {
    const cfg = loadConfig();
    const scriptsDir = cfg.TEMPLATE_VARS.SCRIPTS_DIR;
    const scriptsDirLower = cfg.TEMPLATE_VARS.scripts_dir;
    expect(typeof scriptsDir).toBe('string');
    // scripts_dir retains the raw override, while SCRIPTS_DIR is resolved to an absolute path.
    expect(scriptsDirLower).toBe('custom-scripts');
    expect(scriptsDir.endsWith('/custom-scripts') || scriptsDir.endsWith('\\custom-scripts')).toBe(true);
  });
});
