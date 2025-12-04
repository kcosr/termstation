import { MobileKeyboardDrag } from '../../utils/mobile-keyboard-drag.js';
import { TextInputModalDrag } from '../../utils/text-input-modal-drag.js';
import { TerminalAutoCopy } from '../../utils/terminal-auto-copy.js';
import { getStateStore } from '../../core/state-store/index.js';
import { debouncedSet as debouncedStateSet } from '../../core/state-store/debounced.js';
import { queueStateSet } from '../../core/state-store/batch.js';

/**
 * Mobile Interface Manager - Handles all mobile-specific functionality for terminals
 * Extracted from Terminal Manager to improve maintainability and performance
 */


export class MobileInterfaceManager {
    constructor(terminalManager) {
        this.terminalManager = terminalManager;
        
        // Mobile keyboard drag handler
        this.keyboardDrag = null;
        
        // Text input modal drag handler
        this.textInputDrag = null;
        // Text input modal resize observer
        this._textInputResizeObserver = null;
        this._textInputResizeActive = false;
        
        // Mobile-specific DOM elements (references from terminal manager)
        this.elements = {
            mobileKeyboardBtn: null,
            mobileKeyboardDropdown: null,
            mobileKeyboardBackdrop: null,
            mobileScrollForwardBtn: null,
            textInputModal: null
        };
        
        // Touch event state for history scrolling
        this.touchState = {
            startY: 0,
            startX: 0,
            lastY: 0,
            lastTime: 0,
            velocity: 0,
            isScrolling: false,
            longPressTimer: null,
            initialTouchPos: null
        };
        
        this.initialized = false;
    }
    
    /**
     * Initialize mobile interface with DOM elements from terminal manager
     */
    initialize(elements, textInputModal) {
        this.elements = { ...elements };
        this.textInputModal = textInputModal;
        
        this.setupMobileKeyboardDrag();
        this.setupTextInputModalDrag();
        this.setupMobileKeyListeners();
        this.setupTextInputButtonHandlers();
        this.setupMobileKeyboardButton();
        this.setupMobileScrollForwardingButton();
        
        // Initialize button states from persistent state
        this.initializeScrollForwardingButtonState();
        
        // Restore overlay states
        this.restoreOverlayStates();
        
        this.initialized = true;
    }
    
    /**
     * Setup drag functionality for mobile keyboard
     */
    setupMobileKeyboardDrag() {
        this.keyboardDrag = new MobileKeyboardDrag(this.elements.mobileKeyboardDropdown, {
            onDragStart: () => this.handleKeyboardDragStart(),
            onDragEnd: () => this.handleKeyboardDragEnd(),
            onPositionChange: (x, y) => this.handleKeyboardPositionChange(x, y)
        });
    }
    
    /**
     * Setup drag functionality for text input modal
     */
    setupTextInputModalDrag() {
        this.textInputDrag = new TextInputModalDrag(this.elements.textInputModal, {
            onDragStart: () => this.handleTextInputDragStart(),
            onDragEnd: () => this.handleTextInputDragEnd(),
            onPositionChange: (x, y) => this.handleTextInputPositionChange(x, y)
        });
    }

    /**
     * Apply saved size to the text input modal if present
     */
    applyTextInputSize() {
        try {
            const el = this.elements?.textInputModal;
            if (!el) return false;
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const st = res && res.ok ? (res.state || {}) : {};
            const saved = st['textInputModalSize'];
            if (!saved) return false;
            const size = typeof saved === 'string' ? JSON.parse(saved) : saved;
            const w = parseInt(size?.width, 10);
            const h = parseInt(size?.height, 10);
            if (Number.isFinite(w) && w > 0) el.style.width = `${w}px`;
            if (Number.isFinite(h) && h > 0) el.style.height = `${h}px`;
            return true;
        } catch (_) { return false; }
    }

