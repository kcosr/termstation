import { describe, it, expect } from 'vitest';
import {
  resolveInlineMessageArg,
  shouldReadMessageFromStdin,
} from '../tools/agents/lib/io.mjs';

describe('agents stdin/message resolution', () => {
  it('keeps regular message arguments inline', () => {
    expect(resolveInlineMessageArg('review this change')).toBe('review this change');
  });

  it('treats "-" as the explicit stdin sentinel', () => {
    expect(resolveInlineMessageArg('-')).toBe('');
    expect(shouldReadMessageFromStdin('-')).toBe(true);
  });

  it('does not read stdin implicitly when no message is provided', () => {
    expect(resolveInlineMessageArg(undefined)).toBe('');
    expect(resolveInlineMessageArg('')).toBe('');
    expect(shouldReadMessageFromStdin(undefined)).toBe(false);
    expect(shouldReadMessageFromStdin('')).toBe(false);
  });
});
