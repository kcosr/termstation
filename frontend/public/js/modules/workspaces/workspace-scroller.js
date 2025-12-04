/**
 * Mobile Workspace Scroller
 * Renders a horizontally scrolling list of workspaces in the mobile header.
 * Syncs order and filters with the sidebar via shared appStore state.
 */

import { appStore } from '../../core/store.js';
import { getContext } from '../../core/context.js';
import { SessionFilterService } from '../terminal/session-filter-service.js';

export class WorkspaceScroller {
  /**
   * @param {HTMLElement} toolbarEl - The container element (typically #session-info-toolbar)
   * @param {Object} terminalManager - Reference to TerminalManager for workspace navigation
   */
  constructor(toolbarEl, terminalManager) {
    this.toolbarEl = toolbarEl;
    this.terminalManager = terminalManager;
    this.store = appStore;
    this.unsubscribeWorkspaces = null;
    this.unsubscribeSessions = null;

    // Root container we manage inside the toolbar
    this.container = null;
    // Add (+) button element reference
    this.addButton = null;
  }

  init() {
    if (!this.toolbarEl) return;

    // Create or reuse container
    this.container = this.toolbarEl.querySelector('#workspace-scroller');
    if (!this.container) {
      // Hide old session title content if present
      const oldContent = this.toolbarEl.querySelector('.session-info-content');
      if (oldContent) oldContent.style.display = 'none';

      this.container = document.createElement('div');
      this.container.id = 'workspace-scroller';
      this.container.className = 'workspace-scroller';
      this.toolbarEl.appendChild(this.container);
    }

    // Subscribe to relevant store slices
    this.unsubscribeWorkspaces = this.store.subscribe('workspaces', () => this.render());
    this.unsubscribeSessions = this.store.subscribe('sessionList.sessions', () => this.render());

    // Initial render
    this.render();
  }

  destroy() {
    try { this.unsubscribeWorkspaces && this.unsubscribeWorkspaces(); } catch (_) {}
    try { this.unsubscribeSessions && this.unsubscribeSessions(); } catch (_) {}
    this.unsubscribeWorkspaces = null;
    this.unsubscribeSessions = null;
  }

  getVisibleWorkspaceNames() {
    const wsState = this.store.getState().workspaces || {};
    const itemsSet = wsState.items || new Set();
    const pinnedSet = wsState.pinned || new Set();
    const filterPinned = !!wsState.filterPinned;
    const filterActive = wsState.filterActive !== false; // default true
    const order = Array.isArray(wsState.order) && wsState.order.length > 0
      ? wsState.order.filter(n => !filterPinned || pinnedSet.has(n))
      : Array.from(itemsSet);

    // Pull sessions and apply the same template/search filters as sidebar
    const sessionsMap = this.store.getState().sessionList?.sessions || new Map();
    const sessionArray = sessionsMap instanceof Map ? Array.from(sessionsMap.values()) : [];

    let filteredSessionArray = sessionArray;
    try {
      const sl = this.store.getState().sessionList || {};
      const filters = sl.filters || {};
      const pinnedSessions = filters.pinnedSessions || new Set();
      filteredSessionArray = SessionFilterService.filter(sessionArray, {
        status: 'all',
        search: '',
        template: filters.template || 'all',
        pinned: false,
        pinnedSessions,
        workspace: null
      });
      this._templateFilterActive = !!(filters && filters.template && filters.template !== 'all' && ((filters.template instanceof Set && filters.template.size > 0) || (Array.isArray(filters.template) && filters.template.length > 0) || (typeof filters.template === 'string' && filters.template.trim() !== '')));
      // Determine if a search is active
      try {
        const tm = getContext()?.app?.modules?.terminal;
        if (tm && typeof tm.searchQuery === 'string') {
          this._searchActive = tm.searchQuery.trim().length > 0;
        } else {
          const input = document.getElementById('session-search');
          this._searchActive = !!(input && input.value && input.value.trim().length > 0);
        }
      } catch (_) { this._searchActive = false; }
    } catch (_) {}

    const requireActive = filterActive || this._templateFilterActive || this._searchActive;

    // Compute which workspaces should be shown
    const visible = [];
    order.forEach((name) => {
      if ((itemsSet && !itemsSet.has(name))) return;
      if (filterPinned && !pinnedSet.has(name)) return;

      if (requireActive) {
        const hasActive = filteredSessionArray.some(s => (s.workspace || 'Default') === name && s.is_active);
        if (!hasActive) return;
      }
      visible.push(name);
    });

    return visible;
  }

  render() {
    if (!this.container) return;

    const current = this.store.getState().workspaces?.current || null;
    const names = this.getVisibleWorkspaceNames();

    // Clear scroll row but preserve + button if it exists
    let row = this.container.querySelector('.workspace-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'workspace-row';
      this.container.appendChild(row);
    }
    row.innerHTML = '';

    // Add click handler to workspace-row to clear selection when clicking empty area
    if (!row.hasAttribute('data-click-handler-attached')) {
      row.setAttribute('data-click-handler-attached', 'true');
      row.addEventListener('click', (e) => {
        // Only clear if clicking directly on the row, not on a button
        if (e.target === row) {
          try {
            if (this.terminalManager?.showWorkspaceList) {
              this.terminalManager.showWorkspaceList();
            }
          } catch (_) {}
        }
      });
    }

    names.forEach((name) => {
      const btn = document.createElement('button');
      btn.className = 'workspace-route' + (current === name ? ' active' : '');
      btn.textContent = name;
      btn.title = `Show workspace: ${name}`;
      btn.addEventListener('click', () => {
        try {
          if (this.terminalManager?.enterWorkspace) {
            this.terminalManager.enterWorkspace(name);
          }
        } catch (_) {}
      });
      row.appendChild(btn);
    });

    // Ensure + button exists and sits outside the scroll area
    this.ensureAddButton();

    // Auto-scroll active into view on render within the scroll row
    try {
      const activeEl = this.container.querySelector('.workspace-route.active');
      if (activeEl && typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    } catch (_) {}
  }

  ensureAddButton() {
    if (!this.container) return;
    // Remove stale button if detached
    if (this.addButton && !this.addButton.isConnected) this.addButton = null;

    if (!this.addButton) {
      const btn = document.createElement('button');
      btn.className = 'workspace-add-btn';
      btn.title = 'Create workspace';
      btn.setAttribute('aria-label', 'Create workspace');
      btn.textContent = '+';
      btn.addEventListener('click', () => {
        try {
          // Reset and show the existing New Workspace modal from TerminalManager
          const modal = this.terminalManager?.newWorkspaceModal;
          if (modal) {
            try { modal.setFieldValue?.('new-workspace-name', ''); } catch (_) {}
            try {
              const err = document.getElementById('new-workspace-error');
              if (err) { err.textContent = ''; err.style.display = 'none'; }
            } catch (_) {}
            modal.show();
          }
        } catch (_) {}
      });
      this.container.appendChild(btn);
      this.addButton = btn;
    }
  }
}
