/**
 * Main Application Module
 * Handles routing, page management, and module initialization
 */

import '../utils/logger.js';
import { TerminalManager } from '../modules/terminal/manager.js';
import { TabManager } from '../modules/terminal/tab-manager.js';
import { HistoryPage } from '../modules/history/history-page.js';
import { ContainersPage } from '../modules/containers/containers-page.js';
import { websocketService } from '../services/websocket.service.js';
import { apiService } from '../services/api.service.js';
import { errorHandler } from '../utils/error-handler.js';
import { EventBus } from '../utils/eventbus.js';
import { config } from './config.js';
import { keyOverlay } from '../utils/key-overlay.js';
import { authSession } from '../utils/auth-session.js';
import { appStore } from './store.js';
import { settingsManager } from '../modules/settings/settings-manager.js';
import { setContext } from './context.js';
import { mobileViewport } from '../utils/mobile-viewport.js';
import { mobileDetection } from '../utils/mobile-detection.js';
import { responsiveToolbarManager } from '../utils/responsive-toolbar-manager.js';
import { notificationDisplay } from '../utils/notification-display.js';
import { notificationCenter } from '../modules/notification-center/notification-center.js';
import { iconUtils } from '../utils/icon-utils.js';
import { GlobalLinksController } from '../modules/links/global-links-controller.js';
import { userMenu } from '../modules/user/user-menu.js';
import { profileShortcuts } from '../modules/user/profile-shortcuts.js';
import { authModal } from '../modules/auth/auth-modal.js';
import { passwordResetModal } from '../modules/auth/password-reset-modal.js';
import { isAnyModalOpen } from '../modules/ui/modal.js';
import { authOrchestrator } from './auth-orchestrator.js';
import { initWindowTitleSync } from '../utils/window-title.js';

// (cleanup) Removed legacy isChildOf helper injection; not required.

class Application {
    constructor() {
        this.eventBus = new EventBus();
        this.modules = {};
        this.currentPage = 'terminal';
        this._postAuthInitialized = false;
        this._connectionSubscriptionBound = false;
        this.serverRequiresAuth = false;
        this._websocketListenersBound = false;
        this._secondaryAuthWaitTimer = null;
        this.isDedicatedWindow = false;
        this._secondaryOverlayEl = null;

        this.init();
    }

  async init() {
        authOrchestrator.initialize(this);
        // Configure API service with correct base URL
        apiService.baseUrl = config.API_BASE_URL;

        // If a client override is provided via URL (e.g., dedicated Electron windows),
        // use it for this renderer process only and avoid persisting it to shared state.
        try {
            const params = new URLSearchParams(window.location.search || '');
            const clientOverride = (params.get('client') || '').trim();
            if (clientOverride) {
                this.clientId = clientOverride;
            }
            // Detect dedicated secondary window mode early
            try {
                if (window.WindowModeUtils && typeof WindowModeUtils.shouldUseWindowModeFromUrl === 'function') {
                    this.isDedicatedWindow = !!WindowModeUtils.shouldUseWindowModeFromUrl(window.location);
                } else {
                    const ui = String(params.get('ui') || '').toLowerCase();
                    const win = String(params.get('window') || '').trim();
                    const hasSid = !!String(params.get('session_id') || '').trim();
                    this.isDedicatedWindow = (ui === 'window') || (win === '1' || win.toLowerCase() === 'true') || (hasSid && !ui);
                }
            } catch (_) { this.isDedicatedWindow = false; }

            // Defer non-target selection during startup when dedicated window targets a session
            try {
                const sid = String(params.get('session_id') || '').trim();
                if (this.isDedicatedWindow && sid) {
                    window.__DEFER_SESSION_SELECTION__ = true;
                    window.__TARGET_SESSION_ID__ = sid;
                }
            } catch (_) { /* ignore */ }
        } catch (_) { /* ignore */ }

        // Publish shared context as early as possible so modules can consume it safely
        setContext({
            app: this,
            appStore,
            apiService,
            websocketService,
            eventBus: this.eventBus,
        });

        // Initialize icons immediately so they render before any async work
        this.initializeIcons();

        // Setup desktop full-screen toggle if running in Electron
        try { this.setupFullScreenToggle(); } catch (e) { console.warn('[App] Fullscreen toggle init failed:', e); }

        // Adjust Mac traffic-light inset based on page zoom to keep
        // the desktop sidebar toggle clear of the window controls
        try { this.setupMacTitlebarInsetForZoom(); } catch (e) { console.debug('[MacInset] init error', e); }

        // Initialize minimal UI pieces needed before any API call
        // Settings modal (for API config) must apply theme before auth modal toggles UI
        try { settingsManager.init(); } catch (e) { console.warn('[App] Settings init failed (pre-auth):', e); }
        try { userMenu.init(); } catch (e) { console.warn('[App] User menu init failed (pre-auth):', e); }
        // Register global profile switching shortcuts
        try { profileShortcuts.init(); } catch (e) { console.warn('[App] Profile shortcuts init failed:', e); }
        // Allow settings manager init to flush theme before showing auth modal
        setTimeout(() => {
            try { authModal.init(); } catch (e) { console.warn('[App] Auth modal init failed:', e); }
            try { passwordResetModal.init(); } catch (e) { console.warn('[App] Password reset modal init failed:', e); }
        }, 0);

        // If no API base URL is configured (no saved URL and no injected default),
        // skip the automatic auth flow and immediately show the login modal
        // with the advanced API settings expanded so the user can configure it.
        const hasApiConfig = config.HAS_ANY_API_CONFIG === true;
        const initialApiBase = (config.API_BASE_URL || '').trim();
        if (!hasApiConfig && !initialApiBase) {
            this.showLoginPrompt({ expandApiSettings: true });
            return;
        }

        try {
            await authOrchestrator.startInitialFlow();
        } catch (error) {
            console.error('[App] Failed to start initial auth flow:', error);
            this.showLoginPrompt();
        }
    }

    setupFullScreenToggle() {
        const btn = document.getElementById('window-fullscreen-toggle');
        const iconSpan = document.getElementById('window-fullscreen-toggle-icon');
        if (!btn || !iconSpan) return;

        const isElectron = !!(window.desktop && window.desktop.isElectron);
        if (!isElectron) {
            try { btn.style.display = 'none'; } catch (_) {}
            return;
        }

        const applyState = (fs) => {
            const fullscreen = !!fs;
            try { btn.setAttribute('aria-pressed', fullscreen ? 'true' : 'false'); } catch (_) {}
            try { btn.title = fullscreen ? 'Exit full screen' : 'Enter full screen'; } catch (_) {}
            try {
                // Swap icon
                iconSpan.innerHTML = '';
                iconSpan.appendChild(iconUtils.createIcon(fullscreen ? 'fullscreen-exit' : 'fullscreen', { size: 16 }));
            } catch (_) {}
        };

        // Reflect DOM class changes applied by the Electron main process
        try {
            const root = document.documentElement;
            const obs = new MutationObserver(() => applyState(root.classList.contains('is-fullscreen')));
            obs.observe(root, { attributes: true, attributeFilter: ['class'] });
            // Initial apply based on current class
            applyState(root.classList.contains('is-fullscreen'));
        } catch (_) { /* ignore */ }

        // Also query initial fullscreen state from the desktop API (in case class not yet set)
        try { window.desktop.getFullScreen().then((fs) => applyState(!!fs)).catch(() => {}); } catch (_) {}

        // Wire click handler
        btn.addEventListener('click', () => {
            try { window.desktop.toggleFullScreen(); } catch (_) {}
            try { btn.blur && btn.blur(); } catch (_) {}
        });
    }

