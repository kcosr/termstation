import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWindowTitleFromSessionData } from '../public/js/utils/window-title.js';

function withWindowMode(testFn) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalWindowModeUtils = globalThis.WindowModeUtils;

  const windowModeUtils = {
    shouldUseWindowModeFromUrl: () => true
  };

  globalThis.window = {
    location: {},
    WindowModeUtils: windowModeUtils
  };
  globalThis.WindowModeUtils = windowModeUtils;
  globalThis.document = {
    title: '',
    documentElement: {
      getAttribute: () => 'window'
    }
  };

  try {
    testFn();
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.WindowModeUtils = originalWindowModeUtils;
  }
}

test('applyWindowTitleFromSessionData sets window title from display title', () => {
  withWindowMode(() => {
    applyWindowTitleFromSessionData({ title: 'Explicit Title', dynamic_title: 'Ignored' });
    assert.equal(globalThis.document.title, 'TermStation — Explicit Title');

    applyWindowTitleFromSessionData({ dynamic_title: 'Dynamic Title' });
    assert.equal(globalThis.document.title, 'TermStation — Dynamic Title');
  });
});

test('applyWindowTitleFromSessionData falls back to default app title', () => {
  withWindowMode(() => {
    applyWindowTitleFromSessionData({});
    assert.equal(globalThis.document.title, 'TermStation');
  });
});
