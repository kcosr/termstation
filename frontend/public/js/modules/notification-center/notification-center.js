/**
 * Notification Center - Historical notification management
 * Provides a persistent notification history with badge counts and management features
 */
import { iconUtils } from '../../utils/icon-utils.js';
import { getContext } from '../../core/context.js';
import { delegate } from '../../utils/delegate.js';

export class NotificationCenter {
    constructor() {
        this.notifications = [];
        this.unreadCount = 0;
        this.isOpen = false;
        this.container = null;
        this.button = null;
        this.badge = null;
        this.liveRegion = null;
        this._announceQueue = [];
        this._announceTimer = null;
        // Lazy rendering + pagination state
        this.pageSize = 50;
        this.renderedCount = 0; // how many items are currently rendered
        
        this.initializeUI();
        this.bindEvents();
    }

    /**
     * Initialize the notification center UI components
     */
    initializeUI() {
        this.createButton();
        this.createPanel();
        this.injectStyles();
    }

    /**
     * Create the notification center button with badge
     */
    createButton() {
        const userMenuContainer = document.getElementById('user-menu-container');
        const settingsBtn = document.getElementById('settings-btn');

        // Determine insertion point (keep near the user menu on the right)
        const parent = (userMenuContainer && userMenuContainer.parentNode)
            ? userMenuContainer.parentNode
            : (settingsBtn && settingsBtn.parentNode)
                ? settingsBtn.parentNode
                : (document.querySelector('.app-nav') || document.body);
        const reference = userMenuContainer || settingsBtn || null;

        // Create notification center button (bell)
        this.button = document.createElement('button');
        this.button.id = 'notification-center-btn';
        this.button.className = 'btn-icon header-notification-btn';
        this.button.title = 'Show notifications';
        try { this.button.setAttribute('aria-label', 'Show notifications'); } catch (_) {}
        
        // Add bell icon
        const bellIcon = iconUtils.createIcon('bell', { size: 16 });
        this.button.appendChild(bellIcon);

        // Create badge
        this.badge = document.createElement('span');
        this.badge.className = 'notification-badge';
        this.badge.style.display = 'none';
        this.button.appendChild(this.badge);

        // Insert bell button
        if (reference) {
            parent.insertBefore(this.button, reference);
        } else {
            parent.appendChild(this.button);
        }

        // Create reload button to the left of the bell
        try {
            // Reload button (existing)
            this.reloadButton = document.createElement('button');
            this.reloadButton.id = 'app-reload-btn';
            this.reloadButton.className = 'btn-icon header-reload-btn';
            this.reloadButton.title = 'Reload';

            const reloadIcon = iconUtils.createIcon('arrow-clockwise', { size: 16 });
            this.reloadButton.appendChild(reloadIcon);

            // Click handler: desktop (Electron) or web
            this.reloadButton.addEventListener('click', () => {
                try {
                    const isDesktop = !!(window.desktop && window.desktop.isElectron);
                    const canReloadDesktop = isDesktop && typeof window.desktop.reloadWindow === 'function';
                    if (canReloadDesktop) {
                        window.desktop.reloadWindow();
                    } else {
                        window.location.reload();
                    }
                } catch (e) {
                    try {
                        console.warn('[HeaderReload] reload handler failed, falling back to window.location.reload()', e?.message || e);
                    } catch (_) { /* ignore */ }
                    try { window.location.reload(); } catch (_) {}
                }
            });

            // Insert reload before the bell
            parent.insertBefore(this.reloadButton, this.button);

            // Clear-ended button (new) — insert to the left of reload
            try {
                this.clearEndedButton = document.createElement('button');
                this.clearEndedButton.id = 'clear-ended-btn';
                this.clearEndedButton.className = 'btn-icon header-reload-btn';
                this.clearEndedButton.title = 'Clear ended sessions';
                try { this.clearEndedButton.setAttribute('aria-label', 'Clear ended sessions'); } catch (_) {}

                const clearIcon = iconUtils.createIcon('stars', { size: 16 });
                this.clearEndedButton.appendChild(clearIcon);

                this.clearEndedButton.addEventListener('click', () => {
                    try {
                        const tm = getContext()?.app?.modules?.terminal;
                        if (tm && typeof tm.removeAllEndedSessionsFromUI === 'function') {
                            tm.removeAllEndedSessionsFromUI();
                        }
                    } catch (_) { /* ignore */ }
                });

                // Place directly to the left of reload
                parent.insertBefore(this.clearEndedButton, this.reloadButton);
            } catch (_) { /* non-fatal */ }
        } catch (_) { /* non-fatal */ }
    }