    // Keep header padding-left large enough (in CSS pixels) so that the
    // macOS window traffic lights never overlap the header controls when
    // the page is zoomed in/out inside Electron. We do this by setting a
    // CSS variable that scales inversely with the page zoom factor.
    setupMacTitlebarInsetForZoom() {
        const root = document.documentElement;
        const isElectron = root.classList.contains('is-electron');
        const isMac = root.classList.contains('platform-mac');
        const verbose = (() => {
            try {
                if (config && config.DEBUG_FLAGS && config.DEBUG_FLAGS.verboseLogs) return true;
                const params = new URLSearchParams(window.location.search);
                if (params.get('verboseLogs') === '1') return true;
                try { if (window.localStorage?.getItem('tm_verbose_logs') === '1') return true; } catch (_) {}
            } catch (_) { /* ignore */ }
            return false;
        })();
        if (verbose) console.debug('[MacInset] environment check', { isElectron, isMac, classes: Array.from(root.classList) });
        if (!isElectron || !isMac) return;

        const BASE_INSET_PX = 120; // base 80px + extra 40px safety margin

        // Use devicePixelRatio as the primary zoom signal on desktop.
        // Capture baseline DPR at first init and treat it as 100% zoom.
        if (!this._macInsetBaseDpr) {
            this._macInsetBaseDpr = Math.max(0.5, Number(window.devicePixelRatio || 1));
            if (verbose) console.debug('[MacInset] baseline DPR set', this._macInsetBaseDpr);
        }

        const applyInset = () => {
            // Compute zoom factor relative to baseline DPR. On desktop Chrome/Electron,
            // page zoom changes devicePixelRatio, while the baseline captures monitor DPI.
            const currentDpr = Math.max(0.5, Number(window.devicePixelRatio || this._macInsetBaseDpr || 1));
            let zoomFactor = currentDpr / this._macInsetBaseDpr;

            // As a secondary signal (rare), use visualViewport.scale if it deviates significantly
            try {
                if (window.visualViewport && typeof window.visualViewport.scale === 'number') {
                    const vv = window.visualViewport.scale || 1;
                    // If vv suggests different zoom (>10% delta), prefer it
                    if (Math.abs(vv - 1) > 0.1) {
                        zoomFactor = vv; // vv behaves like a scale multiplier
                    }
                }
            } catch (_) { /* ignore */ }

            // Avoid extreme values
            const z = Math.max(0.5, Math.min(3, zoomFactor));
            const inset = (BASE_INSET_PX / z);
            // Only log/update if value changed enough to matter visually
            const prev = this._lastMacInsetApplied;
            root.style.setProperty('--mac-header-left-inset', `${inset}px`);
            this._lastMacInsetApplied = inset;
            if (verbose && (prev == null || Math.abs(prev - inset) >= 0.5)) {
                console.debug('[MacInset] applied', { baseDpr: this._macInsetBaseDpr, currentDpr, zoomFactor: z, insetPx: inset });
            }
        };

        // Initial apply and wire listeners for zoom/viewport changes
        applyInset();
        try { window.addEventListener('resize', applyInset, { passive: true }); } catch (_) {}
        try { window.visualViewport && window.visualViewport.addEventListener('resize', applyInset, { passive: true }); } catch (_) {}

        // Also observe class changes for fullscreen toggling to log state
        try {
            const observer = new MutationObserver(() => {
                const fs = root.classList.contains('is-fullscreen');
                if (verbose) console.debug('[MacInset] fullscreen state changed', { fullscreen: fs });
                // We don't change inset in fullscreen (CSS overrides), but we keep it updated for when exiting.
                if (!fs) applyInset();
            });
            observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        } catch (_) { /* ignore */ }
    }

    async initServerConnection(prefetched) {
        // Generate or retrieve client ID for WebSocket connection
        if (!this.clientId) {
            let clientId = null;
            try {
                const mod = await import('./state-store/index.js');
                clientId = await mod.getStateStore().get('terminal_manager_client_id');
            } catch (_) { clientId = null; }
            if (!clientId) {
                clientId = `client_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`;
                try {
                    const batch = await import('./state-store/batch.js');
                    batch.queueStateSet('terminal_manager_client_id', clientId, 200);
                } catch (_) {}
            }
            this.clientId = clientId;
        }

        // Configure WebSocket service with correct options from config
        websocketService.options = {
            ...websocketService.options,
            reconnectDelay: config.RECONNECT_DELAY,
            maxReconnectDelay: config.MAX_RECONNECT_DELAY,
            reconnectDecay: config.RECONNECT_DECAY,
            pingInterval: config.PING_INTERVAL
        };

        if (!this._websocketListenersBound) {
            websocketService.on('open', () => {
                this.eventBus.emit('ws:connected');
                this.updateConnectionStatus('Connected', true);
            });
            
            websocketService.on('close', () => {
                this.eventBus.emit('ws:disconnected');
                this.updateConnectionStatus('Disconnected', false);
            });
            
            websocketService.on('error', (error) => {
                this.eventBus.emit('ws:error', error);
                this.updateConnectionStatus('Error', false);
            });
            
            websocketService.on('auth_failed', (data) => {
                console.error('[App] WebSocket authentication failed:', data.reason);
                this.updateConnectionStatus('Authentication failed - check credentials', false);
            });
            this._websocketListenersBound = true;
        }

        let systemResult;
        if (prefetched && prefetched.serverInfo) {
            systemResult = {
                success: true,
                serverInfo: prefetched.serverInfo,
                authRequired: Boolean(prefetched.authRequired),
                authError: prefetched.authError || null
            };
            this.serverRequiresAuth = Boolean(systemResult.authRequired);
            try {
                appStore.setState({ systemInfo: prefetched.serverInfo });
            } catch (_) {}
            const environment = window.TERMINAL_MANAGER_ENVIRONMENT;
        if (prefetched.serverInfo.version || environment) {
                this.displayVersion(prefetched.serverInfo.version, environment);
            }
        } else {
            systemResult = await this.loadSystemInfo();
            this.serverRequiresAuth = Boolean(systemResult.authRequired);
        }

        return systemResult;
    }

    async runBootPipeline(initResult) {
        this.serverRequiresAuth = Boolean(initResult?.authRequired);

        if (!initResult || !initResult.success) {
            apiService.setAuthenticated(false);
            if (initResult && initResult.authError) {
                if (initResult.authError.type === 'auth_required') {
                    try { authSession.setLoggedIn(false); } catch (_) {}
                    this.showLoginPrompt();
                } else {
                    this.showDeferredAuthNotification(initResult.authError);
                }
            }
            return;
        }

        apiService.setAuthenticated(true);

        try {
            if (initResult.serverInfo && initResult.serverInfo.current_user) {
                authSession.setLoggedIn(true);
            }
        } catch (_) {}

        await this.connectWebSocketWithAuth(initResult.authRequired);
        await this.ensurePostAuthSetup();

        if (initResult.authError) {
            setTimeout(() => {
                this.showDeferredAuthNotification(initResult.authError);
            }, 500);
        }
    }

