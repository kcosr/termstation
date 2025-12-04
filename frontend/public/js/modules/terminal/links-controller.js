/**
 * LinksController
 * - Manages the session links dropdown: render, toggle, and delegated events
 * - Uses event delegation for dropdown item clicks
 */

import { delegate } from '../../utils/delegate.js';
import { dropdownBackdrop } from '../../utils/dropdown-backdrop.js';
import { appStore } from '../../core/store.js';

export class LinksController {
  constructor(elements, eventBus) {
    this.elements = elements;
    this.eventBus = eventBus;
    this._unsubs = [];
    this._onDocumentClick = this._onDocumentClick.bind(this);
    // No state needed; we render based on current session data
  }

  init() {
    const { sessionLinksBtn, sessionLinksDropdown } = this.elements || {};
    // Normalize container (support existing fallback)
    this.elements.sessionLinksContainer =
      this.elements.sessionLinksContainer || document.getElementById('session-links-container') || document.querySelector('.session-links-container');

    if (this.elements.sessionLinksContainer) {
      // Start hidden; visibility is driven by preference + session links in updateSessionLinks()
      this.elements.sessionLinksContainer.style.display = 'none';
    }

    if (sessionLinksBtn) {
      const clickHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle();
      };
      sessionLinksBtn.addEventListener('click', clickHandler);
      this._unsubs.push(() => sessionLinksBtn.removeEventListener('click', clickHandler));
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', this._onDocumentClick);
    this._unsubs.push(() => document.removeEventListener('click', this._onDocumentClick));

    // React to preference changes (show/hide session links menu)
    try {
      const off = appStore.subscribe('preferences.links.showSessionToolbarMenu', () => {
        try {
          const container = this.elements?.sessionLinksContainer;
          const dropdown = this.elements?.sessionLinksDropdown;
          if (!container) return;
          const enabled = appStore?.getState?.('preferences.links.showSessionToolbarMenu') === true;
          if (!enabled) {
            if (dropdown) dropdown.classList.remove('show');
            container.style.display = 'none';
          } else {
            // When re-enabled, re-render for current session if we have cached data
            if (this._lastSessionData) this.updateSessionLinks(this._lastSessionData);
          }
        } catch (_) {}
      });
      this._unsubs.push(off);
    } catch (_) {}

    // Prevent clicks/touches within the dropdown from bubbling to the terminal (mobile safety)
    if (sessionLinksDropdown) {
      const stopProp = (e) => { try { e.stopPropagation(); } catch (_) {} };
      ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchmove'].forEach((type) => {
        sessionLinksDropdown.addEventListener(type, stopProp, false);
      });

      // (No preventDefault here to preserve internal scrolling if needed)

      // Delegate link item clicks to open externally in browser (not iframe)
      const off = delegate(sessionLinksDropdown, '.dropdown-item', 'click', (e, item) => {
        e.preventDefault();
        this.hide();
        const url = item.dataset.url || item.getAttribute('data-url') || item.getAttribute('href');
        if (url) {
          try {
            window.open(url, '_blank', 'noopener,noreferrer');
          } catch (err) {
            // Fallback: emit to open in tab if window.open blocked
            const title = item.dataset.title || null;
            this.eventBus?.emit('open-url-in-tab', { url, title });
          }
        }
      });
      this._unsubs.push(off);
    }
  }

  _onDocumentClick(e) {
    const { sessionLinksDropdown, sessionLinksContainer } = this.elements || {};
    if (sessionLinksDropdown && !sessionLinksContainer?.contains(e.target)) {
      sessionLinksDropdown.classList.remove('show');
    }
  }

  toggle() {
    const { sessionLinksDropdown } = this.elements || {};
    if (!sessionLinksDropdown) return;
    if (sessionLinksDropdown.classList.contains('show')) {
      this.hide();
    } else {
      this.show();
    }
  }

  show() {
    const { sessionLinksDropdown } = this.elements || {};
    if (!sessionLinksDropdown) return;
    sessionLinksDropdown.classList.add('show');
    if (!this._backdropCloser) this._backdropCloser = () => this.hide();
    dropdownBackdrop.show(this._backdropCloser);
  }

  hide() {
    const { sessionLinksDropdown } = this.elements || {};
    if (!sessionLinksDropdown) return;
    sessionLinksDropdown.classList.remove('show');
    if (this._backdropCloser) dropdownBackdrop.hide(this._backdropCloser);
  }

  updateSessionLinks(sessionData) {
    const { sessionLinksContainer, sessionLinksDropdown } = this.elements || {};
    if (!sessionLinksContainer || !sessionLinksDropdown) return;
    // Respect preference: hide entirely when disabled
    try {
      const enabled = appStore?.getState?.('preferences.links.showSessionToolbarMenu') === true;
      if (!enabled) {
        sessionLinksDropdown.innerHTML = '';
        sessionLinksContainer.style.display = 'none';
        return;
      }
    } catch (_) {}

    // Cache last data so we can re-render when toggled back on
    this._lastSessionData = sessionData || null;

    const links = sessionData?.links || [];
    const isTerminated = sessionData?.is_active === false;
    if (links.length === 0 || isTerminated) {
      sessionLinksDropdown.innerHTML = '';
      sessionLinksContainer.style.display = 'none';
      return;
    }

    sessionLinksContainer.style.display = 'flex';
    // Rebuild dropdown items from the provided links
    sessionLinksDropdown.innerHTML = '';

    // De-duplicate by URL
    const seen = new Set();
    for (const link of links) {
      if (!link?.url) continue;
      if (seen.has(link.url)) continue;
      seen.add(link.url);

      if (!this._shouldShowLink(link, sessionData)) continue;

      const el = document.createElement('a');
      el.className = 'dropdown-item';
      el.href = '#';
      el.textContent = link.name || link.url;
      el.setAttribute('data-url', link.url);
      if (link.name) el.setAttribute('data-title', link.name);
      sessionLinksDropdown.appendChild(el);
    }
    // Done
  }

  _shouldShowLink(link, sessionData) {
    const isActive = !!sessionData?.is_active;
    const showActive = link.show_active !== false;
    const showInactive = link.show_inactive !== false;
    if (isActive && !showActive) return false;
    if (!isActive && !showInactive) return false;
    return true;
  }

  destroy() {
    try {
      this._unsubs.forEach((fn) => fn());
    } finally {
      this._unsubs = [];
    }
    // Ensure any transient UI state is cleared
    if (this._backdropCloser) dropdownBackdrop.hide(this._backdropCloser);
  }
}
