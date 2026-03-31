import test from 'node:test';
import assert from 'node:assert/strict';
import { isDynamicTitleOnlySessionUpdate } from '../public/js/utils/dynamic-title-updates.js';

test('isDynamicTitleOnlySessionUpdate accepts only session_id plus dynamic_title', () => {
  assert.equal(isDynamicTitleOnlySessionUpdate({
    session_id: 'sess-1',
    dynamic_title: 'rotating'
  }, 'updated'), true);
});

test('isDynamicTitleOnlySessionUpdate rejects payloads with extra fields', () => {
  assert.equal(isDynamicTitleOnlySessionUpdate({
    session_id: 'sess-1',
    dynamic_title: 'rotating',
    output_active: true
  }, 'updated'), false);

  assert.equal(isDynamicTitleOnlySessionUpdate({
    session_id: 'sess-1',
    dynamic_title: 'rotating',
    title: 'Pinned'
  }, 'updated'), false);
});

test('isDynamicTitleOnlySessionUpdate rejects non-updated events and invalid ids', () => {
  assert.equal(isDynamicTitleOnlySessionUpdate({
    session_id: 'sess-1',
    dynamic_title: 'rotating'
  }, 'created'), false);

  assert.equal(isDynamicTitleOnlySessionUpdate({
    session_id: '   ',
    dynamic_title: 'rotating'
  }, 'updated'), false);
});
