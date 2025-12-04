/**
 * Generic Draggable Element Module
 * Provides drag functionality for any DOM element while preventing click interference
 */

import { getStateStore } from '../core/state-store/index.js';
import { queueStateSet } from '../core/state-store/batch.js';

export class DraggableElement {
    constructor(element, options = {}) {
        this.element = element;
        this.options = {
            // Callbacks
            onDragStart: options.onDragStart || (() => {}),
            onDragEnd: options.onDragEnd || (() => {}),
            onPositionChange: options.onPositionChange || (() => {}),
            
            // Configuration
            dragThreshold: options.dragThreshold || 25, // pixels of movement before drag starts
            quickTapThreshold: options.quickTapThreshold || 200, // ms - if tap is quicker than this, always treat as click
            dragReleaseGracePeriod: options.dragReleaseGracePeriod || 150, // ms - prevent clicks briefly after drag release
            constrainToViewport: options.constrainToViewport !== false, // default true
            storageKey: options.storageKey || null, // localStorage key for position persistence
            dragHandle: options.dragHandle || null, // specific element to use as drag handle (selector or element)
            visibilityClass: options.visibilityClass || null // CSS class that indicates element is visible/active
        };
        
        // Drag state
        this.isDragging = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.elementX = null;
        this.elementY = null;
        
        // Swipe detection state
        this.potentialDrag = false;
        this.touchActive = false;
        this.initialTouchX = 0;
        this.initialTouchY = 0;
        this.touchStartTime = 0;
        this.lastDragEndTime = 0;
        
        this.init();
    }
    
    init() {
        this.loadSavedPosition();
        this.setupEventListeners();
    }
    
