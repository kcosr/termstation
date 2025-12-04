/**
 * Terminal View Controller
 * Handles terminal display, rendering, and UI management
 * Extracted from TerminalManager to improve separation of concerns
 */

import { TerminalAutoCopy } from '../../utils/terminal-auto-copy.js';
import { getEffectiveTheme, getXtermTheme } from '../../utils/theme-utils.js';
import { AnsiDebug } from '../../utils/ansi-debug.js';
import { appStore } from '../../core/store.js';
import { applyAnsiFilters } from '../../utils/ansi-filters.js';
import { isAnyModalOpen } from '../ui/modal.js';
import { apiService } from '../../services/api.service.js';
import { streamHistoryToTerminal } from '../../utils/history-streamer.js';

export class TerminalViewController {
    constructor(elements, eventBus, terminalManager) {
        this.elements = elements;
        this.eventBus = eventBus;
        this.terminalManager = terminalManager;
        
        // History terminal references
        this.historyTerminal = null;
        this.historyFitAddon = null;
        this.historyAutoCopyCleanup = null;
        this.historyMobileUrlPopup = null;
        this.historyMobileUrlPopupTimeout = null;
    }

    /**
     * Show session history in read-only terminal viewer
     * @param {Object} sessionData - Session data including history
     * @param {Function} formatDurationFn - Function to format duration display
     */
    async showSessionHistory(sessionData, formatDurationFn) {
        // Hide terminal controls for inactive sessions but keep Close handler available
        this.hideTerminalControls();

        try {
            this.terminalManager?.sessionTabsManager?.disable?.();
        } catch (_) {}
        
        // Show the terminal tabs toolbar when viewing history
        try {
            this.terminalManager?.setTabsToolbarVisibility?.(true);
        } catch (_) {}

        // Create history viewer container
        const historyViewer = document.createElement('div');
        historyViewer.className = 'history-viewer';

        // Create header for history view
        const header = document.createElement('div');
        header.className = 'history-header';
        header.innerHTML = `
            <div class="history-info">
                <span class="history-title">Session History</span>
                <span class="history-details">
                    Command: ${sessionData.command_preview || sessionData.command} |
                    Exit Code: ${sessionData.exit_code !== null ? sessionData.exit_code : 'N/A'} |
                    Duration: ${formatDurationFn(sessionData.created_at, sessionData.ended_at)}
                </span>
            </div>
        `;

        // Create terminal container for xterm.js
        const terminalContainer = document.createElement('div');
        terminalContainer.className = 'history-terminal';
        terminalContainer.style.flex = '1';
        terminalContainer.style.overflow = 'hidden';

        // Create read-only xterm.js instance for history display
        const terminalOptions = this.getHistoryTerminalOptions(sessionData);
        const historyTerminal = new Terminal(terminalOptions);

        // Add fit addon for proper sizing
        const fitAddon = new FitAddon.FitAddon();
        historyTerminal.loadAddon(fitAddon);

        // Add hyperlink support for clickable URLs
        if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
            const openExternal = (event, uri) => {
                const href = typeof uri === 'string' ? uri : String(uri ?? '');
                try {
                    if (window.desktop && window.desktop.isElectron && typeof window.desktop.openExternal === 'function') {
                        window.desktop.openExternal(href);
                    } else {
                        window.open(href, '_blank');
                    }
                } catch (_) {
                    try { window.open(href, '_blank'); } catch (_) {}
                }
                try { event?.preventDefault?.(); } catch (_) {}
            };
            const webLinksAddon = new window.WebLinksAddon.WebLinksAddon(openExternal);
            historyTerminal.loadAddon(webLinksAddon);
        } else {
            console.warn('WebLinksAddon not available - hyperlinks will not be clickable in history terminal');
        }

