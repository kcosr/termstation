/**
 * SidebarController
 * Handles show/hide/toggle behavior for the terminal sidebar, resizing via a handle,
 * and persistence of width and collapsed state in localStorage/settings.
 */
import { appStore } from '../../core/store.js';
import { settingsManager } from '../settings/settings-manager.js';
import { getStateStore } from '../../core/state-store/index.js';
import { queueStateSet } from '../../core/state-store/batch.js';

export class SidebarController {
  constructor(options = {}) {
    this.sidebarSelector = options.sidebarSelector || '.terminal-sidebar';
    this.mainLayoutSelector = options.mainLayoutSelector || '.main-layout';
    this.desktopToggleId = options.desktopToggleId || 'desktop-sidebar-toggle';

    // Resize configuration
    this.minWidth = options.minWidth || 260; // px
    this.maxWidth = options.maxWidth || 640; // px
    this.storageWidthKey = options.storageWidthKey || 'ui.sidebar.width';
    this.storageCollapsedKey = options.storageCollapsedKey || 'ui.sidebar.collapsed';

    this._onMouseMove = null;
    this._onMouseUp = null;
  }

  init() {
    const sidebar = this.getSidebar();
    if (!sidebar) return;

    // Non-mobile: start hidden by default, then open only if saved state says not collapsed
    try {
      if (!this.isMobileLayout()) {
        // Default: hidden
        sidebar.classList.add('sidebar-hidden');
        this.getMainLayout()?.classList.add('sidebar-hidden');

        const savedCollapsed = this.getSavedCollapsedState();
        if (savedCollapsed === false) {
          // Persisted as not collapsed -> show
          this.showSidebar();
        } // else remain hidden (collapsed)
      } else {
        // Mobile: start collapsed by default. Respect explicit savedCollapsed=false to show.
        const savedCollapsed = this.getSavedCollapsedState();
        if (savedCollapsed === false) {
          sidebar.classList.remove('sidebar-hidden');
          this.getMainLayout()?.classList.remove('sidebar-hidden');
        } else {
          sidebar.classList.add('sidebar-hidden');
          this.getMainLayout()?.classList.add('sidebar-hidden');
        }
      }
    } catch (_) {}

    // Apply saved width (desktop layouts only)
    this.applySavedWidth();

    // Ensure resizer handle exists and attach listeners
    this.ensureResizer();
  }

  getSidebar() {
    return document.querySelector(this.sidebarSelector);
  }

  getMainLayout() {
    return document.querySelector(this.mainLayoutSelector);
  }

  getDesktopToggle() {
    return document.getElementById(this.desktopToggleId);
  }

  isMobileLayout() {
    // Keep in sync with CSS breakpoints
    try {
      if (document.body && document.body.classList.contains('responsive-window')) return true;
      const sidebar = this.getSidebar();
      if (sidebar && typeof window.getComputedStyle === 'function') {
        const pos = getComputedStyle(sidebar).position;
        if (pos === 'fixed') return true;
      }
    } catch (_) {}
    return window.matchMedia('(max-width: 768px), (max-device-width: 768px), (orientation: portrait) and (max-width: 1024px)').matches;
  }

  applySavedWidth() {
    try {
      if (this.isMobileLayout()) return; // ignore on mobile
      const sidebar = this.getSidebar();
      if (!sidebar) return;
      const store = getStateStore();
      const st = store.loadSync && store.loadSync();
      const stateObj = st && st.ok ? (st.state || {}) : {};
      const raw = stateObj[this.storageWidthKey];
      const value = raw != null ? parseInt(raw, 10) : NaN;
      if (!Number.isNaN(value)) {
        const clamped = Math.min(this.maxWidth, Math.max(this.minWidth, value));
        sidebar.style.setProperty('--sidebar-width', `${clamped}px`);
      }
    } catch (e) {
      console.warn('[SidebarController] Failed to apply saved width:', e);
    }
  }

