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

describe('Config workspace service feature flag', () => {
  it('defaults to false when features block is missing', () => {
    const { features, ...without } = baseConfig;
    writeConfig(without);
    const cfg = loadConfig();

    expect(cfg.WORKSPACE_SERVICE_ENABLED).toBe(false);
  });

  it('defaults to false when workspace_service_enabled is omitted', () => {
    writeConfig({
      features: {
        proxy_container_services: false
      }
    });
    const cfg = loadConfig();

    expect(cfg.WORKSPACE_SERVICE_ENABLED).toBe(false);
  });

  it('reads workspace_service_enabled when present', () => {
    writeConfig({
      features: {
        workspace_service_enabled: true
      }
    });

    const cfg = loadConfig();
    expect(cfg.WORKSPACE_SERVICE_ENABLED).toBe(true);
  });
});

