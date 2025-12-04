/**
 * Responsive Toolbar Manager
 * Manages toolbar visibility based on screen height to maximize terminal space
 */

class ResponsiveToolbarManager {
    constructor() {
        this.isInitialized = false;
        this.currentState = null;
        this.forcedState = null; // allow explicit override via URL or environment
        this.thresholds = {
            verySmall: 200,    // Hide all toolbars only at minimum height
            small: 600,        // Hide some toolbars
            medium: 768        // Normal mobile behavior (disabled on Electron)
        };
        
        // Detect an explicit window/minimal hint from URL to avoid full chrome in
        // dedicated session windows (e.g., Electron secondary windows).
        try {
            const useMinimal = (window.WindowModeUtils && typeof WindowModeUtils.shouldUseMinimalModeFromUrl === 'function')
                ? WindowModeUtils.shouldUseMinimalModeFromUrl(window.location)
                : false;
            const useWindow = (window.WindowModeUtils && typeof WindowModeUtils.shouldUseWindowModeFromUrl === 'function')
                ? WindowModeUtils.shouldUseWindowModeFromUrl(window.location)
                : false;
            if (useMinimal) {
                this.forcedState = 'minimal';
                try { document.addEventListener('DOMContentLoaded', () => { try { document.body.classList.add('responsive-minimal'); } catch (_) {} }); } catch (_) {}
            } else if (useWindow) {
                this.forcedState = 'window';
                try { document.addEventListener('DOMContentLoaded', () => { try { document.body.classList.add('responsive-window'); } catch (_) {} }); } catch (_) {}
            }
        } catch (_) { /* ignore */ }

        this.init();
    }
    
    init() {
        if (this.isInitialized) return;
        
        this.setupEventListeners();
        this.checkScreenHeight();
        this.isInitialized = true;
        
        // Log initial screen dimensions
        this.logScreenDimensions('Initial load');
    }
    
