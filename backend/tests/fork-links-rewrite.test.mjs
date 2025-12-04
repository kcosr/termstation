import { test, expect } from 'vitest';
import { rewriteLinksForFork, rewriteLinkForFork } from '../utils/link-rewriter.js';

test('rewriteLinkForFork replaces old session_id in query and path', () => {
  const oldId = '00000000-0000-0000-0000-000000000000';
  const newId = '11111111-1111-1111-1111-111111111111';
  const l1 = { url: `https://pc/termstation?session_id=${oldId}`, name: `Session ${oldId}` };
  const out1 = rewriteLinkForFork(l1, { oldSessionId: oldId, newSessionId: newId });
  expect(out1.url).toBe(`https://pc/termstation?session_id=${newId}`);
  expect(out1.name).toBe(`Session ${newId}`);

  const l2 = { url: `https://pc/termstation-api/api/sessions/${oldId}/service/3000`, name: 'Svc' };
  const out2 = rewriteLinkForFork(l2, { oldSessionId: oldId, newSessionId: newId });
  expect(out2.url).toBe(`https://pc/termstation-api/api/sessions/${newId}/service/3000`);
});

test('rewriteLinkForFork expands macros with provided variables', () => {
  const oldId = 'aaaa';
  const newId = 'bbbb';
  const l = { url: 'https://pc/termstation?session_id={session_id}', name: 'N={session_id}' };
  const out = rewriteLinkForFork(l, {
    oldSessionId: oldId,
    newSessionId: newId,
    variables: { session_id: newId }
  });
  expect(out.url).toBe(`https://pc/termstation?session_id=${newId}`);
  expect(out.name).toBe(`N=${newId}`);
});

test('rewriteLinksForFork processes arrays and preserves unrelated links', () => {
  const oldId = 'old';
  const newId = 'new';
  const list = [
    { url: `https://x?session_id=${oldId}`, name: 'A' },
    { url: `https://y/path`, name: 'B' }
  ];
  const out = rewriteLinksForFork(list, { oldSessionId: oldId, newSessionId: newId });
  expect(out.length).toBe(2);
  expect(out[0].url).toBe(`https://x?session_id=${newId}`);
  expect(out[1].url).toBe(`https://y/path`);
});
