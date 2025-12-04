/**
 * Dropdown Backdrop Manager
 * - Provides a shared transparent backdrop while any dropdown menu is open
 * - Intercepts touches/clicks outside the menu and notifies registered closers
 * - Toggles `body.dropdown-open` to disable terminal pointer-events during menus
 */

class DropdownBackdropManager {
  constructor() {
    this._closers = new Set();
    this._el = null;
  }

  _ensureElement() {
    if (this._el && document.body.contains(this._el)) return this._el;
    const el = document.createElement('div');
    el.id = 'dropdown-blocker-backdrop';
    const swallow = (e) => { try { e.preventDefault(); } catch(_) {} try { e.stopPropagation(); } catch(_) {} };
    ['touchstart','touchmove','mousedown','mouseup','click'].forEach((t) => {
      el.addEventListener(t, swallow, { passive: false });
    });
    const closeAll = () => {
      try {
        // Copy to array to avoid mutation during iteration
        const toClose = Array.from(this._closers);
        toClose.forEach((fn) => { try { fn(); } catch (_) {} });
      } catch (_) {}
    };
    // Close on click (desktop) and on early touch/mouse down (mobile & Safari)
    el.addEventListener('click', closeAll);
    el.addEventListener('touchstart', closeAll, { passive: true });
    el.addEventListener('mousedown', closeAll);
    document.body.appendChild(el);
    this._el = el;
    return el;
  }

  show(onClose) {
    if (typeof onClose === 'function') this._closers.add(onClose);
    this._ensureElement();
    try { document.body.classList.add('dropdown-open'); } catch (_) {}
  }

  hide(onClose) {
    if (typeof onClose === 'function') this._closers.delete(onClose);
    if (this._closers.size === 0) {
      try { document.body.classList.remove('dropdown-open'); } catch (_) {}
      if (this._el && this._el.parentNode) {
        try { this._el.parentNode.removeChild(this._el); } catch (_) {}
      }
      this._el = null;
    }
  }

  isActive() {
    return this._closers.size > 0;
  }
}

export const dropdownBackdrop = new DropdownBackdropManager();