    async ensurePostAuthSetup() {
        if (this._postAuthInitialized) return;
        // Load user features before initializing modules so feature-gated UI can hide appropriately
        try {
            const me = await apiService.getCurrentUser();
            if (me && typeof me === 'object') {
                if (me.features && typeof me.features === 'object') {
                    try { appStore.setPath('auth.features', me.features); } catch (_) {}
                }
                if (me.permissions && typeof me.permissions === 'object') {
                    try { appStore.setPath('auth.permissions', me.permissions); } catch (_) {}
                }
                if (Object.prototype.hasOwnProperty.call(me, 'prompt_for_reset')) {
                    try { appStore.setPath('auth.prompt_for_reset', !!me.prompt_for_reset); } catch (_) {}
                }
                try { settingsManager.updateUIFromStore(); } catch (_) {}
            }
        } catch (_) {}

        await this.initModules();

        // Enforce first-login password reset when requested by the server
        try {
            const state = appStore.getState();
            const mustReset = state?.auth?.prompt_for_reset === true;
            const features = state?.auth?.features || {};
            if (mustReset && features.password_reset_enabled === true && !this.isDedicatedWindow) {
                try { passwordResetModal.show({ force: true }); } catch (e) { console.warn('[App] Password reset modal show failed:', e); }
            }
        } catch (_) {}

        // Initialize dynamic window title syncing for window-mode (web + Electron)
        try { this._disposeWindowTitleSync = initWindowTitleSync(); } catch (e) { console.warn('[App] Window title sync init failed:', e); }

        this.setupNavigation();
        this.setupEventListeners();

        // Load any server-side notifications for this user and seed the center
        try {
            const data = await apiService.getNotifications();
            const items = (data && Array.isArray(data.notifications)) ? data.notifications : [];
            if (items.length > 0) {
                // Seed in bulk to avoid per-item re-render and speed up load
                if (typeof notificationCenter.seedNotifications === 'function') {
                    notificationCenter.seedNotifications(items);
                } else {
                    // Fallback (legacy): add individually
                    items.slice().reverse().forEach((n) => {
                        try {
                            notificationCenter.addNotification({
                                title: n.title,
                                message: n.message,
                                notification_type: n.notification_type,
                                timestamp: n.timestamp,
                                session_id: n.session_id,
                                is_active: n.is_active,
                                read: n.read,
                                server_id: n.id
                            });
                        } catch (_) {}
                    });
                }
            }
        } catch (e) {
            console.warn('[App] Failed to load server notifications:', e?.message || e);
        }

        if (!this._connectionSubscriptionBound) {
            try {
                this.unsubscribeConnection = appStore.subscribe('connection.websocket', (newStatus) => {
                    const statusMap = {
                        connected: { text: 'Connected', ok: true },
                        connecting: { text: 'Connecting...', ok: false },
                        error: { text: 'Error', ok: false },
                        disconnected: { text: 'Disconnected', ok: false }
                    };
                    const mapped = statusMap[newStatus] || { text: 'Disconnected', ok: false };
                    this.updateConnectionStatus(mapped.text, mapped.ok);
                });
                this._connectionSubscriptionBound = true;
            } catch (e) {
                console.warn('[App] Failed to subscribe to connection status:', e);
            }
        }

        responsiveToolbarManager.init();

        // Show a one-time toast when we just switched profiles (flag is set before reload).
        try {
            this.showProfileSwitchToastIfNeeded();
        } catch (_) {}

        // Fast path: in dedicated window, attempt to adopt only if the session id belongs
        // to a local PTY. Probe via localpty.attach; if not-found, fall back to server path.
        let didLocalAdopt = false;
        try {
            const params = new URLSearchParams(window.location.search || '');
            const sid = String(params.get('session_id') || '').trim();
            const isWindow = this.isDedicatedWindow;
            const lpty = (window.desktop && window.desktop.isElectron && window.desktop.localpty) ? window.desktop.localpty : null;
            if (isWindow && sid && lpty && this.modules.terminal && typeof this.modules.terminal.adoptLocalSession === 'function') {
                try {
                    const res = await lpty.attach({ sessionId: sid }).catch(() => ({ ok: false }));
                    if (res && res.ok) {
                        await this.modules.terminal.adoptLocalSession(sid);
                        didLocalAdopt = true;
                        try { window.__DEFER_SESSION_SELECTION__ = false; } catch (_) {}
                    }
                } catch (e) {
                    // Treat as non-local; continue to server path
                }
            }
        } catch (e) {
            console.warn('[App] Local adoption probe failed:', e);
        }

        if (!didLocalAdopt) {
            await this.handleSessionIdParameter();
        }
        this.setupMobileSidebar();
        this.showPage('terminal');

        setTimeout(async () => {
            if (this.modules.terminal && this.modules.terminal.handleInitialAutoSelection) {
                await this.modules.terminal.handleInitialAutoSelection();
            }
        }, 100);

        setTimeout(() => {
            this.updateConnectionStatusFromWebSocket();
        }, 150);

        this.startStatusMonitoring();

        this._postAuthInitialized = true;
    }

    showLoginPrompt(options = {}) {
        const expandApiSettings = options && options.expandApiSettings === true;
        try { sessionStorage.removeItem('tm_logged_in'); } catch (_) {}
        // In dedicated secondary windows, avoid showing the blocking auth modal.
        // Instead, wait for the primary window to authenticate and then continue boot.
        if (this.isDedicatedWindow) {
            this.startSecondaryAuthWait();
            return;
        }
        setTimeout(() => {
            try {
                if (expandApiSettings && typeof authModal.show === 'function') {
                    authModal.show({ expandApiSettings: true });
                } else {
                    authModal.show();
                }
            } catch (e) {
                console.warn('[App] Failed to show auth modal:', e);
            }
        }, 0);
    }

    startSecondaryAuthWait() {
        // Provide a clear status to the user
        this.updateConnectionStatus('Waiting for authentication in primary window…', false);
        // Show greyed-out overlay while waiting in a dedicated secondary window
        this.showSecondaryAuthOverlay();
        // Clear any previous timer
        try { if (this._secondaryAuthWaitTimer) { clearTimeout(this._secondaryAuthWaitTimer); } } catch (_) {}
        this._secondaryAuthWaitTimer = null;

        const attempt = async () => {
            // If already initialized post-auth, stop waiting
            if (this._postAuthInitialized) return;
            try {
                // Give a small window for cookies to propagate in Electron
                const info = await apiService.getInfo({ retryOn401: true, retryDelayMs: 150 });
                if (info && (info.current_user || info.version)) {
                    try { apiService.setAuthenticated(true); } catch (_) {}
                    try { authSession.setLoggedIn(true); } catch (_) {}
                    // Proceed with normal boot using the known server info
                    try { await authOrchestrator.bootWithKnownInfo(info); } catch (_) {}
                    // Remove overlay now that we can proceed
                    try { this.hideSecondaryAuthOverlay(); } catch (_) {}
                    return; // done
                }
            } catch (e) {
                // Keep waiting on 401/connection errors
            }
            // Schedule next attempt
            this._secondaryAuthWaitTimer = setTimeout(attempt, 750);
        };

        // Kick off the first attempt shortly
        this._secondaryAuthWaitTimer = setTimeout(attempt, 250);
    }

