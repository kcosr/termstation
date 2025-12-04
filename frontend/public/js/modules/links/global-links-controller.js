/**
 * GlobalLinksController
 * Renders a header-level links dropdown from backend-provided groups
 */

import { delegate } from '../../utils/delegate.js';
import { apiService } from '../../services/api.service.js';
import { isAnyModalOpen } from '../ui/modal.js';
import { appStore } from '../../core/store.js';
import { dropdownBackdrop } from '../../utils/dropdown-backdrop.js';
import { getContext } from '../../core/context.js';

export class GlobalLinksController {
  constructor() {
    this.elements = {
      container: document.getElementById('global-links-container'),
      button: document.getElementById('global-links-btn'),
      dropdown: document.getElementById('global-links-dropdown'),
      searchInput: null
    };
    this._unsubs = [];
    this._isOpen = false;
    this._isMac = false;
    this._groupsMeta = [];
    this._focusReturnFn = null;
    this._searchGroupRevealOverride = null;
    try {
      const ua = navigator.userAgent || '';
      this._isMac = /Mac OS X/i.test(ua) || document.documentElement.classList.contains('platform-mac');
    } catch (_) { this._isMac = false; }
  }

  async init() {
    const { button, dropdown, container } = this.elements;
    if (!button || !dropdown || !container) return;

    // Toggle handler
    const onBtnClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._isOpen ? this.close() : this.open();
    };
    button.addEventListener('click', onBtnClick);
    this._unsubs.push(() => button.removeEventListener('click', onBtnClick));

    // Ensure ARIA baseline
    try {
      button.setAttribute('aria-haspopup', 'true');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-controls', 'global-links-dropdown');
      if (!dropdown.getAttribute('role')) dropdown.setAttribute('role', 'menu');
    } catch (_) {}

    // Hide on outside click
    const onDocClick = (e) => {
      if (!container.contains(e.target)) this.close();
    };
    document.addEventListener('click', onDocClick);
    this._unsubs.push(() => document.removeEventListener('click', onDocClick));

