import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let resolveAllowedTemplatesFromConfig;

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ resolveAllowedTemplatesFromConfig } = await import('../utils/template-access.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('template access resolution', () => {
  it('groups-only allow/deny with ordering and deny wins', () => {
    const known = ['a', 'b', 'c', 'd'];
    const groups = [
      { name: 'g1', allow_templates: ['b', 'a'] },
      { name: 'g2', deny_templates: ['b'] }
    ];
    const out = resolveAllowedTemplatesFromConfig(known, null, groups, ['g1', 'g2']);
    expect(out).toEqual(['a']);
  });

  it('group allow * with group-level deny list', () => {
    const known = ['a', 'b', 'c', 'd'];
    const groups = [
      { name: 'g1', allow_templates: '*' },
      { name: 'g2', deny_templates: ['c'] }
    ];
    const out = resolveAllowedTemplatesFromConfig(known, null, groups, ['g1', 'g2']);
    expect(out).toEqual(['a', 'b', 'd']);
  });

  it('user allow * with user denies applied', () => {
    const known = ['a', 'b', 'c'];
    const groups = [];
    const user = { allow_templates: '*', deny_templates: ['a'] };
    const out = resolveAllowedTemplatesFromConfig(known, user, groups, []);
    expect(out).toEqual(['b', 'c']);
  });

  it('append user allow list after groups with dedupe', () => {
    const known = ['a', 'b', 'c', 'd'];
    const groups = [{ name: 'g1', allow_templates: ['b'] }];
    const user = { allow_templates: ['a', 'b', 'd'] };
    const out = resolveAllowedTemplatesFromConfig(known, user, groups, ['g1']);
    expect(out).toEqual(['b', 'a', 'd']);
  });

  it('user deny * yields empty set even if allows present', () => {
    const known = ['a', 'b'];
    const groups = [{ name: 'g1', allow_templates: ['a', 'b'] }];
    const user = { allow_templates: ['a'], deny_templates: '*' };
    const out = resolveAllowedTemplatesFromConfig(known, user, groups, ['g1']);
    expect(out).toEqual([]);
  });

  it('unknown IDs in allow/deny are ignored', () => {
    const known = ['a', 'b'];
    const groups = [{ name: 'g1', allow_templates: ['x', 'a'], deny_templates: ['y'] }];
    const user = { allow_templates: ['z'] };
    const out = resolveAllowedTemplatesFromConfig(known, user, groups, ['g1']);
    expect(out).toEqual(['a']);
  });
});

