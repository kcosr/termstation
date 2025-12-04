/**
 * Mobile Terminal Touch Handler
 * Handles touch interactions, scrolling, and selection for mobile devices
 */

import { TerminalAutoCopy } from '../../utils/terminal-auto-copy.js';
import { MobileUrlPopup } from '../../utils/mobile-url-popup.js';
import { TOUCH_CONFIG } from './terminal-touch-config.js';
import { getStateStore } from '../../core/state-store/index.js';
import { getContext } from '../../core/context.js';

export class MobileTerminalTouchHandler {
    constructor(terminal, sessionId, eventBus, wsClient = null) {
        this.terminal = terminal;
        this.sessionId = sessionId;
        this.eventBus = eventBus;
        this.wsClient = wsClient;
        
        // Touch overlay for capturing events
        this.touchOverlay = null;
        this.touchScrollingEnabled = false;
        
        // Touch state tracking
        this.touchState = {
            startY: 0,
            startX: 0,
            scrollStartY: 0,
            isScrolling: false,
            scrollDirection: null,
            lastTouchY: 0,
            lastTouchTime: 0,
            velocity: 0,
            momentumAnimationId: null,
            totalDistance: 0,
            fractionalScroll: 0
        };
        
        // Focus prevention state
        this.focusPrevention = {
            isBlocking: false,
            focusListener: null,
            mousedownListener: null
        };
        
        // Selection state tracking
        this.selectionState = {
            longPressTimer: null,
            isLongPressMode: false,
            selectionStartPos: null,
            isSelecting: false,
            initialTouchPos: null,
            autoScrollTimer: null,
            autoScrollDirection: null
        };
        
        // Scroll forwarding state (for synthetic wheel events)
        this.scrollForwarding = {
            enabled: this._loadScrollForwardingState(), // Load saved state from localStorage
            threshold: TOUCH_CONFIG.PIXELS_PER_LINE_DRAG / 2, // Use same threshold logic as local scrolling
            accumulatedDelta: 0,
            lastScrollTime: 0,
            minScrollInterval: 16 // ~60fps for smooth remote scrolling
        };
    }
    
    
    /**
     * Send scroll event to server via WebSocket as mouse wheel escape sequence
     * @param {number} deltaY - Scroll delta (negative for up, positive for down)
     * @param {number} x - X coordinate in pixels
     * @param {number} y - Y coordinate in pixels
     */
    sendScrollEvent(deltaY, x, y) {
        // Only send to server if scroll forwarding is enabled
        if (!this.scrollForwarding.enabled) {
            return;
        }
        
        // Rate limiting for smooth scrolling
        const now = Date.now();
        if (now - this.scrollForwarding.lastScrollTime < this.scrollForwarding.minScrollInterval) {
            return;
        }
        
        // Accumulate fractional scrolling like local scrolling does
        this.scrollForwarding.accumulatedDelta += deltaY;
        
        // Only send when we have enough accumulated delta
        if (Math.abs(this.scrollForwarding.accumulatedDelta) < this.scrollForwarding.threshold) {
            return;
        }
        
        // Use accumulated delta and preserve fractional remainder
        const deltaToSend = this.scrollForwarding.accumulatedDelta;
        this.scrollForwarding.accumulatedDelta = 0;
        this.scrollForwarding.lastScrollTime = now;
        
        if (!this.wsClient) {
            console.warn('[MobileTouch] No WebSocket client available for scroll forwarding');
            return;
        }
        
        try {
            // Convert pixel coordinates to terminal cell coordinates
            const rect = this.terminal.element.getBoundingClientRect();
            const relativeX = Math.max(0, x - rect.left);
            const relativeY = Math.max(0, y - rect.top);
            
            // Get character dimensions
            const charWidth = this.terminal._core._renderService.dimensions.actualCellWidth || 9;
            const charHeight = this.terminal._core._renderService.dimensions.actualCellHeight || 17;
            
            // Convert to 1-based terminal coordinates (standard for mouse reporting)
            const col = Math.min(this.terminal.cols, Math.max(1, Math.floor(relativeX / charWidth) + 1));
            const row = Math.min(this.terminal.rows, Math.max(1, Math.floor(relativeY / charHeight) + 1));
            
            // Determine scroll direction - mouse button codes for wheel events:
            // 64 = wheel up, 65 = wheel down
            const button = deltaToSend < 0 ? 64 : 65;
            
            // Generate SGR mouse mode escape sequence: \x1b[<button;col;rowM
            // This is the modern mouse reporting format that most terminal apps support
            const mouseSequence = `\x1b[<${button};${col};${row}M`;
            
            // Do not send input if session is read-only for this client
            try {
                const { app } = getContext();
                const mgr = app?.modules?.terminal;
                if (mgr) {
                    const sd = mgr.sessionList.getSessionData(this.sessionId);
                    if (!mgr.isSessionInteractive(sd)) {
                        console.warn('[MobileTouch] Skipping scroll stdin: session is read-only for this client');
                        return;
                    }
                }
            } catch (_) {}

            // Send the mouse sequence directly to the server via WebSocket
            this.wsClient.send('stdin', {
                session_id: this.sessionId,
                data: mouseSequence
            });
            
        } catch (error) {
            console.error('Failed to send scroll event to server:', error);
        }
    }
    
