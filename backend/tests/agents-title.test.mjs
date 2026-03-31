import { describe, it, expect } from 'vitest';
import { resolveCreateTitle } from '../tools/agents/agents.mjs';

describe('resolveCreateTitle', () => {
  it('defaults to Session for <agent> when no repo or override is provided', () => {
    expect(resolveCreateTitle({ agent: 'codex' })).toBe('Session for codex');
  });

  it('uses repo and issue id when available', () => {
    expect(resolveCreateTitle({
      agent: 'codex',
      repo: 'devtools/termstation',
      issueId: '123',
    })).toBe('devtools/termstation #123');
  });

  it('appends description to computed titles when no explicit title override is present', () => {
    expect(resolveCreateTitle({
      agent: 'codex',
      repo: 'devtools/termstation',
      issueId: '123',
      description: 'Review reconnect behavior',
    })).toBe('devtools/termstation #123: Review reconnect behavior');
  });

  it('prefers --title over SESSION_TITLE and computed titles', () => {
    expect(resolveCreateTitle({
      agent: 'codex',
      repo: 'devtools/termstation',
      issueId: '123',
      description: 'Review reconnect behavior',
      optionTitle: 'Manual override',
      envTitle: 'Env override',
    })).toBe('Manual override');
  });

  it('uses SESSION_TITLE when --title is not provided', () => {
    expect(resolveCreateTitle({
      agent: 'codex',
      repo: 'devtools/termstation',
      issueId: '123',
      description: 'Review reconnect behavior',
      envTitle: 'Env override',
    })).toBe('Env override');
  });
});
