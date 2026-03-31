/**
 * Window Title Sync
 * Updates document.title in window-mode to reflect the active parent session title.
 * Format: "TermStation — <session_title>"; falls back to just "TermStation" when unknown.
 */

import { getContext } from '../core/context.js';
import { computeDisplayTitle } from './title-utils.js';

let lastAppliedTitle = null;

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

function getDisplaySessionData(parentSessionId) {
  try {
    const terminalManager = getContext()?.app?.modules?.terminal;
    if (terminalManager && typeof terminalManager.getDisplaySessionData === 'function') {
      return terminalManager.getDisplaySessionData(parentSessionId);
    }
  } catch (_) { /* ignore */ }

  try {
    const { appStore } = getContext();
    if (parentSessionId) {
      const sessions = appStore.getState('sessionList.sessions');
      if (sessions && typeof sessions.get === 'function') {
        return sessions.get(parentSessionId) || null;
      }
    }
  } catch (_) { /* ignore */ }

  return null;
}

/** Initialize title syncing for window-mode renderers. */
export function initWindowTitleSync() {
  if (!isWindowMode()) return () => {};

  const { appStore } = getContext();

  const applyTitle = (parentSessionId) => {
    const data = getDisplaySessionData(parentSessionId);
    applyWindowTitleFromSessionData(data);
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

export function applyWindowTitleFromSessionData(sessionData = null) {
  if (!isWindowMode()) return;

  let finalTitle = 'TermStation';
  try {
    const display = computeDisplayTitle(sessionData || {}, { fallbackOrder: [], defaultValue: '' }).trim();
    if (display) {
      finalTitle = `TermStation — ${display}`;
    }
  } catch (_) { /* keep default */ }

  if (finalTitle !== lastAppliedTitle) {
    try { document.title = finalTitle; } catch (_) {}
    lastAppliedTitle = finalTitle;
  }
}
