/**
 * Mobile Viewport Height Utility
 * Fixes viewport height issues on mobile devices
 */

class MobileViewport {
    constructor() {
        this.supportsDvh = CSS.supports('height', '100dvh');
        this.init();
    }

    init() {
        // Always set viewport height for mobile compatibility
        this.setViewportHeight();
        this.setupEventListeners();
        
        // Log initial viewport setup for debugging
        console.log('[MobileViewport] Initialized with dvh support:', this.supportsDvh);
    }

    setViewportHeight() {
        // Calculate the actual viewport height
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--vh', `${vh}px`);
        
        // Also set the actual viewport height variable used by responsive toolbar manager
        const actualHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        document.documentElement.style.setProperty('--actual-viewport-height', `${actualHeight}px`);
        
        // Debug logging for mobile viewport issues
        console.log('[MobileViewport] Updated:', {
            innerHeight: window.innerHeight,
            visualViewportHeight: window.visualViewport ? window.visualViewport.height : 'N/A',
            actualHeightUsed: actualHeight,
            vh: vh
        });
    }

    setupEventListeners() {
        // Update on resize and orientation change
        window.addEventListener('resize', () => this.setViewportHeight());
        window.addEventListener('orientationchange', () => {
            // Delay to ensure accurate height after orientation change
            setTimeout(() => this.setViewportHeight(), 100);
        });
        
        // Visual viewport API for better mobile viewport handling
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => {
                this.setViewportHeight();
            });
        }
    }
}

// Auto-initialize
export const mobileViewport = new MobileViewport();