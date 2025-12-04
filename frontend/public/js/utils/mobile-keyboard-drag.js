/**
 * Mobile Keyboard Drag Module
 * Handles drag functionality for the mobile keyboard dropdown
 * Now uses the generic DraggableElement class
 */

import { DraggableElement } from './draggable-element.js';

export class MobileKeyboardDrag {
    constructor(element, options = {}) {
        this.element = element;
        this.onDragStart = options.onDragStart || (() => {});
        this.onDragEnd = options.onDragEnd || (() => {});
        this.onPositionChange = options.onPositionChange || (() => {});
        
        // Create draggable instance with mobile keyboard specific configuration
        this.draggable = new DraggableElement(element, {
            onDragStart: this.onDragStart,
            onDragEnd: this.onDragEnd,
            onPositionChange: this.onPositionChange,
            dragHandle: '.mobile-keyboard-content', // Only content area is draggable
            storageKey: 'mobileKeyboardPosition',
            visibilityClass: 'show', // Only active when keyboard is visible
            dragThreshold: 25, // pixels of movement before drag starts - increased for better tolerance
            quickTapThreshold: 200, // ms - if tap is quicker than this, always treat as click
            dragReleaseGracePeriod: 150 // ms - prevent key presses briefly after drag release
        });
        
        this.init();
    }
    
    init() {
        // Draggable instance handles initialization
    }
    
    /**
     * Returns true if key press should be blocked due to drag state
     */
    shouldBlockKeyPress() {
        return this.draggable.shouldBlockClick();
    }
    
    /**
     * Force clear all drag state (for button handlers)
     */
    clearDragState() {
        this.draggable.clearDragState();
    }
    
    /**
     * Apply saved position when showing the keyboard
     */
    applyPosition() {
        return this.draggable.applyPosition();
    }
    
    /**
     * Initialize position tracking after element is shown
     */
    initializePosition() {
        this.draggable.initializePosition();
    }
    
    /**
     * Clean up event handlers
     */
    destroy() {
        this.draggable.destroy();
    }
}