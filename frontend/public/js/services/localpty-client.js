/**
 * LocalPTYClient
 * Renderer-side transport that adapts the desktop preload local PTY API
 * to the ITerminalTransport shape consumed by TerminalSession.
 *
 * Expected preload API (from #834):
 *  - window.desktop.isElectron === true when running in Electron
 *  - window.desktop.localpty exposes methods and emits events:
 *      Methods (best-effort; optional):
 *        - stdin({ session_id, data })
 *        - resize({ session_id, cols, rows })
 *        - terminate({ session_id })
 *        - attach?.({ session_id }) | start?.({ session_id, cols, rows }) | spawn?.(…)
 *      Events (window-despatched):
 *        - 'desktop:localpty-data'   detail: { session_id, data }
 *        - 'desktop:localpty-exit'   detail: { session_id, code?, signal? }
 *        - 'desktop:localpty-error'  detail: { session_id, message? }
 *
 * Notes
 *  - History is not managed for local sessions. An immediate ws-attached
 *    event with a static marker is emitted so TerminalSession skips history.
 *  - Output is forwarded directly to the active TerminalSession instance
 *    maintained by TerminalManager (avoids touching the WebSocket registry).
 *  - All behavior is gated on window.desktop?.isElectron && window.desktop?.localpty.
 */

import { getContext } from '../core/context.js';

export class LocalPTYClient {
  /**
   * @param {import('../modules/event-bus.js').EventBus|any} eventBus - App event bus
   */
  constructor(eventBus) {
    this.eventBus = eventBus;
    this._handlers = new Map(); // Map<event, Set<fn>> for basic on/off API
    this._boundListeners = new Map(); // Map<eventName, fn> for window listeners
    this._sessionId = null;
    this._connected = false;
  }

  static isAvailable() {
    try {
      return !!(window.desktop && window.desktop.isElectron && window.desktop.localpty);
    } catch (_) {
      return false;
    }
  }

  /**
   * Bind desktop event listeners for this session id.
   * Safe to call multiple times; no-ops if already connected.
   * @param {string} sessionId
   */
  connect(sessionId) {
    if (!LocalPTYClient.isAvailable()) return;
    if (this._connected && this._sessionId === sessionId) return;
    this._sessionId = sessionId;
    try { console.log('[LocalPTYClient] connect', { sessionId }); } catch (_) {}
    // Helper: route output data directly to the TerminalSession instance.
    const forwardOutput = (data) => {
      try {
        const mgr = getContext()?.app?.modules?.terminal;
        const sess = mgr?.sessions?.get?.(sessionId);
        if (sess && typeof sess.handleOutput === 'function') {
          sess.handleOutput(String(data ?? ''));
        }
        // Debug trace (non-fatal): log the first chunk to confirm wiring
        try {
          if (!this._loggedFirst && data) {
            console.log('[LocalPTYClient] output received', { sessionId, sample: String(data).slice(0, 80) });
            this._loggedFirst = true;
          }
        } catch (_) {}
      } catch (_) { /* ignore */ }
    };


    // Subscribe via preload API (ipc-backed), not window events
    try {
      const api = window.desktop && window.desktop.localpty;
      if (api && typeof api.onData === 'function') {
        const off = api.onData((payload) => {
          try {
            const sid = String((payload?.session_id ?? payload?.sessionId) || '').trim();
            if (!sid || sid !== this._sessionId) return;
            forwardOutput(payload?.data);
            this._emit('data', payload);
          } catch (_) { /* ignore */ }
        });
        this._boundListeners.set('onData', off);
      }
      if (api && typeof api.onExit === 'function') {
        const off = api.onExit((payload) => {
          try {
            const sid = String((payload?.session_id ?? payload?.sessionId) || '').trim();
            if (!sid || sid !== this._sessionId) return;
            try { console.log('[LocalPTYClient] exit', { sessionId: this._sessionId, payload }); } catch (_) {}
            try {
              const mgr = getContext()?.app?.modules?.terminal;
              if (mgr) {
                // Show terminated message and mark session ended in store so sidebar reflects Ended
                if (typeof mgr.showSessionTerminatedMessage === 'function') {
                  mgr.showSessionTerminatedMessage({ session_id: this._sessionId });
                }
                try { mgr?.sessionList?.markSessionAsTerminated?.(this._sessionId); } catch (_) {}
              }
            } catch (_) {}
            this._emit('exit', payload);
          } catch (_) { /* ignore */ }
        });
        this._boundListeners.set('onExit', off);
      }
      if (api && typeof api.onError === 'function') {
        const off = api.onError((payload) => {
          try {
            const sid = String((payload?.session_id ?? payload?.sessionId) || '').trim();
            if (!sid || sid !== this._sessionId) return;
            try { console.error('[LocalPTYClient] Error', payload); } catch (_) {}
            this._emit('error', payload);
          } catch (_) { /* ignore */ }
        });
        this._boundListeners.set('onError', off);
      }
    } catch (_) { /* ignore */ }

    this._connected = true;
  }