  ensureResizer() {
    const sidebar = this.getSidebar();
    if (!sidebar || this.isMobileLayout()) return;

    let handle = sidebar.querySelector('.sidebar-resizer');
    if (!handle) {
      handle = document.createElement('div');
      handle.id = 'sidebar-resizer';
      handle.className = 'sidebar-resizer';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', 'Resize sidebar');
      handle.setAttribute('tabindex', '0');
      sidebar.appendChild(handle);
    }

    // Avoid duplicate listeners
    handle.onmousedown = (e) => this.startResize(e);
    handle.ontouchstart = (e) => this.startResize(e);
  }

  startResize(ev) {
    const sidebar = this.getSidebar();
    if (!sidebar || this.isMobileLayout()) return;

    const isTouch = ev.type === 'touchstart';
    const startX = isTouch ? ev.touches[0].clientX : ev.clientX;
    const rect = sidebar.getBoundingClientRect();
    const startWidth = rect.width;

    sidebar.classList.add('resizing');
    const handle = sidebar.querySelector('.sidebar-resizer');
    if (handle) handle.classList.add('dragging');

    const onMove = (e) => {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const delta = clientX - startX;
      const newWidth = Math.min(this.maxWidth, Math.max(this.minWidth, startWidth + delta));
      sidebar.style.setProperty('--sidebar-width', `${newWidth}px`);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);

      sidebar.classList.remove('resizing');
      const handle = sidebar.querySelector('.sidebar-resizer');
      if (handle) handle.classList.remove('dragging');

      // Queue persistence via global StateStore batch
      try {
        const computed = parseInt(getComputedStyle(sidebar).getPropertyValue('--sidebar-width'), 10);
        if (!Number.isNaN(computed)) {
          queueStateSet(this.storageWidthKey, String(computed), 200);
        }
      } catch (_) {}
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp, { passive: true });

    // Prevent text selection while dragging
    ev.preventDefault?.();
  }

  toggleSidebar() {
    const sidebar = this.getSidebar();
    if (!sidebar) {
      console.warn('[SidebarController] Sidebar element not found');
      return;
    }
    const isHidden = sidebar.classList.contains('sidebar-hidden');
    if (isHidden) {
      this.showSidebar();
    } else {
      this.hideSidebar();
    }
  }

  showSidebar() {
    const sidebar = this.getSidebar();
    const mainLayout = this.getMainLayout();
    if (sidebar) sidebar.classList.remove('sidebar-hidden');
    if (mainLayout) mainLayout.classList.remove('sidebar-hidden');
    const btn = this.getDesktopToggle();
    if (btn) {
      btn.classList.remove('sidebar-hidden');
      btn.setAttribute('aria-expanded', 'true');
    }
    // Restore saved width on show
    this.applySavedWidth();
    // Persist collapsed state = false
    try {
      appStore.setPath('ui.sidebarCollapsed', false);
      queueStateSet(this.storageCollapsedKey, 'false', 200);
    } catch (_) {}
  }

  hideSidebar() {
    const sidebar = this.getSidebar();
    const mainLayout = this.getMainLayout();
    if (sidebar) sidebar.classList.add('sidebar-hidden');
    if (mainLayout) mainLayout.classList.add('sidebar-hidden');
    const btn = this.getDesktopToggle();
    if (btn) {
      btn.classList.add('sidebar-hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
    // Persist collapsed state = true
    try {
      appStore.setPath('ui.sidebarCollapsed', true);
      queueStateSet(this.storageCollapsedKey, 'true', 200);
    } catch (_) {}
  }

  getSavedCollapsedState() {
    try {
      // Prefer in-memory store first
      const fromStore = appStore.getState('ui.sidebarCollapsed');
      if (typeof fromStore === 'boolean') return fromStore;
    } catch (_) {}
    try {
      const store = getStateStore();
      const res = store.loadSync && store.loadSync();
      const stateObj = res && res.ok ? (res.state || {}) : {};
      const raw = stateObj[this.storageCollapsedKey];
      if (raw === 'true' || raw === true) return true;
      if (raw === 'false' || raw === false) return false;
    } catch (_) {}
    return false; // default expanded
  }
}