    /**
     * Start tracking text input modal size changes and persist them
     */
    startTextInputResizeTracking() {
        try {
            const el = this.elements?.textInputModal;
            if (!el || typeof ResizeObserver === 'undefined') return;
            if (this._textInputResizeObserver) return; // already tracking
            this._textInputResizeActive = true;
            const parsePx = (val) => {
                if (!val || typeof val !== 'string') return NaN;
                const n = parseFloat(val);
                return Number.isFinite(n) ? n : NaN;
            };
            this._textInputResizeObserver = new ResizeObserver((entries) => {
                try {
                    if (!this._textInputResizeActive) return;
                    const entry = entries && entries[0];
                    const target = entry?.target || el;
                    // Ignore when not visible to avoid saving zero/min sizes after hide
                    try {
                        const cs = window.getComputedStyle(target);
                        if (cs.display === 'none' || !target.classList?.contains('show')) return;
                    } catch (_) {}
                    const rect = target.getBoundingClientRect();
                    let width = Math.round(rect.width);
                    let height = Math.round(rect.height);
                    // Clamp to computed min/max to avoid shrinking too small or exceeding viewport caps
                    try {
                        const cs = window.getComputedStyle(target);
                        const minW = parsePx(cs.minWidth);
                        const maxW = parsePx(cs.maxWidth);
                        const minH = parsePx(cs.minHeight);
                        const maxH = parsePx(cs.maxHeight);
                        if (Number.isFinite(minW)) width = Math.max(width, Math.round(minW));
                        if (Number.isFinite(maxW)) width = Math.min(width, Math.round(maxW));
                        if (Number.isFinite(minH)) height = Math.max(height, Math.round(minH));
                        if (Number.isFinite(maxH)) height = Math.min(height, Math.round(maxH));
                        // Enforce against viewport as a hard cap for safety
                        width = Math.max(160, Math.min(width, Math.max(200, window.innerWidth - 20)));
                        height = Math.max(120, Math.min(height, Math.max(140, window.innerHeight - 20)));
                        // Apply clamped dimensions back to style to avoid lingering too-small sizes
                        target.style.width = `${width}px`;
                        target.style.height = `${height}px`;
                    } catch (_) {}
                    debouncedStateSet('textInputModalSize', { width, height }, 200);
                } catch (_) {}
            });
            this._textInputResizeObserver.observe(el);
        } catch (_) { /* ignore */ }
    }

    /**
     * Stop tracking text input modal size changes
     */
    stopTextInputResizeTracking() {
        try {
            this._textInputResizeActive = false;
            if (this._textInputResizeObserver) {
                this._textInputResizeObserver.disconnect();
                this._textInputResizeObserver = null;
            }
        } catch (_) { /* ignore */ }
    }
    