    // Prevent clicks/touches within the dropdown from bubbling to the terminal (mobile safety)
    const stopProp = (e) => { try { e.stopPropagation(); } catch (_) {} };
    ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchmove'].forEach((type) => {
      dropdown.addEventListener(type, stopProp, false);
    });

    // Delegate link clicks
    const off = delegate(dropdown, '.dropdown-item', 'click', (e, item) => {
      e.preventDefault();
      this.close();
      const url = item.dataset.url || item.getAttribute('href');
      if (!url) return;
      try {
        if (window.desktop && window.desktop.isElectron && typeof window.desktop.openExternal === 'function') {
          window.desktop.openExternal(url);
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      } catch (_) {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) {}
      }
    });
    this._unsubs.push(off);

    // Keyboard: global shortcut and menu navigation
    const onKeyDown = (e) => {
      // Suppress global link shortcuts/menu navigation while a blocking modal is open
      // unless the dropdown itself is already open
      try {
        const dropdownOpen = this._isOpen === true;
        if (!dropdownOpen && isAnyModalOpen()) return;
      } catch (_) {}
      const key = (e.key || '').toLowerCase();
      // Open shortcut: Command+Shift+L (mac) or Alt+Shift+L (others)
      const isOpenCombo = key === 'l' && e.shiftKey && ((this._isMac && e.metaKey) || (!this._isMac && e.altKey));
      const isNoteEditorTarget = this._isNoteEditor(e?.target);
      if (isOpenCombo && (!this._isTypingTarget(e) || isNoteEditorTarget)) {
        e.preventDefault();
        e.stopPropagation();
        // Toggle: if already open, close; otherwise open
        if (this._isOpen) {
          this.close();
        } else {
          this.open();
        }
        return;
      }

      if (!this._isOpen) return;

      // Close on Tab/Shift+Tab and allow natural focus movement
      if (key === 'tab') {
        this.close();
        return; // do not prevent default
      }

      // Navigation within open menu
      if (key === 'escape') {
        e.preventDefault();
        this.close();
        return;
      }
      if (key === 'arrowdown') {
        e.preventDefault();
        this._moveFocus(1);
        return;
      }
      if (key === 'arrowup') {
        e.preventDefault();
        this._moveFocus(-1);
        return;
      }
      if (key === 'enter') {
        const current = this._currentItem();
        if (current) {
          // Prevent Enter from propagating to global handlers (e.g., "+ Session")
          e.preventDefault();
          e.stopPropagation();
          try { e.stopImmediatePropagation?.(); } catch (_) {}
          current.click();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    this._unsubs.push(() => document.removeEventListener('keydown', onKeyDown));

      // Load links
      await this.loadAndRender();
  }

  async loadAndRender() {
    try {
      const { dropdown, container } = this.elements;
      const data = await apiService.getLinks();
      const groups = Array.isArray(data?.groups) ? data.groups : [];
      dropdown.innerHTML = '';
      if (groups.length === 0) {
        container.style.display = 'none';
        return;
      }
      container.style.display = '';

      // Add search input at the top of the dropdown
      const search = document.createElement('input');
      search.type = 'text';
      search.className = 'dropdown-search searchable-dropdown-search';
      search.setAttribute('placeholder', 'Search links...');
      search.setAttribute('aria-label', 'Search links');
      dropdown.appendChild(search);
      this.elements.searchInput = search;

      // Build grouped menu with metadata for filtering
      this._groupsMeta = [];
      groups.forEach((g, gi) => {
        const title = typeof g?.name === 'string' && g.name.trim() ? g.name.trim() : null;
        const links = Array.isArray(g?.links) ? g.links : [];
        let header = null;
        const items = [];

        if (title) {
          header = document.createElement('div');
          header.className = 'dropdown-header';
          header.textContent = title;
          header.dataset.group = String(gi);
          dropdown.appendChild(header);
        }

        links.forEach((l) => {
          if (!l || !l.url) return;
          const a = document.createElement('a');
          a.className = 'dropdown-item';
          a.href = '#';
          a.textContent = l.name || l.url;
          a.setAttribute('data-url', l.url);
          a.setAttribute('role', 'menuitem');
          a.setAttribute('tabindex', '-1');
          a.dataset.group = String(gi);
          dropdown.appendChild(a);
          items.push(a);
        });

        let divider = null;
        if (gi < groups.length - 1) {
          divider = document.createElement('div');
          divider.className = 'dropdown-divider';
          divider.dataset.group = String(gi);
          dropdown.appendChild(divider);
        }

        this._groupsMeta.push({ header, divider, items, title: title ? title.toLowerCase() : '' });
      });

      // Filtering logic
      const onSearchInput = () => {
        // Any user input resets one-time group reveal override
        this._searchGroupRevealOverride = null;
        this.filterLinks();
      };
      search.addEventListener('input', onSearchInput);
      // Arrow down from search should focus first visible item and keep navigation working
      const onSearchKeyDown = (e) => {
        const key = (e.key || '').toLowerCase();
        if (key === 'arrowdown') {
          e.preventDefault();
          e.stopPropagation();
          this._focusFirstVisibleItem();
        } else if (key === 'enter') {
          // If there is exactly one visible link, open it directly
          try {
            const items = this._visibleItems();
            const count = Array.isArray(items) ? items.length : 0;
            if (count === 1) {
              e.preventDefault();
              e.stopPropagation();
              try { e.stopImmediatePropagation?.(); } catch (_) {}
              items[0].click();
              return;
            }

            // Toggle group reveal when preference allows and multiple results are visible
            const linksPrefs = appStore.getState('preferences.links') || {};
            const prefAllowGroupReveal = linksPrefs.searchRevealGroupLinks !== false;
            const queryNow = (this.elements.searchInput?.value || '').trim();
            if (prefAllowGroupReveal && queryNow.length > 0 && count > 1) {
              if (this._searchGroupRevealOverride === false) {
                // Currently in direct-only mode: toggle back to include
                e.preventDefault();
                e.stopPropagation();
                this._searchGroupRevealOverride = true;
                this.filterLinks();
                this._focusSearchInput();
                return;
              } else {
                // Currently including group matches (or default): only toggle to direct-only
                // if there will be at least one direct-only match
                const directCount = this._computeVisibleCount(queryNow, false);
                if (directCount >= 1 && directCount < count) {
                  e.preventDefault();
                  e.stopPropagation();
                  this._searchGroupRevealOverride = false; // exclude group matches
                  this.filterLinks();
                  this._focusSearchInput();
                  return;
                }
                // Otherwise, do not toggle
              }
            }
          } catch (_) {}
        } else if (key === 'escape') {
          e.preventDefault();
          e.stopPropagation();
          const input = this.elements.searchInput;
          const hasText = !!(input && input.value && input.value.trim().length > 0);
          if (hasText) {
            try { input.value = ''; } catch (_) {}
            // Reset one-time override and re-filter to default preference mode
            this._searchGroupRevealOverride = null;
            this.filterLinks('');
            this._focusSearchInput();
            return;
          }
          this.close();
        }
      };
      search.addEventListener('keydown', onSearchKeyDown);

      // Cleanup for search input listeners
      this._unsubs.push(() => {
        try { search.removeEventListener('input', onSearchInput); } catch(_) {}
        try { search.removeEventListener('keydown', onSearchKeyDown); } catch(_) {}
      });

      // Initialize headers/dividers visibility
      this.filterLinks('');
    } catch (e) {
      // On error, hide the container silently
      try { this.elements.container.style.display = 'none'; } catch (_) {}
      console.warn('[GlobalLinks] Failed to load links:', e);
    }
  }

  open() {
    const { dropdown } = this.elements;
    if (!dropdown) return;
    // Capture where to return focus before showing the menu
    this._captureReturnFocus();
    this._searchGroupRevealOverride = null;
    dropdown.classList.add('show');
    this._isOpen = true;
    try { this.elements.button.setAttribute('aria-expanded', 'true'); } catch (_) {}
    // Register shared dropdown backdrop
    if (!this._backdropCloser) this._backdropCloser = () => this.close();
    dropdownBackdrop.show(this._backdropCloser);
    // Focus search input on open; if missing, focus first item
    if (this.elements.searchInput) {
      // Clear previous query and reset filters on each open for predictability
      try { this.elements.searchInput.value = ''; } catch (_) {}
      this.filterLinks('');
      this._focusSearchInput();
    } else {
      this._focusFirstItem();
    }
  }

  close() {
    const { dropdown } = this.elements;
    if (!dropdown) return;
    dropdown.classList.remove('show');
    this._isOpen = false;
    try { this.elements.button.setAttribute('aria-expanded', 'false'); } catch (_) {}
    if (this._backdropCloser) dropdownBackdrop.hide(this._backdropCloser);
    // Restore focus to the prior active tab target (terminal or note textarea)
    this._restoreFocus();
    this._searchGroupRevealOverride = null;
  }

  _items() {
    try { return Array.from(this.elements.dropdown.querySelectorAll('.dropdown-item')); } catch (_) { return []; }
  }

  _currentItem() {
    const items = this._items();
    const active = document.activeElement;
    return items.find(el => el === active) || null;
  }

  _focusFirstItem() {
    this._focusFirstVisibleItem();
  }

  _visibleItems() {
    const items = this._items();
    return items.filter(el => el.style.display !== 'none');
  }

  _focusFirstVisibleItem() {
    const items = this._visibleItems();
    if (items.length > 0) {
      try { items[0].focus(); } catch (_) {}
    }
  }

  _computeVisibleCount(queryStr, allowGroupReveal) {
    try {
      const query = (queryStr || '').trim().toLowerCase();
      const hasQuery = query.length > 0;
      let total = 0;
      (this._groupsMeta || []).forEach((gm) => {
        const groupMatch = allowGroupReveal && hasQuery && gm.title && gm.title.indexOf(query) !== -1;
        (gm.items || []).forEach((a) => {
          let hit = !hasQuery || groupMatch;
          if (!hit) {
            const text = (a.textContent || '').toLowerCase();
            hit = text.indexOf(query) !== -1;
          }
          if (hit) total++;
        });
      });
      return total;
    } catch (_) {
      return 0;
    }
  }

  _focusSearchInput() {
    try {
      const input = this.elements.searchInput;
      if (input) {
        input.focus();
        // Select existing text (should be empty, but safe)
        input.setSelectionRange?.(0, input.value.length);
      }
    } catch (_) {}
  }

  filterLinks(q = null) {
    try {
      const query = (q !== null ? q : (this.elements.searchInput?.value || '')).trim().toLowerCase();
      const hasQuery = query.length > 0;
      const linksPrefs = appStore.getState('preferences.links') || {};
      const prefAllowGroupReveal = linksPrefs.searchRevealGroupLinks !== false;
      const allowGroupReveal = (this._searchGroupRevealOverride === null)
        ? prefAllowGroupReveal
        : !!this._searchGroupRevealOverride;
      const counts = [];
      // Show/hide items per group
      this._groupsMeta.forEach((gm, gi) => {
        let visibleInGroup = 0;
        const groupMatch = allowGroupReveal && hasQuery && gm.title && gm.title.indexOf(query) !== -1;
        gm.items.forEach((a) => {
          let hit = !hasQuery || groupMatch;
          if (!hit) {
            const text = (a.textContent || '').toLowerCase();
            hit = text.indexOf(query) !== -1;
          }
          a.style.display = hit ? '' : 'none';
          if (hit) visibleInGroup++;
        });
        if (gm.header) gm.header.style.display = visibleInGroup > 0 ? '' : 'none';
        counts[gi] = visibleInGroup;
      });
      // Show dividers only between visible groups
      this._groupsMeta.forEach((gm, gi) => {
        if (!gm.divider) return;
        const anyAfter = counts.slice(gi + 1).some(c => c > 0);
        gm.divider.style.display = (counts[gi] > 0 && anyAfter) ? '' : 'none';
      });
    } catch (_) {}
  }

  _moveFocus(delta) {
    const items = this._visibleItems();
    if (items.length === 0) {
      // Nothing to move between; prefer keeping focus on search
      this._focusSearchInput();
      return;
    }
    const active = this._currentItem();
    let idx = items.indexOf(active);
    if (idx < 0) idx = delta > 0 ? -1 : 0; // from search or unknown target

    // If at first item and moving up, return focus to search input
    if (delta < 0 && idx <= 0) {
      this._focusSearchInput();
      return;
    }

    let next = idx + delta;
    // Wrap within visible items (but we already handled up from start)
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    try { items[next].focus(); } catch (_) {}
  }

  _isTypingTarget(e) {
    try {
      const t = e.target;
      if (!t) return false;
      // Treat xterm's hidden helper textarea as NOT a typing target so shortcuts still work
      if (t.classList && t.classList.contains('xterm-helper-textarea')) return false;
      const tag = (t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      const ce = t.getAttribute && t.getAttribute('contenteditable');
      if (ce && String(ce).toLowerCase() !== 'false') return true;
      return false;
    } catch (_) { return false; }
  }

  destroy() {
    this._unsubs.forEach(fn => { try { fn(); } catch(_) {} });
    this._unsubs = [];
    // Ensure any transient UI state is cleared
    if (this._backdropCloser) dropdownBackdrop.hide(this._backdropCloser);
  }

  _isNoteEditor(el) {
    try {
      if (!el) return false;
      const tag = (el.tagName || '').toLowerCase();
      if (tag !== 'textarea') return false;
      const cl = el.classList || {};
      return !!(cl.contains && (cl.contains('note-editor') || cl.contains('workspace-note-editor')));
    } catch (_) { return false; }
  }

  _captureReturnFocus() {
    this._focusReturnFn = null;
    try {
      const app = getContext()?.app;
      const tabManager = app?.modules?.tabManager;
      const activeTabId = tabManager?.activeTabId || 'terminal';

      if (activeTabId === 'note') {
        const sessionId = tabManager?.currentSessionId;
        const tab = tabManager?.notesController?.getNoteTab?.(sessionId);
        const textarea = tab?.textarea || null;
        this._focusReturnFn = () => {
          try {
            if (textarea && document.body.contains(textarea)) {
              textarea.focus();
              return;
            }
          } catch (_) {}
          try { app?.modules?.terminal?.currentSession?.focus?.(); } catch (_) {}
        };
        return;
      }

      if (activeTabId === 'workspace-note') {
        const wsCtl = tabManager?.workspaceNotesController;
        const ws = wsCtl?.getWorkspaceName?.();
        const view = wsCtl?.findWorkspaceView?.(ws);
        const textarea = view ? view.querySelector('textarea.note-editor') : null;
        this._focusReturnFn = () => {
          try {
            if (textarea && document.body.contains(textarea)) {
              textarea.focus();
              return;
            }
          } catch (_) {}
          try { app?.modules?.terminal?.currentSession?.focus?.(); } catch (_) {}
        };
        return;
      }

      // Default: terminal, containers, URLs → focus terminal
      this._focusReturnFn = () => {
        try { getContext()?.app?.modules?.terminal?.currentSession?.focus?.(); } catch (_) {}
      };
    } catch (_) {
      this._focusReturnFn = null;
    }
  }

  _restoreFocus() {
    const fn = this._focusReturnFn;
    this._focusReturnFn = null;
    try {
      if (typeof fn === 'function') fn();
    } catch (_) {}
  }
}