    /**
     * Create the notification center panel
     */
    createPanel() {
        this.container = document.createElement('div');
        this.container.id = 'notification-center-panel';
        this.container.className = 'notification-center-panel';
        
        this.container.innerHTML = `
            <div class="notification-center-header">
                <h3>Notifications</h3>
                <div class="notification-center-actions">
                    <button class="clear-all-btn" title="Clear All">Clear</button>
                    <button class="close-panel-btn" title="Close">×</button>
                </div>
            </div>
            <div class="notification-center-body">
                <div id="notification-live-region" class="sr-only" aria-live="polite" aria-atomic="true"></div>
                <div class="notification-list" id="notification-list">
                    <div class="empty-state">
                        <p>No notifications yet</p>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.container);

        // Initialize live region reference
        this.liveRegion = this.container.querySelector('#notification-live-region');
    }

    /**
     * Inject CSS styles for the notification center
     */
    injectStyles() {
        const style = document.createElement('style');
        style.id = 'notification-center-styles';
        style.textContent = `
            .sr-only {
                position: absolute !important;
                width: 1px !important;
                height: 1px !important;
                padding: 0 !important;
                margin: -1px !important;
                overflow: hidden !important;
                clip: rect(0, 0, 1px, 1px) !important;
                white-space: nowrap !important;
                border: 0 !important;
            }
            .header-notification-btn {
                position: relative;
                background: none;
                border: none;
                font-size: 18px;
                cursor: pointer;
                padding: 8px;
                margin-right: 8px;
                border-radius: 4px;
                transition: background-color 0.2s ease;
            }

            .header-notification-btn:hover {
                background-color: rgba(0, 0, 0, 0.1);
            }

            .notification-badge {
                position: absolute;
                top: 2px;
                right: 2px;
                background: var(--danger-color);
                color: #fff;
                border-radius: 50%;
                font-size: 11px;
                font-weight: bold;
                min-width: 16px;
                height: 16px;
                display: flex;
                align-items: center;
                justify-content: center;
                line-height: 1;
                padding: 2px 4px;
            }

            .notification-badge.error {
                background: var(--danger-color);
                color: #fff;
            }

            .notification-badge.warning {
                background: var(--warning-color);
                color: #000;
            }

            .notification-badge.info {
                background: var(--accent-color);
                color: #fff;
            }

            .notification-badge.success {
                background: var(--success-color);
                color: #fff;
            }

            .notification-center-panel {
                position: fixed;
                top: 60px;
                right: -400px;
                width: 380px;
                height: calc(100vh - 80px);
                background: var(--bg-primary);
                border: 1px solid var(--border-color);
                border-radius: 8px 0 0 8px;
                box-shadow: -4px 0 12px rgba(0, 0, 0, 0.15);
                z-index: 9999;
                transition: right 0.3s ease;
                display: flex;
                flex-direction: column;
            }

            .notification-center-panel.open {
                right: 0;
            }

            .notification-center-header {
                padding: 16px 20px;
                border-bottom: 1px solid var(--border-color);
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: var(--bg-secondary);
                border-radius: 8px 0 0 0;
            }

            .notification-center-header h3 {
                margin: 0;
                font-size: 16px;
                color: var(--text-primary);
            }

            .notification-center-actions {
                display: flex;
                gap: 8px;
            }

            .clear-all-btn {
                background: var(--danger-color);
                color: #fff;
                border: none;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 12px;
                cursor: pointer;
                transition: background-color 0.2s ease;
            }

            .clear-all-btn:hover {
                filter: brightness(0.9);
            }

            .close-panel-btn {
                background: none;
                border: none;
                font-size: 18px;
                color: #666;
                cursor: pointer;
                padding: 2px 6px;
                border-radius: 4px;
                transition: background-color 0.2s ease;
            }

            .close-panel-btn:hover {
                background: rgba(0, 0, 0, 0.1);
            }

            .notification-center-body {
                flex: 1;
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }

            .notification-list {
                flex: 1;
                overflow-y: auto;
                padding: 8px;
            }

            .empty-state {
                text-align: center;
                color: var(--text-secondary);
                margin-top: 40px;
            }

            .notification-item {
                background: var(--bg-secondary);
                border: 1px solid var(--border-color);
                border-radius: 6px;
                margin-bottom: 8px;
                padding: 12px;
                position: relative;
                transition: all 0.2s ease;
                border-left: 4px solid var(--accent-color);
            }

            .notification-item:hover {
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            }

            .notification-item.unread {
                background: var(--bg-hover);
                border-color: var(--accent-color);
            }

            .notification-item.unread::before {
                content: '';
                position: absolute;
                top: 12px;
                right: 12px;
                width: 8px;
                height: 8px;
                background: var(--accent-color);
                border-radius: 50%;
            }

            .notification-item.info {
                border-left-color: var(--accent-color);
            }

            .notification-item.success {
                border-left-color: var(--success-color);
            }

            .notification-item.warning {
                border-left-color: var(--warning-color);
            }

            .notification-item.error {
                border-left-color: var(--danger-color);
            }

            .notification-item.error.unread::before {
                background: var(--danger-color);
            }

            .notification-item.warning.unread::before {
                background: var(--warning-color);
            }

            .notification-item.success.unread::before {
                background: var(--success-color);
            }

            .notification-item-header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 6px;
            }

            .notification-item-title {
                font-weight: 600;
                color: var(--text-primary);
                margin: 0;
                font-size: 14px;
                line-height: 1.3;
                flex: 1;
                margin-right: 8px;
            }

            .notification-item-dismiss {
                background: none;
                border: none;
                color: var(--text-secondary);
                cursor: pointer;
                font-size: 14px;
                padding: 2px 4px;
                border-radius: 2px;
                transition: background-color 0.2s ease;
                flex-shrink: 0;
            }

            .notification-item-dismiss:hover {
                background: rgba(0, 0, 0, 0.1);
            }

            .notification-item-message {
                color: var(--text-secondary);
                font-size: 13px;
                line-height: 1.4;
                margin: 0 0 8px 0;
            }

