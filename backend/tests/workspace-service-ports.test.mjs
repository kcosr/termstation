import { describe, it, expect } from 'vitest';
import { computeWorkspaceServicePort } from '../utils/workspace-service-flags.js';

describe('computeWorkspaceServicePort', () => {
  it('returns the same port for the same session id', () => {
    const id = 'session-stable-123';
    const p1 = computeWorkspaceServicePort(id);
    const p2 = computeWorkspaceServicePort(id);
    expect(p1).toBe(p2);
  });

  it('generally returns distinct ports for different session ids', () => {
    const ids = [
      'session-a',
      'session-b',
      'session-c',
      'session-d',
      'session-e',
      'session-f',
      'session-g',
      'session-h'
    ];
    const ports = ids.map(id => computeWorkspaceServicePort(id));
    const unique = new Set(ports);
    expect(unique.size).toBe(ports.length);
  });

  it('always returns a port within the configured range', () => {
    const base = 41000;
    const upperExclusive = 61000; // BASE_PORT + PORT_RANGE
    const ids = [
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
      'eta',
      'theta',
      'iota',
      'kappa'
    ];

    for (const id of ids) {
      const port = computeWorkspaceServicePort(id);
      expect(port).toBeGreaterThanOrEqual(base);
      expect(port).toBeLessThan(upperExclusive);
    }
  });
});
