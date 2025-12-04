/**
 * Session Activity Handler
 * Handles server-sent activity state updates per session
 */
import { appStore } from '../../../core/store.js';

function updateStoppedWhileHiddenIndicator(sessionId, enabled) {
  try {
    if (!sessionId) return;
    const state = appStore.getState() || {};
    const sessionListState = state.sessionList;
    // If the session list has not been initialized yet, skip without
    // creating a placeholder structure (SessionList will set it up).
    if (!sessionListState) return;
    const currentMap = sessionListState.activityStoppedWhileHidden;
    let nextMap;
    if (currentMap instanceof Map) {
      nextMap = new Map(currentMap);
    } else if (currentMap && typeof currentMap === 'object') {
      nextMap = new Map();
      for (const [key, value] of Object.entries(currentMap)) {
        if (value) nextMap.set(key, true);
      }
    } else {
      nextMap = new Map();
    }
    if (enabled) nextMap.set(sessionId, true);
    else nextMap.delete(sessionId);
    appStore.setPath('sessionList.activityStoppedWhileHidden', nextMap);
    try { appStore.setPath('sessionList.lastUpdate', Date.now()); } catch (_) {}
  } catch (_) { /* ignore */ }
}

export class SessionActivityHandler {
  /**
   * @param {Object} message - { session_id, sessionId, activity_state, last_output_at }
   * @param {Object} context - { terminalManager, eventBus, ... }
   */
  handle(message, context) {
    try {
      const mgr = context && context.terminalManager;
      if (!mgr) return;
      const sid = String(message.session_id || message.sessionId || '').trim();
      if (!sid) return;
      const state = String(message.activity_state || '').toLowerCase();
      if (state === 'inactive' || state === 'idle') {
        // Persistently set as inactive and, when the session is not the one
        // currently being viewed, mark that output stopped while hidden.
        try { mgr.setSessionActivityState?.(sid, false); } catch (_) {}
        try {
          const st = appStore.getState() || {};
          const sl = st.sessionList || {};
          const activeId = sl.activeSessionId != null ? String(sl.activeSessionId) : null;
          const isViewingNow = !!activeId && activeId === sid;
          updateStoppedWhileHiddenIndicator(sid, !isViewingNow);
        } catch (_) { /* ignore */ }
        return;
      }
      if (state === 'active') {
        // Active: show pulsing indicator and clear any prior "stopped while hidden" flag.
        try { mgr.setSessionActivityState?.(sid, true); } catch (_) {}
        try { updateStoppedWhileHiddenIndicator(sid, false); } catch (_) {}
      }
    } catch (_) { /* ignore */ }
  }
}

export const sessionActivityHandler = new SessionActivityHandler();
