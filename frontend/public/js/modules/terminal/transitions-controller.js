/**
 * TransitionsController
 * - Manages the activity transitions dropdown (timeline)
 * - Renders grouped timestamps and prev/next controls
 */

import { dropdownBackdrop } from '../../utils/dropdown-backdrop.js';
import { apiService } from '../../services/api.service.js';

export class TransitionsController {
  constructor(elements, manager, eventBus) {
    this.elements = elements;
    this.manager = manager;
    this.eventBus = eventBus;
    this._unsubs = [];
    this._onDocumentClick = this._onDocumentClick.bind(this);
    this._fetchingCaptureFor = null;
    this._selectedIndex = -1;
  }

  init() {
    const { sessionTransitionsBtn, sessionTransitionsDropdown } = this.elements || {};
    if (sessionTransitionsBtn) {
      const clickHandler = (e) => { e.preventDefault(); e.stopPropagation(); this.toggle(); };
      sessionTransitionsBtn.addEventListener('click', clickHandler);
      this._unsubs.push(() => sessionTransitionsBtn.removeEventListener('click', clickHandler));
      // A11y: link button to dropdown and initialize aria-expanded=false
      try {
        sessionTransitionsBtn.setAttribute('aria-controls', 'session-transitions-dropdown');
        sessionTransitionsBtn.setAttribute('aria-expanded', 'false');
        sessionTransitionsBtn.setAttribute('aria-haspopup', 'menu');
      } catch (_) {}
    }

    document.addEventListener('click', this._onDocumentClick);
    this._unsubs.push(() => document.removeEventListener('click', this._onDocumentClick));

    // Stop propagation within dropdown to avoid terminal clicks
    if (sessionTransitionsDropdown) {
      const stop = (e) => { try { e.stopPropagation(); } catch (_) {} };
      ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchmove', 'keydown'].forEach((t) => {
        sessionTransitionsDropdown.addEventListener(t, stop, false);
      });

