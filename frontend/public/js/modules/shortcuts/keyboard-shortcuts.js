/**
 * Centralized keyboard shortcut registry.
 * Allows modules to register global shortcuts with consistent precedence rules.
 */

const DEFAULT_SCOPE = 'global';
const MOD_KEYS = ['shift', 'alt', 'ctrl', 'meta'];

function normalizeKey(key) {
    if (!key && key !== 0) return null;
    const str = String(key);
    if (str.length === 1) {
        return str.toLowerCase();
    }
    return str.toLowerCase();
}

function isInputElement(element) {
    if (!element || !element.tagName) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        const textTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
        return textTypes.has(type);
    }
    return false;
}

function isContentEditable(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;
    if (typeof element.closest === 'function') {
        const editable = element.closest('[contenteditable="true"]');
        return !!editable;
    }
    return false;
}

function elementMatchesAllowlist(element, allowlist) {
    if (!allowlist) return false;
    const entries = Array.isArray(allowlist) ? allowlist : [allowlist];
    for (const entry of entries) {
        try {
            if (typeof entry === 'function') {
                if (entry(element) === true) {
                    return true;
                }
            } else if (typeof entry === 'string' && entry.length > 0) {
                if (element && typeof element.closest === 'function' && element.closest(entry)) {
                    return true;
                }
            }
        } catch (_) {
            // Ignore allowlist errors so a bad matcher does not break shortcuts
        }
    }
    return false;
}

function isXtermHelper(element) {
    return !!element && element.classList?.contains('xterm-helper-textarea');
}

export class KeyboardShortcuts {
    constructor() {
        this._shortcuts = new Map();
        this._orderedShortcuts = [];
        this._orderCounter = 0;
        this._scopes = new Map();
        this._listener = this._handleKeydown.bind(this);

        if (typeof document !== 'undefined' && document?.addEventListener) {
            document.addEventListener('keydown', this._listener, true);
        } else {
            console.warn('[KeyboardShortcuts] document is not available; global shortcuts disabled');
        }
    }

    registerShortcut(definition = {}) {
        const { id, handler } = definition;
        if (!id || typeof id !== 'string') {
            throw new Error('[KeyboardShortcuts] registerShortcut requires a unique string id');
        }
        if (typeof handler !== 'function') {
            throw new Error(`[KeyboardShortcuts] Shortcut '${id}' is missing a handler function`);
        }

        // Remove existing shortcut with same id to avoid duplicates
        if (this._shortcuts.has(id)) {
            this.unregisterShortcut(id);
        }

        const shortcut = {
            id,
            handler,
            description: definition.description || '',
            scope: definition.scope || DEFAULT_SCOPE,
            priority: Number.isFinite(definition.priority) ? definition.priority : 0,
            when: typeof definition.when === 'function' ? definition.when : null,
            enabled: definition.enabled !== false,
            preventDefault: definition.preventDefault !== false,
            stopPropagation: definition.stopPropagation !== false,
            consume: definition.consume !== false,
            allowInInputs: definition.allowInInputs === true,
            allowInEditable: definition.allowInEditable === true,
            inputAllowlist: definition.inputAllowlist || null,
            matchers: [],
            customMatch: typeof definition.match === 'function' ? definition.match : null,
            order: this._orderCounter++
        };

        const keys = definition.keys;
        if (keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            shortcut.matchers = list
                .map((value) => this._parseDescriptor(String(value || '').trim()))
                .filter(Boolean);
        }

        this._shortcuts.set(shortcut.id, shortcut);
        this._rebuildOrdering();

        return () => {
            this.unregisterShortcut(shortcut.id);
        };
    }

    unregisterShortcut(id) {
        if (!this._shortcuts.delete(id)) {
            return false;
        }
        this._rebuildOrdering();
        return true;
    }

    enableScope(scope) {
        if (!scope) return;
        this._scopes.set(scope, true);
    }

    disableScope(scope) {
        if (!scope) return;
        this._scopes.set(scope, false);
    }

    isScopeEnabled(scope) {
        if (!scope) return true;
        if (!this._scopes.has(scope)) return true;
        return this._scopes.get(scope) !== false;
    }

    clear() {
        this._shortcuts.clear();
        this._orderedShortcuts = [];
    }

    _rebuildOrdering() {
        this._orderedShortcuts = Array.from(this._shortcuts.values())
            .sort((a, b) => {
                if (b.priority !== a.priority) {
                    return b.priority - a.priority;
                }
                return a.order - b.order;
            });
    }