    /**
     * Set scroll forwarding state (called by mobile interface manager)
     * @param {boolean} enabled - Whether to enable scroll forwarding
     */
    setScrollForwarding(enabled) {
        this.scrollForwarding.enabled = enabled;
    }
    
    /**
     * Get current scroll forwarding state
     * @returns {boolean} Whether scroll forwarding is enabled
     */
    isScrollForwardingEnabled() {
        return this.scrollForwarding.enabled;
    }
    
    /**
     * Initialize mobile touch handling
     */
    setup() {
        if (!this.terminal || this.touchScrollingEnabled) {
            return;
        }
        
        this._createTouchOverlay();
        this._disableNativeTouchBehavior();
        this._setupTouchEventListeners();
        
        this.touchScrollingEnabled = true;
    }
    
    /**
     * Clean up touch handling and remove event listeners
     */
    teardown() {
        if (this.touchOverlay && this.touchOverlay.parentNode) {
            this.touchOverlay.parentNode.removeChild(this.touchOverlay);
            this.touchOverlay = null;
        }
        
        this._cancelMomentum();
        this._clearLongPressTimer();
        this._stopSelectionAutoScroll();
        this._stopFocusPrevention();
        
        this.touchScrollingEnabled = false;
    }
    
    /**
     * Create the touch overlay element
     * @private
     */
    _createTouchOverlay() {
        const extension = TOUCH_CONFIG.TOUCH_OVERLAY_EXTENSION;
        
        this.touchOverlay = document.createElement('div');
        this.touchOverlay.style.position = 'absolute';
        this.touchOverlay.style.top = `-${extension}px`; // Extend above terminal
        this.touchOverlay.style.left = `-${extension}px`; // Extend to left of terminal
        this.touchOverlay.style.width = `calc(100% + ${extension * 2}px)`; // Extend on both sides
        this.touchOverlay.style.height = `calc(100% + ${extension * 2}px)`; // Extend above and below
        this.touchOverlay.style.zIndex = '1000';
        this.touchOverlay.style.touchAction = 'none';
        this.touchOverlay.style.backgroundColor = TOUCH_CONFIG.TRANSPARENT;
        this.touchOverlay.style.pointerEvents = 'auto';
        
        this.terminal.element.style.position = 'relative';
        try { this.touchOverlay.classList.add('terminal-touch-overlay'); } catch (_) {}
        this.terminal.element.appendChild(this.touchOverlay);
    }
    
    /**
     * Disable native touch behavior on xterm elements
     * @private
     */
    _disableNativeTouchBehavior() {
        const elements = [
            this.terminal.element.querySelector('.xterm-viewport'),
            this.terminal.element.querySelector('.xterm-screen'),
            this.terminal.element.querySelector('canvas'),
            this.terminal.element.querySelector('.xterm-helper-container')
        ];
        
        elements.forEach(el => {
            if (el) {
                el.style.touchAction = 'none';
                el.addEventListener('touchstart', e => e.stopPropagation(), true);
                el.addEventListener('touchmove', e => e.stopPropagation(), true);
            }
        });
    }
    
    /**
     * Setup touch event listeners
     * @private
     */
    _setupTouchEventListeners() {
        this.touchOverlay.addEventListener('touchstart', this._handleTouchStart.bind(this), { passive: true });
        this.touchOverlay.addEventListener('touchmove', this._handleTouchMove.bind(this), { passive: false });
        this.touchOverlay.addEventListener('touchend', this._handleTouchEnd.bind(this), { passive: true });
    }
    
    /**
     * Handle touch start events
     * @private
     */
    _handleTouchStart(e) {
        if (e.touches.length !== 1) return;
        
        const touch = e.touches[0];
        
        console.log('[MobileTouch] TouchStart:', {
            x: touch.clientX,
            y: touch.clientY,
            hasSelection: this.terminal.hasSelection(),
            isLongPressMode: this.selectionState.isLongPressMode,
            isSelecting: this.selectionState.isSelecting,
            timestamp: Date.now()
        });
        
        // Initialize touch state
        this.touchState.startY = touch.clientY;
        this.touchState.startX = touch.clientX;
        this.touchState.lastTouchY = this.touchState.startY;
        this.touchState.lastTouchTime = Date.now();
        this.touchState.scrollStartY = this.terminal.buffer.active.viewportY;
        this.touchState.isScrolling = false;
        this.touchState.scrollDirection = null;
        this.touchState.velocity = 0;
        this.touchState.totalDistance = 0;
        this.touchState.fractionalScroll = 0;
        
        // Store initial touch position for long press
        this.selectionState.initialTouchPos = { 
            x: this.touchState.startX, 
            y: this.touchState.startY 
        };
        
        // Cancel any ongoing momentum
        this._cancelMomentum();
        
        // IMPORTANT: Reset selection mode state on new touch
        // This ensures that selection mode doesn't persist from previous interactions
        if (this.selectionState.isLongPressMode || this.selectionState.isSelecting) {
            console.log('[MobileTouch] Resetting persistent selection mode on new touch');
            this.selectionState.isLongPressMode = false;
            this.selectionState.isSelecting = false;
            this.selectionState.selectionStartPos = null;
        }
        
        // Always start long press timer for new touches
        // Selection will only activate after the full long press duration
        console.log('[MobileTouch] Starting long press timer for new touch');
        this._startLongPressTimer(touch);
        
        // Start focus prevention immediately when long press timer starts
        // This prevents focus events during the entire long press period
        this._startFocusPrevention();
    }
    
