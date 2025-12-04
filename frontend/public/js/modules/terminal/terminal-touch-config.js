/**
 * Terminal Touch Configuration
 * Centralized configuration constants for mobile touch interactions
 */

export const TOUCH_CONFIG = {
    // Long press settings
    LONG_PRESS_THRESHOLD: 600, // milliseconds
    LONG_PRESS_TOLERANCE: 10, // pixels - maximum movement allowed during long press
    SCROLL_INTENT_THRESHOLD: 5, // pixels - movement threshold to detect scroll intent (half of long press tolerance for vertical movement)
    
    // Scroll sensitivity settings
    PIXELS_PER_LINE_DRAG: 20, // Sensitivity for drag scrolling
    PIXELS_PER_LINE_MOMENTUM: 10, // Sensitivity for momentum scrolling
    MOMENTUM_THRESHOLD: 5, // pixels - minimum distance to trigger momentum
    
    // Selection settings
    MIN_DISTANCE_FOR_MOMENTUM: 80, // pixels - minimum swipe distance for momentum effect
    MAX_DISTANCE_FOR_MOMENTUM: 200, // pixels - distance for maximum momentum effect
    SELECTION_AUTO_SCROLL_ZONE: 60, // pixels - zone height at top/bottom for auto-scroll during selection
    SELECTION_AUTO_SCROLL_SPEED: 100, // milliseconds - auto-scroll interval during selection
    TOUCH_OVERLAY_EXTENSION: 50, // pixels - extension of touch overlay beyond terminal bounds
    
    // Momentum physics
    MOMENTUM_FRICTION: 0.94, // velocity decay factor per frame
    MOMENTUM_VELOCITY_THRESHOLD: 0.5, // minimum velocity to start momentum
    MOMENTUM_STOP_THRESHOLD: 5, // minimum velocity to continue momentum
    MOMENTUM_BOOST: 1.5, // extra boost for momentum scrolling
    
    // UI timeouts
    URL_POPUP_AUTO_HIDE: 8000, // milliseconds
    SELECTION_CLEAR_DELAY: 1000, // milliseconds
    REFOCUS_DELAY: 100, // milliseconds
    VISUAL_FEEDBACK_DURATION: 150, // milliseconds
    
    // Haptic feedback
    HAPTIC_LONG_PRESS: [50], // vibration pattern for long press
    HAPTIC_SELECTION_SUCCESS: [50, 50, 50], // vibration pattern for successful selection
    
    // Visual feedback
    HIGHLIGHT_COLOR: 'rgba(255, 255, 255, 0.1)',
    TRANSPARENT: 'transparent'
};