        // Open terminal in container
        historyTerminal.open(terminalContainer);
        fitAddon.fit();
        try {
            const rect = terminalContainer.getBoundingClientRect ? terminalContainer.getBoundingClientRect() : null;
            console.log('[TerminalViewController] history fit', {
                sessionId: sessionData?.session_id,
                terminalSize: { cols: historyTerminal?.cols, rows: historyTerminal?.rows },
                metadataSize: sessionData?.terminal_size ?? null,
                containerWidth: rect ? Math.round(rect.width) : null,
                containerHeight: rect ? Math.round(rect.height) : null
            });
        } catch (_) {}

        // Store fit addon reference for resizing
        this.historyFitAddon = fitAddon;

        // Setup mobile scrolling for history terminal if on mobile
        if (this.isMobile()) {
            this.terminalManager.mobileInterface.setupHistoryMobileScrolling(historyTerminal, terminalContainer);
        }

        // Stream history content with ANSI rendering and progressive updates
        try {
            const controller = new AbortController();
            this._historyStreamAbort = controller;

            await streamHistoryToTerminal({
                terminal: historyTerminal,
                sessionId: sessionData.session_id,
                transitions: Array.isArray(sessionData?.activity_transitions) ? sessionData.activity_transitions : [],
                ensureTransitions: async () => {
                    try { const meta = await apiService.getSessionHistory(sessionData.session_id); return Array.isArray(meta?.activity_transitions) ? meta.activity_transitions : []; } catch (_) { return []; }
                },
                signal: controller.signal,
                onMarker: (marker, meta) => {
                    // optional: capture for future navigation; not required for viewer
                    try { this.historyMarkers = (this.historyMarkers || []).concat([{ marker, meta }]); } catch (_) {}
                }
            });
        } catch (e) {
            try { historyTerminal.write('No output history available for this session.'); } catch (_) {}
        }
        
        // Remove loading overlay after terminal rendering is complete
        this.setupRenderCompleteHandler(historyTerminal);

        // Setup auto-copy functionality for history terminal
        this.historyAutoCopyCleanup = TerminalAutoCopy.setup(historyTerminal, `history-${sessionData.session_id}`);

        // Handle keyboard shortcuts for scrolling in history terminal (Issue #224)
        this.setupHistoryKeyboardShortcuts(historyTerminal);

        // Assemble the history viewer
        historyViewer.appendChild(header);
        historyViewer.appendChild(terminalContainer);
        
        // Clear terminal view and add history viewer with loading overlay
        this.elements.terminalView.innerHTML = '';
        this.elements.terminalView.appendChild(historyViewer);
        
        // Add loading overlay that will be removed after rendering
        const loadingOverlay = document.createElement('div');
        loadingOverlay.className = 'terminal-loading-overlay';
        loadingOverlay.innerHTML = '<div class="terminal-placeholder"><p>Rendering terminal content...</p></div>';
        loadingOverlay.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 1000; background: var(--bg-primary);';
        this.elements.terminalView.appendChild(loadingOverlay);