    /**
     * Handle touch move events
     * @private
     */
    _handleTouchMove(e) {
        if (e.touches.length !== 1) return;
        
        const touch = e.touches[0];
        const deltaY = this.touchState.startY - touch.clientY;
        const deltaX = this.touchState.startX - touch.clientX;
        const moveDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        
        console.log('[MobileTouch] TouchMove:', {
            deltaX: deltaX.toFixed(1),
            deltaY: deltaY.toFixed(1),
            distance: moveDistance.toFixed(1),
            isLongPressMode: this.selectionState.isLongPressMode,
            isSelecting: this.selectionState.isSelecting,
            isScrolling: this.touchState.isScrolling,
            hasLongPressTimer: !!this.selectionState.longPressTimer
        });
        
        // Cancel long press timer if we move too much
        this._checkLongPressMovement(deltaX, deltaY);
        
        // Handle selection extension if in CONFIRMED long press mode
        // Only allow selection moves if we're actually in long press selection mode
        if (this.selectionState.isLongPressMode && this.selectionState.isSelecting) {
            console.log('[MobileTouch] Handling selection move (confirmed long press mode)');
            this._handleSelectionMove(e, touch);
            return;
        }
        
        // Handle normal scrolling - this is the default behavior
        console.log('[MobileTouch] Handling scroll move (not in selection mode)');
        // Clear any existing selection when we start scrolling
        if (!this.touchState.isScrolling && (Math.abs(deltaY) > TOUCH_CONFIG.LONG_PRESS_TOLERANCE || Math.abs(deltaX) > TOUCH_CONFIG.LONG_PRESS_TOLERANCE)) {
            console.log('[MobileTouch] Clearing selection - scroll detected (deltaY:', Math.abs(deltaY), 'deltaX:', Math.abs(deltaX), ')');
            this._clearSelection();
        }
        this._handleScrollMove(e, touch, deltaX, deltaY);
    }
    
    /**
     * Handle touch end events
     * @private
     */
    _handleTouchEnd() {
        const wasLongPress = this.selectionState.isLongPressMode && this.selectionState.isSelecting;
        const wasMoveDistance = this.touchState.totalDistance;
        const touchDuration = Date.now() - this.touchState.lastTouchTime;
        
        console.log('[MobileTouch] TouchEnd:', {
            wasLongPressMode: this.selectionState.isLongPressMode,
            wasSelecting: this.selectionState.isSelecting,
            wasScrolling: this.touchState.isScrolling,
            totalDistance: this.touchState.totalDistance.toFixed(1),
            duration: touchDuration
        });
        
        this._clearLongPressTimer();
        
        // Stop any auto-scrolling
        this._stopSelectionAutoScroll();
        
        // Handle selection completion
        if (wasLongPress) {
            console.log('[MobileTouch] Completing selection');
            this._completeSelection();
            // Stop focus prevention after a longer delay to prevent keyboard popup on release
            setTimeout(() => {
                this._stopFocusPrevention();
            }, 1000);
        } else {
            // For normal taps or scrolls, stop focus prevention since no selection occurred
            console.log('[MobileTouch] Normal tap/scroll - stopping focus prevention');
            this._stopFocusPrevention();
            
            // If this interaction was effectively a tap (not a scroll),
            // focus the terminal to bring up the keyboard on mobile/tablet
            // and hide the mobile sidebar for better UX.
            if (!this.touchState.isScrolling && wasMoveDistance <= TOUCH_CONFIG.LONG_PRESS_TOLERANCE) {
                this._focusTerminalOnTap();
            }
            
            // Handle normal scrolling momentum
            console.log('[MobileTouch] Starting momentum scroll');
            this._startMomentumScroll();
        }
        
        this._resetTouchState();
    }

    /**
     * Focus xterm on simple tap to bring up OS keyboard and hide sidebar
     * @private
     */
    _focusTerminalOnTap() {
        try {
            // Hide mobile sidebar if open
            const app = getContext()?.app;
            app?.hideMobileSidebar?.();
        } catch (_) {}

        // Ensure focus-prevent flag is cleared
        try { window._mobileKeyboardInputActive = false; } catch (_) {}

        // Focus the xterm instance (or helper textarea) to trigger the keyboard
        try {
            if (this.terminal && typeof this.terminal.focus === 'function') {
                this.terminal.focus();
            } else {
                const textarea = this.terminal?.element?.querySelector?.('.xterm-helper-textarea');
                if (textarea && typeof textarea.focus === 'function') textarea.focus();
            }
        } catch (e) {
            console.warn('[MobileTouch] Failed to focus terminal on tap:', e);
        }
    }
    
