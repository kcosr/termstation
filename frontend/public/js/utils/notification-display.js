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

            /* Interactive notification inputs */
            .notification-inputs {
                margin-top: 6px;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .notification-input-row {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .notification-input-row label {
                font-size: 12px;
                color: var(--text-secondary);
            }

            .notification-input-row label .required-indicator {
                color: var(--danger-color);
                margin-left: 2px;
            }

            .notification-input-row input {
                font-size: 13px;
                padding: 4px 6px;
                border-radius: 4px;
                border: 1px solid var(--border-color);
                background: var(--bg-primary);
                color: var(--text-primary);
            }

            .notification-input-row input:focus {
                outline: none;
                border-color: var(--accent-color);
                box-shadow: 0 0 0 1px var(--accent-color);
            }

            .notification-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 6px;
            }

            .notification-action-button {
                font-size: 12px;
            }

            .notification-action-button[disabled] {
                opacity: 0.6;
                cursor: default;
            }

            .notification-action-status,
            .notification-action-error {
                font-size: 12px;
                margin-top: 4px;
            }

            .notification-action-status {
                color: var(--text-secondary);
            }

            .notification-action-error {
                color: var(--danger-color);
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
        const normalizedNotification = { ...notification, notification_type: normalizedType };
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
                                    read: Boolean(notification.read === true ? true : false),
                                    actions: Array.isArray(notification.actions) ? notification.actions : undefined,
                                    inputs: Array.isArray(notification.inputs) ? notification.inputs : undefined,
                                    response: notification.response || undefined
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
                    title: normalizedNotification.title || 'Notification',
                    message: normalizedNotification.message || '',
                    notification_type: normalizedType,
                    timestamp: normalizedNotification.timestamp || Date.now(),
                    session_id: normalizedNotification.session_id || null,
                    is_active: normalizedNotification.is_active !== false,
                    // Preserve server-provided identifiers/flags for API persistence
                    server_id: normalizedNotification.server_id || null,
                    read: Boolean(normalizedNotification.read === true ? true : false),
                    // Interactive metadata (optional)
                    actions: Array.isArray(normalizedNotification.actions) ? normalizedNotification.actions : undefined,
                    inputs: Array.isArray(normalizedNotification.inputs) ? normalizedNotification.inputs : undefined,
                    response: normalizedNotification.response || undefined
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
        const element = this.createElement(id, normalizedNotification);
        
        // Add to container
        this.container.appendChild(element);
        
        // Store reference
        this.notifications.set(id, {
            element,
            notification: normalizedNotification,
            config,
            timestamp: Date.now(),
            interactive: null
        });

        // Wire interactive behaviors if applicable
        this.setupInteractiveNotification(id);
        
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

        const title = notification.title || 'Notification';
        const message = notification.message || '';
        
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

        const interactiveHtml = this.buildInteractiveHtml(notification, id);
        
        element.innerHTML = `
            <div class=\"notification-header\">\n                <h4 class=\"notification-title\">${this.escapeHtml(title)}</h4>\n                <button class=\"notification-close\">&times;</button>\n            </div>
            <p class="notification-message">${this.escapeHtml(message)}</p>
            <div class="notification-footer">
                ${originLabel}
                ${interactiveHtml}
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
            duration: this.getDurationForNotification(notification, normalizedType),
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
     * Determine duration for a notification, honoring interactive persistence preference.
     * @param {Object} notification
     * @param {string} type
     * @returns {number}
     */
    getDurationForNotification(notification, type) {
        try {
            if (this.shouldPersistInteractive(notification)) {
                return 0;
            }
        } catch (_) {}
        return this.getDurationForType(type);
    }

    /**
     * Check if a notification is interactive.
     * @param {Object} notification
     * @returns {boolean}
     */
    isInteractiveNotification(notification) {
        try {
            if (!notification) return false;
            const hasActions = Array.isArray(notification.actions) && notification.actions.length > 0;
            const hasInputs = Array.isArray(notification.inputs) && notification.inputs.length > 0;
            return hasActions || hasInputs;
        } catch (_) {
            return false;
        }
    }

    /**
     * Determine if interactive notifications should persist on screen.
     * @param {Object} notification
     * @returns {boolean}
     */
    shouldPersistInteractive(notification) {
        if (!this.isInteractiveNotification(notification)) return false;
        try {
            const prefs = appStore?.getState?.('preferences.notifications') || {};
            return prefs.persistInteractive === true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Build HTML for interactive inputs and actions.
     * @param {Object} notification
     * @param {string} id
     * @returns {string}
     */
    buildInteractiveHtml(notification, id) {
        if (!this.isInteractiveNotification(notification)) return '';

        const inputs = Array.isArray(notification.inputs) ? notification.inputs : [];
        const actions = Array.isArray(notification.actions) ? notification.actions : [];

        const inputRows = inputs.map((inputDef) => {
            if (!inputDef || !inputDef.id) return '';
            const inputId = `${id}-input-${inputDef.id}`;
            const labelText = inputDef.label || inputDef.id;
            const type = (inputDef.type === 'password') ? 'password' : 'text';
            const placeholder = inputDef.placeholder ? this.escapeHtml(String(inputDef.placeholder)) : '';
            const required = inputDef.required === true;
            const requiredIndicator = required ? '<span class="required-indicator">*</span>' : '';
            return `
                <div class="notification-input-row">
                    <label for="${this.escapeHtml(inputId)}">
                        ${this.escapeHtml(labelText)}${requiredIndicator}
                    </label>
                    <input
                        id="${this.escapeHtml(inputId)}"
                        class="notification-input"
                        type="${type}"
                        data-input-id="${this.escapeHtml(inputDef.id)}"
                        ${placeholder ? `placeholder="${placeholder}"` : ''}
                    >
                </div>
            `;
        }).filter(Boolean);

        const inputsHtml = inputRows.length
            ? `<div class="notification-inputs">${inputRows.join('')}</div>`
            : '';

        const actionButtons = actions.map((action) => {
            if (!action || !action.key) return '';
            const key = String(action.key);
            const label = action.label || key;
            // Map style -> button variant using existing button classes
            let styleClass = 'btn-secondary';
            const style = (action.style || '').toLowerCase();
            if (style === 'primary') styleClass = 'btn-primary';
            else if (style === 'danger') styleClass = 'btn-danger';
            return `
                <button
                    type="button"
                    class="notification-action-button btn btn-xs ${styleClass}"
                    data-action-key="${this.escapeHtml(key)}"
                    disabled
                >
                    ${this.escapeHtml(label)}
                </button>
            `;
        }).filter(Boolean);

        const actionsHtml = actionButtons.length
            ? `<div class="notification-actions">${actionButtons.join('')}</div>`
            : '';

        // Status and error lines for action feedback
        const statusHtml = `<div class="notification-action-status" aria-live="polite"></div>`;
        const errorHtml = `<div class="notification-action-error" aria-live="polite"></div>`;

        return `${inputsHtml}${actionsHtml}${statusHtml}${errorHtml}`;
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

    /**
     * Initialize interactive behaviors (inputs + actions) for a given notification element.
     * @param {string} id - Notification ID
     */
    setupInteractiveNotification(id) {
        const entry = this.notifications.get(id);
        if (!entry || !this.isInteractiveNotification(entry.notification)) {
            return;
        }

        const notification = entry.notification || {};
        const element = entry.element;

        const inputs = Array.isArray(notification.inputs) ? notification.inputs : [];
        const actions = Array.isArray(notification.actions) ? notification.actions : [];

        const inputElements = {};
        inputs.forEach((inputDef) => {
            if (!inputDef || !inputDef.id) return;
            const escapedId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(inputDef.id) : inputDef.id;
            const el = element.querySelector(`.notification-input[data-input-id="${escapedId}"]`)
                || element.querySelector(`.notification-input[data-input-id="${inputDef.id}"]`);
            if (el) {
                inputElements[inputDef.id] = el;
                el.addEventListener('input', () => {
                    this.updateActionButtonsState(id);
                });
            }
        });

        const actionButtons = {};
        actions.forEach((action) => {
            if (!action || !action.key) return;
            const escapedKey = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(action.key) : action.key;
            const btn = element.querySelector(`.notification-action-button[data-action-key="${escapedKey}"]`)
                || element.querySelector(`.notification-action-button[data-action-key="${action.key}"]`);
            if (btn) {
                actionButtons[action.key] = btn;
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.handleActionClick(id, action.key);
                });
            }
        });

        const statusEl = element.querySelector('.notification-action-status') || null;
        const errorEl = element.querySelector('.notification-action-error') || null;

        entry.interactive = {
            inputs,
            actions,
            inputElements,
            actionButtons,
            statusEl,
            errorEl,
            pendingActionKey: null,
            resolved: !!notification.response,
            lastSubmittedInputs: null
        };

        this.updateActionButtonsState(id);
    }

    /**
     * Enable/disable action buttons based on required inputs and pending/resolved state.
     * @param {string} id
     */
    updateActionButtonsState(id) {
        const entry = this.notifications.get(id);
        if (!entry || !entry.interactive) return;

        const { actions, inputElements, actionButtons, pendingActionKey, resolved } = entry.interactive;

        const values = {};
        Object.keys(inputElements || {}).forEach((inputId) => {
            const el = inputElements[inputId];
            if (el) {
                values[inputId] = (el.value || '').trim();
            }
        });

        actions.forEach((action) => {
            const btn = actionButtons[action.key];
            if (!btn) return;

            let disabled = false;

            // Once a notification is resolved, all actions remain disabled
            if (resolved) {
                disabled = true;
            }

            // While a submission is in-flight, all buttons are disabled
            if (!disabled && pendingActionKey) {
                disabled = true;
            }

            // Require inputs defined for this action
            if (!disabled && Array.isArray(action.requires_inputs) && action.requires_inputs.length) {
                const missing = action.requires_inputs.some((inputId) => {
                    const v = (values[inputId] || '').trim();
                    return !v;
                });
                if (missing) disabled = true;
            }

            btn.disabled = !!disabled;
        });
    }

    /**
     * Handle an action button click: validate, send WS message, and mark pending state.
     * @param {string} id
     * @param {string} actionKey
     */
    handleActionClick(id, actionKey) {
        const entry = this.notifications.get(id);
        if (!entry || !entry.interactive) return;

        const ctx = getContext();
        const ws = ctx?.websocketService;
        if (!ws || typeof ws.send !== 'function') {
            if (entry.interactive.errorEl) {
                entry.interactive.errorEl.textContent = 'Not connected to server.';
            }
            return;
        }

        const { actions, inputElements, actionButtons, statusEl, errorEl } = entry.interactive;
        const action = actions.find((a) => a && a.key === actionKey);
        if (!action) return;

        const values = {};
        Object.keys(inputElements || {}).forEach((inputId) => {
            const el = inputElements[inputId];
            if (el) values[inputId] = el.value || '';
        });

        // Client-side validation for required inputs
        const missingIds = [];
        if (Array.isArray(action.requires_inputs)) {
            action.requires_inputs.forEach((inputId) => {
                const v = (values[inputId] || '').trim();
                if (!v) missingIds.push(inputId);
            });
        }

        if (missingIds.length > 0) {
            if (errorEl) {
                const labels = missingIds.map((idPart) => this.getInputLabel(entry.notification, idPart));
                errorEl.textContent = `Please fill: ${labels.join(', ')}`;
            }
            return;
        }

        // Clear previous messages and mark pending
        if (errorEl) {
            errorEl.textContent = '';
        }
        if (statusEl) {
            statusEl.textContent = 'Sending...';
        }

        entry.interactive.pendingActionKey = action.key;
        entry.interactive.lastSubmittedInputs = values;
        this.updateActionButtonsState(id);

        const btn = actionButtons[action.key] || null;

        const notification = entry.notification || {};
        const notificationId = notification.server_id || notification.notification_id || notification.id || null;
        if (!notificationId) {
            if (errorEl) {
                errorEl.textContent = 'Notification cannot be submitted (missing id).';
            }
            entry.interactive.pendingActionKey = null;
            this.updateActionButtonsState(id);
            if (statusEl) statusEl.textContent = '';
            return;
        }

        try {
            ws.send('notification_action', {
                notification_id: notificationId,
                action_key: action.key,
                inputs: values
            });
        } catch (e) {
            console.error('[NotificationDisplay] Failed to send notification_action:', e);
            if (errorEl) {
                errorEl.textContent = 'Failed to send response. Please try again.';
            }
            if (statusEl) statusEl.textContent = '';
            entry.interactive.pendingActionKey = null;
            this.updateActionButtonsState(id);
            if (btn) btn.disabled = false;
        }
    }

    /**
     * Handle a notification_action_result message from WebSocket.
     * @param {Object} result
     */
    handleActionResult(result) {
        if (!result || !result.notification_id) return;
        const targetId = String(result.notification_id);

        for (const [id, entry] of this.notifications.entries()) {
            const notification = entry.notification || {};
            const serverId = notification.server_id || notification.notification_id || notification.id || null;
            if (!serverId || String(serverId) !== targetId) continue;
            this.applyActionResultToEntry(id, entry, result);
        }
    }

    /**
     * Apply a notification_action_result to a specific notification entry.
     * @param {string} id
     * @param {Object} entry
     * @param {Object} result
     */
    applyActionResultToEntry(id, entry, result) {
        if (!entry || !entry.interactive) return;

        const { actions, statusEl, errorEl } = entry.interactive;
        entry.interactive.pendingActionKey = null;

        if (errorEl) errorEl.textContent = '';

        const action = actions.find((a) => a && a.key === result.action_key);
        const actionLabel = action?.label || result.action_key || '';

        if (result.ok) {
            entry.interactive.resolved = true;

            if (statusEl) {
                const statusText = result.status ? String(result.status) : 'completed';
                statusEl.textContent = actionLabel
                    ? `Action "${actionLabel}" ${statusText}.`
                    : `Action ${statusText}.`;
            }

            // Disable all buttons after a successful response
            this.updateActionButtonsState(id);

            // Build a local response summary for the notification center (non-secret only)
            try {
                const inputsDef = Array.isArray(entry.interactive.inputs) ? entry.interactive.inputs : [];
                const submitted = entry.interactive.lastSubmittedInputs || {};
                const nonSecretInputs = {};
                const maskedIds = [];

                inputsDef.forEach((def) => {
                    if (!def || !def.id) return;
                    if (!(def.id in submitted)) return;
                    const v = submitted[def.id];
                    const t = (def.type === 'password') ? 'password' : 'string';
                    if (t === 'password') {
                        maskedIds.push(def.id);
                    } else {
                        nonSecretInputs[def.id] = v;
                    }
                });

                const nowIso = new Date().toISOString();
                let username = '';
                try { username = appStore.getState('auth.username') || ''; } catch (_) {}

                const response = {
                    at: nowIso,
                    user: username || undefined,
                    action_key: result.action_key,
                    action_label: actionLabel || null,
                    inputs: nonSecretInputs,
                    masked_input_ids: maskedIds
                };

                entry.notification.response = response;
                try {
                    if (notificationCenter && typeof notificationCenter.updateNotificationResponseByServerId === 'function') {
                        const serverId = entry.notification.server_id || entry.notification.notification_id || entry.notification.id || null;
                        if (serverId) {
                            notificationCenter.updateNotificationResponseByServerId(serverId, response);
                        }
                    }
                } catch (_) {}
            } catch (e) {
                console.warn('[NotificationDisplay] Failed to synthesize response summary:', e);
            }

            // Auto-dismiss after a short delay when interactive persistence is disabled
            try {
                if (!this.shouldPersistInteractive(entry.notification)) {
                    setTimeout(() => {
                        if (this.notifications.has(id)) {
                            this.remove(id);
                        }
                    }, 2000);
                }
            } catch (_) {}
        } else {
            // Failure path
            entry.interactive.resolved = false;
            if (statusEl) statusEl.textContent = '';
            if (errorEl) {
                const msg = result.error || result.status || 'Action failed. Please try again.';
                errorEl.textContent = String(msg);
            }
            this.updateActionButtonsState(id);
        }
    }

    /**
     * Resolve a human-friendly label for an input id.
     * @param {Object} notification
     * @param {string} inputId
     * @returns {string}
     */
    getInputLabel(notification, inputId) {
        try {
            const inputs = Array.isArray(notification.inputs) ? notification.inputs : [];
            const match = inputs.find((it) => it && it.id === inputId);
            if (match && match.label) return String(match.label);
            return String(inputId);
        } catch (_) {
            return String(inputId);
        }
    }
}

// Export singleton instance
export const notificationDisplay = new NotificationDisplay();