            .notification-item-timestamp {
                font-size: 11px;
                color: var(--text-dim);
                text-align: right;
            }

            .notification-item-footer {
                display: flex;
                flex-direction: column;
                gap: 6px;
                align-items: stretch;
                margin-top: 8px;
            }

            .notification-item-session {
                font-size: 12px;
                color: var(--text-secondary);
                font-style: italic;
            }

            .notification-item-session.broadcast {
                color: var(--text-secondary);
                font-weight: 500;
            }

            .notification-item-session a {
                color: var(--accent-color);
                text-decoration: none;
                cursor: pointer;
            }

            .notification-item-session a:hover {
                text-decoration: underline;
            }

            /* source-badge styles moved to global stylesheet */

            .notification-item-interactive {
                font-size: 11px;
                color: var(--text-secondary);
            }

            .notification-response-summary {
                margin-top: 4px;
                padding: 4px 6px;
                border-radius: 4px;
                background: var(--bg-primary);
            }

            .notification-response-header {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
                align-items: baseline;
                margin-bottom: 2px;
            }

            .notification-response-badge {
                font-size: 10px;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                padding: 2px 6px;
                border-radius: 999px;
                border: 1px solid var(--border-color);
                color: var(--text-secondary);
            }

            .notification-response-action {
                font-size: 12px;
                font-weight: 500;
                color: var(--text-secondary);
            }

            .notification-response-at {
                font-size: 11px;
                color: var(--text-dim);
            }

            .notification-response-inputs {
                margin-top: 2px;
            }

            .notification-response-input {
                font-size: 12px;
                color: var(--text-secondary);
            }

            .notification-response-input-label {
                font-weight: 500;
                margin-right: 4px;
            }

            /* Mobile responsiveness */
            @media (max-width: 768px) {
                .notification-center-panel {
                    right: -100vw;
                    width: 100vw;
                    top: 50px;
                    height: calc(100vh - 50px);
                    border-radius: 0;
                }

                .notification-center-panel.open {
                    right: 0;
                }
            }

            /* Theme-aware colors via CSS variables; no media overrides needed */

