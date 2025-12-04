import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_CONFIG_PATH = join(__dirname, '../config/base-config.json');

export function createTestConfig(overrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ts-test-'));

  const baseConfig = JSON.parse(readFileSync(BASE_CONFIG_PATH, 'utf8'));
  const config = deepMerge(baseConfig, overrides);

  writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(config, null, 2));

  return tmpDir;
}

export function writeTestTemplates(configDir, templates) {
  const templatesFile = { templates };
  writeFileSync(
    join(configDir, 'templates.json'),
    JSON.stringify(templatesFile, null, 2),
  );
}

export function cleanupTestConfig(configDir) {
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

