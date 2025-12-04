import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProfileThemeOverride,
  computeThemePersistence
} from '../public/js/modules/settings/theme-persistence.js';

test('global theme saves when no overrides exist', () => {
  const plan = computeThemePersistence({
    prevSettings: { ui: { theme: 'dark' } },
    selectedTheme: 'light',
    scopeIsProfile: false,
    activeProfileId: ''
  });

  assert.equal(plan.nextGlobalTheme, 'light');
  assert.equal(plan.nextProfileTheme, null);
  assert.equal(plan.effectiveTheme, 'light');
});

test('saving a profile-specific override does not touch the global theme', () => {
  const prevSettings = {
    ui: { theme: 'dark' },
    authProfiles: {
      activeId: 'alpha',
      items: [{ id: 'alpha', name: 'Primary' }]
    }
  };

  const plan = computeThemePersistence({
    prevSettings,
    selectedTheme: 'light',
    scopeIsProfile: true,
    activeProfileId: 'alpha'
  });

  assert.equal(plan.nextGlobalTheme, 'dark');
  assert.equal(plan.nextProfileTheme, 'light');
  assert.equal(plan.effectiveTheme, 'light');

  const updatedProfiles = applyProfileThemeOverride(prevSettings.authProfiles, 'alpha', plan.nextProfileTheme);
  assert.equal(updatedProfiles.items[0].overrides.ui.theme, 'light');
  assert.equal(updatedProfiles.activeId, 'alpha');
});

test('editing an existing profile override keeps the stored global theme intact', () => {
  const prevSettings = {
    ui: { theme: 'nord' },
    authProfiles: {
      activeId: 'alpha',
      items: [{
        id: 'alpha',
        overrides: { ui: { theme: 'dracula' } }
      }]
    }
  };

  const plan = computeThemePersistence({
    prevSettings,
    selectedTheme: 'matrix',
    scopeIsProfile: true,
    activeProfileId: 'alpha'
  });

  assert.equal(plan.nextGlobalTheme, 'nord');
  assert.equal(plan.nextProfileTheme, 'matrix');
  assert.equal(plan.effectiveTheme, 'matrix');

  const updatedProfiles = applyProfileThemeOverride(prevSettings.authProfiles, 'alpha', plan.nextProfileTheme);
  assert.equal(updatedProfiles.items[0].overrides.ui.theme, 'matrix');
});

test('switching back to a global theme clears any profile-specific override', () => {
  const prevSettings = {
    ui: { theme: 'dark' },
    authProfiles: {
      activeId: 'alpha',
      items: [{
        id: 'alpha',
        overrides: { ui: { theme: 'nord' } }
      }]
    }
  };

  const plan = computeThemePersistence({
    prevSettings,
    selectedTheme: 'tokyo-night',
    scopeIsProfile: false,
    activeProfileId: 'alpha'
  });

  assert.equal(plan.nextGlobalTheme, 'tokyo-night');
  assert.equal(plan.nextProfileTheme, null);
  assert.equal(plan.effectiveTheme, 'tokyo-night');

  const updatedProfiles = applyProfileThemeOverride(prevSettings.authProfiles, 'alpha', plan.nextProfileTheme);
  assert.equal(updatedProfiles.items[0].overrides, undefined);
});
