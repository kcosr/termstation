import { describe, it, expect } from 'vitest';
import { resolveCreateWorkspace } from '../tools/agents/agents.mjs';

describe('resolveCreateWorkspace', () => {
  it('defaults to Default when no override is provided', () => {
    expect(resolveCreateWorkspace({})).toBe('Default');
  });

  it('uses AGENTS_WORKSPACE when provided', () => {
    expect(resolveCreateWorkspace({ envWorkspace: 'Reviews' })).toBe('Reviews');
  });

  it('prefers the CLI workspace option over AGENTS_WORKSPACE', () => {
    expect(resolveCreateWorkspace({
      optionWorkspace: 'Pairing',
      envWorkspace: 'Reviews',
    })).toBe('Pairing');
  });

  it('normalizes default workspace casing', () => {
    expect(resolveCreateWorkspace({ optionWorkspace: 'default' })).toBe('Default');
    expect(resolveCreateWorkspace({ envWorkspace: 'DEFAULT' })).toBe('Default');
  });
});
