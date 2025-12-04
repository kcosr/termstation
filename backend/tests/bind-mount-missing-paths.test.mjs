import { test, expect } from 'vitest';
import { mkdirSync } from 'fs';
import { join } from 'path';
import {
  createTestConfig,
  writeTestTemplates,
  cleanupTestConfig
} from './helpers/test-utils.mjs';

test('template bind_mounts skip missing host paths', async () => {
  const configDir = createTestConfig();
  try {
    const existingDir = join(configDir, 'existing-mount');
    mkdirSync(existingDir, { recursive: true });
    const missingDir = join(configDir, 'missing-mount-does-not-exist');

    writeTestTemplates(configDir, [
      {
        id: 'bind-mount-test',
        name: 'Bind Mount Test',
        command: 'echo test',
        isolation: 'container',
        bind_mounts: [
          { host_path: existingDir, container_path: '/mnt/existing' },
          { host_path: missingDir, container_path: '/mnt/missing' }
        ]
      }
    ]);

    process.env.TERMSTATION_CONFIG_DIR = configDir;
    const mod = await import('../template-loader.js');
    const loader = mod.templateLoader;

    const tpl = loader.getTemplate('bind-mount-test');
    expect(tpl).toBeTruthy();
    expect(tpl.isolation).toBe('container');

    const processed = tpl.processTemplate({ session_id: 'bind-mount-session' });
    const cmd = String(processed.command || '');

    expect(cmd).toContain(`${existingDir}:/mnt/existing`);
    expect(cmd).not.toContain(`${missingDir}:/mnt/missing`);
  } finally {
    try {
      const mod = await import('../template-loader.js');
      mod.templateLoader?.cleanup?.();
    } catch {
      // ignore
    }
    cleanupTestConfig(configDir);
    delete process.env.TERMSTATION_CONFIG_DIR;
  }
});