    /**
     * Setup mobile keyboard button click handler
     */
    setupMobileKeyboardButton() {
        this.elements.mobileKeyboardBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleMobileKeyboard();
        });
        
        // Mobile keyboard close button
        const mobileKeyboardClose = document.getElementById('mobile-keyboard-close');
        if (mobileKeyboardClose) {
            mobileKeyboardClose.addEventListener('click', (e) => {
                // Check if click should be blocked due to drag state
                if (this.keyboardDrag.shouldBlockKeyPress()) {
                    return;
                }
                this.hideMobileKeyboard();
            });
        }
    }
    
    /**
     * Setup mobile scroll forwarding button click handler
     */
    setupMobileScrollForwardingButton() {
        this.elements.mobileScrollForwardBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleMobileScrollForwarding();
        });
    }
    
    /**
     * Setup direct event listeners on mobile keyboard keys
     */
    setupMobileKeyListeners() {
        if (!this.elements.mobileKeyboardDropdown) return;
        
        // Get all mobile key buttons directly
        const mobileKeys = this.elements.mobileKeyboardDropdown.querySelectorAll('.mobile-key');
        
        mobileKeys.forEach(keyButton => {
            const keyValue = keyButton.dataset.key;
            if (!keyValue) return;
            
            // Track touch handling state  
            let touchHandled = false;
            
            // Click handler for desktop/mouse
            keyButton.addEventListener('click', (e) => {
                // Check if click should be blocked due to drag state
                if (this.keyboardDrag.shouldBlockKeyPress()) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                
                e.preventDefault();
                e.stopPropagation();
                
                // Skip if touch was already handled
                if (touchHandled) {
                    touchHandled = false;
                    return;
                }
                
                this.sendMobileKey(keyValue);
            });
            
            // Direct touch handler for mobile
            keyButton.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Check if touch should be blocked due to drag state
                if (this.keyboardDrag.shouldBlockKeyPress()) {
                    touchHandled = true;
                    setTimeout(() => { touchHandled = false; }, 300);
                    return;
                }
                
                // Mark touch as handled to prevent click event
                touchHandled = true;
                
                this.sendMobileKey(keyValue);
                
                // Reset flag after a delay
                setTimeout(() => {
                    touchHandled = false;
                }, 300);
            });
            
            // Prevent default on touchstart to avoid delays
            keyButton.addEventListener('touchstart', (e) => {
                e.preventDefault();
            }, { passive: false });
            
            // Prevent mousedown to avoid focus issues
            keyButton.addEventListener('mousedown', (e) => {
                e.preventDefault();
            });
        });
    }
    
    /**
     * Setup text input modal button handlers with drag-aware click prevention
     */
    setupTextInputButtonHandlers() {
        // Get text input modal buttons (Send is handled by new modal system)
        const buttons = [
            { element: this.elements.textInputClear, action: () => this.terminalManager.clearTextInputText() }
        ];
        
        buttons.forEach(({ element, action }) => {
            if (!element) return;
            
            // Click handler for desktop/mouse
            element.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Check if click should be blocked due to drag state
                if (this.textInputDrag && this.textInputDrag.shouldBlockClick && this.textInputDrag.shouldBlockClick()) {
                    return;
                }
                
                action();
            });
            
            // Track touch handling state
            let touchHandled = false;
            
            // Direct touch handler for mobile
            element.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Check if touch has already been handled
                if (touchHandled) {
                    touchHandled = false;
                    return;
                }
                
                // Check if touch should be blocked due to drag state
                if (this.textInputDrag && this.textInputDrag.shouldBlockClick && this.textInputDrag.shouldBlockClick()) {
                    return;
                }
                
                // Mark touch as handled to prevent click event
                touchHandled = true;
                
                action();
            });
            
            // Prevent default on touchstart to avoid delays
            element.addEventListener('touchstart', (e) => {
                e.preventDefault();
            }, { passive: false });
        });
    }
    
    /**
     * Setup mobile scrolling for history terminal
     */
    setupHistoryMobileScrolling(historyTerminal, terminalContainer) {
        // Create an overlay to capture all touch events for history terminal
        const touchOverlay = document.createElement('div');
        try { touchOverlay.classList.add('terminal-touch-overlay'); } catch (_) {}
        touchOverlay.style.position = 'absolute';
        touchOverlay.style.top = '0';
        touchOverlay.style.left = '0';
        touchOverlay.style.width = '100%';
        touchOverlay.style.height = '100%';
        touchOverlay.style.zIndex = '1000';
        touchOverlay.style.touchAction = 'none';
        touchOverlay.style.backgroundColor = 'transparent';
        
        terminalContainer.appendChild(touchOverlay);
        
        // Disable native touch behavior on xterm elements
        const xtermElements = [
            terminalContainer.querySelector('.xterm-viewport'),
            terminalContainer.querySelector('.xterm-screen'),
            terminalContainer.querySelector('.xterm-rows')
        ];
        
        xtermElements.forEach(el => {
            if (el) {
                el.style.touchAction = 'none';
                el.addEventListener('touchstart', e => e.stopPropagation(), true);
                el.addEventListener('touchmove', e => e.stopPropagation(), true);
            }
        });
        
        // Reset touch state
        this.resetTouchState();
        
        // Touch event handlers
        touchOverlay.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            
            this.touchState.startY = e.touches[0].clientY;
            this.touchState.startX = e.touches[0].clientX;
            this.touchState.lastY = this.touchState.startY;
            this.touchState.lastTime = Date.now();
            this.touchState.velocity = 0;
            this.touchState.isScrolling = false;
            
            // Clear any existing long press timer
            if (this.touchState.longPressTimer) {
                clearTimeout(this.touchState.longPressTimer);
            }
            
            // Store initial touch position for long press
            this.touchState.initialTouchPos = { x: this.touchState.startX, y: this.touchState.startY };
            
            // Start long press timer (500ms)
            this.touchState.longPressTimer = setTimeout(() => {
                // Only trigger if touch hasn't moved significantly
                const currentTouch = e.touches[0] || { clientX: this.touchState.startX, clientY: this.touchState.startY };
                const dx = Math.abs(currentTouch.clientX - this.touchState.initialTouchPos.x);
                const dy = Math.abs(currentTouch.clientY - this.touchState.initialTouchPos.y);
                
                if (dx < 10 && dy < 10) {
                    this.handleHistoryLongPress(historyTerminal);
                }
                this.touchState.longPressTimer = null;
            }, 500);
            
        }, { passive: true });
        
        touchOverlay.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 1) return;
            
            const currentY = e.touches[0].clientY;
            const currentTime = Date.now();
            const deltaY = this.touchState.lastY - currentY;
            const deltaTime = currentTime - this.touchState.lastTime;
            
            // Calculate velocity
            if (deltaTime > 0) {
                this.touchState.velocity = deltaY / deltaTime;
            }
            
            // Check if we've moved enough to be considered scrolling
            const totalMoveY = Math.abs(this.touchState.startY - currentY);
            if (totalMoveY > 5) {
                this.touchState.isScrolling = true;
                
                // Clear long press timer since we're scrolling
                if (this.touchState.longPressTimer) {
                    clearTimeout(this.touchState.longPressTimer);
                    this.touchState.longPressTimer = null;
                }
            }
            
            if (this.touchState.isScrolling) {
                // Prevent default scrolling behavior
                e.preventDefault();
                
                // Apply scrolling to the terminal
                const viewport = terminalContainer.querySelector('.xterm-viewport');
                if (viewport) {
                    const scrollAmount = deltaY * 2;
                    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, viewport.scrollTop + scrollAmount));
                }
            }
            
            this.touchState.lastY = currentY;
            this.touchState.lastTime = currentTime;
        }, { passive: false });
        
        touchOverlay.addEventListener('touchend', () => {
            // Clear long press timer if still active
            if (this.touchState.longPressTimer) {
                clearTimeout(this.touchState.longPressTimer);
                this.touchState.longPressTimer = null;
            }
            
            // Handle momentum scrolling if we were scrolling and have significant velocity
            if (this.touchState.isScrolling && Math.abs(this.touchState.velocity) > 0.5) {
                this.handleMomentumScroll(terminalContainer);
            }
            
            // Reset state
            this.resetTouchState();
        }, { passive: true });
    }
    
    /**
     * Handle long press on history terminal for text selection
     */
    handleHistoryLongPress(historyTerminal) {
        if (!historyTerminal || !historyTerminal.hasSelection()) return;
        
        const selectedText = historyTerminal.getSelection();
        if (!selectedText || selectedText.length === 0) return;
        
        // Remove newlines and extra spaces to handle wrapped URLs
        const normalizedText = selectedText.replace(/\n/g, '').replace(/\s+/g, ' ').trim();
        
        // Check if selection contains a URL
        const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/i;
        const urlMatch = normalizedText.match(urlRegex);
        
        if (urlMatch) {
            // Extract just the URL from the selection
            const extractedUrl = urlMatch[0];
            const originalSelection = selectedText.trim();
            this.showHistoryMobileUrlPopup(extractedUrl, originalSelection, historyTerminal);
        } else {
            // Auto-copy the selected text; fall back to utility if manager method not available
            if (this.terminalManager && typeof this.terminalManager.handleAutocopiedText === 'function') {
                this.terminalManager.handleAutocopiedText(selectedText, null);
            } else {
                const refocus = () => { try { historyTerminal && historyTerminal.focus && historyTerminal.focus(); } catch(_){} };
                TerminalAutoCopy.copyToClipboard(selectedText, 'mobile-history', refocus);
            }
        }
    }
    
    /**
     * Handle momentum scrolling animation
     */
    handleMomentumScroll(terminalContainer) {
        const viewport = terminalContainer.querySelector('.xterm-viewport');
        if (!viewport) return;
        
        let velocity = this.touchState.velocity;
        const friction = 0.95;
        const minVelocity = 0.1;
        
        const animate = () => {
            if (Math.abs(velocity) < minVelocity) return;
            
            velocity *= friction;
            const scrollAmount = velocity * 16; // 60fps approximation
            
            viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, viewport.scrollTop + scrollAmount));
            
            requestAnimationFrame(animate);
        };
        
        requestAnimationFrame(animate);
    }
    
    /**
     * Reset touch state
     */
    resetTouchState() {
        this.touchState = {
            startY: 0,
            startX: 0,
            lastY: 0,
            lastTime: 0,
            velocity: 0,
            isScrolling: false,
            longPressTimer: null,
            initialTouchPos: null
        };
    }
    
    /**
     * Show mobile URL popup for history terminal
     */
    showHistoryMobileUrlPopup(url, originalSelection = null, historyTerminal) {
        // Remove any existing popup
        this.hideHistoryMobileUrlPopup();
        
        // Create popup container
        const popup = document.createElement('div');
        popup.id = 'history-mobile-url-popup';
        popup.className = 'mobile-url-popup';
        
        // Create popup content
        const content = document.createElement('div');
        content.className = 'mobile-url-popup-content';
        
        // URL display
        const urlDisplay = document.createElement('div');
        urlDisplay.className = 'mobile-url-display';
        urlDisplay.textContent = url;
        content.appendChild(urlDisplay);
        
        // Button container
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'mobile-url-buttons';
        
        // Copy URL button
        const copyButton = document.createElement('button');
        copyButton.className = 'mobile-url-btn copy-btn';
        copyButton.textContent = 'Copy URL';
        copyButton.addEventListener('click', () => {
            this.terminalManager.handleAutocopiedText(url, null);
            this.hideHistoryMobileUrlPopup();
        });
        buttonContainer.appendChild(copyButton);
        
        // Copy Selection button (if different from URL)
        if (originalSelection && originalSelection !== url) {
            const copySelectionButton = document.createElement('button');
            copySelectionButton.className = 'mobile-url-btn copy-selection-btn';
            copySelectionButton.textContent = 'Copy Selection';
            copySelectionButton.addEventListener('click', () => {
                this.terminalManager.handleAutocopiedText(originalSelection, null);
                this.hideHistoryMobileUrlPopup();
            });
            buttonContainer.appendChild(copySelectionButton);
        }
        
        // Open URL button
        const openButton = document.createElement('button');
        openButton.className = 'mobile-url-btn open-btn';
        openButton.textContent = 'Open';
        openButton.addEventListener('click', () => {
            window.open(url, '_blank');
            this.hideHistoryMobileUrlPopup();
        });
        buttonContainer.appendChild(openButton);
        
        // Cancel button
        const cancelButton = document.createElement('button');
        cancelButton.className = 'mobile-url-btn cancel-btn';
        cancelButton.textContent = 'Cancel';
        cancelButton.addEventListener('click', () => {
            this.hideHistoryMobileUrlPopup();
        });
        buttonContainer.appendChild(cancelButton);
        
        content.appendChild(buttonContainer);
        popup.appendChild(content);
        
        // Add to page
        document.body.appendChild(popup);
        
        // Position popup at center of screen
        popup.style.position = 'fixed';
        popup.style.top = '50%';
        popup.style.left = '50%';
        popup.style.transform = 'translate(-50%, -50%)';
        popup.style.zIndex = '10002';
        
        // Show popup with animation
        setTimeout(() => {
            popup.classList.add('show');
        }, 10);
        
        // Clear text selection
        if (historyTerminal) {
            historyTerminal.clearSelection();
        }
    }
    
    /**
     * Hide mobile URL popup
     */
    hideHistoryMobileUrlPopup() {
        const popup = document.getElementById('history-mobile-url-popup');
        if (popup) {
            popup.remove();
        }
    }
    
    // Mobile keyboard functionality
    
    /**
     * Toggle mobile keyboard visibility
     */
    toggleMobileKeyboard() {
        const dropdown = this.elements.mobileKeyboardDropdown;
        if (!dropdown) return;
        
        if (dropdown.classList.contains('show')) {
            this.hideMobileKeyboard();
        } else {
            this.showMobileKeyboard();
        }
    }
    
    /**
     * Show mobile keyboard
     */
    showMobileKeyboard() {
        const dropdown = this.elements.mobileKeyboardDropdown;
        const keyboardBtn = document.getElementById('mobile-keyboard-btn');
        if (!dropdown) return;
        
        // Apply saved position if available
        if (!this.keyboardDrag.applyPosition()) {
            // Default center position
            dropdown.style.transform = 'translate(-50%, -50%)';
            dropdown.style.left = '50%';
            dropdown.style.top = '50%';
        }
        
        // Restore z-index from localStorage or bring to front
        this.restoreOrSetZIndex('mobileKeyboard');
        
        dropdown.classList.add('show');
        keyboardBtn?.classList.add('active');
        
        // Save toggle state
        try { queueStateSet('mobileKeyboardVisible', true, 200); } catch (_) {}
        
        // Trigger terminal resize when mobile keyboard is shown
        setTimeout(() => {
            if (this.terminalManager.currentSession) {
                this.terminalManager.currentSession.fit();
            } else if (this.terminalManager.viewController.historyTerminal && this.terminalManager.viewController.historyFitAddon) {
                this.terminalManager.viewController.fitHistoryTerminal();
            }
        }, 100);
    }
    
    /**
     * Hide mobile keyboard
     */
    hideMobileKeyboard() {
        const dropdown = this.elements.mobileKeyboardDropdown;
        const keyboardBtn = document.getElementById('mobile-keyboard-btn');
        if (!dropdown) return;
        
        dropdown.classList.remove('show');
        keyboardBtn?.classList.remove('active');
        
        // Clear toggle state (positions are preserved by draggable system)
        try { queueStateSet('mobileKeyboardVisible', false, 200); } catch (_) {}
        
        // Trigger terminal resize when mobile keyboard is hidden
        setTimeout(() => {
            if (this.terminalManager.currentSession) {
                this.terminalManager.currentSession.fit();
            } else if (this.terminalManager.viewController.historyTerminal && this.terminalManager.viewController.historyFitAddon) {
                this.terminalManager.viewController.fitHistoryTerminal();
            }
        }, 100);
    }
    
    /**
     * Send mobile key to active session
     */
    sendMobileKey(keyString) {
        // Determine the effective target session (container child when its tab is active)
        const sid = (typeof this.terminalManager.getActiveEffectiveSessionId === 'function')
            ? this.terminalManager.getActiveEffectiveSessionId()
            : this.terminalManager.currentSessionId;
        if (!sid) {
            return;
        }

        // Check if target session is interactive for this client
        const sessionData = (typeof this.terminalManager.getAnySessionData === 'function')
            ? this.terminalManager.getAnySessionData(sid)
            : this.terminalManager.sessionList.getSessionData(sid);
        const isInteractive = this.terminalManager.isSessionInteractive(sessionData);
        if (!isInteractive) {
            return;
        }
        
        // Set flag to prevent focus during mobile keyboard input
        window._mobileKeyboardInputActive = true;
        
        // Blur any currently focused input elements to hide device keyboard
        if (document.activeElement && (
            document.activeElement.tagName === 'INPUT' ||
            document.activeElement.tagName === 'TEXTAREA' ||
            document.activeElement.contentEditable === 'true'
        )) {
            document.activeElement.blur();
        }

        let keyToSend;
        
        // Handle different key types - use toLowerCase() for case-insensitive comparison
        switch (keyString.toLowerCase()) {
            case 'escape':
                keyToSend = '\x1b'; // ESC character
                break;
            case 'tab':
                keyToSend = '\t'; // Tab character
                break;
            case 'shift+tab':
                keyToSend = '\x1b[Z'; // Shift+Tab escape sequence
                break;
            case 'ctrl+c':
                keyToSend = '\x03'; // Ctrl+C character
                break;
            case 'ctrl+t':
                keyToSend = '\x14'; // Ctrl+T character
                break;
            case 'ctrl+j':
                keyToSend = '\n'; // Ctrl+J character (line feed)
                break;
            case 'arrowup':
                keyToSend = '\x1b[A'; // Up arrow escape sequence
                break;
            case 'arrowdown':
                keyToSend = '\x1b[B'; // Down arrow escape sequence
                break;
            case 'arrowright':
                keyToSend = '\x1b[C'; // Right arrow escape sequence
                break;
            case 'arrowleft':
                keyToSend = '\x1b[D'; // Left arrow escape sequence
                break;
            case 'home':
                keyToSend = '\x1b[H'; // Home key escape sequence
                break;
            case 'end':
                keyToSend = '\x1b[F'; // End key escape sequence
                break;
            case 'pageup':
                keyToSend = '\x1b[5~'; // Page Up escape sequence
                break;
            case 'pagedown':
                keyToSend = '\x1b[6~'; // Page Down escape sequence
                break;
            case 'enter':
                keyToSend = '\r'; // Enter/Return character
                break;
            case 'backspace':
                keyToSend = '\x7f'; // Backspace character
                break;
            default:
                keyToSend = keyString;
        }

        try {
            // Do not send input if session is read-only for this client
            const sd = (typeof this.terminalManager.getAnySessionData === 'function')
                ? this.terminalManager.getAnySessionData(sid)
                : this.terminalManager.sessionList.getSessionData(sid);
            if (!this.terminalManager.isSessionInteractive(sd)) {
                console.warn('[MobileInterface] Skipping stdin: session is read-only for this client');
                return;
            }
            // Send the key directly via WebSocket, bypassing xterm.js input handling
            this.terminalManager.wsClient.send('stdin', {
                session_id: sid,
                data: keyToSend
            });
        } catch (error) {
            console.error(`Failed to send mobile key: ${error.message}`);
        }
        
        // Clear the flag after a short delay to prevent any focus calls triggered by this mobile input
        setTimeout(() => {
            window._mobileKeyboardInputActive = false;
        }, 200);
    }
    
    // Mobile scroll forwarding functionality
    
    /**
     * Toggle mobile scroll forwarding state
     */
    toggleMobileScrollForwarding() {
        try {
            // Get current state (sync if possible)
            let currentState = false;
            try {
                const res = getStateStore().loadSync && getStateStore().loadSync();
                const st = res && res.ok ? (res.state || {}) : {};
                const val = st['mobile_scroll_forwarding_enabled'];
                currentState = (val === true || val === 'true');
            } catch (_) {}
            const newState = !currentState;
            // Save new state
            queueStateSet('mobile_scroll_forwarding_enabled', newState, 200);
            
            // Update button UI
            this.updateScrollForwardingButtonState(newState);
            
            // Update current session's touch handler if available
            if (this.terminalManager.currentSession?.mobileTouch) {
                this.terminalManager.currentSession.mobileTouch.setScrollForwarding(newState);
            }
        } catch (error) {
            console.error('[MobileInterface] Failed to toggle scroll forwarding:', error);
        }
    }
    
    /**
     * Update scroll forwarding button UI state
     */
    updateScrollForwardingButtonState(enabled) {
        const toggleBtn = document.getElementById('mobile-scroll-forward-btn');
        if (toggleBtn) {
            toggleBtn.classList.toggle('active', enabled);
            toggleBtn.title = enabled ? 
                'Disable scroll forwarding to apps (enabled)' : 
                'Enable scroll forwarding to apps (disabled)';
        }
    }
    
    /**
     * Initialize scroll forwarding button state
     */
    initializeScrollForwardingButtonState() {
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const st = res && res.ok ? (res.state || {}) : {};
            const v = st['mobile_scroll_forwarding_enabled'];
            const enabled = (v === true || v === 'true');
            this.updateScrollForwardingButtonState(enabled);
        } catch (error) {
            console.warn('[MobileInterface] Failed to initialize scroll forwarding button state:', error);
        }
    }
    
    // Drag handlers
    
    /**
     * Handle keyboard drag start
     */
    handleKeyboardDragStart() {
        // Called when keyboard drag starts - bring to front
        this.bringMobileKeyboardToFront();
    }
    
    /**
     * Handle keyboard drag end
     */
    handleKeyboardDragEnd() {
        // Called when keyboard drag ends
    }
    
    /**
     * Handle keyboard position change during drag
     */
    handleKeyboardPositionChange(x, y) {
        // Called when keyboard position changes during drag
    }
    
    /**
     * Handle text input modal drag start
     */
    handleTextInputDragStart() {
        // Called when text input modal drag starts - bring to front
        this.bringTextInputModalToFront();
    }
    
    /**
     * Handle text input modal drag end
     */
    handleTextInputDragEnd() {
        // Called when text input modal drag ends
    }
    
    /**
     * Handle text input modal position change during drag
     */
    handleTextInputPositionChange(x, y) {
        // Called when text input modal position changes during drag
    }
    
    /**
     * Bring text input modal to front
     */
    bringTextInputModalToFront() {
        // Swap z-indexes: text input gets higher, mobile keyboard gets lower
        document.documentElement.style.setProperty('--text-input-modal-z-index', '10001');
        document.documentElement.style.setProperty('--mobile-keyboard-z-index', '10000');
        
        // Save z-index state
        this.saveZIndexState();
    }
    
    /**
     * Bring mobile keyboard to front
     */
    bringMobileKeyboardToFront() {
        // Swap z-indexes: mobile keyboard gets higher, text input gets lower
        document.documentElement.style.setProperty('--text-input-modal-z-index', '9999');
        document.documentElement.style.setProperty('--mobile-keyboard-z-index', '10001');
        
        // Save z-index state
        this.saveZIndexState();
    }
    
    /**
     * Save current z-index state
     */
    saveZIndexState() {
        try {
            const textInputZIndex = getComputedStyle(document.documentElement)
                .getPropertyValue('--text-input-modal-z-index').trim();
            const mobileKeyboardZIndex = getComputedStyle(document.documentElement)
                .getPropertyValue('--mobile-keyboard-z-index').trim();
            
            debouncedStateSet('overlayZIndexState', {
                textInputModal: textInputZIndex || '9999',
                mobileKeyboard: mobileKeyboardZIndex || '10001'
            }, 200);
        } catch (e) {
            console.warn('Failed to save z-index state:', e);
        }
    }
    
    /**
     * Restore or set z-index for overlay
     */
    restoreOrSetZIndex(overlayType) {
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const stateObj = res && res.ok ? (res.state || {}) : {};
            const savedState = stateObj['overlayZIndexState'] ? stateObj['overlayZIndexState'] : null;
            if (savedState) {
                const state = typeof savedState === 'string' ? JSON.parse(savedState) : savedState;
                document.documentElement.style.setProperty('--text-input-modal-z-index', state.textInputModal);
                document.documentElement.style.setProperty('--mobile-keyboard-z-index', state.mobileKeyboard);
            } else {
                // Default: bring the opening overlay to front
                if (overlayType === 'mobileKeyboard') {
                    this.bringMobileKeyboardToFront();
                } else if (overlayType === 'textInputModal') {
                    this.bringTextInputModalToFront();
                }
            }
        } catch (e) {
            console.warn('Failed to restore z-index state:', e);
            // Fallback to bringing the opening overlay to front
            if (overlayType === 'mobileKeyboard') {
                this.bringMobileKeyboardToFront();
            } else if (overlayType === 'textInputModal') {
                this.bringTextInputModalToFront();
            }
        }
    }
    
    /**
     * Restore overlay states from localStorage on initialization
     */
    restoreOverlayStates() {
        try {
            // Restore z-index state
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const stateObj = res && res.ok ? (res.state || {}) : {};
            const zIndexState = stateObj['overlayZIndexState'] || null;
            if (zIndexState) {
                const state = typeof zIndexState === 'string' ? JSON.parse(zIndexState) : zIndexState;
                document.documentElement.style.setProperty('--text-input-modal-z-index', state.textInputModal);
                document.documentElement.style.setProperty('--mobile-keyboard-z-index', state.mobileKeyboard);
            }
            
            // Restore mobile keyboard visibility
            const mobileKeyboardVisible = stateObj['mobileKeyboardVisible'];
            if (mobileKeyboardVisible === true || mobileKeyboardVisible === 'true') {
                // Small delay to ensure DOM is ready
                setTimeout(() => {
                    this.showMobileKeyboard();
                }, 100);
            }
            
            // Restore text input modal visibility
            const textInputModalVisible = stateObj['textInputModalVisible'];
            if (textInputModalVisible === true || textInputModalVisible === 'true') {
                // Small delay to ensure DOM is ready
                setTimeout(() => {
                    if (this.terminalManager && this.terminalManager.showTextInputModal) {
                        this.terminalManager.showTextInputModal();
                    }
                }, 150);
            }
        } catch (e) {
            console.warn('Failed to restore overlay states:', e);
        }
    }
    
    // Text input modal drag methods delegation
    
    /**
     * Apply saved text input modal position
     */
    applyTextInputPosition() {
        if (!this.textInputDrag) return false;
        return this.textInputDrag.applyPosition();
    }
    
    /**
     * Initialize text input modal position tracking
     */
    initializeTextInputPosition() {
        if (!this.textInputDrag) return;
        this.textInputDrag.initializePosition();
    }
    
    /**
     * Check if keyboard drag should block key press
     */
    shouldBlockKeyPress() {
        return this.keyboardDrag ? this.keyboardDrag.shouldBlockKeyPress() : false;
    }
    
    /**
     * Clean up mobile interface resources
     */
    cleanup() {
        // Clear any active timers
        if (this.touchState.longPressTimer) {
            clearTimeout(this.touchState.longPressTimer);
            this.touchState.longPressTimer = null;
        }
        
        // Clean up drag handlers
        if (this.keyboardDrag) {
            if (this.keyboardDrag && typeof this.keyboardDrag.cleanup === 'function') {
                this.keyboardDrag.cleanup();
            }
        }
        
        if (this.textInputDrag) {
            if (this.textInputDrag && typeof this.textInputDrag.cleanup === 'function') {
                this.textInputDrag.cleanup();
            }
        }
        
        // Remove any mobile popups
        this.hideHistoryMobileUrlPopup();
        
        // Reset state
        this.resetTouchState();
        this.initialized = false;
    }
}
