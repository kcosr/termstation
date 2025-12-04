/**
 * TerminalSearchController
 * - Adds a search dropdown to the terminal toolbar
 * - Searches rendered xterm buffer (client-side) only
 * - Highlights matches using xterm selection and scrolls into view
 */

import { dropdownBackdrop } from '../../utils/dropdown-backdrop.js';

export class TerminalSearchController {
  constructor(elements, manager) {
    this.elements = elements;
    this.manager = manager;
    this._unsubs = [];
    this._backdropCloser = null;

    this._query = '';
    this._matches = [];
    this._index = -1;
  }

  init() {
    const {
      terminalSearchBtn,
      terminalSearchDropdown,
      terminalSearchInput,
      terminalSearchPrev,
      terminalSearchNext
    } = this.elements || {};

    if (terminalSearchBtn) {
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (terminalSearchDropdown?.classList.contains('show')) {
          this.hide();
        } else {
          this.show();
        }
      };
      terminalSearchBtn.addEventListener('click', handler);
      this._unsubs.push(() => terminalSearchBtn.removeEventListener('click', handler));
    }

    if (terminalSearchInput) {
      const onInput = (e) => {
        const value = String(e.target.value || '').trim();
        this._query = value;
        this._computeMatches();
      };
      const onKey = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) this.prev(); else this.next();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.hide();
        }
      };
      terminalSearchInput.addEventListener('input', onInput);
      terminalSearchInput.addEventListener('keydown', onKey);
      this._unsubs.push(() => terminalSearchInput.removeEventListener('input', onInput));
      this._unsubs.push(() => terminalSearchInput.removeEventListener('keydown', onKey));
    }

    if (terminalSearchPrev) {
      const handler = (e) => { e.preventDefault(); e.stopPropagation(); this.prev(); };
      terminalSearchPrev.addEventListener('click', handler);
      this._unsubs.push(() => terminalSearchPrev.removeEventListener('click', handler));
    }
    if (terminalSearchNext) {
      const handler = (e) => { e.preventDefault(); e.stopPropagation(); this.next(); };
      terminalSearchNext.addEventListener('click', handler);
      this._unsubs.push(() => terminalSearchNext.removeEventListener('click', handler));
    }

    // Dismiss on outside click
    const onDocClick = (e) => {
      if (!terminalSearchDropdown) return;
      const container = this.elements?.terminalSearchContainer || terminalSearchDropdown.parentElement;
      if (container && !container.contains(e.target)) {
        this.hide();
      }
    };
    document.addEventListener('click', onDocClick);
    this._unsubs.push(() => document.removeEventListener('click', onDocClick));

    // Prevent event bubbling inside the dropdown to avoid accidental close
    if (terminalSearchDropdown) {
      const stop = (e) => { try { e.stopPropagation(); } catch (_) {} };
      ['click','mousedown','mouseup','touchstart','touchend','touchmove','input','keydown'].forEach((t) => {
        terminalSearchDropdown.addEventListener(t, stop, false);
      });
      this._unsubs.push(() => {
        ['click','mousedown','mouseup','touchstart','touchend','touchmove','input','keydown'].forEach((t) => {
          terminalSearchDropdown.removeEventListener(t, stop, false);
        });
      });
    }
  }

  show() {
    const { terminalSearchDropdown, terminalSearchInput, terminalSearchBtn } = this.elements || {};
    if (!terminalSearchDropdown) return;
    terminalSearchDropdown.classList.add('show');
    try { terminalSearchBtn?.classList?.add('active'); } catch (_) {}
    if (!this._backdropCloser) this._backdropCloser = () => this.hide();
    dropdownBackdrop.show(this._backdropCloser);
    // Focus input
    try { terminalSearchInput?.focus(); terminalSearchInput?.select?.(); } catch (_) {}
  }

  hide(options = {}) {
    const { terminalSearchDropdown, terminalSearchInput, terminalSearchBtn } = this.elements || {};
    if (!terminalSearchDropdown) return;
    terminalSearchDropdown.classList.remove('show');
    try { terminalSearchBtn?.classList?.remove('active'); } catch (_) {}
    if (this._backdropCloser) dropdownBackdrop.hide(this._backdropCloser);
    // Clear input and highlight, but do not change terminal scroll position
    try { if (terminalSearchInput) terminalSearchInput.value = ''; } catch (_) {}
    this._query = '';
    this._matches = [];
    this._index = -1;
    this._clearSelection();

    // Refocus the terminal (except on mobile) for smooth workflow,
    // unless suppressed by caller (for explicit toggle behavior)
    const suppressRefocus = options && options.suppressRefocus === true;
    if (!suppressRefocus) {
      try {
        const session = this.manager?.currentSession || null;
        if (session && typeof session.shouldPreventAutoFocus === 'function') {
          const prevent = !!session.shouldPreventAutoFocus();
          if (!prevent) {
            session.focus?.();
          }
        } else {
          // Fallback: focus terminal if present
          this._getTerminal()?.focus?.();
        }
      } catch (_) { /* ignore */ }
    }
  }

  next() {
    if (!this._ensureMatches()) return;
    if (!this._matches.length) return;
    this._index = (this._index + 1) % this._matches.length;
    this._seekTo(this._matches[this._index]);
  }

  prev() {
    if (!this._ensureMatches()) return;
    if (!this._matches.length) return;
    this._index = (this._index - 1 + this._matches.length) % this._matches.length;
    this._seekTo(this._matches[this._index]);
  }

  _ensureMatches() {
    if (!this._query || !this._query.length) {
      this._matches = [];
      this._index = -1;
      this._clearSelection();
      return false;
    }
    if (!this._matches || !this._matches.length) {
      this._computeMatches();
    }
    return true;
  }

  _clearSelection() {
    const term = this._getTerminal();
    try { term?.clearSelection?.(); } catch (_) {}
  }

  _seekTo(match) {
    const term = this._getTerminal();
    if (!term || !match) return;
    try {
      term.select(match.col, match.row, match.len);
      // Ensure visibility
      term.scrollToLine(match.row);
    } catch (e) {
      console.warn('[TerminalSearch] Failed to select/scroll to match:', e);
    }
  }

  _getTerminal() {
    // Current interactive terminal instance
    return this.manager?.currentSession?.terminal || null;
  }

  _computeMatches() {
    const term = this._getTerminal();
    const q = this._query;
    this._matches = [];
    this._index = -1;
    if (!term || !q || !q.length) return;

    try {
      const buf = term.buffer?.active;
      if (!buf) return;
      const qLower = q.toLowerCase();
      const totalLines = buf.length;

      let y = 0;
      while (y < totalLines) {
        const line = buf.getLine(y);
        if (!line) { y++; continue; }
        // Start groups only on non-wrapped lines
        if (line.isWrapped) { y++; continue; }
        const groupStart = y;
        let groupEnd = y;
        let groupText = '';

        // Collect this line and all wrapped continuations
        let cur = buf.getLine(groupEnd);
        while (cur) {
          groupText += cur.translateToString(true);
          const next = buf.getLine(groupEnd + 1);
          if (next && next.isWrapped) {
            groupEnd++;
            cur = next;
          } else {
            break;
          }
        }

        // Search case-insensitive within groupText
        const textLower = groupText.toLowerCase();
        let pos = 0;
        while (true) {
          const idx = textLower.indexOf(qLower, pos);
          if (idx === -1) break;
          // Map string index to buffer position
          const startPos = this._mapStrIdx(buf, groupStart, 0, idx);
          if (startPos && startPos[0] !== -1) {
            this._matches.push({ row: startPos[0], col: startPos[1], len: q.length });
          }
          pos = idx + (q.length || 1);
        }

        y = groupEnd + 1;
      }
    } catch (e) {
      console.warn('[TerminalSearch] Error computing matches:', e);
      this._matches = [];
      this._index = -1;
    }
  }

  // Adapted mapping from xterm web links addon to convert a string index
  // within wrapped group to buffer coordinates (row, col).
  _mapStrIdx(buffer, row, startCol, offset) {
    try {
      const cell = buffer.getNullCell ? buffer.getNullCell() : null;
      let s = startCol || 0;
      let remaining = offset;
      while (remaining >= 0) {
        const line = buffer.getLine(row);
        if (!line) return [-1, -1];
        for (let n = s; n < line.length; ++n) {
          if (cell) line.getCell(n, cell);
          const ch = cell ? cell.getChars() : '';
          const width = cell ? cell.getWidth() : 1;
          if (width) {
            remaining -= (ch && ch.length) ? ch.length : 1;
            // Wrapped wide-char correction
            if (n === line.length - 1 && (!ch || ch === '')) {
              const next = buffer.getLine(row + 1);
              if (next && next.isWrapped && cell) {
                next.getCell(0, cell);
                if (cell.getWidth && cell.getWidth() === 2) remaining += 1;
              }
            }
            if (remaining < 0) return [row, n];
          }
        }
        row++;
        s = 0;
      }
      return [row, s];
    } catch (_) {
      return [-1, -1];
    }
  }

  destroy() {
    try { this._unsubs.forEach((fn) => fn()); } finally { this._unsubs = []; }
    if (this._backdropCloser) dropdownBackdrop.hide(this._backdropCloser);
  }
}
