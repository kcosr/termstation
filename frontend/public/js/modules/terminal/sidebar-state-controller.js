/**
 * SidebarStateController
 * Centralizes sidebar overlay state (open/close) and mode detection.
 */
import { isAnyModalOpen } from '../ui/modal.js';

export class SidebarStateController {
  constructor(options = {}) {
    this.sidebarSelector = options.sidebarSelector || '.terminal-sidebar';
    this.mainLayoutSelector = options.mainLayoutSelector || '.main-layout';
    this.backdropSelector = options.backdropSelector || '#sidebar-backdrop';
    this.closeButtonSelector = options.closeButtonSelector || '#mobile-sidebar-close';
    this.toggleIds = options.toggleIds || [
      'mobile-sidebar-toggle',
      'toolbar-sidebar-toggle',
      'window-sidebar-toggle',
      'desktop-sidebar-toggle',
    ];
    this.overlayOpenClass = options.overlayOpenClass || 'sidebar-overlay-open';
    this.sidebarOpenClass = options.sidebarOpenClass || 'sidebar-overlay-visible';
    this.modeVar = options.modeVar || '--sidebar-mode';
    this.onToggleDocked = options.onToggleDocked || null;
    this.onAfterClose = options.onAfterClose || null;
    this.onDockedSync = options.onDockedSync || null;
    this._isDedicatedWindow = options.isDedicatedWindow || null;
    this.shouldIgnoreGlobalToggle = options.shouldIgnoreGlobalToggle || null;
    this._initialized = false;
    this._toggleButtons = null;
    this._lastMode = null;
    this._dockedHiddenState = null;
    this._onResize = () => this.syncMode();
    this._onToggleClick = (event) => this.handleToggleClick(event);
    this._onBackdropClick = () => this.closeOverlay();
    this._onCloseClick = () => this.closeOverlay();
    this._onKeydown = (event) => this.handleKeydown(event);
    this._onDedicatedShortcut = (event) => this.handleDedicatedShortcut(event);
  }