    showSecondaryAuthOverlay() {
        try {
            if (!this.isDedicatedWindow) return;
            let el = this._secondaryOverlayEl || document.getElementById('secondary-auth-overlay');
            if (!el) {
                el = document.createElement('div');
                el.id = 'secondary-auth-overlay';
                el.setAttribute('aria-hidden', 'true');
                // Keep overlay lightweight: visual backdrop only, no content
                document.body.appendChild(el);
                this._secondaryOverlayEl = el;
            }
            el.classList.add('show');
        } catch (_) { /* ignore */ }
    }

    hideSecondaryAuthOverlay() {
        try {
            const el = this._secondaryOverlayEl || document.getElementById('secondary-auth-overlay');
            if (el) el.classList.remove('show');
        } catch (_) { /* ignore */ }
    }

    async handleLogoutCleanup() {
        try {
            websocketService.disconnect(1000, 'User logout');
        } catch (_) {}
        this.serverRequiresAuth = true;
        try {
            if (typeof this.unsubscribeConnection === 'function') {
                this.unsubscribeConnection();
            }
        } catch (_) {}
        this.unsubscribeConnection = null;
        this._postAuthInitialized = false;
        this._connectionSubscriptionBound = false;
    }

    async connectWebSocketWithAuth(authRequired) {
        // Connect WebSocket with appropriate auth settings
        try {
            this.updateConnectionStatus('Connecting WebSocket...', false);
            const requireAuth = Boolean(authRequired);
            this.serverRequiresAuth = requireAuth;
            await this.connectWebSocket({ requireAuth });
        } catch (error) {
            console.error('[App] WebSocket connection failed:', error);
            this.updateConnectionStatus(`WebSocket connection failed: ${error.message}`, false);
        }
    }

    showDeferredAuthNotification(authError) {
        const notificationMap = {
            auth_required: { title: 'Authentication Required', type: 'warning' },
            auth_failed: { title: 'Authentication Failed', type: 'error' },
            connection_failed: { title: 'Connection Failed', type: 'error' }
        };

        const notification = notificationMap[authError.type];
        if (notification) {
            notificationDisplay.show({
                title: notification.title,
                message: authError.message,
                notification_type: notification.type
            });
            console.log(`[App] Showed deferred notification: ${notification.title}`);
        }
    }

    async connectWebSocket(authOptions = {}) {
        // A resolver that always builds a fresh WS URL (fetches new token when required)
        const urlResolver = async () => {
            let url = config.WS_ENDPOINT(this.clientId);
            try {
                if (authOptions && authOptions.requireAuth === true && (!authOptions.auth || !authOptions.auth.username || !authOptions.auth.password)) {
                    const tokResp = await apiService.get('/api/ws-token');
                    const token = tokResp && tokResp.token ? tokResp.token : null;
                    if (token) {
                        const sep = url.includes('?') ? '&' : '?';
                        url = `${url}${sep}ws_token=${encodeURIComponent(token)}`;
                    }
                }
            } catch (_) {}
            return url;
        };

        try {
            const wsUrl = await urlResolver();
            await websocketService.connect(wsUrl, { ...authOptions, urlResolver });
        } catch (error) {
            errorHandler.handle(error, { context: 'websocket_connection' });
        }
    }

    async initModules() {
        // Initialize Tab Manager for terminal + URL viewing
        this.modules.tabManager = new TabManager(this.eventBus);
        
        // Initialize Terminal Manager module (pass WebSocket service as client)
        this.modules.terminal = new TerminalManager(websocketService, this.eventBus, this.clientId);
        await this.modules.terminal.init();
        
        // Initialize History Page module
        this.modules.history = new HistoryPage();

        // Initialize Containers Page module
        this.modules.containers = new ContainersPage();

        // Initialize Global Links controller (header dropdown)
        try {
            this.modules.globalLinks = new GlobalLinksController();
            await this.modules.globalLinks.init();
        } catch (e) {
            console.warn('[App] Failed to initialize global links:', e);
        }

        // Setup event listeners for URL tab opening
        this.eventBus.on('open-url-in-tab', (data) => {
            this.modules.tabManager.createUrlTab(data.url, data.title);
        });
        
        // Setup event listener for tab switching - auto-focus terminal when terminal tab is clicked
        this.eventBus.on('tab-switched', (data) => {
            if (data.tabId === 'terminal' && this.modules.terminal && this.modules.terminal.currentSession) {
                // Only auto-focus the terminal on non-mobile devices to prevent keyboard popup
                if (!this.modules.terminal.currentSession.shouldPreventAutoFocus()) {
                    this.modules.terminal.currentSession.focus();
                }
            }
        });

        // Future modules can be added here
        // this.modules.fileManager = new FileManager(websocketService, this.eventBus);
        // this.modules.settings = new Settings(websocketService, this.eventBus);
    }

