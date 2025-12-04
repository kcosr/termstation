import { Modal } from '../ui/modal.js';

class KeyboardShortcutsModal {
    constructor() {
        this.modalElement = null;
        this.modal = null;
        this.capturing = false;
        this.options = { exclusive: false, preventDefault: false };
        this.pressed = new Set();
        this.handlersBound = false;

        this.elements = {
            startBtn: null,
            stopBtn: null,
            clearBtn: null,
            exclusiveChk: null,
            preventDefaultChk: null,
            pressedDisplay: null,
            lastDisplay: null,
            lastDetail: null,
            list: null
        };

        // Bind handlers once
        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);
    }

    init() {
        if (this.modal) return; // already initialized
        this.modalElement = document.getElementById('keyboard-shortcuts-modal');
        if (!this.modalElement) return;

        this.modal = new Modal({ element: this.modalElement });

        // Cache elements
        this.elements.startBtn = document.getElementById('shortcuts-start');
        this.elements.stopBtn = document.getElementById('shortcuts-stop');
        this.elements.clearBtn = document.getElementById('shortcuts-clear');
        this.elements.exclusiveChk = document.getElementById('shortcuts-exclusive');
        this.elements.preventDefaultChk = document.getElementById('shortcuts-prevent-default');
        this.elements.pressedDisplay = document.getElementById('shortcuts-pressed');
        this.elements.lastDisplay = document.getElementById('shortcuts-last');
        this.elements.lastDetail = document.getElementById('shortcuts-last-detail');
        this.elements.list = document.getElementById('shortcuts-list');

        // Wire up buttons
        this.elements.startBtn?.addEventListener('click', () => this.startCapture());
        this.elements.stopBtn?.addEventListener('click', () => this.stopCapture());
        this.elements.clearBtn?.addEventListener('click', () => this.clear());
        this.elements.exclusiveChk?.addEventListener('change', (e) => {
            this.options.exclusive = !!e.target.checked;
        });
        this.elements.preventDefaultChk?.addEventListener('change', (e) => {
            this.options.preventDefault = !!e.target.checked;
        });

        // Stop capturing when the modal hides
        this.modal.on('beforeHide', () => {
            this.stopCapture();
        });
    }

    openModal() {
        this.init();
        if (!this.modal) return;
        this.modal.show();
        // Ensure default state
        this.stopCapture();
        setTimeout(() => this.elements.startBtn?.focus(), 50);
    }

    startCapture() {
        if (this.capturing) return;
        this.capturing = true;
        this._updateButtons();

        if (!this.handlersBound) {
            // Use capture phase so we can observe keys early; we do not stop propagation
            window.addEventListener('keydown', this._onKeyDown, { capture: true });
            window.addEventListener('keyup', this._onKeyUp, { capture: true });
            this.handlersBound = true;
        }
    }

    stopCapture() {
        if (!this.capturing && !this.handlersBound) return;
        this.capturing = false;
        this._updateButtons();
        if (this.handlersBound) {
            window.removeEventListener('keydown', this._onKeyDown, { capture: true });
            window.removeEventListener('keyup', this._onKeyUp, { capture: true });
            this.handlersBound = false;
        }
        this.pressed.clear();
        this._renderPressed();
    }

    clear() {
        if (this.elements.list) this.elements.list.innerHTML = '';
        if (this.elements.lastDisplay) this.elements.lastDisplay.textContent = '—';
        if (this.elements.lastDetail) this.elements.lastDetail.textContent = '';
        this.pressed.clear();
        this._renderPressed();
    }

    _onKeyDown(e) {
        if (!this.capturing) return;

        // Track pressed set (avoid repeats)
        const keyId = this._keyId(e);
        if (!e.repeat) this.pressed.add(keyId);
        this._renderPressed();

        // Optionally block others
        if (this.options.preventDefault) e.preventDefault();
        if (this.options.exclusive) {
            e.stopImmediatePropagation();
            e.stopPropagation();
        }

        // Describe combo
        const combo = this._formatCombo(e);
        const detail = `key="${e.key}" code="${e.code}" repeat=${e.repeat ? 'true' : 'false'} defaultPrevented=${e.defaultPrevented ? 'true' : 'false'}`;

        // Update last
        if (this.elements.lastDisplay) this.elements.lastDisplay.textContent = combo;
        if (this.elements.lastDetail) this.elements.lastDetail.textContent = detail;

        // Append to history (limit to last 50 entries)
        if (this.elements.list) {
            const row = document.createElement('div');
            row.className = 'shortcuts-item';
            const time = new Date().toLocaleTimeString();
            row.textContent = `[${time}] ${combo} — ${detail}`;
            this.elements.list.prepend(row);
            while (this.elements.list.childElementCount > 50) {
                this.elements.list.lastChild.remove();
            }
        }
    }

    _onKeyUp(e) {
        if (!this.capturing) return;
        // Update pressed keys
        this.pressed.delete(this._keyId(e));
        this._renderPressed();
    }

    _renderPressed() {
        if (!this.elements.pressedDisplay) return;
        if (this.pressed.size === 0) {
            this.elements.pressedDisplay.textContent = 'None';
            return;
        }
        const sorted = Array.from(this.pressed).sort();
        this.elements.pressedDisplay.textContent = sorted.join(' + ');
    }

    _updateButtons() {
        if (this.elements.startBtn) this.elements.startBtn.style.display = this.capturing ? 'none' : '';
        if (this.elements.stopBtn) this.elements.stopBtn.style.display = this.capturing ? '' : 'none';
    }

    _keyId(e) {
        // Identify a key with modifiers; use code for stability across layouts
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Meta');
        parts.push(e.code || e.key);
        return parts.join('+');
    }

    _formatCombo(e) {
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push(this._isMac() ? 'Cmd' : 'Meta');
        // Prefer code for physical key; show key fallback
        const keyLabel = e.code || e.key;
        parts.push(keyLabel);
        return parts.join(' + ');
    }

    _isMac() {
        return navigator.platform.toUpperCase().includes('MAC');
    }
}

export const keyboardShortcuts = new KeyboardShortcutsModal();