    /**
     * Start long press timer
     * @private
     */
    _startLongPressTimer(touch) {
        console.log('[MobileTouch] Long press timer started (', TOUCH_CONFIG.LONG_PRESS_THRESHOLD, 'ms)');
        this.selectionState.longPressTimer = setTimeout(() => {
            // Check if we haven't moved much
            const deltaX = Math.abs(touch.clientX - this.touchState.startX);
            const deltaY = Math.abs(touch.clientY - this.touchState.startY);
            
            console.log('[MobileTouch] Long press timer fired - checking movement:', {
                deltaX: deltaX.toFixed(1),
                deltaY: deltaY.toFixed(1),
                tolerance: TOUCH_CONFIG.LONG_PRESS_TOLERANCE
            });
            
            if (deltaX <= TOUCH_CONFIG.LONG_PRESS_TOLERANCE && deltaY <= TOUCH_CONFIG.LONG_PRESS_TOLERANCE) {
                this._startLongPressSelection();
            } else {
                console.log('[MobileTouch] Long press cancelled - too much movement');
            }
        }, TOUCH_CONFIG.LONG_PRESS_THRESHOLD);
    }
    
    /**
     * Start long press selection mode
     * @private
     */
    _startLongPressSelection() {
        console.log('[MobileTouch] STARTING LONG PRESS SELECTION MODE');
        this.selectionState.isLongPressMode = true;
        this.selectionState.isSelecting = true;
        
        // Focus prevention was already started when long press timer began
        // Now it will be active since isLongPressMode is true
        
        // Convert touch coordinates to terminal coordinates
        const rect = this.terminal.element.getBoundingClientRect();
        const relativeX = this.touchState.startX - rect.left;
        const relativeY = this.touchState.startY - rect.top;
        
        // Calculate character position in terminal
        const charWidth = this.terminal._core._renderService.dimensions.actualCellWidth || 9;
        const charHeight = this.terminal._core._renderService.dimensions.actualCellHeight || 17;
        const col = Math.floor(relativeX / charWidth);
        const row = Math.floor(relativeY / charHeight) + this.terminal.buffer.active.viewportY;
        
        console.log('[MobileTouch] Selection start position:', {
            col,
            row,
            relativeX: relativeX.toFixed(1),
            relativeY: relativeY.toFixed(1)
        });
        
        // Store selection start position and start selection
        this.selectionState.selectionStartPos = { col, row };
        
        // Start the selection (focus prevention will block any focus attempts)
        this.terminal.select(col, row, 1);
        
        // Provide feedback
        this._provideLongPressFeedback();
    }
    
    /**
     * Check if long press timer should be cancelled due to movement
     * @private
     */
    _checkLongPressMovement(deltaX, deltaY) {
        if (this.selectionState.longPressTimer && !this.selectionState.isLongPressMode) {
            const moveDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
            // Cancel long press timer more aggressively for vertical movement (likely scroll intent)
            // Use smaller threshold for vertical movement to prevent accidental selections during scrolling
            const isVerticalMovement = Math.abs(deltaY) > Math.abs(deltaX);
            const threshold = isVerticalMovement ? TOUCH_CONFIG.SCROLL_INTENT_THRESHOLD : TOUCH_CONFIG.LONG_PRESS_TOLERANCE;
            
            console.log('[MobileTouch] Checking long press movement:', {
                moveDistance: moveDistance.toFixed(1),
                threshold,
                isVertical: isVerticalMovement,
                willCancel: moveDistance > threshold
            });
            
            if (moveDistance > threshold) {
                console.log('[MobileTouch] Cancelling long press timer - movement exceeded threshold');
                this._clearLongPressTimer();
            }
        }
    }
    
    /**
     * Handle selection movement during long press
     * @private
     */
    _handleSelectionMove(e, touch) {
        e.preventDefault();
        e.stopPropagation();
        
        const rect = this.terminal.element.getBoundingClientRect();
        const relativeX = touch.clientX - rect.left;
        const relativeY = touch.clientY - rect.top;
        
        const charWidth = this.terminal._core._renderService.dimensions.actualCellWidth || 9;
        const charHeight = this.terminal._core._renderService.dimensions.actualCellHeight || 17;
        
        // Calculate selection coordinates, allowing for out-of-bounds values
        let currentCol = Math.floor(relativeX / charWidth);
        let currentRow = Math.floor(relativeY / charHeight) + this.terminal.buffer.active.viewportY;
        
        // Clamp coordinates to valid terminal bounds for selection
        const maxCols = this.terminal.cols - 1;
        const minRow = 0;
        const maxRow = this.terminal.buffer.active.length - 1;
        
        const originalCol = currentCol;
        const originalRow = currentRow;
        currentCol = Math.max(0, Math.min(maxCols, currentCol));
        currentRow = Math.max(minRow, Math.min(maxRow, currentRow));
        
        console.log('[MobileTouch] Selection move:', {
            originalCol,
            originalRow,
            clampedCol: currentCol,
            clampedRow: currentRow,
            relativeX: relativeX.toFixed(1),
            relativeY: relativeY.toFixed(1)
        });
        
        // Check for auto-scroll zones during selection (using original relativeY)
        this._handleSelectionAutoScroll(relativeY, rect.height);
        
        // Update selection with clamped coordinates
        this._updateSelection(currentCol, currentRow);
    }
    