        // Store reference for cleanup
        this.historyTerminal = historyTerminal;
        // Ensure stream aborts when we cleanup the viewer
        try {
            const origCleanup = this.cleanupHistoryTerminal.bind(this);
            this.cleanupHistoryTerminal = () => {
                try { if (this._historyStreamAbort) { this._historyStreamAbort.abort(); this._historyStreamAbort = null; } } catch (_) {}
                origCleanup();
            };
        } catch (_) {}
    }

    /**
     * Get terminal options for history viewer
     * @param {Object} sessionData - Session data
     * @returns {Object} Terminal options
     */
    getHistoryTerminalOptions(sessionData) {
        const terminalOptions = {
            cursorBlink: false,
            fontSize: 14,
            fontFamily: 'Consolas, "Courier New", monospace',
            theme: getXtermTheme(getEffectiveTheme(), { interactive: false }),
            scrollback: 50000, // Large scrollback for history
            disableStdin: true, // Make it read-only
            allowTransparency: false
        };

        // Set initial size from session data if available
        if (sessionData.terminal_size) {
            terminalOptions.cols = sessionData.terminal_size.cols;
            terminalOptions.rows = sessionData.terminal_size.rows;
        }

        return terminalOptions;
    }

    /**
     * Setup render complete handler to remove loading overlay
     * @param {Terminal} terminal - xterm.js terminal instance
     */
    setupRenderCompleteHandler(terminal) {
        let renderCount = 0;
        const maxRenders = 3; // Wait for a few render cycles to ensure completion
        let renderDisposable = null;
        const onRenderComplete = () => {
            renderCount++;
            if (renderCount >= maxRenders) {
                if (renderDisposable) {
                    renderDisposable.dispose(); // Clean up the listener
                }
                setTimeout(() => {
                    const overlay = this.elements.terminalView.querySelector('.terminal-loading-overlay');
                    if (overlay) {
                        overlay.remove();
                    }
                }, 100); // Small delay to ensure visibility
            }
        };
        renderDisposable = terminal.onRender(onRenderComplete);
    }

    /**
     * Setup keyboard shortcuts for history terminal
     * @param {Terminal} terminal - xterm.js terminal instance
     */
    setupHistoryKeyboardShortcuts(terminal) {
        terminal.attachCustomKeyEventHandler((event) => {
            // Handle Home key - scroll to top
            if (event.key === 'Home' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                terminal.scrollToTop();
                return false; // Prevent default terminal handling
            }
            
            // Handle End key - scroll to bottom
            if (event.key === 'End' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                terminal.scrollToBottom();
                return false; // Prevent default terminal handling
            }
            
            // Allow other keys to be handled normally
            return true;
        });
    }


    /**
     * Handle link clicks in history terminal
     * @param {string} href - The URL to handle
     */
    handleHistoryLinkClick(href) {
        // Create a temporary popup for the URL on mobile
        if (this.historyMobileUrlPopup) {
            document.body.removeChild(this.historyMobileUrlPopup);
            clearTimeout(this.historyMobileUrlPopupTimeout);
        }
        
        const popup = document.createElement('div');
        popup.className = 'mobile-url-popup';
        popup.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            right: 20px;
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 12px;
            z-index: 10000;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        `;
        
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.gap = '10px';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = href;
        input.readOnly = true;
        Object.assign(input.style, {
            flex: '1', padding: '8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
            borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '12px'
        });
        row.appendChild(input);

        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy';
        Object.assign(copyBtn.style, {
            padding: '8px 12px', background: 'var(--button-primary)', color: 'white', border: 'none',
            borderRadius: '4px', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap'
        });
        copyBtn.addEventListener('click', async function() {
            try { await navigator.clipboard.writeText(href); copyBtn.textContent = 'Copied!'; setTimeout(() => copyBtn.textContent = 'Copy', 1000); } catch (_) {}
        });
        row.appendChild(copyBtn);

        const openBtn = document.createElement('button');
        openBtn.textContent = 'Open';
        Object.assign(openBtn.style, {
            padding: '8px 12px', background: 'var(--success)', color: 'white', border: 'none',
            borderRadius: '4px', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap'
        });
        openBtn.addEventListener('click', () => {
            try {
                if (window.desktop && window.desktop.isElectron && typeof window.desktop.openExternal === 'function') {
                    window.desktop.openExternal(href);
                } else {
                    window.open(href, '_blank');
                }
            } catch (_) {
                try { window.open(href, '_blank'); } catch (_) {}
            }
        });
        row.appendChild(openBtn);

        popup.appendChild(row);
        
        document.body.appendChild(popup);
        this.historyMobileUrlPopup = popup;
        
        // Auto-hide after 10 seconds
        this.historyMobileUrlPopupTimeout = setTimeout(() => {
            this.hideHistoryMobileUrlPopup();
        }, 10000);
        
        // Allow manual close by clicking on the popup
        popup.addEventListener('click', (e) => {
            if (e.target === popup) {
                this.hideHistoryMobileUrlPopup();
            }
        });
    }

    /**
     * Hide the mobile URL popup for history terminal
     */
    hideHistoryMobileUrlPopup() {
        if (this.historyMobileUrlPopup) {
            document.body.removeChild(this.historyMobileUrlPopup);
            this.historyMobileUrlPopup = null;
        }
        if (this.historyMobileUrlPopupTimeout) {
            clearTimeout(this.historyMobileUrlPopupTimeout);
            this.historyMobileUrlPopupTimeout = null;
        }
    }

    /**
     * Clean up history terminal and related resources
     */
    cleanupHistoryTerminal() {
        if (this.historyTerminal) {
            this.historyTerminal.dispose();
            this.historyTerminal = null;
            this.historyFitAddon = null;
        }
        
        if (this.historyAutoCopyCleanup) {
            this.historyAutoCopyCleanup();
            this.historyAutoCopyCleanup = null;
        }
        
        this.hideHistoryMobileUrlPopup();
    }

    /**
     * Clear the terminal view
     */
    clearTerminalView() {
        while (this.elements.terminalView.firstChild) {
            this.elements.terminalView.removeChild(this.elements.terminalView.firstChild);
        }
        // Remove empty-state Enter key handler if present
        if (this._emptyStateKeyHandler) {
            document.removeEventListener('keydown', this._emptyStateKeyHandler, true);
            this._emptyStateKeyHandler = null;
        }
    }

    /**
     * Show loading placeholder in terminal view
     * @param {string} message - Loading message to display
     */
    showLoadingPlaceholder(message = 'Loading...') {
        const loadingPlaceholder = document.createElement('div');
        loadingPlaceholder.className = 'terminal-placeholder';
        loadingPlaceholder.innerHTML = `<p>${message}</p>`;
        this.elements.terminalView.appendChild(loadingPlaceholder);
    }

    /**
     * Show empty state placeholder
     * @param {string} message - Message to display
     */
    showEmptyPlaceholder(message = 'Select or create a session') {
        this.hideTerminalControls();
        try {
            this.terminalManager?.sessionTabsManager?.disable?.();
        } catch (_) {}
        this.elements.terminalView.innerHTML = `
            <div class="terminal-placeholder empty-state-container">
                <p>${message}</p>
                <button id="new-session-cta" class="btn btn-primary">+ Session</button>
            </div>`;

        // Wire up CTA
        const cta = this.elements.terminalView.querySelector('#new-session-cta');
        if (cta) {
            cta.addEventListener('click', (e) => {
                e.preventDefault();
                try { this.terminalManager?.showNewSessionModal?.(); } catch (_) {}
            });
        }

        // Install Enter-to-create handler while empty state is visible
        if (this._emptyStateKeyHandler) {
            document.removeEventListener('keydown', this._emptyStateKeyHandler, true);
        }
        this._emptyStateKeyHandler = (evt) => {
            // Ignore if a modal is already open or focus is in input fields
            const isInput = (el) => {
                if (!el) return false;
                const tag = (el.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return true;
                return el.closest && !!el.closest('input, textarea, [contenteditable="true"]');
            };
            // Ignore key events that originate from open dropdown menus (e.g., Global Links)
            const fromMenu = (() => {
                try {
                    const t = evt.target;
                    if (!t) return false;
                    if (t.closest && (t.closest('#global-links-container') || t.closest('#global-links-dropdown'))) return true;
                    if (t.closest && t.closest('[role="menu"], .dropdown-menu')) return true;
                } catch (_) {}
                try {
                    const dropdown = document.getElementById('global-links-dropdown');
                    if (dropdown && dropdown.classList.contains('show')) return true;
                } catch (_) {}
                return false;
            })();
            // Suppress empty-state Enter shortcut while any modal is open
            const anyModalOpen = isAnyModalOpen();
            const placeholderPresent = !!this.elements.terminalView.querySelector('.empty-state-container');
            if (!placeholderPresent || anyModalOpen || isInput(evt.target) || fromMenu) return;
            if (evt.key === 'Enter' && !evt.shiftKey && !evt.ctrlKey && !evt.altKey && !evt.metaKey) {
                evt.preventDefault();
                try { this.terminalManager?.showNewSessionModal?.(); } catch (_) {}
            }
        };
        document.addEventListener('keydown', this._emptyStateKeyHandler, true);
    }

    /**
     * Show attach button for unattached sessions
     * @param {Object} sessionData - Session data
     */
    showAttachButton(sessionData) {
        const attachContainer = document.createElement('div');
        attachContainer.className = 'attach-button-container terminal-placeholder';
        attachContainer.innerHTML = `
            <div class="attach-prompt">
                <p>Session "${sessionData.title || sessionData.session_id}" is ready</p>
                <button id="attach-session-btn" class="btn btn-primary attach-session-btn">
                    Attach
                </button>
                <p class="attach-description">Click "Attach" to connect to the terminal session</p>
            </div>
        `;

        // Add click handler for the attach button
        const attachButton = attachContainer.querySelector('#attach-session-btn');
        if (attachButton) {
            attachButton.addEventListener('click', () => {
                // Call the terminal manager's attach method
                if (this.terminalManager && this.terminalManager.attachToCurrentSession) {
                    this.terminalManager.attachToCurrentSession();
                }
            });
        }

        this.elements.terminalView.innerHTML = '';
        this.elements.terminalView.appendChild(attachContainer);
    }

    /**
     * Show load history button for terminated sessions
     * @param {Object} sessionData - Session data
     */
    showLoadHistoryButton(sessionData) {
        const historyContainer = document.createElement('div');
        historyContainer.className = 'load-history-button-container terminal-placeholder';
        historyContainer.innerHTML = `
            <div class="attach-prompt">
                <p>Session "${sessionData.title || sessionData.session_id}" has terminated</p>
                <button id="load-history-btn" class="btn btn-info load-history-btn">
                    📜 Load History
                </button>
                <p class="attach-description">Click "Load History" or press Enter to view the session history</p>
            </div>
        `;

        // Add click handler for the load history button
        const loadHistoryButton = historyContainer.querySelector('#load-history-btn');
        if (loadHistoryButton) {
            loadHistoryButton.addEventListener('click', () => {
                // Call the terminal manager's load history method
                if (this.terminalManager && this.terminalManager.loadSessionHistory) {
                    this.terminalManager.loadSessionHistory(sessionData.session_id);
                }
            });
        }

        this.elements.terminalView.innerHTML = '';
        this.elements.terminalView.appendChild(historyContainer);
    }

    /**
     * Calculate terminal size based on container dimensions
     * @returns {Object} Terminal size with cols and rows
     */
    calculateTerminalSize() {
        // Get terminal view dimensions with fallbacks
        const terminalView = this.elements.terminalView;
        let containerWidth = terminalView ? terminalView.clientWidth : 0;
        let containerHeight = terminalView ? terminalView.clientHeight : 0;
        
        // If the terminal view doesn't have dimensions yet, use the parent container
        if (containerWidth === 0 || containerHeight === 0) {
            const terminalMain = document.querySelector('.terminal-main');
            if (terminalMain) {
                containerWidth = terminalMain.clientWidth || 800; // fallback to 800px
                containerHeight = terminalMain.clientHeight || 600; // fallback to 600px
            } else {
                // Ultimate fallback if no containers have dimensions
                containerWidth = 800;
                containerHeight = 600;
            }
        }
        
        // If we still don't have valid dimensions, return reasonable defaults
        if (containerWidth === 0 || containerHeight === 0) {
            return { cols: 80, rows: 24 };
        }
        
        // Calculate terminal size using character dimensions
        // This avoids the xterm.js rendering issues
        const charWidth = 9;  // Approximate character width in pixels
        const charHeight = 17; // Approximate character height in pixels
        const padding = 20;    // Account for padding/scrollbars
        
        const cols = Math.floor((containerWidth - padding) / charWidth);
        const rows = Math.floor((containerHeight - padding) / charHeight);
        
        return { 
            cols: Math.max(cols, 40), // minimum 40 cols
            rows: Math.max(rows, 10)  // minimum 10 rows
        };
    }

    /**
     * Hide terminal control buttons
     */
    hideTerminalControls() {
        // Hide terminal-specific control buttons
        if (this.elements.clearBtn) this.elements.clearBtn.style.display = 'none';
        if (this.elements.detachBtn) this.elements.detachBtn.style.display = 'none';
        if (this.elements.closeBtn) this.elements.closeBtn.style.display = 'none';
        if (this.elements.deleteBtn) this.elements.deleteBtn.style.display = 'none';
        if (this.elements.textInputBtn) this.elements.textInputBtn.style.display = 'inline-flex';

        // Hide session links container
        if (this.elements.sessionLinksContainer) {
            this.elements.sessionLinksContainer.style.display = 'none';
        }

        // Keep mobile keyboard visible for navigation shortcuts
        if (this.elements.mobileKeyboardBtn) this.elements.mobileKeyboardBtn.style.display = 'block';


    }

    /**
     * Show delete controls for terminated sessions
     * @param {Object} sessionData - Session data
     */
    showDeleteControls(sessionData) {
        const setDisplay = (el, value) => {
            if (!el) return;
            try { el.style.setProperty('display', value, 'important'); } catch (_) { el.style.display = value; }
        };

        // Reuse for terminated/history view: show Close and keep input/keyboard visible
        setDisplay(this.elements.clearBtn, 'none');
        setDisplay(this.elements.detachBtn, 'none');
        setDisplay(this.elements.deleteBtn, 'none');
        setDisplay(this.elements.textInputBtn, 'inline-flex');
        if (this.elements.closeBtn) {
            setDisplay(this.elements.closeBtn, 'inline-flex');
            this.elements.closeBtn.textContent = 'Close';
            this.elements.closeBtn.title = 'Close session';
        }

        // Hide session links container for inactive sessions
        if (this.elements.sessionLinksContainer) {
            this.elements.sessionLinksContainer.style.display = 'none';
        }

        // Show mobile keyboard button for inactive sessions
        if (this.elements.mobileKeyboardBtn) this.elements.mobileKeyboardBtn.style.display = 'block';
    }

    /**
     * Show terminal control buttons
     * @param {Object} sessionData - Session data with interactive flag
     */
    showTerminalControls(sessionData) {
        const isInteractive = sessionData && sessionData.interactive !== false && sessionData.is_active !== false;
        const isTerminated = sessionData && sessionData.is_active === false;
        const setDisplay = (el, value) => {
            if (!el) return;
            try { el.style.setProperty('display', value, 'important'); } catch (_) { el.style.display = value; }
        };
        try {
            const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalLogs || appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs);
            if (dbg) {
                console.log('[TerminalViewController] showTerminalControls', {
                    sessionId: sessionData?.session_id,
                    isTerminated,
                    isInteractive
                });
            }
        } catch (_) {}
        
        // Debug: Log which elements are missing
        const missingElements = [];
        ['clearBtn', 'detachBtn', 'closeBtn', 'textInputBtn'].forEach(elementName => {
            if (!this.elements[elementName]) {
                missingElements.push(elementName);
            }
        });
        try {
            const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalLogs || appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs);
            if (dbg && missingElements.length > 0) {
                console.debug('[TerminalViewController] Missing elements:', missingElements);
            }
        } catch (_) {}
        
        // Update attach/detach button text and functionality based on current attachment state
        this.updateAttachDetachButton(sessionData);

        if (isTerminated) {
            setDisplay(this.elements.clearBtn, 'none');
            setDisplay(this.elements.detachBtn, 'none');
            setDisplay(this.elements.deleteBtn, 'none');
            setDisplay(this.elements.textInputBtn, 'inline-flex');
            if (this.elements.closeBtn) {
                setDisplay(this.elements.closeBtn, 'inline-flex');
                this.elements.closeBtn.textContent = 'Close';
                this.elements.closeBtn.title = 'Close session';
            }
            if (this.elements.sessionLinksContainer) {
                this.elements.sessionLinksContainer.style.display = 'none';
            }
            // Keep text input and mobile keyboard visible for read-only history view
            setDisplay(this.elements.textInputBtn, 'inline-flex');
            setDisplay(this.elements.mobileKeyboardBtn, 'block');
            // Hide prompts dropdown for terminated sessions
            if (this.elements.promptsDropdownContainer) {
                setDisplay(this.elements.promptsDropdownContainer, 'none');
            }
            try { this.terminalManager?.closePromptsDropdown?.(); } catch (_) {}
            return;
        }

        if (isInteractive) {
            // Show all controls for interactive sessions
            setDisplay(this.elements.clearBtn, 'inline-flex');
            // For local-only desktop sessions, hide the Attach/Detach control entirely
            try {
                const isLocal = !!(sessionData && sessionData.local_only === true);
                const inDesktop = !!(window.desktop && window.desktop.isElectron);
                if (isLocal && inDesktop) {
                    setDisplay(this.elements.detachBtn, 'none');
                } else {
                    setDisplay(this.elements.detachBtn, 'inline-flex');
                }
            } catch (_) { setDisplay(this.elements.detachBtn, 'inline-flex'); }
            setDisplay(this.elements.closeBtn, 'inline-flex');
            setDisplay(this.elements.deleteBtn, 'none');
            setDisplay(this.elements.textInputBtn, 'inline-flex');
            if (this.elements.closeBtn) this.elements.closeBtn.textContent = this.terminalManager?.sessionToolbarController?._terminateLabel || 'Terminate';
            
            // Show session links container only when enabled in preferences AND links exist
            if (this.elements.sessionLinksContainer) {
                try {
                    const enabled = appStore?.getState?.('preferences.links.showSessionToolbarMenu') === true;
                    const count = (sessionData?.links || []).length;
                    this.elements.sessionLinksContainer.style.display = (enabled && count > 0) ? 'inline-block' : 'none';
                } catch (_) {
                    // Fallback: hide when any error occurs
                    this.elements.sessionLinksContainer.style.display = 'none';
                }
            }
            
            // Show mobile keyboard button for interactive sessions
            if (this.elements.mobileKeyboardBtn) {
                this.elements.mobileKeyboardBtn.style.display = 'block';
            }
            // Show prompts dropdown button for interactive sessions
            if (this.elements.promptsDropdownContainer) {
                setDisplay(this.elements.promptsDropdownContainer, 'inline-flex');
            }
            // Local-only: do not show Attach/Detach in desktop
            try {
                const isLocal = !!(sessionData && sessionData.local_only === true);
                const inDesktop = !!(window.desktop && window.desktop.isElectron);
                if (isLocal && inDesktop && this.elements.detachBtn) {
                    setDisplay(this.elements.detachBtn, 'none');
                }
            } catch (_) {}
        } else {
            // Show limited controls for non-interactive sessions
            setDisplay(this.elements.clearBtn, 'none');
            // For local-only desktop sessions, hide the Attach/Detach control entirely
            try {
                const isLocal = !!(sessionData && sessionData.local_only === true);
                const inDesktop = !!(window.desktop && window.desktop.isElectron);
                if (isLocal && inDesktop) {
                    setDisplay(this.elements.detachBtn, 'none');
                } else {
                    setDisplay(this.elements.detachBtn, 'inline-flex');
                }
            } catch (_) { setDisplay(this.elements.detachBtn, 'inline-flex'); }
            setDisplay(this.elements.closeBtn, 'inline-flex');
            setDisplay(this.elements.deleteBtn, 'none');
            setDisplay(this.elements.textInputBtn, 'inline-flex');
            if (this.elements.closeBtn) this.elements.closeBtn.textContent = this.terminalManager?.sessionToolbarController?._terminateLabel || 'Terminate';
            
            // Hide session links container for non-interactive sessions
            if (this.elements.sessionLinksContainer) {
                this.elements.sessionLinksContainer.style.display = 'none';
            }
            
            // Show mobile keyboard button for non-interactive sessions
            if (this.elements.mobileKeyboardBtn) {
                this.elements.mobileKeyboardBtn.style.display = 'block';
            }
            // Hide prompts dropdown when session is non-interactive
            if (this.elements.promptsDropdownContainer) {
                setDisplay(this.elements.promptsDropdownContainer, 'none');
            }
            try { this.terminalManager?.closePromptsDropdown?.(); } catch (_) {}
            // Local-only: do not show Attach/Detach in desktop for non-interactive sessions either
            try {
                const isLocal = !!(sessionData && sessionData.local_only === true);
                const inDesktop = !!(window.desktop && window.desktop.isElectron);
                if (isLocal && inDesktop && this.elements.detachBtn) {
                    setDisplay(this.elements.detachBtn, 'none');
                }
            } catch (_) {}
        }
    }

    /**
     * Update attach/detach button text and functionality based on current attachment state
     * @param {Object} sessionData - Session data
     */
    updateAttachDetachButton(sessionData) {
        if (!this.elements.detachBtn || !sessionData) {
            return;
        }

        // Check if current session is attached by looking at:
        // 1. If there's a current session and it matches this session ID and is attached
        // 2. If this session is in the terminal manager's attached sessions set
        const sessionId = sessionData.session_id;
        const isTerminated = sessionData.is_active === false;
        const isLocalOnly = !!(sessionData && sessionData.local_only === true);
        const inDesktop = !!(window.desktop && window.desktop.isElectron);
        const currentSession = this.terminalManager.currentSession;
        const isCurrentSessionAttached = currentSession && 
            currentSession.sessionId === sessionId && 
            currentSession.isAttached;
        
        const isInAttachedSet = this.terminalManager.attachedSessions && 
            this.terminalManager.attachedSessions.has(sessionId);
        
        if (isTerminated) {
            this.elements.detachBtn.textContent = 'Ended';
            this.elements.detachBtn.title = 'Session ended';
            this.elements.detachBtn.disabled = true;
            this.elements.detachBtn.classList.add('button-disabled');
            try { this.elements.detachBtn.style.display = 'none'; } catch (_) {}
            return;
        }

        // Local-only desktop sessions: hide detach/attach control entirely
        if (isLocalOnly && inDesktop) {
            try { this.elements.detachBtn.style.display = 'none'; } catch (_) {}
            return;
        }

        this.elements.detachBtn.disabled = false;
        this.elements.detachBtn.classList.remove('button-disabled');
        try { this.elements.detachBtn.style.display = 'inline-flex'; } catch (_) {}

        const isAttached = isCurrentSessionAttached || isInAttachedSet;

        // Update button text and title
        if (isAttached) {
            this.elements.detachBtn.textContent = 'Detach';
            this.elements.detachBtn.title = 'Detach session';
        } else {
            this.elements.detachBtn.textContent = 'Attach';
            this.elements.detachBtn.title = 'Attach session';
        }
    }

    /**
     * Check if running on mobile device
     * @returns {boolean} True if mobile device
     */
    isMobile() {
        const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const isCapacitor = (() => { try { return !!window.Capacitor; } catch (_) { return false; } })();
        const widthMobile = (window.innerWidth <= 768);
        const landscapeTouch = ('ontouchstart' in window && window.innerWidth > window.innerHeight && window.innerWidth <= 1366);
        return uaMobile || widthMobile || landscapeTouch || isCapacitor;
    }

    /**
     * Fit terminal to container if history terminal exists
     */
    fitHistoryTerminal() {
        if (this.historyFitAddon) {
            this.historyFitAddon.fit();
        }
    }
}
