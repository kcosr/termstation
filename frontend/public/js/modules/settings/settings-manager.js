/**
 * Settings Manager - Handle user preferences with localStorage persistence
 */

import { appStore } from '../../core/store.js';
import { getSettingsStore } from '../../core/settings-store/index.js';
import { keyOverlay } from '../../utils/key-overlay.js';
import { getContext } from '../../core/context.js';
import { audioManager } from '../../utils/audio.js';
import { notificationDisplay } from '../../utils/notification-display.js';
import { fontDetector } from '../../utils/font-detector.js';
import { config } from '../../core/config.js';
import { keyboardShortcuts } from '../shortcuts/shortcuts-modal.js';
import { getEffectiveTheme, onSystemThemeChange } from '../../utils/theme-utils.js';
import { uiFonts } from '../../utils/ui-fonts.js';
import { apiService } from '../../services/api.service.js';
import { ConfirmationModal } from '../ui/modal.js';
import {
    applyProfileThemeOverride,
    computeThemePersistence,
    getEffectiveThemeFromSettings,
    getThemeStateFromSettings
} from './theme-persistence.js';

export class SettingsManager {
    constructor() {
        this.modal = null;
        this.elements = {};
        this.initialized = false;
        this._removeSystemThemeListener = null;
        this._lastAppliedTheme = document.documentElement.getAttribute('data-theme') || null;
        this._unsubscribeLinksPrefs = null;
        this.defaultSessionTabMaxWidth = 200;
        this.minSessionTabMaxWidth = 100;
        this.maxSessionTabMaxWidth = 800;
        // Lazy font scan state (desktop)
        this._fontsLoaded = false;
        this._fontsLoading = false;
        // Theme/profile override state
        this._initialTheme = this._lastAppliedTheme;
        this._initialThemeScopeIsProfile = false;
        this._activeProfileId = '';
        this._savedGlobalTheme = null;
        this._savedProfileTheme = null;
        this._themeSaved = false;
        
        // Settings storage key
        this.storageKey = 'terminal_manager_settings';
        
        // Load saved settings on initialization
        this.bootstrapSettingsSync();
        this.loadSettings();

        // Apply session tab width preference on boot and react to subsequent updates
        try {
            const initialWidth = this.normalizeSessionTabMaxWidth(
                appStore.getState('preferences.links.sessionTabMaxWidth')
            );
            this.applySessionTabMaxWidth(initialWidth);
        } catch (_) {
            this.applySessionTabMaxWidth(this.defaultSessionTabMaxWidth);
        }

        try {
            this._unsubscribeLinksPrefs = appStore.subscribe('preferences.links', (newPrefs = {}) => {
                const width = this.normalizeSessionTabMaxWidth(newPrefs.sessionTabMaxWidth);
                this.applySessionTabMaxWidth(width);
                this.updateSessionTabMaxWidthValue(width);
            });
        } catch (_) {}

        // (removed debug theme observer)
    }

    // Coerce persisted values that may be stored as strings into booleans.
    // Defaults to true when value is absent/unknown, unless explicitly false-like.
    coerceBoolDefaultTrue(value) {
        try {
            if (value === true || value === false) return !!value;
            if (value == null) return true; // default ON
            if (typeof value === 'string') {
                const v = value.trim().toLowerCase();
                if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
                if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
            }
            // Fallback to previous semantics: everything except strict false is treated as enabled
            return value !== false;
        } catch (_) {
            return value !== false;
        }
    }

    // Coerce to boolean with default OFF
    // Treat common truthy string values as true; otherwise false.
    coerceBoolDefaultFalse(value) {
        try {
            if (value === true || value === false) return !!value;
            if (value == null) return false; // default OFF
            if (typeof value === 'string') {
                const v = value.trim().toLowerCase();
                if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
                if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
            }
            return value === true; // only explicit true
        } catch (_) {
            return false;
        }
    }

    // Apply small forward-only migrations to user settings
    applyMigrations(settings) {
        try {
            if (!settings || typeof settings !== 'object') return settings;
            const migrated = { ...settings };
            // 1) Force https for saved pc/termstation-api custom URL
            try {
                const cu = migrated?.api?.customUrl;
                if (typeof cu === 'string' && /^(?:http:\/\/pc\/termstation-api\/?)/i.test(cu.trim())) {
                    const clean = cu.trim().replace(/\/?$/, '');
                    const next = clean.replace(/^http:/i, 'https:');
                    migrated.api = { ...(migrated.api || {}), customUrl: next };
                }
            } catch (_) {}
            // 2) Update saved auth profiles apiUrl values to https for pc/termstation-api
            try {
                const profiles = migrated?.authProfiles?.items;
                if (Array.isArray(profiles) && profiles.length) {
                    migrated.authProfiles = { ...(migrated.authProfiles || {}), items: profiles.map((p) => {
                        try {
                            if (p && typeof p.apiUrl === 'string' && /^(?:http:\/\/pc\/termstation-api\/?)/i.test(p.apiUrl.trim())) {
                                const clean = p.apiUrl.trim().replace(/\/?$/, '');
                                const next = clean.replace(/^http:/i, 'https:');
                                return { ...p, apiUrl: next };
                            }
                        } catch (_) {}
                        return p;
                    }) };
                }
            } catch (_) {}
            return migrated;
        } catch (_) {
            return settings;
        }
    }

    /**
     * Initialize the settings manager
     */
    init() {
        if (this.initialized) return;
        
        this.modal = document.getElementById('settings-modal');
        this.initializeElements();
        this.populateFontOptions();
        this.populateUiFontOptions();
        this.setupEventListeners();
        this.updateUIFromStore();
        // Fetch feature flags to toggle gated controls (e.g., Reset Token)
        this.refreshFeatureFlags().catch(() => {/* non-fatal */});
        // Initialize sidebar navigation inside settings modal
        try {
            this.initSidebarNav();
        } catch (e) {
            console.warn('[Settings] Failed to initialize sidebar nav:', e);
        }
        // Initialize desktop window effects
        // If a saved opacity exists, apply it to the desktop window on startup.
        // Otherwise, reflect current runtime effects into the slider as a baseline.
        try {
            const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
            const savedOpacity = (() => {
                try { return appStore.getState('preferences')?.desktop?.effects?.windowOpacity; } catch { return undefined; }
            })();
            if (isElectron && typeof savedOpacity === 'number' && !Number.isNaN(savedOpacity)) {
                // Apply saved effect to the actual window
                window.desktop?.setWindowEffects?.({ opacity: Math.max(0.2, Math.min(1, Number(savedOpacity))) }).catch(() => {});
            } else if (isElectron && window.desktop?.getWindowEffects) {
                // No saved value; sync slider from current runtime window effects
                window.desktop.getWindowEffects()
                    .then((eff) => {
                        if (!eff) return;
                        const pct = Math.round(Math.max(0.2, Math.min(1, Number(eff.opacity) || 1)) * 100);
                        if (this.elements.windowOpacity) {
                            this.elements.windowOpacity.value = pct;
                            if (this.elements.windowOpacityValue) this.elements.windowOpacityValue.textContent = `${pct}%`;
                        }
                    })
                    .catch(() => {});
            }
        } catch (_) {}
        // Apply theme from store on init
        try {
            const stateTheme = (() => {
                try { return appStore.getState('ui')?.theme; } catch (_) { return null; }
            })();
            const theme = this._lastAppliedTheme || stateTheme || 'auto';
            this.applyTheme(theme);
        } catch (e) {
            console.warn('[Settings] Failed to apply theme at init:', e);
        }
        
        this.initialized = true;
    }

    /**
     * Initialize sidebar navigation for settings sections
     */
    initSidebarNav() {
        if (!this.modal) return;
        const navButtons = this.modal.querySelectorAll('.settings-nav button[data-section]');
        const show = (section) => this.showSection(section);
        navButtons.forEach(btn => {
            btn.addEventListener('click', () => show(btn.dataset.section));
        });
        // Default section: place Theme near Terminal, but show Terminal by default
        this.showSection('terminal');
    }

