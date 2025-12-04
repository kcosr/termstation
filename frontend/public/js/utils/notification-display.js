/**
 * Notification Display - Visual notification system
 * Handles displaying toast notifications with different types and styles
 */
import { notificationCenter } from '../modules/notification-center/notification-center.js';
import { getContext } from '../core/context.js';
import { appStore } from '../core/store.js';

export class NotificationDisplay {
    constructor() {
        this.container = null;
        this.notifications = new Map();
        this.nextId = 1;
        
        this.defaultOptions = {
            duration: 5000,
            position: 'top-right',
            animation: 'slide'
        };
        
        this.initializeContainer();
    }

    /**
     * Initialize the notification container
     */
    initializeContainer() {
        // Check if container already exists
        this.container = document.getElementById('notification-container');
        
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'notification-container';
            this.container.className = 'notification-container';
            // Check if mobile
            const isMobile = window.matchMedia('(max-width: 768px)').matches;
            
            this.container.style.cssText = `
                position: fixed;
                top: var(--app-header-height);
                right: ${isMobile ? '10px' : '20px'};
                z-index: 10000;
                pointer-events: none;
                width: ${isMobile ? 'calc(100% - 20px)' : '400px'};
                max-width: ${isMobile ? '350px' : '400px'};
            `;
            
            document.body.appendChild(this.container);
        }
        
