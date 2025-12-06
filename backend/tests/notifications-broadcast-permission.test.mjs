// Tests for constructing the notifications API request used to verify
// broadcast permission enforcement. These are unit tests for the request
// shape only (no real HTTP calls are made).

import { test, expect } from 'vitest';

const SERVER = 'http://localhost:6620';
const USER = 'developer';
const PASS = 'password';
const SESSION_ID = '00000000-0000-0000-0000-000000000000';

function buildNotificationRequest({ server, user, pass, sessionId }) {
  const url = `${server}/api/notifications`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
  };
  const body = {
    title: 'Broadcast Test (should 403)',
    message: 'Expecting 403 without broadcast permission',
    type: 'info',
    session_id: sessionId
  };
  return { url, options: { method: 'POST', headers, body: JSON.stringify(body) } };
}

test('notifications broadcast permission request has expected shape', () => {
  const { url, options } = buildNotificationRequest({
    server: SERVER,
    user: USER,
    pass: PASS,
    sessionId: SESSION_ID
  });
  expect(url).toBe(`${SERVER}/api/notifications`);
  expect(options.method).toBe('POST');
  expect(options.headers['Content-Type']).toBe('application/json');
  expect(options.headers.Authorization).toBe(
    'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
  );
  const parsedBody = JSON.parse(options.body);
  expect(parsedBody.session_id).toBe(SESSION_ID);
  expect(parsedBody.type).toBe('info');
});
