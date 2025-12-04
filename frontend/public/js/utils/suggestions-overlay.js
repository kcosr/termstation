/**
 * SuggestionsOverlay
 * Reusable left-aligned suggestions dropdown for text-like inputs
 * - Opens on click (button), focus, or typing
 * - ArrowUp/Down to navigate, Enter to select, Escape to close
 * - Options supplied via async getOptions()
 */

export class SuggestionsOverlay {
  constructor(inputEl, opts = {}) {
    this.input = inputEl;
    this.getOptions = typeof opts.getOptions === 'function' ? opts.getOptions : async () => [];
    this.onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : (() => {});
    this.openOnFocus = opts.openOnFocus !== false;
    this.filterWhileTyping = opts.filterWhileTyping !== false;
    this._cached = null;
    this._loading = null;
    this._wrap = null;
    this._btn = null;
    this._overlay = null;
    this._outsideCloser = null;
    this._selectedIndex = -1;
    this._build();
  }

  _build() {
    const wrap = document.createElement('div');
    wrap.className = 'input-with-action input-with-suggestions';
    this.input.classList.add('input-with-action-field');
    this.input.parentNode.insertBefore(wrap, this.input);
    wrap.appendChild(this.input);

    const overlay = document.createElement('div');
    overlay.className = 'suggestions-dropdown';
    overlay.style.display = 'none';
    // Accessibility: listbox semantics
    const overlayId = (this.input.id ? `${this.input.id}-listbox` : `listbox-${Math.random().toString(36).slice(2)}`);
    overlay.id = overlayId;
    overlay.setAttribute('role', 'listbox');
    // Keep overlay out of the tab order; keyboard navigation is handled on the input
    overlay.setAttribute('tabindex', '-1');
    // Prevent overlay from stealing focus on mouse interactions
    overlay.addEventListener('mousedown', (e) => { e.preventDefault(); }, true);
    wrap.appendChild(overlay);

    this._wrap = wrap;
    this._btn = null;
    this._overlay = overlay;

    this._outsideCloser = (e) => { if (!wrap.contains(e.target)) this.close(); };
    document.addEventListener('click', this._outsideCloser);

    // No toggle button; overlay opens on focus/typing

    if (this.openOnFocus) {
      this.input.addEventListener('focus', async () => {
        if (this.input.dataset && this.input.dataset.suppressNextFocusOpen === '1') {
          try { delete this.input.dataset.suppressNextFocusOpen; } catch(_) {}
          return;
        }
        await this.open();
      });
    }
    // A11y: associate input with listbox
    try {
      this.input.setAttribute('aria-haspopup', 'listbox');
      this.input.setAttribute('aria-controls', overlayId);
      this.input.setAttribute('aria-expanded', 'false');
    } catch(_) {}
    // Close on blur (with slight delay to allow click selection)
    this.input.addEventListener('blur', () => {
      setTimeout(() => {
        try {
          const active = document.activeElement;
          if (this._wrap && this._wrap.contains(active)) return; // focus moved within wrapper
        } catch (_) {}
        this.close();
      }, 100);
    });
    if (this.filterWhileTyping) {
      this.input.addEventListener('input', async () => {
        if (this.input.dataset && this.input.dataset.suppressNextOverlayOpen === '1') {
          try { delete this.input.dataset.suppressNextOverlayOpen; } catch(_) {}
          return;
        }
        if (!this.isOpen()) { await this.open(); return; }
        this._render(this._cached || [], this.input.value || '');
      });
    }

    // Keyboard navigation
    this.input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        if (this.isOpen()) { e.preventDefault(); e.stopPropagation(); this.close(); }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this.isOpen()) await this.open();
        const items = this._items();
        if (items.length === 0) return;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        this._setSelectedIndex(this._selectedIndex + delta);
        return;
      }
      if (e.key === 'Enter') {
        if (this.isOpen()) {
          const items = this._items();
          const idx = this._selectedIndex;
          if (idx >= 0 && idx < items.length) {
            e.preventDefault(); e.stopPropagation();
            items[idx].click();
            return;
          }
        }
      }
      if (e.key === 'Tab') {
        // Close overlay when tabbing away
        if (this.isOpen()) this.close();
      }
    });
  }

  destroy() {
    try { document.removeEventListener('click', this._outsideCloser); } catch(_) {}
    if (this._wrap && this._wrap.parentNode) {
      try {
        // Move input back to original position then remove wrapper
        this._wrap.parentNode.insertBefore(this.input, this._wrap);
        this._wrap.remove();
      } catch(_) {}
    }
  }

  isOpen() { return this._overlay && this._overlay.style.display !== 'none'; }
  async open(forceReload = false) {
    this._overlay.style.display = 'block';
    const opts = await this._load(forceReload);
    this._render(opts, this.input.value || '');
    try { this.input.setAttribute('aria-expanded', 'true'); } catch(_) {}
  }
  close() {
    if (this._overlay) this._overlay.style.display = 'none';
    try { this.input.setAttribute('aria-expanded', 'false'); } catch(_) {}
    try { this.input.removeAttribute('aria-activedescendant'); } catch(_) {}
  }

  async _load(force) {
    if (this._cached && !force) return this._cached;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        const out = await this.getOptions();
        this._cached = Array.isArray(out) ? out : [];
        return this._cached;
      } finally {
        this._loading = null;
      }
    })();
    return this._loading;
  }

  _items() { return Array.from(this._overlay.querySelectorAll('.suggestion-item')); }
  _setSelectedIndex(idx) {
    const items = this._items();
    if (items.length === 0) { this._selectedIndex = -1; return; }
    const clamped = Math.max(0, Math.min(idx, items.length - 1));
    if (this._selectedIndex >= 0 && this._selectedIndex < items.length) items[this._selectedIndex].classList.remove('highlighted');
    this._selectedIndex = clamped;
    items[clamped].classList.add('highlighted');
    try { items[clamped].scrollIntoView({ block: 'nearest' }); } catch(_) {}
    // A11y: reflect active descendant
    try { this.input.setAttribute('aria-activedescendant', items[clamped].id || ''); } catch(_) {}
  }

  _render(items, filterTerm) {
    const ov = this._overlay;
    ov.innerHTML = '';
    const term = String(filterTerm || '').toLowerCase();
    const filtered = term ? (items || []).filter(o => String(o.label || o.value || '').toLowerCase().includes(term)) : (items || []);
    if (filtered.length === 0) {
      const none = document.createElement('div');
      none.className = 'suggestion-item';
      none.textContent = 'No options available';
      ov.appendChild(none);
      this._selectedIndex = -1;
      return;
    }
    filtered.forEach((opt, i) => {
      const el = document.createElement('div');
      el.className = 'suggestion-item';
      el.textContent = opt.label ?? opt.value ?? '';
      el.dataset.value = String(opt.value ?? '');
      // A11y: option semantics
      try {
        el.setAttribute('role', 'option');
        el.setAttribute('tabindex', '-1');
        el.id = `${ov.id}-opt-${i}`;
        el.setAttribute('aria-selected', 'false');
      } catch(_) {}
      el.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const v = el.dataset.value || '';
        try { this.input.dataset.suppressNextOverlayOpen = '1'; } catch(_) {}
        try { this.input.dataset.suppressNextFocusOpen = '1'; } catch(_) {}
        this.input.value = v;
        // Bubble change for upstream listeners
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
        this.input.dispatchEvent(new Event('change', { bubbles: true }));
        this.close();
        try { this.input.focus(); } catch(_) {}
        try { this.onSelect(v); } catch(_) {}
      });
      ov.appendChild(el);
    });
    this._setSelectedIndex(0);
    // Update aria-selected on items
    const all = this._items();
    all.forEach((node, idx) => {
      try { node.setAttribute('aria-selected', idx === this._selectedIndex ? 'true' : 'false'); } catch(_) {}
    });
  }

  invalidateCache() { this._cached = null; }
  refresh() {
    if (this.isOpen()) this._render(this._cached || [], this.input.value || '');
  }

  /**
   * Replace cached options with a provided list and re-render if open.
   * Useful for external callers that have already fetched dynamic options.
   */
  setOptions(items) {
    this._cached = Array.isArray(items) ? items : [];
    if (this.isOpen()) {
      this._render(this._cached, this.input.value || '');
    }
  }
}
