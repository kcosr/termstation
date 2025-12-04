import { computeDefaultStatusText, formatRelativeTime } from './note-status.js';

/**
 * Shared model to encapsulate optimistic note state, debounced saving, and
 * status transitions for session/workspace notes.
 */
export class NotesModel {
  constructor(options = {}) {
    const {
      id = 'note',
      debounceMs = 800,
      saveFn = null,
      loadFn = null,
      onConflict = null,
      computeStatusText = computeDefaultStatusText,
      relativeTimeFormatter = formatRelativeTime,
      getCurrentUser = null,
      now = () => Date.now(),
      setTimer = (fn, ms) => setTimeout(fn, ms),
      clearTimer = (handle) => clearTimeout(handle),
      initialState = {}
    } = options;

    this.id = id;
    this.debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 800;
    this.saveFn = typeof saveFn === 'function' ? saveFn : null;
    this.loadFn = typeof loadFn === 'function' ? loadFn : null;
    this.onConflict = typeof onConflict === 'function' ? onConflict : null;
    this.computeStatusText = typeof computeStatusText === 'function' ? computeStatusText : computeDefaultStatusText;
    this.relativeTimeFormatter = typeof relativeTimeFormatter === 'function' ? relativeTimeFormatter : formatRelativeTime;
    this.getCurrentUser = typeof getCurrentUser === 'function' ? getCurrentUser : null;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this._setTimer = typeof setTimer === 'function' ? setTimer : ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = typeof clearTimer === 'function' ? clearTimer : ((handle) => clearTimeout(handle));

    this._listeners = new Map();
    this._listeners.set('change', new Set());
    this._listeners.set('status', new Set());

    const baseState = {
      content: '',
      lastSavedContent: '',
      version: 0,
      updatedAt: null,
      updatedBy: null,
      pendingRemote: null,
      pendingSave: null,
      lastSyncSignature: null,
      viewMode: 'plain',
      splitOrientation: 'horizontal'
    };
    this.state = { ...baseState, ...initialState };

    this.status = {
      state: 'idle',
      message: this.computeStatusText(this.state, this.relativeTimeFormatter, this.getCurrentUser?.()),
      showLoadButton: false
    };

    this._saveTimer = null;
    this._statusTimer = null;
    this._savePromise = null;
  }