            /* Load more pagination */
            .load-more-container {
                display: flex;
                justify-content: center;
                padding: 8px 0 12px 0;
            }
            .load-more-btn {
                background: var(--bg-secondary);
                border: 1px solid var(--border-color);
                color: var(--text-primary);
                border-radius: 4px;
                font-size: 12px;
                padding: 6px 10px;
                cursor: pointer;
            }
            .load-more-btn:hover {
                background: var(--bg-hover);
            }
        `;

        document.head.appendChild(style);
    }

    /**
     * Bind event listeners
     */
    bindEvents() {
        // Button click to toggle panel
        if (this.button) {
            this.button.addEventListener('click', () => this.toggle());
        }

        // Panel controls
        const closeBtn = this.container.querySelector('.close-panel-btn');
        const clearAllBtn = this.container.querySelector('.clear-all-btn');

        closeBtn.addEventListener('click', () => this.close());
        clearAllBtn.addEventListener('click', () => this.clearAll());

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (this.isOpen && 
                !this.container.contains(e.target) && 
                !this.button.contains(e.target)) {
                this.close();
            }
        });

        // Close on escape key (suppressed while a modal is open)
        document.addEventListener('keydown', (e) => {
            if (isAnyModalOpen()) return;
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });

        // Delegated events inside the panel
        const list = this.container.querySelector('#notification-list');
        if (list) {
            // Mark unread item as read when clicking anywhere except dismiss or session link
            delegate(list, '.notification-item.unread', 'click', (e, item) => {
                if (e.target.closest('.notification-item-dismiss')) return;
                if (e.target.closest('.notification-session-link')) return;
                const id = item.getAttribute('data-id');
                if (id) this.markAsRead(id);
            });
            // Dismiss button
            delegate(list, '.notification-item-dismiss', 'click', (e, btn) => {
                e.stopPropagation();
                const id = btn.closest('.notification-item')?.getAttribute('data-id');
                if (id) this.removeNotification(id);
            });
            // Session link navigation
            delegate(list, '.notification-session-link', 'click', (e, link) => {
                e.preventDefault();
                e.stopPropagation();
                const sid = link.getAttribute('data-session-id');
                if (sid) {
                    this.navigateToSession(sid);
                    this.close();
                }
            });

            // Load more pagination
            delegate(list, '.load-more-btn', 'click', (e) => {
                e.preventDefault();
                this.renderNextPage();
            });

            // Interactive inputs: update button state on change
            delegate(list, '.notification-item .notification-input', 'input', (e, inputEl) => {
                const item = inputEl.closest('.notification-item');
                if (!item) return;
                const id = item.getAttribute('data-id');
                if (!id) return;
                this.updateInteractiveButtonsState(id);
            });

            // Interactive action buttons: send notification_action over WebSocket
            delegate(list, '.notification-item .notification-action-button', 'click', (e, btn) => {
                e.preventDefault();
                e.stopPropagation();
                const item = btn.closest('.notification-item');
                if (!item) return;
                const id = item.getAttribute('data-id');
                if (!id) return;
                const actionKey = btn.getAttribute('data-action-key');
                if (!actionKey) return;
                this.handleInteractiveActionClick(id, actionKey);
            });
        }
    }

    /**
     * Add a notification to the center
     * 
     * IMPORTANT: For notifications that should appear as visible toast alerts on screen,
     * use notificationDisplay.show() instead. This method only adds to the notification
     * center history without showing a toast notification to the user.
     * 
     * notificationDisplay.show() will automatically call this method to record the
     * notification in the center while also displaying the toast alert.
     * 
     * @param {Object} notification - Notification data
     */
    addNotification(notification) {
        const serverId = notification.server_id || null;
        const actions = Array.isArray(notification.actions) ? notification.actions : undefined;
        const inputs = Array.isArray(notification.inputs) ? notification.inputs : undefined;
        const response = notification.response || null;
        const interactive = !!(
            (Array.isArray(actions) && actions.length > 0) ||
            (Array.isArray(inputs) && inputs.length > 0)
        );

        const notificationData = {
            id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            title: notification.title || 'Notification',
            message: notification.message || '',
            type: notification.notification_type || 'info',
            timestamp: notification.timestamp || Date.now(),
            sessionId: notification.session_id || null,
            isActive: notification.is_active !== false, // Default to true if not specified
            read: Boolean(notification.read === true ? true : false),
            serverId,
            origin: serverId ? 'server' : 'local',
            actions,
            inputs,
            response,
            interactive,
            _interactiveState: {
                pendingActionKey: null,
                resolved: !!response,
                lastSubmittedInputs: null
            }
        };

        // Add to beginning of array (newest first)
        this.notifications.unshift(notificationData);

        // Increment unread count only when unread
        if (!notificationData.read) {
            this.unreadCount++;
        }

        // Update UI (lazy: render only if panel is open)
        this.updateBadge();
        this.renderNotificationsIfOpen();

        // Announce for screen readers
        this.queueAnnouncement(notificationData);

        return notificationData.id;
    }

    /**
     * Queue announcements and debounce flush to avoid spamming SRs
     * @param {Object} n - normalized notification data
     */
    queueAnnouncement(n) {
        try {
            const type = (n.type || 'info');
            const title = (n.title || 'Notification');
            const message = (n.message || '');
            this._announceQueue.push({ type, title, message });

            if (this._announceTimer) return;
            this._announceTimer = setTimeout(() => {
                this.flushAnnouncements();
            }, 700);
        } catch (_) {}
    }

    /**
     * Flush queued announcements into a summarized aria-live update
     */
    flushAnnouncements() {
        const items = this._announceQueue.splice(0, this._announceQueue.length);
        this._announceTimer = null;
        if (!items.length || !this.liveRegion) return;

        let text = '';
        if (items.length === 1) {
            const { type, title, message } = items[0];
            text = `New ${type} notification: ${title}${message ? ' — ' + message : ''}`;
        } else {
            const counts = items.reduce((acc, it) => { acc[it.type] = (acc[it.type] || 0) + 1; return acc; }, {});
            const parts = Object.entries(counts)
                .sort((a,b) => (b[1]-a[1]))
                .map(([t,c]) => `${c} ${t}`);
            text = `${items.length} new notifications${parts.length ? ': ' + parts.join(', ') : ''}`;
        }
        this.announce(text);
    }

    /**
     * Write into aria-live region without stealing focus
     * @param {string} text
     */
    announce(text) {
        if (!this.liveRegion) return;
        // Clear then set to ensure SR announcement
        this.liveRegion.textContent = '';
        setTimeout(() => { this.liveRegion.textContent = text; }, 10);
    }

    /**
     * Mark a notification as read
     * @param {string} id - Notification ID
     */
    async markAsRead(id) {
        const notification = this.notifications.find(n => n.id === id);
        if (notification && !notification.read) {
            notification.read = true;
            this.unreadCount--;
            this.updateBadge();
            this.renderNotificationsIfOpen();
            // Persist server-side if applicable
            try {
                if (notification.serverId) {
                    const api = getContext()?.apiService;
                    await api?.markNotificationRead?.(notification.serverId);
                }
            } catch (_) {}
        }
    }

    /**
     * Remove a notification
     * @param {string} id - Notification ID
     */
    async removeNotification(id) {
        const index = this.notifications.findIndex(n => n.id === id);
        if (index !== -1) {
            const notification = this.notifications[index];
            if (!notification.read) {
                this.unreadCount--;
            }
            this.notifications.splice(index, 1);
            this.updateBadge();
            this.renderNotificationsIfOpen();
            // Persist server-side if applicable
            try {
                if (notification.serverId) {
                    const api = getContext()?.apiService;
                    await api?.deleteNotification?.(notification.serverId);
                }
            } catch (_) {}
            
            // Close the notification center if this was the last notification
            if (this.notifications.length === 0 && this.isOpen) {
                this.close();
            }
        }
    }

    /**
     * Clear all notifications
     */
    async clearAll() {
        try {
            const api = getContext()?.apiService;
            await api?.deleteAllNotifications?.();
        } catch (_) {}

        this.notifications = [];
        this.unreadCount = 0;
        this.renderedCount = 0;
        this.updateBadge();
        this.renderNotificationsIfOpen();
    }

    /**
     * Mark all notifications as read
     */
    async markAllAsRead(persist = false) {
        this.notifications.forEach(n => n.read = true);
        this.unreadCount = 0;
        this.updateBadge();
        this.renderNotificationsIfOpen();

        if (persist) {
            try {
                const api = getContext()?.apiService;
                await api?.markAllNotificationsRead?.();
            } catch (_) {}
        }
    }

    /**
     * Update the badge display
     */
    updateBadge() {
        if (!this.badge) return;

        if (this.unreadCount > 0) {
            this.badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
            this.badge.style.display = 'flex';

            // Set badge color based on highest priority unread notification
            const unreadNotifications = this.notifications.filter(n => !n.read);
            const hasError = unreadNotifications.some(n => n.type === 'error');
            const hasWarning = unreadNotifications.some(n => n.type === 'warning');
            const hasSuccess = unreadNotifications.some(n => n.type === 'success');

            this.badge.className = 'notification-badge';
            if (hasError) {
                this.badge.classList.add('error');
            } else if (hasWarning) {
                this.badge.classList.add('warning');
            } else if (hasSuccess) {
                this.badge.classList.add('success');
            } else {
                this.badge.classList.add('info');
            }
        } else {
            this.badge.style.display = 'none';
        }
    }

    /**
     * Render the notification list
     */
    renderNotifications({ reset = false } = {}) {
        const listContainer = this.container.querySelector('#notification-list');
        if (!listContainer) return;

        const total = this.notifications.length;
        if (total === 0) {
            this.renderedCount = 0;
            listContainer.innerHTML = `
                <div class="empty-state">
                    <p>No notifications yet</p>
                </div>
            `;
            return;
        }

        // Determine how many to render
        let count = this.renderedCount;
        if (reset || !count) {
            count = Math.min(this.pageSize, total);
        } else {
            count = Math.min(count, total);
        }

        const slice = this.notifications.slice(0, count);
        const html = slice.map(notification => {
            let sessionDisplay = '';
            if (notification.sessionId) {
                sessionDisplay = `<span class=\"notification-item-session\"><a href=\"#\" class=\"notification-session-link\" data-session-id=\"${this.escapeHtml(notification.sessionId)}\">${this.escapeHtml(notification.sessionId)}</a></span>`;
            } else {
                sessionDisplay = `<span class=\"notification-item-session broadcast\">Broadcast</span>`;
            }
            const sourceLabel = `<span class='source-badge ${notification.origin === 'server' ? 'server' : 'local'}'>${notification.origin === 'server' ? 'Server' : 'Local'}</span>`;
            const interactiveSummary = this.renderInteractiveSummary(notification);
            return `
                <div class=\"notification-item ${notification.type} ${!notification.read ? 'unread' : ''}\" data-id=\"${notification.id}\">\n                    <div class=\"notification-item-header\">\n                        <h4 class=\"notification-item-title\">${this.escapeHtml(notification.title)}</h4>\n                        <button class=\"notification-item-dismiss\" title=\"Dismiss\">×</button>\n                    </div>\n                    <p class=\"notification-item-message\">${this.escapeHtml(notification.message)}</p>\n                    <div class=\"notification-item-footer\">\n                        ${sourceLabel}\n                        ${interactiveSummary}\n                        <div class=\"notification-item-bottom-row\">\n                            ${sessionDisplay}\n                            <span class=\"notification-item-timestamp\">${this.formatTimestamp(notification.timestamp)}</span>\n                        </div>\n                    </div>\n                </div>
            `;
        }).join('');

        // Load more control
        const hasMore = count < total;
        const loadMoreHtml = hasMore ? `
            <div class="load-more-container">
                <button class="load-more-btn" id="notification-load-more">Load more</button>
            </div>
        ` : '';

        listContainer.innerHTML = html + loadMoreHtml;
        this.renderedCount = count;
    }

    /**
     * Append next page of notifications when available
     */
    renderNextPage() {
        const listContainer = this.container.querySelector('#notification-list');
        if (!listContainer) return;
        const total = this.notifications.length;
        if (this.renderedCount >= total) return;

        const start = this.renderedCount;
        const end = Math.min(start + this.pageSize, total);
        const chunk = this.notifications.slice(start, end).map(notification => {
            let sessionDisplay = '';
            if (notification.sessionId) {
                sessionDisplay = `<span class=\"notification-item-session\"><a href=\"#\" class=\"notification-session-link\" data-session-id=\"${this.escapeHtml(notification.sessionId)}\">${this.escapeHtml(notification.sessionId)}</a></span>`;
            } else {
                sessionDisplay = `<span class=\"notification-item-session broadcast\">Broadcast</span>`;
            }
            const sourceLabel = `<span class='source-badge ${notification.origin === 'server' ? 'server' : 'local'}'>${notification.origin === 'server' ? 'Server' : 'Local'}</span>`;
            const interactiveSummary = this.renderInteractiveSummary(notification);
            return `
                <div class=\"notification-item ${notification.type} ${!notification.read ? 'unread' : ''}\" data-id=\"${notification.id}\">\n                    <div class=\"notification-item-header\">\n                        <h4 class=\"notification-item-title\">${this.escapeHtml(notification.title)}</h4>\n                        <button class=\"notification-item-dismiss\" title=\"Dismiss\">×</button>\n                    </div>\n                    <p class=\"notification-item-message\">${this.escapeHtml(notification.message)}</p>\n                    <div class=\"notification-item-footer\">\n                        ${sourceLabel}\n                        ${interactiveSummary}\n                        <div class=\"notification-item-bottom-row\">\n                            ${sessionDisplay}\n                            <span class=\"notification-item-timestamp\">${this.formatTimestamp(notification.timestamp)}</span>\n                        </div>\n                    </div>\n                </div>
            `;
        }).join('');

        // Insert before load-more container if present
        const loadMore = listContainer.querySelector('.load-more-container');
        if (loadMore) {
            loadMore.insertAdjacentHTML('beforebegin', chunk);
        } else {
            listContainer.insertAdjacentHTML('beforeend', chunk);
        }

        this.renderedCount = end;
        if (this.renderedCount >= total && loadMore) {
            loadMore.remove();
        }
    }

    /**
     * Render notifications only when the panel is open
     */
    renderNotificationsIfOpen() {
        if (this.isOpen) {
            this.renderNotifications();
        }
    }

    /**
     * Toggle the notification center panel
     */
    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    /**
     * Open the notification center panel
     */
    open() {
        this.isOpen = true;
        this.container.classList.add('open');
        // Initial render when opening to avoid heavy work on page load
        this.renderNotifications({ reset: true });
        
        // Mark all as read when opened
        if (this.unreadCount > 0) {
            setTimeout(() => this.markAllAsRead(true), 500);
        }
    }

    /**
     * Close the notification center panel
     */
    close() {
        this.isOpen = false;
        this.container.classList.remove('open');
    }

    /**
     * Format timestamp for display
     * @param {number} timestamp - Unix timestamp
     * @returns {string} Formatted timestamp
     */
    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        
        return date.toLocaleDateString();
    }

    /**
     * Render interactive response summary or controls when available.
     * - If a response exists: show a non-interactive summary.
     * - If interactive and no response: render inputs + action buttons so the user can respond from the center.
     * @param {Object} notification
     * @returns {string}
     */
    renderInteractiveSummary(notification) {
        try {
            const hasActions = Array.isArray(notification.actions) && notification.actions.length > 0;
            const hasInputs = Array.isArray(notification.inputs) && notification.inputs.length > 0;
            const response = notification.response || null;

            if (!hasActions && !hasInputs && !response) {
                return '';
            }

            const parts = [];

            if (response) {
                const headerPieces = [];
                headerPieces.push('<span class="notification-response-badge">Responded</span>');

                const actionLabel = response.action_label || response.action_key || '';
                if (actionLabel) {
                    headerPieces.push(`<span class="notification-response-action">${this.escapeHtml(actionLabel)}</span>`);
                }

                if (response.at) {
                    const atTs = new Date(response.at).getTime();
                    headerPieces.push(`<span class="notification-response-at">${this.escapeHtml(this.formatTimestamp(atTs))}</span>`);
                }

                const headerHtml = `<div class="notification-response-header">${headerPieces.join(' ')}</div>`;

                const rows = [];
                const respInputs = response.inputs || {};
                Object.keys(respInputs || {}).forEach((inputId) => {
                    const label = this.findInputLabel(notification, inputId);
                    const value = respInputs[inputId];
                    rows.push(
                        `<div class="notification-response-input"><span class="notification-response-input-label">${this.escapeHtml(label)}:</span><span class="notification-response-input-value">${this.escapeHtml(String(value))}</span></div>`
                    );
                });

                if (Array.isArray(response.masked_input_ids)) {
                    response.masked_input_ids.forEach((inputId) => {
                        const label = this.findInputLabel(notification, inputId);
                        rows.push(
                            `<div class="notification-response-input"><span class="notification-response-input-label">${this.escapeHtml(label)}:</span><span class="notification-response-input-value">••• provided</span></div>`
                        );
                    });
                }

                const inputsBlock = rows.length
                    ? `<div class="notification-response-inputs">${rows.join('')}</div>`
                    : '';

                parts.push(headerHtml + inputsBlock);
            } else if (hasActions || hasInputs) {
                // Interactive notification that has not yet been responded to: render controls.
                const controls = this.buildInteractiveControls(notification);
                if (controls) {
                    parts.push(controls);
                }
            }

            if (!parts.length) return '';
            return `<div class="notification-response-summary">${parts.join('')}</div>`;
        } catch (_) {
            return '';
        }
    }

    /**
     * Build HTML for interactive inputs and actions inside the notification center.
     * @param {Object} notification
     * @returns {string}
     */
    buildInteractiveControls(notification) {
        const actions = Array.isArray(notification.actions) ? notification.actions : [];
        const inputs = Array.isArray(notification.inputs) ? notification.inputs : [];
        if (!actions.length && !inputs.length) return '';

        const inputRows = inputs.map((inputDef) => {
            if (!inputDef || !inputDef.id) return '';
            const inputId = `nc-input-${this.escapeHtml(inputDef.id)}`;
            const labelText = inputDef.label || inputDef.id;
            const type = (inputDef.type === 'password') ? 'password' : 'text';
            const placeholder = inputDef.placeholder ? this.escapeHtml(String(inputDef.placeholder)) : '';
            const required = inputDef.required === true;
            const requiredIndicator = required ? '<span class="required-indicator">*</span>' : '';
            return `
                <div class="notification-input-row">
                    <label for="${inputId}">
                        ${this.escapeHtml(labelText)}${requiredIndicator}
                    </label>
                    <input
                        id="${inputId}"
                        class="notification-input"
                        type="${type}"
                        data-input-id="${this.escapeHtml(inputDef.id)}"
                        autocomplete="off"
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

        const statusHtml = `<div class="notification-action-status" aria-live="polite"></div>`;
        const errorHtml = `<div class="notification-action-error" aria-live="polite"></div>`;

        return `${inputsHtml}${actionsHtml}${statusHtml}${errorHtml}`;
    }

    /**
     * Find a human-friendly label for an input id.
     * @param {Object} notification
     * @param {string} inputId
     * @returns {string}
     */
    findInputLabel(notification, inputId) {
        try {
            const inputs = Array.isArray(notification.inputs) ? notification.inputs : [];
            const match = inputs.find((it) => it && it.id === inputId);
            if (match && match.label) return String(match.label);
            return String(inputId);
        } catch (_) {
            return String(inputId);
        }
    }

    /**
     * Enable/disable action buttons for a given notification item based on
     * required inputs and pending/resolved state.
     * @param {string} id - NotificationCenter local id
     */
    updateInteractiveButtonsState(id) {
        const notification = this.notifications.find(n => n.id === id);
        if (!notification || !notification.actions) return;

        if (!notification._interactiveState) {
            notification._interactiveState = {
                pendingActionKey: null,
                resolved: !!notification.response,
                lastSubmittedInputs: null
            };
        }

        const { pendingActionKey, resolved } = notification._interactiveState;

        const listContainer = this.container.querySelector('#notification-list');
        if (!listContainer) return;
        const item = listContainer.querySelector(`.notification-item[data-id="${this.escapeHtml(id)}"]`) ||
                     listContainer.querySelector(`.notification-item[data-id="${id}"]`);
        if (!item) return;

        const values = {};
        const inputEls = item.querySelectorAll('.notification-input[data-input-id]');
        inputEls.forEach((el) => {
            const key = el.getAttribute('data-input-id');
            if (!key) return;
            values[key] = (el.value || '').trim();
        });

        const buttons = item.querySelectorAll('.notification-action-button[data-action-key]');
        buttons.forEach((btn) => {
            const actionKey = btn.getAttribute('data-action-key');
            const action = notification.actions.find((a) => a && String(a.key) === String(actionKey));
            if (!action) return;

            let disabled = false;

            if (resolved) disabled = true;
            if (!disabled && pendingActionKey) disabled = true;

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
     * Handle click on an interactive action button in the notification center.
     * Sends a notification_action message over WebSocket.
     * @param {string} id - NotificationCenter local id
     * @param {string} actionKey
     */
    handleInteractiveActionClick(id, actionKey) {
        const notification = this.notifications.find(n => n.id === id);
        if (!notification || !notification.actions) return;

        if (!notification._interactiveState) {
            notification._interactiveState = {
                pendingActionKey: null,
                resolved: !!notification.response,
                lastSubmittedInputs: null
            };
        }

        const state = notification._interactiveState;
        if (state.pendingActionKey || state.resolved) {
            return;
        }

        const listContainer = this.container.querySelector('#notification-list');
        if (!listContainer) return;
        const item = listContainer.querySelector(`.notification-item[data-id="${this.escapeHtml(id)}"]`) ||
                     listContainer.querySelector(`.notification-item[data-id="${id}"]`);
        if (!item) return;

        const statusEl = item.querySelector('.notification-action-status') || null;
        const errorEl = item.querySelector('.notification-action-error') || null;

        const ctx = getContext();
        const ws = ctx?.websocketService;
        if (!ws || typeof ws.send !== 'function') {
            if (errorEl) errorEl.textContent = 'Not connected to server.';
            return;
        }

        const action = notification.actions.find((a) => a && String(a.key) === String(actionKey));
        if (!action) return;

        const values = {};
        const inputEls = item.querySelectorAll('.notification-input[data-input-id]');
        inputEls.forEach((el) => {
            const key = el.getAttribute('data-input-id');
            if (!key) return;
            values[key] = el.value || '';
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
                const labels = missingIds.map((idPart) => this.findInputLabel(notification, idPart));
                errorEl.textContent = `Please fill: ${labels.join(', ')}`;
            }
            return;
        }

        if (errorEl) errorEl.textContent = '';
        if (statusEl) statusEl.textContent = 'Sending...';

        state.pendingActionKey = action.key;
        state.lastSubmittedInputs = values;
        this.updateInteractiveButtonsState(id);

        const serverId = notification.serverId || notification.server_id || notification.id || null;
        if (!serverId) {
            if (errorEl) errorEl.textContent = 'Notification cannot be submitted (missing id).';
            state.pendingActionKey = null;
            if (statusEl) statusEl.textContent = '';
            this.updateInteractiveButtonsState(id);
            return;
        }

        try {
            ws.send('notification_action', {
                notification_id: serverId,
                action_key: action.key,
                inputs: values
            });
        } catch (e) {
            console.error('[NotificationCenter] Failed to send notification_action:', e);
            if (errorEl) errorEl.textContent = 'Failed to send response. Please try again.';
            if (statusEl) statusEl.textContent = '';
            state.pendingActionKey = null;
            this.updateInteractiveButtonsState(id);
        }
    }

    /**
     * Handle a notification_action_result from WebSocket for center entries.
     * @param {Object} result
     */
    handleActionResult(result) {
        if (!result || !result.notification_id) return;
        const targetId = String(result.notification_id);
        let updated = false;

        this.notifications.forEach((n) => {
            const serverId = n.serverId || n.server_id || n.id || null;
            if (!serverId || String(serverId) !== targetId) return;
            this.applyActionResultToNotification(n, result);
            updated = true;
        });

        if (updated) {
            this.renderNotificationsIfOpen();
        }
    }

    /**
     * Apply a notification_action_result to a center notification, updating
     * interactive state and response summary.
     * @param {Object} notification
     * @param {Object} result
     */
    applyActionResultToNotification(notification, result) {
        if (!notification) return;

        if (!notification._interactiveState) {
            notification._interactiveState = {
                pendingActionKey: null,
                resolved: !!notification.response,
                lastSubmittedInputs: null
            };
        }
        const state = notification._interactiveState;
        state.pendingActionKey = null;

        const listContainer = this.container.querySelector('#notification-list');
        const item = listContainer
            ? (listContainer.querySelector(`.notification-item[data-id="${this.escapeHtml(notification.id)}"]`) ||
               listContainer.querySelector(`.notification-item[data-id="${notification.id}"]`))
            : null;
        const statusEl = item ? item.querySelector('.notification-action-status') : null;
        const errorEl = item ? item.querySelector('.notification-action-error') : null;

        if (errorEl) errorEl.textContent = '';

        const action = Array.isArray(notification.actions)
            ? notification.actions.find((a) => a && String(a.key) === String(result.action_key))
            : null;
        const actionLabel = action?.label || result.action_key || '';

        const statusCode = typeof result.status === 'string' ? result.status : '';
        const isCallbackResult = statusCode === 'callback_succeeded' || statusCode === 'callback_failed';
        const isAlreadyResponded = statusCode === 'already_responded';

        if (result.ok || isCallbackResult || isAlreadyResponded) {
            state.resolved = true;

            if (statusEl) {
                const statusText = result.status ? String(result.status) : 'completed';
                statusEl.textContent = actionLabel
                    ? `Action "${actionLabel}" ${statusText}.`
                    : `Action ${statusText}.`;
            }

            // Build local response summary (non-secret only) for this notification
            // when the backend actually attempted the callback (success or failure).
            if (isCallbackResult || result.ok) {
                try {
                    const inputsDef = Array.isArray(notification.inputs) ? notification.inputs : [];
                    const submitted = state.lastSubmittedInputs || {};
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

                    notification.response = response;
                } catch (e) {
                    console.warn('[NotificationCenter] Failed to synthesize response summary:', e);
                }
            }
        } else {
            state.resolved = false;
            if (statusEl) statusEl.textContent = '';
            if (errorEl) {
                const msg = result.error || result.status || 'Action failed. Please try again.';
                errorEl.textContent = String(msg);
            }
        }

        this.updateInteractiveButtonsState(notification.id);
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
     * Update the stored response for notifications that reference a given server id.
     * @param {string|number} serverId
     * @param {Object} response
     */
    updateNotificationResponseByServerId(serverId, response) {
        if (!serverId) return;
        const target = String(serverId);
        let updated = false;
        this.notifications.forEach((n) => {
            if (String(n.serverId) === target) {
                n.response = response;
                updated = true;
            }
        });
        if (updated) {
            this.renderNotificationsIfOpen();
        }
    }

    /**
     * Get all notifications
     * @returns {Array} Array of notifications
     */
    getNotifications() {
        return [...this.notifications];
    }

    /**
     * Get unread count
     * @returns {number} Number of unread notifications
     */
    getUnreadCount() {
        return this.unreadCount;
    }

    /**
     * Navigate to a session internally
     * @param {string} sessionId - Session ID to navigate to
     */
    async navigateToSession(sessionId) {
        try {
            // Check if terminal manager is available
            const appRef = getContext()?.app;
            if (!appRef?.modules?.terminal) {
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
export const notificationCenter = new NotificationCenter();

// No global assignment; modules should import or use AppContext
import { isAnyModalOpen } from '../ui/modal.js';

// Bulk seeding API for initial load (avoids per-item re-render)
// Items are expected in server format (newest-first)
NotificationCenter.prototype.seedNotifications = function(items) {
    try {
        const normalized = (Array.isArray(items) ? items : []).map((n) => {
            const actions = Array.isArray(n.actions) ? n.actions : undefined;
            const inputs = Array.isArray(n.inputs) ? n.inputs : undefined;
            const response = n.response || null;
            const interactive = !!(
                (Array.isArray(actions) && actions.length > 0) ||
                (Array.isArray(inputs) && inputs.length > 0)
            );
            return {
                id: `svr-${n.id}-${Math.random().toString(36).slice(2, 7)}`,
                title: n.title || 'Notification',
                message: n.message || '',
                type: n.notification_type || 'info',
                timestamp: n.timestamp || Date.now(),
                sessionId: n.session_id || null,
                isActive: n.is_active !== false,
                read: Boolean(n.read === true ? true : false),
                serverId: n.id,
                origin: 'server',
                actions,
                inputs,
                response,
                interactive
            };
        });
        // Keep newest-first
        this.notifications = normalized;
        this.unreadCount = this.notifications.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);
        this.renderedCount = 0; // nothing rendered until panel opens
        this.updateBadge();
        // Do not render here; panel open will render lazily
    } catch (e) {
        try { console.warn('[NotificationCenter] seed failed:', e); } catch (_) {}
    }
};
