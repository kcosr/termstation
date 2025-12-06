// Tests for constructing the notifications API request used to verify
// successful broadcast (owner + attached users). Again, this validates
// request shape only, not server behavior.

import { test, expect } from 'vitest';

const SERVER = 'http://localhost:6620';
const USER = 'webhooks';
const PASS = 'webhooks';
const SESSION_ID = '00000000-0000-0000-0000-000000000000';

function buildSuccessNotificationRequest({ server, user, pass, sessionId }) {
  const url = `${server}/api/notifications`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
  };
  const body = {
    title: 'Broadcast Test (owner+attached)',
    message: `Testing broadcast with session ${sessionId}`,
    type: 'info',
    session_id: sessionId
  };
  return { url, options: { method: 'POST', headers, body: JSON.stringify(body) } };
}

test('notifications broadcast success request has expected shape', () => {
  const { url, options } = buildSuccessNotificationRequest({
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
  expect(parsedBody.title).toContain('Broadcast Test');
  expect(parsedBody.session_id).toBe(SESSION_ID);
});