    /**
     * Show a specific settings section by data-section
     */
    showSection(section) {
        if (!this.modal) return;
        const buttons = this.modal.querySelectorAll('.settings-nav button[data-section]');
        const panels = this.modal.querySelectorAll('.settings-panel[data-section]');
        buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.section === section));
        panels.forEach(panel => panel.classList.toggle('active', panel.dataset.section === section));
        // Trigger desktop font scan when opening Display tab
        if (section === 'display') {
            this.loadInstalledFontsOnce();
        }
        // Move focus into first focusable control of the panel for accessibility
        const panel = this.modal.querySelector(`.settings-panel[data-section="${section}"]`);
        if (panel) {
            const focusable = panel.querySelector('input, select, button, textarea');
            if (focusable && typeof focusable.focus === 'function') {
                setTimeout(() => focusable.focus(), 0);
            }
        }
    }

    /**
     * Initialize DOM element references
     */
    initializeElements() {
            this.elements = {
            // Modal controls
            openBtn: document.getElementById('settings-btn'),
            closeBtn: document.getElementById('settings-modal-close'),
            cancelBtn: document.getElementById('settings-cancel'),
            saveBtn: document.getElementById('settings-save'),
            keyboardShortcutsBtn: document.getElementById('keyboard-shortcuts-btn'),
            // Import/Export (browser) and reload (desktop)
            exportBtn: document.getElementById('export-settings-btn'),
            importBtn: document.getElementById('import-settings-btn'),
            importInput: document.getElementById('import-settings-input'),
            reloadFromDiskBtn: document.getElementById('reload-settings-btn'),
            // State import/export controls
            exportStateBtn: document.getElementById('export-state-btn'),
            importStateBtn: document.getElementById('import-state-btn'),
            importStateInput: document.getElementById('import-state-input'),
            reloadStateBtn: document.getElementById('reload-state-btn'),
            // Developer (desktop)
            openDevToolsBtn: document.getElementById('open-devtools-btn'),
            developerSection: document.getElementById('developer-settings-section'),
            resetTokenBtn: document.getElementById('reset-session-token-btn'),
            resetTokenGroup: document.getElementById('reset-session-token-group'),
            confirmAdminActionModal: document.getElementById('confirm-admin-action-modal'),
            confirmAdminActionConfirm: document.getElementById('confirm-admin-action-confirm'),
            reloadConfigBtn: document.getElementById('reload-config-btn'),
            reloadConfigGroup: document.getElementById('reload-config-group'),
            allowInsecureCerts: document.getElementById('allow-insecure-certs'),
            // Desktop window effects
            windowOpacity: document.getElementById('window-opacity'),
            windowOpacityValue: document.getElementById('window-opacity-value'),
            // window blur removed per requirements
            
            // Notification settings
            notificationsEnabled: document.getElementById('notifications-enabled'),
            notificationsSound: document.getElementById('notifications-sound'),
            notificationsScheduledInputShow: document.getElementById('notifications-scheduled-input-show'),
            notificationsPersistInteractive: document.getElementById('notifications-persist-interactive'),
            // Per-level notification settings
            notificationsInfoShow: document.getElementById('notifications-info-show'),
            notificationsInfoSound: document.getElementById('notifications-info-sound'),
            notificationsSuccessShow: document.getElementById('notifications-success-show'),
            notificationsSuccessSound: document.getElementById('notifications-success-sound'),
            notificationsWarningShow: document.getElementById('notifications-warning-show'),
            notificationsWarningSound: document.getElementById('notifications-warning-sound'),
            notificationsErrorShow: document.getElementById('notifications-error-show'),
            notificationsErrorSound: document.getElementById('notifications-error-sound'),
            testNotificationBtn: document.getElementById('test-notification-btn'),
            testNotificationLevel: document.getElementById('test-notification-level'),
            
            // Terminal settings
            terminalFontSize: document.getElementById('terminal-font-size'),
            fontSizeValue: document.getElementById('font-size-value'),
            terminalFontFamily: document.getElementById('terminal-font-family'),
            terminalCursorBlink: document.getElementById('terminal-cursor-blink'),
            terminalFilterOscColors: document.getElementById('terminal-filter-osc-colors'),
            terminalCollapseNakedRgb: document.getElementById('terminal-collapse-naked-rgb'),
            terminalAutoAttachOnSelect: document.getElementById('terminal-auto-attach-on-select'),
            dynamicTitleMode: document.getElementById('dynamic-title-mode'),

            // Links settings
            linksSearchRevealGroup: document.getElementById('links-search-reveal-group'),
            linksShowSessionToolbarMenu: document.getElementById('links-show-session-toolbar-menu'),
            linksShowSessionTabs: document.getElementById('links-show-session-tabs'),
            linksSessionTabMaxWidth: document.getElementById('links-session-tab-max-width'),
            linksSessionTabMaxWidthValue: document.getElementById('links-session-tab-max-width-value'),
            notesShowSessionTab: document.getElementById('notes-show-session-tab'),
            notesShowWorkspaceTab: document.getElementById('notes-show-workspace-tab'),

            // Display settings
            displayShowActivityIndicator: document.getElementById('display-show-activity-indicator'),
            displayCloseSendTextOnSubmit: document.getElementById('display-close-send-text-on-submit'),
            displayShowContainerShellsInSidebar: document.getElementById('display-show-container-shells-in-sidebar'),

            // Theme settings
            appTheme: document.getElementById('app-theme'),
            appThemeProfileOverride: document.getElementById('app-theme-profile-override'),
            // UI font settings
            appFontFamily: document.getElementById('app-font-family'),
            
            // Authentication settings handled via header user menu
            
            // Debug settings
            debugKeyOverlay: document.getElementById('debug-key-overlay'),
            debugWsLogs: document.getElementById('debug-ws-logs'),
            debugRegistryLogs: document.getElementById('debug-registry-logs'),
            // Additional categorized debug toggles
            debugApiLogs: document.getElementById('debug-api-logs'),
            debugStateStoreLogs: document.getElementById('debug-state-store-logs'),
            debugAppLogs: document.getElementById('debug-app-logs'),
            debugSettingsLogs: document.getElementById('debug-settings-logs'),
            debugSessionTabsLogs: document.getElementById('debug-session-tabs-logs'),
            debugSessionListLogs: document.getElementById('debug-session-list-logs'),
            debugTerminalLogs: document.getElementById('debug-terminal-logs'),
            debugTerminalSessionLogs: document.getElementById('debug-terminal-session-logs'),
            debugAnsiOscLogs: document.getElementById('debug-ansi-osc-logs'),
            debugTerminalManagerLogs: document.getElementById('debug-terminal-manager-logs'),
            debugTabManagerLogs: document.getElementById('debug-tab-manager-logs'),
            debugResponsiveToolbarLogs: document.getElementById('debug-responsive-toolbar-logs'),
            debugMobileViewportLogs: document.getElementById('debug-mobile-viewport-logs'),
            debugMobileDetectionLogs: document.getElementById('debug-mobile-detection-logs'),
            debugMobileTouchLogs: document.getElementById('debug-mobile-touch-logs'),
            debugNotesLogs: document.getElementById('debug-notes-logs'),
            debugConfigLogs: document.getElementById('debug-config-logs'),
            
            // API Configuration settings
            apiUrl: document.getElementById('api-url'),
            apiPrefix: document.getElementById('api-prefix')
        };
    }

    /**
     * Populate font family options based on available fonts
     */
    populateFontOptions() {
        if (!this.elements.terminalFontFamily) return;
        const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
        try {
            // Always start clean
            this.elements.terminalFontFamily.innerHTML = '';
            if (!isElectron) {
                // Web: show fallback terminal fonts immediately
                const availableFonts = fontDetector.getAvailableFonts();
                availableFonts.forEach(font => {
                    const option = document.createElement('option');
                    option.value = font.value;
                    option.textContent = font.name;
                    this.elements.terminalFontFamily.appendChild(option);
                });
                console.log(`[Settings] Populated ${availableFonts.length} web font options`);
            }
        } catch (error) {
            console.error('[Settings] Error populating font options:', error);
            // On error, for web still show fallbacks; on desktop, defer to scan
            if (!isElectron) {
                const fallbackFonts = [
                    { name: 'Courier New (Default)', value: '"Courier New", monospace' },
                    { name: 'System Monospace', value: 'monospace' }
                ];
                fallbackFonts.forEach(font => {
                    const option = document.createElement('option');
                    option.value = font.value;
                    option.textContent = font.name;
                    this.elements.terminalFontFamily.appendChild(option);
                });
            }
        }
    }

    /**
     * Populate application UI font family options
     */
    populateUiFontOptions() {
        if (!this.elements.appFontFamily) return;
        try {
            this.elements.appFontFamily.innerHTML = '';
            const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
            if (!isElectron) {
                // Web: show curated UI font stacks
                const fonts = uiFonts.getAvailable();
                fonts.forEach((f) => {
                    const opt = document.createElement('option');
                    opt.value = f.value;
                    opt.textContent = f.name;
                    this.elements.appFontFamily.appendChild(opt);
                });
            }
        } catch (e) {
            console.warn('[Settings] Failed to populate UI fonts:', e);
        }
    }

    /**
     * Desktop-only: enumerate installed fonts once and append to dropdowns.
     */
    async loadInstalledFontsOnce() {
        try {
            const isElectron = !!(window.desktop && window.desktop.isElectron);
            if (!isElectron) return;
            if (this._fontsLoaded || this._fontsLoading) return;
            this._fontsLoading = true;

            const res = await window.desktop?.fonts?.list?.();
            const names = (res && res.ok && Array.isArray(res.fonts)) ? res.fonts : [];
            const unique = Array.from(new Set(names.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim())));
            const noneFound = unique.length === 0;

            // Append to terminal font dropdown
            const termSel = this.elements.terminalFontFamily;
            if (termSel) {
                termSel.innerHTML = '';
                // Always place minimal basic fonts at the top on desktop
                const basicFonts = [
                    { name: 'Courier New (Default)', value: '"Courier New", monospace' },
                    { name: 'System Monospace', value: 'monospace' }
                ];
                basicFonts.forEach(font => {
                    const option = document.createElement('option');
                    option.value = font.value;
                    option.textContent = font.name;
                    termSel.appendChild(option);
                });

                if (!noneFound) {
                    const makeValue = (family) => `'${family.replace(/'/g, "\\'")}', monospace`;
                    const skipNames = new Set(['courier new', 'monospace']);
                    unique.forEach((family) => {
                        if (skipNames.has(String(family).trim().toLowerCase())) return;
                        const opt = document.createElement('option');
                        opt.value = makeValue(family);
                        opt.textContent = family;
                        termSel.appendChild(opt);
                    });
                    // Re-apply current preference or default to first option
                    try {
                        const state = appStore.getState();
                        const pref = state?.preferences?.terminal?.fontFamily;
                        if (pref && Array.from(termSel.options).some(o => o.value === pref)) {
                            termSel.value = pref;
                        } else if (termSel.options.length > 0) {
                            termSel.selectedIndex = 0;
                        }
                    } catch (_) {}
                }
            }

            // Append to application UI font dropdown
            const appSel = this.elements.appFontFamily;
            if (appSel) {
                appSel.innerHTML = '';
                // Always add minimal basic UI options first on desktop
                const pinned = [
                    { name: 'System UI (Default)', value: uiFonts.getDefault() },
                    { name: 'System Monospace', value: 'monospace' }
                ];
                pinned.forEach((f) => {
                    const opt = document.createElement('option');
                    opt.value = f.value;
                    opt.textContent = f.name;
                    appSel.appendChild(opt);
                });

                if (!noneFound) {
                    const makeUiValue = (family) => {
                        const escaped = family.replace(/'/g, "\\'");
                        return `'${escaped}', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif`;
                    };
                    const existingValues = new Set(Array.from(appSel.options).map(o => o.value));
                    unique.forEach((family) => {
                        const val = makeUiValue(family);
                        if (existingValues.has(val)) return; // skip duplicates
                        const opt = document.createElement('option');
                        opt.value = val;
                        opt.textContent = family;
                        appSel.appendChild(opt);
                    });
                    try {
                        const state = appStore.getState();
                        const pref = state?.preferences?.display?.appFontFamily;
                        if (pref && Array.from(appSel.options).some(o => o.value === pref)) {
                            appSel.value = pref;
                        } else if (appSel.options.length > 0) {
                            appSel.selectedIndex = 0;
                        }
                    } catch (_) {}
                } else {
                    // None found: fall back to curated UI stacks in addition to pinned
                    const fonts = uiFonts.getAvailable();
                    const existingValues = new Set(Array.from(appSel.options).map(o => o.value));
                    fonts.forEach((f) => {
                        if (existingValues.has(f.value)) return;
                        const opt = document.createElement('option');
                        opt.value = f.value;
                        opt.textContent = f.name;
                        appSel.appendChild(opt);
                    });
                }
            }

            this._fontsLoaded = true;
            this._fontsLoading = false;
            console.log(`[Settings] Appended ${unique.length} installed fonts`);
        } catch (e) {
            this._fontsLoading = false;
            console.warn('[Settings] Failed to enumerate installed fonts:', e);
        }
    }

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Modal controls
        this.elements.openBtn?.addEventListener('click', () => this.openModal());
        this.elements.closeBtn?.addEventListener('click', () => this.closeModal());
        this.elements.cancelBtn?.addEventListener('click', () => this.closeModal());
        this.elements.saveBtn?.addEventListener('click', () => this.saveSettings());
        
        // Test notification
        this.elements.testNotificationBtn?.addEventListener('click', () => this.testNotification());

        // Test authentication
        // Authentication test handled via user menu login

        // Open keyboard shortcuts tester
        this.elements.keyboardShortcutsBtn?.addEventListener('click', () => {
            try {
                keyboardShortcuts.openModal();
            } catch (e) {
                console.error('[Settings] Failed to open keyboard shortcuts modal:', e);
            }
        });

        // Developer: selectively hide desktop-only parts, keep section visible on web/mobile
        const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
        const isCapacitor = (() => { try { return !!window.Capacitor; } catch (_) { return false; } })();
        if (!isElectron && !isCapacitor) {
            // Hide Open DevTools and Allow Invalid Certs groups on web
            try {
                const devtoolsGrp = this.elements.openDevToolsBtn?.closest?.('.form-group');
                if (devtoolsGrp) devtoolsGrp.style.display = 'none';
            } catch (_) { /* no-op */ }
            try {
                const certsGrp = this.elements.allowInsecureCerts?.closest?.('.form-group');
                if (certsGrp) certsGrp.style.display = 'none';
            } catch (_) { /* no-op */ }
        }
        // On web/mobile, hide desktop-only invalid certs UI
        // Hide window opacity slider on web (desktop-only feature)
        if (!isElectron && this.elements.windowOpacity) {
            try {
                const grp = this.elements.windowOpacity.closest('.form-group');
                if (grp) grp.style.display = 'none';
                if (this.elements.windowOpacityValue) this.elements.windowOpacityValue.style.display = 'none';
            } catch (_) { /* no-op */ }
        }
        this.elements.openDevToolsBtn?.addEventListener('click', async () => {
            try {
                if (window.desktop && typeof window.desktop.openDevTools === 'function') {
                    await window.desktop.openDevTools();
                } else {
                    console.warn('[Settings] Desktop bridge not available; cannot open DevTools');
                }
            } catch (e) {
                console.error('[Settings] Failed to open DevTools via desktop bridge:', e);
            }
        });

        // Shared confirmation modal for admin actions (reset token / reload config)
        const adminModalEl = this.elements.confirmAdminActionModal;
        let adminConfirmModal = null;
        if (adminModalEl) {
            adminConfirmModal = new ConfirmationModal({
                element: adminModalEl,
                confirmText: 'Confirm',
                cancelText: 'Cancel'
            });
        }

        const showAdminConfirm = async ({ title, message, confirmText, destructive = false }) => {
            if (!adminConfirmModal) return false;
            try {
                const titleEl = adminModalEl.querySelector('[data-modal-title]');
                if (titleEl && title) titleEl.textContent = title;
            } catch (_) {}
            try {
                adminConfirmModal.setMessage(message);
            } catch (_) {}
            try {
                adminConfirmModal.confirmText = confirmText || 'Confirm';
                const confirmBtn = adminModalEl.querySelector('[data-modal-confirm]');
                if (confirmBtn) {
                    confirmBtn.textContent = confirmText || 'Confirm';
                    if (destructive) {
                        confirmBtn.classList.add('destructive');
                    } else {
                        confirmBtn.classList.remove('destructive');
                    }
                }
            } catch (_) {}

            return await new Promise((resolve) => {
                const onConfirm = () => {
                    adminConfirmModal.off('confirm', onConfirm);
                    adminConfirmModal.off('cancel', onCancel);
                    try { adminConfirmModal.hide(); } catch (_) {}
                    resolve(true);
                };
                const onCancel = () => {
                    adminConfirmModal.off('confirm', onConfirm);
                    adminConfirmModal.off('cancel', onCancel);
                    try { adminConfirmModal.hide(); } catch (_) {}
                    resolve(false);
                };
                adminConfirmModal.on('confirm', onConfirm);
                adminConfirmModal.on('cancel', onCancel);
                adminConfirmModal.show();
            });
        };

        // Feature-gated: Reset Session Token
        if (this.elements.resetTokenBtn) {
            this.elements.resetTokenBtn.addEventListener('click', async () => {
                try {
                    const ok = await showAdminConfirm({
                        title: 'Reset Session Token',
                        message: 'Rotate server session token? This will log out all clients.',
                        confirmText: 'Reset Token',
                        destructive: true
                    });
                    if (!ok) return;
                    await apiService.resetSessionToken();
                    notificationDisplay?.show?.({ notification_type: 'success', title: 'Token Reset', message: 'Server token rotated. A new session cookie was issued.', timestamp: new Date().toISOString() }, { duration: 5000 });
                } catch (e) {
                    const disabled = (e && (e.status === 403 || e.code === 'FEATURE_DISABLED'));
                    const msg = disabled ? 'Feature disabled by server' : 'Failed to reset token';
                    notificationDisplay?.show?.({ notification_type: 'error', title: 'Reset Failed', message: msg, timestamp: new Date().toISOString() }, { duration: 6000 });
                }
            });
        }

        // Feature-gated: Reload Server Config
        if (this.elements.reloadConfigBtn) {
            this.elements.reloadConfigBtn.addEventListener('click', async () => {
                try {
                    const ok = await showAdminConfirm({
                        title: 'Reload Server Config',
                        message: 'Reload server templates, users, groups, and links from disk?',
                        confirmText: 'Reload Config',
                        destructive: false
                    });
                    if (!ok) return;
                    const result = await apiService.reloadServerConfig();
                    let summaryParts = [];
                    try {
                        const tCount = Number(result?.templates?.count);
                        const uCount = Number(result?.users?.count);
                        const gCount = Number(result?.groups?.count);
                        const lGroups = Number(result?.links?.groups);
                        if (Number.isFinite(tCount)) summaryParts.push(`templates=${tCount}`);
                        if (Number.isFinite(uCount)) summaryParts.push(`users=${uCount}`);
                        if (Number.isFinite(gCount)) summaryParts.push(`groups=${gCount}`);
                        if (Number.isFinite(lGroups)) summaryParts.push(`link groups=${lGroups}`);
                    } catch (_) { /* non-fatal */ }
                    const msg = summaryParts.length > 0
                        ? `Config reload complete (${summaryParts.join(', ')}).`
                        : 'Config reload complete.';
                    notificationDisplay?.show?.({ notification_type: 'success', title: 'Config Reloaded', message: msg, timestamp: new Date().toISOString() }, { duration: 5000 });
                } catch (e) {
                    const disabled = (e && (e.status === 403 || e.code === 'FEATURE_DISABLED'));
                    const msg = disabled ? 'Feature disabled by server' : 'Failed to reload server config';
                    notificationDisplay?.show?.({ notification_type: 'error', title: 'Reload Failed', message: msg, timestamp: new Date().toISOString() }, { duration: 6000 });
                }
            });
        }

        // Import/Export handlers
        if (!isElectron) {
            this.elements.exportBtn?.addEventListener('click', () => this.exportSettingsToFile());
            this.elements.importBtn?.addEventListener('click', () => this.elements.importInput?.click());
            this.elements.importInput?.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) this.importSettingsFromFile(file);
                // reset input to allow re-selecting same file
                e.target.value = '';
            });
            if (this.elements.reloadFromDiskBtn) {
                // Hide desktop-only reload button in browser
                this.elements.reloadFromDiskBtn.style.display = 'none';
            }
            // State import/export (browser)
            this.elements.exportStateBtn?.addEventListener('click', () => this.exportStateToFile());
            this.elements.importStateBtn?.addEventListener('click', () => this.elements.importStateInput?.click());
            this.elements.importStateInput?.addEventListener('change', (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) this.importStateFromFile(file);
                e.target.value = '';
            });
            if (this.elements.reloadStateBtn) this.elements.reloadStateBtn.style.display = 'none';
        } else {
            // Desktop-only: reload settings from disk button
            this.elements.reloadFromDiskBtn?.addEventListener('click', () => this.reloadSettingsFromDisk());
            // Desktop import/export via native dialogs
            this.elements.exportBtn?.addEventListener('click', async () => {
                try {
                    const data = this.getCurrentSettings();
                    const res = await window.desktop?.settings?.export?.(data);
                    if (res && res.ok) {
                        notificationDisplay?.show?.({ notification_type: 'success', title: 'Exported', message: 'Settings exported successfully.', timestamp: new Date().toISOString() }, { duration: 4000 });
                    } else if (res && res.canceled) {
                        // no-op
                    } else {
                        notificationDisplay?.show?.({ notification_type: 'error', title: 'Export Failed', message: 'Could not export settings.', timestamp: new Date().toISOString() }, { duration: 6000 });
                    }
                } catch (e) {
                    notificationDisplay?.show?.({ notification_type: 'error', title: 'Export Failed', message: 'Unexpected error exporting settings.', timestamp: new Date().toISOString() }, { duration: 6000 });
                }
            });
            this.elements.importBtn?.addEventListener('click', async () => {
                try {
                    const res = await window.desktop?.settings?.import?.();
                    if (res && res.ok && res.settings) {
                        const s = res.settings;
                        if (s.preferences) appStore.setState({ preferences: s.preferences });
                        if (s.ui) this.mergeUiSettings(s.ui);
                        if (s.api) appStore.setState({ api: s.api });
                        this.updateUIFromStore();
                        notificationDisplay?.show?.({ notification_type: 'success', title: 'Imported', message: 'Settings imported successfully.', timestamp: new Date().toISOString() }, { duration: 4000 });
                    } else if (res && res.canceled) {
                        // no-op
                    } else {
                        const msg = res && res.error ? String(res.error) : 'Could not import settings.';
                        notificationDisplay?.show?.({ notification_type: 'error', title: 'Import Failed', message: msg, timestamp: new Date().toISOString() }, { duration: 6000 });
                    }
                } catch (e) {
                    notificationDisplay?.show?.({ notification_type: 'error', title: 'Import Failed', message: 'Unexpected error importing settings.', timestamp: new Date().toISOString() }, { duration: 6000 });
                }
            });
            // Desktop state import/export via native dialogs
            this.elements.reloadStateBtn?.addEventListener('click', () => this.reloadStateFromDisk());
            this.elements.exportStateBtn?.addEventListener('click', async () => {
                try {
                    const s = await getSettingsStore().load(); // get full current settings to merge with state? Not needed here
                    const st = await (await import('../../core/state-store/index.js')).getStateStore().load();
                    const res = await window.desktop?.state?.export?.(st || {});
                    if (res && res.ok) {
                        notificationDisplay?.show?.({ notification_type: 'success', title: 'State Exported', message: 'State exported successfully.', timestamp: new Date().toISOString() }, { duration: 4000 });
                    } else if (res && res.canceled) { /* no-op */ } else {
                        notificationDisplay?.show?.({ notification_type: 'error', title: 'Export Failed', message: 'Could not export state.', timestamp: new Date().toISOString() }, { duration: 6000 });
                    }
                } catch (e) {
                    notificationDisplay?.show?.({ notification_type: 'error', title: 'Export Failed', message: 'Unexpected error exporting state.', timestamp: new Date().toISOString() }, { duration: 6000 });
                }
            });
            this.elements.importStateBtn?.addEventListener('click', async () => {
                try {
                    const res = await window.desktop?.state?.import?.();
                    if (res && res.ok && res.state) {
                        const store = (await import('../../core/state-store/index.js')).getStateStore();
                        await store.save(res.state);
                        notificationDisplay?.show?.({ notification_type: 'success', title: 'State Imported', message: 'State imported successfully.', timestamp: new Date().toISOString() }, { duration: 4000 });
                    } else if (res && res.canceled) { /* no-op */ } else {
                        const msg = res && res.error ? String(res.error) : 'Could not import state';
                        notificationDisplay?.show?.({ notification_type: 'error', title: 'Import Failed', message: msg, timestamp: new Date().toISOString() }, { duration: 6000 });
                    }
                } catch (e) {
                    notificationDisplay?.show?.({ notification_type: 'error', title: 'Import Failed', message: 'Unexpected error importing state.', timestamp: new Date().toISOString() }, { duration: 6000 });
                }
            });
        }

        // Developer: Allow invalid certificates toggle
        if (this.elements.allowInsecureCerts) {
            // Initialize from desktop main (async)
            if (isElectron && window.desktop?.getAllowInvalidCerts) {
                window.desktop.getAllowInvalidCerts()
                    .then((enabled) => {
                        this.elements.allowInsecureCerts.checked = !!enabled;
                    })
                    .catch((e) => {
                        console.warn('[Settings] Failed to read allow-insecure-certs flag:', e);
                    });
            }
            this.elements.allowInsecureCerts.addEventListener('change', async (e) => {
                const enable = !!e.target.checked;
                try {
                    if (isElectron && window.desktop?.setAllowInvalidCerts) {
                        await window.desktop.setAllowInvalidCerts(enable);
                    } else {
                        console.warn('[Settings] Desktop bridge not available; cannot set allow-insecure-certs');
                    }
                } catch (err) {
                    console.error('[Settings] Failed setting allow-insecure-certs:', err);
                    // Rollback UI if failed
                    this.elements.allowInsecureCerts.checked = !enable;
                }
            });
        }

        // Desktop: Window effects (opacity/blur)
        if (this.elements.windowOpacity) {
            const onOpacityChange = (val) => {
                const pct = Math.max(50, Math.min(100, parseInt(val) || 100));
                if (this.elements.windowOpacityValue) this.elements.windowOpacityValue.textContent = `${pct}%`;
                // Apply immediately in Electron
                const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
                if (isElectron && window.desktop?.setWindowEffects) {
                    const normalized = pct / 100;
                    const blurPx = parseInt(this.elements.windowBlur?.value) || 0;
                    window.desktop.setWindowEffects({ opacity: normalized, blur: blurPx }).catch(() => {});
                    // Update in-memory state; persistence happens on Save
                    try {
                        appStore.setPath('preferences.desktop.effects.windowOpacity', normalized);
                    } catch (_) {}
                }
            };
            this.elements.windowOpacity.addEventListener('input', (e) => onOpacityChange(e.target.value));
        }
        // Blur removed
        
        // Font size slider - apply changes in real-time and persist immediately (desktop)
        this.elements.terminalFontSize?.addEventListener('input', (e) => {
            const fontSize = parseInt(e.target.value);
            this.elements.fontSizeValue.textContent = `${fontSize}px`;
            
            // Apply font size immediately to all terminals in this window
            this.applyFontSettings(fontSize, this.elements.terminalFontFamily?.value || fontDetector.getDefaultFont());
            // Update in-memory state; persistence happens on Save
            try {
                appStore.setPath('preferences.terminal.fontSize', fontSize);
            } catch (_) {}
            // Persist immediately so new windows inherit the change too
            try { this.saveSettingsToStorage(); } catch (_) {}
            // Broadcast to other windows via desktop bridge when available
            try {
                const famNow = this.elements.terminalFontFamily?.value || fontDetector.getDefaultFont();
                if (window.desktop?.applyFontSettingsAll) window.desktop.applyFontSettingsAll(fontSize, famNow);
            } catch (_) {}
        });
        
        // Font family selector - apply changes in real-time and persist immediately (desktop)
        this.elements.terminalFontFamily?.addEventListener('change', (e) => {
            const fontFamily = e.target.value;
            const fontSize = parseInt(this.elements.terminalFontSize?.value) || 14;
            
            // Apply font family immediately to all terminals in this window
            this.applyFontSettings(fontSize, fontFamily);
            // Update in-memory state; persistence happens on Save
            try {
                appStore.setPath('preferences.terminal.fontFamily', fontFamily);
            } catch (_) {}
            // Persist immediately so new windows inherit the change too
            try { this.saveSettingsToStorage(); } catch (_) {}
            // Broadcast to other windows via desktop bridge when available
            try { if (window.desktop?.applyFontSettingsAll) window.desktop.applyFontSettingsAll(fontSize, fontFamily); } catch (_) {}
        });
        // Terminal filters toggles - apply immediately
        this.elements.terminalFilterOscColors?.addEventListener('change', (e) => {
            appStore.setPath('preferences.terminal.filterOscColors', !!e.target.checked);
        });
        this.elements.terminalCollapseNakedRgb?.addEventListener('change', (e) => {
            appStore.setPath('preferences.terminal.collapseNakedRgbRuns', !!e.target.checked);
        });
        
        // Theme selector - preview changes immediately (persist on Save)
        this.elements.appTheme?.addEventListener('change', (e) => {
            const theme = e.target.value || 'auto';
            this.applyTheme(theme);
            try { appStore.setPath('ui.theme', theme); } catch (_) {}
            this._lastAppliedTheme = theme;
        });
        if (this.elements.appThemeProfileOverride) {
            this.elements.appThemeProfileOverride.addEventListener('change', () => {
                // No immediate persistence; scope is applied on Save.
                // Keep in-memory flag only; initial state is derived from persisted settings on openModal.
            });
        }
        // Application font family - apply immediately (persist on Save)
        this.elements.appFontFamily?.addEventListener('change', (e) => {
            const fontFamily = e.target.value || uiFonts.getDefault();
            this.applyAppFontFamily(fontFamily);
            try { appStore.setPath('preferences.display.appFontFamily', fontFamily); } catch (_) {}
        });
        
        // Key overlay checkbox - apply changes in real-time (persist on Save)
        this.elements.debugKeyOverlay?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            this.applyKeyOverlaySettings(enabled);
            try { appStore.setPath('preferences.debug.keyOverlay', enabled); } catch (_) {}
        });
        // WebSocket logs checkbox - apply changes immediately
        this.elements.debugWsLogs?.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            appStore.setPath('preferences.debug.websocketLogs', enabled);
        });
        // Registry logs checkbox - apply changes immediately
        this.elements.debugRegistryLogs?.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            appStore.setPath('preferences.debug.registryLogs', enabled);
        });
        // Scheduled/remote input toast visibility
        this.elements.notificationsScheduledInputShow?.addEventListener('change', (e) => {
            appStore.setPath('preferences.notifications.showScheduledInput', !!e.target.checked);
        });
        // Persist interactive notification toasts
        this.elements.notificationsPersistInteractive?.addEventListener('change', (e) => {
            appStore.setPath('preferences.notifications.persistInteractive', !!e.target.checked);
        });

        // Additional categorized logs - apply changes immediately
        this.elements.debugApiLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.apiLogs', !!e.target.checked);
        });
        this.elements.debugStateStoreLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.stateStoreLogs', !!e.target.checked);
        });
        this.elements.debugAppLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.appLogs', !!e.target.checked);
        });
        this.elements.debugSettingsLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.settingsLogs', !!e.target.checked);
        });
        this.elements.debugSessionTabsLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.sessionTabsLogs', !!e.target.checked);
        });
        this.elements.debugSessionListLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.sessionListLogs', !!e.target.checked);
        });
        this.elements.debugTerminalLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.terminalLogs', !!e.target.checked);
        });
        this.elements.debugTerminalSessionLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.terminalSessionLogs', !!e.target.checked);
        });
        // ANSI/OSC logs checkbox - apply changes immediately
        this.elements.debugAnsiOscLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.ansiOscLogs', !!e.target.checked);
        });
        this.elements.debugTerminalManagerLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.terminalManagerLogs', !!e.target.checked);
        });
        this.elements.debugTabManagerLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.tabManagerLogs', !!e.target.checked);
        });
        this.elements.debugResponsiveToolbarLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.responsiveToolbarLogs', !!e.target.checked);
        });
        this.elements.debugMobileViewportLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.mobileViewportLogs', !!e.target.checked);
        });
        this.elements.debugMobileDetectionLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.mobileDetectionLogs', !!e.target.checked);
        });
        this.elements.debugMobileTouchLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.mobileTouchLogs', !!e.target.checked);
        });
        this.elements.debugNotesLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.notesLogs', !!e.target.checked);
        });
        this.elements.debugConfigLogs?.addEventListener('change', (e) => {
            appStore.setPath('preferences.debug.configLogs', !!e.target.checked);
        });

        // Notification toggles - persist on Save
        this.elements.notificationsEnabled?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.notifications.enabled', enabled); } catch (_) {}
        });
        this.elements.notificationsSound?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.notifications.sound', enabled); } catch (_) {}
        });
        // Per-level toggles
        this.elements.notificationsInfoShow?.addEventListener('change', (e) => {
            try { appStore.setPath('preferences.notifications.levels.info.show', !!e.target.checked); } catch (_) {}
        });
        this.elements.notificationsInfoSound?.addEventListener('change', (e) => {
            try { appStore.setPath('preferences.notifications.levels.info.sound', !!e.target.checked); } catch (_) {}
        });
        this.elements.notificationsSuccessShow?.addEventListener('change', (e) => {
            try { appStore.setPath('preferences.notifications.levels.success.show', !!e.target.checked); } catch (_) {}
        });
        this.elements.notificationsSuccessSound?.addEventListener('change', (e) => {
            try { appStore.setPath('preferences.notifications.levels.success.sound', !!e.target.checked); } catch (_) {}
        });
        this.elements.notificationsWarningShow?.addEventListener('change', (e) => {
            try { appStore.setPath('preferences.notifications.levels.warning.show', !!e.target.checked); } catch (_) {}
        });
        this.elements.notificationsWarningSound?.addEventListener('change', (e) => {
            try { appStore.setPath('preferences.notifications.levels.warning.sound', !!e.target.checked); } catch (_) {}
        });
        this.elements.notificationsErrorShow?.addEventListener('change', (e) => {
            try { appStore.setPath('preferences.notifications.levels.error.show', !!e.target.checked); } catch (_) {}
        });
        this.elements.notificationsErrorSound?.addEventListener('change', (e) => {
            try { appStore.setPath('preferences.notifications.levels.error.sound', !!e.target.checked); } catch (_) {}
        });

        // Terminal toggles - persist on Save
        this.elements.terminalCursorBlink?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.terminal.cursorBlink', enabled); } catch (_) {}
        });
        this.elements.terminalAutoAttachOnSelect?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.terminal.autoAttachOnSelect', enabled); } catch (_) {}
        });
        this.elements.dynamicTitleMode?.addEventListener('change', (e) => {
            const mode = e.target.value || 'ifUnset';
            try { appStore.setPath('preferences.terminal.dynamicTitleMode', mode); } catch (_) {}
        });

        // Display settings - apply immediately
        this.elements.displayShowActivityIndicator?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.display.showActivityIndicator', enabled); } catch (_) {}
            // Trigger re-render of session lists to show/hide indicators
            try {
                const ctx = getContext();
                ctx?.app?.modules?.terminal?.sessionList?.render?.();
                ctx?.app?.modules?.workspaceList?.render?.();
            } catch (_) {}
        });
        // Display: close Send Text modal after submit
        this.elements.displayCloseSendTextOnSubmit?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.display.closeSendTextOnSubmit', enabled); } catch (_) {}
        });
        // Display: show/hide container shells under parents in sidebar
        this.elements.displayShowContainerShellsInSidebar?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.display.showContainerShellsInSidebar', enabled); } catch (_) {}
            try {
                const ctx = getContext();
                // Ask TerminalManager to refresh all parents so the sidebar reflects preference immediately
                ctx?.app?.modules?.terminal?.refreshSidebarChildrenForPreference?.();
            } catch (_) {}
        });

        // Links settings - apply immediately for responsiveness
        this.elements.linksSearchRevealGroup?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.links.searchRevealGroupLinks', enabled); } catch (_) {}
        });
        this.elements.linksShowSessionToolbarMenu?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.links.showSessionToolbarMenu', enabled); } catch (_) {}
        });
        this.elements.linksShowSessionTabs?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.links.showSessionTabs', enabled); } catch (_) {}
        });
        this.elements.linksSessionTabMaxWidth?.addEventListener('input', (e) => {
            const width = this.normalizeSessionTabMaxWidth(e.target?.value);
            this.updateSessionTabMaxWidthValue(width);
            this.applySessionTabMaxWidth(width);
            try { appStore.setPath('preferences.links.sessionTabMaxWidth', width); } catch (_) {}
        });

        this.elements.notesShowSessionTab?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.notes.showSessionTab', enabled); } catch (_) {}
        });
        this.elements.notesShowWorkspaceTab?.addEventListener('change', (e) => {
            const enabled = !!e.target.checked;
            try { appStore.setPath('preferences.notes.showWorkspaceTab', enabled); } catch (_) {}
        });

        // API fields - persist on Save (reload occurs after Save)
        if (this.elements.apiUrl) {
            try { this.elements.apiUrl.setAttribute('readonly', 'true'); } catch (_) {}
            try { this.elements.apiUrl.classList.add('readonly'); } catch (_) {}
        }
        if (this.elements.apiPrefix) {
            try { this.elements.apiPrefix.setAttribute('readonly', 'true'); } catch (_) {}
            try { this.elements.apiPrefix.classList.add('readonly'); } catch (_) {}
        }
        
        // Close modal on backdrop click
        this.modal?.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });
        
        // Handle keyboard shortcuts for modal
        document.addEventListener('keydown', (e) => {
            if (this.modal?.classList.contains('show')) {
                if (e.key === 'Escape') {
                    this.closeModal();
                } else if (e.key === 'Enter') {
                    // Prevent default form submission behavior
                    e.preventDefault();
                    e.stopPropagation();
                    // Save settings and close modal
                    this.saveSettings();
                } else if (e.key === 'Tab') {
                    // Trap focus inside modal
                    const focusable = this.modal?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
                    if (!focusable || focusable.length === 0) return;
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (e.shiftKey) {
                        if (document.activeElement === first) {
                            e.preventDefault();
                            last.focus();
                        }
                    } else {
                        if (document.activeElement === last) {
                            e.preventDefault();
                            first.focus();
                        }
                    }
                }
            }
        });
    }

    /**
     * Load settings from disk (desktop) or localStorage (browser) and apply to store
     */
    async loadSettings() {
        const store = getSettingsStore();
        const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
        try {
            let settings = await store.load();
            if (settings) {
                // Migrate if needed
                settings = this.applyMigrations(settings);
                if (settings.preferences) {
                    const linksPrefs = settings.preferences.links || {};
                    settings.preferences.links = {
                        searchRevealGroupLinks: this.coerceBoolDefaultTrue(linksPrefs.searchRevealGroupLinks),
                        showSessionToolbarMenu: this.coerceBoolDefaultFalse(linksPrefs.showSessionToolbarMenu),
                        showSessionTabs: this.coerceBoolDefaultTrue(linksPrefs.showSessionTabs),
                        sessionTabMaxWidth: this.normalizeSessionTabMaxWidth(linksPrefs.sessionTabMaxWidth)
                    };
                    const notesPrefs = settings.preferences.notes || {};
                    settings.preferences.notes = {
                        showSessionTab: this.coerceBoolDefaultTrue(notesPrefs.showSessionTab),
                        showWorkspaceTab: this.coerceBoolDefaultTrue(notesPrefs.showWorkspaceTab)
                    };
                }
                if (settings.preferences) {
                    // Merge into existing preferences to preserve defaults for new keys (e.g., display.showActivityIndicator)
                    try {
                        const existing = appStore.getState('preferences') || {};
                        const merged = { ...existing, ...settings.preferences };
                        // Ensure nested objects preserve existing defaults when missing in saved settings
                        if (settings.preferences.links) merged.links = settings.preferences.links;
                        if (settings.preferences.notes) merged.notes = settings.preferences.notes;
                        merged.display = { ...(existing.display || {}), ...(settings.preferences.display || {}) };
                        appStore.setState({ preferences: merged });
                    } catch (_) {
                        appStore.setState({ preferences: settings.preferences });
                    }
                }
                if (settings.ui) this.mergeUiSettings(settings.ui, { applyTheme: false });
                if (settings.api) appStore.setState({ api: settings.api });
                if (settings.auth) appStore.setState({ auth: this.sanitizeAuthSettings(settings.auth) });
                try {
                    const effectiveTheme = getEffectiveThemeFromSettings(settings);
                    if (effectiveTheme) {
                        this.applyTheme(effectiveTheme);
                        try { appStore.setPath('ui.theme', effectiveTheme); } catch (_) {}
                    }
                } catch (_) {}
                console.log('[Settings] Loaded settings from', isElectron ? 'disk' : 'localStorage');
                
                // Authentication credentials are handled via the header user menu/auth modal
            } else if (isElectron) {
                console.log('[Settings] No desktop settings file found; using defaults');
            }
        } catch (error) {
            console.error('[Settings] Error loading settings:', error);
        }
    }

    /**
     * Attempt to synchronously hydrate settings before async workflows run
     */
    bootstrapSettingsSync() {
        try {
            const store = getSettingsStore();
            const res = store.loadSync ? store.loadSync() : null;
            let settings = res && res.ok ? (res.settings || null) : null;
            if (!settings) return;
            // Migrate if needed
            settings = this.applyMigrations(settings);
            if (settings.preferences) {
                const linksPrefs = settings.preferences.links || {};
                settings.preferences.links = {
                    searchRevealGroupLinks: this.coerceBoolDefaultTrue(linksPrefs.searchRevealGroupLinks),
                    showSessionToolbarMenu: this.coerceBoolDefaultFalse(linksPrefs.showSessionToolbarMenu),
                    showSessionTabs: this.coerceBoolDefaultTrue(linksPrefs.showSessionTabs),
                    sessionTabMaxWidth: this.normalizeSessionTabMaxWidth(linksPrefs.sessionTabMaxWidth)
                };
                const notesPrefs = settings.preferences.notes || {};
                settings.preferences.notes = {
                    showSessionTab: this.coerceBoolDefaultTrue(notesPrefs.showSessionTab),
                    showWorkspaceTab: this.coerceBoolDefaultTrue(notesPrefs.showWorkspaceTab)
                };
            }
            if (settings.preferences) {
                try {
                    const existing = appStore.getState('preferences') || {};
                    const merged = { ...existing, ...settings.preferences };
                    if (settings.preferences.links) merged.links = settings.preferences.links;
                    if (settings.preferences.notes) merged.notes = settings.preferences.notes;
                    merged.display = { ...(existing.display || {}), ...(settings.preferences.display || {}) };
                    appStore.setState({ preferences: merged });
                } catch (_) {
                    appStore.setState({ preferences: settings.preferences });
                }
            }
            if (settings.ui) this.mergeUiSettings(settings.ui, { applyTheme: false });
            if (settings.api) appStore.setState({ api: settings.api });
            if (settings.auth) appStore.setState({ auth: this.sanitizeAuthSettings(settings.auth) });
            try {
                const effectiveTheme = getEffectiveThemeFromSettings(settings);
                if (effectiveTheme) {
                    this.applyTheme(effectiveTheme);
                    try { appStore.setPath('ui.theme', effectiveTheme); } catch (_) {}
                }
            } catch (_) {}
        } catch (error) {
            console.warn('[Settings] Failed to bootstrap settings synchronously:', error);
        }
    }

    mergeUiSettings(uiSettings, options = {}) {
        if (!uiSettings || typeof uiSettings !== 'object') return null;
        let merged;
        try {
            const existingUi = appStore.getState('ui') || {};
            merged = { ...existingUi, ...uiSettings };
        } catch (_) {
            merged = { ...uiSettings };
        }
        appStore.setState({ ui: merged });
        const theme = typeof merged.theme === 'string' && merged.theme.trim() !== '' ? merged.theme : null;
        if (theme) {
            if (options.applyTheme !== false) {
                this.applyTheme(theme);
            } else {
                this._lastAppliedTheme = theme;
            }
        }
        return merged;
    }

    sanitizeAuthSettings(authValue) {
        try {
            const raw = authValue && typeof authValue === 'object' ? authValue : {};
            const uname = typeof raw.username === 'string' ? raw.username.trim() : '';
            return { username: uname };
        } catch (_) {
            return { username: '' };
        }
    }

    /**
     * Persist current settings (desktop: disk only; browser: localStorage)
     */
    saveSettingsToStorage() {
        const store = getSettingsStore();
        try {
            const currentState = appStore.getState();
            const settingsToSave = {
                preferences: currentState.preferences,
                api: currentState.api,
                auth: this.sanitizeAuthSettings(currentState.auth)
            };
            // Merge with previously saved settings to preserve unknown keys (e.g., authProfiles)
            let prev = {};
            try {
                const res = store.loadSync && store.loadSync();
                if (res && res.ok && res.settings && typeof res.settings === 'object') prev = res.settings;
            } catch (_) {}
            const next = { ...prev, ...settingsToSave };
            // Preserve ui.theme when a per-profile override exists; otherwise update from current state.
            try {
                const hasOverride = (() => {
                    try {
                        const ap = prev && prev.authProfiles ? prev.authProfiles : {};
                        const items = Array.isArray(ap.items) ? ap.items : [];
                        const activeId = (ap && typeof ap.activeId === 'string') ? ap.activeId : '';
                        if (!activeId || !items.length) return false;
                        for (let i = 0; i < items.length; i += 1) {
                            const p = items[i];
                            if (!p || !p.id || p.id !== activeId) continue;
                            const ov = p.overrides || {};
                            const ui = ov.ui || {};
                            if (typeof ui.theme === 'string' && ui.theme.trim() !== '') return true;
                            break;
                        }
                        return false;
                    } catch (_) {
                        return false;
                    }
                })();
                const prevUi = prev && prev.ui && typeof prev.ui === 'object' ? prev.ui : {};
                let uiTheme = prevUi.theme;
                if (!hasOverride) {
                    uiTheme = (currentState && currentState.ui && typeof currentState.ui.theme === 'string')
                        ? currentState.ui.theme
                        : uiTheme;
                }
                next.ui = { ...(prevUi || {}), theme: uiTheme };
            } catch (_) {
                // Fallback: preserve previous ui block as-is
                if (prev && prev.ui && typeof prev.ui === 'object') {
                    next.ui = prev.ui;
                }
            }
            const finalSettings = next;
            store.save(finalSettings).then((res) => {
                if (!res || !res.ok) console.warn('[Settings] Save failed:', res && res.error);
            }).catch((e) => console.warn('[Settings] Save error:', e));
            console.log('[Settings] Settings persisted');
        } catch (error) {
            console.error('[Settings] Error saving settings:', error);
        }
    }

    // Export current settings to a downloadable JSON (browser)
    exportSettingsToFile() {
        try {
            const data = JSON.stringify(this.getCurrentSettings(), null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'settings.json';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 0);
        } catch (e) {
            console.error('[Settings] Failed to export settings:', e);
        }
    }

    // Export current state to JSON (browser)
    async exportStateToFile() {
        try {
            const store = (await import('../../core/state-store/index.js')).getStateStore();
            const state = await store.load();
            const data = JSON.stringify(state || {}, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'state.json';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
        } catch (e) {
            console.error('[Settings] Failed to export state:', e);
        }
    }

    // Import state from JSON file (browser)
    async importStateFromFile(file) {
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            if (!json || typeof json !== 'object') throw new Error('Invalid state');
            const store = (await import('../../core/state-store/index.js')).getStateStore();
            const res = await store.save(json);
            if (!res || !res.ok) throw new Error(res && res.error ? String(res.error) : 'save-failed');
            notificationDisplay?.show?.({ notification_type: 'success', title: 'State Imported', message: 'State file imported successfully.', timestamp: new Date().toISOString() }, { duration: 4000 });
        } catch (e) {
            console.error('[Settings] State import failed:', e);
            notificationDisplay?.show?.({ notification_type: 'error', title: 'Import Failed', message: 'Invalid or corrupted state file.', timestamp: new Date().toISOString() }, { duration: 6000 });
        }
    }

    // Import settings from a selected JSON file (browser)
    importSettingsFromFile(file) {
        try {
            const reader = new FileReader();
            reader.onerror = () => {
                console.error('[Settings] Failed to read file');
            };
            reader.onload = () => {
                try {
                    const json = JSON.parse(String(reader.result || 'null'));
                    if (!this.validateSettings(json)) {
                        throw new Error('Invalid settings format');
                    }
                    // Authentication settings are ignored on import
                    // Apply and persist
                    if (json.preferences) appStore.setState({ preferences: json.preferences });
                    if (json.ui) this.mergeUiSettings(json.ui, { applyTheme: false });
                    if (json.api) console.warn('[Settings] Ignoring api settings during import; use auth modal to configure API URL.');
                    if (json.auth) appStore.setState({ auth: this.sanitizeAuthSettings(json.auth) });
                    try {
                        const effectiveTheme = getEffectiveThemeFromSettings(json);
                        if (effectiveTheme) {
                            this.applyTheme(effectiveTheme);
                            try { appStore.setPath('ui.theme', effectiveTheme); } catch (_) {}
                        }
                    } catch (_) {}
                    this.saveSettingsToStorage();
                    this.updateUIFromStore();
                    notificationDisplay?.show?.({ notification_type: 'success', title: 'Settings Imported', message: 'Settings file imported successfully.', timestamp: new Date().toISOString() }, { duration: 4000 });
                } catch (e) {
                    console.error('[Settings] Import failed:', e);
                    notificationDisplay?.show?.({ notification_type: 'error', title: 'Import Failed', message: 'Invalid or corrupted settings file.', timestamp: new Date().toISOString() }, { duration: 6000 });
                }
            };
            reader.readAsText(file);
        } catch (e) {
            console.error('[Settings] Import error:', e);
        }
    }

    async reloadSettingsFromDisk() {
        try {
            if (!(window.desktop && window.desktop.settings && window.desktop.settings.load)) return;
            const res = await window.desktop.settings.load();
            if (res && res.ok && res.settings) {
                const s = res.settings;
                if (s.preferences) appStore.setState({ preferences: s.preferences });
                if (s.ui) this.mergeUiSettings(s.ui);
                if (s.api) appStore.setState({ api: s.api });
                if (s.auth) appStore.setState({ auth: this.sanitizeAuthSettings(s.auth) });
                this.updateUIFromStore();
                // Reflect allow-invalid-certs toggle into desktop runtime and UI
                try {
                    const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
                    if (isElectron && s.preferences && s.preferences.desktop && typeof s.preferences.desktop.allowInvalidCerts === 'boolean') {
                        await window.desktop.setAllowInvalidCerts(!!s.preferences.desktop.allowInvalidCerts);
                        if (this.elements.allowInsecureCerts) this.elements.allowInsecureCerts.checked = !!s.preferences.desktop.allowInvalidCerts;
                    }
                } catch (_) {}
                notificationDisplay?.show?.({ notification_type: 'success', title: 'Settings Reloaded', message: 'Loaded settings from disk.', timestamp: new Date().toISOString() }, { duration: 4000 });
            } else {
                const err = res && res.error ? String(res.error) : 'unknown-error';
                notificationDisplay?.show?.({ notification_type: 'error', title: 'Reload Failed', message: `Could not load settings from disk: ${err}`, timestamp: new Date().toISOString() }, { duration: 6000 });
            }
        } catch (e) {
            console.error('[Settings] Reload from disk failed:', e);
            notificationDisplay?.show?.({ notification_type: 'error', title: 'Reload Failed', message: 'Unexpected error reloading settings from disk.', timestamp: new Date().toISOString() }, { duration: 6000 });
        }
    }

    validateSettings(obj) {
        if (!obj || typeof obj !== 'object') return false;
        const keys = ['preferences', 'ui', 'auth'];
        for (const k of keys) {
            if (obj[k] != null && typeof obj[k] !== 'object') return false;
        }
        return true;
    }

    /**
     * Capture initial theme and override scope from persisted settings for the current session.
     */
    captureInitialThemeState() {
        const store = getSettingsStore();
        let settings = null;
        try {
            const res = store.loadSync && store.loadSync();
            if (res && res.ok && res.settings && typeof res.settings === 'object') {
                settings = this.applyMigrations(res.settings);
            }
        } catch (_) {
            settings = null;
        }
        const themeState = getThemeStateFromSettings(settings);
        const effectiveTheme = themeState.effectiveTheme || this._lastAppliedTheme || themeState.globalTheme || 'auto';
        this._savedGlobalTheme = themeState.globalTheme;
        this._savedProfileTheme = themeState.profileTheme;
        this._activeProfileId = themeState.activeProfileId || '';
        this._initialTheme = effectiveTheme;
        this._initialThemeScopeIsProfile = !!(themeState.activeProfileId && themeState.profileTheme);
    }

    /**
     * Initialize theme select and override checkbox from captured initial state.
     */
    initThemeControlsFromInitialState() {
        if (!this.elements.appTheme) return;
        try {
            const themeSel = this.elements.appTheme;
            const overrideCheckbox = this.elements.appThemeProfileOverride;
            if (this._initialTheme && typeof this._initialTheme === 'string') {
                themeSel.value = this._initialTheme;
            }
            if (overrideCheckbox) {
                const hasActiveProfile = !!this._activeProfileId;
                overrideCheckbox.disabled = !hasActiveProfile;
                overrideCheckbox.checked = !!(hasActiveProfile && this._initialThemeScopeIsProfile);
            }
        } catch (_) {}
    }

    /**
     * Open the settings modal
     */
    openModal() {
        // Capture initial theme + profile override state from persisted settings
        try { this.captureInitialThemeState(); } catch (_) {}
        // Ensure feature-gated controls reflect the current authenticated user
        try { this.refreshFeatureFlags().catch(() => {}); } catch (_) {}
        this.updateUIFromStore();
        try { this.initThemeControlsFromInitialState(); } catch (_) {}
        this.modal?.classList.add('show');
        // Focus trap setup
        this.prevFocused = document.activeElement;
        const focusable = this.modal?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        this.firstFocusable = focusable?.[0] || null;
        this.lastFocusable = focusable?.[focusable.length - 1] || null;
        if (this.firstFocusable && this.firstFocusable.focus) {
            this.firstFocusable.focus();
        } else {
            this.modal?.focus();
        }
    }

    /**
     * Close the settings modal
     */
    closeModal() {
        // If the modal is closed without saving, revert any theme preview
        try {
            if (!this._themeSaved && this._initialTheme && typeof this._initialTheme === 'string') {
                this.applyTheme(this._initialTheme);
                try { appStore.setPath('ui.theme', this._initialTheme); } catch (_) {}
            }
        } catch (_) {}
        this._themeSaved = false;
        this.modal?.classList.remove('show');
        if (this.prevFocused && this.prevFocused.focus) {
            this.prevFocused.focus();
        }
    }

    /**
     * Update UI elements from current store state
     */
    updateUIFromStore() {
        const state = appStore.getState();
        
        // Notification settings
        if (this.elements.notificationsEnabled) {
            this.elements.notificationsEnabled.checked = state.preferences?.notifications?.enabled ?? false;
        }
        if (this.elements.notificationsSound) {
            this.elements.notificationsSound.checked = state.preferences?.notifications?.sound ?? false;
        }
        if (this.elements.notificationsScheduledInputShow) {
            const showPref = state.preferences?.notifications?.showScheduledInput;
            this.elements.notificationsScheduledInputShow.checked = (showPref !== false);
        }
        if (this.elements.notificationsPersistInteractive) {
            const persist = state.preferences?.notifications?.persistInteractive === true;
            this.elements.notificationsPersistInteractive.checked = persist;
        }
        // Per-level settings (fallback to true)
        const lv = (state.preferences?.notifications?.levels) || {};
        if (this.elements.notificationsInfoShow) this.elements.notificationsInfoShow.checked = (lv.info?.show ?? true);
        if (this.elements.notificationsInfoSound) this.elements.notificationsInfoSound.checked = (lv.info?.sound ?? true);
        if (this.elements.notificationsSuccessShow) this.elements.notificationsSuccessShow.checked = (lv.success?.show ?? true);
        if (this.elements.notificationsSuccessSound) this.elements.notificationsSuccessSound.checked = (lv.success?.sound ?? true);
        if (this.elements.notificationsWarningShow) this.elements.notificationsWarningShow.checked = (lv.warning?.show ?? true);
        if (this.elements.notificationsWarningSound) this.elements.notificationsWarningSound.checked = (lv.warning?.sound ?? true);
        if (this.elements.notificationsErrorShow) this.elements.notificationsErrorShow.checked = (lv.error?.show ?? true);
        if (this.elements.notificationsErrorSound) this.elements.notificationsErrorSound.checked = (lv.error?.sound ?? true);
        
        // Terminal settings
        if (this.elements.terminalFontSize) {
            const fontSize = state.preferences?.terminal?.fontSize ?? 14;
            this.elements.terminalFontSize.value = fontSize;
            this.elements.fontSizeValue.textContent = `${fontSize}px`;
        }
        if (this.elements.terminalFontFamily) {
            const defaultFont = fontDetector.getDefaultFont();
            this.elements.terminalFontFamily.value = state.preferences?.terminal?.fontFamily ?? defaultFont;
        }
        if (this.elements.terminalCursorBlink) {
            this.elements.terminalCursorBlink.checked = state.preferences?.terminal?.cursorBlink ?? true;
        }
        if (this.elements.terminalFilterOscColors) {
            this.elements.terminalFilterOscColors.checked = state.preferences?.terminal?.filterOscColors !== false;
        }
        if (this.elements.terminalCollapseNakedRgb) {
            this.elements.terminalCollapseNakedRgb.checked = state.preferences?.terminal?.collapseNakedRgbRuns !== false;
        }
        if (this.elements.terminalAutoAttachOnSelect) {
            this.elements.terminalAutoAttachOnSelect.checked = state.preferences?.terminal?.autoAttachOnSelect ?? true;
        }
        // Dynamic title mode
        if (this.elements.dynamicTitleMode) {
            this.elements.dynamicTitleMode.value = state.preferences?.terminal?.dynamicTitleMode ?? 'ifUnset';
        }

        // Display settings
        if (this.elements.displayShowActivityIndicator) {
            this.elements.displayShowActivityIndicator.checked = state.preferences?.display?.showActivityIndicator !== false;
        }
        if (this.elements.displayCloseSendTextOnSubmit) {
            this.elements.displayCloseSendTextOnSubmit.checked = state.preferences?.display?.closeSendTextOnSubmit === true;
        }
        if (this.elements.displayShowContainerShellsInSidebar) {
            this.elements.displayShowContainerShellsInSidebar.checked = state.preferences?.display?.showContainerShellsInSidebar === true;
        }
        if (this.elements.appFontFamily) {
            const ff = state.preferences?.display?.appFontFamily || uiFonts.getDefault();
            this.elements.appFontFamily.value = ff;
            this.applyAppFontFamily(ff);
        }

        // Links settings
        const linksPrefs = state.preferences?.links || {};
        if (this.elements.linksSearchRevealGroup) {
            this.elements.linksSearchRevealGroup.checked = linksPrefs.searchRevealGroupLinks ?? true;
        }
        if (this.elements.linksShowSessionToolbarMenu) {
            // Default OFF unless explicitly true
            this.elements.linksShowSessionToolbarMenu.checked = linksPrefs.showSessionToolbarMenu === true;
        }
        if (this.elements.linksShowSessionTabs) {
            this.elements.linksShowSessionTabs.checked = linksPrefs.showSessionTabs ?? true;
        }
        const sessionTabWidth = this.normalizeSessionTabMaxWidth(linksPrefs.sessionTabMaxWidth);
        this.updateSessionTabMaxWidthValue(sessionTabWidth);
        this.applySessionTabMaxWidth(sessionTabWidth);

        const notesPrefs = state.preferences?.notes || {};
        if (this.elements.notesShowSessionTab) {
            this.elements.notesShowSessionTab.checked = notesPrefs.showSessionTab ?? true;
        }
        if (this.elements.notesShowWorkspaceTab) {
            this.elements.notesShowWorkspaceTab.checked = notesPrefs.showWorkspaceTab ?? true;
        }

        // Hide the Notes settings nav and panel entirely when the user lacks the notes feature
        try {
            const enabled = state?.auth?.features?.notes_enabled === true;
            const notesPanel = this.modal?.querySelector('.settings-panel[data-section="notes"]');
            const notesButton = this.modal?.querySelector('.settings-nav button[data-section="notes"]');
            if (notesPanel) notesPanel.style.display = enabled ? '' : 'none';
            if (notesButton) notesButton.style.display = enabled ? '' : 'none';
            // If notes becomes hidden while it's the active section, switch to 'terminal'
            const isActive = !!(notesPanel && notesPanel.classList.contains('active')) || !!(notesButton && notesButton.classList.contains('active'));
            if (!enabled && isActive) {
                this.showSection('terminal');
            }
        } catch (_) {}

        // Theme setting
        if (this.elements.appTheme) {
            this.elements.appTheme.value = state.ui?.theme ?? 'auto';
        }

        // Desktop effects
        const desktopOpacityPct = Math.round((state.preferences?.desktop?.effects?.windowOpacity ?? 1) * 100);
        if (this.elements.windowOpacity) {
            const pct = Math.max(50, Math.min(100, desktopOpacityPct || 100));
            this.elements.windowOpacity.value = pct;
            if (this.elements.windowOpacityValue) this.elements.windowOpacityValue.textContent = `${pct}%`;
        }
        // Blur removed
        
        // Debug settings
        if (this.elements.debugWsLogs) {
            this.elements.debugWsLogs.checked = state.preferences?.debug?.websocketLogs ?? false;
        }
        if (this.elements.debugRegistryLogs) {
            this.elements.debugRegistryLogs.checked = state.preferences?.debug?.registryLogs ?? false;
        }
        if (this.elements.debugApiLogs) {
            this.elements.debugApiLogs.checked = state.preferences?.debug?.apiLogs ?? false;
        }
        if (this.elements.debugStateStoreLogs) {
            this.elements.debugStateStoreLogs.checked = state.preferences?.debug?.stateStoreLogs ?? false;
        }
        if (this.elements.debugAppLogs) {
            this.elements.debugAppLogs.checked = state.preferences?.debug?.appLogs ?? false;
        }
        if (this.elements.debugSettingsLogs) {
            this.elements.debugSettingsLogs.checked = state.preferences?.debug?.settingsLogs ?? false;
        }
        if (this.elements.debugSessionTabsLogs) {
            this.elements.debugSessionTabsLogs.checked = state.preferences?.debug?.sessionTabsLogs ?? false;
        }
        if (this.elements.debugSessionListLogs) {
            this.elements.debugSessionListLogs.checked = state.preferences?.debug?.sessionListLogs ?? false;
        }
        if (this.elements.debugTerminalLogs) {
            this.elements.debugTerminalLogs.checked = state.preferences?.debug?.terminalLogs ?? false;
        }
        if (this.elements.debugTerminalSessionLogs) {
            this.elements.debugTerminalSessionLogs.checked = state.preferences?.debug?.terminalSessionLogs ?? false;
        }
        if (this.elements.debugAnsiOscLogs) {
            this.elements.debugAnsiOscLogs.checked = state.preferences?.debug?.ansiOscLogs ?? false;
        }
        if (this.elements.debugKeyOverlay) {
            const enabled = state.preferences?.debug?.keyOverlay ?? false;
            this.elements.debugKeyOverlay.checked = !!enabled;
            // Apply on load so overlay state matches saved preference
            this.applyKeyOverlaySettings(!!enabled);
        }
        if (this.elements.debugTerminalManagerLogs) {
            this.elements.debugTerminalManagerLogs.checked = state.preferences?.debug?.terminalManagerLogs ?? false;
        }
        if (this.elements.debugTabManagerLogs) {
            this.elements.debugTabManagerLogs.checked = state.preferences?.debug?.tabManagerLogs ?? false;
        }
        if (this.elements.debugResponsiveToolbarLogs) {
            this.elements.debugResponsiveToolbarLogs.checked = state.preferences?.debug?.responsiveToolbarLogs ?? false;
        }
        if (this.elements.debugMobileViewportLogs) {
            this.elements.debugMobileViewportLogs.checked = state.preferences?.debug?.mobileViewportLogs ?? false;
        }
        if (this.elements.debugMobileDetectionLogs) {
            this.elements.debugMobileDetectionLogs.checked = state.preferences?.debug?.mobileDetectionLogs ?? false;
        }
        if (this.elements.debugMobileTouchLogs) {
            this.elements.debugMobileTouchLogs.checked = state.preferences?.debug?.mobileTouchLogs ?? false;
        }
        if (this.elements.debugNotesLogs) {
            this.elements.debugNotesLogs.checked = state.preferences?.debug?.notesLogs ?? false;
        }
        if (this.elements.debugConfigLogs) {
            this.elements.debugConfigLogs.checked = state.preferences?.debug?.configLogs ?? false;
        }
        
        // Authentication settings handled in user menu; no UI fields here
        
        // API Configuration settings
        if (this.elements.apiUrl) {
            this.elements.apiUrl.placeholder = config.DEFAULT_API_URL;
            this.elements.apiUrl.value = state.api?.customUrl ?? '';
            try { this.elements.apiUrl.setAttribute('title', 'Use the Login modal to configure the API URL.'); } catch (_) {}
            try {
                const group = this.elements.apiUrl.closest('.form-group');
                if (group && !group.querySelector('.api-url-note')) {
                    const note = document.createElement('small');
                    note.className = 'form-help api-url-note';
                    note.textContent = 'API URL is configured in the Login modal after signing in.';
                    group.appendChild(note);
                }
            } catch (_) {}
        }
        if (this.elements.apiPrefix) {
            this.elements.apiPrefix.placeholder = config.DEFAULT_API_PREFIX;
            this.elements.apiPrefix.value = state.api?.customPrefix ?? '';
            try { this.elements.apiPrefix.setAttribute('title', 'Use the Login modal to configure the API prefix.'); } catch (_) {}
        }
        
    }

    normalizeSessionTabMaxWidth(value) {
        const numeric = parseInt(value, 10);
        if (Number.isFinite(numeric)) {
            return Math.min(this.maxSessionTabMaxWidth, Math.max(this.minSessionTabMaxWidth, numeric));
        }
        return this.defaultSessionTabMaxWidth;
    }

    applySessionTabMaxWidth(width) {
        const sanitized = this.normalizeSessionTabMaxWidth(width);
        try {
            document.documentElement.style.setProperty('--session-tab-title-max-width', `${sanitized}px`);
        } catch (_) {}
        return sanitized;
    }

    updateSessionTabMaxWidthValue(width) {
        const sanitized = this.normalizeSessionTabMaxWidth(width);
        try {
            if (this.elements?.linksSessionTabMaxWidthValue) {
                this.elements.linksSessionTabMaxWidthValue.textContent = `${sanitized}px`;
            }
            if (this.elements?.linksSessionTabMaxWidth) {
                this.elements.linksSessionTabMaxWidth.value = sanitized;
            }
        } catch (_) {}
        return sanitized;
    }

    /**
     * Fetch current user profile to determine feature flags and toggle gated controls.
     */
    async refreshFeatureFlags() {
        try {
            const me = await apiService.getCurrentUser();
            const features = (me && me.features) || {};
            try { appStore.setPath('auth.username', me?.username || ''); } catch (_) {}
            try { appStore.setPath('auth.features', features); } catch (_) {}
            this.updateFeatureGatedControls(features);
        } catch (e) {
            // Non-fatal; hide gated controls
            this.updateFeatureGatedControls({});
        }
    }

    /**
     * Show/hide controls based on feature flags
     * @param {Object} features
     */
    updateFeatureGatedControls(features = {}) {
        try {
            const resetEnabled = !!features.cookie_token_reset_enabled;
            const resetGrp = this.elements?.resetTokenGroup;
            if (resetGrp) resetGrp.style.display = resetEnabled ? '' : 'none';
        } catch (_) {}
        try {
            const reloadEnabled = !!features.config_reload_enabled;
            const reloadGrp = this.elements?.reloadConfigGroup;
            if (reloadGrp) reloadGrp.style.display = reloadEnabled ? '' : 'none';
        } catch (_) {}
    }

    /**
     * Save settings from UI to store and localStorage
     */
    saveSettings() {
        try {
            // Capture current state
            const currentState = appStore.getState();
            const store = getSettingsStore();
            // Reload persisted settings so we can preserve unknown keys and profile overrides
            let prevSettings = {};
            try {
                const res = store.loadSync && store.loadSync();
                if (res && res.ok && res.settings && typeof res.settings === 'object') {
                    prevSettings = this.applyMigrations(res.settings);
                }
            } catch (_) {
                prevSettings = {};
            }

            const activeProfileId = this._activeProfileId || (() => {
                try {
                    const ap = prevSettings && prevSettings.authProfiles ? prevSettings.authProfiles : {};
                    return typeof ap.activeId === 'string' ? ap.activeId : '';
                } catch (_) {
                    return '';
                }
            })();
            const scopeIsProfile = !!(this.elements.appThemeProfileOverride?.checked && activeProfileId);
            const selectedTheme = this.elements.appTheme?.value || 'auto';
            const themePlan = computeThemePersistence({
                prevSettings,
                selectedTheme,
                scopeIsProfile,
                activeProfileId
            });

            const newSettings = {
                preferences: {
                    mobile: {
                        useNativeHttpInsecure: (() => { try { return !!this.elements.allowInsecureCerts?.checked; } catch (_) { return true; } })()
                    },
                    notifications: {
                        enabled: this.elements.notificationsEnabled?.checked ?? false,
                        sound: this.elements.notificationsSound?.checked ?? false,
                        showScheduledInput: this.elements.notificationsScheduledInputShow?.checked !== false,
                        persistInteractive: this.elements.notificationsPersistInteractive?.checked === true,
                        levels: {
                            info: {
                                show: this.elements.notificationsInfoShow?.checked ?? true,
                                sound: this.elements.notificationsInfoSound?.checked ?? true
                            },
                            success: {
                                show: this.elements.notificationsSuccessShow?.checked ?? true,
                                sound: this.elements.notificationsSuccessSound?.checked ?? true
                            },
                            warning: {
                                show: this.elements.notificationsWarningShow?.checked ?? true,
                                sound: this.elements.notificationsWarningSound?.checked ?? true
                            },
                            error: {
                                show: this.elements.notificationsErrorShow?.checked ?? true,
                                sound: this.elements.notificationsErrorSound?.checked ?? true
                            }
                        }
                    },
                    terminal: {
                        fontSize: parseInt(this.elements.terminalFontSize?.value) || 14,
                        fontFamily: this.elements.terminalFontFamily?.value || fontDetector.getDefaultFont(),
                        cursorBlink: this.elements.terminalCursorBlink?.checked ?? true,
                        scrollback: 1000, // Keep existing value
                        dynamicTitleMode: this.elements.dynamicTitleMode?.value || 'ifUnset',
                        filterOscColors: this.elements.terminalFilterOscColors?.checked !== false,
                        collapseNakedRgbRuns: this.elements.terminalCollapseNakedRgb?.checked !== false,
                        autoAttachOnSelect: this.elements.terminalAutoAttachOnSelect?.checked ?? true
                    },
                    links: {
                        searchRevealGroupLinks: this.elements.linksSearchRevealGroup?.checked ?? true,
                        // Default OFF unless explicitly checked
                        showSessionToolbarMenu: this.elements.linksShowSessionToolbarMenu?.checked ?? false,
                        showSessionTabs: this.elements.linksShowSessionTabs?.checked ?? true,
                        sessionTabMaxWidth: this.normalizeSessionTabMaxWidth(
                            this.elements.linksSessionTabMaxWidth?.value
                            ?? currentState.preferences?.links?.sessionTabMaxWidth
                            ?? this.defaultSessionTabMaxWidth
                        )
                    },
                    display: {
                        showActivityIndicator: this.elements.displayShowActivityIndicator?.checked !== false,
                        closeSendTextOnSubmit: this.elements.displayCloseSendTextOnSubmit?.checked === true,
                        showContainerShellsInSidebar: this.elements.displayShowContainerShellsInSidebar?.checked === true,
                        appFontFamily: this.elements.appFontFamily?.value || uiFonts.getDefault()
                    },
                    notes: {
                        showSessionTab: this.elements.notesShowSessionTab?.checked ?? true,
                        showWorkspaceTab: this.elements.notesShowWorkspaceTab?.checked ?? true
                    },
                    desktop: {
                        allowInvalidCerts: this.elements.allowInsecureCerts?.checked ?? false,
                        effects: {
                            windowOpacity: (Math.max(50, Math.min(100, parseInt(this.elements.windowOpacity?.value) || 100))) / 100
                        }
                    },
                    debug: {
                        keyOverlay: this.elements.debugKeyOverlay?.checked ?? false,
                        websocketLogs: this.elements.debugWsLogs?.checked ?? false,
                        registryLogs: this.elements.debugRegistryLogs?.checked ?? false,
                        apiLogs: this.elements.debugApiLogs?.checked ?? false,
                        stateStoreLogs: this.elements.debugStateStoreLogs?.checked ?? false,
                        appLogs: this.elements.debugAppLogs?.checked ?? false,
                        settingsLogs: this.elements.debugSettingsLogs?.checked ?? false,
                        sessionTabsLogs: this.elements.debugSessionTabsLogs?.checked ?? false,
                        sessionListLogs: this.elements.debugSessionListLogs?.checked ?? false,
                        terminalLogs: this.elements.debugTerminalLogs?.checked ?? false,
                        terminalSessionLogs: this.elements.debugTerminalSessionLogs?.checked ?? false,
                        ansiOscLogs: this.elements.debugAnsiOscLogs?.checked ?? false,
                        terminalManagerLogs: this.elements.debugTerminalManagerLogs?.checked ?? false,
                        tabManagerLogs: this.elements.debugTabManagerLogs?.checked ?? false,
                        responsiveToolbarLogs: this.elements.debugResponsiveToolbarLogs?.checked ?? false,
                        mobileViewportLogs: this.elements.debugMobileViewportLogs?.checked ?? false,
                        mobileDetectionLogs: this.elements.debugMobileDetectionLogs?.checked ?? false,
                        mobileTouchLogs: this.elements.debugMobileTouchLogs?.checked ?? false,
                        notesLogs: this.elements.debugNotesLogs?.checked ?? false,
                        configLogs: this.elements.debugConfigLogs?.checked ?? false
                    }
                },
                ui: {
                    theme: themePlan.nextGlobalTheme
                },
                api: currentState.api
            };
            
            // Update store
            appStore.beginTransaction();
            appStore.setState(newSettings);
            appStore.commitTransaction();

            // Merge with previously saved settings to preserve unknown keys (e.g., authProfiles)
            const mergedSettings = { ...prevSettings, ...newSettings };

            // Apply per-profile overrides container (extensible for future attributes)
            try {
                const updatedProfiles = applyProfileThemeOverride(
                    mergedSettings.authProfiles,
                    activeProfileId,
                    themePlan.nextProfileTheme
                );
                if (updatedProfiles !== mergedSettings.authProfiles) {
                    mergedSettings.authProfiles = updatedProfiles;
                }
            } catch (_) {}

            // Persist merged settings (desktop: disk; browser: localStorage)
            store.save(mergedSettings).then((res) => {
                if (!res || !res.ok) console.warn('[Settings] Save failed:', res && res.error);
            }).catch((e) => console.warn('[Settings] Save error:', e));
            
            // Apply audio preferences
            if (audioManager) {
                audioManager.setEnabled(newSettings.preferences.notifications.sound);
            }
            
            // Apply theme immediately based on the selected scope
            this.applyTheme(themePlan.effectiveTheme);
            try { appStore.setPath('ui.theme', themePlan.effectiveTheme); } catch (_) {}

            this._themeSaved = true;

            // Apply desktop effects if available
            try {
                const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
                if (isElectron && window.desktop?.setWindowEffects) {
                    const eff = newSettings.preferences.desktop.effects;
                    window.desktop.setWindowEffects({ opacity: eff.windowOpacity }).catch(() => {});
                }
                // Apply persisted allow-invalid-certs to desktop runtime
                if (isElectron && window.desktop?.setAllowInvalidCerts) {
                    const enable = !!newSettings.preferences.desktop.allowInvalidCerts;
                    window.desktop.setAllowInvalidCerts(enable).catch(() => {});
                }
            } catch (e) {
                console.warn('[Settings] Failed to apply desktop window effects:', e);
            }

            // Refresh titles across UI to reflect any dynamic title mode change
            try {
                const ctx = getContext();
                const tm = ctx?.app?.modules?.terminal;
                if (tm) {
                    tm.sessionList?.render();
                    tm.sessionTabsManager?.refresh();
                    if (tm.currentSessionId) {
                        tm.updateSessionUI(tm.currentSessionId);
                    }
                }
            } catch (e) {
                console.warn('[Settings] Failed to refresh titles after settings change:', e);
            }
            
            // Authentication credentials are managed via the header user menu (runtime only)

            // No WS reconnect here; user menu handles login/logout actions
            
            // Close modal
            this.closeModal();
            
            console.log('[Settings] Settings saved and applied');
        } catch (error) {
            console.error('[Settings] Error saving settings:', error);
            
            // Only show error notification if something actually went wrong
            if (notificationDisplay) {
                notificationDisplay.show({
                    notification_type: 'error',
                    title: 'Save Failed',
                    message: 'Failed to save settings. Please try again.',
                    timestamp: new Date().toISOString()
                }, { duration: 5000 });
            }
        }
    }

    /**
     * Send a test notification
     */
    testNotification() {
        const showNotifications = this.elements.notificationsEnabled?.checked ?? false;
        const soundEnabled = this.elements.notificationsSound?.checked ?? false;
        const levelSel = (this.elements.testNotificationLevel?.value || 'info');
        
        const testNotification = {
            notification_type: levelSel,
            title: 'Test Notification',
            message: `This is a ${levelSel} notification to preview your settings`,
            sound: soundEnabled,
            timestamp: new Date().toISOString()
        };

        // Respect per-level preferences as well
        try {
            const prefs = appStore.getState('preferences.notifications') || {};
            const type = testNotification.notification_type || 'info';
            const level = prefs.levels?.[type] || {};
            const shouldShow = !!((prefs.enabled === true) && (level.show !== false) && showNotifications);
            const shouldSound = !!((prefs.sound === true) && (level.sound !== false) && soundEnabled);

            // Show visual notification if enabled
            if (shouldShow && notificationDisplay) {
                notificationDisplay.handleNotification(testNotification);
            }

            // Play sound if enabled (independent of visual notification)
            if (shouldSound && audioManager) {
                audioManager.playNotificationSound(type);
            }
        } catch (_) {
            // Fallback to legacy behavior if prefs access fails
            if (showNotifications && notificationDisplay) {
                notificationDisplay.handleNotification(testNotification);
            }
            if (soundEnabled && audioManager) {
                audioManager.playNotificationSound(testNotification.notification_type);
            }
        }
        
        // If nothing is enabled, provide feedback
        if (!showNotifications && !soundEnabled) {
            console.log('[Settings] Test notification: Both visual and sound are disabled');
        }
    }

    // Authentication test removed; handled via auth modal

    /**
     * Reset settings to defaults
     */
    resetToDefaults() {
        const defaultSettings = {
            preferences: {
                terminal: {
                    fontSize: 14,
                    fontFamily: fontDetector.getDefaultFont(),
                    cursorBlink: true,
                    scrollback: 1000,
                    dynamicTitleMode: 'ifUnset',
                    autoAttachOnSelect: true
                },
                display: {
                    showActivityIndicator: true,
                    showContainerShellsInSidebar: false
                },
                links: {
                    searchRevealGroupLinks: true,
                    showSessionToolbarMenu: false,
                    showSessionTabs: true,
                    sessionTabMaxWidth: this.defaultSessionTabMaxWidth
                },
                notes: {
                    showSessionTab: true,
                    showWorkspaceTab: true
                },
                notifications: {
                    enabled: false,
                    sound: false,
                    showScheduledInput: true,
                    persistInteractive: false,
                    levels: {
                        info: { show: true, sound: true },
                        success: { show: true, sound: true },
                        warning: { show: true, sound: true },
                        error: { show: true, sound: true }
                    }
                },
                desktop: {
                    allowInvalidCerts: false,
                    effects: {
                        windowOpacity: 1
                    }
                },
                debug: {
                    websocketLogs: false,
                    registryLogs: false,
                    apiLogs: false,
                    stateStoreLogs: false,
                    appLogs: false,
                    settingsLogs: false,
                    sessionTabsLogs: false,
                    sessionListLogs: false,
                    terminalLogs: false,
                    terminalSessionLogs: false,
                    terminalManagerLogs: false,
                    tabManagerLogs: false,
                    responsiveToolbarLogs: false,
                    mobileViewportLogs: false,
                    mobileDetectionLogs: false,
                    mobileTouchLogs: false,
                    notesLogs: false,
                    configLogs: false
                }
            },
            ui: {
                theme: 'auto'
            },
            auth: {
                username: ''
            }
        };

        appStore.setState({ ...defaultSettings, api: appStore.getState('api') });
        this.saveSettingsToStorage();
        this.updateUIFromStore();
        
        console.log('[Settings] Settings reset to defaults');
    }

    /**
     * Get current settings
     */
    getCurrentSettings() {
        const prefs = appStore.getState('preferences');
        const ui = appStore.getState('ui');
        const api = appStore.getState('api');
        const auth = this.sanitizeAuthSettings(appStore.getState('auth'));
        // Never include plaintext password in exported settings
        const safePrefs = (() => {
            try {
                const p = JSON.parse(JSON.stringify(prefs || {}));
                if (p.auth) {
                    p.auth = { username: p.auth.username || '' };
                }
                return p;
            } catch (_) {
                return prefs || {};
            }
        })();
        return {
            preferences: safePrefs,
            ui: { theme: (ui && ui.theme) || 'auto' },
            api,
            auth
        };
    }
    
    /**
     * Apply font settings to all terminals in real-time
     * @param {number} fontSize - Font size in pixels
     * @param {string} fontFamily - Font family string
     */
    applyFontSettings(fontSize, fontFamily) {
        // Get terminal manager instance if available
        const terminalManager = getContext()?.app?.modules?.terminal;
        if (terminalManager && terminalManager.updateAllTerminalFonts) {
            terminalManager.updateAllTerminalFonts(fontSize, fontFamily);
        }
    }
    
    /**
     * Apply the application UI font by setting a CSS variable on :root.
     * @param {string} fontFamily
     */
    applyAppFontFamily(fontFamily) {
        try {
            const root = document.documentElement;
            if (root && typeof fontFamily === 'string' && fontFamily.trim()) {
                root.style.setProperty('--app-font-family', fontFamily);
            }
        } catch (_) {
            // Non-fatal
        }
    }
    
    /**
     * Apply keypress overlay visibility in real-time
     * @param {boolean} enabled
     */
    applyKeyOverlaySettings(enabled) {
        try {
            if (enabled) {
                keyOverlay.enable();
            } else {
                keyOverlay.disable();
            }
        } catch (e) {
            console.warn('[Settings] Failed to apply key overlay setting:', e);
        }
    }

    /**
     * Apply the selected theme to the document and terminals
     * @param {('dark'|'light'|'auto')} theme
     */
    applyTheme(theme) {
        try {
            const resolvedTheme = (typeof theme === 'string' && theme.trim() !== '') ? theme : 'auto';
            this._lastAppliedTheme = resolvedTheme;
            // Update document attribute to drive CSS variables
            document.documentElement.setAttribute('data-theme', resolvedTheme);

            // Handle system theme change listener for 'auto'
            if (this._removeSystemThemeListener) {
                this._removeSystemThemeListener();
                this._removeSystemThemeListener = null;
            }
            if (resolvedTheme === 'auto') {
                // Keep terminals in sync when system theme changes
                this._removeSystemThemeListener = onSystemThemeChange(() => {
                    this.updateTerminalThemes();
                });
            }

            // Update terminal themes now
            this.updateTerminalThemes();
        } catch (e) {
            console.error('[Settings] Failed to apply theme:', e);
        }
    }

    /**
     * Update xterm theme across all terminals to match effective theme
     */
    updateTerminalThemes() {
        try {
            const ctx = getContext();
            const manager = ctx?.app?.modules?.terminal;
            if (manager && typeof manager.updateAllTerminalThemes === 'function') {
                const theme = getEffectiveTheme();
                manager.updateAllTerminalThemes(theme);
            }
        } catch (e) {
            console.warn('[Settings] Failed to update terminal themes:', e);
        }
    }

    // Removed legacy credential change modal (auth handled via header user menu/auth modal)
}

// Export singleton instance
export const settingsManager = new SettingsManager();