    /**
     * Handle scroll movement during normal touch
     * @private
     */
    _handleScrollMove(e, touch, deltaX, deltaY) {
        // Determine scroll direction on first move
        if (!this.touchState.scrollDirection) {
            this.touchState.scrollDirection = Math.abs(deltaX) > Math.abs(deltaY) * 2 ? 'horizontal' : 'vertical';
            this.touchState.isScrolling = this.touchState.scrollDirection === 'vertical';
            console.log('[MobileTouch] Scroll direction determined:', {
                direction: this.touchState.scrollDirection,
                isScrolling: this.touchState.isScrolling,
                deltaX: Math.abs(deltaX).toFixed(1),
                deltaY: Math.abs(deltaY).toFixed(1)
            });
        }
        
        if (this.touchState.isScrolling) {
            e.preventDefault();
            e.stopPropagation();
            
            const deltaFromLast = this.touchState.lastTouchY - touch.clientY;
            this._calculateVelocity(touch);
            
            // Get terminal-relative touch coordinates for scroll forwarding
            const rect = this.terminal.element.getBoundingClientRect();
            const relativeX = touch.clientX - rect.left;
            const relativeY = touch.clientY - rect.top;
            
            this._applyScroll(deltaFromLast, relativeX, relativeY);
        }
    }
    
    /**
     * Update terminal selection
     * @private
     */
    _updateSelection(currentCol, currentRow) {
        if (!this.selectionState.selectionStartPos) return;
        
        const startCol = this.selectionState.selectionStartPos.col;
        const startRow = this.selectionState.selectionStartPos.row;
        
        // Calculate selection bounds
        let fromCol, fromRow, toCol, toRow;
        if (currentRow < startRow || (currentRow === startRow && currentCol < startCol)) {
            // Selecting backwards
            fromCol = currentCol;
            fromRow = currentRow;
            toCol = startCol;
            toRow = startRow;
        } else {
            // Selecting forwards
            fromCol = startCol;
            fromRow = startRow;
            toCol = currentCol;
            toRow = currentRow;
        }
        
        console.log('[MobileTouch] Updating selection:', {
            from: { col: fromCol, row: fromRow },
            to: { col: toCol, row: toRow },
            length: toCol - fromCol + 1,
            multiline: fromRow !== toRow,
            direction: currentRow < startRow ? 'backward' : 'forward'
        });
        
        // Apply the selection
        this.terminal.select(fromCol, fromRow, toCol - fromCol + 1);
        if (fromRow !== toRow) {
            this.terminal.selectLines(fromRow, toRow);
        }
    }
    
    /**
     * Handle auto-scrolling during text selection
     * @private
     */
    _handleSelectionAutoScroll(relativeY, containerHeight) {
        const autoScrollZone = TOUCH_CONFIG.SELECTION_AUTO_SCROLL_ZONE;
        
        // Check if touch is dragged above the terminal viewport
        if (relativeY < 0) {
            this._startSelectionAutoScroll('up');
        }
        // Check if touch is dragged below the terminal viewport  
        else if (relativeY > containerHeight) {
            this._startSelectionAutoScroll('down');
        }
        // Check if touch is in top auto-scroll zone (within viewport)
        else if (relativeY < autoScrollZone) {
            this._startSelectionAutoScroll('up');
        }
        // Check if touch is in bottom auto-scroll zone (within viewport)
        else if (relativeY > containerHeight - autoScrollZone) {
            this._startSelectionAutoScroll('down');
        }
        // Touch is in normal area, stop auto-scrolling
        else {
            this._stopSelectionAutoScroll();
        }
    }
    
    /**
     * Start auto-scrolling in the specified direction during selection
     * @private
     */
    _startSelectionAutoScroll(direction) {
        // If already scrolling in this direction, no need to restart
        if (this.selectionState.autoScrollDirection === direction) {
            return;
        }
        
        // Stop any existing auto-scroll
        this._stopSelectionAutoScroll();
        
        // Set new direction and start timer
        this.selectionState.autoScrollDirection = direction;
        this.selectionState.autoScrollTimer = setInterval(() => {
            const currentY = this.terminal.buffer.active.viewportY;
            const maxScroll = this.terminal.buffer.active.length - this.terminal.rows;
            let newViewportY;
            
            if (direction === 'up' && currentY > 0) {
                newViewportY = Math.max(0, currentY - 1);
            } else if (direction === 'down' && currentY < maxScroll) {
                newViewportY = Math.min(maxScroll, currentY + 1);
            } else {
                // Reached scroll limit, stop auto-scrolling
                this._stopSelectionAutoScroll();
                return;
            }
            
            if (newViewportY !== currentY) {
                this.terminal.scrollToLine(newViewportY);
            }
        }, TOUCH_CONFIG.SELECTION_AUTO_SCROLL_SPEED);
    }
    
    /**
     * Stop auto-scrolling during selection
     * @private
     */
    _stopSelectionAutoScroll() {
        if (this.selectionState.autoScrollTimer) {
            clearInterval(this.selectionState.autoScrollTimer);
            this.selectionState.autoScrollTimer = null;
        }
        this.selectionState.autoScrollDirection = null;
    }
    