  init() {
    if (this._initialized) return;
    const sidebar = this.getSidebar();
    if (!sidebar) return;
    this._initialized = true;

    this.getToggleButtons().forEach((btn) => {
      try {
        btn.setAttribute('aria-controls', 'terminal-sidebar');
        btn.setAttribute('aria-expanded', 'false');
      } catch (_) {}
      btn.addEventListener('click', this._onToggleClick);
    });

    const backdrop = this.getBackdrop();
    if (backdrop) {
      backdrop.addEventListener('click', this._onBackdropClick);
    }

    const closeButton = this.getCloseButton();
    if (closeButton) {
      closeButton.addEventListener('click', this._onCloseClick);
    }

    document.addEventListener('keydown', this._onKeydown, true);
    if (this.getIsDedicatedWindow()) {
      document.addEventListener('keydown', this._onDedicatedShortcut, true);
    }
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', () => {
      setTimeout(this._onResize, 100);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize);
    }

    this.syncMode();
  }

  getSidebar() {
    return document.querySelector(this.sidebarSelector);
  }

  getMainLayout() {
    return document.querySelector(this.mainLayoutSelector);
  }

  getBackdrop() {
    return document.querySelector(this.backdropSelector);
  }

  getCloseButton() {
    return document.querySelector(this.closeButtonSelector);
  }

  getToggleButtons() {
    if (Array.isArray(this._toggleButtons)) return this._toggleButtons;
    const buttons = [];
    this.toggleIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) buttons.push(el);
    });
    this._toggleButtons = buttons;
    return buttons;
  }

  getSidebarMode() {
    const sidebar = this.getSidebar();
    if (!sidebar || typeof window.getComputedStyle !== 'function') return 'docked';
    const styles = getComputedStyle(sidebar);
    const raw = styles.getPropertyValue(this.modeVar);
    const mode = (raw || '').trim().replace(/['"]/g, '').toLowerCase();
    if (mode) return mode;
    return styles.position === 'fixed' ? 'overlay' : 'docked';
  }

  getIsDedicatedWindow() {
    if (typeof this._isDedicatedWindow === 'function') {
      try { return !!this._isDedicatedWindow(); } catch (_) { return false; }
    }
    if (typeof this._isDedicatedWindow === 'boolean') return this._isDedicatedWindow;
    try {
      if (window.WindowModeUtils && typeof WindowModeUtils.shouldUseWindowModeFromUrl === 'function') {
        return !!WindowModeUtils.shouldUseWindowModeFromUrl(window.location);
      }
      const params = new URLSearchParams(window.location.search || '');
      const ui = String(params.get('ui') || '').toLowerCase();
      const win = String(params.get('window') || '').trim();
      return ui === 'window' || win === '1' || win.toLowerCase() === 'true';
    } catch (_) {
      return false;
    }
  }

  isOverlayMode() {
    return this.getSidebarMode() === 'overlay';
  }

  isHiddenMode() {
    return this.getSidebarMode() === 'hidden';
  }

  isOverlayOpen() {
    const sidebar = this.getSidebar();
    const sidebarOpen = !!(sidebar && sidebar.classList.contains(this.sidebarOpenClass));
    const bodyOpen = !!(document.body && document.body.classList.contains(this.overlayOpenClass));
    return sidebarOpen || bodyOpen;
  }

  handleToggleClick(event) {
    this.toggle();
    try { event?.currentTarget?.blur?.(); } catch (_) {}
  }

  handleKeydown(event) {
    if (isAnyModalOpen()) return;
    if (event.key !== 'Escape') return;
    if (!this.isOverlayOpen()) return;
    this.closeOverlay();
    try { event.preventDefault(); event.stopPropagation(); } catch (_) {}
  }

  handleDedicatedShortcut(event) {
    if (isAnyModalOpen()) return;
    const isQMark = event.code === 'Slash';
    if (!isQMark || !event.shiftKey) return;
    if (!(event.metaKey || event.altKey || event.ctrlKey)) return;
    if (typeof this.shouldIgnoreGlobalToggle === 'function') {
      try { if (this.shouldIgnoreGlobalToggle()) return; } catch (_) {}
    }
    try { event.preventDefault(); event.stopPropagation(); } catch (_) {}
    this.toggle();
  }

  openOverlay() {
    if (!this.isOverlayMode()) {
      this.syncMode();
      return false;
    }
    const sidebar = this.getSidebar();
    if (!sidebar) return false;
    this.rememberDockedHidden();
    this.clearDockedHidden();
    sidebar.classList.add(this.sidebarOpenClass);
    document.body.classList.add(this.overlayOpenClass);
    this.updateToggleAria(true);
    return true;
  }

  closeOverlay(options = {}) {
    const sidebar = this.getSidebar();
    const wasOpen = this.isOverlayOpen();
    if (!sidebar) return false;
    sidebar.classList.remove(this.sidebarOpenClass);
    document.body.classList.remove(this.overlayOpenClass);
    this.updateToggleAria(false);
    if (options.focusTerminal && wasOpen && typeof this.onAfterClose === 'function') {
      try { this.onAfterClose(); } catch (_) {}
    }
    return wasOpen;
  }

  toggleOverlay() {
    if (this.isOverlayOpen()) {
      return this.closeOverlay();
    }
    return this.openOverlay();
  }

  toggle() {
    if (this.isHiddenMode()) return false;
    if (this.isOverlayMode()) {
      return this.toggleOverlay();
    }
    this.toggleDocked();
    setTimeout(() => this.syncMode(), 0);
    return true;
  }

  toggleDocked() {
    if (typeof this.onToggleDocked === 'function') {
      try { this.onToggleDocked(); } catch (_) {}
    }
  }

  clearDockedHidden() {
    const sidebar = this.getSidebar();
    const mainLayout = this.getMainLayout();
    if (sidebar) sidebar.classList.remove('sidebar-hidden');
    if (mainLayout) mainLayout.classList.remove('sidebar-hidden');
  }

  rememberDockedHidden() {
    if (this._dockedHiddenState) return;
    const sidebar = this.getSidebar();
    const mainLayout = this.getMainLayout();
    this._dockedHiddenState = {
      sidebarHidden: !!(sidebar && sidebar.classList.contains('sidebar-hidden')),
      mainLayoutHidden: !!(mainLayout && mainLayout.classList.contains('sidebar-hidden')),
    };
  }

  restoreDockedHidden() {
    if (!this._dockedHiddenState) return;
    const sidebar = this.getSidebar();
    const mainLayout = this.getMainLayout();
    if (sidebar) {
      sidebar.classList.toggle('sidebar-hidden', this._dockedHiddenState.sidebarHidden);
    }
    if (mainLayout) {
      mainLayout.classList.toggle('sidebar-hidden', this._dockedHiddenState.mainLayoutHidden);
    }
    this._dockedHiddenState = null;
  }

  clearOverlayClasses() {
    const sidebar = this.getSidebar();
    if (sidebar) sidebar.classList.remove(this.sidebarOpenClass);
    document.body.classList.remove(this.overlayOpenClass);
  }

  updateToggleAria(expanded) {
    const value = expanded ? 'true' : 'false';
    this.getToggleButtons().forEach((btn) => {
      try { btn.setAttribute('aria-expanded', value); } catch (_) {}
    });
  }

  syncMode() {
    const sidebar = this.getSidebar();
    if (!sidebar || !document.body) return;
    const mode = this.getSidebarMode();
    const prevMode = this._lastMode;

    if (prevMode !== mode) {
      if (mode === 'overlay') {
        this.rememberDockedHidden();
        this.clearDockedHidden();
      } else if (prevMode === 'overlay') {
        this.restoreDockedHidden();
      }
    }

    if (mode === 'overlay') {
      const isOpen = sidebar.classList.contains(this.sidebarOpenClass);
      if (isOpen) {
        document.body.classList.add(this.overlayOpenClass);
      } else {
        document.body.classList.remove(this.overlayOpenClass);
      }
      this.updateToggleAria(isOpen);
      this._lastMode = mode;
      return;
    }

    this.clearOverlayClasses();

    if (mode === 'hidden') {
      this.updateToggleAria(false);
      this._lastMode = mode;
      return;
    }

    if (prevMode !== 'docked' && typeof this.onDockedSync === 'function') {
      try { this.onDockedSync(); } catch (_) {}
    }

    const expanded = !sidebar.classList.contains('sidebar-hidden');
    this.updateToggleAria(expanded);
    this._lastMode = mode;
  }
}
