import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

// Lightweight test of the SessionManager alias registry helpers

let SessionManager;
let configDir;

describe('SessionManager alias registry', () => {
  beforeEach(async () => {
    configDir = createTestConfig();
    process.env.TERMSTATION_CONFIG_DIR = configDir;
    ({ SessionManager } = await import('../managers/session-manager.js'));
  });

  afterEach(() => {
    cleanupTestConfig(configDir);
    delete process.env.TERMSTATION_CONFIG_DIR;
  });

  it('registers, resolves, and unregisters aliases correctly', () => {
    const mgr = new SessionManager();

    // No-op: Map is empty; resolving returns input unchanged
    expect(mgr.resolveIdFromAliasOrId('abc')).toBe('abc');

    // Register a valid alias
    const sid = '11111111-1111-1111-1111-111111111111';
    expect(mgr.registerAlias('my-alias', sid)).toBe(true);
    expect(mgr.resolveIdFromAliasOrId('my-alias')).toBe(sid);

    // Re-register same alias to a different session — should move mapping
    const sid2 = '22222222-2222-2222-2222-222222222222';
    expect(mgr.registerAlias('my-alias', sid2)).toBe(true);
    expect(mgr.resolveIdFromAliasOrId('my-alias')).toBe(sid2);

    // Invalid alias should be ignored
    expect(mgr.registerAlias('not ok!', sid)).toBe(false);
    expect(mgr.resolveIdFromAliasOrId('not ok!')).toBe('not ok!');

    // Unregister for session
    mgr.unregisterAliasesForSession(sid2);
    expect(mgr.resolveIdFromAliasOrId('my-alias')).toBe('my-alias');
  });
});