    setupEventListeners() {
        // Check on resize
        window.addEventListener('resize', () => {
            this.checkScreenHeight();
            this.logScreenDimensions('Resize');
        });
        
        // Check on orientation change
        window.addEventListener('orientationchange', () => {
            // Small delay to ensure accurate height after orientation change
            setTimeout(() => {
                this.checkScreenHeight();
                this.logScreenDimensions('Orientation change');
            }, 100);
        });
        
        // Visual viewport API for more accurate mobile measurements
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => {
                this.checkScreenHeight();
                this.logScreenDimensions('Visual viewport resize');
            });
        }
    }
    
    checkScreenHeight() {
        const viewportHeight = this.getViewportHeight();
        const newState = this.determineState(viewportHeight);
        
        if (newState !== this.currentState) {
            this.currentState = newState;
            this.applyState(newState);
            this.logStateChange(newState, viewportHeight);
        } else {
            // Even if state hasn't changed, update CSS variables in case they were reset
            this.updateHeaderHeightVariables(newState);
        }
    }
    
    getViewportHeight() {
        // Use the most accurate viewport height available
        if (window.visualViewport) {
            return window.visualViewport.height;
        }
        return window.innerHeight;
    }
    
    determineState(height) {
        // Respect an explicit override if present
        if (this.forcedState === 'minimal' || this.forcedState === 'compact' || this.forcedState === 'window') {
            return this.forcedState;
        }
        const isElectron = (() => {
            try { return document.documentElement.classList.contains('is-electron'); } catch (_) { return false; }
        })();
        if (height <= this.thresholds.verySmall) {
            return 'minimal'; // Hide all toolbars
        } else if (height <= this.thresholds.small) {
            return 'compact'; // Hide some toolbars
        } else if (height <= this.thresholds.medium) {
            // On Electron desktop, do not apply the 'mobile' state regardless of viewport size
            return isElectron ? 'desktop' : 'mobile';
        } else {
            return 'desktop'; // Full desktop layout
        }
    }
    
    applyState(state) {
        const body = document.body;
        
        // Remove existing responsive classes
        body.classList.remove('responsive-minimal', 'responsive-compact', 'responsive-mobile', 'responsive-window');
        
        // Update CSS variables for header heights based on state
        this.updateHeaderHeightVariables(state);
        
        // Add appropriate class
        switch (state) {
            case 'minimal':
                body.classList.add('responsive-minimal');
                break;
            case 'window':
                body.classList.add('responsive-window');
                break;
            case 'compact':
                body.classList.add('responsive-compact');
                break;
            case 'mobile':
                body.classList.add('responsive-mobile');
                break;
            case 'desktop':
                // No special class needed - default styles
                break;
        }
        
        // Trigger terminal resize after a short delay to allow CSS changes to take effect
        setTimeout(() => {
            this.triggerTerminalResize();
        }, 50);
    }
    
    updateHeaderHeightVariables(state) {
        const root = document.documentElement;
        
        // Default header heights
        const defaultHeights = {
            'app-header': '60px',
            'terminal-header': '55px',
            'session-tabs': '38px',
            'terminal-tabs': '38px',
            'session-info-toolbar': '48px',
            'session-info-toolbar-mobile': '40px'
        };
        
        switch (state) {
            case 'minimal':
                // Hide ALL toolbars - set all heights to 0
                root.style.setProperty('--app-header-height', '0px');
                root.style.setProperty('--terminal-header-height', '0px');
                root.style.setProperty('--session-tabs-height', '0px');
                root.style.setProperty('--terminal-tabs-height', '0px');
                root.style.setProperty('--session-info-toolbar-height', '0px');
                root.style.setProperty('--session-info-toolbar-height-mobile', '0px');
                break;
            case 'window':
                // Dedicated window: hide app header, session tabs, and session info toolbar
                // Keep terminal header and terminal tabs visible
                root.style.setProperty('--app-header-height', '0px');
                root.style.setProperty('--terminal-header-height', defaultHeights['terminal-header']);
                root.style.setProperty('--session-tabs-height', '0px');
                root.style.setProperty('--terminal-tabs-height', defaultHeights['terminal-tabs']);
                root.style.setProperty('--session-info-toolbar-height', '0px');
                root.style.setProperty('--session-info-toolbar-height-mobile', '0px');
                break;
                
            case 'compact':
                // Hide secondary toolbars only
                root.style.setProperty('--app-header-height', defaultHeights['app-header']);
                root.style.setProperty('--terminal-header-height', defaultHeights['terminal-header']);
                root.style.setProperty('--session-tabs-height', '0px'); // Hidden in compact
                root.style.setProperty('--terminal-tabs-height', defaultHeights['terminal-tabs']);
                root.style.setProperty('--session-info-toolbar-height', '0px'); // Hidden in compact
                root.style.setProperty('--session-info-toolbar-height-mobile', '0px'); // Hidden in compact
                break;
                
            case 'mobile':
            case 'desktop':
            default:
                // Restore all default heights
                Object.entries(defaultHeights).forEach(([key, value]) => {
                    root.style.setProperty(`--${key}-height`, value);
                });
                break;
        }
        
        console.log(`[ResponsiveToolbars] Updated header height variables for state: ${state}`, {
            appHeader: root.style.getPropertyValue('--app-header-height') || 'not set',
            terminalHeader: root.style.getPropertyValue('--terminal-header-height') || 'not set',
            terminalTabs: root.style.getPropertyValue('--terminal-tabs-height') || 'not set',
            sessionTabs: root.style.getPropertyValue('--session-tabs-height') || 'not set'
        });
    }
    
    // Public method for debugging - check current CSS variable values
    getCurrentHeaderHeights() {
        const root = document.documentElement;
        return {
            appHeader: root.style.getPropertyValue('--app-header-height') || getComputedStyle(root).getPropertyValue('--app-header-height'),
            terminalHeader: root.style.getPropertyValue('--terminal-header-height') || getComputedStyle(root).getPropertyValue('--terminal-header-height'),
            terminalTabs: root.style.getPropertyValue('--terminal-tabs-height') || getComputedStyle(root).getPropertyValue('--terminal-tabs-height'),
            sessionTabs: root.style.getPropertyValue('--session-tabs-height') || getComputedStyle(root).getPropertyValue('--session-tabs-height'),
            sessionInfoToolbar: root.style.getPropertyValue('--session-info-toolbar-height') || getComputedStyle(root).getPropertyValue('--session-info-toolbar-height'),
            currentState: this.currentState
        };
    }
    
    triggerTerminalResize() {
        // Trigger window resize event to make xterm.js recalculate dimensions
        window.dispatchEvent(new Event('resize'));
        
        // Also trigger any custom terminal resize events if they exist
        const resizeEvent = new CustomEvent('terminal-resize', {
            detail: { 
                trigger: 'responsive-toolbar-change',
                state: this.currentState 
            }
        });
        window.dispatchEvent(resizeEvent);
        
        // Force xterm.js to recalculate dimensions by calling fit() if available
        setTimeout(() => {
            this.forceXtermRefit();
        }, 100);
    }
    
    forceXtermRefit() {
        // Try to find and refit any active xterm instances
        const xtermElements = document.querySelectorAll('.xterm');
        xtermElements.forEach(element => {
            // Check if the element has an xterm instance attached
            if (element._terminal && element._terminal.fit) {
                element._terminal.fit();
                console.log('[ResponsiveToolbars] Forced xterm refit');
            }
        });
        
        // Also try to access global terminal instances if they exist
        if (window.terminalManager && window.terminalManager.activeSession) {
            const session = window.terminalManager.activeSession;
            if (session.terminal && session.fitAddon) {
                session.fitAddon.fit();
                console.log('[ResponsiveToolbars] Forced active terminal refit');
            }
        }
    }
    
    logScreenDimensions(event) {
        const vvHeight = window.visualViewport ? window.visualViewport.height : 'N/A';
        const innerHeight = window.innerHeight;
        const outerHeight = window.outerHeight;
        const screenHeight = screen.height;
        const devicePixelRatio = window.devicePixelRatio || 1;
        
        console.log(`[ResponsiveToolbars] ${event}:`, {
            visualViewport: vvHeight,
            innerHeight: innerHeight,
            outerHeight: outerHeight,
            screenHeight: screenHeight,
            devicePixelRatio: devicePixelRatio,
            orientation: screen.orientation ? screen.orientation.angle : 'N/A',
            currentState: this.currentState
        });
    }
    
    logStateChange(newState, height) {
        console.log(`[ResponsiveToolbars] State changed to: ${newState} (height: ${height}px)`);
        
        // Log which toolbars are now hidden
        const hiddenElements = [];
        if (newState === 'minimal') {
            hiddenElements.push('app-header', 'terminal-header', 'session-tabs', 'session-info-toolbar', 'terminal-tabs', 'sidebar');
        } else if (newState === 'window') {
            hiddenElements.push('app-header', 'session-tabs', 'session-info-toolbar', 'sidebar');
        } else if (newState === 'compact') {
            hiddenElements.push('session-info-toolbar', 'session-tabs');
        }
        
        if (hiddenElements.length > 0) {
            console.log(`[ResponsiveToolbars] Hidden elements: ${hiddenElements.join(', ')}`);
        } else {
            console.log('[ResponsiveToolbars] All toolbars visible');
        }
    }
    
    // Public method to get current dimensions (for debugging)
    getCurrentDimensions() {
        return {
            visualViewport: window.visualViewport ? window.visualViewport.height : null,
            innerHeight: window.innerHeight,
            outerHeight: window.outerHeight,
            screenHeight: screen.height,
            currentState: this.currentState,
            thresholds: this.thresholds
        };
    }
    
    // Public method to manually trigger check (for debugging)
    forceCheck() {
        this.checkScreenHeight();
    }
}

// Create and export singleton instance
export const responsiveToolbarManager = new ResponsiveToolbarManager();

// Make it available globally for debugging
window.responsiveToolbarManager = responsiveToolbarManager;

// Global debugging functions
window.checkHeaderHeights = () => responsiveToolbarManager.getCurrentHeaderHeights();
window.forceResponsiveCheck = () => responsiveToolbarManager.forceCheck();