    /**
     * Calculate scrolling velocity for momentum
     * @private
     */
    _calculateVelocity(touch) {
        const currentTime = Date.now();
        const deltaFromLast = this.touchState.lastTouchY - touch.clientY;
        const timeDelta = currentTime - this.touchState.lastTouchTime;
        
        if (timeDelta > 0) {
            this.touchState.velocity = deltaFromLast / timeDelta * 32;
        }
        
        this.touchState.totalDistance += Math.abs(deltaFromLast);
        this.touchState.lastTouchY = touch.clientY;
        this.touchState.lastTouchTime = currentTime;
    }
    
    /**
     * Apply scroll to terminal
     * @private
     */
    _applyScroll(deltaFromLast, touchX = 0, touchY = 0) {
        if (this.scrollForwarding.enabled) {
            // Send scroll event to server for remote apps (like vim)
            // Use the same sensitivity as local scrolling for consistent feel
            const scrollSensitivity = this.terminal.options.scrollSensitivity || 3;
            const adjustedDelta = deltaFromLast * scrollSensitivity / 3; // Normalize to match local sensitivity
            this.sendScrollEvent(adjustedDelta, touchX, touchY);
        } else {
            // Apply local viewport scrolling (default behavior)
            const scrollSensitivity = this.terminal.options.scrollSensitivity || 3;
            const linesToScroll = deltaFromLast / 30 * scrollSensitivity; // Convert pixels to lines
            
            const currentY = this.terminal.buffer.active.viewportY;
            const targetY = currentY + linesToScroll;
            const maxScroll = this.terminal.buffer.active.length - this.terminal.rows;
            const newViewportY = Math.max(0, Math.min(maxScroll, Math.round(targetY)));
            
            if (newViewportY !== currentY) {
                this.terminal.scrollToLine(newViewportY);
            }
        }
    }
    
    /**
     * Complete selection and handle copy/URL detection
     * @private
     */
    _completeSelection() {
        const hasSelection = this.terminal.hasSelection();
        console.log('[MobileTouch] Completing selection, hasSelection:', hasSelection);
        
        // Ensure no focus events during completion
        this._preventMobileKeyboard();
        
        if (hasSelection) {
            const selectedText = this.terminal.getSelection();
            console.log('[MobileTouch] Selected text length:', selectedText ? selectedText.length : 0, 'trimmed:', selectedText ? selectedText.trim().length : 0);
            
            if (selectedText && selectedText.trim()) {
                this._handleSelectedText(selectedText.trim());
                this._provideSelectionFeedback();
                this._clearSelectionAfterDelay();
            }
        }
        
        this._resetSelectionState();
        
        // Additional blur after state reset - this was critical for preventing focus on release
        setTimeout(() => {
            this._preventMobileKeyboard();
        }, 100);
    }
    
    /**
     * Handle selected text - check for URLs or copy to clipboard
     * @private
     */
    _handleSelectedText(selectedText) {
        // Remove newlines and extra spaces to handle wrapped URLs
        const normalizedText = selectedText.replace(/\n/g, '').replace(/\s+/g, ' ').trim();
        
        // Updated regex to better capture URLs that may be wrapped
        const urlRegex = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;
        const urlMatch = normalizedText.match(urlRegex);
        
        if (urlMatch) {
            const extractedUrl = urlMatch[0];
            const focusCallback = () => this.terminal.focus();
            // Pass the original selected text, not the normalized one
            MobileUrlPopup.show(extractedUrl, this.sessionId, focusCallback, selectedText);
        } else {
            const refocusCallback = () => {
                setTimeout(() => {
                    this.terminal.focus();
                }, TOUCH_CONFIG.REFOCUS_DELAY);
            };
            TerminalAutoCopy.copyToClipboard(selectedText, `mobile-selection-${this.sessionId}`, refocusCallback);
        }
    }
    
    /**
     * Start momentum scrolling
     * @private
     */
    _startMomentumScroll() {
        const shouldStartMomentum = this.touchState.isScrolling && Math.abs(this.touchState.velocity) > TOUCH_CONFIG.MOMENTUM_VELOCITY_THRESHOLD;
        
        console.log('[MobileTouch] Momentum check:', {
            isScrolling: this.touchState.isScrolling,
            velocity: this.touchState.velocity.toFixed(2),
            threshold: TOUCH_CONFIG.MOMENTUM_VELOCITY_THRESHOLD,
            willStart: shouldStartMomentum
        });
        
        if (shouldStartMomentum) {
            // Calculate distance factor for momentum
            const distanceFactor = this._calculateDistanceFactor();
            this.touchState.velocity *= distanceFactor;
            
            console.log('[MobileTouch] Starting momentum:', {
                adjustedVelocity: this.touchState.velocity.toFixed(2),
                distanceFactor: distanceFactor.toFixed(2),
                mode: this.scrollForwarding.enabled ? 'remote' : 'local'
            });
            
            if (Math.abs(this.touchState.velocity) > TOUCH_CONFIG.MOMENTUM_VELOCITY_THRESHOLD) {
                if (this.scrollForwarding.enabled) {
                    this._animateMomentumRemote();
                } else {
                    this._animateMomentum();
                }
            }
        }
    }
    
