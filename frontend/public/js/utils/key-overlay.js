/**
 * KeyPress Overlay
 * Passive overlay that shows currently pressed keys and the last combo.
 * Modeled after the Settings > Keyboard Shortcuts capture test.
 *
 * Activation:
 *  - URL param: ?debug_keys=1 (or true)
 *  - Or window.KEY_OVERLAY=true (for ad-hoc enabling via devtools)
 */

class KeyOverlay {
    constructor() {
        this.enabled = false;
        this.alwaysVisible = true; // keep overlay visible while enabled
        this.overlayEl = null;
        this.pressedEl = null;
        this.lastEl = null;
        this.pressed = new Set();
        this.hideTimer = null;
        this.handlersBound = false;
        // Track Meta (Cmd) state and keys that may have missing keyup due to Meta combos
        this._metaDown = false;
        this._suspectTimers = new Map(); // code -> timeout id

        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);
        this._onWindowBlur = this._onWindowBlur.bind(this);
        this._onVisibilityChange = this._onVisibilityChange.bind(this);
        // Do not auto-enable; the Settings toggle controls activation
    }

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this._ensureDom();
        this._bindEvents();
        this._show();
        this._render();
    }

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this._unbindEvents();
        this._hide();
        this.pressed.clear();
        this._render();
    }

    _ensureDom() {
        if (this.overlayEl) return;
        const el = document.createElement('div');
        el.id = 'key-overlay';
        el.setAttribute('aria-hidden', 'true');
        // Inline styles to avoid CSS coupling
        el.style.position = 'fixed';
        el.style.bottom = 'max(12px, env(safe-area-inset-bottom, 12px))';
        el.style.right = 'max(12px, env(safe-area-inset-right, 12px))';
        el.style.background = 'rgba(0, 0, 0, 0.75)';
        el.style.color = '#fff';
        el.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
        el.style.fontSize = '12px';
        el.style.lineHeight = '1.3';
        el.style.padding = '8px 10px';
        el.style.borderRadius = '8px';
        el.style.boxShadow = '0 6px 16px rgba(0,0,0,0.35)';
        el.style.border = '1px solid rgba(255,255,255,0.15)';
        el.style.zIndex = '2147483646';
        el.style.pointerEvents = 'none';
        el.style.userSelect = 'none';
        el.style.backdropFilter = 'saturate(140%) blur(4px)';
        el.style.webkitBackdropFilter = 'saturate(140%) blur(4px)';
        el.style.display = 'none';
        el.style.minWidth = '160px';
        el.style.maxWidth = '40vw';

        const title = document.createElement('div');
        title.textContent = 'Keys';
        title.style.opacity = '0.7';
        title.style.fontWeight = '600';
        title.style.marginBottom = '4px';
        title.style.letterSpacing = '0.02em';
        el.appendChild(title);

        const pressed = document.createElement('div');
        pressed.id = 'key-overlay-pressed';
        pressed.textContent = 'Pressed: None';
        pressed.style.whiteSpace = 'nowrap';
        pressed.style.overflow = 'hidden';
        pressed.style.textOverflow = 'ellipsis';
        el.appendChild(pressed);

        const last = document.createElement('div');
        last.id = 'key-overlay-last';
        last.textContent = 'Last: —';
        last.style.opacity = '0.9';
        last.style.marginTop = '2px';
        last.style.whiteSpace = 'nowrap';
        last.style.overflow = 'hidden';
        last.style.textOverflow = 'ellipsis';
        el.appendChild(last);

        document.body.appendChild(el);
        this.overlayEl = el;
        this.pressedEl = pressed;
        this.lastEl = last;
    }

    _bindEvents() {
        if (this.handlersBound) return;
        window.addEventListener('keydown', this._onKeyDown, { capture: true });
        window.addEventListener('keyup', this._onKeyUp, { capture: true });
        window.addEventListener('blur', this._onWindowBlur, { capture: true });
        document.addEventListener('visibilitychange', this._onVisibilityChange, { capture: true });
        this.handlersBound = true;
    }

    _unbindEvents() {
        if (!this.handlersBound) return;
        window.removeEventListener('keydown', this._onKeyDown, { capture: true });
        window.removeEventListener('keyup', this._onKeyUp, { capture: true });
        window.removeEventListener('blur', this._onWindowBlur, { capture: true });
        document.removeEventListener('visibilitychange', this._onVisibilityChange, { capture: true });
        this.handlersBound = false;
    }

    _onKeyDown(e) {
        if (!this.enabled) return;
        // Track physical key by code only to ensure keyup matches
        const code = this._codeFromEvent(e);
        if (code) {
            if (code === 'Meta') this._metaDown = true;
            // If we marked a key as suspect on Meta release, seeing repeats confirms it's still held
            if (e && e.repeat && this._suspectTimers.has(code)) {
                this._clearSuspect(code);
            }
            if (!e.repeat) {
                this.pressed.add(code);
                // If a new keydown arrives, it is definitely not suspect
                this._clearSuspect(code);
                this._canonicalizePressed();
            }
        }
        this._render();

        // Update last combo to reflect all currently held keys (including this key)
        const combo = this._formatPressedCombo();
        if (this.lastEl) this.lastEl.textContent = `Last: ${combo || '—'}`;

        // Show immediately and delay hide
        this._show();
        this._delayHide(1200);
    }

    _onWindowBlur() {
        // Clear any stuck keys when window loses focus
        this.pressed.clear();
        this._clearAllSuspects();
        this._render();
        this._delayHide(300);
    }

    _onVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            this.pressed.clear();
            this._clearAllSuspects();
            this._render();
        }
    }

    _onKeyUp(e) {
        if (!this.enabled) return;
        const code = this._codeFromEvent(e);
        if (code) {
            // Always remove the released key itself
            this.pressed.delete(code);
            // Clear any suspect timer for this key (definitive keyup arrived)
            this._clearSuspect(code);
            // On Meta release, some browsers may suppress keyup for non-modifier keys used with Meta combos.
            // Instead of clearing immediately, mark non-modifiers as 'suspect' and clear shortly unless
            // we observe their own keyup or a repeat keydown confirming they remain held after Meta release.
            if (code === 'Meta') {
                this._metaDown = false;
                const onlyModifiers = new Set(['Shift', 'Control', 'Alt', 'Meta']);
                const delay = 150; // ms
                Array.from(this.pressed).forEach((k) => {
                    if (!onlyModifiers.has(k)) this._markSuspect(k, delay);
                });
            }
            this._canonicalizePressed();
        }
        this._render();
        // Hide shortly after keys released if none are pressed
        if (this.pressed.size === 0) {
            this._delayHide(600);
        }
    }

    _markSuspect(code, delayMs) {
        try { this._clearSuspect(code); } catch (_) {}
        const id = setTimeout(() => {
            // If still marked suspect after the delay and Meta is not down, clear it
            try { this._suspectTimers.delete(code); } catch (_) {}
            if (!this._metaDown) {
                this.pressed.delete(code);
                this._render();
            }
        }, Math.max(50, Number(delayMs) || 150));
        this._suspectTimers.set(code, id);
    }

    _clearSuspect(code) {
        const id = this._suspectTimers.get(code);
        if (id) {
            try { clearTimeout(id); } catch (_) {}
            this._suspectTimers.delete(code);
        }
    }

    _clearAllSuspects() {
        try {
            for (const [, id] of this._suspectTimers) {
                try { clearTimeout(id); } catch (_) {}
            }
            this._suspectTimers.clear();
        } catch (_) {}
    }

    _render() {
        if (!this.pressedEl) return;
        if (this.pressed.size === 0) {
            this.pressedEl.textContent = 'Pressed: None';
            return;
        }
        const labels = this._sortedPrettyLabels(Array.from(this.pressed));
        this.pressedEl.textContent = `Pressed: ${labels.join(' + ')}`;
    }

    _show() {
        if (!this.overlayEl) return;
        this.overlayEl.style.display = 'block';
        this.overlayEl.style.opacity = '1';
        this.overlayEl.style.transition = 'opacity 120ms ease-out, transform 120ms ease-out';
        this.overlayEl.style.transform = 'translateY(0)';
    }

    _hide() {
        if (!this.overlayEl) return;
        this.overlayEl.style.transition = 'opacity 200ms ease-in, transform 200ms ease-in';
        this.overlayEl.style.opacity = '0';
        this.overlayEl.style.transform = 'translateY(6px)';
        // Fully hide after transition for pointer-events none anyway
        setTimeout(() => { if (this.overlayEl) this.overlayEl.style.display = 'none'; }, 220);
    }

    _delayHide(ms) {
        if (this.alwaysVisible) return; // do not auto-hide when enabled
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(() => {
            if (this.pressed.size === 0) this._hide();
        }, ms);
    }

    _codeFromEvent(e) {
        if (!e) return '';
        const code = (e.code || '').toString();
        const key = (e.key || '').toString();
        // Canonicalize modifiers to side-agnostic names so keyup matches reliably
        switch (code) {
            case 'ShiftLeft':
            case 'ShiftRight':
            case 'Shift':
                return 'Shift';
            case 'ControlLeft':
            case 'ControlRight':
            case 'Control':
                return 'Control';
            case 'AltLeft':
            case 'AltRight':
            case 'Alt':
                return 'Alt';
            case 'MetaLeft':
            case 'MetaRight':
            case 'OSLeft':
            case 'OSRight':
            case 'Meta':
                return 'Meta';
            case 'Space':
            case 'Spacebar':
                return 'Space';
            case 'Escape':
            case 'Esc':
                return 'Escape';
            default:
                break;
        }
        if (code && code !== 'Unidentified') return code;
        // Fallback when code is missing
        if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;
        if (/^[0-9]$/.test(key)) return `Digit${key}`;
        if (key === ' ') return 'Space';
        if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return key;
        if (key === 'Esc') return 'Escape';
        return key;
    }

    _formatPressedCombo() {
        if (!this.pressed || this.pressed.size === 0) return '';
        const labels = this._sortedPrettyLabels(Array.from(this.pressed));
        return labels.join(' + ');
    }

    _sortedPrettyLabels(codes = []) {
        const labels = codes.map((c) => this._prettyLabelFromCode(c));
        // De-duplicate by label (e.g., ShiftLeft + ShiftRight -> Shift)
        const unique = Array.from(new Set(labels));
        const rank = (label) => {
            const l = String(label).toLowerCase();
            if (l === 'cmd' || l === 'meta') return 1;
            if (l === 'ctrl') return 2;
            if (l === 'alt') return 3;
            if (l === 'shift') return 4;
            return 10;
        };
        return unique.sort((a, b) => {
            const ra = rank(a), rb = rank(b);
            if (ra !== rb) return ra - rb;
            return a.localeCompare(b);
        });
    }

    _canonicalizePressed() {
        if (!this.pressed || this.pressed.size === 0) return;
        const next = new Set();
        this.pressed.forEach((c) => {
            switch (c) {
                case 'ShiftLeft':
                case 'ShiftRight':
                    next.add('Shift');
                    break;
                case 'ControlLeft':
                case 'ControlRight':
                    next.add('Control');
                    break;
                case 'AltLeft':
                case 'AltRight':
                    next.add('Alt');
                    break;
                case 'MetaLeft':
                case 'MetaRight':
                case 'OSLeft':
                case 'OSRight':
                    next.add('Meta');
                    break;
                case 'Spacebar':
                    next.add('Space');
                    break;
                case 'Esc':
                    next.add('Escape');
                    break;
                default:
                    next.add(c);
            }
        });
        this.pressed = next;
    }

    _prettyLabelFromCode(code) {
        if (!code) return '';
        switch (code) {
            case 'ControlLeft':
            case 'ControlRight':
            case 'Control':
                return 'Ctrl';
            case 'ShiftLeft':
            case 'ShiftRight':
            case 'Shift':
                return 'Shift';
            case 'AltLeft':
            case 'AltRight':
            case 'Alt':
                return 'Alt';
            case 'MetaLeft':
            case 'MetaRight':
            case 'OSLeft':
            case 'OSRight':
            case 'Meta':
                return this._isMac() ? 'Cmd' : 'Meta';
            case 'Space':
            case 'Spacebar':
                return 'Space';
            case 'Escape':
                return 'Esc';
            default:
                break;
        }
        if (/^Key[A-Z]$/.test(code)) return code.slice(3);
        if (/^Digit[0-9]$/.test(code)) return code.slice(5);
        return code;
    }

    _isMac() {
        try { return navigator.platform.toUpperCase().includes('MAC'); } catch (_) { return false; }
    }
}

// Export a singleton-like accessor for optional external toggling
export const keyOverlay = new KeyOverlay();
