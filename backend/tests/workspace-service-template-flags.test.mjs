import { test, expect } from 'vitest';
import {
  createTestConfig,
  writeTestTemplates,
  cleanupTestConfig
} from './helpers/test-utils.mjs';

test('workspace_service_enabled inherits and overrides correctly', async () => {
  const configDir = createTestConfig();
  try {
    writeTestTemplates(configDir, [
      {
        id: 'base-workspace',
        name: 'Base Workspace',
        command: 'echo base',
        workspace_service_enabled: true
      },
      {
        id: 'child-inherit',
        name: 'Child Inherit',
        extends: 'base-workspace',
        command: 'echo child inherit'
      },
      {
        id: 'child-disable',
        name: 'Child Disable',
        extends: 'base-workspace',
        command: 'echo child disable',
        workspace_service_enabled: false
      }
    ]);

    process.env.TERMSTATION_CONFIG_DIR = configDir;
    const mod = await import('../template-loader.js');
    const loader = mod.templateLoader;

    const base = loader.getTemplate('base-workspace');
    const inherit = loader.getTemplate('child-inherit');
    const disable = loader.getTemplate('child-disable');

    expect(base.workspace_service_enabled).toBe(true);
    expect(inherit.workspace_service_enabled).toBe(true);
    expect(disable.workspace_service_enabled).toBe(false);

    const inheritDict = inherit.toDict();
    const disableDict = disable.toDict();
    expect(inheritDict.workspace_service_enabled).toBe(true);
    expect(disableDict.workspace_service_enabled).toBe(false);
  } finally {
    try {
      const mod = await import('../template-loader.js');
      mod.templateLoader?.cleanup?.();
    } catch {
    }
    cleanupTestConfig(configDir);
    delete process.env.TERMSTATION_CONFIG_DIR;
  }
});