    /**
     * Calculate distance factor for momentum based on swipe distance
     * @private
     */
    _calculateDistanceFactor() {
        const effectiveDistance = Math.max(this.touchState.totalDistance - TOUCH_CONFIG.MIN_DISTANCE_FOR_MOMENTUM, 0);
        const distanceRange = TOUCH_CONFIG.MAX_DISTANCE_FOR_MOMENTUM - TOUCH_CONFIG.MIN_DISTANCE_FOR_MOMENTUM;
        return Math.min(effectiveDistance / distanceRange, 1);
    }
    
    /**
     * Animate momentum scrolling
     * @private
     */
    _animateMomentum() {
        const step = () => {
            this.touchState.velocity *= TOUCH_CONFIG.MOMENTUM_FRICTION;
            
            if (Math.abs(this.touchState.velocity) < TOUCH_CONFIG.MOMENTUM_STOP_THRESHOLD) {
                this.touchState.momentumAnimationId = null;
                return;
            }
            
            const scrollSensitivity = this.terminal.options.scrollSensitivity || 1;
            const linesToScroll = this.touchState.velocity / TOUCH_CONFIG.PIXELS_PER_LINE_MOMENTUM * 
                                  scrollSensitivity * TOUCH_CONFIG.MOMENTUM_BOOST;
            
            const currentY = this.terminal.buffer.active.viewportY;
            const targetY = currentY + linesToScroll;
            const maxScroll = this.terminal.buffer.active.length - this.terminal.rows;
            const newViewportY = Math.max(0, Math.min(maxScroll, Math.round(targetY)));
            
            if (newViewportY !== currentY) {
                this.terminal.scrollToLine(newViewportY);
                this.touchState.momentumAnimationId = requestAnimationFrame(step);
            } else {
                this.touchState.momentumAnimationId = null;
            }
        };
        
        this.touchState.momentumAnimationId = requestAnimationFrame(step);
    }
    
    /**
     * Animate momentum scrolling for remote forwarding (sends to server)
     * @private
     */
    _animateMomentumRemote() {
        // Get terminal center coordinates for momentum scroll events
        const rect = this.terminal.element.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        
        const step = () => {
            this.touchState.velocity *= TOUCH_CONFIG.MOMENTUM_FRICTION;
            
            if (Math.abs(this.touchState.velocity) < TOUCH_CONFIG.MOMENTUM_STOP_THRESHOLD) {
                this.touchState.momentumAnimationId = null;
                return;
            }
            
            // Convert velocity to scroll delta using same physics as local momentum
            const scrollSensitivity = this.terminal.options.scrollSensitivity || 1;
            const scrollDelta = this.touchState.velocity / TOUCH_CONFIG.PIXELS_PER_LINE_MOMENTUM * 
                               scrollSensitivity * TOUCH_CONFIG.MOMENTUM_BOOST;
            
            // Send scroll event to remote terminal application
            this.sendScrollEvent(scrollDelta, centerX, centerY);
            
            this.touchState.momentumAnimationId = requestAnimationFrame(step);
        };
        
        this.touchState.momentumAnimationId = requestAnimationFrame(step);
    }
    
    /**
     * Scroll terminal to specific line offset
     * @private
     */
    _scrollToLine(linesToScroll) {
        const currentY = this.terminal.buffer.active.viewportY;
        const targetY = currentY + linesToScroll;
        const maxScroll = this.terminal.buffer.active.length - this.terminal.rows;
        const newViewportY = Math.max(0, Math.min(maxScroll, Math.round(targetY)));
        
        if (newViewportY !== currentY) {
            this.terminal.scrollToLine(newViewportY);
        }
    }
    
    /**
     * Provide haptic and visual feedback for long press
     * @private
     */
    _provideLongPressFeedback() {
        if (navigator.vibrate) {
            navigator.vibrate(TOUCH_CONFIG.HAPTIC_LONG_PRESS);
        }
        
        this.touchOverlay.style.backgroundColor = TOUCH_CONFIG.HIGHLIGHT_COLOR;
        setTimeout(() => {
            this.touchOverlay.style.backgroundColor = TOUCH_CONFIG.TRANSPARENT;
        }, TOUCH_CONFIG.VISUAL_FEEDBACK_DURATION);
    }
    
    /**
     * Provide haptic feedback for successful selection
     * @private
     */
    _provideSelectionFeedback() {
        if (navigator.vibrate) {
            navigator.vibrate(TOUCH_CONFIG.HAPTIC_SELECTION_SUCCESS);
        }
    }
    
    /**
     * Clear selection after delay
     * @private
     */
    _clearSelectionAfterDelay() {
        setTimeout(() => {
            this.terminal.clearSelection();
        }, TOUCH_CONFIG.SELECTION_CLEAR_DELAY);
    }
    
    /**
     * Clear current terminal selection
     * @private
     */
    _clearSelection() {
        if (this.terminal.hasSelection()) {
            console.log('[MobileTouch] Clearing terminal selection');
            this.terminal.clearSelection();
        }
    }
    
    /**
     * Cancel momentum animation
     * @private
     */
    _cancelMomentum() {
        if (this.touchState.momentumAnimationId) {
            cancelAnimationFrame(this.touchState.momentumAnimationId);
            this.touchState.momentumAnimationId = null;
        }
    }
    