  on(eventName, handler) {
    if (!this._listeners.has(eventName) || typeof handler !== 'function') {
      return () => {};
    }
    const handlers = this._listeners.get(eventName);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  emit(eventName, payload) {
    const handlers = this._listeners.get(eventName);
    if (!handlers) return;
    handlers.forEach((handler) => {
      try {
        handler(payload);
      } catch (error) {
        console.warn(`[NotesModel:${this.id}] listener error`, error);
      }
    });
  }

  getState() {
    return this.state;
  }

  getStatus() {
    return this.status;
  }

  updateState(patch = {}) {
    if (patch && typeof patch === 'object') {
      Object.assign(this.state, patch);
      this.emit('change', this.state);
    }
  }

  cancelScheduledSave() {
    if (this._saveTimer) {
      this._clearTimer(this._saveTimer);
      this._saveTimer = null;
    }
  }

  scheduleSave(options = {}) {
    if (!this.saveFn) return;
    if (this.state.pendingRemote) return;
    const { content, lastSavedContent } = this.state;
    if (content === lastSavedContent && !options.force) {
      this.cancelScheduledSave();
      return;
    }
    this.cancelScheduledSave();
    this._saveTimer = this._setTimer(() => {
      this._saveTimer = null;
      this.saveNow(options);
    }, this.debounceMs);
  }

  setContent(content, options = {}) {
    const next = typeof content === 'string' ? content : '';
    if (this.state.content !== next) {
      this.state.content = next;
      this.emit('change', this.state);
    }

    if (this.state.pendingRemote) {
      this.setStatus('warning', options.pendingRemoteMessage || 'Remote changes detected. Load latest to continue editing.', { showLoadButton: true });
      return;
    }

    if (this.state.content !== this.state.lastSavedContent) {
      this.setStatus('editing', options.editingMessage || 'Unsaved changes');
    } else {
      this.setStatus();
    }

    if (options.scheduleSave !== false) {
      this.scheduleSave(options);
    }
  }

  async saveNow(options = {}) {
    if (!this.saveFn) return null;
    if (this.state.pendingRemote && !options.ignorePendingRemote) {
      this.setStatus('warning', options.pendingRemoteMessage || 'Remote changes detected. Load latest to continue editing.', { showLoadButton: true });
      return null;
    }

    if (this._savePromise) {
      return this._savePromise;
    }

    const { content, lastSavedContent } = this.state;
    if (!options.force && content === lastSavedContent) {
      this.setStatus();
      return null;
    }

    const versionToSend = Number.isInteger(this.state.version) ? this.state.version : 0;
    const currentUser = options.currentUser ?? (this.getCurrentUser ? this.getCurrentUser() : '');
    const pendingSave = {
      content,
      versionSent: versionToSend,
      user: typeof currentUser === 'string' ? currentUser : '',
      timestamp: this.now()
    };
    this.state.pendingSave = pendingSave;
    this.setStatus('saving', options.savingMessage || 'Saving…');

    const doSave = async () => {
      const response = await this.saveFn({ content, version: versionToSend });
      const snapshot = this._normalizeSnapshot(response, { content, version: versionToSend });
      this._applySuccessfulSave(snapshot, pendingSave, options);
      return snapshot;
    };

    const handleError = async (error) => {
      if (this._isConflictError(error)) {
        const snapshot = this._extractConflictSnapshot(error);
        this.state.pendingSave = null;
        this.handleConflict(snapshot, error, options);
        return null;
      }

      this.state.pendingSave = null;
      this.setStatus('error', options.saveErrorMessage || 'Failed to save note. Will retry automatically.');
      throw error;
    };

    const savePromise = doSave().catch(handleError);
    this._savePromise = savePromise;

    return savePromise.finally(() => {
      if (this._savePromise === savePromise) {
        this._savePromise = null;
      }
    });
  }

  async loadLatest(options = {}) {
    if (!this.loadFn) return null;
    const snapshot = await this.loadFn();
    const normalized = this._normalizeSnapshot(snapshot);
    const statePatch = {
      version: normalized.version,
      updatedAt: normalized.updatedAt,
      updatedBy: normalized.updatedBy,
      pendingRemote: null,
      pendingSave: null,
      lastSavedContent: normalized.content,
      lastSyncSignature: {
        version: normalized.version,
        updatedAt: normalized.updatedAt,
        updatedBy: normalized.updatedBy
      }
    };
    if (!options.preserveDirtyContent || this.state.content === this.state.lastSavedContent) {
      statePatch.content = normalized.content;
    }
    this.updateState(statePatch);
    this.setStatus(options.statusState || 'success', options.statusMessage || 'Loaded latest changes', { delay: options.statusDelay ?? 1500 });
    return normalized;
  }

  applyPendingRemote(options = {}) {
    const pending = this.state.pendingRemote;
    if (!pending) return null;
    const normalized = this._normalizeSnapshot(pending);
    const patch = {
      pendingRemote: null,
      pendingSave: null,
      lastSavedContent: normalized.content,
      version: normalized.version,
      updatedAt: normalized.updatedAt,
      updatedBy: normalized.updatedBy,
      lastSyncSignature: {
        version: normalized.version,
        updatedAt: normalized.updatedAt,
        updatedBy: normalized.updatedBy
      }
    };
    if (!options.preserveDirtyContent || this.state.content === this.state.lastSavedContent) {
      patch.content = normalized.content;
    }
    this.updateState(patch);
    if (options.statusState !== false) {
      const statusState = options.statusState || 'success';
      const statusMessage = options.statusMessage || 'Loaded latest changes';
      this.setStatus(statusState, statusMessage, { delay: options.statusDelay ?? 2000 });
    } else {
      this.setStatus();
    }
    return normalized;
  }

  markPendingRemote(snapshot, options = {}) {
    const normalized = this._normalizeSnapshot(snapshot);
    this.state.pendingRemote = normalized;
    this.state.pendingSave = null;
    const message = options.message || 'Remote changes detected. Load latest to continue editing.';
    const stateName = options.state || 'warning';
    this.setStatus(stateName, message, { showLoadButton: options.showLoadButton !== false });
    this.emit('change', this.state);
    return normalized;
  }

  handleConflict(snapshot, error, options = {}) {
    if (this.onConflict) {
      try {
        const handled = this.onConflict(snapshot, error, this);
        if (handled) {
          return;
        }
      } catch (err) {
        console.warn('[NotesModel] onConflict handler threw error', err);
      }
    }
    this.markPendingRemote(snapshot, {
      message: options.conflictMessage || 'Remote changes detected. Load latest to continue editing.',
      state: 'error',
      showLoadButton: true
    });
  }

  setStatus(stateName = 'idle', message, options = {}) {
    if (this._statusTimer) {
      this._clearTimer(this._statusTimer);
      this._statusTimer = null;
    }

    const showLoadButton = options.showLoadButton === true;
    const resolvedMessage = message && message.trim().length > 0
      ? message
      : this.computeStatusText(this.state, this.relativeTimeFormatter, this.getCurrentUser?.());

    this.status = {
      state: stateName,
      message: resolvedMessage,
      showLoadButton
    };
    this.emit('status', this.status);

    const delay = options.delay;
    if (Number.isFinite(delay) && delay > 0) {
      this._statusTimer = this._setTimer(() => {
        this._statusTimer = null;
        this.setStatus();
      }, delay);
    }
  }

  destroy() {
    this.cancelScheduledSave();
    if (this._statusTimer) {
      this._clearTimer(this._statusTimer);
      this._statusTimer = null;
    }
    this._listeners.forEach((handlers) => handlers.clear());
  }

  _applySuccessfulSave(snapshot, pendingSave, options = {}) {
    const normalized = this._normalizeSnapshot(snapshot, {
      content: pendingSave?.content ?? '',
      version: pendingSave?.versionSent ?? 0
    });
    const shouldOverrideContent = options.preserveDirtyContent
      ? (this.state.content === pendingSave?.content)
      : true;

    const patch = {
      pendingRemote: null,
      pendingSave: null,
      lastSavedContent: normalized.content,
      version: normalized.version,
      updatedAt: normalized.updatedAt,
      updatedBy: normalized.updatedBy,
      lastSyncSignature: {
        version: normalized.version,
        updatedAt: normalized.updatedAt,
        updatedBy: normalized.updatedBy ?? pendingSave?.user ?? null
      }
    };
    if (shouldOverrideContent) {
      patch.content = normalized.content;
    }
    this.updateState(patch);
    this.setStatus(options.savedState || 'success', options.savedMessage || 'Saved', { delay: options.successDelay ?? 2000 });
  }

  _normalizeSnapshot(snapshot, fallback = {}) {
    const content = typeof snapshot?.content === 'string'
      ? snapshot.content
      : (typeof fallback.content === 'string' ? fallback.content : '');
    const version = Number.isInteger(snapshot?.version)
      ? snapshot.version
      : (Number.isInteger(fallback.version) ? fallback.version : 0);
    const updatedAt = snapshot?.updated_at || snapshot?.updatedAt || fallback.updatedAt || null;
    const updatedBy = snapshot?.updated_by || snapshot?.updatedBy || fallback.updatedBy || null;
    return {
      content,
      version,
      updatedAt,
      updatedBy
    };
  }

  _isConflictError(error) {
    if (!error) return false;
    if (error.status === 409) return true;
    return error?.code === 'CONFLICT';
  }

  _extractConflictSnapshot(error) {
    return error?.context?.note || error?.note || null;
  }
}

export default NotesModel;