    loadSavedPosition() {
        if (!this.options.storageKey) return;
        
        // Load saved position from StateStore
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const st = res && res.ok ? (res.state || {}) : {};
            const saved = st[this.options.storageKey];
            if (saved) {
                const pos = typeof saved === 'string' ? JSON.parse(saved) : saved;
                if (typeof pos.x === 'number' && typeof pos.y === 'number') {
                    this.elementX = pos.x;
                    this.elementY = pos.y;
                }
            }
        } catch (e) {
            // ignore
        }
    }
    
    setupEventListeners() {
        // Determine drag handle - either specific element or the main element
        const dragHandle = this.getDragHandle();
        
        if (!dragHandle) return;
        
        // Global mouse events only for actual dragging
        document.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                this.handleDrag(e.clientX, e.clientY);
                e.preventDefault();
            }
        });
        
        document.addEventListener('mouseup', () => {
            if (this.touchActive) {
                this.potentialDrag = false;
                this.touchActive = false;
                this.endDrag();
            }
        });
        
        // Touch events for drag handle (with threshold)
        dragHandle.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            this.touchActive = true;
            this.potentialDrag = true;
            this.initialTouchX = touch.clientX;
            this.initialTouchY = touch.clientY;
            this.touchStartTime = Date.now();
        }, { passive: true });
        
        dragHandle.addEventListener('touchmove', (e) => {
            if (!this.potentialDrag || this.isDragging) return;
            
            // Don't start drag if it's a quick tap
            const timeDiff = Date.now() - this.touchStartTime;
            if (timeDiff < this.options.quickTapThreshold) {
                return;
            }
            
            const touch = e.touches[0];
            const deltaX = Math.abs(touch.clientX - this.initialTouchX);
            const deltaY = Math.abs(touch.clientY - this.initialTouchY);
            const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
            
            // Check if movement exceeds threshold
            if (distance > this.options.dragThreshold) {
                this.potentialDrag = false;
                this.startDrag(this.initialTouchX, this.initialTouchY);
                e.preventDefault();
                document.body.style.userSelect = 'none';
                document.body.style.webkitUserSelect = 'none';
            }
        }, { passive: false });
        
        // Mouse events for drag handle (with threshold)
        dragHandle.addEventListener('mousedown', (e) => {
            this.touchActive = true;
            this.potentialDrag = true;
            this.initialTouchX = e.clientX;
            this.initialTouchY = e.clientY;
            this.touchStartTime = Date.now();
        });
        
        dragHandle.addEventListener('mousemove', (e) => {
            if (!this.potentialDrag || this.isDragging) return;
            
            // Don't start drag if it's a quick click
            const timeDiff = Date.now() - this.touchStartTime;
            if (timeDiff < this.options.quickTapThreshold) {
                return;
            }
            
            const deltaX = Math.abs(e.clientX - this.initialTouchX);
            const deltaY = Math.abs(e.clientY - this.initialTouchY);
            const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
            
            // Check if movement exceeds threshold
            if (distance > this.options.dragThreshold) {
                this.potentialDrag = false;
                this.startDrag(this.initialTouchX, this.initialTouchY);
                e.preventDefault();
            }
        });
        
        // Global touch start to detect touches outside element
        document.addEventListener('touchstart', (e) => {
            setTimeout(() => {
                const touch = e.touches[0];
                
                // Only handle if element is visible (if visibility class is specified)
                const isVisible = !this.options.visibilityClass || this.element.classList.contains(this.options.visibilityClass);
                
                if (this.element && isVisible && (this.potentialDrag || this.touchActive || this.isDragging)) {
                    const rect = this.element.getBoundingClientRect();
                    const isInsideElement = (
                        touch.clientX >= rect.left && 
                        touch.clientX <= rect.right && 
                        touch.clientY >= rect.top && 
                        touch.clientY <= rect.bottom
                    );
                    
                    if (!isInsideElement) {
                        // Touch started outside element - clear any active drag state
                        this.clearDragState();
                    }
                }
            }, 10); // Small delay to let element handlers run first
        }, { passive: true });
        
        // Global touch events only for actual dragging
        document.addEventListener('touchmove', (e) => {
            if (this.isDragging && this.touchActive) {
                const touch = e.touches[0];
                this.handleDrag(touch.clientX, touch.clientY);
                e.preventDefault();
            }
        }, { passive: false });
        
        document.addEventListener('touchend', (e) => {
            if (this.isDragging) {
                this.endDrag();
                document.body.style.userSelect = '';
                document.body.style.webkitUserSelect = '';
            } else if (this.potentialDrag || this.touchActive) {
                // Clear potential drag state
                this.clearDragState();
            }
        }, { passive: true });
    }
    
    getDragHandle() {
        if (this.options.dragHandle) {
            if (typeof this.options.dragHandle === 'string') {
                return this.element.querySelector(this.options.dragHandle);
            } else if (this.options.dragHandle instanceof Element) {
                return this.options.dragHandle;
            }
        }
        return this.element;
    }
    
    blurFocusedElements() {
        // Blur any focused elements within the draggable element to prevent scroll interference
        const activeElement = document.activeElement;
        if (activeElement && this.element.contains(activeElement)) {
            // Only blur if the focused element is within our draggable element
            activeElement.blur();
        }
    }
    
    startDrag(clientX, clientY) {
        const rect = this.element.getBoundingClientRect();
        
        this.isDragging = true;
        this.potentialDrag = false;
        
        // Blur any focused elements to prevent scroll interference
        this.blurFocusedElements();
        
        // Calculate the offset from the current mouse/touch position to the top-left of the element
        this.dragStartX = clientX - rect.left;
        this.dragStartY = clientY - rect.top;
        
        // Update our position tracking to match the current actual position
        this.elementX = rect.left;
        this.elementY = rect.top;
        
        this.element.classList.add('dragging');
        this.options.onDragStart();
    }
    
    handleDrag(clientX, clientY) {
        if (!this.isDragging) return;
        
        // Calculate new position
        let newX = clientX - this.dragStartX;
        let newY = clientY - this.dragStartY;
        
        // Constrain to viewport if enabled
        if (this.options.constrainToViewport) {
            const rect = this.element.getBoundingClientRect();
            const maxX = window.innerWidth - rect.width;
            const maxY = window.innerHeight - rect.height;
            
            newX = Math.max(0, Math.min(newX, maxX));
            newY = Math.max(0, Math.min(newY, maxY));
        }
        
        // Apply position
        this.element.style.transform = 'none';
        this.element.style.left = newX + 'px';
        this.element.style.top = newY + 'px';
        
        // Store position
        this.elementX = newX;
        this.elementY = newY;
        
        this.options.onPositionChange(newX, newY);
    }
    
    endDrag() {
        if (!this.isDragging && !this.potentialDrag) return;
        
        // If we were actually dragging, make sure position is finalized
        if (this.isDragging) {
            const rect = this.element.getBoundingClientRect();
            this.elementX = rect.left;
            this.elementY = rect.top;
        }
        
        // Set timestamp when drag actually ends to prevent immediate clicks
        if (this.isDragging) {
            this.lastDragEndTime = Date.now();
        }
        
        this.isDragging = false;
        this.potentialDrag = false;
        this.touchActive = false;
        this.element.classList.remove('dragging');
        
        // Clear drag interaction state but preserve position state
        this.initialTouchX = 0;
        this.initialTouchY = 0;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.touchStartTime = 0;
        
        // Save position to StateStore if enabled
        this.savePosition();
        
        this.options.onDragEnd();
    }
    
    savePosition() {
        if (!this.options.storageKey || this.elementX === null || this.elementY === null) return;
        try { queueStateSet(this.options.storageKey, { x: this.elementX, y: this.elementY }, 200); } catch (_) {}
    }
    
    /**
     * Returns true if click should be blocked due to drag state
     */
    shouldBlockClick() {
        // If we're currently dragging, block click
        if (this.isDragging) {
            this.endDrag();
            this.lastDragEndTime = Date.now();
            return true;
        }
        
        // Check if this is too soon after a previous drag release
        const timeSinceLastDrag = this.lastDragEndTime > 0 ? Date.now() - this.lastDragEndTime : 9999;
        if (timeSinceLastDrag < this.options.dragReleaseGracePeriod) {
            return true;
        }
        
        // Clear any remaining stuck state
        this.clearDragState();
        return false;
    }
    
    /**
     * Force clear all drag state
     */
    clearDragState() {
        this.potentialDrag = false;
        this.touchActive = false;
        this.isDragging = false;
        this.initialTouchX = 0;
        this.initialTouchY = 0;
        this.touchStartTime = 0;
        this.element.classList.remove('dragging');
        
        // Restore text selection
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
    }
    
    /**
     * Apply saved position when showing the element
     */
    applyPosition() {
        if (this.elementX !== null && this.elementY !== null) {
            this.element.style.transform = 'none';
            this.element.style.left = this.elementX + 'px';
            this.element.style.top = this.elementY + 'px';
            return true;
        }
        return false;
    }
    
    /**
     * Initialize position tracking after element is shown
     */
    initializePosition() {
        if (this.elementX === null || this.elementY === null) {
            // Wait for element to be visible then get its position
            requestAnimationFrame(() => {
                const rect = this.element.getBoundingClientRect();
                this.elementX = rect.left;
                this.elementY = rect.top;
            });
        }
    }
    
    /**
     * Set the element position programmatically
     */
    setPosition(x, y) {
        this.elementX = x;
        this.elementY = y;
        this.element.style.transform = 'none';
        this.element.style.left = x + 'px';
        this.element.style.top = y + 'px';
        this.savePosition();
    }
    
    /**
     * Reset position to center of viewport
     */
    centerElement() {
        const rect = this.element.getBoundingClientRect();
        const centerX = (window.innerWidth - rect.width) / 2;
        const centerY = (window.innerHeight - rect.height) / 2;
        this.setPosition(centerX, centerY);
    }
    
    /**
     * Clean up event handlers
     */
    destroy() {
        // Event handlers are added to global document, so they would need to be tracked
        // and removed here in a production implementation
        // For now, this is a placeholder for the interface
    }
}
