/**
 * Text Input Modal Drag Module
 * Handles mobile-optimized drag functionality for the text input modal
 * Similar to MobileKeyboardDrag but optimized for modal interaction
 */

import { DraggableElement } from './draggable-element.js';

export class TextInputModalDrag {
    constructor(element, options = {}) {
        this.element = element;
        this.onDragStart = options.onDragStart || (() => {});
        this.onDragEnd = options.onDragEnd || (() => {});
        this.onPositionChange = options.onPositionChange || (() => {});
        
        // Create draggable instance with text input modal specific configuration
        this.draggable = new DraggableElement(element, {
            onDragStart: this.onDragStart,
            onDragEnd: this.onDragEnd,
            onPositionChange: this.onPositionChange,
            dragHandle: '.floating-modal-content', // Allow dragging from entire modal content
            storageKey: 'textInputModalPosition',
            visibilityClass: 'show', // Only active when modal is visible
            dragThreshold: 30, // Higher threshold for mobile tolerance - optimized for modal use
            quickTapThreshold: 250, // Longer threshold for modal interactions - allows for deliberate taps
            dragReleaseGracePeriod: 200 // Longer grace period for modal buttons - prevents accidental clicks
        });
        
        this.init();
    }
    
    init() {
        // Draggable instance handles initialization
    }
    
    /**
     * Returns true if button clicks should be blocked due to drag state
     */
    shouldBlockClick() {
        return this.draggable.shouldBlockClick();
    }
    
    /**
     * Force clear all drag state (for button handlers)
     */
    clearDragState() {
        this.draggable.clearDragState();
    }
    
    /**
     * Apply saved position when showing the modal
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