    _handleKeydown(event) {
        if (!event) {
            return;
        }

        // Suppress global shortcuts while any modal overlay is open.
        // Modal components handle their own Enter/Escape and focus trapping.
        try { if (isAnyModalOpen()) return; } catch (_) {}

        const target = event.target || event.srcElement || null;
        for (const shortcut of this._orderedShortcuts) {
            if (!shortcut.enabled) {
                continue;
            }
            if (!this.isScopeEnabled(shortcut.scope)) {
                continue;
            }

            if (shortcut.when) {
                let allow = false;
                try {
                    allow = shortcut.when(event) === true;
                } catch (error) {
                    console.warn(`[KeyboardShortcuts] When predicate failed for '${shortcut.id}':`, error);
                    allow = false;
                }
                if (!allow) {
                    continue;
                }
            }

            if (!this._eventMatchesShortcut(event, shortcut)) {
                continue;
            }

            if (this._shouldIgnoreEvent(event, shortcut, target)) {
                continue;
            }

            let handled = false;
            try {
                handled = shortcut.handler(event, { id: shortcut.id, target, shortcut }) === true;
            } catch (error) {
                console.error(`[KeyboardShortcuts] Handler threw for '${shortcut.id}':`, error);
                handled = false;
            }

            if (!handled) {
                continue;
            }

            if (shortcut.preventDefault) {
                try { event.preventDefault(); } catch (_) {}
            }
            if (shortcut.stopPropagation) {
                try { event.stopPropagation(); } catch (_) {}
                try { event.stopImmediatePropagation(); } catch (_) {}
            }
            if (shortcut.consume) {
                break;
            }
        }
    }

    _eventMatchesShortcut(event, shortcut) {
        if (shortcut.customMatch) {
            try {
                if (shortcut.customMatch(event) === true) {
                    return true;
                }
            } catch (error) {
                console.warn(`[KeyboardShortcuts] Custom matcher failed for '${shortcut.id}':`, error);
            }
        }

        if (!shortcut.matchers || shortcut.matchers.length === 0) {
            return false;
        }

        return shortcut.matchers.some((descriptor) => this._matchesDescriptor(descriptor, event));
    }

    _matchesDescriptor(descriptor, event) {
        if (!descriptor) {
            return false;
        }

        for (const modKey of MOD_KEYS) {
            const required = descriptor[modKey];
            const actual = !!event[`${modKey}Key`];
            if (required === true && actual !== true) {
                return false;
            }
            if (required !== true && actual === true) {
                return false;
            }
        }

        if (descriptor.key) {
            const eventKey = normalizeKey(event.key);
            if (eventKey !== descriptor.key) {
                return false;
            }
        }

        if (descriptor.code && event.code !== descriptor.code) {
            return false;
        }

        return true;
    }

    _shouldIgnoreEvent(event, shortcut, target) {
        if (!shortcut) {
            return false;
        }

        if (isXtermHelper(target)) {
            return false;
        }

        if (!shortcut.allowInInputs) {
            const ignore = isInputElement(target) && !elementMatchesAllowlist(target, shortcut.inputAllowlist);
            if (ignore) {
                return true;
            }
        }

        if (!shortcut.allowInEditable) {
            const isEditable = isContentEditable(target);
            if (isEditable && !elementMatchesAllowlist(target, shortcut.inputAllowlist)) {
                return true;
            }
        }

        return false;
    }

    _parseDescriptor(input) {
        if (!input) {
            return null;
        }

        const descriptor = {
            shift: false,
            alt: false,
            ctrl: false,
            meta: false,
            key: null,
            code: null
        };

        const parts = input.split('+').map(part => part.trim()).filter(Boolean);
        if (parts.length === 0) {
            return null;
        }

        for (const rawPart of parts) {
            const part = rawPart.toLowerCase();
            if (part === 'shift') {
                descriptor.shift = true;
            } else if (part === 'alt' || part === 'option') {
                descriptor.alt = true;
            } else if (part === 'ctrl' || part === 'control') {
                descriptor.ctrl = true;
            } else if (part === 'meta' || part === 'cmd' || part === 'command') {
                descriptor.meta = true;
            } else if (part.startsWith('code:')) {
                descriptor.code = rawPart.slice(5);
            } else if (part.startsWith('key:')) {
                descriptor.key = normalizeKey(rawPart.slice(4));
            } else {
                descriptor.key = normalizeKey(rawPart);
            }
        }

        return descriptor;
    }
}

export const keyboardShortcuts = new KeyboardShortcuts();
import { isAnyModalOpen } from '../ui/modal.js';
