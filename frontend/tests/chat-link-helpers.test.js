import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRegenerateTemplateLink,
  normalizeTemplateLinkError,
  normalizeFontFamilyString,
  computeChatLinkFonts
} from '../public/js/modules/terminal/chat-link-helpers.js';
import { TabManager } from '../public/js/modules/terminal/tab-manager.js';

test('shouldRegenerateTemplateLink regenerates on first view', () => {
  const decision = shouldRegenerateTemplateLink({
    hasGeneratedOnce: false,
    refreshOnViewActive: false,
    refreshOnViewInactive: false,
    isSessionActive: true,
    reason: 'view'
  });
  assert.equal(decision, true);
});

test('shouldRegenerateTemplateLink respects active/inactive flags after first generation', () => {
  const activeShould = shouldRegenerateTemplateLink({
    hasGeneratedOnce: true,
    refreshOnViewActive: true,
    refreshOnViewInactive: false,
    isSessionActive: true,
    reason: 'view'
  });
  assert.equal(activeShould, true);

  const activeSkip = shouldRegenerateTemplateLink({
    hasGeneratedOnce: true,
    refreshOnViewActive: false,
    refreshOnViewInactive: true,
    isSessionActive: true,
    reason: 'view'
  });
  assert.equal(activeSkip, false);

  const inactiveShould = shouldRegenerateTemplateLink({
    hasGeneratedOnce: true,
    refreshOnViewActive: false,
    refreshOnViewInactive: true,
    isSessionActive: false,
    reason: 'view'
  });
  assert.equal(inactiveShould, true);

  const inactiveSkip = shouldRegenerateTemplateLink({
    hasGeneratedOnce: true,
    refreshOnViewActive: true,
    refreshOnViewInactive: false,
    isSessionActive: false,
    reason: 'view'
  });
  assert.equal(inactiveSkip, false);
});

test('shouldRegenerateTemplateLink always regenerates on explicit refresh', () => {
  const decision = shouldRegenerateTemplateLink({
    hasGeneratedOnce: true,
    refreshOnViewActive: false,
    refreshOnViewInactive: false,
    isSessionActive: true,
    reason: 'refresh'
  });
  assert.equal(decision, true);
});

test('normalizeTemplateLinkError prefers backend error and details fields', () => {
  const err = {
    error: 'Generation failed',
    details: 'Template process exited with status 1'
  };
  const normalized = normalizeTemplateLinkError(err);
  assert.equal(normalized.message, 'Generation failed');
  assert.equal(normalized.details, 'Template process exited with status 1');
});

test('normalizeTemplateLinkError falls back to ApiService-style error context', () => {
  const err = {
    message: 'Request failed',
    context: {
      error: 'generation_error',
      details: 'Command timed out after 5s'
    }
  };
  const normalized = normalizeTemplateLinkError(err);
  assert.equal(normalized.message, 'Request failed');
  assert.equal(normalized.details, 'Command timed out after 5s');
});

test('normalizeFontFamilyString strips a single pair of surrounding quotes', () => {
  assert.equal(normalizeFontFamilyString('"Inter"'), 'Inter');
  assert.equal(normalizeFontFamilyString('  \'Fira Code\'  '), 'Fira Code');
  // Inner quotes should be preserved
  assert.equal(normalizeFontFamilyString('\"Inter\", system-ui'), '"Inter", system-ui');
});

test('computeChatLinkFonts prefers CSS vars with sensible fallbacks', () => {
  const fonts = computeChatLinkFonts({
    fontUiVar: '"Inter"',
    bodyFontFamily: 'BodyFallback',
    fontCodeVar: '',
    terminalFontFamily: '"Fira Code", monospace',
    defaultCodeFont: 'monospace'
  });

  assert.ok(fonts);
  assert.equal(fonts.ui, 'Inter');
  assert.equal(fonts.code, '"Fira Code", monospace');
});

test('buildThemePayloadForTab forwards core palette with normalized keys', () => {
  const root = {};
  const body = {};
  const terminal = {};

  const cssVars = {
    '--bg-primary': '#111111',
    '--bg-secondary': '#222222',
    '--bg-tertiary': '#333333',
    '--bg-hover': '#444444',
    '--text-primary': '#eeeeee',
    '--text-secondary': '#dddddd',
    '--text-dim': '#cccccc',
    '--border-color': '#555555',
    '--accent-color': '#0066ff',
    '--accent-hover': '#0088ff',
    '--danger-color': '#ff0000',
    '--success-color': '#00ff00',
    '--warning-color': '#ffaa00',
    '--font-ui': '"Inter"',
    '--font-code': '"Fira Code"'
  };

  global.document = {
    documentElement: root,
    body,
    querySelector: (selector) => {
      if (selector === '.terminal-view') return terminal;
      return null;
    }
  };

  global.getComputedStyle = (node) => {
    if (node === root) {
      return {
        getPropertyValue: (name) => cssVars[name] || ''
      };
    }
    if (node === body) {
      return { fontFamily: 'BodyFallback' };
    }
    if (node === terminal) {
      return { fontFamily: '"Fira Code", monospace' };
    }
    return {
      getPropertyValue: () => '',
      fontFamily: ''
    };
  };

  const payload = TabManager.prototype.buildThemePayloadForTab.call(null, {
    passThemeColors: true
  });

  assert.ok(payload);
  assert.ok(payload.theme);

  assert.deepEqual(payload.theme, {
    bg_primary: '#111111',
    bg_secondary: '#222222',
    bg_tertiary: '#333333',
    bg_hover: '#444444',
    text_primary: '#eeeeee',
    text_secondary: '#dddddd',
    text_dim: '#cccccc',
    border_color: '#555555',
    accent_color: '#0066ff',
    accent_hover: '#0088ff',
    danger_color: '#ff0000',
    success_color: '#00ff00',
    warning_color: '#ffaa00'
  });

  assert.ok(payload.fonts);
  assert.equal(payload.fonts.ui, 'Inter');
  assert.equal(payload.fonts.code, '"Fira Code", monospace');
});
