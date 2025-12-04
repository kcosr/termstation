import { test, expect } from 'vitest';

import { resolveBooleanDomain } from '../utils/access-resolver.js';

test('permissions: group wildcard with user explicit false override', () => {
  const KEYS = new Set(['impersonate', 'manage_all_sessions', 'broadcast', 'sandbox_login']);
  const groupInputs = ['*'];
  const userInput = { broadcast: false };
  const res = resolveBooleanDomain({ keys: KEYS, groupInputs, userInput });
  expect(res.impersonate).toBe(true);
  expect(res.manage_all_sessions).toBe(true);
  expect(res.sandbox_login).toBe(true);
  expect(res.broadcast).toBe(false); // explicit false override
});

test('permissions: later group overrides earlier group', () => {
  const KEYS = new Set(['manage_all_sessions']);
  const groupInputs = [{ manage_all_sessions: true }, { manage_all_sessions: false }];
  const res = resolveBooleanDomain({ keys: KEYS, groupInputs, userInput: {} });
  expect(res.manage_all_sessions).toBe(false);
});

test('permissions: user wildcard with explicit false from group', () => {
  const KEYS = new Set(['broadcast', 'sandbox_login']);
  const groupInputs = [{ sandbox_login: false }];
  const userInput = '*';
  const res = resolveBooleanDomain({ keys: KEYS, groupInputs, userInput });
  expect(res.broadcast).toBe(true);
  expect(res.sandbox_login).toBe(false);
});

test('permissions: explicit user deny beats group allow', () => {
  const KEYS = new Set(['impersonate']);
  const groupInputs = [{ impersonate: true }];
  const userInput = { impersonate: false };
  const res = resolveBooleanDomain({ keys: KEYS, groupInputs, userInput });
  expect(res.impersonate).toBe(false);
});

test('features: wildcard enables notes_enabled unless explicit false', () => {
  const KEYS = new Set(['notes_enabled']);
  const groupInputs = ['*'];
  const res1 = resolveBooleanDomain({ keys: KEYS, groupInputs, userInput: {} });
  expect(res1.notes_enabled).toBe(true);
  const res2 = resolveBooleanDomain({ keys: KEYS, groupInputs, userInput: { notes_enabled: false } });
  expect(res2.notes_enabled).toBe(false);
});

test('features: wildcard enables image_uploads_enabled unless explicit false', () => {
  const KEYS = new Set(['image_uploads_enabled']);
  const groupInputs = ['*'];
  const res1 = resolveBooleanDomain({ keys: KEYS, groupInputs, userInput: {} });
  expect(res1.image_uploads_enabled).toBe(true);
  const res2 = resolveBooleanDomain({ keys: KEYS, groupInputs, userInput: { image_uploads_enabled: false } });
  expect(res2.image_uploads_enabled).toBe(false);
});