  /**
   * ITerminalTransport: send(type, payload)
   * Maps TerminalSession operations to desktop.localpty.
   */
  send(type, payload = {}) {
    if (!LocalPTYClient.isAvailable()) return false;
    const lpty = window.desktop.localpty;
    // Accept payload.session_id for compatibility, but pass sessionId to preload
    const sid = String((payload?.session_id ?? payload?.sessionId ?? this._sessionId) || '').trim();
    if (!sid) return false;

    switch (type) {
      case 'stdin': {
        try { lpty.stdin?.({ sessionId: sid, data: payload?.data ?? '' }); } catch (_) {}
        return true;
      }
      case 'resize': {
        const cols = Math.max(40, Math.floor(Number(payload?.cols) || 80));
        const rows = Math.max(10, Math.floor(Number(payload?.rows) || 24));
        try { lpty.resize?.({ sessionId: sid, cols, rows }); } catch (_) {}
        return true;
      }
      case 'terminate': {
        try { lpty.terminate?.({ sessionId: sid }); } catch (_) {}
        return true;
      }
      case 'attach': {
        // Bind listeners and try to start/attach if the preload exposes a method.
        this.connect(sid);
        try {
          if (typeof lpty.attach === 'function') {
            lpty.attach({ sessionId: sid }).then((res) => {
              try { console.log('[LocalPTYClient] attach result', { sessionId: sid, res }); } catch (_) {}
            }).catch((e) => {
              try { console.warn('[LocalPTYClient] attach error', e); } catch (_) {}
            });
          } else if (typeof lpty.start === 'function') {
            lpty.start({ sessionId: sid });
          } else if (typeof lpty.spawn === 'function') {
            lpty.spawn({ sessionId: sid });
          }
        } catch (_) { /* non-fatal */ }
        // Immediately emit ws-attached so TerminalSession skips history and proceeds
        try {
          this.eventBus?.emit?.('ws-attached', {
            type: 'attached',
            detail: { session_id: sid, history_marker: 'LOCAL_SESSION_NO_HISTORY', should_load_history: false }
          });
        } catch (_) { /* ignore */ }
        return true;
      }
      case 'detach': {
        // No-op for local PTY (kept for interface parity)
        return true;
      }
      case 'history_loaded': {
        // No-op: local sessions do not load history
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Optional teardown hook for TerminalSession.dispose() to call.
   */
  teardown() {
    // Remove bound subscriptions (either off() functions or DOM listeners)
    for (const [key, ref] of this._boundListeners.entries()) {
      try {
        if (typeof ref === 'function') {
          // off() function returned by preload api
          ref();
        } else if (key && typeof window.removeEventListener === 'function') {
          // legacy path
          window.removeEventListener(key, ref);
        }
      } catch (_) {}
    }
    this._boundListeners.clear();
    this._connected = false;
  }

  // Basic on/off API to satisfy ITerminalTransport shape.
  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(handler);
  }

  off(event, handler) {
    const set = this._handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._handlers.delete(event);
  }

  _emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (_) {}
    }
  }
}

export const localPTYClient = LocalPTYClient;