    /**
     * Clear long press timer
     * @private
     */
    _clearLongPressTimer() {
        if (this.selectionState.longPressTimer) {
            console.log('[MobileTouch] Clearing long press timer');
            clearTimeout(this.selectionState.longPressTimer);
            this.selectionState.longPressTimer = null;
        }
    }
    
    /**
     * Prevent mobile keyboard popup by setting flag and blurring input elements
     * @private
     */
    _preventMobileKeyboard() {
        // Set global flag to prevent xterm focus attempts (existing system)
        window._mobileKeyboardInputActive = true;
        
        // Blur any currently active input elements
        if (document.activeElement && this._isInputElement(document.activeElement)) {
            console.log('[MobileTouch] Blurring active element to prevent keyboard:', document.activeElement.className || document.activeElement.tagName);
            document.activeElement.blur();
        }
        
        // Also specifically blur the xterm helper textarea
        const xtermTextarea = this.terminal.element.querySelector('.xterm-helper-textarea');
        if (xtermTextarea) {
            console.log('[MobileTouch] Blurring xterm helper textarea');
            xtermTextarea.blur();
        }
    }
    
    /**
     * Check if an element is an input element that could trigger mobile keyboard
     * @private
     */
    _isInputElement(element) {
        return element && (
            element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA' ||
            element.contentEditable === 'true' ||
            element.classList.contains('xterm-helper-textarea')
        );
    }
    
    /**
     * Start DOM-level focus prevention during long press operations
     * Prevents mobile keyboard from appearing during potential text selection
     * @private
     */
    _startFocusPrevention() {
        if (this.focusPrevention.isBlocking) return;
        
        console.log('[MobileTouch] Starting focus prevention with long press timer');
        this.focusPrevention.isBlocking = true;
        
        // Prevent focus events when long press timer is active OR in selection mode
        this.focusPrevention.focusListener = (e) => {
            if (!this._shouldBlockFocusEvents()) return;
            
            if (this._isInputElement(e.target)) {
                console.log('[MobileTouch] Blocking focus event during long press/selection on:', e.target.className || e.target.tagName);
                e.preventDefault();
                e.stopPropagation();
                e.target.blur();
            }
        };
        
        // Prevent mousedown events during long press timer or selection mode
        this.focusPrevention.mousedownListener = (e) => {
            if (!this._shouldBlockFocusEvents()) return;
            
            if (this._isInputElement(e.target)) {
                console.log('[MobileTouch] Blocking mousedown event during long press/selection on:', e.target.className || e.target.tagName);
                e.preventDefault();
                e.stopPropagation();
            }
        };
        
        // Add listeners with capture=true to intercept before reaching target
        const elements = [document, this.terminal.element];
        elements.forEach(element => {
            element.addEventListener('focus', this.focusPrevention.focusListener, true);
            element.addEventListener('mousedown', this.focusPrevention.mousedownListener, true);
        });
    }
    
    /**
     * Check if focus events should be blocked based on current state
     * @private
     */
    _shouldBlockFocusEvents() {
        // Block if long press timer is running (potential selection) OR actively selecting
        return this.selectionState.longPressTimer || this.selectionState.isLongPressMode;
    }
    
    /**
     * Stop DOM-level focus prevention
     * @private
     */
    _stopFocusPrevention() {
        if (!this.focusPrevention.isBlocking) return;
        
        console.log('[MobileTouch] Stopping DOM-level focus prevention');
        this.focusPrevention.isBlocking = false;
        
        // Remove event listeners from both document and terminal element
        const elements = [document, this.terminal.element];
        const events = [
            { type: 'focus', listener: this.focusPrevention.focusListener },
            { type: 'mousedown', listener: this.focusPrevention.mousedownListener }
        ];
        
        elements.forEach(element => {
            events.forEach(({ type, listener }) => {
                if (listener) {
                    element.removeEventListener(type, listener, true);
                }
            });
        });
        
        // Clear listener references
        this.focusPrevention.focusListener = null;
        this.focusPrevention.mousedownListener = null;
        
        // Clear the mobile keyboard flag
        if (window._mobileKeyboardInputActive) {
            console.log('[MobileTouch] Clearing mobile keyboard input flag');
            window._mobileKeyboardInputActive = false;
        }
    }
    
    /**
     * Reset touch state
     * @private
     */
    _resetTouchState() {
        console.log('[MobileTouch] Resetting touch state');
        this.touchState.isScrolling = false;
        this.touchState.scrollDirection = null;
    }
    
    /**
     * Reset selection state
     * @private
     */
    _resetSelectionState() {
        console.log('[MobileTouch] Resetting selection state');
        this._stopSelectionAutoScroll();
        this.selectionState.isLongPressMode = false;
        this.selectionState.isSelecting = false;
        this.selectionState.selectionStartPos = null;
    }
    
    /**
     * Load scroll forwarding state from localStorage
     * @private
     * @returns {boolean} The saved scroll forwarding state, or false by default
     */
    _loadScrollForwardingState() {
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const state = res && res.ok ? (res.state || {}) : {};
            const v = state['mobile_scroll_forwarding_enabled'];
            if (v != null) return (v === true || v === 'true');
        } catch (_) {}
        return false;
    }
    
}