      // Keyboard navigation: Escape to close; Up/Down to move; Enter to activate
      const onKeyDown = (e) => {
        const key = e.key;
        if (key === 'Escape') {
          e.preventDefault();
          this.hide();
          return;
        }
        const entries = this._getEntries();
        if (!entries.length) return;
        if (key === 'ArrowDown') {
          e.preventDefault();
          this._moveSelection(1);
        } else if (key === 'ArrowUp') {
          e.preventDefault();
          this._moveSelection(-1);
        } else if (key === 'Enter') {
          e.preventDefault();
          this._activateSelected();
        }
      };
      sessionTransitionsDropdown.addEventListener('keydown', onKeyDown);
      this._unsubs.push(() => sessionTransitionsDropdown.removeEventListener('keydown', onKeyDown));
    }

    // Re-render when terminal is ready (history loaded)
    if (this.eventBus) {
      const onReady = ({ sessionId }) => {
        try {
          if (this.manager?.currentSessionId === sessionId) {
            this.updateVisibilityAndRender();
          }
        } catch (_) {}
      };
      this.eventBus.on('terminal-ready', onReady);
      this._unsubs.push(() => this.eventBus.off('terminal-ready', onReady));

      // Auto-close dropdown if the active session changes while open
      const onSessionChanged = ({ sessionId }) => {
        try {
          const { sessionTransitionsDropdown } = this.elements || {};
          if (!sessionTransitionsDropdown) return;
          if (sessionTransitionsDropdown.classList.contains('show')) {
            this.hide();
          }
        } catch (_) {}
      };
      this.eventBus.on('session-changed', onSessionChanged);
      this._unsubs.push(() => this.eventBus.off('session-changed', onSessionChanged));

      const onUpdated = ({ sessionId }) => {
        try {
          if (this.manager?.currentSessionId === sessionId) {
            this.updateVisibilityAndRender();
          }
        } catch (_) {}
      };
      this.eventBus.on('transitions-updated', onUpdated);
      this._unsubs.push(() => this.eventBus.off('transitions-updated', onUpdated));
    }
  }

  _onDocumentClick(e) {
    const { sessionTransitionsDropdown, sessionTransitionsContainer } = this.elements || {};
    if (sessionTransitionsDropdown && !sessionTransitionsContainer?.contains(e.target)) {
      sessionTransitionsDropdown.classList.remove('show');
    }
  }

  async toggle() {
    const { sessionTransitionsDropdown } = this.elements || {};
    if (!sessionTransitionsDropdown) return;
    if (sessionTransitionsDropdown.classList.contains('show')) {
      this.hide();
    } else {
      await this.updateVisibilityAndRender();
      this.show();
    }
  }

  show() {
    const { sessionTransitionsDropdown, sessionTransitionsBtn } = this.elements || {};
    if (!sessionTransitionsDropdown) return;
    sessionTransitionsDropdown.classList.add('show');
    try { sessionTransitionsBtn?.classList?.add('active'); } catch (_) {}
    try { sessionTransitionsBtn?.setAttribute?.('aria-expanded', 'true'); } catch (_) {}
    if (!this._backdropCloser) this._backdropCloser = () => this.hide();
    dropdownBackdrop.show(this._backdropCloser);
    try {
      this._selectedIndex = this._computeInitialSelectionIndex();
      this._updateSelection();
      sessionTransitionsDropdown.setAttribute('tabindex', '0');
      // Focus the selected item to enable Up/Down/Enter without showing a container outline
      const el = (this._selectedIndex >= 0)
        ? sessionTransitionsDropdown.querySelector(`.transition-item[data-index="${this._selectedIndex}"]`)
        : null;
      if (el && typeof el.focus === 'function') {
        el.focus();
      } else {
        sessionTransitionsDropdown.focus();
      }
    } catch (_) {}
  }

  hide() {
    const { sessionTransitionsDropdown, sessionTransitionsBtn } = this.elements || {};
    if (!sessionTransitionsDropdown) return;
    sessionTransitionsDropdown.classList.remove('show');
    try { sessionTransitionsBtn?.classList?.remove('active'); } catch (_) {}
    try { sessionTransitionsBtn?.setAttribute?.('aria-expanded', 'false'); } catch (_) {}
    if (this._backdropCloser) dropdownBackdrop.hide(this._backdropCloser);
    this._selectedIndex = -1;
  }

  async updateVisibilityAndRender() {
    const { sessionTransitionsContainer } = this.elements || {};
    if (!sessionTransitionsContainer) return;
    try {
      // Check if activity transitions capture is enabled for this session
      const sessionId = this.manager?.currentSessionId;
      let captureEnabled = false;
      if (sessionId) {
        try {
          const sessionData = (typeof this.manager?.getAnySessionData === 'function')
            ? this.manager.getAnySessionData(sessionId)
            : this.manager?.sessionList?.getSessionData?.(sessionId);
          // Also check session.sessionData as fallback
          if (!sessionData && this.manager?.currentSession?.sessionData) {
            captureEnabled = this.manager.currentSession.sessionData.capture_activity_transitions === true;
          } else {
            captureEnabled = sessionData?.capture_activity_transitions === true;
          }
        } catch (_) {
          // Fallback: check currentSession.sessionData directly
          captureEnabled = this.manager?.currentSession?.sessionData?.capture_activity_transitions === true;
        }
      }
      
      // Hide container if capture is not enabled
      if (!captureEnabled) {
        sessionTransitionsContainer.style.display = 'none';
        return;
      }
      
      // Show the container and render timeline
      sessionTransitionsContainer.style.display = 'flex';
      this.renderTimeline();
    } catch (_) {
      sessionTransitionsContainer.style.display = 'none';
    }
  }

  renderTimeline() {
    const { sessionTransitionsDropdown } = this.elements || {};
    if (!sessionTransitionsDropdown) return;
    const session = this.manager?.currentSession;
    const entries = this._getEntries();

    sessionTransitionsDropdown.innerHTML = '';

    // Controls
    const controls = document.createElement('div');
    controls.className = 'transitions-controls';
    const prev = document.createElement('button');
    prev.className = 'btn btn-secondary';
    prev.textContent = 'Prev';
    prev.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = this.manager?.currentSession;
      const ok = s?.jumpToPrevTransition?.();
      if (ok) {
        try { this._selectedIndex = typeof s._markerNavIndex === 'number' ? s._markerNavIndex : this._selectedIndex; } catch(_) {}
        this._updateSelection();
      }
    });
    const next = document.createElement('button');
    next.className = 'btn btn-secondary';
    next.textContent = 'Next';
    next.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = this.manager?.currentSession;
      const ok = s?.jumpToNextTransition?.();
      if (ok) {
        try { this._selectedIndex = typeof s._markerNavIndex === 'number' ? s._markerNavIndex : this._selectedIndex; } catch(_) {}
        this._updateSelection();
      }
    });
    controls.appendChild(prev); controls.appendChild(next);
    sessionTransitionsDropdown.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'transitions-list';

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'transition-item';
      empty.textContent = 'No activity markers';
      list.appendChild(empty);
      sessionTransitionsDropdown.appendChild(list);
      return;
    }

    // Group by day
    const byDay = new Map();
    const todayStr = this._dateKey(new Date());
    for (const e of entries) {
      const dt = new Date(e.t);
      const key = this._dateKey(dt);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    const onlyToday = byDay.size === 1 && byDay.has(todayStr);

    // Render groups preserving chronological order
    const keys = Array.from(byDay.keys()).sort((a, b) => (new Date(a)) - (new Date(b)));
    for (const key of keys) {
      const group = byDay.get(key) || [];
      // Always include header, even if only today
      const header = document.createElement('div');
      header.className = 'date-header';
      header.textContent = this._formatDateHeader(new Date(key));
      list.appendChild(header);
      group.sort((a, b) => a.t - b.t);
      for (const e of group) {
        const item = document.createElement('div');
        item.className = 'transition-item';
        if (e._ordinal !== undefined) item.setAttribute('data-ordinal', String(e._ordinal));
        if (e._index !== undefined) item.setAttribute('data-index', String(e._index));
        item.setAttribute('tabindex', '0');
        item.textContent = onlyToday ? this._formatTime(new Date(e.t)) : this._formatTime(new Date(e.t));
        item.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); this._jumpToEntry(e); });
        item.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); this._jumpToEntry(e); } });
        list.appendChild(item);
      }
    }

    sessionTransitionsDropdown.appendChild(list);
  }

  _computeInitialSelectionIndex() {
    try {
      const session = this.manager?.currentSession;
      const markers = Array.isArray(session?.activityMarkers) ? session.activityMarkers : [];
      if (!markers.length) return -1;
      // Pick the closest marker to current viewport top
      const term = session?.terminal;
      const vpTop = (term && term.buffer && term.buffer.active && typeof term.buffer.active.viewportY === 'number')
        ? term.buffer.active.viewportY
        : 0;
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < markers.length; i++) {
        const line = (markers[i]?.marker && typeof markers[i].marker.line === 'number') ? markers[i].marker.line : 0;
        const d = Math.abs(line - vpTop);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    } catch (_) {
      return -1;
    }
  }

  _getEntries() {
    const session = this.manager?.currentSession;
    // Derive from client-tracked markers list
    const markers = session?.getClientMarkers?.() || [];
    if (!markers.length) return [];
    return markers.map((m, i) => ({ t: Number(m.t) || Date.now(), _clientIndex: i }));
  }

  // Build a reduced list of indices by merging markers that map to the same
  // visible location. Preference order for identity: marker.line, then meta.raw,
  // else timestamp (coarse). The parameters allow tuning coalescing sensitivity.
  _coalesceMarkerIndices(session, opts = {}) {
    const markers = Array.isArray(session?.activityMarkers) ? session.activityMarkers : [];
    const minLineDelta = Number.isFinite(Number(opts.minLineDelta)) ? Math.max(0, Math.floor(opts.minLineDelta)) : 1;
    const minRawDelta = Number.isFinite(Number(opts.minRawDelta)) ? Math.max(0, Math.floor(opts.minRawDelta)) : 256;
    const kept = [];
    let lastLine = null;
    let lastRaw = null;
    let lastT = null;
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      const line = (m?.marker && typeof m.marker.line === 'number') ? m.marker.line : null;
      const raw = (m?.meta && Number.isFinite(Number(m.meta.raw))) ? Math.floor(Number(m.meta.raw)) : null;
      const t = (m?.meta && Number.isFinite(Number(m.meta.t))) ? Math.floor(Number(m.meta.t)) : null;
      let keep = true;
      if (line != null && lastLine != null) {
        if (Math.abs(line - lastLine) <= minLineDelta) keep = false;
      } else if (raw != null && lastRaw != null) {
        if (Math.abs(raw - lastRaw) <= minRawDelta) keep = false;
      } else if (t != null && lastT != null) {
        // Coarse time coalescing (~5s) when no other signals are present
        if (Math.abs(t - lastT) <= 5000) keep = false;
      }
      if (keep) {
        kept.push(i);
        if (line != null) lastLine = line;
        if (raw != null) lastRaw = raw;
        if (t != null) lastT = t;
      }
    }
    return kept;
  }

  // Coalesce using a predefined index list (e.g., filtered by kind)
  _coalesceMarkerIndicesFromList(session, indices, opts = {}) {
    const markers = Array.isArray(session?.activityMarkers) ? session.activityMarkers : [];
    const minLineDelta = Number.isFinite(Number(opts.minLineDelta)) ? Math.max(0, Math.floor(opts.minLineDelta)) : 1;
    const minRawDelta = Number.isFinite(Number(opts.minRawDelta)) ? Math.max(0, Math.floor(opts.minRawDelta)) : 256;
    const kept = [];
    let lastLine = null;
    let lastRaw = null;
    let lastT = null;
    for (const i of indices) {
      const m = markers[i];
      const line = (m?.marker && typeof m.marker.line === 'number') ? m.marker.line : null;
      const raw = (m?.meta && Number.isFinite(Number(m.meta.raw))) ? Math.floor(Number(m.meta.raw)) : null;
      const t = (m?.meta && Number.isFinite(Number(m.meta.t))) ? Math.floor(Number(m.meta.t)) : null;
      let keep = true;
      if (line != null && lastLine != null) {
        if (Math.abs(line - lastLine) <= minLineDelta) keep = false;
      } else if (raw != null && lastRaw != null) {
        if (Math.abs(raw - lastRaw) <= minRawDelta) keep = false;
      } else if (t != null && lastT != null) {
        if (Math.abs(t - lastT) <= 5000) keep = false;
      }
      if (keep) {
        kept.push(i);
        if (line != null) lastLine = line;
        if (raw != null) lastRaw = raw;
        if (t != null) lastT = t;
      }
    }
    return kept;
  }

  _moveSelection(delta) {
    const entries = this._getEntries();
    if (!entries.length) return;
    const len = entries.length;
    this._selectedIndex = (this._selectedIndex + delta + len) % len;
    this._updateSelection();
    // Seek immediately on selection change, but keep dropdown open
    try {
      const s = this.manager?.currentSession;
      if (s && typeof s.seekToClientMarker === 'function') s.seekToClientMarker(this._selectedIndex);
    } catch (_) {}
  }

  _updateSelection() {
    const { sessionTransitionsDropdown } = this.elements || {};
    if (!sessionTransitionsDropdown) return;
    const items = sessionTransitionsDropdown.querySelectorAll('.transition-item[data-index]');
    items.forEach((el) => el.classList.remove('selected'));
    if (this._selectedIndex >= 0) {
      const el = sessionTransitionsDropdown.querySelector(`.transition-item[data-index="${this._selectedIndex}"]`);
      if (el) {
        el.classList.add('selected');
        try { el.scrollIntoView({ block: 'nearest' }); } catch (_) {}
      }
    }
  }

  _activateSelected() {
    if (this._selectedIndex < 0) return;
    this._jumpToIndex(this._selectedIndex);
  }

  _jumpToIndex(index) {
    try {
      const session = this.manager?.currentSession;
      if (!session || !Array.isArray(session.activityMarkers) || !session.activityMarkers.length) return;
      const targetIdx = this._resolveSeekIndex(session, index);
      this._seekToIndex(targetIdx);
      this.hide();
    } catch (_) { /* ignore */ }
  }

  _jumpToEntry(entry) {
    try {
      const session = this.manager?.currentSession;
      if (!session) return;
      if (entry && entry._clientIndex !== undefined && typeof session.seekToClientMarker === 'function') {
        session.seekToClientMarker(Number(entry._clientIndex));
        this.hide();
        return;
      }
    } catch (_) { /* ignore */ }
  }

  _seekToIndex(index) {
    const session = this.manager?.currentSession;
    if (!session || !Array.isArray(session.activityMarkers) || session.activityMarkers.length === 0) return;
    const entry = session.activityMarkers[index];
    const marker = entry?.marker;
    const line = (marker && typeof marker.line === 'number') ? marker.line : -1;
    if (line >= 0) {
      try { session.terminal?.scrollToLine?.(line); } catch (_) {}
      try { session._markerNavIndex = index; } catch (_) {}
      return;
    }
    // Fallbacks: find nearest valid marker; else approximate by index
    const nearest = this._findNearestValidIndex(session, index);
    if (nearest !== -1) {
      try {
        const mk = session.activityMarkers[nearest]?.marker;
        if (mk && typeof mk.line === 'number' && mk.line >= 0) {
          session.terminal?.scrollToLine?.(mk.line);
          session._markerNavIndex = nearest;
          return;
        }
      } catch (_) { /* ignore */ }
    }
    // Approximate seek by index ratio within buffer if no valid markers are available
    try {
      const term = session.terminal;
      const buf = term?.buffer?.active;
      const total = Array.isArray(session.activityMarkers) ? session.activityMarkers.length : 1;
      if (term && buf && total > 0) {
        const ratio = Math.min(1, Math.max(0, index / (total - 1)));
        const lastLine = (typeof buf.length === 'number') ? buf.length - 1 : 0;
        const target = Math.floor(ratio * lastLine);
        term.scrollToLine(target);
        session._markerNavIndex = index;
      }
    } catch (_) { /* ignore */ }

    // Ultimate fallback for TUIs: replay up to this marker if supported
    try {
      if (typeof session.isReplaySeekEnabled === 'function' && session.isReplaySeekEnabled()) {
        session.seekToMarkerByReplay(index);
      }
    } catch (_) { /* ignore */ }
  }

  // Resolve a requested index to the best available index to seek to
  _resolveSeekIndex(session, index) {
    if (!session || !Array.isArray(session.activityMarkers) || session.activityMarkers.length === 0) return -1;
    const clamped = Math.max(0, Math.min(index, session.activityMarkers.length - 1));
    const marker = session.activityMarkers[clamped]?.marker;
    const line = (marker && typeof marker.line === 'number') ? marker.line : -1;
    if (line >= 0) return clamped;
    const nearest = this._findNearestValidIndex(session, clamped);
    return nearest !== -1 ? nearest : clamped;
  }

  // Find nearest index (forward, then backward) that has a valid marker line
  _findNearestValidIndex(session, startIdx) {
    const markers = Array.isArray(session?.activityMarkers) ? session.activityMarkers : [];
    const n = markers.length;
    if (n === 0) return -1;
    // forward search
    for (let i = startIdx; i < n; i++) {
      const m = markers[i]?.marker;
      if (m && typeof m.line === 'number' && m.line >= 0) return i;
    }
    // backward search
    for (let i = startIdx - 1; i >= 0; i--) {
      const m = markers[i]?.marker;
      if (m && typeof m.line === 'number' && m.line >= 0) return i;
    }
    return -1;
  }

  _dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  _formatDateHeader(d) {
    // Show date only (MM/DD/YYYY), no day-of-week
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${m}/${day}/${y}`;
  }

  _formatTime(d) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }


  _jumpToEntry(entry) {
    try {
      const session = this.manager?.currentSession;
      if (!session) return;
      if (entry && entry._clientIndex !== undefined && typeof session.seekToClientMarker === 'function') {
        session.seekToClientMarker(Number(entry._clientIndex));
        this.hide();
        return;
      }
    } catch (_) { /* ignore */ }
  }

  destroy() {
    try { this._unsubs.forEach((fn) => fn()); } finally { this._unsubs = []; }
    if (this._backdropCloser) dropdownBackdrop.hide(this._backdropCloser);
  }
}
