import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { loadConfig } from '../tools/agents/lib/config.mjs';

const originalSessionId = process.env.SESSION_ID;
const originalApiBase = process.env.SESSIONS_API_BASE_URL;
const originalForge = process.env.FORGE;

beforeEach(() => {
  if (!process.env.SESSION_ID) process.env.SESSION_ID = 'test-session-id';
  if (!process.env.SESSIONS_API_BASE_URL) process.env.SESSIONS_API_BASE_URL = 'http://localhost/';
});

afterEach(() => {
  if (originalSessionId === undefined) delete process.env.SESSION_ID;
  else process.env.SESSION_ID = originalSessionId;

  if (originalApiBase === undefined) delete process.env.SESSIONS_API_BASE_URL;
  else process.env.SESSIONS_API_BASE_URL = originalApiBase;

  if (originalForge === undefined) delete process.env.FORGE;
  else process.env.FORGE = originalForge;
});

describe('agents config FORGE handling', () => {
  it('includes FORGE from environment when set', () => {
    process.env.FORGE = 'gitlab';
    const cfg = loadConfig();
    expect(cfg.FORGE).toBe('gitlab');
  });

  it('defaults FORGE to empty string when unset', () => {
    delete process.env.FORGE;
    const cfg = loadConfig();
    expect(cfg.FORGE).toBe('');
  });
});

