/**
 * Console Overlay Module
 * Captures and displays console messages in a debug overlay when visible
 * Persists overlay visibility state using StateStore (localStorage on web, disk on desktop)
*/
import { getStateStore } from '../core/state-store/index.js';
import { queueStateSet } from '../core/state-store/batch.js';
import { appStore } from '../core/store.js';

class ConsoleOverlay {
    constructor() {
        // Store original console methods
        this.originalConsoleLog = console.log;
        this.originalConsoleError = console.error;
        this.originalConsoleWarn = console.warn;
        
        // StateStore key for persistence
        this.storageKey = 'debug_overlay_visible';
        
        // Initialize overlay and always-on console wrappers
        this.init();
        this.overrideConsoleMethods();
    }

    init() {
        // Wire overlay control buttons if present
        this.attachControlEvents();

        // Load saved visibility state when DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.loadVisibilityState());
        } else {
            this.loadVisibilityState();
        }
    }

    attachControlEvents() {
        const copyBtn = document.getElementById('debug-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => this.copyDebugLog());
        }
        const clearBtn = document.getElementById('debug-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearDebugLog());
        }
        const closeBtn = document.getElementById('debug-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hideOverlay());
        }
    }

    logToOverlay(message, type = 'log') {
        const overlay = document.getElementById('debug-overlay');
        const log = document.getElementById('debug-log');
        
        // Only capture to overlay if it's visible
        if (overlay && log && overlay.style.display !== 'none') {
            const timestamp = new Date().toLocaleTimeString();
            const color = type === 'error' ? '#f00' : type === 'warn' ? '#ff0' : '#0f0';
            log.innerHTML = `<div style="border-bottom: 1px solid #333; padding: 2px 0; color: ${color};">[${timestamp}] ${message}</div>` + log.innerHTML;
        }
    }

    clearDebugLog() {
        const log = document.getElementById('debug-log');
        if (log) {
            log.innerHTML = '';
        }
    }

    copyDebugLog() {
        const log = document.getElementById('debug-log');
        if (!log) return;

        // Extract text content from the debug log
        const text = log.textContent || log.innerText || '';
        
        if (!text.trim()) {
            alert('Debug log is empty');
            return;
        }

        // Use the same copy method as terminal auto-copy with fallback
        this.copyToClipboard(text);
    }

    copyToClipboard(text) {
        // Try modern Clipboard API first (requires HTTPS or localhost)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
                .then(() => {
                    this.showCopyStatus('Debug log copied!');
                })
                .catch(error => {
                    console.warn('[Debug] Clipboard API failed, trying fallback:', error);
                    this.copyUsingExecCommand(text);
                });
        } else {
            // Fallback to older execCommand method
            this.copyUsingExecCommand(text);
        }
    }

    copyUsingExecCommand(text) {
        try {
            // Create a temporary textarea element
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.top = '-9999px';
            textarea.style.left = '-9999px';
            textarea.setAttribute('readonly', '');
            document.body.appendChild(textarea);
            
            // Select the text
            textarea.select();
            textarea.setSelectionRange(0, text.length);
            
            // Try to copy
            const successful = document.execCommand('copy');
            
            // Clean up
            document.body.removeChild(textarea);
            
            if (successful) {
                this.showCopyStatus('Debug log copied!');
            } else {
                console.warn('[Debug] execCommand copy failed');
                alert('Failed to copy debug log');
            }
        } catch (error) {
            console.error('[Debug] Copy failed:', error);
            alert('Failed to copy debug log');
        }
    }

    showCopyStatus(message) {
        // Show a brief success message
        const overlay = document.getElementById('debug-overlay');
        if (overlay) {
            const existingStatus = overlay.querySelector('.copy-status');
            if (existingStatus) {
                existingStatus.remove();
            }

            const status = document.createElement('div');
            status.className = 'copy-status';
            status.style.cssText = 'position: absolute; top: 5px; right: 5px; background: #0a0; color: white; padding: 4px 8px; border-radius: 3px; font-size: 11px; z-index: 10001;';
            status.textContent = message;
            overlay.appendChild(status);

            setTimeout(() => {
                if (status.parentNode) {
                    status.parentNode.removeChild(status);
                }
            }, 2000);
        }
    }

    overrideConsoleMethods() {
        // Helper: map console prefix [Category] to debug flag key
        const mapPrefixToFlag = (prefix) => {
            switch ((prefix || '').toString().trim()) {
                case 'WebSocketService': return 'websocketLogs';
                case 'ApiService': return 'apiLogs';
                case 'StateStore': return 'stateStoreLogs';
                case 'App':
                case 'App URL Parameter': return 'appLogs';
                case 'Settings': return 'settingsLogs';
                case 'SessionTabs':
                case 'SessionTabsDnD':
                case 'SessionTabsManager': return 'sessionTabsLogs';
                case 'SessionList': return 'sessionListLogs';
                case 'TerminalViewController': return 'terminalLogs';
                case 'TerminalSession': return 'terminalSessionLogs';
                case 'TerminalManager':
                case 'Manager': return 'terminalManagerLogs';
                case 'TabManager': return 'tabManagerLogs';
                case 'ResponsiveToolbars': return 'responsiveToolbarLogs';
                case 'MobileViewport': return 'mobileViewportLogs';
                case 'MobileDetection': return 'mobileDetectionLogs';
                case 'MobileTouch': return 'mobileTouchLogs';
                case 'NotesModel': return 'notesLogs';
                case 'Config': return 'configLogs';
                // WebSocket handlers map to wsLogs bucket
                case 'AttachedHandler':
                case 'SessionUpdatedHandler':
                case 'LinkUpdatedHandler':
                case 'LinkRemovedHandler':
                case 'ShutdownHandler': return 'websocketLogs';
                default: return null;
            }
        };

        const shouldLog = (args) => {
            try {
                const first = args && args.length ? args[0] : null;
                const prefs = appStore.getState('preferences.debug') || {};

                // Handle debug-helper channel style: console.log('[debug]', 'wsLogs', ...)
                if (typeof first === 'string' && first.startsWith('[debug]')) {
                    const channel = (args[1] && typeof args[1] === 'string') ? args[1] : '';
                    if (channel === 'wsLogs') return prefs.websocketLogs === true;
                    if (channel === 'registryLogs') return prefs.registryLogs === true;
                    // Unknown channel -> allow
                    return true;
                }

                // Categorized bracket prefix style: console.log('[Category]', ...)
                if (typeof first === 'string' && first[0] === '[') {
                    const endIdx = first.indexOf(']');
                    if (endIdx > 1) {
                        const prefix = first.substring(1, endIdx);
                        const flag = mapPrefixToFlag(prefix);
                        if (!flag) return true; // unknown category -> allow
                        return prefs[flag] === true;
                    }
                }
                // Non-categorized logs pass through
                return true;
            } catch (_) {
                return true;
            }
        };

        // Override console.log (debug-level) with category gating
        console.log = (...args) => {
            const allow = shouldLog(args);
            const overlay = document.getElementById('debug-overlay');
            if (overlay && overlay.style.display !== 'none' && allow) {
                this.logToOverlay(args.join(' '), 'log');
            }
            if (allow) {
                this.originalConsoleLog.apply(console, args);
            }
        };

        // Override console.error (always show; still mirror to overlay if visible)
        console.error = (...args) => {
            const overlay = document.getElementById('debug-overlay');
            if (overlay && overlay.style.display !== 'none') {
                this.logToOverlay(args.join(' '), 'error');
            }
            this.originalConsoleError.apply(console, args);
        };

        // Override console.warn (always show; still mirror to overlay if visible)
        console.warn = (...args) => {
            const overlay = document.getElementById('debug-overlay');
            if (overlay && overlay.style.display !== 'none') {
                this.logToOverlay(args.join(' '), 'warn');
            }
            this.originalConsoleWarn.apply(console, args);
        };
    }

    loadVisibilityState() {
        try {
            const store = getStateStore();
            const res = store.loadSync && store.loadSync();
            const state = res && res.ok ? (res.state || {}) : {};
            const saved = state[this.storageKey];
            if (saved === true || saved === 'true') { this.showOverlay(); } else { this.hideOverlay(); }
        } catch (_) { this.hideOverlay(); }
    }

    saveVisibilityState(isVisible) {
        try { queueStateSet(this.storageKey, !!isVisible, 200); } catch (_) {}
    }

    showOverlay() {
        const overlay = document.getElementById('debug-overlay');
        if (overlay) {
            overlay.style.display = 'block';
            this.saveVisibilityState(true);
        }
    }

    hideOverlay() {
        const overlay = document.getElementById('debug-overlay');
        if (overlay) {
            overlay.style.display = 'none';
            this.saveVisibilityState(false);
        }
    }

    toggleOverlay() {
        const overlay = document.getElementById('debug-overlay');
        if (overlay) {
            const isVisible = overlay.style.display !== 'none';
            if (isVisible) {
                this.hideOverlay();
            } else {
                this.showOverlay();
            }
            return !isVisible;
        }
        return false;
    }

    // Method retained for API compatibility; no longer used
    restore() {
        // no-op: console overrides are always active to support gating
    }
}

// Export singleton instance
export const consoleOverlay = new ConsoleOverlay();
