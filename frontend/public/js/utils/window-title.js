/**
 * Window Title Sync
 * Updates document.title in window-mode to reflect the active parent session title.
 * Format: "TermStation — <session_title>"; falls back to just "TermStation" when unknown.
 */

import { getContext } from '../core/context.js';
import { computeDisplayTitle } from './title-utils.js';

function isWindowMode() {
  try {
    if (window.WindowModeUtils && typeof WindowModeUtils.shouldUseWindowModeFromUrl === 'function') {
      return !!WindowModeUtils.shouldUseWindowModeFromUrl(window.location);
    }
  } catch (_) { /* ignore */ }
  try {
    const mode = document.documentElement.getAttribute('data-window-ui');
    return mode === 'window';
  } catch (_) { /* ignore */ }
  return false;
}

/** Initialize title syncing for window-mode renderers. */
export function initWindowTitleSync() {
  if (!isWindowMode()) return () => {};

  const { appStore } = getContext();
  let lastTitle = null;

  const applyTitle = (parentSessionId) => {
    let finalTitle = 'TermStation';
    try {
      let data = null;
      if (parentSessionId) {
        const sessions = appStore.getState('sessionList.sessions');
        if (sessions && typeof sessions.get === 'function') {
          data = sessions.get(parentSessionId);
        }
      }
      // Use empty default so unknown title does not render as placeholder in window title
      const display = computeDisplayTitle(data || {}, { fallbackOrder: [], defaultValue: '' }).trim();
      if (display) {
        finalTitle = `TermStation — ${display}`;
      }
    } catch (_) { /* keep default */ }

    if (finalTitle !== lastTitle) {
      try { document.title = finalTitle; } catch (_) {}
      lastTitle = finalTitle;
    }
  };

  const getActiveParentId = () => {
    try {
      const sid = appStore.getState('sessionList.activeSessionId');
      return sid || null;
    } catch (_) { return null; }
  };

  // Initial apply
  applyTitle(getActiveParentId());

  // React to session selection changes
  const unsubActive = appStore.subscribe('sessionList.activeSessionId', (newVal) => {
    applyTitle(newVal);
  });

  // React to session data updates (e.g., title changes)
  const unsubSessions = appStore.subscribe('sessionList.sessions', () => {
    applyTitle(getActiveParentId());
  });

  // React to Dynamic Title mode changes
  const unsubMode = appStore.subscribe('preferences.terminal.dynamicTitleMode', () => {
    applyTitle(getActiveParentId());
  });

  // Return a disposer
  return () => {
    try { typeof unsubActive === 'function' && unsubActive(); } catch (_) {}
    try { typeof unsubSessions === 'function' && unsubSessions(); } catch (_) {}
    try { typeof unsubMode === 'function' && unsubMode(); } catch (_) {}
  };
}
