/**
 * Mobile Device Detection Utility
 * Provides reliable mobile device detection for preventing unwanted mobile behaviors
 */
import { appStore } from '../core/store.js';

class MobileDetection {
    constructor() {
        this.isMobile = this.detectMobile();
        this.isTouch = this.detectTouch();
    }
    
    /**
     * Whether debug logs for mobile detection are enabled via settings
     */
    _debugEnabled() {
        try {
            const prefs = appStore.getState('preferences.debug') || {};
            return prefs.mobileDetectionLogs === true;
        } catch (_) {
            return false;
        }
    }
    
    detectMobile() {
        // Multiple detection methods for reliability
        const userAgentMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const screenSizeMobile = (window.innerWidth <= 768);
        const touchMobile = ('ontouchstart' in window && window.innerWidth <= 1024);
        const mediaQueryMobile = window.matchMedia('(max-width: 768px)').matches;
        // Detect Capacitor (native wrapper) and treat as mobile
        const isCapacitor = (() => { try { return !!window.Capacitor; } catch (_) { return false; } })();
        
        // Enhanced landscape detection - mobile device in landscape might have width > 768
        const landscapeTouch = ('ontouchstart' in window && 
                               window.innerWidth > window.innerHeight && 
                               window.innerWidth <= 1366); // Typical mobile landscape width
        
        // Enhanced mobile detection including landscape mode and Capacitor builds
        const isMobile = userAgentMobile || screenSizeMobile || touchMobile || mediaQueryMobile || landscapeTouch || isCapacitor;
        
        if (this._debugEnabled()) {
            console.log('[MobileDetection] detectMobile result:', {
                userAgentMobile,
                screenSizeMobile,
                touchMobile, 
                mediaQueryMobile,
                landscapeTouch,
                isCapacitor,
                finalResult: isMobile,
                dimensions: { width: window.innerWidth, height: window.innerHeight }
            });
        }
        
        return isMobile;
    }
    
    detectTouch() {
        return (
            'ontouchstart' in window ||
            navigator.maxTouchPoints > 0 ||
            window.DocumentTouch && document instanceof DocumentTouch
        );
    }
    
    // Check if we should prevent auto-focus (mobile devices)
    shouldPreventAutoFocus() {
        // Be more aggressive - prevent focus on ANY touch-capable device
        const preventFocus = this.isMobile || this.isTouch || 
                            ('ontouchstart' in window) || 
                            (navigator.maxTouchPoints > 0) ||
                            /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        
        if (this._debugEnabled()) {
            console.log('[MobileDetection] shouldPreventAutoFocus result:', {
                preventFocus,
                isMobile: this.isMobile,
                isTouch: this.isTouch,
                hasOntouchstart: 'ontouchstart' in window,
                maxTouchPoints: navigator.maxTouchPoints,
                userAgent: navigator.userAgent
            });
        }
        
        return preventFocus;
    }
    
    // Update detection on resize/orientation change
    updateDetection() {
        const wasMobile = this.isMobile;
        this.isMobile = this.detectMobile();
        this.isTouch = this.detectTouch();
        
        if (wasMobile !== this.isMobile) {
            if (this._debugEnabled()) {
                console.log('[MobileDetection] Mobile state changed:', {
                    isMobile: this.isMobile,
                    isTouch: this.isTouch,
                    shouldPreventAutoFocus: this.shouldPreventAutoFocus()
                });
            }
        }
        
        return this.isMobile;
    }
    
    // Get current detection state for debugging
    getState() {
        return {
            isMobile: this.isMobile,
            isTouch: this.isTouch,
            shouldPreventAutoFocus: this.shouldPreventAutoFocus(),
            userAgent: navigator.userAgent,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight
        };
    }
}

// Create and export singleton instance
export const mobileDetection = new MobileDetection();

// Update detection on resize and orientation change
window.addEventListener('resize', () => mobileDetection.updateDetection());
window.addEventListener('orientationchange', () => {
    setTimeout(() => mobileDetection.updateDetection(), 100);
});

// Make available globally for debugging
window.mobileDetection = mobileDetection;

// Global debugging function
window.checkMobileState = () => mobileDetection.getState();
