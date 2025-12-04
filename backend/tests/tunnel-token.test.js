import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let createTunnelToken;
let verifyTunnelToken;
let getTunnelWebSocketUrl;

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ createTunnelToken, verifyTunnelToken, getTunnelWebSocketUrl } = await import('../utils/session-access-token.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('tunnel token utilities', () => {
it('createTunnelToken + verifyTunnelToken: basic round-trip', () => {
  const sid = 'sess-xyz';
  const tok = createTunnelToken({ sessionId: sid, ttlSeconds: 3600 });
  const v1 = verifyTunnelToken(tok);
  expect(v1.ok).toBe(true);
  expect(v1.payload.session_id).toBe(sid);
  const v2 = verifyTunnelToken(tok, sid);
  expect(v2.ok).toBe(true);
  const v3 = verifyTunnelToken(tok, 'other');
  expect(v3.ok).toBe(false);
});

// Scopes removed: token is unscoped; verification only checks session and expiry

it('verifyTunnelToken rejects tampered token', () => {
  const sid = 'sess-abc';
  const tok = createTunnelToken({ sessionId: sid, ttlSeconds: 3600 });
  // Flip last hex char in signature
  const bad = tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a');
  const v = verifyTunnelToken(bad);
  expect(v.ok).toBe(false);
});

it('getTunnelWebSocketUrl uses explicit API base (no implicit /api append)', () => {
  const sid = 's1';
  const token = 't1';
  const u1 = getTunnelWebSocketUrl('https://pc/termstation-api/', sid, token);
  expect(u1).toBe('wss://pc/termstation-api/sessions/s1/tunnel?token=t1');
  const u2 = getTunnelWebSocketUrl('http://localhost:8080/api/', sid, token);
  expect(u2).toBe('ws://localhost:8080/api/sessions/s1/tunnel?token=t1');
});

it('createTunnelToken with ttlSeconds=0 creates token without exp field', () => {
  const sid = 'sess-no-exp';
  const tok = createTunnelToken({ sessionId: sid, ttlSeconds: 0 });
  const v = verifyTunnelToken(tok, sid);
  expect(v.ok, 'Token should verify').toBe(true);
  expect(v.payload.exp, 'Token should not have exp field').toBeUndefined();
});

it('verifyTunnelToken accepts token without exp field (TTL=0)', () => {
  const sid = 'sess-no-exp-verify';
  const tok = createTunnelToken({ sessionId: sid, ttlSeconds: 0 });
  const v = verifyTunnelToken(tok, sid);
  expect(v.ok, 'Token without exp should verify').toBe(true);
  expect(v.payload.exp, 'Token should not have exp field').toBeUndefined();
});

it('verifyTunnelToken still rejects expired tokens with exp field', async () => {
  const sid = 'sess-expired';
  const tok = createTunnelToken({ sessionId: sid, ttlSeconds: 1 });
  // Wait for expiration
  await new Promise((resolve) => {
    setTimeout(() => {
      const v = verifyTunnelToken(tok, sid);
      expect(v.ok, 'Expired token should be rejected').toBe(false);
      expect(v.error).toBe('expired');
      resolve();
    }, 1500);
  });
});

it('createTunnelToken default parameter is 0 (no expiration)', () => {
  const sid = 'sess-default';
  const tok = createTunnelToken({ sessionId: sid });
  const v = verifyTunnelToken(tok, sid);
  expect(v.ok, 'Token with default TTL should verify').toBe(true);
  expect(v.payload.exp, 'Token with default TTL should not have exp field').toBeUndefined();
});

});
