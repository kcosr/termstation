import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

describe('configure-install URL updates', () => {
  it('uses TERMSTATION_PUBLIC_HOST when bind address is 0.0.0.0', () => {
    const configDir = createTestConfig();
    try {
      const scriptPath = join(process.cwd(), 'scripts', 'configure-install.mjs');
      const env = { ...process.env, TERMSTATION_PUBLIC_HOST: 'example-host' };
      const result = spawnSync(
        'node',
        [
          scriptPath,
          '--config-dir',
          configDir,
          '--bind-address',
          '0.0.0.0',
          '--backend-port',
          '6624',
          '--frontend-port',
          '6625',
        ],
        { encoding: 'utf8', env },
      );

      expect(result.status).toBe(0);

      const config = JSON.parse(
        readFileSync(join(configDir, 'config.json'), 'utf8'),
      );
      expect(config.sessions_base_url).toBe('http://example-host:6625');
      expect(config.sessions_api_base_url).toBe('http://example-host:6624/api');
    } finally {
      cleanupTestConfig(configDir);
    }
  });
});