    setupNavigation() {
        // Handle navigation button clicks
        const navButtons = document.querySelectorAll('.nav-btn');
        navButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const page = e.currentTarget.dataset.page;
                this.showPage(page);

                // Update active state
                navButtons.forEach(btn => btn.classList.remove('active'));
                e.currentTarget.classList.add('active');
            });
        });
    }

    setupEventListeners() {
        // WebSocket connection status
        this.eventBus.on('ws:connected', () => {
            this.updateConnectionStatus('Connected', true);
        });

        this.eventBus.on('ws:disconnected', () => {
            this.updateConnectionStatus('Disconnected', false);
        });

        this.eventBus.on('ws:error', (error) => {
            console.error('WebSocket error:', error);
            this.updateConnectionStatus('Error', false);
        });

        // Handle page visibility changes (useful for mobile)
        document.addEventListener('visibilitychange', async () => {
            // Only act when page becomes visible again
            if (document.hidden) return;

            const state = websocketService.getState();
            if (state === 'disconnected') {
                // If disconnected while backgrounded, reconnect
                await this.connectWebSocketWithAuth(this.serverRequiresAuth);
                return;
            }

            // If still "connected" after resume, proactively reattach the active session.
            // On some mobile browsers, the transport resumes but server-side stream
            // subscriptions are lost; reattach ensures stdout resumes.
            if (state === 'connected') {
                try {
                    const mgr = this.modules && this.modules.terminal ? this.modules.terminal : null;
                    if (mgr && mgr.currentSessionId && mgr.attachedSessions && mgr.attachedSessions.has(mgr.currentSessionId)) {
                        const sessionObj = (mgr.sessions && typeof mgr.sessions.get === 'function') ? mgr.sessions.get(mgr.currentSessionId) : null;
                        if (sessionObj && typeof sessionObj.attach === 'function') {
                            await sessionObj.attach(true);
                        } else if (typeof mgr.attachToCurrentSession === 'function') {
                            await mgr.attachToCurrentSession();
                        }
                    }
                } catch (e) {
                    console.warn('[App] Reattach on visibilitychange failed:', e);
                }
            }
        });

        // Navigate away from non-terminal pages when a session context changes
        this.eventBus.on('session-changed', () => {
            if (this.currentPage === 'history' || this.currentPage === 'containers') {
                this.showPage('terminal');
            }
        });

        // Also react to workspace view changes
        this.eventBus.on('workspace-changed', () => {
            if (this.currentPage === 'history' || this.currentPage === 'containers') {
                this.showPage('terminal');
            }
        });
    }

    showPage(pageName) {
        // Hide all pages
        document.querySelectorAll('.page').forEach(page => {
            page.classList.remove('active');
        });

        // Show selected page (ensure element exists) and notify module
        const pageId = `${pageName}-page`;
        let pageElement = document.getElementById(pageId);
        if (!pageElement) {
            try {
                // Try to attach the module's container if it exists but isn't in the DOM yet
                const mod = this.modules && this.modules[pageName] ? this.modules[pageName] : null;
                if (mod) {
                    if (mod.container && mod.container.id === pageId && !mod.container.parentNode) {
                        const appContent = document.querySelector('.app-content');
                        if (appContent) appContent.appendChild(mod.container);
                    } else if (typeof mod.createContainer === 'function') {
                        mod.createContainer();
                    }
                }
            } catch (_) { /* ignore */ }
            pageElement = document.getElementById(pageId);
        }
        if (pageElement) {
            pageElement.classList.add('active');

            if (this.modules[pageName] && this.modules[pageName].onPageActive) {
                this.modules[pageName].onPageActive();
            }

            // Auto-focus terminal when switching to terminal page (non-mobile only)
            if (pageName === 'terminal' && this.modules.terminal && this.modules.terminal.currentSession) {
                if (!this.modules.terminal.currentSession.shouldPreventAutoFocus()) {
                    this.modules.terminal.currentSession.focus();
                }
            }
        }

        // Track current page even if the element doesn't exist (e.g., terminal)
        this.currentPage = pageName;

        // Sync nav button active state
        try {
            const navButtons = document.querySelectorAll('.nav-btn');
            navButtons.forEach(btn => {
                const isActive = btn.dataset.page === pageName;
                btn.classList.toggle('active', !!isActive);
            });
        } catch (_) { /* ignore */ }
    }

    setupMobileSidebar() {
        const toggleButton = document.getElementById('mobile-sidebar-toggle');
        const toolbarToggleButton = document.getElementById('toolbar-sidebar-toggle');
        const windowToggleButton = document.getElementById('window-sidebar-toggle');
        const sidebar = document.querySelector('.terminal-sidebar');
        if (toggleButton) {
            toggleButton.setAttribute('aria-controls', 'terminal-sidebar');
            toggleButton.setAttribute('aria-expanded', 'false');
        }
        if (toolbarToggleButton) {
            toolbarToggleButton.setAttribute('aria-controls', 'terminal-sidebar');
            toolbarToggleButton.setAttribute('aria-expanded', 'false');
        }
        if (windowToggleButton) {
            windowToggleButton.setAttribute('aria-controls', 'terminal-sidebar');
            windowToggleButton.setAttribute('aria-expanded', 'false');
        }

        if ((!toggleButton && !toolbarToggleButton && !windowToggleButton) || !sidebar) {
            return;
        }

        // Don't auto-show sidebar on mobile - user should manually open it

        const handleToggleClick = () => {
            const isVisible = sidebar.classList.contains('mobile-visible');
            if (isVisible) {
                this.hideMobileSidebar();
            } else {
                this.showMobileSidebar();
            }
            try { toggleButton && toggleButton.setAttribute('aria-expanded', (!isVisible).toString()); } catch (_) {}
            try { toolbarToggleButton && toolbarToggleButton.setAttribute('aria-expanded', (!isVisible).toString()); } catch (_) {}
            try { windowToggleButton && windowToggleButton.setAttribute('aria-expanded', (!isVisible).toString()); } catch (_) {}
            // Remove focus ring/highlight after click
            try { toggleButton && toggleButton.blur && toggleButton.blur(); } catch (_) {}
            try { toolbarToggleButton && toolbarToggleButton.blur && toolbarToggleButton.blur(); } catch (_) {}
            try { windowToggleButton && windowToggleButton.blur && windowToggleButton.blur(); } catch (_) {}
        };

        // Toggle sidebar on button click(s)
        if (toggleButton) toggleButton.addEventListener('click', handleToggleClick);
        if (toolbarToggleButton) toolbarToggleButton.addEventListener('click', handleToggleClick);
        if (windowToggleButton) windowToggleButton.addEventListener('click', handleToggleClick);

        // Backdrop click closes overlay
        const backdrop = document.getElementById('sidebar-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', () => {
                if (sidebar.classList.contains('mobile-visible')) {
                    this.hideMobileSidebar();
                    try { toggleButton && toggleButton.setAttribute('aria-expanded', 'false'); } catch (_) {}
                    try { toolbarToggleButton && toolbarToggleButton.setAttribute('aria-expanded', 'false'); } catch (_) {}
                    try { windowToggleButton && windowToggleButton.setAttribute('aria-expanded', 'false'); } catch (_) {}
                }
            });
        }

        // Fallback keyboard handler for dedicated window if global shortcut is unavailable
        try {
            const params = new URLSearchParams(window.location.search || '');
            const isDedicated = (params.get('window') === '1') || ((params.get('ui') || '').toLowerCase() === 'window');
            if (isDedicated) {
                document.addEventListener('keydown', (e) => {
                    // Toggle on Shift+Meta+? or Shift+Alt+? or Shift+Ctrl+?
                    // Use Slash code with Shift to represent '?'
                    const isQMark = (e.code === 'Slash');
                    if (!isQMark) return;
                    if (!e.shiftKey) return;
                    if (!(e.metaKey || e.altKey || e.ctrlKey)) return;
                    // Avoid conflicting with TerminalManager's own shortcuts or quick-open overlay
                    try {
                        const overlay = document.getElementById('template-quick-open-modal');
                        const overlayOpen = !!(overlay && overlay.classList && overlay.classList.contains('show'));
                        if (this.modules && this.modules.terminal) return; // let KeyboardShortcuts handle it
                        if (overlayOpen) return; // don't intercept while quick-open is visible
                    } catch (_) { /* ignore */ }
                    try { e.preventDefault(); } catch (_) {}
                    try { e.stopPropagation(); } catch (_) {}
                    handleToggleClick();
                }, true);
            }
        } catch (_) { /* ignore */ }

        // Close sidebar when X button is clicked
        const closeButton = document.getElementById('mobile-sidebar-close');
        if (closeButton) {
            closeButton.addEventListener('click', () => {
                this.hideMobileSidebar();
            });
        }

        // Hide sidebar on escape key (but not while a modal is open)
        document.addEventListener('keydown', (e) => {
            if (isAnyModalOpen()) return;
            if (e.key === 'Escape' && sidebar.classList.contains('mobile-visible')) {
                this.hideMobileSidebar();
            }
        });

        // Setup desktop sidebar toggle
        const desktopToggleButton = document.getElementById('desktop-sidebar-toggle');
        if (desktopToggleButton) {
            desktopToggleButton.setAttribute('aria-controls', 'terminal-sidebar');
            // initial state based on visibility
            const isHidden = document.querySelector('.terminal-sidebar')?.classList.contains('sidebar-hidden');
            desktopToggleButton.setAttribute('aria-expanded', (!isHidden).toString());
            desktopToggleButton.addEventListener('click', () => {
                // Use the terminal manager's toggle function if available
                if (this.modules.terminal && this.modules.terminal.toggleSidebar) {
                    this.modules.terminal.toggleSidebar();
                }
                // Update aria-expanded after a tick to reflect class changes
                setTimeout(() => {
                    const hidden = document.querySelector('.terminal-sidebar')?.classList.contains('sidebar-hidden');
                    desktopToggleButton.setAttribute('aria-expanded', (!hidden).toString());
                }, 0);
            });
        }
    }

    showMobileSidebar() {
        const sidebar = document.querySelector('.terminal-sidebar');
        
        sidebar.classList.add('mobile-visible');
        document.body.classList.add('mobile-sidebar-open');
    }

    hideMobileSidebar() {
        const sidebar = document.querySelector('.terminal-sidebar');
        
        sidebar.classList.remove('mobile-visible');
        document.body.classList.remove('mobile-sidebar-open');
    }

    async handleSessionIdParameter() {
        // If this renderer is a dedicated secondary window and it was just
        // reloaded by the desktop app after a backend restart, skip restoring
        // the targeted session (and its history). Show a blank window instead.
        try {
            if (this.isDedicatedWindow) {
                const postRestart = window.sessionStorage && window.sessionStorage.getItem('tm_post_restart_reload');
                if (postRestart === '1') {
                    try { window.sessionStorage.removeItem('tm_post_restart_reload'); } catch (_) {}
                    console.log('[App URL Parameter] Skipping session restoration after restart in dedicated window');
                    // Ensure terminal manager treats URL as processed so it won’t auto-select another session
                    try { if (this.modules.terminal) this.modules.terminal.sessionIdParameterProcessed = true; } catch (_) {}
                    return false;
                }
            }
        } catch (_) { /* ignore */ }

        // Parse URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        const sessionId = urlParams.get('session_id');
        
        // Only handle sessions from URL parameters, no localStorage auto-selection
        if (!sessionId) {
            return false;
        }

        // Special handling for Electron main window and local sessions
        // If a local session id is present but not known locally, avoid WS/API attach and route safely
        try {
            const isElectron = !!(window.desktop && window.desktop.isElectron);
            if (isElectron && !this.isDedicatedWindow && sessionId) {
                const api = window.desktop.localpty;
                if (api && typeof api.list === 'function') {
                    const result = await api.list();
                    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
                    const hasLocal = sessions.some(s => String(s.sessionId || s.session_id || '') === String(sessionId));
                    if (hasLocal) {
                        // Local session exists: ensure terminal tab and select without hitting API/WS
                        if (this.modules.terminal) {
                            this.modules.terminal.sessionIdParameterProcessed = true;
                            await this.modules.terminal.switchToTabAsync('active');
                            // select/activate will attach via LocalPTYClient when applicable
                            if (typeof this.modules.terminal.activateSession === 'function') {
                                await this.modules.terminal.activateSession(sessionId, { restored: true });
                            } else {
                                await this.modules.terminal.selectSession(sessionId, { restored: true });
                            }
                            try { window.__DEFER_SESSION_SELECTION__ = false; } catch (_) {}
                        }
                        // Keep URL param per current behavior
                        return true;
                    } else {
                        // Local session not present after reload: treat as terminated local session
                        if (this.modules.terminal && typeof this.modules.terminal.loadSessionHistory === 'function') {
                            await this.modules.terminal.loadSessionHistory(sessionId);
                            try { window.__DEFER_SESSION_SELECTION__ = false; } catch (_) {}
                            return true;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[App URL Parameter] Electron/local pre-check failed:', e);
        }

        // Check if the session exists in our system
        try {
            // First get basic session info without history to check load_history flag
            const basicSessionData = await apiService.getSession(sessionId);
            if (!basicSessionData) {
                throw new Error('Session not found');
            }
            
            console.log(`[App URL Parameter] Session ${sessionId}:`, {
                is_active: basicSessionData.is_active,
                load_history: basicSessionData.load_history
            });
            
            // For Issue #349: Only fetch history for terminated sessions to avoid unnecessary API calls
            let sessionData = basicSessionData;
            const shouldFetchHistory = !basicSessionData.is_active;
            
            if (shouldFetchHistory) {
                console.log(`[App URL Parameter] Fetching history for terminated session ${sessionId}`);
                sessionData = await apiService.getSessionHistory(sessionId);
            } else {
                console.log(`[App URL Parameter] SKIPPING history fetch for active session ${sessionId} - Issue #349`);
            }
            
            if (sessionData) {
                // Session exists from URL parameter, set correct tab and select it after terminal manager is initialized
                if (this.modules.terminal) {
                    // Mark that a session_id was processed to prevent auto-selection (whether from URL or localStorage)
                    this.modules.terminal.sessionIdParameterProcessed = true;
                    
                    // Set the correct tab based on session status and await completion
                    const targetTab = sessionData.is_active ? 'active' : 'inactive';
                    await this.modules.terminal.switchToTabAsync(targetTab);
                    
                    // Select the session after tab switch is complete
                    if (sessionData.is_active === false && typeof this.modules.terminal.loadSessionHistory === 'function') {
                        // Inactive/terminated: load history view directly (works in ui=window too)
                        await this.modules.terminal.loadSessionHistory(sessionId);
                    } else {
                        if (typeof this.modules.terminal.activateSession === 'function') {
                            await this.modules.terminal.activateSession(sessionId);
                        } else {
                            await this.modules.terminal.selectSession(sessionId);
                        }
                    }

                    // Clear any global deferral now that we have switched to the target session
                    try { window.__DEFER_SESSION_SELECTION__ = false; } catch (_) {}

                    // Ensure terminal header controls and links are visible for the selected session
                    // Some CSS defaults hide these on first paint; explicitly show and populate now.
                    try {
                        this.modules.terminal?.viewController?.showTerminalControls(sessionData);
                        this.modules.terminal?.updateSessionLinks?.(sessionData);
                    } catch (_) { /* ignore */ }
                    
                    // Skip showing mobile sidebar if on mobile and we loaded a session
                    if (window.matchMedia('(max-width: 768px)').matches) {
                        this.skipMobileSidebar = true;
                    }
                }
                
                // Clean up URL after successful session loading
                this.cleanUpSessionIdFromURL();
                return true;
            } else {
                // Session not found
                this.showSessionNotFoundModal(sessionId);
                this.cleanUpSessionIdFromURL();
                return false;
            }
        } catch (error) {
            console.error('Error loading session from URL (will try history):', error);
            // If fetching active session failed, try to load history directly (inactive case)
            try {
                if (this.modules.terminal && typeof this.modules.terminal.loadSessionHistory === 'function') {
                    await this.modules.terminal.loadSessionHistory(sessionId);
                    try { window.__DEFER_SESSION_SELECTION__ = false; } catch (_) {}
                    // Do not strip URL; keep params per new behavior
                    return true;
                }
            } catch (err2) {
                console.error('Fallback history load failed:', err2);
            }
            try { window.__DEFER_SESSION_SELECTION__ = false; } catch (_) {}
            this.showSessionLoadErrorModal(sessionId);
            this.cleanUpSessionIdFromURL();
            return false;
        }
    }

    cleanUpSessionIdFromURL() {
        // Preserve the session_id parameter across all environments so hard
        // reloads and copy/paste of the URL keep targeting the same session.
        // (Legacy behavior stripped it on web; we now keep it consistently.)
        try { return; } catch (_) {}
        // Remove session_id parameter from URL without reloading the page
        const url = new URL(window.location);
        url.searchParams.delete('session_id');
        
        // Use replaceState to update URL without adding to browser history
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }

    updateConnectionStatus(text, isConnected) {
        const statusElement = document.getElementById('connection-status');
        const statusIndicator = statusElement.querySelector('.status-indicator');

        if (isConnected) {
            statusIndicator.classList.add('connected');
            statusIndicator.classList.remove('disconnected');
        } else {
            statusIndicator.classList.add('disconnected');
            statusIndicator.classList.remove('connected');
        }

        // Expose status text for accessibility and quick hover-preview
        if (statusElement) {
            if (typeof text === 'string' && text.length) {
                statusElement.setAttribute('title', text);
                statusElement.setAttribute('aria-label', `Connection status: ${text}`);
                const sr = document.getElementById('connection-status-text');
                if (sr) sr.textContent = text;
            } else {
                statusElement.removeAttribute('title');
                statusElement.setAttribute('aria-label', 'Connection status');
                const sr = document.getElementById('connection-status-text');
                if (sr) sr.textContent = '';
            }
        }
    }

    updateConnectionStatusFromWebSocket() {
        // Check current WebSocket connection state and update display accordingly
        const state = websocketService.getState();
        if (state === 'connected') {
            this.updateConnectionStatus('Connected', true);
        } else {
            this.updateConnectionStatus('Disconnected', false);
        }
    }

    startStatusMonitoring() {
        // Periodically check connection status to ensure display stays accurate
        setInterval(() => {
            this.updateConnectionStatusFromWebSocket();
        }, 5000); // Check every 5 seconds
        // Also handle any one-time profile switch toast that was queued before reload
        try {
            this.showProfileSwitchToastIfNeeded();
        } catch (_) { /* non-fatal */ }
    }

    showProfileSwitchToastIfNeeded() {
        let raw = null;
        try {
            raw = window.sessionStorage.getItem('ts_profile_switch_toast');
        } catch (_) {
            raw = null;
        }
        if (!raw) return;
        try {
            window.sessionStorage.removeItem('ts_profile_switch_toast');
        } catch (_) { /* ignore */ }
        let data;
        try {
            data = JSON.parse(raw);
        } catch (_) {
            return;
        }
        if (!data || typeof data !== 'object') return;
        const label = (data.label && String(data.label).trim()) || '';
        const username = (data.username && String(data.username).trim()) || '';
        const apiUrl = (data.apiUrl && String(data.apiUrl).trim()) || '';
        const message = (() => {
            if (label) return `Active profile: ${label}`;
            if (username && apiUrl) return `Active profile: ${username}@${apiUrl}`;
            if (username) return `Active profile: ${username}`;
            if (apiUrl) return `Active profile: ${apiUrl}`;
            return '';
        })();
        if (!message) return;
        try {
            notificationDisplay.show(
                {
                    title: 'Profile switched',
                    message,
                    notification_type: 'info'
                },
                {
                    duration: 3500,
                    recordInCenter: false
                }
            );
        } catch (_) { /* non-fatal */ }
    }

    showSessionNotFoundModal(sessionId) {
        this.showErrorModal(
            'Session Not Found',
            `The session "${sessionId.substring(0, 8)}" could not be found. It may have been deleted or the URL is incorrect.`
        );
    }

    showSessionLoadErrorModal(sessionId) {
        this.showErrorModal(
            'Error Loading Session',
            `Failed to load session "${sessionId.substring(0, 8)}". Please check your connection and try again.`
        );
    }

    showErrorModal(title, message) {
        // Create modal if it doesn't exist
        let errorModal = document.getElementById('error-modal');
        if (!errorModal) {
            errorModal = document.createElement('div');
            errorModal.id = 'error-modal';
            errorModal.className = 'modal';
            errorModal.setAttribute('role', 'dialog');
            errorModal.setAttribute('aria-modal', 'true');
            errorModal.setAttribute('aria-labelledby', 'error-modal-title');
            errorModal.setAttribute('aria-describedby', 'error-modal-message');
            errorModal.setAttribute('tabindex', '-1');
            errorModal.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">
                        <h2 id="error-modal-title">Error</h2>
                        <button id="error-modal-close" class="modal-close">&times;</button>
                    </div>
                    <div class="modal-body">
                        <p id="error-modal-message">An error occurred.</p>
                    </div>
                    <div class="modal-footer">
                        <button id="error-modal-ok" class="btn btn-primary">OK</button>
                    </div>
                </div>
            `;
            document.body.appendChild(errorModal);
            
            // Add event listeners
            document.getElementById('error-modal-close').addEventListener('click', () => {
                this.hideErrorModal();
            });
            document.getElementById('error-modal-ok').addEventListener('click', () => {
                this.hideErrorModal();
            });
            
            // Handle keyboard events on the modal itself (not globally)
            errorModal.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' || event.key === 'Enter') {
                    event.preventDefault();
                    this.hideErrorModal();
                } else if (event.key === 'Tab') {
                    // Trap focus within the error modal
                    const focusable = errorModal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
                    if (!focusable || focusable.length === 0) return;
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (event.shiftKey) {
                        if (document.activeElement === first) {
                            event.preventDefault();
                            last.focus();
                        }
                    } else {
                        if (document.activeElement === last) {
                            event.preventDefault();
                            first.focus();
                        }
                    }
                }
            });
        }
        
        // Set content and show
        document.getElementById('error-modal-title').textContent = title;
        document.getElementById('error-modal-message').textContent = message;
        errorModal.classList.add('show');
        
        // Focus the modal for keyboard interaction
        setTimeout(() => {
            const okBtn = document.getElementById('error-modal-ok');
            if (okBtn && okBtn.focus) {
                okBtn.focus();
            } else {
                errorModal.focus();
            }
        }, 100);
    }

    hideErrorModal() {
        const errorModal = document.getElementById('error-modal');
        if (errorModal) {
            errorModal.classList.remove('show');
        }
    }

    async loadSystemInfo() {
        // Get authentication credentials from settings
        const state = appStore.getState();
        const username = state.auth?.username || state.preferences?.auth?.username;
        
        // Fetch server info to determine auth requirements and get system info
        let authRequired = false;
        let serverInfo = null;
        let authError = null;

        try {
            this.updateConnectionStatus('Checking server...', false);
            serverInfo = await apiService.getInfo();
            authRequired = Boolean(serverInfo && serverInfo.auth_enabled === true);
            if (authRequired && username) {
                console.log(`[App] API reachable with session cookie; auth_enabled=${authRequired}`);
            }
        } catch (error) {
            if (error.status === 401) {
                authRequired = true;
                console.warn('[App] Server requires authentication but no valid session is present');
                this.updateConnectionStatus('Authentication required - please sign in', false);
                authError = {
                    type: 'auth_required',
                    message: 'Server requires authentication. Please sign in.'
                };
            } else {
                console.error('[App] Failed to connect to server:', error);
                this.updateConnectionStatus(`Connection failed: ${error.message}`, false);
                authError = {
                    type: 'connection_failed',
                    message: `Unable to connect to server: ${error.message}`
                };
            }
        }
        
        // Allow cookie-based persistence (desktop/web). Do not auto-logout if cookie exists.
        
        // Store server info in appStore for use by other modules
        if (serverInfo) {
            appStore.setState({ systemInfo: serverInfo });
            
            // Display version info
            const environment = window.TERMINAL_MANAGER_ENVIRONMENT;
            if (serverInfo.version || environment) {
                this.displayVersion(serverInfo.version, environment);
            }
        }
        
        return { 
            success: !authError && serverInfo, 
            serverInfo, 
            authRequired, 
            authError 
        };
    }

    displayVersion(version, environment) {
        // Prefer Electron-embedded app version when running inside the desktop app,
        // regardless of how the UI is loaded (file://, localhost, or remote FRONTEND_URL).
        // Do not rely on config-provided version in desktop contexts.
        let frontendVersion = null;
        let frontendBuild = null;
        let frontendCommit = null;

        try {
            if (window && window.desktop && window.desktop.isElectron && typeof window.desktop.appVersion === 'string') {
                const embedded = window.desktop.appVersion.trim();
                if (embedded) frontendVersion = embedded;
            }
        } catch (_) { frontendVersion = null; }

        // In pure web (non-desktop) contexts, read from version.js if present; never use config for version.
        if (!frontendVersion) {
            try {
                if (!window.desktop || !window.desktop.isElectron) {
                    const vjs = (window && typeof window.TS_FRONTEND_VERSION === 'string') ? window.TS_FRONTEND_VERSION.trim() : '';
                    if (vjs) frontendVersion = vjs;
                }
            } catch (_) { /* ignore */ }
        }

        // Read build and commit info from globals (set by version.js)
        try {
            if (typeof window.TS_FRONTEND_BUILD === 'number') {
                frontendBuild = window.TS_FRONTEND_BUILD;
            }
            if (typeof window.TS_FRONTEND_COMMIT === 'string') {
                frontendCommit = window.TS_FRONTEND_COMMIT;
            }
        } catch (_) { /* ignore */ }

        // Fallback to server-provided build info if available
        try {
            const systemInfo = window.appStore?.getState()?.systemInfo;
            if (systemInfo) {
                if (frontendBuild === null && typeof systemInfo.build === 'number') {
                    frontendBuild = systemInfo.build;
                }
                if (!frontendCommit && typeof systemInfo.commit === 'string') {
                    frontendCommit = systemInfo.commit;
                }
            }
        } catch (_) { /* ignore */ }

        const effectiveVersion = (frontendVersion && frontendVersion.length > 0) ? frontendVersion : (version || '');

        // Build tooltip text with build number and commit
        let tooltipText = '';
        if (frontendBuild !== null) {
            tooltipText = `Build ${frontendBuild}`;
            if (frontendCommit) {
                tooltipText += ` (${frontendCommit})`;
            }
        }

        // Populate user menu version block as a badge; hide environment badge placeholder
        const userVersion = document.getElementById('user-menu-version-text');
        const userEnv = document.getElementById('user-menu-environment-text');
        if (userEnv) {
            try { userEnv.style.display = 'none'; } catch (_) {}
        }
        if (userVersion && effectiveVersion) {
            try { userVersion.classList.remove('version-text'); } catch (_) {}
            try { userVersion.classList.remove('environment-text'); } catch (_) {}
            try { userVersion.classList.add('version-badge'); } catch (_) {}
            userVersion.textContent = `v${effectiveVersion}`;
            if (tooltipText) {
                userVersion.title = tooltipText;
            }
        }

        // Do not change document title based on environment anymore
    }

  initializeIcons() {
    // Declarative icon map for single targets
    const singleIconMap = [
            { id: 'settings-icon', name: 'settings', size: 16 },
            { id: 'auth-settings-icon', name: 'settings', size: 16 },
            { id: 'auth-hash-copy-icon', name: 'copy', size: 16 },
            { id: 'user-menu-settings-icon', name: 'settings', size: 16 },
            { id: 'global-links-icon', name: 'link', size: 18 },
            { id: 'session-links-icon', name: 'link', size: 18 },
            { id: 'session-transitions-icon', name: 'arrow-down-square', size: 18 },
            { id: 'terminal-search-icon', name: 'search', size: 16 },
            { id: 'prompts-queue-icon', name: 'clock-history', size: 16 },
            { id: 'text-input-icon', name: 'message-square', size: 16 },
            { id: 'debug-icon', name: 'search', size: 16 },
            { id: 'floating-modal-icon', name: 'message-square', size: 16 },
            { id: 'mobile-keyboard-toggle-icon', name: 'keyboard', size: 16 },
            { id: 'window-fullscreen-toggle-icon', name: 'fullscreen', size: 16 },
            { id: 'mobile-keyboard-icon', name: 'keyboard', size: 16 },
            { id: 'mobile-scroll-forward-icon', name: 'mouse', size: 16 },
            { id: 'pinned-filter-icon', name: 'pin-off', size: 14 },
            { id: 'active-filter-icon', name: 'eye', size: 14 },
            { id: 'terminal-nav-icon', name: 'terminal', size: 16 },
            { id: 'history-nav-icon', name: 'card-list', size: 16 },
            { id: 'containers-nav-icon', name: 'box', size: 16 },
            { id: 'refresh-icon', name: 'arrow-refresh', size: 16 },
            { id: 'containers-refresh-icon', name: 'arrow-refresh', size: 16 },
            { id: 'empty-icon', name: 'folder2', size: 48 },
            { id: 'first-page-icon', name: 'chevron-double-left', size: 14 },
            { id: 'prev-page-icon', name: 'chevron-left', size: 14 },
            { id: 'next-page-icon', name: 'chevron-right', size: 14 },
            { id: 'last-page-icon', name: 'chevron-double-right', size: 14 },
        ];

        singleIconMap.forEach(({ id, name, size }) => {
            const el = document.getElementById(id);
            if (el) {
                // Skip if an icon already exists (avoid double insert if early bootstrap ran)
                const hasIcon = !!(el.querySelector('svg') || el.querySelector('.bi-icon'));
                if (!hasIcon) {
                    el.appendChild(iconUtils.createIcon(name, { size }));
                    try { if (id === 'session-transitions-icon') console.log('[Icons] inserted session-transitions-icon'); } catch(_) {}
                }
            }
        });

        // Batch targets with the same icon for many elements
        const batchIconMap = [
            { selector: '.page-up-icon', name: 'chevron-up', size: 12 },
            { selector: '.page-down-icon', name: 'chevron-down', size: 12 },
        ];

        batchIconMap.forEach(({ selector, name, size }) => {
            document.querySelectorAll(selector).forEach(el => {
                const hasIcon = !!(el.querySelector('svg') || el.querySelector('.bi-icon'));
                if (!hasIcon) {
                    el.appendChild(iconUtils.createIcon(name, { size }));
                }
            });
        });
    }
}

// Initialize application when DOM is ready
document.addEventListener('DOMContentLoaded', () => { new Application(); });
