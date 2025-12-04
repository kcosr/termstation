import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

describe('configure-install users.json update', () => {
  it('updates top-level users array username from termstation to custom login', () => {
    const configDir = createTestConfig();
    try {
      const usersPath = join(configDir, 'users.json');
      const initialUsers = [
        {
          username: 'termstation',
          password_hash: 'dummy-hash',
          prompt_for_reset: true,
          groups: ['developers', 'admins'],
        },
      ];
      writeFileSync(usersPath, JSON.stringify(initialUsers, null, 2));

      const scriptPath = join(process.cwd(), 'scripts', 'configure-install.mjs');
      const result = spawnSync(
        'node',
        [scriptPath, '--config-dir', configDir, '--termstation-login', 'alice'],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(0);

      const updated = JSON.parse(readFileSync(usersPath, 'utf8'));
      expect(Array.isArray(updated)).toBe(true);
      expect(updated[0].username).toBe('alice');
    } finally {
      cleanupTestConfig(configDir);
    }
  });
});

