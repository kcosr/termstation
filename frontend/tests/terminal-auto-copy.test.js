import test from 'node:test';
import assert from 'node:assert/strict';

import { TerminalAutoCopy } from '../public/js/utils/terminal-auto-copy.js';
import { appStore } from '../public/js/core/store.js';

test('normalizeSelectionTextForCopy keeps text unchanged when trimming is disabled', () => {
  const input = '  alpha  \n\tbeta\t\n  gamma  ';
  const output = TerminalAutoCopy.normalizeSelectionTextForCopy(input, {
    trimSelectionLineWhitespace: false
  });
  assert.equal(output, input);
});

test('normalizeSelectionTextForCopy trims leading and trailing whitespace per line when enabled', () => {
  const input = '  alpha  \n\tbeta\t\n  gamma  \n';
  const output = TerminalAutoCopy.normalizeSelectionTextForCopy(input, {
    trimSelectionLineWhitespace: true
  });
  assert.equal(output, 'alpha\nbeta\ngamma\n');
});

test('normalizeSelectionTextForCopy respects terminal preference when option is omitted', () => {
  const prev = appStore.getState('preferences.terminal.trimSelectionLineWhitespace');
  try {
    appStore.setPath('preferences.terminal.trimSelectionLineWhitespace', true);
    const input = '  left  \n\tright\t';
    const output = TerminalAutoCopy.normalizeSelectionTextForCopy(input);
    assert.equal(output, 'left\nright');
  } finally {
    appStore.setPath('preferences.terminal.trimSelectionLineWhitespace', prev === true);
  }
});