        // Add CSS styles if not already present
        if (!document.getElementById('notification-styles')) {
            this.injectStyles();
        }
    }

    /**
     * Inject CSS styles for notifications
     */
    injectStyles() {
        const style = document.createElement('style');
        style.id = 'notification-styles';
        style.textContent = `
            .notification-container {
                font-family: var(--app-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
            }
            
            .notification {
                pointer-events: auto;
                background: var(--bg-secondary);
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                margin-bottom: 12px;
                padding: 16px;
                border-left: 4px solid var(--accent-color);
                transform: translateX(calc(100% + 20px));
                transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease;
                opacity: 0;
                max-width: 100%;
                overflow: hidden;
                position: relative;
                will-change: transform, opacity;
            }
            
            .notification.show {
                transform: translateX(0) !important;
                opacity: 1 !important;
            }
            
            .notification.hide {
                transform: translateX(100%);
                opacity: 0;
            }
            
            .notification.info {
                border-left-color: var(--accent-color);
            }
            
            .notification.success {
                border-left-color: var(--success-color);
            }
            
            .notification.warning {
                border-left-color: var(--warning-color);
            }
            
            .notification.error {
                border-left-color: var(--danger-color);
            }
            
            .notification-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 8px;
            }
            
            .notification-title {
                font-weight: 600;
                color: var(--text-primary);
                margin: 0;
                line-height: 1.4;
                word-break: break-word;
            }
            
            .notification-close {
                background: none;
                border: none;
                font-size: 18px;
                color: var(--text-secondary);
                cursor: pointer;
                padding: 0;
                margin-left: 12px;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                transition: background-color 0.2s ease;
                flex-shrink: 0;
            }
            
            .notification-close:hover {
                background-color: rgba(0, 0, 0, 0.1);
            }
            
            .notification-message {
                color: var(--text-secondary);
                margin: 0;
                line-height: 1.4;
                word-break: break-word;
            }
            
            .notification-timestamp {
                font-size: 12px;
                color: var(--text-dim);
                margin-top: 8px;
                text-align: right;
            }

            .notification-footer {
                display: flex;
                flex-direction: column;
                gap: 6px;
                align-items: stretch;
                margin-top: 8px;
            }

            .notification-session {
                font-size: 12px;
                color: var(--text-secondary);
                font-style: italic;
            }

            .notification-session.broadcast {
                color: var(--text-secondary);
                font-weight: 500;
            }

            .notification-session a {
                color: var(--accent-color);
                text-decoration: none;
                cursor: pointer;
            }

            .notification-session a:hover {
                text-decoration: underline;
            }
            
            .source-label {
                display: inline-block;
                font-size: 10px;
                line-height: 1;
                padding: 2px 6px;
                border: 1px solid var(--border-color);
                border-radius: 6px;
                color: var(--text-secondary);
                margin-right: 8px;
            }
            .source-label.server {
                border-color: var(--accent-color);
                color: var(--accent-color);
            }
            .source-label.local {
                border-color: var(--border-color);
                color: var(--text-secondary);
            }
            
            /* source-badge and notification-bottom-row styles moved to global stylesheet */

            .notification-icon {
                margin-right: 8px;
                flex-shrink: 0;
            }
            
            /* Mobile responsive */
            @media (max-width: 768px) {
                .notification-container {
                    top: 20px; /* Back to same as desktop */
                    right: 10px;
                    width: calc(100% - 20px);
                    max-width: 350px;
                }
                
                .notification {
                    padding: 16px 12px; /* 10px taller (16px top/bottom vs 12px) */
                    margin-bottom: 8px;
                    /* Mobile uses same animation as desktop */
                }
                
                .notification-title {
                    font-size: 14px;
                }
                
                .notification-message {
                    font-size: 13px;
                }
            }
            
            /* Theme-aware via CSS variables; no media overrides needed */
        `;
        
        document.head.appendChild(style);
    }

    /**
     * Show a notification
     * @param {Object} notification - Notification data
     * @param {Object} options - Display options
     * @returns {string} Notification ID
     */
    show(notification, options = {}) {
        // Normalize type and merge options
        const normalizedType = (notification.notification_type || notification.type || 'info');
        const config = { recordInCenter: true, ...this.defaultOptions, ...options };
        const id = `notification-${this.nextId++}`;

        // Electron dedicated window filtering: only show session-scoped notifications
        // when the dedicated window maps to that same session. Main window shows all.
        try {
            const isElectron = !!(window.desktop && window.desktop.isElectron);
            if (isElectron) {
                const params = new URLSearchParams(window.location.search || '');
                const isDedicated = (params.get('window') === '1') || ((params.get('ui') || '').toLowerCase() === 'window');
                if (isDedicated) {
                    const target = (typeof getContext === 'function'
                        ? (getContext()?.app?.modules?.terminal?.getActiveEffectiveSessionId?.() || getContext()?.app?.modules?.terminal?.currentSessionId)
                        : null) || null;
                    const nSession = notification?.session_id || null;
                    if (!nSession || !target || String(nSession) !== String(target)) {
                        // Still record in center if requested but do not show toast
                        try {
                            if (config.recordInCenter && notificationCenter && typeof notificationCenter.addNotification === 'function') {
                                notificationCenter.addNotification({
                                    title: notification.title || 'Notification',
                                    message: notification.message || '',
                                    notification_type: normalizedType,
                                    timestamp: notification.timestamp || Date.now(),
                                    session_id: nSession || null,
                                    is_active: notification.is_active !== false,
                                    server_id: notification.server_id || null,
                                    read: Boolean(notification.read === true ? true : false)
                                });
                            }
                        } catch (_) {}
                        return id;
                    }
                }
            }
        } catch (_) { /* non-fatal */ }

        // Record in Notification Center if requested
        try {
            if (config.recordInCenter && notificationCenter && typeof notificationCenter.addNotification === 'function') {
                notificationCenter.addNotification({
                    title: notification.title || 'Notification',
                    message: notification.message || '',
                    notification_type: normalizedType,
                    timestamp: notification.timestamp || Date.now(),
                    session_id: notification.session_id || null,
                    is_active: notification.is_active !== false,
                    // Preserve server-provided identifiers/flags for API persistence
                    server_id: notification.server_id || null,
                    read: Boolean(notification.read === true ? true : false)
                });
            }
        } catch (_) {}
        
        // Respect global and per-level notification preferences
        try {
            const prefs = appStore?.getState?.('preferences.notifications') || {};
            const globalShow = prefs.enabled === true;
            const levelShow = prefs.levels?.[normalizedType]?.show;
            const shouldShow = !!(globalShow && (levelShow !== false));

            if (!shouldShow) {
                // Do not render toast when disabled; already recorded in center above
                return id;
            }
        } catch (_) { /* ignore preference errors */ }

        // Create notification element
        const element = this.createElement(id, { ...notification, notification_type: normalizedType });
        
        // Add to container
        this.container.appendChild(element);
        
        // Store reference
        this.notifications.set(id, {
            element,
            notification,
            config,
            timestamp: Date.now()
        });
        
        // Force reflow to ensure the element is rendered in its initial position
        element.offsetHeight;
        
        // Trigger show animation after a small delay
        setTimeout(() => {
            element.classList.add('show');
        }, 10);
        
        // Auto-remove after duration
        if (config.duration > 0) {
            setTimeout(() => {
                this.remove(id);
            }, config.duration);
        }
        
        return id;
    }

    /**
     * Create notification DOM element
     * @param {string} id - Notification ID
     * @param {Object} notification - Notification data
     * @returns {HTMLElement} Notification element
     */
    createElement(id, notification) {
        const element = document.createElement('div');
        element.id = id;
        const type = (notification.notification_type || notification.type || 'info');
        element.className = `notification ${type}`;
        
        // Format timestamp
        const timestamp = notification.timestamp 
            ? new Date(notification.timestamp).toLocaleTimeString()
            : new Date().toLocaleTimeString();
        
        // Create session display - make all sessions with IDs clickable for navigation
        let sessionDisplay = '';
        if (notification.session_id) {
            sessionDisplay = `<span class=\"notification-session\"><a href=\"#\" class=\"notification-session-link\" data-session-id=\"${this.escapeHtml(notification.session_id)}\">${this.escapeHtml(notification.session_id)}</a></span>`;
        } else {
            sessionDisplay = `<span class=\"notification-session broadcast\">Broadcast</span>`;
        }

        // Source label (Server vs Local)
        const isServer = !!notification.server_id;
        const originLabel = `<span class='source-badge ${isServer ? 'server' : 'local'}'>${isServer ? 'Server' : 'Local'}</span>`;
        
        element.innerHTML = `
            <div class=\"notification-header\">\n                <h4 class=\"notification-title\">${this.escapeHtml(notification.title)}</h4>\n                <button class=\"notification-close\">&times;</button>\n            </div>
            <p class="notification-message">${this.escapeHtml(notification.message)}</p>
            <div class="notification-footer">
                ${originLabel}
                <div class="notification-bottom-row">
                    ${sessionDisplay}
                    <span class="notification-timestamp">${timestamp}</span>
                </div>
            </div>
        `;
        
        // Wire dismiss
        const closeBtn = element.querySelector('.notification-close');
        if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.remove(id); });
        // Wire session link
        const link = element.querySelector('.notification-session-link');
        if (link) link.addEventListener('click', (e) => { e.preventDefault(); this.navigateToSession(link.getAttribute('data-session-id')); });
        return element;
    }

    /**
     * Remove a notification
     * @param {string} id - Notification ID
     */
    remove(id) {
        const notificationData = this.notifications.get(id);
        if (!notificationData) {
            return;
        }
        
        const { element } = notificationData;
        
        // Trigger hide animation
        element.classList.remove('show');
        element.classList.add('hide');
        
        // Remove from DOM after animation
        setTimeout(() => {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
            this.notifications.delete(id);
        }, 300);
    }

    /**
     * Clear all notifications
     */
    clear() {
        this.notifications.forEach((_, id) => {
            this.remove(id);
        });
    }

    /**
     * Get all active notifications
     * @returns {Array} Array of notification data
     */
    getActive() {
        return Array.from(this.notifications.values());
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} text - Text to escape
     * @returns {string} Escaped text
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Handle notification received from WebSocket
     * @param {Object} notification - Notification data from server
     */
    handleNotification(notification) {
        try {
            // no-op: Notification Center recording happens inside show()
        } catch (_) {}
        // Show toast notification
        const normalizedType = (notification.notification_type || notification.type || 'info');
        this.show(notification, {
            duration: this.getDurationForType(normalizedType),
            recordInCenter: true
        });
    }

    /**
     * Get display duration based on notification type
     * @param {string} type - Notification type
     * @returns {number} Duration in milliseconds
     */
    getDurationForType(type) {
        switch (type) {
            case 'error':
                return 8000; // Errors stay longer
            case 'warning':
                return 6000;
            case 'success':
                return 4000;
            case 'info':
            default:
                return 5000;
        }
    }

    /**
     * Navigate to a session internally
     * @param {string} sessionId - Session ID to navigate to
     */
    async navigateToSession(sessionId) {
        try {
            // Check if terminal manager is available
            const appRef = getContext()?.app;
            if (!appRef || !appRef.modules || !appRef.modules.terminal) {
                console.error('Terminal manager not available');
                return;
            }

            const terminalManager = appRef.modules.terminal;
            
            // First, check if the session exists and determine which tab it's in
            const apiService = getContext()?.apiService;
            if (apiService) {
                const sessionData = await apiService.getSessionHistory(sessionId);
                if (sessionData) {
                    // Switch to the appropriate tab
                    const targetTab = sessionData.is_active ? 'active' : 'inactive';
                    terminalManager.switchToTab(targetTab);
                    
                    // Small delay to ensure tab switch completes
                    setTimeout(() => {
                        if (typeof terminalManager.activateSession === 'function') {
                            terminalManager.activateSession(sessionId);
                        } else {
                            terminalManager.selectSession(sessionId);
                        }
                    }, 100);
                } else {
                    console.warn(`Session ${sessionId} not found`);
                }
            } else {
                // Fallback: try to select directly
                if (typeof terminalManager.activateSession === 'function') {
                    terminalManager.activateSession(sessionId);
                } else {
                    terminalManager.selectSession(sessionId);
                }
            }
        } catch (error) {
            console.error('Error navigating to session:', error);
        }
    }
}

// Export singleton instance
export const notificationDisplay = new NotificationDisplay();
