/**
 * Terminal Manager Module
 * Handles terminal session management and UI
 */

import { TerminalSession } from './session.js';
import { SessionList } from './session-list.js';
import { TerminalViewController } from './terminal-view-controller.js';
import { getContext } from '../../core/context.js';
import { SessionFormManager } from './session-form-manager.js';
import { SessionFilterService } from './session-filter-service.js';
import { config } from '../../core/config.js';
import { apiService } from '../../services/api.service.js';
import { LocalPTYClient } from '../../services/localpty-client.js';
import { showLoadingOverlay } from '../../utils/loading-overlay.js';
import { errorHandler } from '../../utils/error-handler.js';
import { TerminalAutoCopy } from '../../utils/terminal-auto-copy.js';
import { sendStdinWithDelayedSubmit } from '../../utils/stdin-delayed-submit.js';
import { audioManager } from '../../utils/audio.js';
import { notificationDisplay } from '../../utils/notification-display.js';
import { getStateStore } from '../../core/state-store/index.js';
import { queueStateSet } from '../../core/state-store/batch.js';
import { MobileInterfaceManager } from './mobile-interface-manager.js';
import { DraggableElement } from '../../utils/draggable-element.js';
import { FormModal, ConfirmationModal, InputModal, isAnyModalOpen } from '../ui/modal.js';
import { parseColor, getContrastColor } from '../../utils/color-utils.js';
import { SessionTabsManager } from './session-tabs-manager.js';
import { TemplateQuickOpen } from './template-quick-open.js';
import { WorkspaceList } from '../workspaces/workspace-list.js';
import { WorkspaceScroller } from '../workspaces/workspace-scroller.js';
import { SidebarController } from './sidebar-controller.js';
import { SessionToolbarController } from './session-toolbar-controller.js';
import { LinksController } from './links-controller.js';
import { TransitionsController } from './transitions-controller.js';
import { TerminalSearchController } from './search-controller.js';
import { appStore } from '../../core/store.js';
import { iconUtils } from '../../utils/icon-utils.js';
import { computeDisplayTitle, getDynamicTitleMode } from '../../utils/title-utils.js';
import { settingsManager } from '../settings/settings-manager.js';
import { fontDetector } from '../../utils/font-detector.js';
import { keyboardShortcuts } from '../shortcuts/keyboard-shortcuts.js';
import { openAddRuleModal } from '../ui/scheduled-input-modals.js';
import { createDebug } from '../../utils/debug.js';
import { getSettingsStore } from '../../core/settings-store/index.js';


const TERMINAL_FONT_MIN = 8;
const TERMINAL_FONT_MAX = 64;
const TERMINAL_FONT_STEP = 1;

export class TerminalManager {

    constructor(wsClient, eventBus, clientId) {
        this.wsClient = wsClient;
        this.eventBus = eventBus;
        this.clientId = clientId;
        // Detect whether this renderer is a dedicated secondary window or has a direct session target.
        // If so, mark that a session_id has effectively been provided so we skip any
        // initial auto-selection/restore that would momentarily load another session first.
        try {
            const params = new URLSearchParams(window.location.search || '');
            const isDedicated = (params.get('window') === '1') || ((params.get('ui') || '').toLowerCase() === 'window');
            const hasSessionParam = !!String(params.get('session_id') || '').trim();
            this.isDedicatedWindow = !!isDedicated;
            if (isDedicated || hasSessionParam) {
                this.sessionIdParameterProcessed = true;
            }
        } catch (_) { /* ignore */ }
        this.sessions = new Map();
        this.currentSession = null;
        this.currentSessionId = null;
        this.connectedSessionId = null; // Track which session this client is connected to (for compatibility)
        this.attachedSessions = new Set(); // Track multiple attached sessions
        this.sessionList = null;
        this.tabManager = null;
        this.pendingParentFetches = new Map();
        this.isCreatingSession = false; // Prevent double session creation
        this.isInitialized = false; // Track if sessions have been loaded initially
        this.terminatedSessionsLoaded = false; // Track if terminated sessions have been loaded
        this.sessionsLoaded = false; // Track if sessions have been loaded on demand
        
        // Track pending sessions for auto-attachment
        this.expectAutoAttachNext = false; // Flag to auto-attach the next created session
        
        // Track separate selections for Active and Inactive tabs
        this.tabSelections = {
            active: null,
            inactive: null
        };
        // Track last-selected session per workspace
        this.workspaceSelections = new Map(); // Map<workspaceName, sessionId>
        this.childSessions = new Map(); // Map<childSessionId, sessionData>
        this.childSessionsByParent = new Map(); // Map<parentSessionId, Array<childSessionId>>
        this.activeChildSessionId = null;
        this._attachedChildSnapshot = new Set();
        // Track child sessions user explicitly detached to suppress auto-reattach
        this._suppressedChildAttach = new Set();
        // Track last successful child attaches to ignore stale 'detached' events arriving out-of-order
        this._lastChildAttachAt = new Map(); // Map<childId, timestamp>
        this._lastParentAttachAt = new Map(); // Map<parentId, timestamp>
        // Activity timers for transient activity (stdout bursts)
        this._activityTimers = new Map(); // Map<sessionId, timeoutId>
        // Load persisted workspace selections
        this.loadWorkspaceSelections();

        // Initialize form manager
        this.formManager = new SessionFormManager();

        // Cleanup handles for registered keyboard shortcuts
        this._shortcutDisposers = [];

        // Cache for tabs toolbar visibility toggling
        this._tabsToolbarEl = null;
        this._tabsToolbarVisible = null;

        // Throttle map for refit/focus helper
        this._lastFitFocusAt = new Map(); // Map<sessionId, timestamp>

        // Deferred input queue and stop inputs state
        this.deferredInputQueues = new Map(); // Map<sessionId, Array>
        this.stopInputsState = new Map(); // Map<sessionId, { enabled: boolean, prompts: Array, rearmRemaining?: number, rearmMax?: number }>
        this._promptsDropdownOpen = false;
        
        // UI elements
        this.elements = {
            sessionList: document.getElementById('session-list'),
            workspaceList: document.getElementById('workspace-list'),
            terminalView: document.getElementById('terminal-view'),
            terminalTitle: document.getElementById('terminal-title'),
            terminalSessionId: document.getElementById('terminal-session-id'),
            sessionInfoToolbar: document.getElementById('session-info-toolbar'),
            sessionTitleLine: document.getElementById('session-title-line'),
            sessionIdLine: document.getElementById('session-id-line'),
            newSessionBtn: document.getElementById('new-session-btn'),
            newLocalSessionBtn: document.getElementById('new-local-session-btn'),
            newWorkspaceBtn: document.getElementById('new-workspace-btn'),
            workspacesBackBtn: document.getElementById('workspaces-back-btn'),
            // XXX clearBtn: document.getElementById('terminal-clear-btn'),
            detachBtn: document.getElementById('terminal-detach-btn'),
            closeBtn: document.getElementById('terminal-close-btn'),
            // Save history checkbox removed from header UI
            // Mobile keyboard elements
            mobileKeyboardBtn: document.getElementById('mobile-keyboard-btn'),
            mobileKeyboardDropdown: document.getElementById('mobile-keyboard-dropdown'),
            mobileKeyboardBackdrop: document.getElementById('mobile-keyboard-backdrop'),
            // Mobile scroll forward toggle
            mobileScrollForwardBtn: document.getElementById('mobile-scroll-forward-btn'),
            modal: document.getElementById('new-session-modal'),
            modalClose: document.getElementById('modal-close'),
            modalCancel: document.getElementById('modal-cancel'),
            modalCreate: document.getElementById('modal-create'),
            sessionForm: document.getElementById('new-session-form'),
            // Template elements
            templateDescription: document.getElementById('template-description'),
            templateParameters: document.getElementById('template-parameters'),
            // Interactive elements
            interactiveGroup: document.getElementById('interactive-group'),
            sessionInteractive: document.getElementById('session-interactive'),
            // Terminate confirmation modal
            terminateModal: document.getElementById('confirm-terminate-modal'),
            terminateModalClose: document.getElementById('terminate-modal-close'),
            terminateCancel: document.getElementById('terminate-cancel'),
            terminateConfirm: document.getElementById('terminate-confirm'),
            // Delete confirmation modal
            deleteModal: document.getElementById('confirm-delete-modal'),
            deleteModalClose: document.getElementById('delete-modal-close'),
            deleteCancel: document.getElementById('delete-cancel'),
            deleteConfirm: document.getElementById('delete-confirm'),
            // Text input modal
            textInputBtn: document.getElementById('text-input-btn'),
            textInputModal: document.getElementById('text-input-modal'),
            textInputModalClose: document.getElementById('text-input-modal-close'),
            textInputIncludedLabel: document.getElementById('text-input-included-label'),
            textInputIncluded: document.getElementById('text-input-included'),
            textInputDivider: document.getElementById('text-input-divider'),
            textInputClear: document.getElementById('text-input-clear'),
            textInputCopy: document.getElementById('text-input-copy'),
            textInputSend: document.getElementById('text-input-send'),
            textInputText: document.getElementById('text-input-text'),
            // Terminal search dropdown elements
            terminalSearchContainer: document.querySelector('.terminal-search-container'),
            terminalSearchBtn: document.getElementById('terminal-search-btn'),
            terminalSearchDropdown: document.getElementById('terminal-search-dropdown'),
            terminalSearchInput: document.getElementById('terminal-search-input'),
            terminalSearchPrev: document.getElementById('terminal-search-prev'),
            terminalSearchNext: document.getElementById('terminal-search-next'),
            // Deferred inputs + stop inputs dropdown
            promptsDropdownContainer: document.getElementById('prompts-queue-container'),
            promptsDropdownBtn: document.getElementById('prompts-queue-btn'),
            promptsDropdownIcon: document.getElementById('prompts-queue-icon'),
            promptsDropdownDropdown: document.getElementById('prompts-queue-dropdown'),
            promptsDropdownBadge: document.getElementById('prompts-queue-badge'),
            // Filter tabs
            filterTabs: document.querySelectorAll('.filter-tab'),
            // Search elements
            searchInput: document.getElementById('session-search'),
            searchClear: document.getElementById('search-clear'),
            // Pinned filter elements
            pinnedFilterContainer: document.getElementById('pinned-filter-container'),
            pinnedFilterBtn: document.getElementById('pinned-filter-btn'),
            pinnedFilterIcon: document.getElementById('pinned-filter-icon'),
            // Template filter elements
            templateFilterContainer: document.getElementById('template-filter-container'),
            templateFilterOptions: document.getElementById('template-filter-options'),
            templateFilterClear: document.getElementById('template-filter-clear'),
            // Session links elements
            sessionLinksContainer: document.getElementById('session-links-container') || document.querySelector('.session-links-container'),
            sessionLinksBtn: document.getElementById('session-links-btn'),
            sessionLinksDropdown: document.getElementById('session-links-dropdown'),
            // Multiple templates confirmation modal
            multipleTemplatesModal: document.getElementById('confirm-multiple-templates-modal')
        };

        // Controllers
        this.toolbarController = new SessionToolbarController(this.elements, this);
        this.linksController = new LinksController(this.elements, this.eventBus);
        // Transitions timeline controller
        this.elements.sessionTransitionsContainer = document.getElementById('session-transitions-container');
        this.elements.sessionTransitionsBtn = document.getElementById('session-transitions-btn');
        this.elements.sessionTransitionsDropdown = document.getElementById('session-transitions-dropdown');
        this.transitionsController = new TransitionsController(this.elements, this, this.eventBus);
        this.transitionsController.init();
        this.searchController = new TerminalSearchController(this.elements, this);

        // Initialize terminal view controller for display logic
        this.viewController = new TerminalViewController(this.elements, this.eventBus, this);

        // Workspace state
        this.currentWorkspace = null; // null => workspace list mode
        this.workspaceListComponent = new WorkspaceList(this.elements.workspaceList, (name) => this.enterWorkspace(name));
        // Track whether we've performed a restore/auto-selection to avoid duplicate auto-selection later
        this.autoSelectionPerformed = false;

        // Search state
        this.searchQuery = '';
        this.searchDebounceTimer = null;
        this.originalSessions = [];

        // Template filter state
        this.selectedTemplateFilters = new Set(); // Set of selected template names
        this.availableTemplateFilters = new Set(); // Set of templates available in current view

        // Pinned filter state
        this.pinnedFilterActive = false;

        // Sync terminal font variables for dependent UI (e.g., notes editor)
        try {
            const state = appStore.getState();
            const fontSize = state?.preferences?.terminal?.fontSize ?? 14;
            const fontFamily = state?.preferences?.terminal?.fontFamily || fontDetector.getDefaultFont();
            this.updateTerminalFontVariables(fontSize, fontFamily);
        } catch (_) {}

        // Active Workspaces filter state (default ON)
        this.activeWorkspacesOnly = true;

        // Quick Template Search overlay
        try {
            this.templateQuickOpen = new TemplateQuickOpen(this);
            this.templateQuickOpen.init();
        } catch (e) {
            console.warn('[TerminalManager] Failed to initialize TemplateQuickOpen:', e);
        }

        
        // Mobile interface manager
        this.mobileInterface = new MobileInterfaceManager(this);

        // Sidebar controller
        this.sidebar = new SidebarController();

        // Mobile workspace scroller (renders in mobile header toolbar)
        try {
            const toolbarEl = document.getElementById('session-info-toolbar');
            this.workspaceScroller = new WorkspaceScroller(toolbarEl, this);
            this.workspaceScroller.init();
        } catch (e) {
            console.warn('[TerminalManager] Failed to initialize WorkspaceScroller:', e);
        }

        // Wire prompts dropdown button
        try {
            if (this.elements.promptsDropdownBtn) {
                this.elements.promptsDropdownBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.togglePromptsDropdown();
                });
            }
        } catch (_) { /* non-fatal */ }

        // Feature controllers are initialized in setupEventListeners()

        // Suppress auto-selection for a short window after manual user actions
        this.suppressAutoSelectionUntil = 0;

        // During an active search, freeze auto-selection/tab updates until the user navigates
        this.searchFreezeActive = false;

        // Track a pending manual selection across workspace/search re-renders
        this.pendingManualSelectionId = null;

        // Helper: show an Attach prompt inside a container tab view for a child session
        this.showContainerAttachPrompt = (childId) => {
            try {
                if (!childId) return;
                const child = this.childSessions?.get?.(childId) || {};
                const parentId = child.parent_session_id;
                if (!parentId) return;
                const tabMgr = this.getTabManager();
                const viewEl = tabMgr?.getContainerViewElement?.(parentId, childId);
                if (!viewEl) return;
                // Only render if the container tab view is currently the active visible view
                const isActive = viewEl.classList?.contains('active');
                // Render regardless; updateActiveTabDisplay toggles visibility
                const title = child.title || child.container_name || childId;
                viewEl.innerHTML = `
                    <div class="attach-button-container terminal-placeholder" data-child-id="${childId}">
                        <div class="attach-prompt">
                            <p>Shell for \"${title}\" is ready</p>
                            <button class="btn btn-primary attach-session-btn">Attach</button>
                            <p class="attach-description">Click \"Attach\" to connect to this container terminal</p>
                        </div>
                    </div>
                `;
                const btn = viewEl.querySelector('.attach-session-btn');
                if (btn) {
                    btn.addEventListener('click', async () => {
                        try {
                            await this.attachChildSession(childId, { markActive: true, focus: true });
                        } catch (e) {
                            console.warn('[TerminalManager] Failed to attach child on prompt click:', e);
                        }
                    });
                }

                // Add Enter key handler (document-level) to attach like normal sessions
                try {
                    if (!this._attachKeyHandlers) this._attachKeyHandlers = new Map();
                    const existing = this._attachKeyHandlers.get(childId);
                    if (existing) {
                        document.removeEventListener('keydown', existing, true);
                    }
                    const handler = (evt) => {
                        // Do not trigger attach via Enter while any modal is open
                        try { if (isAnyModalOpen()) return; } catch (_) {}
                        if (evt && evt.key === 'Enter' && !evt.shiftKey && !evt.ctrlKey && !evt.altKey && !evt.metaKey) {
                            // Only when the placeholder for this child is still present
                            const stillHere = !!document.querySelector(`.attach-button-container[data-child-id="${childId}"]`);
                            if (!stillHere) return;
                            evt.preventDefault();
                            evt.stopPropagation();
                            this.attachChildSession(childId, { markActive: true, focus: true })
                                .finally(() => {
                                    // Clean up handler after action
                                    try { document.removeEventListener('keydown', handler, true); } catch (_) {}
                                    this._attachKeyHandlers.delete(childId);
                                });
                        }
                    };
                    document.addEventListener('keydown', handler, true);
                    this._attachKeyHandlers.set(childId, handler);
                } catch (_) {}
            } catch (e) {
                console.warn('[TerminalManager] showContainerAttachPrompt failed:', e);
            }
        };

        // Debounced refresh timer for re-running server search on events
        this.searchRefreshTimer = null;

        // Debug logger
        this._debug = createDebug('TerminalManager');

        // Icon utilities (shared with other terminal modules)
        this.iconUtils = iconUtils;

        // Listen for dedicated window lifecycle to restore or offload sessions
        try {
            const params = new URLSearchParams(window.location.search || '');
            const isDedicated = (params.get('window') === '1') || ((params.get('ui') || '').toLowerCase() === 'window');
            if (!isDedicated && window.desktop && typeof window.desktop.onSessionWindowChanged === 'function') {
                window.desktop.onSessionWindowChanged(async ({ sessionId, windowId }) => {
                    try {
                        if (!sessionId) return;
                        // On close of a dedicated window, if we're showing that session in the main window, reattach it
                        if (!windowId && this.currentSessionId === sessionId) {
                            // If not already attached, attach and focus
                            if (!this.attachedSessions?.has?.(sessionId)) {
                                this._debug?.log?.('Reattaching after dedicated window close', { sessionId });
                                try { await this.attachToCurrentSession(); } catch (_) {}
                            } else {
                                // Ensure view is visible
                                try { this.viewController?.clearTerminalView(); } catch (_) {}
                                try { if (this.currentSession?.container) this.elements.terminalView.appendChild(this.currentSession.container); } catch (_) {}
                            }
                        }
                    } catch (e) {
                        this._debug?.warn?.('onSessionWindowChanged handler failed', e);
                    }
                });
            }
        } catch (_) { /* ignore */ }

        // Helper to select a session and reflect the selection in all views
        this.selectAndHighlight = (sessionId, options = {}) => {
            try { this.selectSession(sessionId, options); } catch (_) {}
            try { this.sessionList?.setActiveSession(sessionId); } catch (_) {}
            try { this.sessionTabsManager?.setActiveSession?.(sessionId); } catch (_) {}
        };
    }

    // Removed transient activity helpers; rely on server state only

    /**
     * Persistently set the activity state for a session (from server events).
     * When active=true, indicator should remain visible until explicitly set inactive.
     * @param {string} sessionId
     * @param {boolean} active
     */
    setSessionActivityState(sessionId, active) {
        try {
            if (!sessionId) return;
            const st = appStore.getState();
            // Initialize map if missing
            const m = st?.sessionList?.activityState instanceof Map
                ? st.sessionList.activityState
                : new Map();
            const next = new Map(m);
            if (active) next.set(sessionId, true); else next.delete(sessionId);
            appStore.setPath('sessionList.activityState', next);
            // Force UI update for session list render
            try { appStore.setPath('sessionList.lastUpdate', Date.now()); } catch (_) {}
            // No extra re-render nudge
        } catch (_) { /* ignore */ }
    }

    /**
     * Unified session activation entry point used by sidebar, tabs, keyboard, and restores.
     * Ensures selection, tab restoration, and container rehydration are handled consistently.
     */
    async activateSession(sessionId, options = {}) {
        if (!sessionId) return;
        this._debug.log('activateSession', { sessionId, options });

        // Local activation only; do not focus dedicated windows from the main window

        // Perform the core selection flow
        await this.selectSession(sessionId, options);

        // Ensure UI highlights match
        try { this.sessionList?.setActiveSession(sessionId); } catch (_) {}
        try { this.sessionTabsManager?.setActiveSession?.(sessionId); } catch (_) {}
        // Clear activity indicator when user activates a session
        try { this.sessionList?.clearActivityIndicator?.(sessionId); } catch (_) {}

        // Restore preferred tab (terminal/containers/urls) if saved
        try {
            const tabManager = this.getTabManager();
            if (tabManager) {
                // Ensure TabManager is on the same session
                const listData = this.sessionList?.getSessionData?.(sessionId) || null;
                try { tabManager.switchToSession?.(sessionId, listData); } catch (_) {}

                // If a forced tab is requested, honor it and skip saved-tab restore
                const forceTabId = options && (options.forceTabId || (options.forceTerminalTab ? 'terminal' : null));
                if (forceTabId) {
                    try { tabManager.switchToTab?.(forceTabId); } catch (_) {}
                } else {
                    const restored = tabManager.activateSavedTabForSession?.(sessionId, { forceSwitch: true });
                    if (!restored) {
                        // Default to terminal when no saved tab exists
                        try { tabManager.switchToTab?.('terminal'); } catch (_) {}
                    }
                }
            }
        } catch (e) {
            this._debug.warn('activateSession tab restore failed', e);
        }

        // Rehydrate container tabs and attachments for parent sessions
        try {
            if (this.childSessionsByParent?.has?.(sessionId)) {
                this.refreshContainerTabsForParent(sessionId, { attach: true });
            }
        } catch (e) {
            this._debug.warn('activateSession container refresh failed', e);
        }

        // In a dedicated window, inform the desktop main process which session this window now represents
        try {
            const params = new URLSearchParams(window.location.search || '');
            const isDedicated = (params.get('window') === '1') || ((params.get('ui') || '').toLowerCase() === 'window');
            if (isDedicated && window.desktop && window.desktop.isElectron && typeof window.desktop.setWindowSession === 'function') {
                const sid = this.getActiveEffectiveSessionId?.() || this.currentSessionId || sessionId;
                if (sid) { window.desktop.setWindowSession(sid).catch(() => {}); }
            }
        } catch (_) { /* ignore */ }
    }

    /** Compute effective active session id for toolbars and actions.
     * Returns child session id when a container tab is active; otherwise parent id.
     */
    getActiveEffectiveSessionId() {
        return this.activeChildSessionId || this.currentSessionId;
    }

    /** Get session data for either a parent (sidebar) or child (container) id. */
    getAnySessionData(sessionId) {
        if (!sessionId) return null;
        if (this.childSessions && this.childSessions.has(sessionId)) {
            return this.childSessions.get(sessionId);
        }
        try { return this.sessionList?.getSessionData?.(sessionId) || null; } catch (_) { return null; }
    }

    /**
     * Load persisted workspace session selections from state store
     */
    loadWorkspaceSelections() {
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const st = res && res.ok ? (res.state || {}) : {};
            const persistedSelections = st['workspace_session_selections'] || {};
            // Populate in-memory map from persisted data
            for (const [workspace, sessionId] of Object.entries(persistedSelections)) {
                if (workspace && sessionId) {
                    this.workspaceSelections.set(workspace, sessionId);
                }
            }
        } catch (e) {
            console.warn('[TerminalManager] Failed to load workspace selections:', e);
        }
    }

    /**
     * Resolve the target workspace for local-only sessions.
     * Preference order:
     * 1) Currently selected workspace in UI
     * 2) Persisted last workspace from state store
     * 3) 'Default'
     */
    resolveWorkspaceForLocalSession() {
        try {
            if (this.currentWorkspace && typeof this.currentWorkspace === 'string') {
                return this.currentWorkspace;
            }
        } catch (_) {}
        // Fallback 1: current workspace from store (if sidebar already restored it)
        try {
            const ws = this.sessionList?.store?.getState()?.workspaces?.current;
            if (typeof ws === 'string' && ws.trim()) return ws.trim();
        } catch (_) {}
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const st = res && res.ok ? (res.state || {}) : {};
            const raw = st['terminal_manager_last_workspace'] || '';
            const last = (typeof raw === 'string') ? raw.trim() : '';
            if (last) return last;
        } catch (_) {}
        return 'Default';
    }

    /**
     * Restore last selected workspace and session after initial load
     */
    async restoreLastSelection() {
        try {
            // Skip if URL parameter was processed
            if (this.sessionIdParameterProcessed) return;

            const res = getStateStore().loadSync && getStateStore().loadSync();
            const st = res && res.ok ? (res.state || {}) : {};
            const lastWorkspaceRaw = st['terminal_manager_last_workspace'] || null;
            const lastWorkspace = (typeof lastWorkspaceRaw === 'string' ? lastWorkspaceRaw.trim() : lastWorkspaceRaw) || null;

            if (lastWorkspace && this.workspaceListComponent) {
                // Restore workspace (even if not yet present in items; server list may arrive later)
                this.workspaceListComponent.setMode('detail');
                this.workspaceListComponent.setCurrent(lastWorkspace);
                this.enterWorkspace(lastWorkspace);

                // Restore session within workspace if previously saved and still active
                const savedSessionId = this.workspaceSelections.get(lastWorkspace);
                if (savedSessionId) {
                    const sessionData = this.sessionList.getSessionData(savedSessionId);
                    if (sessionData && sessionData.is_active !== false) {
                        await this.selectSession(savedSessionId, { restored: true });
                    }
                }
                this.autoSelectionPerformed = true;
                return;
            }
            
            // No workspace to restore, check for global last session
            // This would be a new feature - for now just auto-select first
            this.performAutoSelection();
            
        } catch (e) {
            console.warn('[TerminalManager] Failed to restore last selection:', e);
            this.performAutoSelection();
        }
    }

    /**
     * Update session info in both terminal header and mobile toolbar
     * @param {string} title - Session title
     * @param {string} sessionId - Session ID
     * @param {string} templateName - Template name (optional)
     */
    updateSessionInfoToolbar(title, sessionId, templateName = null) {
        this.toolbarController?.updateSessionInfo(title, sessionId, templateName);
        // Sidebar controller is initialized during constructor/init
    }

    /**
     * Recompute and apply header title for a session (defaults to current).
     */
    refreshHeaderForSession(sessionId = null) {
        try {
            const sid = sessionId || this.currentSessionId;
            if (!sid) return;
            const data = this.sessionList?.getSessionData?.(sid) || {};
            const effective = computeDisplayTitle(data, { fallbackOrder: [], defaultValue: 'Session' });
            const templateName = data.template_name || null;
            this.updateSessionInfoToolbar(effective, sid, templateName);
        } catch (_) { /* ignore */ }
    }

    async init() {

        // Initialize session list UI
        this.sessionList = new SessionList(this.elements.sessionList, this);
        // Listen for local PTY exit events globally (all windows) so the main window
        // reflects ended state even when the session ended in a dedicated window.
        try {
            if (window.desktop && window.desktop.isElectron && window.desktop.localpty && typeof window.desktop.localpty.onExit === 'function') {
                window.desktop.localpty.onExit((payload) => {
                    try {
                        const sid = String((payload?.session_id || payload?.sessionId || '')).trim();
                        if (!sid) return;
                        const data = this.sessionList?.getSessionData?.(sid);
                        // Only update for known local-only sessions
                        if (data && data.local_only === true) {
                            this.sessionList.markSessionAsTerminated(sid);
                            // If this is the current selection and no dedicated window is open, show terminated message
                            try {
                                if (this.currentSessionId === sid && window.desktop && typeof window.desktop.getSessionWindow === 'function') {
                                    window.desktop.getSessionWindow(sid).then((info) => {
                                        try {
                                            const hasWindow = info && info.ok && info.windowId;
                                            if (!hasWindow) {
                                                this.showSessionTerminatedMessage({ session_id: sid });
                                            }
                                        } catch (_) {}
                                    }).catch(() => {});
                                }
                            } catch (_) {}
                            try { this.updateSessionTabs?.(); } catch (_) {}
                        }
                    } catch (_) { /* ignore */ }
                });
            }
        } catch (_) { /* ignore */ }

        // Subscribe to local PTY dynamic title updates (OSC 0/2 parsed in desktop main)
        try {
            if (window.desktop && window.desktop.isElectron && window.desktop.localpty && typeof window.desktop.localpty.onUpdated === 'function') {
                window.desktop.localpty.onUpdated((payload) => {
                    try {
                        const sid = String((payload?.session_id || payload?.sessionId || '')).trim();
                        const dyn = (payload && typeof payload.dynamic_title === 'string') ? payload.dynamic_title : '';
                        if (!sid) return;
                        const data = this.sessionList?.getSessionData?.(sid);
                        // Only process for known local-only sessions
                        if (data && data.local_only === true) {
                            // Persist dynamic title so it survives renderer reloads
                            try {
                                const res = getStateStore().loadSync && getStateStore().loadSync();
                                const st = res && res.ok ? (res.state || {}) : {};
                                const map = (st && typeof st['local_session_dynamic_titles'] === 'object') ? { ...st['local_session_dynamic_titles'] } : {};
                                if (dyn) { map[sid] = dyn; } else { try { delete map[sid]; } catch (_) {} }
                                queueStateSet('local_session_dynamic_titles', map);
                            } catch (_) { /* ignore */ }
                            // Reuse existing update pipeline so header/tabs/sidebar refresh consistently
                            this.handleSessionUpdate({ session_id: sid, dynamic_title: dyn }, 'updated');
                        }
                    } catch (_) { /* ignore */ }
                });
            }
        } catch (_) { /* ignore */ }

        // React to Dynamic Title mode changes by refreshing visible titles across the UI
        try {
            if (appStore && typeof appStore.subscribe === 'function') {
                appStore.subscribe('preferences.terminal.dynamicTitleMode', () => {
                    this.refreshHeaderForSession(this.currentSessionId);
                    try { this.sessionTabsManager?.refresh?.(); } catch (_) {}
                    try { this.sessionList?.render?.(); } catch (_) {}
                });
                // React to session links menu visibility preference changes
                appStore.subscribe('preferences.links.showSessionToolbarMenu', () => {
                    try {
                        const sid = this.getActiveEffectiveSessionId?.();
                        const sd = sid ? this.getAnySessionData?.(sid) : null;
                        this.updateSessionLinks(sd || {});
                    } catch (_) {}
                });
                // React to sidebar children visibility preference changes centrally
                appStore.subscribe('preferences.display.showContainerShellsInSidebar', () => {
                    try { this.refreshSidebarChildrenForPreference(); } catch (_) {}
                });
            }
        } catch (_) { /* ignore */ }

        // Cross-window consistency for manual local titles: listen for IPC broadcast
        try {
            if (window.desktop && window.desktop.isElectron && typeof window.desktop.onLocalTitleUpdated === 'function') {
                window.desktop.onLocalTitleUpdated?.((payload) => {
                    try {
                        const sid = String((payload?.session_id || payload?.sessionId || '')).trim();
                        const title = (payload && typeof payload.title === 'string') ? payload.title : '';
                        if (!sid) return;
                        const data = this.sessionList?.getSessionData?.(sid);
                        if (data && data.local_only === true) {
                            this.sessionList.updateSessionTitle(sid, title);
                            if (this.currentSessionId === sid) this.refreshHeaderForSession(sid);
                        }
                    } catch (_) { /* ignore */ }
                });
            }
        } catch (_) { /* ignore */ }

        // Initialize workspace header state
        this.updateWorkspaceHeader();

        // Proactively restore last selected workspace in sidebar component
        try { this.workspaceListComponent?.restoreLastSelectedWorkspace?.(); } catch (_) {}

        // Initialize session tabs manager
        this.sessionTabsManager = new SessionTabsManager(this);

        // Initialize modal system
        this.initializeModals();

        // Initialize sidebar (apply saved width/collapsed and setup resizer)
        try { this.sidebar?.init?.(); } catch (_) {}

        // Setup event listeners
        this.setupEventListeners();

        // Setup WebSocket message handlers - must complete before loading sessions
        // to ensure handlers are ready for auto-attach
        await this.setupWebSocketHandlers();

        // Load active sessions on page load and auto-select first active session
        this.isInitialLoading = true; // Set flag to prevent selection during initial load
        { const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs); if (dbg) console.log('[TerminalManager] Setting isInitialLoading = true'); }
        await this.loadSessions(false, true);
        { const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs); if (dbg) console.log('[TerminalManager] Setting isInitialLoading = false'); }
        this.isInitialLoading = false; // Clear flag after loading completes
        // Ensure UI shows the Active tab by default
        const activeTabBtn = Array.from(this.elements.filterTabs || []).find(tab => tab.dataset.filter === 'active');
        if (activeTabBtn) {
            this.setActiveFilterTab(activeTabBtn);
            this.sessionList.setFilter('active');
        }
        this.updateWorkspacesFromSessions();
        this.sessionsLoaded = true;

        // Mark as initialized to prevent double loading on WebSocket connect
        this.isInitialized = true;
        
        // Restore last workspace and session selection (idempotent if already restored by sidebar)
        await this.restoreLastSelection();

        // Rehydrate local PTY sessions (Electron) so they persist across reloads
        try { await this.rehydrateLocalPtySessions(); } catch (e) { console.warn('[TerminalManager] Local PTY rehydrate failed:', e); }
        
        // Initially hide terminal controls only if no session is selected
        if (!this.currentSessionId) {
            this.viewController.hideTerminalControls();
        }
        
        // Keep terminal tabs visible by default to avoid flicker on page load.
        // Hide them a moment later only if no session is selected and we aren't
        // processing a session_id from the URL (prevents tabs briefly appearing
        // then disappearing when auto-focusing a session on load).
        try {
            if (this.getTabsToolbarElement()) {
                setTimeout(() => {
                    try {
                        if (!this.currentSessionId && !this.sessionIdParameterProcessed) {
                            this.setTabsToolbarVisibility(false);
                        }
                    } catch (_) {}
                }, 300);
            }
        } catch (_) { /* no-op */ }
        
        // Track initialization state
        this.isInitializing = true;

        // Apply saved Active filter preference (default ON) after DOM is ready
        try { this.loadActiveWorkspaceFilter(); } catch (_) {}
    }
    
    /**
     * Rehydrate local PTY sessions on startup when running inside Electron.
     * Adds them to the session list and selects the most recent if nothing is active.
     */
    async rehydrateLocalPtySessions() {
        try {
            const api = window.desktop && window.desktop.localpty;
            if (!api || typeof api.list !== 'function') return;
            const result = await api.list();
            const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
            if (!sessions.length) return;

            // Load persisted manual titles for local sessions
            let persistedTitles = {};
            let persistedDynamic = {};
            let persistedWorkspaces = {};
            try {
                const res = getStateStore().loadSync && getStateStore().loadSync();
                const st = res && res.ok ? (res.state || {}) : {};
                const map = st['local_session_titles'];
                if (map && typeof map === 'object') persistedTitles = map;
                const dmap = st['local_session_dynamic_titles'];
                if (dmap && typeof dmap === 'object') persistedDynamic = dmap;
                const wmap = st['local_session_workspaces'];
                if (wmap && typeof wmap === 'object') persistedWorkspaces = wmap;
            } catch (_) { /* ignore */ }

            const toTs = (v) => { try { return new Date(v).getTime() || 0; } catch (_) { return 0; } };
            sessions.sort((a, b) => toTs(a.createdAt) - toTs(b.createdAt));

            for (const s of sessions) {
                const sessionId = String(s.sessionId || s.session_id || '').trim();
                if (!sessionId) continue;
                if (this.sessionList?.hasSession?.(sessionId)) continue;
                const sessionData = {
                    session_id: sessionId,
                    title: '',
                    is_active: true,
                    interactive: true,
                    load_history: false,
                    save_session_history: false,
                    visibility: 'private',
                    local_only: true,
                    created_at: s.createdAt || 0,
                    working_directory: '~',
                    workspace: (() => {
                        try { const ws = persistedWorkspaces[sessionId]; if (typeof ws === 'string' && ws.trim()) return ws; } catch (_) {}
                        return this.resolveWorkspaceForLocalSession();
                    })()
                };
                try { this.sessionList?.addSession?.(sessionData, false); } catch (_) {}
                // Apply persisted manual title if available
                try {
                    const t = persistedTitles[sessionId];
                    if (typeof t === 'string') {
                        this.sessionList.updateSessionTitle(sessionId, t);
                    }
                } catch (_) { /* ignore */ }
                // Apply persisted dynamic title if available (for sidebar/tabs/window title on reload)
                try {
                    const d = persistedDynamic[sessionId];
                    if (typeof d === 'string' && d) {
                        this.sessionList.updateSession({ session_id: sessionId, dynamic_title: d });
                    }
                } catch (_) { /* ignore */ }
            }

            if (!this.currentSessionId) {
                const newest = sessions[sessions.length - 1];
                const sid = newest && (newest.sessionId || newest.session_id);
                if (sid) {
                    try { await this.selectSession(String(sid), { restored: true }); } catch (_) {}
                }
            }
        } catch (e) {
            console.warn('[TerminalManager] Failed to rehydrate local PTY sessions:', e);
        }
    }

    /**
     * Initialize the new modal system to replace existing modals
     */
    initializeModals() {
        // Initialize new session form modal
        this.newSessionModal = new FormModal({
            element: this.elements.modal,
            title: 'Create Session',
            autoClose: false,
            onSubmit: (formData) => this.handleNewSessionSubmit(formData),
            onValidate: (formData) => this.validateNewSessionForm(formData)
        });

        // Initialize multi-template confirmation modal
        try {
            const mtEl = this.elements.multipleTemplatesModal;
            if (mtEl) {
                this.multiTemplatesConfirmModal = new ConfirmationModal({
                    element: mtEl,
                    title: 'Confirm Multiple Commands',
                    message: 'Are you sure you want to run multiple commands?',
                    confirmText: 'Run',
                    cancelText: 'Cancel',
                    destructive: false,
                    onConfirm: () => {
                        // Hide the underlying New Session modal immediately to avoid any flash
                        try { this.newSessionModal.hide(); } catch (_) {}
                        // Now close the confirmation modal itself
                        try { this.multiTemplatesConfirmModal.hide(); } catch (_) {}
                        // Proceed with creation
                        this.createNewSession();
                    },
                    onCancel: () => {
                        // No action; keep New Session modal open for edits
                    }
                });

                // While the confirm modal is open, temporarily hide the New Session modal
                try {
                    this.multiTemplatesConfirmModal.on('show', () => {
                        const parent = document.getElementById('new-session-modal');
                        if (parent) parent.classList.add('temporarily-hidden');
                    });
                    this.multiTemplatesConfirmModal.on('hide', () => {
                        const parent = document.getElementById('new-session-modal');
                        if (parent) parent.classList.remove('temporarily-hidden');
                    });
                } catch (_) { /* ignore */ }
            }
        } catch (e) {
            console.warn('Failed to initialize multi-templates confirm modal:', e);
        }

        // Initialize new workspace modal
        try {
            const wsModalEl = document.getElementById('new-workspace-modal');
            if (wsModalEl) {
                this.newWorkspaceModal = new FormModal({
                    element: wsModalEl,
                    title: 'Create Workspace',
                    autoClose: false,
                    onSubmit: async (formData) => {
                        const nameRaw = formData['new-workspace-name'] || '';
                        const name = (nameRaw || '').trim();
                        if (!name || name.toLowerCase() === 'default') {
                            const err = document.getElementById('new-workspace-error');
                            if (err) { err.textContent = 'Invalid name'; err.style.display = 'block'; }
                            return;
                        }
                        // Clear any prior error
                        const err = document.getElementById('new-workspace-error');
                        if (err) { err.textContent = ''; err.style.display = 'none'; }
                        try {
                            await apiService.createWorkspace(name);
                            // Select the new workspace for convenience
                            if (this.enterWorkspace) this.enterWorkspace(name);
                            // Close sidebar on mobile
                            if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
                                const app = getContext()?.app;
                                app?.hideMobileSidebar?.();
                            }
                            // Close modal on success
                            this.newWorkspaceModal.hide();
                        } catch (e) {
                            const msg = e?.message || 'Failed to create workspace';
                            if (err) { err.textContent = msg; err.style.display = 'block'; }
                        }
                    },
                    onValidate: (formData) => {
                        const nameRaw = formData['new-workspace-name'] || '';
                        const name = (nameRaw || '').trim();
                        return Boolean(name) && name.toLowerCase() !== 'default';
                    }
                });
            }
        } catch (e) {
            console.warn('Failed to initialize new workspace modal:', e);
        }

        // Initialize move to workspace modal
        try {
            const moveEl = document.getElementById('move-workspace-modal');
            if (moveEl) {
                this.moveWorkspaceModal = new FormModal({
                    element: moveEl,
                    title: 'Move to Workspace',
                    autoClose: true,
                    onSubmit: async (formData) => {
                        await this.handleMoveWorkspaceSubmit(formData);
                    }
                });
            }
        } catch (e) {
            console.warn('Failed to initialize move workspace modal:', e);
        }

        // Initialize terminate confirmation modal
        this.terminateModal = new ConfirmationModal({
            element: this.elements.terminateModal,
            title: 'Terminate Session',
            message: 'Are you sure you want to terminate this terminal session? This action cannot be undone.',
            confirmText: 'Terminate',
            cancelText: 'Cancel',
            destructive: true,
            onConfirm: () => this.confirmTerminate(),
            onCancel: () => this.hideTerminateModal()
        });

        // Initialize delete confirmation modal
        this.deleteModal = new ConfirmationModal({
            element: this.elements.deleteModal,
            title: 'Delete Session History',
            message: 'Are you sure you want to delete this session\'s history and logs? This will permanently remove all terminal output and metadata. This action cannot be undone.',
            confirmText: 'Delete',
            cancelText: 'Cancel',
            destructive: true,
            onConfirm: () => this.confirmDelete(),
            onCancel: () => this.hideDeleteModal()
        });

        // Initialize text input modal (using InputModal)
        this.textInputModal = new InputModal({
            element: this.elements.textInputModal,
            inputType: 'text',
            multiline: true,
            onSubmit: (formData) => this.handleTextInputSubmit(formData)
        });
        try { this.textInputModal?.inputElement?.addEventListener('input', () => this.updateTextInputState()); } catch (_) {}
        try { this.elements?.textInputIncluded?.addEventListener('input', () => this.updateTextInputState()); } catch (_) {}
        // Wire up Send Text modal controls
        try { this.elements?.textInputClear?.addEventListener('click', () => this.clearTextInputText()); } catch (_) {}
        try { this.elements?.textInputCopy?.addEventListener('click', () => this.copyTextInputText()); } catch (_) {}
        this.updateTextInputState();

        // Track optional included text shown above the text input
        this._includedSendText = '';
        // Optional target override for sending text (e.g., Shift-select from a child targets its parent)
        this._textInputTargetOverride = null;
        // Optional selection source session id (where the xterm selection occurred)
        this._textInputSelectionSource = null;
        
        // Listen for modal hide events to update button state and clear persisted state
        this.textInputModal.on('hide', () => {
            // Update toggle button state when modal is closed via X button
            const textInputBtn = document.getElementById('text-input-btn');
            textInputBtn?.classList.remove('active');
            
            // Clear toggle state when modal is closed via X button
            try { queueStateSet('textInputModalVisible', false, 200); } catch (_) {}

            // Clear the main input when the modal is closed (any reason)
            try { this.textInputModal.setValue(''); } catch (_) {}

            // Clear included text when modal closes
            try { this.setIncludedSendText(''); } catch (_) {}
            // Clear target override and selection source on close
            this._textInputTargetOverride = null;
            this._textInputSelectionSource = null;

            // Update button enabled/disabled state after clearing
            try { this.updateTextInputState(); } catch (_) {}
        });
    }

    async showMoveWorkspaceModal() {
        if (!this.currentSessionId) {
            console.warn('[Manager] No active session selected to move');
            return;
        }
        try {
            // Populate workspaces into select
            const select = document.getElementById('move-workspace-select');
            const addBtn = document.getElementById('move-workspace-add-btn');
            if (select) {
                const names = this.getWorkspaceNames();
                const filtered = names.filter(n => n && n !== 'Default');
                select.innerHTML = '';
                // Empty option signifies Default
                const emptyOpt = document.createElement('option');
                emptyOpt.value = '';
                emptyOpt.textContent = 'Default';
                select.appendChild(emptyOpt);
                filtered.forEach(name => {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    select.appendChild(opt);
                });
                // Preselect the session's current workspace
                let ws = '';
                try {
                    const state = this.sessionList?.store?.getState();
                    const data = state?.sessionList?.sessions?.get(this.currentSessionId);
                    ws = (data && data.workspace && data.workspace !== 'Default') ? data.workspace : '';
                } catch (_) {}
                select.value = ws;
            }
            if (addBtn) {
                const inline = document.getElementById('move-workspace-add-inline');
                const addInput = document.getElementById('move-workspace-add-input');
                const addConfirm = document.getElementById('move-workspace-add-confirm');
                const addCancel = document.getElementById('move-workspace-add-cancel');
                const addError = document.getElementById('move-workspace-add-error');

                const hideInline = () => {
                    if (inline) inline.style.display = 'none';
                    if (addInput) addInput.value = '';
                    if (addError) { addError.style.display = 'none'; addError.textContent = ''; }
                };
                const showInline = () => {
                    if (inline) inline.style.display = 'flex';
                    if (addInput) { addInput.value = ''; addInput.focus(); }
                    if (addError) { addError.style.display = 'none'; addError.textContent = ''; }
                };
                const addWorkspace = async () => {
                    if (!addInput) return;
                    const name = (addInput.value || '').trim();
                    if (!name) {
                        if (addError) { addError.textContent = 'Name is required'; addError.style.display = 'block'; }
                        return;
                    }
                    if (name.toLowerCase() === 'default') {
                        if (addError) { addError.textContent = 'Use empty selection for Default'; addError.style.display = 'block'; }
                        return;
                    }
                    const selectEl = document.getElementById('move-workspace-select');
                    if (selectEl && Array.from(selectEl.options).some(o => o.value === name)) {
                        if (addError) { addError.textContent = 'Workspace already exists'; addError.style.display = 'block'; }
                        return;
                    }
                    try {
                        await apiService.createWorkspace(name);
                        if (selectEl) {
                            const opt = document.createElement('option');
                            opt.value = name;
                            opt.textContent = name;
                            selectEl.appendChild(opt);
                            selectEl.value = name;
                        }
                        hideInline();
                        // Focus select so pressing Enter now submits the modal
                        if (selectEl) {
                            selectEl.focus();
                        } else if (this.moveWorkspaceModal && this.moveWorkspaceModal.form) {
                            this.moveWorkspaceModal.form.focus();
                        }
                    } catch (err) {
                        if (addError) { addError.textContent = err?.message || 'Failed to create workspace'; addError.style.display = 'block'; }
                    }
                };

                addBtn.onclick = (e) => { e.preventDefault(); showInline(); };
                if (addConfirm) addConfirm.onclick = (e) => { e.preventDefault(); addWorkspace(); };
                if (addCancel) addCancel.onclick = (e) => { e.preventDefault(); hideInline(); };
                if (addInput) addInput.onkeydown = (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addWorkspace(); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideInline(); }
                };
            }
        } catch (e) {
            console.warn('Failed to populate workspace list for move modal:', e);
        }

        this.moveWorkspaceModal?.show();
    }

    async handleMoveWorkspaceSubmit(formData) {
        try {
            if (!this.currentSessionId) return;
            const nameRaw = formData['move-workspace'] || '';
            const target = (nameRaw || '').trim();
            const wsName = target || 'Default';

            // Use SessionList helper which handles local-only sessions on Electron
            if (this.sessionList && typeof this.sessionList.assignToWorkspace === 'function') {
                this.sessionList.assignToWorkspace(this.currentSessionId, wsName);
            } else {
                await apiService.updateSessionWorkspace(this.currentSessionId, wsName);
            }

            // Switch view to the target workspace for clarity
            if (this.enterWorkspace) this.enterWorkspace(wsName);
            // Keep the same session selected after move
            try { this.sessionList?.setActiveSession?.(this.currentSessionId); } catch (_) {}
        } catch (e) {
            console.error('Failed to move session to workspace:', e);
            notificationDisplay.show({ title: 'Move Failed', message: e?.message || 'Unable to move session', notification_type: 'error' });
        }
    }
    
    /**
     * Called after all initialization is complete to trigger auto-selection
     * of the first terminal if no session is currently selected
     */
    async handleInitialAutoSelection() {
        // Skip auto-selection if a session_id URL parameter was processed
        if (this.sessionIdParameterProcessed) {
            this.isInitializing = false;
            
            // Ensure the sidebar selection is preserved for the already-selected session
            if (this.currentSessionId) {
                this.sessionList.setActiveSession(this.currentSessionId);
            }
            return;
        }
        
        // Don't auto-load or auto-select sessions - Issue #349
        // User will manually load sessions via the session list
        
        this.isInitializing = false;
        
        // Ensure the sidebar selection is preserved after initialization completes
        if (this.currentSessionId) {
            this.sessionList.setActiveSession(this.currentSessionId);
        }
    }

    /**
     * Auto-select the first session for a tab when no saved session exists
     * @param {string} filter - The filter type ('active' or 'inactive')
     */
    async autoSelectFirstSessionForTab(filter) {
        try {
            // Get visible sessions using SessionFilterService
            const allSessions = this.sessionList.getAllSessions();
            const filters = {
                status: filter,
                search: '',
                template: 'all',
                pinned: false,
                pinnedSessions: this.sessionList.store.getState().sessionList.filters.pinnedSessions
            };
            
            const visibleSessions = SessionFilterService.filter(allSessions, filters);
            
            if (visibleSessions.length > 0) {
                // Sort sessions with pinned first
                const sortedSessions = this.sortSessionsWithPins(visibleSessions);
                const firstSession = sortedSessions[0];
                // Save this selection for the tab
                this.updateTabSelection(firstSession.session_id, filter === 'active');
                // Select the session
                await this.selectSession(firstSession.session_id);
            } else {
                // No sessions available in this tab, clear terminal
                this.clearTerminalView();
            }
        } catch (error) {
            console.error('Error auto-selecting first session for tab:', error);
            this.clearTerminalView();
        }
    }

    setupEventListeners() {
        // New session button
        this.elements.newSessionBtn.addEventListener('click', async () => {
            // Load sessions if not already loaded
            if (!this.sessionsLoaded) {
                await this.loadSessions(false, true);
                this.sessionsLoaded = true;
            }
            this.showNewSessionModal();
        });

        // New local session button (feature-gated)
        try {
            const canLocal = !!(window.desktop && window.desktop.isElectron && window.desktop.localpty);
            // Feature flag from authenticated user profile
            let allowFeature = false;
            try { allowFeature = !!(appStore.getState()?.auth?.features?.local_terminal_enabled === true); } catch (_) { allowFeature = false; }
            const btn = this.elements.newLocalSessionBtn;
            if (btn) {
                btn.style.display = (canLocal && allowFeature) ? '' : 'none';
                if (canLocal && allowFeature) {
                    btn.addEventListener('click', async () => {
                        try {
                            await this.createLocalSession();
                        } catch (e) {
                            console.warn('[TerminalManager] createLocalSession failed:', e);
                        }
                    });
                }
            }
        } catch (_) { /* ignore */ }

        // New workspace button -> open modal
        if (this.elements.newWorkspaceBtn) {
            this.elements.newWorkspaceBtn.addEventListener('click', () => {
                if (this.newWorkspaceModal) {
                    // Reset field value
                    try { this.newWorkspaceModal.setFieldValue('new-workspace-name', ''); } catch (_) {}
                    // Clear error
                    try { const err = document.getElementById('new-workspace-error'); if (err) { err.textContent=''; err.style.display='none'; } } catch (_) {}
                    this.newWorkspaceModal.show();
                }
            });
        }

        // Back to workspaces button
        if (this.elements.workspacesBackBtn) {
            this.elements.workspacesBackBtn.addEventListener('click', () => {
                this.showWorkspaceList();
            });
        }

        // Deselect workspace when clicking empty space in the workspace list
        if (this.elements.workspaceList) {
            this.elements.workspaceList.addEventListener('click', (e) => {
                // Ignore clicks on workspace items or context menus
                const onItem = e.target.closest('.workspace-item');
                const onMenu = e.target.closest('.workspace-context-menu');
                if (onItem || onMenu) return;
                // Clicking empty area should deselect current workspace and show all tabs
                this.showWorkspaceList();
            });
        }

        // Initialize mobile interface manager
        this.mobileInterface.initialize(this.elements, this.textInputModal);

        // Initialize toolbar/links/search controllers
        this.toolbarController.init();
        this.linksController.init();
        try { this.searchController.init(); } catch (e) { console.warn('[TerminalManager] TerminalSearchController init failed:', e); }

        // Handle form submission (works for both Enter key and button click)
        // Form submission is now handled by the new modal system

        // Setup global keyboard shortcuts for terminal navigation
        this.setupKeyboardShortcuts();

        // Filter tab event listeners
        this.elements.filterTabs.forEach(tab => {
            tab.addEventListener('click', async () => {
                const filter = tab.dataset.filter;

                // Route inactive tab to History page; keep terminal sidebar active-only
                if (filter === 'inactive') {
                    { const app = getContext()?.app; app?.showPage?.('history'); }
                    return;
                }

                // Set active tab styling for terminal page
                this.setActiveFilterTab(tab);

                // Load sessions on demand if not already loaded (active-only)
                if (!this.sessionsLoaded) {
                    await this.loadSessions(false, true);
                    this.sessionsLoaded = true;
                }

                // Apply filter without reloading sessions
                this.sessionList.setFilter(filter);

                // Apply search or template filters
                if (this.searchQuery) {
                    await this.performSearch(true);
                } else {
                    this.updateAvailableTemplateFilters();
                    this.applyTemplateFilterToCurrentSessions();
                }

                // After filter is applied, handle session selection for this tab
                const savedSessionId = this.tabSelections[filter];
                if (savedSessionId) {
                    const sessionData = this.sessionList.getSessionData(savedSessionId);
                    if (sessionData) {
                        if (this.currentSessionId === savedSessionId && this.currentSession) {
                            this.sessionList.setActiveSession(savedSessionId);
                        } else {
                            this.selectSession(savedSessionId);
                        }
                    } else {
                        this.clearTerminalView();
                    }
                } else {
                    if (!this.isInitializing) {
                        this.autoSelectFirstSessionForTab(filter);
                    } else {
                        this.clearTerminalView();
                    }
                }

                // Update session tabs based on the new filter
                this.updateSessionTabs();
            });
        });

        // Search event listeners
        this.elements.searchInput.addEventListener('input', (event) => {
            this.handleSearchInput(event.target.value);
        });

        // Keyboard behavior for search input
        this.elements.searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                // Just remove focus; filtering already applies via debounce
                event.preventDefault();
                event.stopPropagation();
                try { this.elements.searchInput.blur(); } catch (_) {}
            } else if (event.key === 'Escape') {
                // Clear search and blur input
                event.preventDefault();
                event.stopPropagation();
                try { this.clearSearch(); } catch (_) {}
                try { this.elements.searchInput.blur(); } catch (_) {}
            }
        });

        // When search input loses focus, give focus back to terminal if attached
        this.elements.searchInput.addEventListener('blur', () => {
            try {
                if (this.currentSession && this.attachedSessions && this.attachedSessions.has(this.currentSessionId)) {
                    if (!this.currentSession.shouldPreventAutoFocus()) {
                        setTimeout(() => {
                            try { this.currentSession.focus(); } catch (_) {}
                        }, 0);
                    }
                }
            } catch (_) {}
        });

        this.elements.searchClear.addEventListener('click', () => {
            this.clearSearch();
        });

        // Drag-and-drop: allow dropping a sidebar session onto the xterm area
        try {
            let _dragHoverXtermEl = null;
            const setXtermHover = (el) => {
                try {
                    if (_dragHoverXtermEl && _dragHoverXtermEl !== el) {
                        _dragHoverXtermEl.classList.remove('xterm-drop-hover');
                    }
                    _dragHoverXtermEl = el || null;
                    if (_dragHoverXtermEl) {
                        _dragHoverXtermEl.classList.add('xterm-drop-hover');
                    }
                } catch (_) { /* ignore */ }
            };
            const allowDrop = (ev) => {
                try {
                    // Only when dragging over an xterm area (no validity gating at hover)
                    const xtermEl = ev?.target?.closest?.('.xterm') || null;
                    if (!xtermEl) { setXtermHover(null); return; }
                    setXtermHover(xtermEl);
                } catch (_) { /* ignore */ }
                ev.preventDefault();
                try { if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; } catch (_) {}
            };
            const handleDragEnter = (ev) => {
                try {
                    const xtermEl = ev?.target?.closest?.('.xterm') || null;
                    if (!xtermEl) { setXtermHover(null); return; }
                    ev.preventDefault();
                    setXtermHover(xtermEl);
                    try { if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; } catch (_) {}
                } catch (_) { /* ignore */ }
            };
            const handleDragLeave = (_ev) => {
                // Be forgiving: clear highlight to avoid sticky hover
                setXtermHover(null);
            };
            const handleDrop = async (ev) => {
                try {
                    // Ensure drop is on an xterm area
                    const xtermEl = (ev && ev.target && typeof ev.target.closest === 'function') ? ev.target.closest('.xterm') : null;
                    if (!xtermEl) return;
                    ev.preventDefault();
                    setXtermHover(null);
                    let data = (ev.dataTransfer && ev.dataTransfer.getData && ev.dataTransfer.getData('text/plain')) || '';
                    let sourceSid = String(data || '').trim();
                    let sourceClientId = '';
                    // Cross-window fallback: query desktop global drag state when needed
                    if (!sourceSid && window.desktop && window.desktop.isElectron && window.desktop.drag && typeof window.desktop.drag.getSession === 'function') {
                        try {
                            const res = await window.desktop.drag.getSession();
                            if (res && res.ok && res.drag && res.drag.sessionId) {
                                sourceSid = String(res.drag.sessionId || '').trim();
                                sourceClientId = String(res.drag.clientId || '').trim();
                            }
                        } catch (_) {}
                    }
                    if (!sourceSid) return;
                    // Target is the effective active session (child or parent) currently displayed
                    const targetSid = (typeof this.getActiveEffectiveSessionId === 'function') ? this.getActiveEffectiveSessionId() : this.currentSessionId;
                    if (!targetSid) return;
                    if (sourceSid === targetSid) return; // ignore self-drops
                    // Only log when both are active sessions and attached in this client
                    const srcData = this.sessionList?.getSessionData?.(sourceSid);
                    const tgtData = this.getAnySessionData?.(targetSid) || this.sessionList?.getSessionData?.(targetSid);
                    const bothActive = (srcData && srcData.is_active === true) && (tgtData && tgtData.is_active === true);
                    // Attached logic: target must be attached locally; source may be attached in another window's clientId
                    let srcAttached = !!this.attachedSessions?.has?.(sourceSid);
                    try {
                        if (!srcAttached && sourceClientId) {
                            const ids = Array.isArray(srcData?.connected_client_ids) ? srcData.connected_client_ids : [];
                            srcAttached = ids.includes(sourceClientId);
                        }
                    } catch (_) { /* ignore */ }
                    const tgtAttached = !!this.attachedSessions?.has?.(targetSid);
                    const bothAttached = srcAttached && tgtAttached;
                    if (bothActive && bothAttached) {
                        console.log('[DragDrop] Sidebar session dropped on xterm', { source: sourceSid, target: targetSid });
                        try {
                            const message = `Message from peer agent ${sourceSid}: I am available to assist`;
                            await this.sendInput(targetSid, message, { enterStyle: 'none', stripFinalNewline: false, delayMs: 0 });
                            console.log('[DragDrop] Sent input to target session', { target: targetSid });
                        } catch (e) {
                            console.warn('[DragDrop] Failed to send input to target session', { target: targetSid, error: e?.message || e });
                        }
                    }
                } catch (_) { /* ignore */ }
            };
            // Bind at the terminal view root; checks ensure we only handle xterm targets
            if (this.elements && this.elements.terminalView) {
                this.elements.terminalView.addEventListener('dragenter', handleDragEnter);
                this.elements.terminalView.addEventListener('dragover', allowDrop);
                this.elements.terminalView.addEventListener('dragleave', handleDragLeave);
                this.elements.terminalView.addEventListener('drop', handleDrop);
            }
        } catch (_) { /* ignore */ }

        // Show/hide search clear button based on input
        this.elements.searchInput.addEventListener('input', () => {
            if (this.elements.searchInput.value.trim()) {
                this.elements.searchClear.style.display = 'flex';
            } else {
                this.elements.searchClear.style.display = 'none';
            }
        });

        // Pinned filter event listeners
        this.elements.pinnedFilterBtn.addEventListener('click', () => {
            this.togglePinnedFilter();
        });

        // Active workspaces filter event listeners
        const activeBtn = document.getElementById('active-filter-btn');
        if (activeBtn) {
            activeBtn.addEventListener('click', () => {
                this.toggleActiveWorkspaceFilter();
            });
        }

        // Template filter event listeners
        this.elements.templateFilterClear.addEventListener('click', () => {
            this.clearTemplateFilter();
        });

        // Modal keyboard shortcuts (only Escape now)
        this.elements.modal.addEventListener('keydown', (event) => {
            // Prevent key events inside modal from reaching global handlers
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                this.hideModal();
            }
        });

        // Removed legacy Escape handlers for terminate/delete modals (handled by ConfirmationModal)

        // Text input modal keyboard shortcuts
        this.elements.textInputModal.addEventListener('keydown', (event) => {
            // Prevent propagation so global handlers don't interfere while modal is open
            event.stopPropagation();
            // Only Ctrl+Enter sends text (Escape is removed since modal doesn't auto-close)
            if (event.key === 'Enter' && event.ctrlKey) {
                event.preventDefault();
                this.sendTextInputText();
                return;
            }
            // ESC behavior while focused in the main input:
            // - If there is content, clear it
            // - If empty, close the modal
            if (event.key === 'Escape') {
                try {
                    const active = document.activeElement;
                    const mainInput = this.elements?.textInputText || document.getElementById('text-input-text');
                    const isInMainInput = !!(active && mainInput && active === mainInput);
                    if (isInMainInput) {
                        const value = String(mainInput.value || '').trim();
                        event.preventDefault();
                        // Clear on non-empty; close when already empty
                        if (value.length > 0) {
                            mainInput.value = '';
                            // Keep included content intact; update Send button state
                            try { this.updateTextInputState(); } catch (_) {}
                        } else {
                            this.hideTextInputModal();
                        }
                        return;
                    }
                } catch (_) { /* fall through to default behavior */ }
            }
            // Allow toggling the Send Text modal while open: Cmd/Alt + Shift + I
            const isToggleKey = (evt) => {
                try {
                    const hasShift = !!evt.shiftKey;
                    const hasMod = !!(evt.metaKey || evt.altKey);
                    const codeI = String(evt.code || '').toLowerCase() === 'keyi';
                    const keyI = String(evt.key || '').toLowerCase() === 'i';
                    return hasShift && hasMod && (codeI || keyI);
                } catch (_) { return false; }
            };
            if (isToggleKey(event)) {
                event.preventDefault();
                // While open, shortcut closes the modal
                this.hideTextInputModal();
                return;
            }
        });

        // Note: Global click handler removed since we now use a backdrop

        // WebSocket events
        // Note: WebSocket messages are now handled directly via the registry in WebSocketService
        // No need for EventBus listener anymore
        
        // When the socket disconnects, mark all local sessions as detached so
        // subsequent reattach attempts actually send an attach message.
        this.eventBus.on('ws:disconnected', () => {
            try {
                if (this.sessions && typeof this.sessions.forEach === 'function') {
                    this.sessions.forEach((session) => {
                        try { if (session) session.isAttached = false; } catch (_) {}
                    });
                }
                // Reset compatibility tracking; preserve attachedSessions set so we know what to reattach
                this.connectedSessionId = null;
            } catch (_) { /* ignore */ }
        });

        this.eventBus.on('ws:connected', async () => {
            // Only reload sessions when reconnected if we were already initialized
            // This prevents double loading during initial connection
            if (this.isInitialized) {
                await this.loadSessions(true, true);

                // Ensure the actively viewed session is fully reattached using
                // TerminalSession.attach() so the history sync handshake completes
                // (required for stdout to resume after reconnects).
                try {
                    if (this.currentSessionId && this.attachedSessions && this.attachedSessions.has(this.currentSessionId)) {
                        const active = this.sessions && typeof this.sessions.get === 'function' ? this.sessions.get(this.currentSessionId) : null;
                        if (active && typeof active.attach === 'function') {
                            await active.attach(true);
                        } else if (typeof this.attachToCurrentSession === 'function') {
                            await this.attachToCurrentSession();
                        }
                    }
                } catch (e) {
                    console.warn('[TerminalManager] Failed to reattach active session on reconnect:', e);
                }
            }
        });

        // Handle terminal reload requests from TabManager
        this.eventBus.on('terminal-reload', async (data) => {
            console.log(`[TerminalManager] Handling terminal-reload for session ${data.sessionId}, tab ${data.tabId}`);
            try {
                await this.refreshActiveTerminal();
            } catch (e) {
                console.warn('[TerminalManager] refreshActiveTerminal failed:', e);
                // Fallback to visual reload to avoid leaving terminal in a bad state
                if (this.currentSession && this.currentSessionId === data.sessionId) {
                    this.reloadTerminalDisplay(this.currentSession, 'manual reload fallback');
                }
            }
        });

        // After a terminal (parent or container child) reports ready, ensure it is
        // properly sized and focused if it is the currently visible tab.
        this.eventBus.on('terminal-ready', (payload) => {
            try {
                const sid = payload && payload.sessionId ? String(payload.sessionId) : null;
                if (!sid) return;
                const tabMgr = this.getTabManager();

                // If this is a child container session and its tab is active, refit and focus
                if (this.isChildSession?.(sid)) {
                    const isActiveChild = this.activeChildSessionId === sid;
                    const isActiveTab = tabMgr && (tabMgr.activeTabId === `container-${sid}`);
                    if (isActiveChild && isActiveTab) {
                        const childSession = this.sessions.get(sid) || null;
                        if (childSession) {
                            this.ensureFitAndFocus(childSession, 'terminal-ready child');
                        }
                    }
                    return;
                }

                // Otherwise handle the main session terminal if it's the active terminal tab
                if (sid === this.currentSessionId && tabMgr && tabMgr.activeTabId === 'terminal') {
                    const sess = this.currentSession || null;
                    if (sess) {
                        this.ensureFitAndFocus(sess, 'terminal-ready parent');
                    }
                }
            } catch (e) {
                console.warn('[TerminalManager] terminal-ready post-fit failed:', e);
            }
        });

        // Handle tab switching (terminal, container, links)
        this.eventBus.on('tab-switched', (data) => {
            console.log(`[TerminalManager] Handling tab-switched event for tab ${data.tabId}`);

            const tabManager = this.getTabManager();

            if (data.tab && data.tab.type === 'terminal') {
                if (this.currentSessionId === data.tab.sessionId && tabManager && typeof tabManager.getSavedTabId === 'function') {
                    const desiredTabId = tabManager.getSavedTabId(this.currentSessionId);
                    console.log(`[TerminalManager] Saved tab for session ${this.currentSessionId}: ${desiredTabId}`);
                    if (desiredTabId && desiredTabId !== 'terminal') {
                        const restored = tabManager.activateSavedTabForSession(this.currentSessionId, { forceSwitch: true });
                        if (restored && restored.type !== 'terminal') {
                            console.log('[TerminalManager] Restored saved tab instead of reloading terminal');
                            return;
                        }
                    }
                }

                console.log(`[TerminalManager] Switched to terminal tab, performing auto-reload`);

                if (this.currentSession && this.currentSessionId === data.tab.sessionId) {
                    this.reloadTerminalDisplay(this.currentSession, 'tab switch');
                }
                this.activeChildSessionId = null;
            } else if (data.tab && data.tab.type === 'container') {
                const childId = data.tab.childSessionId;
                if (childId) {
                    // Always mark the active child so toolbar/shortcuts apply to this container session
                    this.activeChildSessionId = childId;

                    const tabMgr = this.getTabManager();
                    const parentId = this.currentSessionId;
                    const viewEl = tabMgr?.getContainerViewElement?.(parentId, childId) || null;
                    const sessionObj = this.sessions.get(childId) || null;
                    const isAttached = (sessionObj && sessionObj.isAttached === true) || (this.attachedSessions?.has?.(childId) === true);
                    const hasXterm = !!(viewEl && viewEl.querySelector && viewEl.querySelector('.xterm'));

                    // If already attached and view has xterm, ensure proper sizing and focus now that it's visible
                    if (isAttached && hasXterm) {
                        this._debug?.log?.('tab-switched: container attached; refitting and focusing', { childId });
                        this.ensureFitAndFocus(sessionObj, 'container tab switch');
                        return;
                    }

                    // If attached but view is missing xterm (placeholder or stale), rebind without history
                    if (isAttached && !hasXterm) {
                        this._debug?.log?.('tab-switched: container attached but view empty, rebinding', { childId });
                        this.attachChildSession(childId, { markActive: true, focus: true, _forceNoHistory: true })
                            .catch((error) => { console.error(`[TerminalManager] Failed to rebind container session ${childId}:`, error); });
                        return;
                    }

                    // Not attached: honor auto-attach preference and suppression
                    let autoAttach = false;
                    try { autoAttach = appStore.getState('preferences.terminal.autoAttachOnSelect') === true; } catch (_) {}
                    const suppressed = this._suppressedChildAttach.has(childId) === true;
                    if (autoAttach && !suppressed) {
                        this.attachChildSession(childId, { markActive: true, focus: true }).catch((error) => {
                            console.error(`[TerminalManager] Failed to activate container session ${childId}:`, error);
                        });
                    } else {
                        this._debug?.log?.('tab-switched: not auto-attaching (autoAttach off or suppressed)', { childId, autoAttach, suppressed });
                        try { this.showContainerAttachPrompt(childId); } catch (_) {}
                    }
                }
            } else {
                this.activeChildSessionId = null;
                // Remove any pending Enter handlers for container attach prompts when leaving container tab
                try {
                    if (this._attachKeyHandlers && this._attachKeyHandlers.size > 0) {
                        this._attachKeyHandlers.forEach((fn, cid) => {
                            try { document.removeEventListener('keydown', fn, true); } catch (_) {}
                        });
                        this._attachKeyHandlers.clear();
                    }
                } catch (_) {}
            }
        });

        // Window resize - fit the current terminal to new size (only when visible)
        window.addEventListener('resize', () => {
            // Debounce resize events to avoid excessive calls
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = setTimeout(() => {
                const termPageActive = !!document.getElementById('terminal-page')?.classList.contains('active');
                if (termPageActive && this.currentSession) {
                    const el = this.currentSession.container;
                    const visible = !!(el && el.offsetParent !== null);
                    if (visible) this.currentSession.fit();
                } else if (this.viewController.historyTerminal && this.viewController.historyFitAddon) {
                    // Fit history terminal if viewing history
                    this.viewController.fitHistoryTerminal();
                }
            }, 100);
        });
        
        // Handle mobile keyboard open/close via Visual Viewport API
        if ('visualViewport' in window) {
            // Use immediate dynamic resizing instead of debouncing to prevent scrolling
            let isResizing = false;
            let lastHeight = window.visualViewport.height;
            
            const handleViewportResize = () => {
                const currentHeight = window.visualViewport.height;
                const windowHeight = window.innerHeight;
                
                // Skip if height hasn't changed
                if (Math.abs(currentHeight - lastHeight) < 1) return;
                lastHeight = currentHeight;
                
                // Immediately adjust layout to prevent scrolling
                this.adjustLayoutForKeyboard(currentHeight, windowHeight);
                
                // Cancel any pending resize
                if (this.resizeAnimationFrame) {
                    cancelAnimationFrame(this.resizeAnimationFrame);
                }
                
                // Use requestAnimationFrame for smooth terminal resizing
                this.resizeAnimationFrame = requestAnimationFrame(() => {
                    const termPageActive = !!document.getElementById('terminal-page')?.classList.contains('active');
                    if (termPageActive && this.currentSession) {
                        const el = this.currentSession.container;
                        const visible = !!(el && el.offsetParent !== null);
                        if (visible) this.currentSession.fit();
                    } else if (this.viewController.historyTerminal && this.viewController.historyFitAddon) {
                        this.viewController.fitHistoryTerminal();
                    }
                });
            };
            
            // Listen to resize events for immediate response
            window.visualViewport.addEventListener('resize', handleViewportResize);
            
            // Also handle scroll events which can occur during keyboard opening
            window.visualViewport.addEventListener('scroll', () => {
                // Prevent unwanted scrolling by resetting scroll position
                if (window.visualViewport.offsetTop > 0) {
                    window.scrollTo(0, 0);
                }
            }, { passive: true });
        } else {
            // Fallback for browsers without Visual Viewport API
            // Use window resize detection for immediate response
            let lastHeight = window.innerHeight;
            let resizeTimer = null;
            
            const handleWindowResize = () => {
                const currentHeight = window.innerHeight;
                const heightDiff = lastHeight - currentHeight;
                
                // Immediately adjust layout for any height change
                this.adjustLayoutForKeyboard(currentHeight, lastHeight);
                
                // Clear any pending timer
                if (resizeTimer) {
                    clearTimeout(resizeTimer);
                }
                
                // Schedule terminal fit after resize stabilizes
                resizeTimer = setTimeout(() => {
                    const termPageActive = !!document.getElementById('terminal-page')?.classList.contains('active');
                    if (termPageActive && this.currentSession) {
                        const el = this.currentSession.container;
                        const visible = !!(el && el.offsetParent !== null);
                        if (visible) this.currentSession.fit();
                    } else if (this.viewController.historyTerminal && this.viewController.historyFitAddon) {
                        this.viewController.fitHistoryTerminal();
                    }
                    lastHeight = currentHeight;
                }, 100);
            };
            
            // Listen for window resize (triggered by keyboard open/close on some devices)
            window.addEventListener('resize', handleWindowResize);
            
            // Also handle orientation changes
            window.addEventListener('orientationchange', () => {
                setTimeout(handleWindowResize, 100);
            });
        }
    }

    async setupWebSocketHandlers() {
        console.log('[TerminalManager] Setting up WebSocket handlers...');

        // Wait for the WebSocket service's message registry to be initialized
        const registry = await this.wsClient.waitForMessageRegistry();

        // If registry is not available (disabled), skip setup
        if (!registry) {
            console.log('[TerminalManager] Message registry not available, skipping handler setup');
            return;
        }

        // Store registry reference
        this.messageRegistry = registry;

        // Import handlers with cache busting
        const handlers = await import(`../websocket/handlers/index.js?v=${Date.now()}`);
        
        // Register handlers with proper context
        const context = {
            terminalManager: this,
            eventBus: this.eventBus,
            notificationCenter: notificationDisplay,
            websocketService: this.wsClient,
            notificationDisplay: notificationDisplay
        };
        
        // Register each handler type with validation
        registry.register('error', (message) => handlers.errorHandler.handle(message, context));
        
        registry.register('notification', (message) => handlers.notificationHandler.handle(message, context));
        
        registry.register('stdout', (message) => handlers.stdoutHandler.handle(message, context), {
            validation: {
                required: ['session_id', 'data'],
                types: {
                    session_id: 'string',
                    data: 'string'
                }
            }
        });
        
        // Server-sent session activity (active/inactive) notifications
        registry.register('session_activity', (message) => handlers.sessionActivityHandler.handle(message, context), {
            validation: {
                required: ['session_id', 'activity_state'],
                types: {
                    session_id: 'string',
                    activity_state: 'string'
                }
            }
        });
        
        registry.register('session_updated', async (message) => await handlers.sessionUpdatedHandler.handle(message, context), {
            validation: {
                required: ['session_data', 'update_type'],
                types: {
                    update_type: 'string'
                }
            }
        });
        
        // 'session_resumed' is deprecated; creation flows are handled via 'session_updated' (update_type: 'created')
        
        registry.register('link-updated', (message) => handlers.linkUpdatedHandler.handle(message, context), {
            validation: {
                required: ['sessionId', 'url', 'name'],
                types: {
                    sessionId: 'string',
                    url: 'string',
                    name: 'string'
                }
            }
        });
        
        registry.register('link-removed', (message) => handlers.linkRemovedHandler.handle(message, context), {
            validation: {
                required: ['sessionId', 'url'],
                types: {
                    sessionId: 'string',
                    url: 'string'
                }
            }
        });
        
        // Register handler for 'attached' message type
        registry.register('attached', (message) => handlers.attachedHandler.handle(message, context));

        // Remove session from UI when server instructs (e.g., visibility -> private for non-owners)
        registry.register('session_removed', (message) => handlers.sessionRemovedHandler.handle(message, context), {
            validation: {
                required: ['session_id'],
                types: { session_id: 'string' }
            }
        });
        
        // Register handler for 'detached' message type
        registry.register('detached', (message) => handlers.sessionDetachedHandler.handle(message, context));
        
        // Register shutdown handler
        registry.register('shutdown', (message) => handlers.shutdownHandler.handle(message, context));

        // Register workspaces update handler (server-driven workspace list changes)
        registry.register('workspaces_updated', (message) => handlers.workspacesUpdatedHandler.handle(message, context), {
            validation: {
                // workspaces array optional (handler will fetch if absent)
                types: {
                    action: 'string'
                }
            }
        });

        // Register sessions reordered handler
        registry.register('sessions_reordered', (message) => handlers.sessionsReorderedHandler.handle(message, context), {
            validation: {
                required: ['workspace', 'order']
            }
        });

        // Register handler for stdin_injected notifications (agent-to-agent input)
        registry.register('stdin_injected', (message) => handlers.stdinInjectedHandler.handle(message, context), {
            validation: {
                required: ['session_id'],
                types: {
                    session_id: 'string'
                }
            }
        });
        
        // Scheduled input rule lifecycle updates (no-op for now other than logging)
        registry.register('scheduled_input_rule_updated', (message) => handlers.scheduledInputRuleUpdatedHandler.handle(message, context), {
            // No strict validation yet; backend shape may evolve
        });

        // Deferred input queue lifecycle updates
        registry.register('deferred_input_updated', (message) => handlers.deferredInputUpdatedHandler.handle(message, context), {
            validation: {
                required: ['session_id', 'action'],
                types: {
                    session_id: 'string',
                    action: 'string'
                }
            }
        });

        // Interactive notification action result acknowledgements
        registry.register('notification_action_result', (message) => handlers.notificationActionResultHandler.handle(message, context), {
            validation: {
                required: ['notification_id', 'action_key', 'ok'],
                types: {
                    notification_id: 'string',
                    action_key: 'string',
                    ok: 'boolean'
                }
            }
        });

        // Notification metadata/response updates (e.g., canceled)
        registry.register('notification_updated', (message) => handlers.notificationUpdatedHandler.handle(message, context), {
            validation: {
                required: ['notification_id'],
                types: {
                    notification_id: 'string'
                }
            }
        });
        
        // (duplicate session_activity registration removed; defined earlier around 1789)
        
        // Set error handler
        registry.setErrorHandler((error, message, ctx) => {
            console.error('[WebSocket] Message handling error:', error, message);
        });

        console.log('[TerminalManager] WebSocket handlers registered successfully');
    }

    setupKeyboardShortcuts() {
        if (Array.isArray(this._shortcutDisposers)) {
            this._shortcutDisposers.forEach((dispose) => {
                try { dispose(); } catch (_) {}
            });
        }
        this._shortcutDisposers = [];

        const isSidebarSearchTarget = (element) => {
            if (!element) return false;
            if (element.id === 'session-search') return true;
            if (element.classList?.contains('search-input')) return true;
            if (typeof element.closest === 'function') {
                if (element.closest('#session-search')) return true;
                if (element.closest('.search-input')) return true;
            }
            return false;
        };

        const blurSidebarSearchIfNeeded = (element) => {
            if (!element) return;
            if (isSidebarSearchTarget(element)) {
                try { element.blur(); } catch (_) {}
            }
        };

        const isVisible = (element) => !!element && element.offsetParent !== null;

        const canHandleShortcut = () => {
            try {
                return !isAnyModalOpen();
            } catch (_) {
                return false;
            }
        };

        const baseOptions = {
            scope: 'terminal:global',
            priority: 10,
            when: () => canHandleShortcut(),
            inputAllowlist: [(el) => isSidebarSearchTarget(el)]
        };

        const registerShortcut = (config) => {
            const disposer = keyboardShortcuts.registerShortcut({
                ...baseOptions,
                ...config
            });
            this._shortcutDisposers.push(disposer);
        };

        const modShiftCombos = (key) => [`Shift+Meta+${key}`, `Shift+Alt+${key}`];
        // For numeric session switching, use Command/Alt without Shift
        const modNumCombos = (key) => [`Meta+${key}`, `Alt+${key}`];

        // Cmd/Alt + Shift + I → Toggle Send Text modal (close if open)
        registerShortcut({
            id: 'terminal.shortcut.toggle-send-text',
            description: 'Toggle Send Text modal',
            keys: [...modShiftCombos('code:KeyI')],
            preventDefault: true,
            handler: () => {
                try {
                    const modalEl = this.elements?.textInputModal;
                    if (!modalEl) return false;
                    const isOpen = !!modalEl.classList?.contains('show');
                    if (isOpen) {
                        this.hideTextInputModal();
                    } else {
                        this.showTextInputModal();
                    }
                    return true;
                } catch (_) { return false; }
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.prev-transition',
            description: 'Jump to previous activity transition',
            keys: [...modShiftCombos('code:Comma')], // Cmd/Alt + Shift + <
            preventDefault: true,
            handler: () => {
                try {
                    if (this.currentSession && typeof this.currentSession.jumpToPrevTransition === 'function') {
                        return this.currentSession.jumpToPrevTransition();
                    }
                } catch (_) {}
                return false;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.next-transition',
            description: 'Jump to next activity transition',
            keys: [...modShiftCombos('code:Period')], // Cmd/Alt + Shift + >
            preventDefault: true,
            handler: () => {
                try {
                    if (this.currentSession && typeof this.currentSession.jumpToNextTransition === 'function') {
                        return this.currentSession.jumpToNextTransition();
                    }
                } catch (_) {}
                return false;
            }
        });

        // Toggle Activity Timeline dropdown: Cmd/Alt + Shift + J
        registerShortcut({
            id: 'terminal.shortcut.toggle-transitions',
            description: 'Toggle activity timeline dropdown',
            keys: [...modShiftCombos('code:KeyJ')],
            preventDefault: true,
            handler: () => {
                try {
                    // Only toggle if controller exists and feature is allowed (container visible)
                    const el = this.elements?.sessionTransitionsContainer;
                    if (!this.transitionsController || !el) return false;
                    // If hidden, do nothing
                    const isVisible = el.style.display !== 'none';
                    if (!isVisible) return false;
                    this.transitionsController.toggle();
                    return true;
                } catch (_) { return false; }
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.activate-primary-button',
            description: 'Activate visible attach or load history button with Enter',
            match: (event) => event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey,
            preventDefault: true,
            handler: () => {
                const attachButton = document.getElementById('attach-session-btn');
                if (isVisible(attachButton)) {
                    attachButton.click();
                    return true;
                }
                const loadHistoryButton = document.getElementById('load-history-btn');
                if (isVisible(loadHistoryButton)) {
                    loadHistoryButton.click();
                    return true;
                }
                return false;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.font-increase',
            description: 'Increase terminal font size',
            keys: [...modShiftCombos('code:Equal')],
            preventDefault: true,
            handler: () => {
                this.adjustTerminalFontSize(TERMINAL_FONT_STEP);
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.font-decrease',
            description: 'Decrease terminal font size',
            keys: [...modShiftCombos('code:Minus')],
            preventDefault: true,
            handler: () => {
                this.adjustTerminalFontSize(-TERMINAL_FONT_STEP);
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.toggle-workspaces',
            description: 'Toggle expansion of all workspaces',
            keys: [...modShiftCombos('code:Backslash')],
            preventDefault: true,
            handler: () => {
                this.toggleAllWorkspacesExpansion();
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.workspace-previous',
            description: 'Navigate to previous workspace',
            keys: [...modShiftCombos('ArrowUp'), ...modShiftCombos('code:BracketLeft')],
            preventDefault: true,
            handler: (_event, context) => {
                blurSidebarSearchIfNeeded(context?.target);
                this.previousWorkspace();
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.workspace-next',
            description: 'Navigate to next workspace',
            keys: [...modShiftCombos('ArrowDown'), ...modShiftCombos('code:BracketRight')],
            preventDefault: true,
            handler: (_event, context) => {
                blurSidebarSearchIfNeeded(context?.target);
                this.nextWorkspace();
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.switch-active-tab',
            description: 'Switch to active sessions tab',
            keys: [...modShiftCombos('code:Digit9')],
            preventDefault: true,
            handler: () => {
                this.switchToTab('active');
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.switch-inactive-tab',
            description: 'Switch to inactive sessions tab',
            keys: [...modShiftCombos('code:Digit0')],
            preventDefault: true,
            // In Electron, reserve Cmd/Alt+Shift+0 for focusing the main window
            when: () => canHandleShortcut() && !(window.desktop && window.desktop.isElectron),
            handler: () => {
                this.switchToTab('inactive');
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.new-session-modal',
            description: 'Open new session modal',
            keys: [...modShiftCombos('code:KeyT')],
            preventDefault: true,
            handler: () => {
                this.showNewSessionModal();
                return true;
            }
        });

        // Cmd/Alt + Shift + M → Quick template search overlay
        registerShortcut({
            id: 'terminal.shortcut.quick-template-search',
            description: 'Quick template search overlay',
            keys: [...modShiftCombos('code:KeyM')],
            preventDefault: true,
            handler: () => {
                try {
                    if (this.templateQuickOpen?.isOpen?.()) {
                        this.templateQuickOpen.close();
                    } else {
                        this.templateQuickOpen?.open?.();
                    }
                } catch (_) {}
                return true;
            }
        });

        // Cmd/Alt + Shift + S → Toggle prompts dropdown (deferred inputs + stop inputs)
        registerShortcut({
            id: 'terminal.shortcut.toggle-prompts-dropdown',
            description: 'Toggle deferred/stop prompts dropdown for active session',
            keys: [...modShiftCombos('code:KeyS')],
            preventDefault: true,
            handler: () => {
                try {
                    this.togglePromptsDropdown();
                    return true;
                } catch (_) {
                    return false;
                }
            }
        });

        // Cmd/Alt + S → Toggle stop inputs enabled for the active session
        registerShortcut({
            id: 'terminal.shortcut.toggle-stop-inputs',
            description: 'Toggle stop inputs for active session',
            keys: [...modNumCombos('code:KeyS')],
            preventDefault: true,
            handler: async () => {
                try {
                    const sessionId = this.getActiveEffectiveSessionId?.() || this.currentSessionId;
                    if (!sessionId) return false;
                    const stopState = this.stopInputsState?.get?.(sessionId) || { enabled: true, prompts: [], rearmRemaining: 0, rearmMax: 10 };
                    const nextEnabled = stopState.enabled === false;
                    const rawRearm = Number(stopState.rearmRemaining);
                    const rearmRemaining = Number.isInteger(rawRearm) && rawRearm >= 0 ? rawRearm : undefined;
                    await apiService.setStopPromptsEnabled(sessionId, nextEnabled, rearmRemaining);
                    return true;
                } catch (_) {
                    return false;
                }
            }
        });

        
        
        // Cmd/Ctrl + Shift + N → Open new local terminal (feature-flagged)
        registerShortcut({
            id: 'terminal.shortcut.new-local-terminal',
            description: 'Open new local terminal',
            keys: [...modShiftCombos('code:KeyN')],
            preventDefault: true,
            when: () => {
                try {
                    const hasLocal = !!(window.desktop && window.desktop.localpty);
                    const feat = !!(appStore.getState()?.auth?.features?.local_terminal_enabled === true);
                    return canHandleShortcut() && hasLocal && feat;
                } catch (_) { return false; }
            },
            handler: async () => {
                try {
                    const lp = window.desktop && window.desktop.localpty;
                    if (!lp) return false;
                    if (typeof lp.openLocalTerminal === 'function') { await lp.openLocalTerminal(); return true; }
                    if (typeof lp.createLocalSession === 'function') { await lp.createLocalSession(); return true; }
                    if (typeof lp.newSession === 'function') { await lp.newSession(); return true; }
                    if (typeof lp.openNew === 'function') { await lp.openNew(); return true; }
                    // Fallback: directly create a local session (same as clicking "+ Terminal")
                    await this.createLocalSession();
                    return true;
                } catch (_) {
                    try { await this.createLocalSession(); } catch (_) {}
                    return true;
                }
            }
        });

        // Cmd + T → Open new local terminal (desktop only, feature-flagged)
        // Note: intentionally Meta-only (no Alt/Ctrl) to satisfy "Command + T" requirement
        registerShortcut({
            id: 'terminal.shortcut.new-local-terminal-cmd-t',
            description: 'Open new local terminal',
            keys: ['Meta+code:KeyT'],
            preventDefault: true,
            when: () => {
                try {
                    const hasLocal = !!(window.desktop && window.desktop.isElectron && window.desktop.localpty);
                    const feat = !!(appStore.getState()?.auth?.features?.local_terminal_enabled === true);
                    return canHandleShortcut() && hasLocal && feat;
                } catch (_) { return false; }
            },
            handler: async () => {
                try {
                    const lp = window.desktop && window.desktop.localpty;
                    if (!lp) return false;
                    if (typeof lp.openLocalTerminal === 'function') { await lp.openLocalTerminal(); return true; }
                    if (typeof lp.createLocalSession === 'function') { await lp.createLocalSession(); return true; }
                    if (typeof lp.newSession === 'function') { await lp.newSession(); return true; }
                    if (typeof lp.openNew === 'function') { await lp.openNew(); return true; }
                    await this.createLocalSession();
                    return true;
                } catch (_) {
                    try { await this.createLocalSession(); } catch (_) {}
                    return true;
                }
            }
        });

        // Cmd/Alt + Shift + Z → Clear ended sessions from the sidebar/UI
        registerShortcut({
            id: 'terminal.shortcut.clear-ended-sessions',
            description: 'Clear ended sessions from view',
            keys: [...modShiftCombos('code:KeyZ')],
            preventDefault: true,
            handler: () => {
                try {
                    if (typeof this.removeAllEndedSessionsFromUI === 'function') {
                        this.removeAllEndedSessionsFromUI();
                        return true;
                    }
                } catch (_) {
                    return false;
                }
                return false;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.terminate-session',
            description: 'Terminate active session',
            keys: [...modShiftCombos('code:KeyK')],
            preventDefault: true,
            handler: () => {
                this.terminateActiveSession();
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.end-or-detach-session',
            description: 'Close terminated session or detach active session',
            keys: [...modShiftCombos('code:KeyD')],
            preventDefault: true,
            handler: () => {
                const sessionId = (typeof this.getActiveEffectiveSessionId === 'function')
                    ? this.getActiveEffectiveSessionId()
                    : this.currentSessionId;
                if (!sessionId) {
                    return false;
                }
                const sessionData = (typeof this.getAnySessionData === 'function')
                    ? this.getAnySessionData(sessionId)
                    : this.sessionList?.getSessionData?.(sessionId);
                if (!sessionData) {
                    return false;
                }
                const isActive = sessionData.is_active !== false;
                const isAttached = this.attachedSessions?.has(sessionId) === true;

                if (!isActive) {
                    this.closeEndedSession(sessionId);
                    return true;
                }
                if (isAttached) {
                    this.detachSession(sessionId);
                    return true;
                }
                this.doTerminateSession(sessionId);
                return true;
            }
        });

        // Issue #633: Add shortcut to fully remove the active session (detach → terminate → close)
        registerShortcut({
            id: 'terminal.shortcut.remove-session',
            description: 'Detach, terminate, and close active session',
            keys: [...modShiftCombos('code:KeyX')],
            // Ensure this takes precedence over any other Shift+Meta/Alt+W binding
            priority: 30,
            preventDefault: true,
            handler: () => {
                const sessionId = (typeof this.getActiveEffectiveSessionId === 'function')
                    ? this.getActiveEffectiveSessionId()
                    : this.currentSessionId;
                if (!sessionId) {
                    return false;
                }
                this.removeSessionCompletely(sessionId);
                return true;
            }
        });

        // Removed pin toggle shortcut (Issue #1148). Pin/unpin remains available via UI menus/buttons.

        registerShortcut({
            id: 'terminal.shortcut.toggle-sidebar',
            description: 'Toggle workspace sidebar',
            keys: [...modShiftCombos('code:Slash')], // Cmd/Alt + Shift + /
            preventDefault: true,
            handler: () => {
                this.toggleSidebar();
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.show-sessions-page',
            description: 'Navigate to sessions page',
            keys: [...modShiftCombos('code:KeyS')],
            preventDefault: true,
            handler: () => {
                try { getContext()?.app?.showPage?.('terminal'); } catch (_) {}
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.show-history-page',
            description: 'Navigate to history page',
            keys: [...modShiftCombos('code:KeyH')],
            preventDefault: true,
            handler: () => {
                // History page navigation shortcut removed (Issue #58).
                return false;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.copy-workspace-path',
            description: 'Copy workspace path for active session',
            keys: [...modShiftCombos('code:KeyC')],
            preventDefault: true,
            handler: () => {
                try {
                    // Determine target session (respect child sessions when container tab is active)
                    const sessionId = (typeof this.getActiveEffectiveSessionId === 'function')
                        ? this.getActiveEffectiveSessionId()
                        : this.currentSessionId;
                    if (!sessionId) return false;

                    const sessionData = (typeof this.getAnySessionData === 'function')
                        ? this.getAnySessionData(sessionId)
                        : this.sessionList?.getSessionData?.(sessionId);
                    if (!sessionData) return false;

                    // Mirror workspace path resolution logic used by the session context menu
                    const mode = String(sessionData.isolation_mode || '').toLowerCase();
                    let workspacePathToCopy = '';
                    if (mode === 'container' || mode === 'directory') {
                        const hostPath = typeof sessionData.workspace_host_path === 'string'
                            ? sessionData.workspace_host_path.trim()
                            : '';
                        if (hostPath) {
                            workspacePathToCopy = hostPath;
                        } else if (mode === 'directory' && typeof sessionData.working_directory === 'string') {
                            const dir = sessionData.working_directory.trim();
                            if (dir) workspacePathToCopy = dir;
                        }
                    }

                    if (!workspacePathToCopy) {
                        return false;
                    }

                    TerminalAutoCopy.copyToClipboard(workspacePathToCopy, 'session');
                    return true;
                } catch (_) {
                    return false;
                }
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.switch-latest-session',
            description: 'Switch to latest session',
            keys: [...modShiftCombos('code:KeyB')],
            preventDefault: true,
            handler: () => {
                this.switchToLatestSession();
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.login-container',
            description: 'Login to container for active session',
            keys: [...modShiftCombos('code:KeyO')],
            preventDefault: true,
            when: () => {
                try {
                    const { appStore } = getContext();
                    return appStore?.getState?.()?.auth?.permissions?.sandbox_login === true;
                } catch (_) { return false; }
            },
            handler: () => {
                if (this.tabManager?.activeTabId === 'workspace-note') {
                    return false;
                }
                this.loginToSandboxContainerForActiveSession();
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.toggle-active-filter',
            description: 'Toggle active workspace filter',
            keys: [...modShiftCombos('code:KeyA')],
            preventDefault: true,
            handler: () => {
                this.toggleActiveWorkspaceFilter();
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.move-session',
            description: 'Open move session to workspace dialog',
            keys: [...modShiftCombos('code:KeyW')],
            preventDefault: true,
            handler: () => {
                if (!this.currentSessionId) {
                    console.warn('[Manager] No active session selected to move');
                    return false;
                }
                this.showMoveWorkspaceModal();
                return true;
            }
        });

        registerShortcut({
            id: 'terminal.shortcut.toggle-current-workspace',
            description: 'Toggle expand/collapse for current workspace',
            keys: [...modShiftCombos('code:KeyE')],
            preventDefault: true,
            handler: () => {
                try {
                    let targetWs = this.currentWorkspace || null;
                    if (!targetWs) {
                        const state = this.sessionList?.store?.getState?.();
                        const activeId = state?.sessionList?.activeSessionId;
                        const data = state?.sessionList?.sessions?.get(activeId);
                        targetWs = (data && (data.workspace || 'Default')) || null;
                    }
                    if (!targetWs) targetWs = 'Default';
                    this.workspaceListComponent?.toggleWorkspace?.(targetWs);
                    return true;
                } catch (_) {
                    return false;
                }
            }
        });

        // Cmd/Alt + Shift + F → Toggle focus between terminal search and sidebar search
        registerShortcut({
            id: 'terminal.shortcut.focus-terminal-search',
            description: 'Toggle terminal/sidebar search focus',
            keys: [...modShiftCombos('code:KeyF')],
            preventDefault: true,
            handler: () => {
                try {
                    const termInput = this.elements?.terminalSearchInput;
                    const sideInput = this.elements?.searchInput;
                    const active = document.activeElement;

                    const isTermInputFocused = !!termInput && active === termInput;
                    const isSideInputFocused = !!sideInput && active === sideInput;

                    if (isTermInputFocused) {
                        // If terminal search is already focused: clear, close, and focus sidebar search
                        this.searchController?.hide?.({ suppressRefocus: true });
                        if (sideInput) {
                            try { sideInput.value = ''; } catch (_) {}
                            sideInput.focus();
                            return true;
                        }
                        return false;
                    }

                    if (isSideInputFocused) {
                        // If sidebar search is focused: clear and switch focus to terminal search
                        try { sideInput.value = ''; } catch (_) {}
                        this.searchController?.show?.();
                        if (termInput) {
                            termInput.focus();
                            return true;
                        }
                        return false;
                    }

                    // Default: open/focus terminal search
                    this.searchController?.show?.();
                    if (termInput) {
                        termInput.focus();
                        if (typeof termInput.value === 'string' && termInput.value.length > 0) {
                            termInput.select();
                        }
                        return true;
                    }
                    return false;
                } catch (_) {
                    return false;
                }
            }
        });

        // Cmd/Alt + Shift + G → Focus sidebar "Search sessions" input
        registerShortcut({
            id: 'terminal.shortcut.focus-session-search',
            description: 'Focus session search input',
            keys: [...modShiftCombos('code:KeyG')],
            preventDefault: true,
            handler: () => {
                try {
                    const input = this.elements?.searchInput;
                    if (!input) return false;
                    input.focus();
                    if (typeof input.value === 'string' && input.value.length > 0) {
                        input.select();
                    }
                    return true;
                } catch (_) {
                    return false;
                }
            }
        });

        // Numbered session shortcuts: Cmd/Alt+Shift+1..9 → switch to Nth visible session in sidebar
        const registerSessionIndexShortcut = (num) => {
            const keyCode = `code:Digit${num}`;
            registerShortcut({
                id: `terminal.shortcut.switch-session-${num}`,
                description: `Switch to sidebar session ${num}`,
                keys: [...modNumCombos(keyCode)],
                // Allow while typing in note editors or other inputs
                allowInInputs: true,
                allowInEditable: true,
                preventDefault: true,
                handler: () => {
                    return this.switchToSidebarSessionByIndex(num) === true;
                }
            });
        };
        for (let i = 1; i <= 9; i++) {
            registerSessionIndexShortcut(i);
        }

        // Cmd/Alt+Shift+0 → focus the main window (Electron)
        registerShortcut({
            id: 'terminal.shortcut.focus-main-window',
            description: 'Focus main window',
            keys: [...modShiftCombos('code:Digit0')],
            preventDefault: true,
            allowInInputs: true,
            allowInEditable: true,
            handler: async () => {
                try {
                    if (window.desktop && window.desktop.isElectron && typeof window.desktop.focusMainWindow === 'function') {
                        await window.desktop.focusMainWindow();
                        return true;
                    }
                } catch (_) {}
                return false;
            }
        });
    }

    adjustTerminalFontSize(delta) {
        if (!delta) {
            return;
        }

        try {
            const state = appStore.getState();
            const currentSize = parseInt(state?.preferences?.terminal?.fontSize, 10) || 14;
            const newSizeUnclamped = currentSize + delta;
            const newSize = Math.max(TERMINAL_FONT_MIN, Math.min(TERMINAL_FONT_MAX, newSizeUnclamped));
            if (newSize === currentSize) {
                return;
            }

            const fontFamily = state?.preferences?.terminal?.fontFamily || fontDetector.getDefaultFont();

            appStore.setPath('preferences.terminal.fontSize', newSize);
            this.updateAllTerminalFonts(newSize, fontFamily);

            try {
                if (settingsManager?.elements?.terminalFontSize) {
                    settingsManager.elements.terminalFontSize.value = newSize;
                }
                if (settingsManager?.elements?.fontSizeValue) {
                    settingsManager.elements.fontSizeValue.textContent = `${newSize}px`;
                }
            } catch (_) {
                // Ignore UI sync issues; shortcuts should still work
            }

            try {
                if (typeof settingsManager.saveSettingsToStorage === 'function') {
                    settingsManager.saveSettingsToStorage();
                }
            } catch (error) {
                console.warn('[Manager] Failed to persist terminal font size shortcut change:', error);
            }
            // Broadcast font settings to other windows in Electron, if available
            try {
                if (window.desktop?.applyFontSettingsAll) {
                    window.desktop.applyFontSettingsAll(newSize, fontFamily);
                }
            } catch (_) {}
        } catch (error) {
            console.error('[Manager] Failed to adjust terminal font size:', error);
        }
    }

    toggleAllWorkspacesExpansion() {
        try {
            if (!this.workspaceListComponent || typeof this.getWorkspaceNames !== 'function') {
                return;
            }

            const workspaces = this.getWorkspaceNames();
            if (!Array.isArray(workspaces) || workspaces.length === 0) {
                return;
            }

            const expanded = this.workspaceListComponent.expanded;
            let expandedCount = 0;
            if (expanded && typeof expanded.has === 'function') {
                for (const name of workspaces) {
                    if (expanded.has(name)) {
                        expandedCount++;
                    }
                }
            }

            if (expanded && expandedCount >= workspaces.length) {
                this.workspaceListComponent.collapseAll?.();
            } else {
                this.workspaceListComponent.expandAll?.();
            }
        } catch (error) {
            console.warn('[Manager] Failed to toggle workspace expansion:', error);
        }
    }

    navigateTerminalList(direction) {
        // Get all visible session items directly from the DOM in visual order
        const sessionItems = Array.from(this.elements.sessionList.querySelectorAll('.session-item'));
        const visibleSessions = sessionItems
            .filter(item => item.style.display !== 'none')
            .map(item => item.dataset.sessionId);

        if (visibleSessions.length === 0) {
            return;
        }

        // Find current session index
        let currentIndex = visibleSessions.indexOf(this.currentSessionId);
        
        // If no session is selected, start at the beginning or end
        if (currentIndex === -1) {
            currentIndex = direction === 'up' ? visibleSessions.length : -1;
        }

        // Calculate new index
        let newIndex;
        if (direction === 'up') {
            newIndex = currentIndex - 1;
            if (newIndex < 0) {
                newIndex = visibleSessions.length - 1; // Wrap to bottom
            }
        } else {
            newIndex = currentIndex + 1;
            if (newIndex >= visibleSessions.length) {
                newIndex = 0; // Wrap to top
            }
        }

        // Select the new session
        const newSessionId = visibleSessions[newIndex];
        if (newSessionId) {
            this.selectSession(newSessionId);
            
            // Ensure the selected session is visible in the list (scroll if needed)
            const sessionItem = this.sessionList.sessions.get(newSessionId);
            if (sessionItem) {
                sessionItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }

    // Switch to the Nth visible session in the sidebar (across all workspaces)
    switchToSidebarSessionByIndex(n) {
        try {
            const idx = Number(n) - 1;
            if (!Number.isFinite(idx) || idx < 0) return false;

            // Prefer workspace list rows (current design keeps workspaces visible)
            const wl = this.elements?.workspaceList;
            let rows = [];
            if (wl) {
                rows = Array.from(wl.querySelectorAll('.workspace-session-row'))
                    .filter(el => el && el.offsetParent !== null && el.style.display !== 'none');
            }
            // Fallback to legacy session list if visible
            if ((!rows || rows.length === 0) && this.elements?.sessionList) {
                rows = Array.from(this.elements.sessionList.querySelectorAll('.session-item'))
                    .filter(el => el && el.offsetParent !== null && el.style.display !== 'none');
            }
            if (!rows || rows.length === 0) return false;
            if (idx >= rows.length) return false;

            const targetEl = rows[idx];
            const sid = targetEl?.dataset?.sessionId || targetEl?.getAttribute?.('data-session-id');
            if (!sid) return false;

            // If this came from workspace list, enter that workspace first to match click behavior
            const ws = targetEl.closest?.('.workspace-item')?.dataset?.workspace || null;
            if (ws && typeof this.enterWorkspace === 'function') {
                try { this.enterWorkspace(ws); } catch (_) {}
                // Defer selection to ensure workspace filter/render completes
                setTimeout(() => { this.selectSession(sid, { manualClick: true }); }, 0);
            } else {
                this.selectSession(sid, { manualClick: true });
            }

            try { targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
            try { this.sessionList?.setActiveSession?.(sid); } catch (_) {}
            return true;
        } catch (e) {
            console.warn('[TerminalManager] switchToSidebarSessionByIndex failed:', e);
            return false;
        }
    }

    switchToTab(tabName) {
        // Find the tab with the matching filter
        const targetTab = Array.from(this.elements.filterTabs).find(
            tab => tab.dataset.filter === tabName
        );
        
        if (targetTab && !targetTab.classList.contains('active')) {
            // Simulate clicking the tab
            targetTab.click();
        }
    }

    async switchToTabAsync(tabName) {
        // Find the tab with the matching filter
        const targetTab = Array.from(this.elements.filterTabs).find(
            tab => tab.dataset.filter === tabName
        );
        
        if (targetTab && !targetTab.classList.contains('active')) {
            // Manually perform the tab switch operations
            this.setActiveFilterTab(targetTab);
            const filter = targetTab.dataset.filter;
            this.sessionList.setFilter(filter);
            await this.performSearch(true);
        }
    }


    toggleSidebarSections() {
        // Get the currently active tab
        const activeTab = document.querySelector('.filter-tab.active');
        if (!activeTab) return;
        
        // Determine which tab to switch to
        const currentFilter = activeTab.dataset.filter;
        const targetFilter = currentFilter === 'active' ? 'inactive' : 'active';
        
        // Switch to the other tab
        this.switchToTab(targetFilter);
    }

    /**
     * Switch to the most recently created active session (excluding current session) across all workspaces
     * Handles workspace switching if the session is in a different workspace
     */
    async switchToLatestSession() {
        try {
            // Ensure session list is ready
            if (!this.sessionList) {
                console.warn('[Manager] Session list not initialized');
                return;
            }

            const allSessions = this.sessionList.getAllSessions();
            if (!allSessions || allSessions.size === 0) {
                console.warn('[Manager] No sessions available to switch to');
                return;
            }

            // Convert Map to array of session values
            const sessionsArray = Array.from(allSessions.values());

            // Consider only other active sessions
            const activeSessions = sessionsArray.filter(session => (
                session.is_active === true && session.session_id !== this.currentSessionId
            ));

            if (activeSessions.length === 0) {
                // Nothing to switch to
                return;
            }

            // Sort by created_at (newest first)
            const sortedSessions = activeSessions.sort((a, b) => {
                const aTime = a.created_at || 0;
                const bTime = b.created_at || 0;
                return bTime - aTime;
            });

            // Pick newest
            const latestSession = sortedSessions[0];
            if (!latestSession || !latestSession.session_id) {
                return;
            }

            // Switch workspace if needed
            const targetWorkspace = latestSession.workspace || 'Default';
            const currentWorkspace = this.currentWorkspace || (this.sessionList.store.getState().sessionList?.filters?.workspace) || 'Default';
            if (targetWorkspace !== currentWorkspace) {
                this.enterWorkspace(targetWorkspace);
                // Keep the UI tabs consistent with the underlying filter
                const activeTab = Array.from(this.elements.filterTabs || []).find(tab => tab.dataset.filter === 'active');
                if (activeTab) this.setActiveFilterTab(activeTab);
            }

            // Select the session
            await this.selectSession(latestSession.session_id);

            // If active and not attached, attach programmatically (avoid DOM click)
            if (latestSession.is_active && !this.attachedSessions.has(latestSession.session_id)) {
                await this.attachToCurrentSession();
            }
        } catch (error) {
            console.error('[Manager] Error switching to latest session:', error);
        }
    }

    /**
     * Attempt to login to the container associated with the active session.
     * If the active session is not container-isolated, do nothing.
     * On failure, show an error notification.
     */
    async loginToSandboxContainerForActiveSession() {
        try {
            if (!this.currentSessionId) return;
            const sessionData = this.sessionList.getSessionData(this.currentSessionId);
            if (!sessionData) return;
            if (!this._isContainerSession(sessionData)) {
                // Not a container session: ignore per requirement
                return;
            }
            const ref = this._getContainerName(sessionData);
            const { app } = getContext();
            const clientId = (app && app.clientId) ? app.clientId : (this.clientId || null);
            const created = await apiService.attachContainer(ref, { clientId, parentSessionId: this.currentSessionId });
            if (created && created.session_id) {
                await this.ensureContainerSessionReady(created, { activate: true });
            }
            try { app?.showPage?.('terminal'); } catch (_) {}
        } catch (error) {
            notificationDisplay.show({
                title: 'Failed to Login to Container',
                message: error?.message || 'Unable to connect to container for this session.',
                notification_type: 'error',
                session_id: this.currentSessionId
            });
        }
    }

    /**
     * Execute a one-liner command inside the active container and attach it to the provided command tab
     * @param {{ command: string, title?: string, tabId: string }} spec
     */
    async runContainerCommandForActiveSession(spec) {
        // Backward-compatible wrapper: use secure template-defined execution for all modes
        return this.runCommandForActiveSession(spec);
    }

    /**
     * Execute a template-defined command tab for the active session (no arbitrary commands)
     * @param {{ tabId: string, command?: string, title?: string }} spec
     */
    async runCommandForActiveSession(spec) {
        try {
            if (!this.currentSessionId) return null;
            const sessionData = this.sessionList.getSessionData(this.currentSessionId);
            if (!sessionData) return null;
            const { app } = getContext();
            const clientId = (app && app.clientId) ? app.clientId : (this.clientId || null);
            // Resolve tab index from TabManager for security (server picks the command by index)
            const tm = this.getTabManager();
            const tab = tm && typeof tm.getCurrentSessionTab === 'function' ? tm.getCurrentSessionTab(spec?.tabId) : null;
            const tabIndex = tab && Number.isInteger(tab.tabIndex) ? tab.tabIndex : null;
            if (tabIndex === null) return null;
            const created = await apiService.runSessionCommandTab(this.currentSessionId, tabIndex, { clientId });
            if (created && created.session_id) {
                try { this.getTabManager()?.mapChildToTab?.(this.currentSessionId, created.session_id, spec?.tabId || null); } catch (_) {}
                await this.ensureContainerSessionReady(created, { activate: true });
            }
            try { app?.showPage?.('terminal'); } catch (_) {}
            return created;
        } catch (error) {
            notificationDisplay.show({
                title: 'Failed to Run Command',
                message: error?.message || 'Unable to run template command tab for this session.',
                notification_type: 'error',
                session_id: this.currentSessionId
            });
            return null;
        }
    }

    getTabManager() {
        if (this.tabManager && typeof this.tabManager.getContainerViewElement === 'function') {
            return this.tabManager;
        }
        try {
            const candidate = getContext()?.app?.modules?.tabManager;
            if (candidate && typeof candidate.getContainerViewElement === 'function') {
                this.tabManager = candidate;
                return candidate;
            }
        } catch (_) {}
        return this.tabManager || null;
    }

    getChildSessions(parentId, options = {}) {
        const respectSidebarPreference = options.respectSidebarPreference !== false;
        const ids = this.childSessionsByParent.get(parentId);
        if (!Array.isArray(ids) || ids.length === 0) {
            return [];
        }
        if (respectSidebarPreference) {
            let showPref = false;
            try {
                showPref = appStore.getState('preferences')?.display?.showContainerShellsInSidebar === true;
            } catch (_) {
                showPref = false;
            }
            if (!showPref) {
                return [];
            }
        }
        return ids
            .map(id => this.childSessions.get(id))
            .filter(Boolean)
            .filter(s => s.show_in_sidebar !== false);
    }

    getChildSessionIds(parentId) {
        const ids = this.childSessionsByParent.get(parentId);
        return Array.isArray(ids) ? [...ids] : [];
    }

    isChildSession(sessionId) {
        return this.childSessions.has(sessionId);
    }

    removeChildFromParentList(parentId, childId) {
        if (!parentId) return;
        const ids = this.childSessionsByParent.get(parentId);
        if (!Array.isArray(ids)) return;
        const idx = ids.indexOf(childId);
        if (idx !== -1) {
            ids.splice(idx, 1);
        }
        if (ids.length === 0) {
            this.childSessionsByParent.delete(parentId);
        }
    }

    /**
     * Ensure default display titles for child container sessions match tab labeling.
     * If there is only one child, use "Shell"; otherwise "Shell N".
     * Never override a non-default/user-defined title.
     */
    updateDefaultChildTitles(parentId) {
        try {
            if (!parentId) return;
            const ids = this.childSessionsByParent.get(parentId);
            if (!Array.isArray(ids) || ids.length === 0) return;
            // Only count/display container shell children (exclude hidden command-tab children)
            const visibleIds = ids.filter(cid => {
                const c = this.childSessions.get(cid);
                return c && c.show_in_sidebar !== false;
            });
            const total = visibleIds.length;
            visibleIds.forEach((cid, idx) => {
                const child = this.childSessions.get(cid);
                if (!child) return;
                const t = (child.title || '').trim();
                const shouldSet = !t || t === 'Shell' || t === `Shell ${idx + 1}`; // allow stabilizing from single to numbered
                if (!shouldSet) return; // keep user/custom titles
                const label = (total > 1) ? `Shell ${idx + 1}` : 'Shell';
                if (t !== label) {
                    this.childSessions.set(cid, { ...child, title: label });
                }
            });
        } catch (_) { /* non-fatal */ }
    }

    registerChildSession(sessionData, options = {}) {
        if (!sessionData || !sessionData.session_id || !sessionData.parent_session_id) {
            return null;
        }
        const childId = sessionData.session_id;
        const parentId = sessionData.parent_session_id;
        const previous = this.childSessions.get(childId);
        const showSidebarChildren = (() => {
            try {
                return appStore.getState('preferences')?.display?.showContainerShellsInSidebar === true;
            } catch (_) {
                return false;
            }
        })();

        if (previous && previous.parent_session_id && previous.parent_session_id !== parentId) {
            this.removeChildFromParentList(previous.parent_session_id, childId);
        }

        const merged = previous ? { ...previous, ...sessionData } : { ...sessionData };
        this.childSessions.set(childId, merged);

        let ids = this.childSessionsByParent.get(parentId);
        if (!Array.isArray(ids)) {
            ids = [];
            this.childSessionsByParent.set(parentId, ids);
        }
        if (!ids.includes(childId)) {
            ids.push(childId);
        }

        // Assign default titles consistent with tab labels when not explicitly set
        this.updateDefaultChildTitles(parentId);

        if (this.sessionList?.getSessionData(childId)) {
            this.sessionList.removeSession(childId);
        }

        this.ensureParentSessionInSidebar(parentId, { forceActiveChildren: true });

        if (this.sessionList && typeof this.sessionList.updateSession === 'function') {
            const parentData = this.sessionList.getSessionData(parentId);
            if (parentData && parentData.has_active_children !== true) {
                this.sessionList.updateSession({ session_id: parentId, has_active_children: true });
            }
        }

        const parentSessionInstance = this.sessions.get(parentId);
        if (parentSessionInstance) {
            parentSessionInstance.sessionData = {
                ...(parentSessionInstance.sessionData || {}),
                has_active_children: true
            };
        }

        const isCommandChild = merged && merged.child_tab_type === 'command';
        // For regular child container shells, keep existing container-tab behavior
        if (!isCommandChild) {
            const tabManager = this.getTabManager();
            if (tabManager && typeof tabManager.ensureContainerTab === 'function') {
            const children = this.getChildSessions(parentId, { respectSidebarPreference: false });
                children.forEach((child) => {
                    if (!child || !child.session_id) return;
                    tabManager.ensureContainerTab(parentId, child);
                });
                tabManager.refreshActiveSessionTabs?.();
            }

            const emitEvents = options.emit !== false;
            if (emitEvents) {
                const eventName = previous ? 'container-session:updated' : 'container-session:added';
                this.eventBus.emit(eventName, { parentId, sessionData: merged });
            }
        }

        this.refreshContainerTabsForParent(parentId, { attach: true });

        // Immediately refresh sidebar/workspace child rows so labels appear without delay
        if (showSidebarChildren) {
            try { this.sessionList?.renderChildrenForParent?.(parentId); } catch (_) {}
        }
        if (showSidebarChildren) {
            try { this.workspaceListComponent?.refreshChildrenForParent?.(parentId); } catch (_) {}
        }

        return merged;
    }

    unregisterChildSession(childId, options = {}) {
        const existing = this.childSessions.get(childId);
        if (!existing) return;
        const parentId = existing.parent_session_id;
        this.childSessions.delete(childId);
        this.removeChildFromParentList(parentId, childId);
        // Recompute default titles when the set changes
        this.updateDefaultChildTitles(parentId);
        // For command-tab children, preserve the DOM so output remains visible
        const isCommandChild = existing && existing.child_tab_type === 'command';
        this.cleanupChildTerminal(childId, { preserveDom: isCommandChild });
        // For command-tab children, do not emit container tab removal events
        const shouldEmit = options.emit !== false && !isCommandChild;
        if (shouldEmit) {
            this.eventBus.emit('container-session:removed', { parentId, sessionId: childId });
        }

        if (this.sessionList && typeof this.sessionList.updateSession === 'function') {
        const remaining = this.getChildSessions(parentId, { respectSidebarPreference: false });
            if ((!remaining || remaining.length === 0)) {
                const parentData = this.sessionList.getSessionData(parentId);
                if (parentData && parentData.has_active_children) {
                    this.sessionList.updateSession({ session_id: parentId, has_active_children: false });
                }
            }
        }

        const parentSessionInstance = this.sessions.get(parentId);
        if (parentSessionInstance && this.getChildSessions(parentId, { respectSidebarPreference: false }).length === 0) {
            parentSessionInstance.sessionData = {
                ...(parentSessionInstance.sessionData || {}),
                has_active_children: false
            };
        }

        this.refreshContainerTabsForParent(parentId, { attach: false });

        // Refresh sidebar/workspace child rows to reflect any title normalization
        try { this.sessionList?.renderChildrenForParent?.(parentId); } catch (_) {}
        try { this.workspaceListComponent?.refreshChildrenForParent?.(parentId); } catch (_) {}
    }

    cleanupChildTerminal(childId, opts = {}) {
        const preserveDom = !!(opts && opts.preserveDom);
        if (this.attachedSessions.has(childId)) {
            this.attachedSessions.delete(childId);
        }
        const session = this.sessions.get(childId);
        if (session) {
            try {
                if (preserveDom && typeof session.detach === 'function') {
                    // Detach from backend but keep the xterm DOM so output remains visible
                    session.detach(false);
                } else {
                    session.dispose();
                }
            } catch (error) {
                console.warn(`[TerminalManager] Failed to dispose child session ${childId}:`, error);
            }
            this.sessions.delete(childId);
        }
        if (this.activeChildSessionId === childId) {
            this.activeChildSessionId = null;
        }
    }

    clearChildSessions(options = {}) {
        const { emit = true } = options || {};
        const previouslyAttached = [];
        const parentIds = new Set();
        this.childSessions.forEach((_, childId) => {
            if (this.attachedSessions.has(childId)) {
                previouslyAttached.push(childId);
            }
            const data = this.childSessions.get(childId);
            if (data && data.parent_session_id) {
                parentIds.add(data.parent_session_id);
            }
            this.cleanupChildTerminal(childId);
        });
        this.childSessions.clear();
        this.childSessionsByParent.clear();
        this.activeChildSessionId = null;
        if (this.sessionList && typeof this.sessionList.updateSession === 'function') {
            parentIds.forEach((parentId) => {
                const parentData = this.sessionList.getSessionData(parentId);
                if (parentData && parentData.has_active_children) {
                    this.sessionList.updateSession({ session_id: parentId, has_active_children: false });
                }
                const parentSessionInstance = this.sessions.get(parentId);
                if (parentSessionInstance) {
                    parentSessionInstance.sessionData = {
                        ...(parentSessionInstance.sessionData || {}),
                        has_active_children: false
                    };
                }
                this.refreshContainerTabsForParent(parentId, { attach: false });
            });
        }
        if (emit) {
            this.eventBus.emit('container-session:reset', {});
        }
        return previouslyAttached;
    }

    ensureParentSessionInSidebar(parentId, options = {}) {
        if (!parentId || !this.sessionList) {
            return;
        }
        const existing = this.sessionList.getSessionData(parentId);
        if (existing) {
            const updatePayload = {
                session_id: parentId,
                has_active_children: options.forceActiveChildren ? true : existing.has_active_children,
                __stickyTerminated: true,
                is_active: existing.is_active
            };
            this.sessionList.updateSession(updatePayload);
            this.eventBus.emit('container-session:refresh', { parentId });
            try { this.updateWorkspacesFromSessions(); } catch (_) {}
            try { this.sessionList?.render?.(); } catch (_) {}
            this.updateSessionTabs();
            return existing;
        }
        if (this.pendingParentFetches.has(parentId)) {
            return this.pendingParentFetches.get(parentId);
        }

        const sessionInstance = this.sessions.get(parentId);
        const sessionSnapshot = sessionInstance?.sessionData;
        if (sessionSnapshot) {
            const enriched = {
                ...sessionSnapshot,
                has_active_children: options.forceActiveChildren ? true : sessionSnapshot.has_active_children,
                __stickyTerminated: true,
                is_active: sessionSnapshot.is_active === true ? true : false
            };
            this.sessionList.addSession(enriched, false, true);
            if (options.forceActiveChildren && enriched.has_active_children !== true) {
                this.sessionList.updateSession({ session_id: parentId, has_active_children: true });
            }
            this.eventBus.emit('container-session:refresh', { parentId });
            try { this.updateWorkspacesFromSessions(); } catch (_) {}
            try { this.sessionList?.render?.(); } catch (_) {}
            this.updateSessionTabs();
            return enriched;
        }

        const fetchPromise = (async () => {
            try {
                const parentData = await apiService.getSession(parentId);
                if (!parentData) {
                    return null;
                }
                const enriched = {
                    ...parentData,
                    has_active_children: options.forceActiveChildren ? true : parentData.has_active_children,
                    __stickyTerminated: true,
                    is_active: parentData.is_active === true ? true : false
                };
                this.sessionList.addSession(enriched, false, true);
                if (options.forceActiveChildren && enriched.has_active_children !== true) {
                    this.sessionList.updateSession({ session_id: parentId, has_active_children: true });
                }
                this.eventBus.emit('container-session:refresh', { parentId });
                try { this.updateWorkspacesFromSessions(); } catch (_) {}
                try { this.sessionList?.render?.(); } catch (_) {}
                this.updateSessionTabs();
                this.refreshContainerTabsForParent(parentId, { attach: true });
                return enriched;
            } catch (error) {
                console.warn(`[TerminalManager] Failed to fetch parent session ${parentId}:`, error);
                return null;
            } finally {
                this.pendingParentFetches.delete(parentId);
            }
        })();
        this.pendingParentFetches.set(parentId, fetchPromise);
        return fetchPromise;
    }

    refreshContainerTabsForParent(parentId, options = {}) {
        if (!parentId) {
            return;
        }
        const children = this.getChildSessions(parentId, { respectSidebarPreference: false });
        if (!Array.isArray(children) || children.length === 0) {
            return;
        }

        const tabManager = this.getTabManager();
        if (!tabManager || typeof tabManager.ensureContainerTab !== 'function') {
            return;
        }

        children.forEach((child) => {
            if (!child || !child.session_id) return;
            tabManager.ensureContainerTab(parentId, child);
        });

        const restoredTab = tabManager.activateSavedTabForSession(parentId, {
            forceSwitch: this.currentSessionId === parentId
        });

        if (options.attach !== false) {
            const attachTargets = new Set();
            let primaryChildId = null;

            if (restoredTab && restoredTab.type === 'container' && restoredTab.childSessionId) {
                primaryChildId = restoredTab.childSessionId;
                attachTargets.add(restoredTab.childSessionId);
            } else if (this.activeChildSessionId) {
                primaryChildId = this.activeChildSessionId;
                attachTargets.add(this.activeChildSessionId);
            }

            // Determine user preference: auto-attach on select
            let autoAttach = false;
            try { autoAttach = this.getTabManager()?.appStore?.getState?.('preferences.terminal.autoAttachOnSelect') === true; } catch (_) {}
            try { autoAttach = appStore.getState('preferences.terminal.autoAttachOnSelect') === true; } catch (_) {}

            // If no explicit primary child, do not auto-attach new children unless preference allows
            if (attachTargets.size === 0) {
                children.forEach((child) => {
                    if (!child || !child.session_id) return;
                    const id = child.session_id;
                    // Always include previously attached children so they remain attached
                    if (this.attachedSessions?.has?.(id)) {
                        attachTargets.add(id);
                        return;
                    }
                    // Only auto-attach new ones if preference is enabled
                    if (autoAttach) {
                        attachTargets.add(id);
                    }
                });
            }

            this._debug?.log?.('refreshContainerTabsForParent', {
                parentId,
                children: children.map(c => c.session_id),
                restoredTab: restoredTab ? restoredTab.id : null,
                primaryChildId,
                activeChildSessionId: this.activeChildSessionId,
                attachTargets: Array.from(attachTargets),
                autoAttach,
                attachedSessions: Array.from(this.attachedSessions || [])
            });

            // If the restored (active) tab is a container and we are not auto-attaching, ensure the attach prompt is visible
            try {
                if (restoredTab && restoredTab.type === 'container') {
                    const cid = restoredTab.childSessionId;
                    const already = this.attachedSessions?.has?.(cid) === true;
                    const suppressed = this._suppressedChildAttach?.has?.(cid) === true;
                    if (!already && (!autoAttach || suppressed)) {
                        this.showContainerAttachPrompt(cid);
                    }
                }
            } catch (_) {}

            attachTargets.forEach((childId) => {
                // If we already have an attached session, ensure its container view matches; if not, re-run attach
                const tabMgr = this.getTabManager();
                const parentView = tabMgr?.getContainerViewElement?.(parentId, childId) || null;
                const sessionObj = this.sessions.get(childId) || null;
                const alreadyAttached = (sessionObj && sessionObj.isAttached === true) || (this.attachedSessions?.has?.(childId) === true);
                const viewMatches = !!(sessionObj && parentView && sessionObj.container === parentView);

                if (alreadyAttached && viewMatches) {
                    this._debug?.log?.('skip reattach (already attached, view ok)', { childId });
                    return;
                }

                const wasAttachedBeforeSwitch = this._attachedChildSnapshot?.has?.(childId) === true;
                const suppressed = this._suppressedChildAttach?.has?.(childId) === true;
                if (!autoAttach || suppressed) {
                    this._debug?.log?.('skip attach (autoAttach off or suppressed)', { childId, autoAttach, suppressed });
                    return;
                }
                this.attachChildSession(childId, {
                    markActive: primaryChildId ? childId === primaryChildId : false,
                    focus: false,
                    _forceNoHistory: wasAttachedBeforeSwitch && alreadyAttached
                }).finally(() => {
                    try { this._attachedChildSnapshot?.delete?.(childId); } catch (_) {}
                }).catch(() => {});
            });
        }

        tabManager.refreshActiveSessionTabs?.();
    }

    async attachChildSession(childId, options = {}) {
        const childData = this.childSessions.get(childId);
        if (!childData) {
            return null;
        }
        const parentId = childData.parent_session_id;
        if (!parentId) {
            return null;
        }

        const tabManager = this.getTabManager();
        const containerView = tabManager?.getContainerViewElement?.(parentId, childId);
        if (!containerView) {
            return null;
        }

        let session = this.sessions.get(childId);
        if (session && session.container !== containerView) {
            this._debug?.log?.('attachChildSession container mismatch, rebuilding', { childId });
            try { session.detach?.(true); } catch (_) {}
            try { session.dispose?.(); } catch (_) {}
            this.sessions.delete(childId);
            this.attachedSessions.delete(childId);
            session = null;
        }

        // If session exists but its container no longer has an xterm instance (e.g., placeholder overwrote DOM), rebuild
        if (session && session.container === containerView) {
            const hasXterm = !!containerView.querySelector('.xterm');
            if (!hasXterm) {
                this._debug?.log?.('attachChildSession container empty, rebuilding', { childId });
                try { session.detach?.(true); } catch (_) {}
                try { session.dispose?.(); } catch (_) {}
                this.sessions.delete(childId);
                this.attachedSessions.delete(childId);
                session = null;
            }
        }

        if (!session) {
            const sessionContainer = containerView;
            const terminalSession = new TerminalSession(
                childId,
                sessionContainer,
                this.wsClient,
                this.eventBus,
                childData,
                null
            );
            terminalSession.init();
            this.sessions.set(childId, terminalSession);
            session = terminalSession;
        } else {
            session.sessionData = { ...session.sessionData, ...childData };
        }

        // If the session is already attached (e.g., persisted across workspace switches),
        // ensure our tracking set includes it and skip sending another attach to avoid history reloads.
        if (session?.isAttached) {
            this._debug?.log?.('attachChildSession already attached', { childId });
            if (!this.attachedSessions.has(childId)) {
                this.attachedSessions.add(childId);
            }
        } else if (!this.attachedSessions.has(childId)) {
            try {
                // If it was attached when we left the workspace, avoid reloading history; otherwise load.
                const skipHistory = options && options._forceNoHistory === true;
                this._debug?.log?.('attachChildSession attaching', { childId, skipHistory });
                await session.attach(!skipHistory);
                this.attachedSessions.add(childId);
                // Clear suppression on explicit attach
                try { this._suppressedChildAttach.delete(childId); } catch (_) {}
                try { this._lastChildAttachAt.set(childId, Date.now()); } catch (_) {}
            } catch (error) {
                console.error(`[TerminalManager] Error attaching child session ${childId}:`, error);
            }
        }

        if (options.markActive) {
            this.activeChildSessionId = childId;
        }

        if (options.focus) {
            requestAnimationFrame(() => {
                try { session.focus?.(); } catch (_) {}
            });
        }

        return session;
    }

    async ensureContainerSessionReady(sessionData, options = {}) {
        if (!sessionData || !sessionData.session_id || !sessionData.parent_session_id) {
            return null;
        }

        const merged = this.registerChildSession(sessionData, { emit: options.emit !== false });
        if (!merged) {
            return null;
        }

        const parentId = merged.parent_session_id;

        if (options.activate === true && this.currentSessionId !== parentId) {
            try {
                await this.selectSession(parentId, { autoSelect: true });
            } catch (_) {}
        }

        if (options.attach !== false) {
            await this.attachChildSession(merged.session_id, {
                markActive: options.activate === true,
                focus: options.activate === true
            });
        }

        if (options.activate === true) {
            this.eventBus.emit('container-session:activate', {
                parentId,
                sessionId: merged.session_id
            });
        }

        return merged;
    }

    reorderChildSession(parentId, childId, direction) {
        const ids = this.childSessionsByParent.get(parentId);
        if (!Array.isArray(ids)) {
            return;
        }
        const index = ids.indexOf(childId);
        if (index === -1) {
            return;
        }
        const delta = direction === 'left' ? -1 : 1;
        const targetIndex = index + delta;
        if (targetIndex < 0 || targetIndex >= ids.length) {
            return;
        }
        ids.splice(index, 1);
        ids.splice(targetIndex, 0, childId);
        this.eventBus.emit('container-session:refresh', { parentId });
    }

    _isContainerSession(sessionData) {
        try {
            if (sessionData && sessionData.isolation_mode === 'container') return true;
            const tid = sessionData?.template_id;
            if (tid && Array.isArray(this.formManager?.availableTemplates)) {
                const tmpl = this.formManager.availableTemplates.find(t => t && t.id === tid);
                if (tmpl && tmpl.isolation === 'container') return true;
            }
        } catch (_) { /* ignore */ }
        return false;
    }

    _getContainerName(sessionData) {
        const explicit = sessionData?.container_name;
        if (explicit && String(explicit).trim()) return explicit;
        const sid = String(sessionData?.session_id || '').trim();
        return sid ? `sandbox-${sid}` : 'sandbox-unknown';
    }

    /**
     * Adjusts the app layout for mobile keyboard open/close
     * @param {number} viewportHeight - Current visible viewport height
     * @param {number} windowHeight - Full window height
     */
    adjustLayoutForKeyboard(viewportHeight, windowHeight) {
        const appElement = document.getElementById('app');
        const mainLayout = document.querySelector('.main-layout');
        const terminalView = document.querySelector('.terminal-view');
        const terminalContainer = document.querySelector('.terminal-container');
        
        // Use CSS custom properties for dynamic sizing
        const root = document.documentElement;
        
        // Calculate keyboard height
        const keyboardHeight = windowHeight - viewportHeight;
        const isKeyboardOpen = keyboardHeight > 100; // Threshold for keyboard detection
        
        // Set the actual viewport height as CSS variables
        root.style.setProperty('--actual-viewport-height', `${viewportHeight}px`);
        root.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
        
        // Add/remove keyboard open class
        if (isKeyboardOpen) {
            document.body.classList.add('keyboard-open');
            
            // Force scroll to bottom of current terminal when keyboard opens
            if (this.currentSession && this.currentSession.terminal) {
                // Use a small delay to ensure the terminal has adjusted to new size
                setTimeout(() => {
                    if (this.currentSession && this.currentSession.terminal) {
                        this.currentSession.terminal.scrollToBottom();
                    }
                }, 50);
            }
        } else {
            document.body.classList.remove('keyboard-open');
        }
        
        // Immediately adjust app height to prevent scrolling
        if (appElement) {
            // Use the actual viewport height directly
            appElement.style.height = `${viewportHeight}px`;
            appElement.style.minHeight = `${viewportHeight}px`;
            appElement.style.maxHeight = `${viewportHeight}px`;
            appElement.style.overflow = 'hidden';
            
            // Disable transitions during resize to prevent lag
            appElement.style.transition = 'none';
        }
        
        // Adjust main layout to fit within viewport
        if (mainLayout) {
            const headerHeight = 60; // App header height
            const availableHeight = viewportHeight - headerHeight;
            mainLayout.style.height = `${availableHeight}px`;
            mainLayout.style.minHeight = `${availableHeight}px`;
            mainLayout.style.maxHeight = `${availableHeight}px`;
            mainLayout.style.overflow = 'hidden';
        }
        
        // Ensure terminal view uses flexible sizing
        if (terminalView) {
            terminalView.style.height = '100%';
            terminalView.style.overflow = 'hidden';
        }
        
        // Ensure terminal container uses all available space
        if (terminalContainer) {
            terminalContainer.style.height = '100%';
            terminalContainer.style.overflow = 'hidden';
        }
        
        // Prevent body scrolling when keyboard is open
        if (isKeyboardOpen) {
            document.body.style.overflow = 'hidden';
            document.body.style.position = 'fixed';
            document.body.style.width = '100%';
            document.body.style.height = `${viewportHeight}px`;
            document.body.style.top = '0';
            document.body.style.left = '0';
        } else {
            // Reset body styles when keyboard is closed
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.width = '';
            document.body.style.height = '';
            document.body.style.top = '';
            document.body.style.left = '';
        }
    }

    // Called when preferences.display.showContainerShellsInSidebar toggles, to refresh
    // sidebar child entries consistently without requiring session interaction.
    refreshSidebarChildrenForPreference() {
        try {
            if (!(this.childSessionsByParent instanceof Map)) return;
            const parents = Array.from(this.childSessionsByParent.keys());
            parents.forEach((parentId) => {
                try { this.sessionList?.renderChildrenForParent?.(parentId); } catch (_) {}
                try { this.workspaceListComponent?.refreshChildrenForParent?.(parentId); } catch (_) {}
            });
        } catch (_) {}
        // Keep tabs intact (still based on full child set), but refresh to ensure
        // title/indexing remains stable after any sidebar-only hides
        try { this.sessionTabsManager?.refresh?.(); } catch (_) {}
        try { this.getTabManager()?.refreshActiveSessionTabs?.(); } catch (_) {}
    }

    updateTabSelection(sessionId, isActiveSession) {
        // Update the appropriate tab selection
        if (isActiveSession) {
            this.tabSelections.active = sessionId;
        } else {
            this.tabSelections.inactive = sessionId;
        }
    }

    getCurrentTabSelection() {
        // Get the current tab filter
        const activeTab = document.querySelector('.filter-tab.active');
        const currentFilter = activeTab ? activeTab.dataset.filter : 'all';
        
        // Return the saved selection for this tab
        return this.tabSelections[currentFilter];
    }

    getCurrentActiveTab() {
        // Get the currently active tab filter
        const activeTab = document.querySelector('.filter-tab.active');
        return activeTab ? activeTab.dataset.filter : 'active';
    }

    getFirstActiveSession() {
        // Get the first active session from the store
        const sessionsMap = this.sessionList.store.getState().sessionList.sessions;
        const sessions = Array.from(sessionsMap.values());
        return sessions.find(session => session.is_active !== false);
    }

    async performAutoSelection() {
        // Skip if we've already performed a restore/selection or one is active
        if (this.autoSelectionPerformed || this.currentSessionId) {
            console.log('[Manager] Skipping auto-selection (already selected)');
            return;
        }
        // Auto-select (not attach) the first active session if available
        const firstActiveSession = this.getFirstActiveSession();
        if (firstActiveSession) {
            console.log(`[Manager] Performing delayed auto-selection: ${firstActiveSession.session_id}`);
            console.log(`[Manager] SessionTabsManager available: ${!!this.sessionTabsManager}`);
            
            // Use autoSelect flag - this won't prevent auto-attach for new sessions
            await this.selectSession(firstActiveSession.session_id, { autoSelect: true });
            this.autoSelectionPerformed = true;
        } else {
            console.log(`[Manager] No active sessions found for delayed auto-select`);
        }
    }

    async loadSessions(preserveSelection = false, activeOnly = true) {
        try {
            console.log(`[Manager] loadSessions called (active-only): preserveSelection=${preserveSelection}`);

            // Always load only active sessions for the sidebar
            const sessions = await apiService.getSessions();
                
            console.log(`[Manager] Loaded ${sessions?.length || 0} sessions:`, sessions?.map(s => ({id: s.session_id, active: s.is_active, title: s.title})));
            
            // Ensure sessions is an array
            if (!Array.isArray(sessions)) {
                console.warn('[TerminalManager] loadSessions: sessions is not an array:', sessions);
                return;
            }

            const previousActiveChild = this.activeChildSessionId;
            const previouslyAttachedChildren = this.clearChildSessions();
            
            // Store current selection for restore: prefer the actually displayed session
            // then fall back to tab-specific selection when preserving
            let sessionIdToRestore = null;
            if (preserveSelection) {
                sessionIdToRestore = this.currentSessionId || this.getCurrentTabSelection();
            }

            // Capture sticky terminated sessions so they can survive reloads
            const stickySnapshots = (this.sessionList && typeof this.sessionList.getStickyTerminatedSessionsSnapshot === 'function')
                ? this.sessionList.getStickyTerminatedSessionsSnapshot()
                : [];

            // Clear existing sessions in UI
            this.sessionList.clear();

            // Sort sessions: pinned first (by timestamp), then unpinned (by timestamp)
            const sortedSessions = this.sortSessionsWithPins(sessions);
            
            // Ensure sortedSessions is an array
            if (!Array.isArray(sortedSessions)) {
                console.warn('[TerminalManager] loadSessions: sortedSessions is not an array:', sortedSessions);
                return;
            }
            
            // Add sorted sessions without applying filter individually (we'll apply it once at the end)
            sortedSessions.forEach(sessionData => {
                if (sessionData && sessionData.parent_session_id) {
                    this.registerChildSession(sessionData);
                    return;
                }
                this.sessionList.addSession(sessionData, false, false); // Don't apply filter yet
                // Initialize persistent activity state from API payload if available
                try {
                    const live = sessionData.is_active !== false;
                    // Prefer boolean output_active; fallback to string activity_state
                    let activeBool = null;
                    if (typeof sessionData.output_active === 'boolean') {
                        activeBool = !!sessionData.output_active;
                    } else if (typeof sessionData.activity_state === 'string') {
                        const s = sessionData.activity_state.toLowerCase();
                        activeBool = s === 'active' ? true : (s === 'inactive' ? false : null);
                    }
                    if (activeBool !== null) {
                        this.setSessionActivityState(sessionData.session_id, !!(activeBool && live));
                    }
                } catch (_) {}
            });

            // Reapply sticky terminated sessions that were active before the reload
            if (Array.isArray(stickySnapshots) && stickySnapshots.length > 0) {
                stickySnapshots.forEach(stickySession => {
                    if (!stickySession || !stickySession.session_id) return;
                    const existing = this.sessionList.getSessionData(stickySession.session_id);
                    if (existing) {
                        if (existing.is_active === false) {
                            this.sessionList.updateSession({
                                ...existing,
                                ...stickySession,
                                __stickyTerminated: true,
                                is_active: false
                            });
                        }
                        return;
                    }
                    this.sessionList.addSession({
                        ...stickySession,
                        __stickyTerminated: true,
                        is_active: false
                    }, false, false);
                });
            }

            // Now apply the current filter to all sessions at once (default to 'active')
            const activeTab = document.querySelector('.filter-tab.active');
            const currentFilter = activeTab ? activeTab.dataset.filter : 'active';
            this.sessionList.setFilter(currentFilter);
            // Update workspace list after loading sessions
            this.updateWorkspacesFromSessions();
            
            // Update available template filters and apply template filter
            this.updateAvailableTemplateFilters();
            this.applyTemplateFilterToCurrentSessions();
            
            // Restore selection if requested and session exists
            if (sessionIdToRestore) {
                const sessionData = this.sessionList.getSessionData(sessionIdToRestore);
                if (sessionData) {
                    this.sessionList.setActiveSession(sessionIdToRestore);
                    this.updateTextInputState();
                }
            }

            const parentIdsToEnsure = Array.from(this.childSessionsByParent.keys());
            if (parentIdsToEnsure.length > 0) {
                try {
                    await Promise.allSettled(parentIdsToEnsure.map((parentId) =>
                        Promise.resolve(this.ensureParentSessionInSidebar(parentId, { forceActiveChildren: true }))
                    ));
                    try { this.workspaceListComponent?.render?.(); } catch (_) {}
                } catch (ensureError) {
                    console.warn('[TerminalManager] Failed to ensure parent sessions after load:', ensureError);
                }
            }

            // Clear localStorage session_id if no sessions are visible in current tab
            this.clearStorageIfNoSessions();
            
            // Update session tabs if any active sessions are available
            this.updateSessionTabs();

            for (const childId of previouslyAttachedChildren) {
                if (!this.childSessions.has(childId)) {
                    continue;
                }
                await this.attachChildSession(childId, {
                    markActive: childId === previousActiveChild
                });
            }

            if (previousActiveChild && this.childSessions.has(previousActiveChild)) {
                const parentId = this.childSessions.get(previousActiveChild)?.parent_session_id;
                if (parentId) {
                    this.eventBus.emit('container-session:activate', {
                        parentId,
                        sessionId: previousActiveChild
                    });
                }
            }

        } catch (error) {
            errorHandler.handle(error, { context: 'load_sessions' });
        }
    }

    getCurrentFilter() {
        const activeTab = document.querySelector('.filter-tab.active');
        return activeTab ? activeTab.dataset.filter : 'active';
    }

    /**
     * Check if the current session is active (not terminated)
     * @returns {boolean} True if current session is active, false otherwise
     */
    isCurrentSessionActive() {
        if (!this.currentSessionId) return false;
        
        const sessionData = this.sessionList.getSessionData(this.currentSessionId);
        return sessionData && sessionData.is_active !== false;
    }

    async showNewSessionModal() {
        // Load templates if not already loaded
        if (this.formManager.availableTemplates.length === 0) {
            await this.formManager.loadTemplates();
        }
        // set up modal defaults and show
        // Do not auto-close the sidebar when opening this modal

        // Set default values using the new modal system
        this.newSessionModal.setFieldValue('session-title', '');
        
        // Reset form using the form manager
        this.formManager.resetForm();

        // Populate workspace select and default value
        try {
            const select = document.getElementById('session-workspace-select');
            const addBtn = document.getElementById('workspace-add-btn');
            if (select) {
                const names = this.getWorkspaceNames();
                const filtered = names.filter(n => n && n !== 'Default');
                select.innerHTML = '';
                // Empty option signifies Default
                const emptyOpt = document.createElement('option');
                emptyOpt.value = '';
                emptyOpt.textContent = 'Default';
                select.appendChild(emptyOpt);
                filtered.forEach(name => {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    select.appendChild(opt);
                });
                // Set current workspace selection (empty for Default)
                const ws = this.currentWorkspace && this.currentWorkspace !== 'Default' ? this.currentWorkspace : '';
                select.value = ws;
            }
            if (addBtn) {
                const inline = document.getElementById('workspace-add-inline');
                const addInput = document.getElementById('workspace-add-input');
                const addConfirm = document.getElementById('workspace-add-confirm');
                const addCancel = document.getElementById('workspace-add-cancel');
                const addError = document.getElementById('workspace-add-error');

                const hideInline = () => {
                    if (inline) inline.style.display = 'none';
                    if (addInput) addInput.value = '';
                    if (addError) { addError.style.display = 'none'; addError.textContent = ''; }
                };
                const showInline = () => {
                    if (inline) inline.style.display = 'flex';
                    if (addInput) { addInput.value = ''; addInput.focus(); }
                    if (addError) { addError.style.display = 'none'; addError.textContent = ''; }
                };
                const addWorkspace = async () => {
                    if (!addInput) return;
                    const name = (addInput.value || '').trim();
                    if (!name) {
                        if (addError) { addError.textContent = 'Name is required'; addError.style.display = 'block'; }
                        return;
                    }
                    if (name.toLowerCase() === 'default') {
                        if (addError) { addError.textContent = 'Use empty selection for Default'; addError.style.display = 'block'; }
                        return;
                    }
                    const selectEl = document.getElementById('session-workspace-select');
                    if (selectEl && Array.from(selectEl.options).some(o => o.value === name)) {
                        if (addError) { addError.textContent = 'Workspace already exists'; addError.style.display = 'block'; }
                        return;
                    }
                    try {
                        // Create on server; sidebar/list will update via WebSocket (workspaces_updated)
                        await apiService.createWorkspace(name);
                        // For immediate form use, add only to the local select
                        if (selectEl) {
                            const opt = document.createElement('option');
                            opt.value = name;
                            opt.textContent = name;
                            selectEl.appendChild(opt);
                            selectEl.value = name;
                        }
                        hideInline();
                        // After adding, refocus form input so Enter can submit (Issue #391)
                        const titleInput = document.getElementById('session-title');
                        if (titleInput) {
                            titleInput.focus();
                        } else if (this.newSessionModal && this.newSessionModal.form) {
                            this.newSessionModal.form.focus();
                        }
                    } catch (err) {
                        if (addError) { addError.textContent = err?.message || 'Failed to create workspace'; addError.style.display = 'block'; }
                    }
                };

                addBtn.onclick = (e) => { e.preventDefault(); showInline(); };
                if (addConfirm) addConfirm.onclick = (e) => { e.preventDefault(); addWorkspace(); };
                if (addCancel) addCancel.onclick = (e) => { e.preventDefault(); hideInline(); };
                if (addInput) addInput.onkeydown = (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        addWorkspace();
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        hideInline();
                    }
                };
            }
        } catch (e) {
            console.warn('Failed to populate workspace list for modal:', e);
        }

        // Auto-select templates marked as default=true
        try {
            const defaults = (this.formManager.availableTemplates || []).filter(t => t?.default === true);
            if (defaults.length > 0) {
                // Update form manager selection and UI
                this.formManager.selectedTemplates = [...defaults];
                if (this.formManager.templateSearchManager) {
                    this.formManager.templateSearchManager.updateSelection([...defaults]);
                    this.formManager.templateSearchManager.refresh();
                }
                this.formManager.updateSelectedTemplatesDisplay();
                this.formManager.updateParameterForm();

                // If a single default template has a default_workspace, set it in the workspace selector
                try {
                    if (defaults.length === 1) {
                        const dwRaw = (defaults[0] && typeof defaults[0].default_workspace === 'string') ? defaults[0].default_workspace.trim() : '';
                        if (dwRaw) {
                            const selectEl = document.getElementById('session-workspace-select');
                            if (selectEl) {
                                const normalizedValue = dwRaw.toLowerCase() === 'default' ? '' : dwRaw;
                                // Add option if it's not already present (ignore default placeholder)
                                if (normalizedValue !== '' && !Array.from(selectEl.options).some(o => o.value === normalizedValue)) {
                                    const opt = document.createElement('option');
                                    opt.value = normalizedValue;
                                    opt.textContent = dwRaw;
                                    selectEl.appendChild(opt);
                                }
                                selectEl.value = normalizedValue;
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Failed to apply default template workspace:', e);
                }
            }
        } catch (e) {
            console.warn('Failed to apply default templates:', e);
        }

        this.newSessionModal.show();
    }

    hideModal() {
        this.newSessionModal.hide();
    }

    /**
     * Check if a session is interactive (allows user input)
     * @param {Object} sessionData - Session data object
     * @returns {boolean} - True if interactive, false if read-only
     */
    isSessionInteractive(sessionData) {
        if (!sessionData) return false;
        if (sessionData.is_active === false) return false;
        // Global interactive flag must be true
        if (sessionData.interactive === false) return false;
        // Shared read-only: only owner can interact
        try {
            const currentUser = this.getCurrentUsername();
            const visibility = sessionData.visibility || 'private';
            if (visibility === 'shared_readonly') {
                return String(sessionData.created_by || '') === String(currentUser || '');
            }
        } catch (_) {}
        return true;
    }

    getCurrentUsername() {
        try {
            const st = appStore.getState();
            const prefUser = st?.preferences?.auth?.username;
            if (prefUser && String(prefUser).trim()) return String(prefUser).trim();
            const infoUser = st?.systemInfo?.current_user;
            if (infoUser && String(infoUser).trim()) return String(infoUser).trim();
        } catch (_) {}
        return '';
    }

    /**
     * Handle deferred_input_updated WebSocket events to keep local queue state in sync.
     * @param {{ session_id: string, action: string, pending?: Object, pending_id?: string }} message
     */
    handleDeferredInputUpdated(message) {
        try {
            const sessionId = String(message?.session_id || '').trim();
            if (!sessionId) return;
            const action = String(message?.action || '').toLowerCase();
            let items = Array.isArray(this.deferredInputQueues.get(sessionId))
                ? [...this.deferredInputQueues.get(sessionId)]
                : [];

            if (action === 'added' && message.pending && message.pending.id) {
                const existingIndex = items.findIndex((it) => it && it.id === message.pending.id);
                if (existingIndex >= 0) {
                    items[existingIndex] = message.pending;
                } else {
                    items.push(message.pending);
                }
            } else if (action === 'removed' && message.pending_id) {
                const removeId = String(message.pending_id);
                items = items.filter((it) => !it || String(it.id) !== removeId);
            } else if (action === 'cleared') {
                items = [];
            }

            this.deferredInputQueues.set(sessionId, items);

            const activeId = (typeof this.getActiveEffectiveSessionId === 'function')
                ? this.getActiveEffectiveSessionId()
                : this.currentSessionId;
            if (activeId && activeId === sessionId) {
                this.updatePromptsDropdownBadge(sessionId);
                if (this._promptsDropdownOpen) {
                    this.updatePromptsDropdownContents(sessionId);
                }
            }
        } catch (e) {
            console.warn('[TerminalManager] handleDeferredInputUpdated failed:', e);
        }
    }

    /**
     * Refresh deferred input queue for a session from the API.
     * Intended to be called on session selection.
     */
    async refreshDeferredInputsForSession(sessionId) {
        if (!sessionId) return;
        try {
            const sd = (typeof this.getAnySessionData === 'function')
                ? this.getAnySessionData(sessionId)
                : this.sessionList?.getSessionData?.(sessionId);
            const interactive = this.isSessionInteractive(sd);
            if (!interactive) {
                this.deferredInputQueues.delete(sessionId);
                const activeId = (typeof this.getActiveEffectiveSessionId === 'function')
                    ? this.getActiveEffectiveSessionId()
                    : this.currentSessionId;
                if (activeId && activeId === sessionId) {
                    this.updatePromptsDropdownBadge(sessionId);
                }
                return;
            }
        } catch (_) { /* ignore gating errors */ }

        try {
            const resp = await apiService.getDeferredInput(sessionId);
            const items = Array.isArray(resp?.items) ? resp.items : [];
            this.deferredInputQueues.set(sessionId, items);
        } catch (e) {
            // 4xx/5xx are non-fatal for UI; treat as empty queue
            this.deferredInputQueues.set(sessionId, []);
            try { console.warn('[TerminalManager] refreshDeferredInputsForSession failed:', e); } catch (_) {}
        }

        const activeId = (typeof this.getActiveEffectiveSessionId === 'function')
            ? this.getActiveEffectiveSessionId()
            : this.currentSessionId;
        if (activeId && activeId === sessionId) {
            this.updatePromptsDropdownBadge(sessionId);
            if (this._promptsDropdownOpen) {
                this.updatePromptsDropdownContents(sessionId);
            }
        }
    }

    /**
     * Refresh stop inputs configuration for a session from the API.
     */
    async refreshStopPromptsForSession(sessionId) {
        if (!sessionId) return;
        try {
            const resp = await apiService.getStopPrompts(sessionId);
            const enabled = resp?.stop_inputs_enabled === false ? false : true;
            const prompts = Array.isArray(resp?.stop_inputs) ? resp.stop_inputs : [];
            const rearmMax = Number.isInteger(resp?.stop_inputs_rearm_max) && resp.stop_inputs_rearm_max >= 0
                ? resp.stop_inputs_rearm_max
                : 10;
            const rawRearm = Number(resp?.stop_inputs_rearm_remaining);
            const rearmRemaining = Number.isInteger(rawRearm) && rawRearm >= 0
                ? Math.min(rawRearm, rearmMax)
                : 0;
            this.stopInputsState.set(sessionId, { enabled, prompts, rearmRemaining, rearmMax });
        } catch (e) {
            // Treat failures as "no prompts" but keep enabled flag true by default
            this.stopInputsState.set(sessionId, { enabled: true, prompts: [], rearmRemaining: 0, rearmMax: 10 });
            try { console.warn('[TerminalManager] refreshStopPromptsForSession failed:', e); } catch (_) {}
        }

        const activeId = (typeof this.getActiveEffectiveSessionId === 'function')
            ? this.getActiveEffectiveSessionId()
            : this.currentSessionId;
        if (activeId && activeId === sessionId && this._promptsDropdownOpen) {
            this.updatePromptsDropdownContents(sessionId);
        }
        // Update icon highlight when stop inputs state changes
        this.updateStopInputsIconHighlightForSession(sessionId);
    }

    /**
     * Update stop inputs state from a session_updated payload.
     */
    updateStopPromptsFromSession(sessionData) {
        try {
            if (!sessionData || !sessionData.session_id) return;
            const sessionId = String(sessionData.session_id);
            const enabled = sessionData.stop_inputs_enabled === false ? false : true;
            const prompts = Array.isArray(sessionData.stop_inputs) ? sessionData.stop_inputs : [];
            const rearmMax = Number.isInteger(sessionData.stop_inputs_rearm_max) && sessionData.stop_inputs_rearm_max >= 0
                ? sessionData.stop_inputs_rearm_max
                : 10;
            const rawRearm = Number(sessionData.stop_inputs_rearm_remaining);
            const rearmRemaining = Number.isInteger(rawRearm) && rawRearm >= 0
                ? Math.min(rawRearm, rearmMax)
                : 0;
            this.stopInputsState.set(sessionId, { enabled, prompts, rearmRemaining, rearmMax });

            const activeId = (typeof this.getActiveEffectiveSessionId === 'function')
                ? this.getActiveEffectiveSessionId()
                : this.currentSessionId;
            if (activeId && activeId === sessionId && this._promptsDropdownOpen) {
                this.updatePromptsDropdownContents(sessionId);
            }
            // Update icon highlight when stop inputs state changes via session_updated
            this.updateStopInputsIconHighlightForSession(sessionId);
        } catch (e) {
            console.warn('[TerminalManager] updateStopPromptsFromSession failed:', e);
        }
    }

    /**
     * Update the badge on the prompts dropdown button for a given session.
     */
    updatePromptsDropdownBadge(sessionId) {
        try {
            const btn = this.elements?.promptsDropdownBtn;
            const badge = this.elements?.promptsDropdownBadge;
            if (!btn || !badge) return;
            const items = Array.isArray(this.deferredInputQueues.get(sessionId))
                ? this.deferredInputQueues.get(sessionId)
                : [];
            const count = items.length || 0;
            if (count > 0) {
                badge.textContent = String(count);
                badge.style.display = 'inline-flex';
            } else {
                badge.textContent = '';
                badge.style.display = 'none';
            }
        } catch (_) { /* non-fatal */ }
    }

    /**
     * Update the prompts queue icon highlight based on stop inputs state for the active session.
     */
    updateStopInputsIconHighlightForSession(sessionId) {
        try {
            const icon = this.elements?.promptsDropdownIcon;
            if (!icon) return;
            const activeId = (typeof this.getActiveEffectiveSessionId === 'function')
                ? this.getActiveEffectiveSessionId()
                : this.currentSessionId;
            if (!activeId || activeId !== sessionId) {
                icon.classList.remove('stop-inputs-enabled');
                return;
            }
            const stopState = this.stopInputsState?.get?.(sessionId) || { enabled: true, prompts: [], rearmRemaining: 0, rearmMax: 10 };
            const enabled = stopState.enabled !== false;
            if (enabled) {
                icon.classList.add('stop-inputs-enabled');
            } else {
                icon.classList.remove('stop-inputs-enabled');
            }
        } catch (_) { /* non-fatal */ }
    }

    /**
     * Render dropdown contents (deferred queue + stop inputs) for a session.
     */
    updatePromptsDropdownContents(sessionId) {
        try {
            const dropdown = this.elements?.promptsDropdownDropdown;
            if (!dropdown) return;
            const queue = Array.isArray(this.deferredInputQueues.get(sessionId))
                ? this.deferredInputQueues.get(sessionId)
                : [];
            const stopState = this.stopInputsState.get(sessionId) || { enabled: true, prompts: [], rearmRemaining: 0, rearmMax: 10 };
            const enabled = stopState.enabled !== false;
            const prompts = Array.isArray(stopState.prompts) ? stopState.prompts : [];
            const rearmMax = Number.isInteger(stopState.rearmMax) && stopState.rearmMax >= 0
                ? stopState.rearmMax
                : 10;
            const rearmRemaining = Number.isInteger(stopState.rearmRemaining) && stopState.rearmRemaining >= 0
                ? Math.min(stopState.rearmRemaining, rearmMax)
                : 0;

            const escapeHtml = (str) => {
                return String(str || '')
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            };

            const renderSourceLabel = (source) => {
                const s = String(source || '').toLowerCase();
                if (s === 'scheduled') return 'Rule';
                if (s === 'stop-inputs' || s === 'stop-prompts') return 'Stop';
                return 'API';
            };

            const queueRows = queue.map((item) => {
                const preview = escapeHtml(item?.data_preview || '');
                const label = renderSourceLabel(item?.source);
                const idAttr = escapeHtml(item?.id || '');
                return `
                    <div class="prompts-queue-item" data-pending-id="${idAttr}">
                        <div class="prompts-queue-meta">
                            <span class="prompts-queue-source">${escapeHtml(label)}</span>
                            <span class="prompts-queue-bytes">${Number(item?.bytes || 0)} bytes</span>
                        </div>
                        <div class="prompts-queue-preview">${preview}</div>
                        <button type="button" class="btn btn-xs btn-secondary prompts-queue-delete">Delete</button>
                    </div>
                `;
            }).join('') || '<div class="prompts-queue-empty">No deferred inputs queued.</div>';

            const promptsRows = prompts.map((p) => {
                const pid = escapeHtml(p?.id || '');
                const text = escapeHtml(p?.prompt || '');
                const source = String(p?.source || 'template');
                const sourceLabel = source === 'user' ? 'User' : 'Template';
                const checked = p?.armed === false ? '' : 'checked';
                const deleteActions = `
                        <div class="stop-prompt-actions">
                            <button type="button"
                                    class="btn-icon stop-prompt-delete"
                                    title="Delete stop input"
                                    aria-label="Delete stop input"></button>
                        </div>
                    `;
                return `
                    <div class="stop-prompt-row" data-prompt-id="${pid}">
                        <div class="stop-prompt-main">
                            <label class="stop-prompt-armed">
                                <input type="checkbox" class="stop-prompt-armed-toggle" ${checked}>
                                <span class="stop-prompt-text">${text}</span>
                            </label>
                        </div>
                        <div class="stop-prompt-meta">
                            <span class="stop-prompt-source">${escapeHtml(sourceLabel)}</span>
                            ${deleteActions}
                        </div>
                    </div>
                `;
            }).join('') || '<div class="stop-inputs-empty">No stop inputs configured.</div>';

            dropdown.innerHTML = `
                <div class="prompts-dropdown-section prompts-queue-section">
                    <div class="prompts-section-header">
                        <span>Deferred inputs</span>
                        <button type="button" class="btn btn-xs btn-secondary prompts-queue-clear"${queue.length ? '' : ' disabled'}>Clear all</button>
                    </div>
                    <div class="prompts-queue-list">
                        ${queueRows}
                    </div>
                </div>
                <div class="prompts-dropdown-divider"></div>
                <div class="prompts-dropdown-section stop-inputs-section">
                    <div class="prompts-section-header">
                        <label class="stop-inputs-enabled-toggle">
                            <input type="checkbox" id="stop-inputs-enabled-toggle" ${enabled ? 'checked' : ''}>
                            <span>Stop inputs enabled</span>
                        </label>
                        <button type="button"
                                class="btn btn-xs btn-secondary stop-inputs-add-btn"
                                title="Add stop input">
                            Add
                        </button>
                    </div>
                    <div class="stop-inputs-rearm-row">
                        <label class="stop-inputs-rearm-label" for="stop-inputs-rearm-slider">
                            Rearm counter
                        </label>
                        <div class="stop-inputs-rearm-control">
                            <input type="range"
                                   id="stop-inputs-rearm-slider"
                                   min="0"
                                   max="${rearmMax}"
                                   value="${rearmRemaining}">
                            <span class="stop-inputs-rearm-value">${rearmRemaining}</span>
                        </div>
                    </div>
                    <div class="stop-inputs-add-row" style="display: none;">
                        <input type="text"
                               class="form-input stop-inputs-add-input"
                               placeholder="New stop input">
                        <div class="stop-inputs-add-actions">
                            <button type="button"
                                    class="btn btn-xs btn-primary stop-inputs-add-confirm">
                                Add
                            </button>
                            <button type="button"
                                    class="btn btn-xs btn-secondary stop-inputs-add-cancel">
                                Cancel
                            </button>
                        </div>
                    </div>
                    <div class="stop-inputs-list">
                        ${promptsRows}
                    </div>
                </div>
            `;

            // Wire up clear/delete handlers
            const clearBtn = dropdown.querySelector('.prompts-queue-clear');
            if (clearBtn) {
                clearBtn.addEventListener('click', async () => {
                    try {
                        clearBtn.disabled = true;
                        await apiService.clearDeferredInput(sessionId);
                    } catch (e) {
                        console.warn('[TerminalManager] clearDeferredInput failed:', e);
                    } finally {
                        clearBtn.disabled = false;
                    }
                });
            }

            dropdown.querySelectorAll('.prompts-queue-delete').forEach((btn) => {
                btn.addEventListener('click', async (ev) => {
                    const itemEl = ev.currentTarget?.closest('.prompts-queue-item');
                    const pendingId = itemEl?.getAttribute('data-pending-id');
                    if (!pendingId) return;
                    try {
                        ev.currentTarget.disabled = true;
                        await apiService.deleteDeferredInputItem(sessionId, pendingId);
                    } catch (e) {
                        console.warn('[TerminalManager] deleteDeferredInputItem failed:', e);
                    } finally {
                        ev.currentTarget.disabled = false;
                    }
                });
            });

            // Wire up stop inputs toggles
            const enabledToggle = dropdown.querySelector('#stop-inputs-enabled-toggle');
            if (enabledToggle) {
                enabledToggle.addEventListener('change', async (ev) => {
                    const nextEnabled = !!ev.currentTarget.checked;
                    const sliderEl = dropdown.querySelector('#stop-inputs-rearm-slider');
                    const rawSliderVal = sliderEl ? Number(sliderEl.value) : NaN;
                    const sliderRearm = Number.isInteger(rawSliderVal) && rawSliderVal >= 0 ? rawSliderVal : undefined;
                    try {
                        await apiService.setStopPromptsEnabled(sessionId, nextEnabled, sliderRearm);
                    } catch (e) {
                        console.warn('[TerminalManager] setStopPromptsEnabled failed:', e);
                        // Revert checkbox on error
                        try { ev.currentTarget.checked = enabled; } catch (_) {}
                    }
                });
            }

            // Wire up rearm slider
            const rearmSlider = dropdown.querySelector('#stop-inputs-rearm-slider');
            const rearmValueEl = dropdown.querySelector('.stop-inputs-rearm-value');
            if (rearmSlider && rearmValueEl) {
                rearmSlider.addEventListener('input', () => {
                    try {
                        const rawVal = Number(rearmSlider.value);
                        const val = Number.isInteger(rawVal) && rawVal >= 0 ? rawVal : 0;
                        rearmValueEl.textContent = String(val);
                    } catch (_) { /* non-fatal */ }
                });
                rearmSlider.addEventListener('change', async () => {
                    const rawVal = Number(rearmSlider.value);
                    const nextRearm = Number.isInteger(rawVal) && rawVal >= 0 ? rawVal : 0;
                    try {
                        await apiService.setStopPromptsEnabled(sessionId, enabled, nextRearm);
                    } catch (e) {
                        console.warn('[TerminalManager] setStopPromptsEnabled (rearm) failed:', e);
                        try {
                            rearmSlider.value = String(rearmRemaining);
                            rearmValueEl.textContent = String(rearmRemaining);
                        } catch (_) {}
                    }
                });
            }

            dropdown.querySelectorAll('.stop-prompt-armed-toggle').forEach((inputEl) => {
                inputEl.addEventListener('change', async (ev) => {
                    const row = ev.currentTarget.closest('.stop-prompt-row');
                    const promptId = row?.getAttribute('data-prompt-id');
                    if (!promptId) return;
                    const nextArmed = !!ev.currentTarget.checked;
                    try {
                        await apiService.toggleStopPrompt(sessionId, promptId, nextArmed);
                    } catch (e) {
                        console.warn('[TerminalManager] toggleStopPrompt failed:', e);
                        // Revert checkbox on error
                        try { ev.currentTarget.checked = !nextArmed; } catch (_) {}
                    }
                });
            });

            // Wire up stop inputs add/delete controls
            const addBtn = dropdown.querySelector('.stop-inputs-add-btn');
            const addRow = dropdown.querySelector('.stop-inputs-add-row');
            const addInput = dropdown.querySelector('.stop-inputs-add-input');
            const addConfirm = dropdown.querySelector('.stop-inputs-add-confirm');
            const addCancel = dropdown.querySelector('.stop-inputs-add-cancel');

            const hideAddRow = () => {
                if (!addRow) return;
                try { addRow.style.display = 'none'; } catch (_) {}
                if (addInput) {
                    try {
                        addInput.value = '';
                        addInput.disabled = false;
                    } catch (_) {}
                }
                if (addConfirm) try { addConfirm.disabled = false; } catch (_) {}
                if (addCancel) try { addCancel.disabled = false; } catch (_) {}
            };

            const showAddRow = () => {
                if (!addRow || !addInput) return;
                try {
                    addRow.style.display = 'flex';
                    addInput.value = '';
                    addInput.focus();
                } catch (_) {}
            };

            const submitNewStopInput = async () => {
                if (!addInput) return;
                const raw = String(addInput.value || '').trim();
                if (!raw) return;
                try {
                    addInput.disabled = true;
                    if (addConfirm) addConfirm.disabled = true;
                    if (addCancel) addCancel.disabled = true;
                } catch (_) {}
                try {
                    const state = this.stopInputsState?.get?.(sessionId) || { prompts: [] };
                    const currentPrompts = Array.isArray(state.prompts) ? state.prompts : [];
                    const payloadPrompts = currentPrompts.map((p) => ({
                        id: p?.id,
                        prompt: p?.prompt,
                        armed: p?.armed === false ? false : true,
                        source: p?.source === 'user' ? 'user' : 'template'
                    }));
                    payloadPrompts.push({
                        prompt: raw,
                        armed: true,
                        source: 'user'
                    });
                    await apiService.setStopPrompts(sessionId, payloadPrompts);
                    hideAddRow();
                    try { await this.refreshStopPromptsForSession(sessionId); } catch (_) {}
                } catch (e) {
                    console.warn('[TerminalManager] setStopPrompts (add) failed:', e);
                    try {
                        addInput.disabled = false;
                        if (addConfirm) addConfirm.disabled = false;
                        if (addCancel) addCancel.disabled = false;
                    } catch (_) {}
                }
            };

            if (addBtn && addRow && addInput && addConfirm && addCancel) {
                addBtn.addEventListener('click', (ev) => {
                    try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                    showAddRow();
                });
                addCancel.addEventListener('click', (ev) => {
                    try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                    hideAddRow();
                });
                addConfirm.addEventListener('click', async (ev) => {
                    try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                    await submitNewStopInput();
                });
                addInput.addEventListener('keydown', async (ev) => {
                    if (ev.key === 'Enter') {
                        try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                        await submitNewStopInput();
                    } else if (ev.key === 'Escape') {
                        try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                        hideAddRow();
                    }
                });
            }

            // Wire up per-prompt delete with inline confirmation
            dropdown.querySelectorAll('.stop-prompt-delete').forEach((btnEl) => {
                // Attach trash icon if available
                try {
                    if (this.iconUtils && typeof this.iconUtils.createIcon === 'function' && !btnEl.querySelector('.bi-icon')) {
                        const icon = this.iconUtils.createIcon('trash-2', { size: 14 });
                        if (icon) btnEl.appendChild(icon);
                    }
                } catch (_) {}

                btnEl.addEventListener('click', (ev) => {
                    try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
                    const row = btnEl.closest('.stop-prompt-row');
                    if (!row) return;
                    const promptId = row.getAttribute('data-prompt-id');
                    if (!promptId) return;
                    const meta = row.querySelector('.stop-prompt-meta');
                    if (!meta) return;
                    const actions = row.querySelector('.stop-prompt-actions') || meta;

                    const group = document.createElement('div');
                    group.className = 'stop-prompt-delete-group';

                    const confirmBtn = document.createElement('button');
                    confirmBtn.className = 'btn-icon stop-prompt-delete-confirm';
                    confirmBtn.title = 'Confirm delete stop input';
                    confirmBtn.setAttribute('aria-label', 'Confirm delete stop input');
                    try {
                        if (this.iconUtils && typeof this.iconUtils.createIcon === 'function') {
                            const icon = this.iconUtils.createIcon('check', { size: 14 });
                            if (icon) confirmBtn.appendChild(icon);
                        } else {
                            confirmBtn.textContent = '✓';
                        }
                    } catch (_) {
                        confirmBtn.textContent = '✓';
                    }

                    const cancelBtn = document.createElement('button');
                    cancelBtn.className = 'btn-icon stop-prompt-delete-cancel';
                    cancelBtn.title = 'Cancel delete';
                    cancelBtn.setAttribute('aria-label', 'Cancel delete');
                    try {
                        if (this.iconUtils && typeof this.iconUtils.createIcon === 'function') {
                            const icon = this.iconUtils.createIcon('x', { size: 14 });
                            if (icon) cancelBtn.appendChild(icon);
                        } else {
                            cancelBtn.textContent = '×';
                        }
                    } catch (_) {
                        cancelBtn.textContent = '×';
                    }

                    const restore = () => {
                        try { group.remove(); } catch (_) {}
                        if (actions && !actions.contains(btnEl)) {
                            try { actions.appendChild(btnEl); } catch (_) {}
                        }
                    };

                    cancelBtn.addEventListener('click', (evt) => {
                        try { evt.preventDefault(); evt.stopPropagation(); } catch (_) {}
                        restore();
                    });

                    confirmBtn.addEventListener('click', async (evt) => {
                        try { evt.preventDefault(); evt.stopPropagation(); } catch (_) {}
                        try {
                            confirmBtn.disabled = true;
                            cancelBtn.disabled = true;
                        } catch (_) {}
                        try {
                            const state = this.stopInputsState?.get?.(sessionId) || { prompts: [] };
                            const currentPrompts = Array.isArray(state.prompts) ? state.prompts : [];
                            const remaining = currentPrompts.filter((p) => !p || String(p.id || '') !== String(promptId));
                            const payloadPrompts = remaining.map((p) => ({
                                id: p?.id,
                                prompt: p?.prompt,
                                armed: p?.armed === false ? false : true,
                                source: p?.source === 'user' ? 'user' : 'template'
                            }));
                            await apiService.setStopPrompts(sessionId, payloadPrompts);
                            try { await this.refreshStopPromptsForSession(sessionId); } catch (_) {}
                        } catch (e) {
                            console.warn('[TerminalManager] setStopPrompts (delete) failed:', e);
                            try {
                                confirmBtn.disabled = false;
                                cancelBtn.disabled = false;
                            } catch (_) {}
                            restore();
                        }
                    });

                    // Swap delete button with confirm/cancel group inside actions container
                    if (actions) {
                        try { actions.removeChild(btnEl); } catch (_) {}
                        group.appendChild(confirmBtn);
                        group.appendChild(cancelBtn);
                        actions.appendChild(group);
                    }
                });
            });
        } catch (e) {
            console.warn('[TerminalManager] updatePromptsDropdownContents failed:', e);
        }
    }

    /**
     * Toggle visibility of the prompts dropdown for the current effective session.
     */
    togglePromptsDropdown() {
        try {
            const btn = this.elements?.promptsDropdownBtn;
            const dropdown = this.elements?.promptsDropdownDropdown;
            if (!btn || !dropdown) return;
            const activeId = (typeof this.getActiveEffectiveSessionId === 'function')
                ? this.getActiveEffectiveSessionId()
                : this.currentSessionId;
            if (!activeId) return;

            const nextOpen = !this._promptsDropdownOpen;
            this._promptsDropdownOpen = nextOpen;
            if (nextOpen) {
                // Ensure latest state for active session
                this.updatePromptsDropdownBadge(activeId);
                this.updatePromptsDropdownContents(activeId);
                dropdown.classList.add('show');
                btn.classList.add('active');
                btn.setAttribute('aria-expanded', 'true');
                
                // Close when clicking outside or when Escape is pressed
                if (!this._promptsDropdownDocHandler) {
                    this._promptsDropdownDocHandler = (ev) => {
                        if (ev && ev.type === 'keydown') {
                            if (ev.key === 'Escape') {
                                try { ev.preventDefault(); } catch (_) {}
                                try { ev.stopPropagation(); } catch (_) {}
                                this.closePromptsDropdown();
                            }
                            return;
                        }
                        const target = ev.target;
                        if (btn.contains(target) || dropdown.contains(target)) return;
                        this.closePromptsDropdown();
                    };
                    document.addEventListener('click', this._promptsDropdownDocHandler);
                    document.addEventListener('keydown', this._promptsDropdownDocHandler, true);
                }
            } else {
                this.closePromptsDropdown();
            }
        } catch (e) {
            console.warn('[TerminalManager] togglePromptsDropdown failed:', e);
        }
    }

    closePromptsDropdown() {
        try {
            const btn = this.elements?.promptsDropdownBtn;
            const dropdown = this.elements?.promptsDropdownDropdown;
            this._promptsDropdownOpen = false;
            if (dropdown) dropdown.classList.remove('show');
            if (btn) {
                btn.classList.remove('active');
                btn.setAttribute('aria-expanded', 'false');
            }
            if (this._promptsDropdownDocHandler) {
                document.removeEventListener('click', this._promptsDropdownDocHandler);
                document.removeEventListener('keydown', this._promptsDropdownDocHandler, true);
                this._promptsDropdownDocHandler = null;
            }
        } catch (_) { /* ignore */ }
    }


    showTerminateModal(sessionId) {
        this.sessionToTerminate = sessionId;

        // If this is a local-only active session and desktop localpty is available,
        // show a tailored confirmation with "Don't ask again" support.
        try {
            const sd = this.sessionList?.getSessionData?.(sessionId);
            const localFlagAvailable = !!(window.desktop && window.desktop.localpty);
            const isLocalOnly = localFlagAvailable && sd && sd.local_only === true;
            const isActive = sd && sd.is_active !== false;
            if (isLocalOnly && isActive) {
                // Load settings to see if confirmation is disabled
                const store = getSettingsStore();
                let settings = {};
                try {
                    const res = store.loadSync?.();
                    settings = (res && res.ok && res.settings) || {};
                } catch (_) { settings = {}; }
                const disableConfirm = !!(settings?.localTerminal?.closeConfirmDisabled);
                if (disableConfirm) {
                    // Skip modal entirely
                    this.doTerminateSession(sessionId);
                    return;
                }
                // Prepare modal UI for local close
                this._isLocalCloseFlow = true;
                const modalEl = this.elements?.terminateModal;
                if (modalEl) {
                    // Save previous title/message/confirm label
                    const titleEl = modalEl.querySelector('[data-modal-title]');
                    const msgEl = modalEl.querySelector('[data-modal-message]');
                    const confirmBtn = modalEl.querySelector('[data-modal-confirm]');
                    this._prevTerminateModalTitle = titleEl?.textContent || 'Terminate Session';
                    this._prevTerminateModalMessage = msgEl?.textContent || this.terminateModal?.message || '';
                    this._prevTerminateModalConfirm = this.terminateModal?.confirmText || (confirmBtn?.textContent || 'Terminate');
                    // Set local-close content
                    try { if (titleEl) titleEl.textContent = 'Close Local Terminal'; } catch (_) {}
                    try { this.terminateModal.setMessage('Close local terminal? This will terminate the local process.'); } catch (_) {}
                    try { this.terminateModal.confirmText = 'Close'; } catch (_) {}
                    try { if (confirmBtn) confirmBtn.textContent = 'Close'; } catch (_) {}
                    // Show/hide the "Don't ask again" row
                    const dontAskRow = modalEl.querySelector('#local-close-dont-ask-row');
                    if (dontAskRow) {
                        dontAskRow.style.display = '';
                        const cb = modalEl.querySelector('#local-close-dont-ask');
                        if (cb) { cb.checked = false; }
                    }
                }
            } else {
                this._isLocalCloseFlow = false;
            }
        } catch (_) {
            this._isLocalCloseFlow = false;
        }

        // Disable the main terminate button while modal is open
        this.elements.closeBtn.disabled = true;

        this.terminateModal.show();
    }

    hideTerminateModal() {
        // Reset any local-close customizations before hiding
        try {
            if (this._isLocalCloseFlow && this.elements?.terminateModal) {
                const modalEl = this.elements.terminateModal;
                const titleEl = modalEl.querySelector('[data-modal-title]');
                const confirmBtn = modalEl.querySelector('[data-modal-confirm]');
                // Hide the don't-ask row
                const dontAskRow = modalEl.querySelector('#local-close-dont-ask-row');
                if (dontAskRow) dontAskRow.style.display = 'none';
                // Restore title/message/confirm label
                try { if (titleEl && this._prevTerminateModalTitle) titleEl.textContent = this._prevTerminateModalTitle; } catch (_) {}
                try { if (this._prevTerminateModalMessage) this.terminateModal.setMessage(this._prevTerminateModalMessage); } catch (_) {}
                try { this.terminateModal.confirmText = this._prevTerminateModalConfirm || 'Terminate'; } catch (_) {}
                try { if (confirmBtn) confirmBtn.textContent = this._prevTerminateModalConfirm || 'Terminate'; } catch (_) {}
            }
        } catch (_) {}

        this.terminateModal.hide();
        this.sessionToTerminate = null;
        this._isLocalCloseFlow = false;

        // Re-enable the main terminate/close button without overriding state-derived label
        if (this.elements.closeBtn) {
            this.elements.closeBtn.disabled = false;
            try {
                // Reflect current session state: show Close for ended sessions, Terminate otherwise
                const sd = this.sessionList?.getSessionData?.(this.currentSessionId);
                const isEnded = !!(sd && sd.is_active === false);
                if (isEnded) {
                    this.elements.closeBtn.textContent = 'Close';
                    this.elements.closeBtn.title = 'Close session';
                } else {
                    const label = (this.toolbarController && this.toolbarController._terminateLabel) || 'Terminate';
                    this.elements.closeBtn.textContent = label;
                    this.elements.closeBtn.title = 'Terminate session';
                }
            } catch (_) {
                // If state lookup fails, leave existing label as-is
            }
        }
    }

    showDeleteModal(sessionId) {
        this.sessionToDelete = sessionId;
        
        // Header Delete button removed; nothing to disable here
        
        this.deleteModal.show();
    }

    hideDeleteModal() {
        this.deleteModal.hide();
        this.sessionToDelete = null;
        
        // Header Delete button removed; nothing to re-enable here
    }

    async confirmTerminate() {
        if (this.sessionToTerminate) {
            // Persist "Don't ask again" if in local-close flow
            try {
                if (this._isLocalCloseFlow && this.elements?.terminateModal) {
                    const cb = this.elements.terminateModal.querySelector('#local-close-dont-ask');
                    if (cb && cb.checked) {
                        const store = getSettingsStore();
                        const current = (await (store.load?.())) || {};
                        const next = { ...current, localTerminal: { ...(current.localTerminal || {}), closeConfirmDisabled: true } };
                        await (store.save?.(next));
                    }
                }
            } catch (_) {}

            // Set loading state using the new modal system
            this.terminateModal.setLoadingState(true, 'Terminating...');
            await this.doTerminateSession(this.sessionToTerminate);
        }
        this.hideTerminateModal();
    }

    async confirmDelete() {
        if (this.sessionToDelete) {
            // Set loading state using the new modal system
            this.deleteModal.setLoadingState(true, 'Deleting...');
            
            await this.doDeleteSessionHistory(this.sessionToDelete);
        }
        this.hideDeleteModal();
    }

    showTextInputModal() {
        // Determine auto-close behavior prior to showing
        try {
            const hasIncluded = !!(this._includedSendText && String(this._includedSendText).length > 0);
            const prefClose = !!appStore.getState('preferences.display.closeSendTextOnSubmit');
            // Always close when launched with included context; otherwise follow preference
            if (this.textInputModal) this.textInputModal.autoClose = hasIncluded ? true : prefClose;
        } catch (_) { /* ignore */ }
        // Apply saved size and position if available; else center the modal
        try { this.mobileInterface.applyTextInputSize?.(); } catch (_) {}
        if (!this.mobileInterface.applyTextInputPosition()) {
            // Default center position
            const modal = this.elements.textInputModal;
            modal.style.transform = 'translate(-50%, -50%)';
            modal.style.left = '50%';
            modal.style.top = '50%';
        }
        
        // Restore z-index from localStorage or bring to front
        this.mobileInterface.restoreOrSetZIndex('textInputModal');
        
        this.textInputModal.show();
        const textInputBtn = document.getElementById('text-input-btn');
        textInputBtn?.classList.add('active');

        // Save toggle state to StateStore
        try { queueStateSet('textInputModalVisible', true, 200); } catch (_) {}

        // Focus the text input field
        const textInputField = document.getElementById('text-input-text');
        if (textInputField) {
            // Small delay to ensure modal is fully shown before focusing
            setTimeout(() => {
                textInputField.focus();
            }, 100);
        }
        this.updateTextInputState();

        // Initialize position tracking after showing
        this.mobileInterface.initializeTextInputPosition();
        // Begin resize tracking after showing
        try { this.mobileInterface.startTextInputResizeTracking?.(); } catch (_) {}
        // While open, support toggle-to-close via Cmd/Alt+Shift+I even when input lacks focus
        try {
            if (!this._textInputDocKeyHandler) {
                const handler = (e) => {
                    try {
                        const hasShift = !!e.shiftKey;
                        const hasMod = !!(e.metaKey || e.altKey);
                        const codeI = String(e.code || '').toLowerCase() === 'keyi';
                        const keyI = String(e.key || '').toLowerCase() === 'i';
                        if (hasShift && hasMod && (codeI || keyI)) {
                            e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation?.();
                            this.hideTextInputModal();
                        }
                    } catch (_) {}
                };
                document.addEventListener('keydown', handler, true);
                this._textInputDocKeyHandler = handler;
            }
        } catch (_) { /* ignore */ }
    }

    // Show modal with pre-populated included content (readonly area above input)
    showTextInputModalWithIncluded(text, options = {}) {
        this.setIncludedSendText(typeof text === 'string' ? text : '');
        // Optionally set a target override for where send should go
        const tgt = options && options.targetSessionId ? String(options.targetSessionId) : '';
        this._textInputTargetOverride = tgt || null;
        // Optionally capture selection source so we can clear xterm highlight after send
        const src = options && options.sourceSessionId ? String(options.sourceSessionId) : '';
        this._textInputSelectionSource = src || null;
        this.showTextInputModal();
    }

    hideTextInputModal() {
        // Persist the current size before hiding so reopening restores exactly
        try {
            const modal = this.elements?.textInputModal;
            if (modal && modal.classList?.contains('show')) {
                const rect = modal.getBoundingClientRect();
                let width = Math.round(rect.width);
                let height = Math.round(rect.height);
                // Clamp against computed min/max to avoid saving zero/invalid sizes
                try {
                    const cs = window.getComputedStyle(modal);
                    const toPx = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
                    const minW = toPx(cs.minWidth);
                    const maxW = toPx(cs.maxWidth);
                    const minH = toPx(cs.minHeight);
                    const maxH = toPx(cs.maxHeight);
                    if (Number.isFinite(minW)) width = Math.max(width, Math.round(minW));
                    if (Number.isFinite(maxW)) width = Math.min(width, Math.round(maxW));
                    if (Number.isFinite(minH)) height = Math.max(height, Math.round(minH));
                    if (Number.isFinite(maxH)) height = Math.min(height, Math.round(maxH));
                    // Also clamp to viewport
                    width = Math.max(160, Math.min(width, Math.max(200, window.innerWidth - 20)));
                    height = Math.max(120, Math.min(height, Math.max(140, window.innerHeight - 20)));
                } catch (_) {}
                queueStateSet('textInputModalSize', { width, height }, 0);
                // Stop resize tracking before triggering DOM hide to avoid a post-hide resize save overriding this size
                try { this.mobileInterface.stopTextInputResizeTracking?.(); } catch (_) {}
            }
        } catch (_) { /* ignore */ }

        this.textInputModal.hide();
        const textInputBtn = document.getElementById('text-input-btn');
        textInputBtn?.classList.remove('active');

        // Clear toggle state (positions are preserved by draggable system)
        try { queueStateSet('textInputModalVisible', false, 200); } catch (_) {}

        this.updateTextInputState();

        // Auto-focus back on terminal after closing modal (desktop only)
        if (!this.viewController.isMobile() && this.currentSession) {
            setTimeout(() => {
                if (this.currentSession && this.currentSession.focus) {
                    this.currentSession.focus();
                }
            }, 100);
        }
        // (already stopped tracking above before hide)
        // Detach global toggle handler for this modal
        try {
            if (this._textInputDocKeyHandler) {
                document.removeEventListener('keydown', this._textInputDocKeyHandler, true);
                this._textInputDocKeyHandler = null;
            }
        } catch (_) { /* ignore */ }
    }
    
    clearTextInputText() {
        this.textInputModal.setValue('');
        this.textInputModal.focus();
        this.updateTextInputState();
    }

    copyTextInputText() {
        const text = this.textInputModal.getValue();
        if (!text.trim()) {
            console.warn('Cannot copy empty text');
            return;
        }
        
        // Use the existing copy utility with fallback
        TerminalAutoCopy.copyToClipboard(text, 'text-input');
    }

    async sendTextInputText() {
        // Target the effective active session (container child when its tab is active)
        // Use explicit override target if set (Shift-select from child), otherwise effective active
        const targetSessionId = (this._textInputTargetOverride && String(this._textInputTargetOverride).length > 0)
            ? this._textInputTargetOverride
            : ((typeof this.getActiveEffectiveSessionId === 'function') ? this.getActiveEffectiveSessionId() : this.currentSessionId);
        // Capture the override now; modal autoClose triggers hide() which may clear it before we finish
        const focusAfterSendTarget = this._textInputTargetOverride ? String(this._textInputTargetOverride) : '';

        if (!targetSessionId) {
            console.warn('Cannot send text input - no active session');
            return;
        }

        // Check if target session is interactive
        const sessionData = (typeof this.getAnySessionData === 'function')
            ? this.getAnySessionData(targetSessionId)
            : this.sessionList.getSessionData(targetSessionId);
        const isInteractive = this.isSessionInteractive(sessionData);
        if (!isInteractive) {
            console.warn('Cannot send text input - session is not interactive');
            return;
        }

        const userText = this.textInputModal.getValue() || '';
        const included = (this.elements?.textInputIncluded?.value ?? '') || '';
        // Build combined payload: included + optional newline + user text
        let text = '';
        if (included && userText) {
            text = `${included}\n${userText}`;
        } else {
            text = included || userText;
        }
        if (!String(text).trim()) {
            console.warn('Cannot send empty text');
            return;
        }

        try {
            // Use centralized helper to mirror backend API behavior (delay + CR)
            const sent = await this.sendInput(targetSessionId, text, {
                delayMs: 120,
                enterStyle: 'cr',
                normalizeCRLF: true,
                stripFinalNewline: true,
                // Suppress stdin_injected notification for the requester
                notify: false
            });
            // Marker registration now handled via WS 'stdin_injected' to avoid duplicates
            // Clear any xterm selection highlight from the selection source (if present)
            if (this._textInputSelectionSource) {
                this._clearSessionSelection(this._textInputSelectionSource);
            }
            
            // Clear the text using the new modal system
            this.textInputModal.setValue('');
            this.setIncludedSendText('');
            // If override target was used, focus that main session and switch to terminal tab
            if (focusAfterSendTarget) {
                try {
                    await this.activateSession(focusAfterSendTarget, { forceTabId: 'terminal' });
                } catch (_) { /* ignore */ }
            }
            // Clear override and update state (redundant with hide handler; defensive to avoid stale targets)
            this._textInputTargetOverride = null;
            this.updateTextInputState();
            
            // Focus back on terminal for desktop only if modal is closing
            if (this.textInputModal?.autoClose && !this.viewController.isMobile() && this.currentSession) {
                setTimeout(() => {
                    if (this.currentSession && this.currentSession.focus) {
                        this.currentSession.focus();
                    }
                }, 100);
            }
        } catch (error) {
            console.error(`Failed to send text input: ${error.message}`);
        }
    }

    /**
     * Handler methods for the new modal system
     */
    async handleNewSessionSubmit(formData) {
        try {
            // If multiple templates are selected (and not the synthetic Local Shell), ask for confirmation
            try {
                const selected = Array.isArray(this.formManager?.selectedTemplates) ? this.formManager.selectedTemplates : [];
                const realSelected = selected.filter(t => t && t.isLocal !== true);
                if (realSelected.length > 1 && this.multiTemplatesConfirmModal) {
                    this.multiTemplatesConfirmModal.show();
                    return; // Defer actual creation to confirmation handler
                }
            } catch (_) { /* ignore, fall through to create */ }

            await this.createNewSession();
        } catch (error) {
            console.error('Failed to create session:', error);
        }
    }

    validateNewSessionForm(formData) {
        return this.formManager.validateForm(formData);
    }

    async handleTextInputSubmit(formData) {
        // Determine desired auto-close at submit time
        let desiredAutoClose = false;
        try {
            const hasIncluded = !!(this._includedSendText && String(this._includedSendText).length > 0);
            const prefClose = !!appStore.getState('preferences.display.closeSendTextOnSubmit');
            desiredAutoClose = hasIncluded ? true : prefClose;
            // Prevent FormModal from auto-hiding immediately so we can send first
            if (this.textInputModal) this.textInputModal.autoClose = false;
        } catch (_) { /* ignore */ }
        // Send the text first
        try { await this.sendTextInputText(); } catch (_) {}
        // Then close if desired
        if (desiredAutoClose) {
            try { this.hideTextInputModal(); } catch (_) {}
        }
    }

    updateTextInputState() {
        const sendBtn = this.elements?.textInputSend;
        if (!sendBtn) return;
        // Use override target when set (Shift-select from child); else effective active session
        const sessionId = (this._textInputTargetOverride && String(this._textInputTargetOverride).length > 0)
            ? this._textInputTargetOverride
            : ((typeof this.getActiveEffectiveSessionId === 'function') ? this.getActiveEffectiveSessionId() : this.currentSessionId);
        const textValue = this.textInputModal?.getValue?.() ?? '';
        const included = this.elements?.textInputIncluded?.value ?? '';
        const combined = included ? (textValue ? `${included}\n${textValue}` : included) : textValue;
        if (!sessionId) {
            sendBtn.disabled = true;
            return;
        }
        const sessionData = (typeof this.getAnySessionData === 'function')
            ? this.getAnySessionData(sessionId)
            : (this.sessionList?.getSessionData(sessionId));
        const isInteractive = this.isSessionInteractive(sessionData);
        const isAttached = this.isSessionAttached(sessionId);
        const hasText = typeof combined === 'string' && combined.trim().length > 0;
        sendBtn.disabled = !(isInteractive && isAttached && hasText);
    }

    isSessionAttached(sessionId) {
        if (!sessionId) return false;
        const current = this.currentSession;
        if (current && current.sessionId === sessionId && current.isAttached === true) {
            return true;
        }
        return this.attachedSessions instanceof Set ? this.attachedSessions.has(sessionId) : false;
    }

    // Internal helpers for included content UI
    setIncludedSendText(text) {
        this._includedSendText = String(text || '');
        const label = this.elements?.textInputIncludedLabel;
        const area = this.elements?.textInputIncluded;
        const divider = this.elements?.textInputDivider;
        const modalEl = this.elements?.textInputModal;
        const has = this._includedSendText.length > 0;
        // Toggle class on the modal for CSS-driven visibility
        try { if (modalEl) modalEl.classList.toggle('send-text--has-included', !!has); } catch (_) {}
        if (area) { area.value = this._includedSendText; }
        this.updateTextInputState();
    }

    // Links controller delegates
    toggleSessionLinksDropdown() { this.linksController?.toggle(); }
    updateSessionLinks(sessionData) {
        this.linksController?.updateSessionLinks(sessionData);
    }

    // Transitions controller delegates
    updateSessionTransitionsUI() {
        try {
            const sid = this.getActiveEffectiveSessionId?.();
            const sd = sid ? this.getAnySessionData?.(sid) : null;
            console.log('[TerminalManager] updateSessionTransitionsUI', { sid, load_history: sd?.load_history, capture: sd?.capture_activity_transitions });
        } catch (_) {}
        this.transitionsController?.updateVisibilityAndRender?.();
    }

    emitNoteUpdate(sessionId, payload = {}) {
        if (!this.eventBus) return;

        const version = Number.isInteger(payload.version)
            ? payload.version
            : Number.isInteger(payload.note_version) ? payload.note_version : 0;

        this.eventBus.emit('note-updated', {
            sessionId,
            note: typeof payload.note === 'string' ? payload.note : (typeof payload.content === 'string' ? payload.content : ''),
            version,
            updatedAt: payload.updatedAt ?? payload.note_updated_at ?? null,
            updatedBy: payload.updatedBy ?? payload.note_updated_by ?? null,
            isCurrent: this.currentSessionId === sessionId
        });
    }

    async deleteSessionHistory(sessionId) {
        this.showDeleteModal(sessionId);
    }

    async createNewSession() {
        // Prevent double session creation (just in case)
        if (this.isCreatingSession) {
            return;
        }
        
        this.isCreatingSession = true;
        
        try {
            // If the synthetic Local Shell is selected, create a local session without backend calls
            try {
                const st = Array.isArray(this.formManager?.selectedTemplates) ? this.formManager.selectedTemplates : [];
                if (st.length === 1 && st[0] && st[0].isLocal === true) {
                    await this.createLocalSession();
                    this.hideModal();
                    // Close mobile sidebar if open
                    { const app = getContext()?.app; app?.hideMobileSidebar?.(); }
                    return;
                }
            } catch (_) { /* ignore */ }

            // Check if we should auto-attach and set the flag BEFORE making API calls
            const selectedTemplates = this.formManager.selectedTemplates;
            const shouldAutoAttach = selectedTemplates.length === 0 || 
                (selectedTemplates.length === 1 && selectedTemplates[0].auto_attach !== false) ||
                (selectedTemplates.length > 1 && selectedTemplates[0].auto_attach !== false);
            
            if (shouldAutoAttach) {
                // Set flag to auto-attach the next created session
                this.expectAutoAttachNext = true;
            }
            
            // Calculate terminal size based on available space
            const terminalSize = this.viewController.calculateTerminalSize();
            
            // Build form data using the form manager - now returns an array
            const sessionRequests = this.formManager.buildFormData(this.clientId, terminalSize);
            // Clear any headless defaults once we've captured the request payloads
            try { this.formManager._headlessDefaultParams = null; } catch (_) {}
            
            // Track created sessions and capture any error details
            const createdSessions = [];
            let firstSessionId = null;
            let lastCreateError = null;
            
            // Create sessions sequentially
            for (let i = 0; i < sessionRequests.length; i++) {
                const formData = sessionRequests[i];
                
                // If a working directory is provided as '~', expand to user home
                if (formData.working_directory === '~') {
                    formData.working_directory = '/home/' + (await this.getUsername());
                }
                
                try {
                    const sessionData = await apiService.createSession(formData);
                    
                    if (sessionData) {
                        createdSessions.push(sessionData);
                        
                        // Track the first session for auto-attach
                        if (i === 0) {
                            firstSessionId = sessionData.session_id;
                        }
                    }
                } catch (error) {
                    console.error(`Failed to create session ${i + 1}/${sessionRequests.length}:`, error);
                    lastCreateError = error || lastCreateError;
                    // If this is the only request, surface the specific error immediately
                    if (sessionRequests.length === 1) {
                        throw error;
                    }
                    // Otherwise, continue to try remaining requests
                }
            }
            
            if (createdSessions.length > 0) {
                // Sessions created successfully (flag was already set before API calls if needed)

                // Hide modal
                this.hideModal();
                
                // Close mobile sidebar if open
                { const app = getContext()?.app; app?.hideMobileSidebar?.(); }
                
                // The sessions will be added to the list when we receive WebSocket notifications
                
                // Show success message if multiple sessions were created
                if (createdSessions.length > 1) {
                }
            } else {
                // All session creations failed — rethrow last specific error when available
                if (lastCreateError) throw lastCreateError;
                throw new Error('Failed to create any sessions');
            }
        } catch (error) {
            // Clear the auto-attach flag if session creation failed
            this.expectAutoAttachNext = false;
            errorHandler.handle(error, { context: 'create_session' });
        } finally {
            // Reset the flag
            this.isCreatingSession = false;
        }
    }

    /**
     * Create a local terminal session using LocalPTYClient transport
     * (renderer-only, behind Electron + preload feature flag)
     */
    async createLocalSession() {
        // Feature gate: require explicit enablement via user features
        try {
            const featOn = !!(appStore.getState()?.auth?.features?.local_terminal_enabled === true);
            if (!featOn) {
                console.warn('[TerminalManager] Local terminal feature disabled by server feature flags');
                return;
            }
        } catch (_) { /* fall through */ }
        const available = !!(window.desktop && window.desktop.isElectron && window.desktop.localpty);
        if (!available) {
            console.warn('[TerminalManager] Local PTY not available in this environment');
            return;
        }

        // Determine an initial size if possible
        let initialSize = { cols: 80, rows: 24 };
        try {
            const sz = this.viewController?.calculateTerminalSize?.();
            if (sz && Number.isFinite(sz.cols) && Number.isFinite(sz.rows)) initialSize = { cols: sz.cols, rows: sz.rows };
        } catch (_) {}

        // Ask the desktop main process to create the PTY and return a sessionId we can bind to
        let created = null;
        try {
            created = await window.desktop.localpty.create({ cols: initialSize.cols, rows: initialSize.rows });
        } catch (e) {
            console.error('[TerminalManager] Failed to create local PTY:', e);
            return;
        }
        if (!created || created.ok !== true || !created.sessionId) {
            console.warn('[TerminalManager] Local PTY create failed:', created);
            return;
        }
        const sessionId = String(created.sessionId);

        // Prepare container in the terminal view
        const sessionContainer = document.createElement('div');
        sessionContainer.className = 'terminal-session-container';
        sessionContainer.style.width = '100%';
        sessionContainer.style.height = '100%';

        // Minimal session data used by UI components
        // Determine target workspace via helper
        const targetWorkspace = this.resolveWorkspaceForLocalSession();

        const sessionData = {
            session_id: sessionId,
            title: '',
            is_active: true,
            interactive: true,
            load_history: false,
            save_session_history: false,
            visibility: 'private',
            local_only: true,
            // Provide fields expected by the sidebar/tab renderers
            // Ensure local sessions sort to the end by default (created desc)
            // Using 0 makes them "oldest" so they append at the bottom; among locals
            // insertion order is preserved via Map iteration order.
            created_at: 0,
            working_directory: '~',
            workspace: targetWorkspace
        };

        // Publish the session to the list and select it so tabs/sidebar reflect it
        try {
            // Persist selection and workspace mapping BEFORE entering workspace so restore logic prefers the new session
            try {
                if (targetWorkspace) {
                    this.workspaceSelections.set(targetWorkspace, sessionId);
                    const selectionsObj = Object.fromEntries(this.workspaceSelections);
                    queueStateSet('workspace_session_selections', selectionsObj, 0);
                }
            } catch (_) { /* non-fatal */ }
            try {
                const res = getStateStore().loadSync && getStateStore().loadSync();
                const st = res && res.ok ? (res.state || {}) : {};
                const existing = (st && typeof st['local_session_workspaces'] === 'object') ? st['local_session_workspaces'] : {};
                const map = Object.assign({}, existing, { [sessionId]: targetWorkspace });
                queueStateSet('local_session_workspaces', map, 0);
            } catch (_) { /* ignore */ }

            // Add to store first so it is visible when switching workspace
            this.sessionList?.addSession?.(sessionData, true);
            // Mark as current for selection logic during enterWorkspace
            this.currentSessionId = sessionId;
            this.currentSession = null;
            // Update sidebar selection immediately
            this.sessionList?.setActiveSession?.(sessionId);
            this.sessionTabsManager?.setActiveSession?.(sessionId);
            // Now enter the target workspace so selection keeps the new session (it's visible in the list)
            try { if (this.enterWorkspace) this.enterWorkspace(targetWorkspace); } catch (_) {}
            // Explicitly re-select the new session after workspace switch to override any fallback selection
            try { this.selectSession?.(sessionId, { autoSelect: true }); } catch (_) {}
            // (persisted above)
        } catch (_) { /* non-fatal */ }

        // Create LocalPTY transport and TerminalSession
        const transport = new LocalPTYClient(this.eventBus);
        const terminalSession = new TerminalSession(
            sessionId,
            sessionContainer,
            transport,
            this.eventBus,
            sessionData,
            null
        );

        // Replace terminal view with the new container
        this.viewController.clearTerminalView();
        this.elements.terminalView.appendChild(sessionContainer);

        // Initialize and attach
        terminalSession.init();
        this.sessions.set(sessionId, terminalSession);
        this.currentSession = terminalSession;
        this.currentSessionId = sessionId;
        this.attachedSessions.add(sessionId);
        await terminalSession.attach(false); // Skip history for local

        // Force a fit on next tick and log dimensions for diagnostics
        try {
            const logFit = () => {
                try {
                    terminalSession.fit?.();
                    const rect = sessionContainer.getBoundingClientRect ? sessionContainer.getBoundingClientRect() : null;
                    console.log('[LocalPTY] post-attach fit', {
                        sessionId,
                        cols: terminalSession?.terminal?.cols,
                        rows: terminalSession?.terminal?.rows,
                        rect: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null
                    });
                } catch (_) {}
            };
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => setTimeout(logFit, 0));
            } else {
                setTimeout(logFit, 0);
            }
        } catch (_) { /* ignore */ }

        // Refresh header from computed display (no hard-coded default title)
        try { this.refreshHeaderForSession(sessionId); } catch (_) {}
        this.updateTextInputState();

        // Nothing else to start: attach() already wired the transport; create() spawned the PTY.
    }

    /**
     * Adopt an existing local PTY session created in another renderer (main window).
     * Does not contact the server. Renders terminal immediately and attaches via LocalPTYClient.
     * @param {string} sessionId
     */
    async adoptLocalSession(sessionId) {
        const sid = String(sessionId || '').trim();
        if (!sid) return;
        const available = !!(window.desktop && window.desktop.isElectron && window.desktop.localpty);
        if (!available) {
            console.warn('[TerminalManager] adoptLocalSession: Local PTY bridge unavailable');
            try {
                this.viewController.clearTerminalView();
                const msg = document.createElement('div');
                msg.className = 'empty-state';
                msg.textContent = 'Local session unavailable in this environment';
                this.elements.terminalView.appendChild(msg);
            } catch (_) {}
            return;
        }

        // Prepare container in the terminal view
        const sessionContainer = document.createElement('div');
        sessionContainer.className = 'terminal-session-container';
        sessionContainer.style.width = '100%';
        sessionContainer.style.height = '100%';

        // Minimal session data for UI components
        // Determine target workspace via helper
        const targetWorkspace = this.resolveWorkspaceForLocalSession();

        const sessionData = {
            session_id: sid,
            title: '',
            is_active: true,
            interactive: true,
            load_history: false,
            save_session_history: false,
            visibility: 'private',
            local_only: true,
            created_at: 0,
            working_directory: '~',
            workspace: targetWorkspace
        };

        // Add to sidebar and make active
        try {
            // Persist selection and workspace mapping BEFORE entering workspace
            try {
                if (targetWorkspace) {
                    this.workspaceSelections.set(targetWorkspace, sid);
                    const selectionsObj = Object.fromEntries(this.workspaceSelections);
                    queueStateSet('workspace_session_selections', selectionsObj, 0);
                }
            } catch (_) { /* ignore */ }
            try {
                const res = getStateStore().loadSync && getStateStore().loadSync();
                const st = res && res.ok ? (res.state || {}) : {};
                const existing = (st && typeof st['local_session_workspaces'] === 'object') ? st['local_session_workspaces'] : {};
                const map = Object.assign({}, existing, { [sid]: targetWorkspace });
                queueStateSet('local_session_workspaces', map, 0);
            } catch (_) { /* ignore */ }

            // Add first and mark selection so it's kept when entering workspace
            this.sessionList?.addSession?.(sessionData, true);
            this.currentSessionId = sid;
            this.currentSession = null;
            this.sessionList?.setActiveSession?.(sid);
            this.sessionTabsManager?.setActiveSession?.(sid);
            // Now switch to the target workspace (new session is already visible)
            try { if (this.enterWorkspace) this.enterWorkspace(targetWorkspace); } catch (_) {}
            // Explicitly re-select the new session after workspace switch to override any fallback selection
            try { this.selectSession?.(sid, { autoSelect: true }); } catch (_) {}
            // (persisted above)
        } catch (_) { /* ignore */ }

        // Create LocalPTY transport bound to this session
        const transport = new LocalPTYClient(this.eventBus);
        const terminalSession = new TerminalSession(
            sid,
            sessionContainer,
            transport,
            this.eventBus,
            sessionData,
            null
        );

        // Swap view and initialize
        this.viewController.clearTerminalView();
        this.elements.terminalView.appendChild(sessionContainer);
        terminalSession.init();

        // Register and mark current
        this.sessions.set(sid, terminalSession);
        this.currentSession = terminalSession;
        this.currentSessionId = sid;
        this.attachedSessions.add(sid);

        // Request ownership/attachment and render live terminal (no history)
        try {
            await terminalSession.attach(false);
        } catch (e) {
            console.warn('[TerminalManager] adoptLocalSession attach failed:', e);
        }

        // Ensure terminal is sized after the dedicated window finishes showing content
        try {
            const refit = () => {
                try { terminalSession.fit?.(); } catch (_) {}
            };
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => setTimeout(refit, 0));
            } else {
                setTimeout(refit, 0);
            }
        } catch (_) { /* ignore */ }

        // Sync toolbar/details and tabs visibility
        try { this.updateSessionInfoToolbar('Terminal', sid, null); } catch (_) {}
        this.updateTextInputState();
        try { this.updateSessionTabs?.(); } catch (_) {}
        try { this.setTabsToolbarVisibility?.(true); } catch (_) {}
        // If a secondary-auth overlay is present (dedicated window without server auth), hide it for local sessions
        try { (getContext()?.app)?.hideSecondaryAuthOverlay?.(); } catch (_) {}

        // Inform desktop main process which session this dedicated window represents (idempotent)
        try {
            const params = new URLSearchParams(window.location.search || '');
            const isDedicated = (params.get('window') === '1') || ((params.get('ui') || '').toLowerCase() === 'window');
            if (isDedicated && window.desktop && window.desktop.isElectron && typeof window.desktop.setWindowSession === 'function') {
                window.desktop.setWindowSession(sid).catch(() => {});
            }
        } catch (_) { /* ignore */ }
    }

    async getUsername() {
        // Prefer backend-reported user; fallback to last-authenticated username
        try {
            const sysUser = appStore.getState('systemInfo')?.current_user;
            if (sysUser && typeof sysUser === 'string' && sysUser.trim()) return sysUser.trim();
        } catch (_) {}
        try {
            const uname = appStore.getState('auth')?.username;
            if (uname && typeof uname === 'string' && uname.trim()) return uname.trim();
        } catch (_) {}
        return '';
    }
    
    async forkSession(sessionId, overrides = {}) {
        try {
            // Guard: fork is not supported for local-only sessions in desktop app
            try {
                const sd = (typeof this.getAnySessionData === 'function')
                    ? this.getAnySessionData(sessionId)
                    : this.sessionList?.getSessionData?.(sessionId);
                if (sd && sd.local_only === true) {
                    try {
                        notificationDisplay.show({
                            title: 'Not Supported',
                            message: 'Fork is not available for local sessions.',
                            notification_type: 'info',
                            session_id: sessionId
                        });
                    } catch (_) {}
                    return;
                }
            } catch (_) { /* ignore */ }
            // Mirror create flow: if template allows auto-attach, set flag BEFORE API call
            try {
                const sd = (typeof this.getAnySessionData === 'function')
                    ? this.getAnySessionData(sessionId)
                    : this.sessionList?.getSessionData?.(sessionId);
                let templateAutoAttach = true; // default to true if unknown
                if (sd && sd.template_name && this.formManager && Array.isArray(this.formManager.availableTemplates)) {
                    const tpl = this.formManager.availableTemplates.find(t => t.name === sd.template_name);
                    if (tpl && tpl.auto_attach === false) templateAutoAttach = false;
                }
                if (templateAutoAttach) {
                    this.expectAutoAttachNext = true;
                }
            } catch (_) { /* non-fatal */ }

            // Request fork via API (no loading notification needed)
            const response = await apiService.forkSession(sessionId, overrides);
            // Treat any valid session response as success
            if (response && (response.session_id || response.sessionId)) {
                // The backend will broadcast session_updated with update_type 'created'.
                // That event triggers handleSessionUpdate which handles auto-select/attach.
                notificationDisplay.show({
                    title: 'Session Forked',
                    message: 'Session has been successfully forked',
                    notification_type: 'success',
                    session_id: response.session_id || response.sessionId,
                    is_active: true
                });
            } else {
                notificationDisplay.show({
                    title: 'Fork Failed',
                    message: 'Unable to fork the session',
                    notification_type: 'error'
                });
            }
        } catch (error) {
            console.error('Error forking session:', error);
            notificationDisplay.show({
                title: 'Fork Error',
                message: error.message || 'Failed to fork session',
                notification_type: 'error'
            });
        }
    }

    async loadSessionHistory(sessionId) {
        try {
            // Indicate loading on the terminal tab while we prepare the history view
            try { (getContext()?.app?.modules?.tabManager)?.setTabLoading?.('terminal', true); } catch (_) {}

            // Get session metadata (prefer sidebar state, fall back to API)
            let sessionData = this.sessionList.getSessionData(sessionId);
            if (!sessionData) {
                try {
                    sessionData = await apiService.getSession(sessionId);
                } catch (_) {
                    sessionData = { session_id: sessionId, is_active: false };
                }
            }

            // Ensure a history session is prepared (includes fetching history + building container)
            const historySession = await this.ensureHistorySession(sessionData);

            // Attach history terminal to the view
            this.viewController.clearTerminalView();
            if (historySession?.container) {
                this.elements.terminalView.appendChild(historySession.container);
                try { historySession.fit?.(); } catch (_) {}
            }

            // Adopt this history view as the current selection and update UI
            this.currentSession = historySession;
            this.currentSessionId = sessionId;
            this.updateSessionUI(sessionId, { updateType: 'terminated' });
            this.updateSessionLinks(sessionData);
            this.updateSessionTransitionsUI();
        } catch (error) {
            console.error('Error loading session history:', error);
            // Suppress 404s that occur within 5s of session start to avoid race-condition noise
            let shouldSuppress = false;
            try {
                if (error && error.status === 404) {
                    const sid = sessionId;
                    let createdAt = null;
                    try {
                        const sd = this.sessionList?.getSessionData?.(sid);
                        createdAt = sd && (sd.created_at || sd.createdAt) ? (sd.created_at || sd.createdAt) : null;
                    } catch (_) {}
                    if (!createdAt) {
                        try {
                            const sd2 = await apiService.getSession(sid).catch(() => null);
                            createdAt = sd2 && (sd2.created_at || sd2.createdAt) ? (sd2.created_at || sd2.createdAt) : null;
                        } catch (_) { /* ignore */ }
                    }
                    if (createdAt) {
                        const t = Date.parse(String(createdAt));
                        if (Number.isFinite(t)) {
                            const ageMs = Date.now() - t;
                            if (ageMs >= 0 && ageMs <= 5000) shouldSuppress = true;
                        }
                    }
                }
            } catch (_) { /* best-effort */ }

            if (shouldSuppress) {
                try { console.info('[TerminalManager] Suppressed early History Load 404 (<5s from start)'); } catch (_) {}
            } else {
                notificationDisplay.show({
                    title: 'History Load Error',
                    message: error?.message || 'Failed to load session history',
                    notification_type: 'error'
                });
            }
        } finally {
            // Clear loading indicator on the terminal tab
            try { (getContext()?.app?.modules?.tabManager)?.setTabLoading?.('terminal', false); } catch (_) {}
        }
    }

    async ensureHistorySession(sessionData) {
        const sessionId = sessionData?.session_id;
        if (!sessionId) throw new Error('Invalid session data for history session creation');

        const existing = this.sessions.get(sessionId);
        if (existing) {
            try { console.log('[TerminalManager] ensureHistorySession reuse', sessionId); } catch (_) {}
            return existing;
        }

        const overlayCtrl = showLoadingOverlay(this.elements.terminalView, 'Fetching session history...');
        try {
            try { console.log('[TerminalManager] ensureHistorySession fetch', sessionId); } catch (_) {}
            // Fetch metadata only (no output); output is streamed separately
            const historyData = await apiService.getSessionHistory(sessionId);

            const historyViewMode = historyData?.history_view_mode === 'html' ? 'html' : 'text';
            const hasHtmlHistory = historyViewMode === 'html' && historyData?.has_html_history === true;
            const historyHtmlFile = (typeof historyData?.history_html_file === 'string' && historyData.history_html_file.trim())
                ? historyData.history_html_file.trim()
                : null;

            const mergedSessionData = {
                ...sessionData,
                created_by: historyData?.created_by ?? sessionData?.created_by,
                visibility: historyData?.visibility ?? sessionData?.visibility,
                // Ensure capture flag is preserved from either API (details) or history payload
                capture_activity_transitions: (historyData?.capture_activity_transitions ?? sessionData?.capture_activity_transitions) === true,
                // Prefer server ordinal input markers when present for immediate dropdown population
                input_markers: Array.isArray(historyData?.input_markers)
                    ? historyData.input_markers
                    : (Array.isArray(sessionData?.input_markers) ? sessionData.input_markers : []),
                // Pass through persisted activity transitions so the history view can render markers
                activity_transitions: Array.isArray(historyData?.activity_transitions)
                    ? historyData.activity_transitions
                    : (Array.isArray(sessionData?.activity_transitions) ? sessionData.activity_transitions : []),
                note: typeof historyData?.note === 'string'
                    ? historyData.note
                    : (typeof sessionData?.note === 'string' ? sessionData.note : ''),
                note_version: Number.isInteger(historyData?.note_version)
                    ? historyData.note_version
                    : (Number.isInteger(sessionData?.note_version) ? sessionData.note_version : 0),
                note_updated_at: historyData?.note_updated_at ?? sessionData?.note_updated_at ?? null,
                note_updated_by: historyData?.note_updated_by ?? sessionData?.note_updated_by ?? null,
                history_view_mode: historyViewMode,
                has_html_history: hasHtmlHistory,
                history_html_file: historyHtmlFile
            };

            if (historyViewMode === 'html') {
                if (hasHtmlHistory) {
                    const container = document.createElement('div');
                    container.className = 'terminal-container history-html-container';
                    container.style.cssText = 'position: relative; height: 100%; width: 100%; overflow: hidden;';

                    const iframe = document.createElement('iframe');
                    iframe.src = config.API_ENDPOINTS.SESSION_HISTORY_HTML(sessionId);
                    iframe.style.cssText = 'width: 100%; height: 100%; border: 0;';
                    // Restrict capabilities for HTML history content; scripts are not expected
                    try { iframe.sandbox = 'allow-same-origin'; } catch (_) {}
                    container.appendChild(iframe);

                    const historySession = {
                        sessionId,
                        session_id: sessionId,
                        container,
                        sessionData: { ...mergedSessionData, is_active: false },
                        isHistoryView: true,
                        is_active: false,
                        // No-op helpers to satisfy generic callers
                        focus() {},
                        fit() {},
                        detach() {},
                        attach() {},
                        refreshInteractive() {},
                        scrollToBottom() {}
                    };

                    try {
                        if (this.sessionList) {
                            const current = this.sessionList.getSessionData?.(sessionId);
                            const payload = { ...mergedSessionData, session_id: sessionId, is_active: false, __stickyTerminated: true };
                            if (current) {
                                this.sessionList.updateSession(payload);
                            } else if (typeof this.sessionList.addSession === 'function') {
                                this.sessionList.addSession(payload, false, false);
                                try { this.sessionList.store.setPath('sessionList.lastUpdate', Date.now()); } catch (_) {}
                            }
                        }
                    } catch (updateError) {
                        console.warn('[TerminalManager] Failed to persist HTML history metadata to session list:', updateError);
                    }

                    this.sessions.set(sessionId, historySession);
                    try { console.log('[TerminalManager] ensureHistorySession ready (HTML)', { sessionId }); } catch (_) {}
                    return historySession;
                }

                const err = new Error('HTML history is enabled for this session, but no HTML content is available. Check the server pty-to-html configuration.');
                err.status = 500;
                throw err;
            }

            const container = document.createElement('div');
            container.className = 'terminal-container history-terminal-container';
            container.style.cssText = 'position: relative; height: 100%;';

            const historySession = new TerminalSession(
                sessionId,
                container,
                null,
                this.eventBus,
                { ...mergedSessionData, is_active: false },
                null
            );

            historySession.isHistoryView = true;
            historySession.originalSessionId = sessionId;
            historySession.sessionData = { ...mergedSessionData, is_active: false };

            try {
                if (this.sessionList) {
                    const current = this.sessionList.getSessionData?.(sessionId);
                    const payload = { ...mergedSessionData, session_id: sessionId, is_active: false, __stickyTerminated: true };
                    if (current) {
                        this.sessionList.updateSession(payload);
                    } else if (typeof this.sessionList.addSession === 'function') {
                        // Add terminated session to the sidebar and mark sticky so it stays visible
                        this.sessionList.addSession(payload, false, false);
                        // Trigger a render to ensure visibility logic accounts for sticky terminated
                        try { this.sessionList.store.setPath('sessionList.lastUpdate', Date.now()); } catch (_) {}
                    }
                }
            } catch (updateError) {
                console.warn('[TerminalManager] Failed to persist history metadata to session list:', updateError);
            }

            // Ensure the TerminalSession sees the transitions for marker placement during initialization
            try { historySession.sessionData = { ...historySession.sessionData, activity_transitions: mergedSessionData.activity_transitions, capture_activity_transitions: mergedSessionData.capture_activity_transitions }; } catch (_) {}

            await historySession.initializeForHistoryStream({
                onProgress: (pct) => {
                    try { overlayCtrl?.setText(`Loading session history... ${pct}%`); } catch (_) {}
                }
            });

            this.sessions.set(sessionId, historySession);
            try { console.log('[TerminalManager] ensureHistorySession ready', { sessionId }); } catch (_) {}
            return historySession;
        } catch (error) {
            console.error('[Manager] ensureHistorySession failed:', error);
            throw error;
        } finally {
            try { overlayCtrl?.remove(); } catch (_) {}
        }
    }

    async selectSession(sessionId, options = {}) {
        // In dedicated windows with a targeted session, defer any non-target selection
        try {
            if (window.__DEFER_SESSION_SELECTION__ === true) {
                const tgt = String(window.__TARGET_SESSION_ID__ || '').trim();
                if (tgt && String(sessionId) !== tgt) {
                    try { console.log('[TerminalManager] Skipping non-target selection during deferred startup', { requested: sessionId, target: tgt }); } catch (_) {}
                    return;
                }
            }
        } catch (_) { /* ignore */ }
        const updateDedicatedWindowMapping = (sid) => {
            try {
                const params = new URLSearchParams(window.location.search || '');
                const isDedicated = (params.get('window') === '1') || ((params.get('ui') || '').toLowerCase() === 'window');
                if (isDedicated && window.desktop && window.desktop.isElectron && typeof window.desktop.setWindowSession === 'function') {
                    if (sid) window.desktop.setWindowSession(sid).catch(() => {});
                }
            } catch (_) { /* ignore */ }
        };
        // If this is a manual selection (click/tap or keyboard), suppress auto-selection overrides briefly
        if (options && options.manualClick) {
            // Navigating breaks the search freeze so normal filtered behavior resumes
            this.searchFreezeActive = false;
            this.suppressAutoSelectionUntil = Date.now() + 2000; // 2s grace period
        }
        // Check if we already have this session created
        const existingSession = this.sessions.get(sessionId);

        // Idempotent fast-path: if already selected and we have a live instance, just refresh UI/tabs
        if (sessionId === this.currentSessionId && existingSession) {
            try { this.updateSessionUI(sessionId, options); } catch (_) {}
            try { this.sessionList?.setActiveSession?.(sessionId); } catch (_) {}
            try { this.sessionTabsManager?.setActiveSession?.(sessionId); } catch (_) {}
            updateDedicatedWindowMapping(sessionId);
            return;
        }
        try {
            const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs);
            if (dbg) {
                console.log('[TerminalManager] selectSession start', {
                    sessionId,
                    manual: !!options?.manualClick,
                    existing: !!existingSession
                });
            }
        } catch (_) {}
        
        if (existingSession) {
            // Session already exists - switch to it
            this.currentSession = existingSession;
            this.currentSessionId = sessionId;
            try {
        {
            const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs);
            if (dbg) console.log('[TerminalManager] selectSession using existing session', {
                sessionId,
                isHistoryView: existingSession.isHistoryView === true
            });
        }
        const listData = this.sessionList.getSessionData(sessionId) || null;
        const tabManager = this.getTabManager();
        if (tabManager && typeof tabManager.switchToSession === 'function') {
            try {
                tabManager.switchToSession(sessionId, listData);
            } catch (e) {
                console.warn('[TerminalManager] Failed to switch tab manager session (existing path):', e);
            }
        }
            } catch (_) {}
            
            // Update UI immediately so header controls/links render before any heavy work
            try { this.updateSessionUI(sessionId, options); } catch (_) {}
            
            const sessionListData = this.sessionList.getSessionData(sessionId);
            // If this is a terminated local-only session, avoid any WS attach paths; show history view instead.
            try {
                if (sessionListData && sessionListData.local_only === true && sessionListData.is_active === false) {
                    await this.loadSessionHistory(sessionId);
                    return;
                }
            } catch (_) { /* ignore */ }
            const isActive = sessionListData ? (sessionListData.is_active !== false) : true;

            if (this.attachedSessions.has(sessionId)) {
                // Session is attached - show the terminal
                this.connectedSessionId = sessionId; // For compatibility
                
                if (existingSession.container) {
                    // Clear view and show the attached terminal container
                    this.viewController.clearTerminalView();
                    this.elements.terminalView.appendChild(existingSession.container);
                    // Perform full reload sequence to fix any display issues
                    requestAnimationFrame(() => {
                        this.reloadTerminalDisplay(existingSession, `session selection (${sessionId})`);
                        // Focus after reload completes (only on non-mobile to prevent keyboard popup)
                        setTimeout(() => {
                            // Do not focus if search input currently has focus
                            const searchFocused = (document.activeElement === this.elements?.searchInput);
                            if (!searchFocused && !existingSession.shouldPreventAutoFocus()) {
                                try { existingSession.focus(); } catch (_) {}
                            }
                        }, 120);
                    });
                } else {
                    console.warn(`[Manager] Attached session ${sessionId} has no container!`);
                }
            } else if (!isActive) {
                // Terminated session with existing terminal - keep content visible in read-only mode
                if (existingSession.container) {
                    this.viewController.clearTerminalView();
                    this.elements.terminalView.appendChild(existingSession.container);
                } else {
                    this.viewController.clearTerminalView();
                    // For local-only desktop sessions, avoid showing the Load History button; render inline history view instead
                    try {
                        const sd = sessionListData || { session_id: sessionId };
                        const inlineLocal = (sd && sd.local_only === true && sd.is_active === false && window.desktop && window.desktop.isElectron);
                        if (inlineLocal) {
                            await this.viewController.showSessionHistory(sd, (a, b) => this.formatDuration(a, b));
                            // Ensure controls reflect terminated state (Close visible) after history view hides controls
                            try { this.updateSessionUI(sessionId, { updateType: 'terminated' }); } catch (_) {}
                        } else {
                            this.viewController.showLoadHistoryButton(sd);
                        }
                    } catch (_) {
                        this.viewController.showLoadHistoryButton(sessionListData || { session_id: sessionId });
                    }
                }
            } else {
                // If user enabled auto-attach on select and session is active, attach immediately
                try {
                    const autoAttach = appStore.getState('preferences.terminal.autoAttachOnSelect') === true;
                    if (autoAttach && isActive) {
                        // Ensure header/links visible before attaching (history fetch)
                        try { this.updateSessionUI(sessionId, options); } catch (_) {}
                        await this.attachToCurrentSession();
                    } else {
                        // Show attach button placeholder for unattached sessions
                        this.viewController.clearTerminalView();
                        this.viewController.showAttachButton(sessionListData || { session_id: sessionId });
                    }
                } catch (e) {
                    console.warn('[Manager] Auto-attach on select failed or disabled, showing attach button instead:', e);
                    this.viewController.clearTerminalView();
                    const sessionListData = this.sessionList.getSessionData(sessionId);
                    this.viewController.showAttachButton(sessionListData || { session_id: sessionId });
                }
            }
            
            // UI already updated above
            
            // Issue #361 Fix: Call setActiveSession and sessionTabsManager.setActiveSession together for existing sessions
            console.log(`[Manager] Calling sessionList.setActiveSession(${sessionId}) for existing session`);
            this.sessionList.setActiveSession(sessionId);
            
        if (this.sessionTabsManager) {
            console.log(`[Manager] Calling sessionTabsManager.setActiveSession(${sessionId}) for existing session`);
            this.sessionTabsManager.setActiveSession(sessionId);
        } else {
            console.warn(`[Manager] sessionTabsManager is not available when trying to set existing session ${sessionId}`);
        }

        if (this.childSessionsByParent.has(sessionId)) {
            this.refreshContainerTabsForParent(sessionId, { attach: true });
        }
        updateDedicatedWindowMapping(sessionId);
        return;
        }
        
        // Hide current session if any (but keep it attached)
        if (this.currentSession) {
            // Remove terminal from view but keep it attached
            if (this.currentSession.container && this.currentSession.container.parentNode) {
                this.currentSession.container.parentNode.removeChild(this.currentSession.container);
            }
        }

        // Clean up history terminal and related resources
        this.viewController.cleanupHistoryTerminal();

        // Clear the terminal view first
        this.viewController.clearTerminalView();
        
        // Show loading message while fetching session details
        this.viewController.showLoadingPlaceholder('Loading session...');

        // Get session data from session list first
        let sessionData = this.sessionList.getSessionData(sessionId);
        
        // Check if this is a terminated session
        const isActiveSession = sessionData && sessionData.is_active !== false;

        // If this is a terminated local-only session, avoid any WS/API paths
        if (sessionData && sessionData.local_only === true && !isActiveSession) {
            try {
                this.viewController.clearTerminalView();
                // Render inline history/readonly view (no button) for local desktop sessions
                await this.viewController.showSessionHistory(sessionData || { session_id: sessionId }, (a, b) => this.formatDuration(a, b));
                const sessionTitle = computeDisplayTitle(sessionData, { fallbackOrder: [], defaultValue: 'Session' });
                this.updateSessionInfoToolbar(sessionTitle, sessionId, sessionData.template_name);
                this.currentSession = null;
                this.currentSessionId = sessionId;
                this.updateSessionUI(sessionId, options);
                this.sessionList.setActiveSession(sessionId);
                if (this.sessionTabsManager) this.sessionTabsManager.setActiveSession(sessionId);
                updateDedicatedWindowMapping(sessionId);
            } catch (e) {
                console.warn('[TerminalManager] Local-only terminated session selection fallback failed:', e);
            }
            return;
        }
        
        if (!isActiveSession && sessionData) {
            try {
                const historySession = await this.ensureHistorySession(sessionData);
                sessionData = historySession?.sessionData || sessionData;
                this.currentSession = historySession;
                this.currentSessionId = sessionId;
                try {
                    console.log('[TerminalManager] selectSession attached history session', {
                        sessionId,
                        hasContainer: !!historySession?.container
                    });
                } catch (_) {}

                const sessionTitle = computeDisplayTitle(sessionData, { fallbackOrder: [], defaultValue: 'Session' });
                this.updateSessionInfoToolbar(sessionTitle, sessionId, sessionData.template_name);
                this.updateSessionUI(sessionId, options);

                this.viewController.clearTerminalView();
                if (historySession?.container) {
                    this.elements.terminalView.appendChild(historySession.container);
                }
                try { historySession?.fit?.(); } catch (_) {}

                this.sessionList.setActiveSession(sessionId);
                if (this.sessionTabsManager) {
                    this.sessionTabsManager.setActiveSession(sessionId);
                }
                this.eventBus.emit('session-changed', {
                    sessionId,
                    sessionData
                });
                this.updateSessionLinks(sessionData);
                this.updateSessionTransitionsUI();
                if (this.childSessionsByParent.has(sessionId)) {
                    this.refreshContainerTabsForParent(sessionId, { attach: true });
                }
                updateDedicatedWindowMapping(sessionId);
            } catch (err) {
                console.warn('[Manager] Failed to prepare terminated session history, falling back to history button:', err);
                this.viewController.clearTerminalView();
                // For local-only sessions on desktop, still avoid showing button; render inline readonly view
                try {
                    const sd = sessionData || { session_id: sessionId };
                    const inlineLocal = (sd && sd.local_only === true && sd.is_active === false && window.desktop && window.desktop.isElectron);
                    if (inlineLocal) {
                        await this.viewController.showSessionHistory(sd, (a, b) => this.formatDuration(a, b));
                        // Ensure controls reflect terminated state (Close visible) after history view hides controls
                        try { this.updateSessionUI(sessionId, { updateType: 'terminated' }); } catch (_) {}
                    } else {
                        this.viewController.showLoadHistoryButton(sd);
                    }
                } catch (_) {
                    this.viewController.showLoadHistoryButton(sessionData);
                }
            }
            return;
        }

        // Check if this is a newly created session that should be auto-attached
        // Check if we're expecting to auto-attach the next created session
        // But never auto-attach if this is a manual click from sidebar (not auto-select)
        const isNewlyCreatedSession = this.expectAutoAttachNext && !options.manualClick;
        
        
        if (isNewlyCreatedSession) {
            // Auto-attach newly created sessions by creating and attaching them
            
            // Create session container
            const sessionContainer = document.createElement('div');
            sessionContainer.className = 'terminal-session-container';
            sessionContainer.style.width = '100%';
            sessionContainer.style.height = '100%';
            
            // Create terminal session
            const session = new TerminalSession(
                sessionId,
                sessionContainer,
                this.wsClient,
                this.eventBus,
                sessionData,
                null // No pre-loaded history for new sessions
            );
            
            // Store the session
            this.sessions.set(sessionId, session);
            this.currentSession = session;
            this.currentSessionId = sessionId;
            
            // Show the session container
            this.viewController.clearTerminalView();
            this.elements.terminalView.appendChild(sessionContainer);
            
            // Initialize session and render header/links before attach
            session.init();
            const sessionTitle = (sessionData?.title && sessionData.title.trim()) ? sessionData.title : (sessionData?.dynamic_title || 'Session');
            this.updateSessionInfoToolbar(sessionTitle, sessionId, sessionData?.template_name);
            this.updateSessionUI(sessionId, options);
            // Attach (history may load); UI is already visible
            await session.attach(false); // Don't force history loading for new sessions
            
            // Add to attached sessions tracking
            this.attachedSessions.add(sessionId);
            this.connectedSessionId = sessionId;
            
            // UI already updated above
            
            this.expectAutoAttachNext = false; // Clear the auto-attach flag
            updateDedicatedWindowMapping(sessionId);
        } else if (this.attachedSessions.has(sessionId)) {
            // Session is already attached (tracked in attachedSessions) but we don't have a local object
            // Create local TerminalSession and re-attach to ensure UI consistency
            this.currentSessionId = sessionId;
            this.currentSession = null;
            // Update UI before attach so controls/links appear immediately
            const stitle = computeDisplayTitle(sessionData, { fallbackOrder: [], defaultValue: 'Session' });
            this.updateSessionInfoToolbar(stitle, sessionId, sessionData?.template_name);
            this.updateSessionUI(sessionId, options);
            await this.attachToCurrentSession();
            updateDedicatedWindowMapping(sessionId);
        } else {
            // Auto-attach on select if enabled and active; otherwise show attach button
            const autoAttach = appStore.getState('preferences.terminal.autoAttachOnSelect') === true;
            const isActive = sessionData ? (sessionData.is_active !== false) : true;
            if (autoAttach && isActive) {
                // Prepare state for attach
                this.currentSessionId = sessionId;
                this.currentSession = null;
                // Render header/links before attaching (history fetch)
                const stitle = computeDisplayTitle(sessionData, { fallbackOrder: [], defaultValue: 'Session' });
                this.updateSessionInfoToolbar(stitle, sessionId, sessionData?.template_name);
                this.updateSessionUI(sessionId);
                await this.attachToCurrentSession();
                updateDedicatedWindowMapping(sessionId);
            } else {
                // Show attach button for existing sessions
                this.viewController.clearTerminalView();
                this.viewController.showAttachButton(sessionData || { session_id: sessionId });
                
                // Update UI state but don't create session yet
                const sessionTitle = computeDisplayTitle(sessionData, { fallbackOrder: [], defaultValue: 'Session' });
                this.updateSessionInfoToolbar(sessionTitle, sessionId, sessionData?.template_name);
                this.currentSessionId = sessionId;
                
                // Issue #361 Fix: Clear currentSession when selecting a different session
                // This ensures attachToCurrentSession creates the correct session object
                this.currentSession = null;
                
                // Update controls
                this.updateSessionUI(sessionId, options);
                
                // Keep currentSessionId set but currentSession null so attach button works
                // The attach process will create the actual session object
                updateDedicatedWindowMapping(sessionId);
            }
        }
        
        // Issue #361 Fix: Consolidate setActiveSession calls to prevent session confusion
        // For active sessions, call setActiveSession and sessionTabsManager.setActiveSession together at the end
        console.log(`[Manager] Calling sessionList.setActiveSession(${sessionId})`);
        this.sessionList.setActiveSession(sessionId);
        
        if (this.sessionTabsManager) {
            console.log(`[Manager] Calling sessionTabsManager.setActiveSession(${sessionId})`);
            this.sessionTabsManager.setActiveSession(sessionId);
        } else {
            console.warn(`[Manager] sessionTabsManager is not available when trying to set session ${sessionId}`);
        }
        
    }
    updateSessionUI(sessionId, options = {}) {
        // Get session data and update UI elements
        const sessionListData = this.sessionList.getSessionData(sessionId);
        let sessionTitle = 'Session';
        let templateName = null;
        if (sessionListData) {
            sessionTitle = computeDisplayTitle(sessionListData, { fallbackOrder: [], defaultValue: 'Session' });
            templateName = sessionListData.template_name;
        }
        
        // Update UI
        this.updateSessionInfoToolbar(sessionTitle, sessionId, templateName);
        this.sessionList.setActiveSession(sessionId);
        
        // Note: Session selection no longer persisted to localStorage to avoid complexity
        
        // Update tab-specific selection tracking
        const sessionActiveStatus = sessionListData ? sessionListData.is_active : true;
        this.updateTabSelection(sessionId, sessionActiveStatus);

        // Persist last selected session per workspace to restore on workspace switch
        // Skip for auto-selections and restored selections to avoid overwriting persisted data
        if (!options.autoSelect && !options.restored) {
            try {
                const wsName = (sessionListData && (sessionListData.workspace || 'Default')) || (this.currentWorkspace || 'Default');
                if (wsName) {
                    this.workspaceSelections.set(wsName, sessionId);
                    // Persist to state store for reload recovery
                    const selectionsObj = Object.fromEntries(this.workspaceSelections);
                    queueStateSet('workspace_session_selections', selectionsObj, 200);
                }
            } catch (e) {
                console.warn('Failed to persist workspace selection:', e);
            }
        }
        
        // Show terminal controls for active sessions  
        const sessionDataForControls = sessionListData;
        
        // Emit session change event for tab manager
        this.eventBus.emit('session-changed', { 
            sessionId: sessionId, 
            sessionData: sessionDataForControls 
        });
        // Ensure header controls are shown for active selection
        try { document.body.classList.add('session-selected'); } catch (_) {}
        this.viewController.showTerminalControls(sessionDataForControls);
        
        // Update session links dropdown immediately and on next tick to avoid race with initial paint
        this.updateSessionLinks(sessionDataForControls);
        this.updateSessionTransitionsUI();
        try {
            setTimeout(() => {
                try {
                    const latest = this.sessionList.getSessionData(sessionId) || sessionDataForControls;
                    this.updateSessionLinks(latest);
                    this.updateSessionTransitionsUI();
                } catch (_) {}
            }, 0);
        } catch (_) {}
        
        // Show the terminal tabs toolbar when a session is active
        this.setTabsToolbarVisibility(true);

        // Refresh deferred input queue and stop inputs for interactive sessions
        if (sessionDataForControls && this.isSessionInteractive(sessionDataForControls)) {
            try { this.refreshDeferredInputsForSession(sessionId).catch(() => {}); } catch (_) {}
            try { this.refreshStopPromptsForSession(sessionId).catch(() => {}); } catch (_) {}
        } else {
            try {
                this.deferredInputQueues.delete(sessionId);
                this.stopInputsState.delete(sessionId);
                const activeId = (typeof this.getActiveEffectiveSessionId === 'function')
                    ? this.getActiveEffectiveSessionId()
                    : this.currentSessionId;
                if (activeId && activeId === sessionId) {
                    this.updatePromptsDropdownBadge(sessionId);
                }
                this.updateStopInputsIconHighlightForSession(sessionId);
            } catch (_) {}
        }

        // Update session tabs to reflect the active session
        if (this.sessionTabsManager) {
            console.log(`[Manager] Calling sessionTabsManager.setActiveSession(${sessionId})`);
            this.sessionTabsManager.setActiveSession(sessionId);
        } else {
            console.warn(`[Manager] sessionTabsManager is not available when trying to set session ${sessionId}`);
        }
    }

    /**
     * Reload terminal display to fix any rendering issues
     * This performs multiple fit operations and forces a DOM reflow
     * @param {TerminalSession} session - The terminal session to reload
     * @param {string} triggerSource - Description of what triggered the reload (for logging)
     */
    reloadTerminalDisplay(session, triggerSource = 'unknown') {
        if (!session) {
            return;
        }
        
        // First try a normal fit
        session.fit();
        
        // Then trigger a resize event similar to window resize
        setTimeout(() => {
            session.fit();
            
            // If the terminal element exists, try forcing a reflow
            const terminalElement = session.terminal?.element;
            if (terminalElement) {
                // Force a reflow by temporarily modifying the element
                const originalDisplay = terminalElement.style.display;
                terminalElement.style.display = 'none';
                terminalElement.offsetHeight; // Force reflow
                terminalElement.style.display = originalDisplay;
                
                // Fit again after reflow
                setTimeout(() => {
                    session.fit();
                }, 10);
            }
        }, 100);
    }

    /**
     * Refresh the currently active terminal view by performing a detach + reattach.
     * - For active remote sessions: detach and reattach with forceLoadHistory=true
     *   to refetch history and re-sync the stream.
     * - For terminated sessions: refetch and re-render the history view.
     * - For local-only sessions: perform a lightweight reattach without history.
     */
    async refreshActiveTerminal() {
        const sid = this.currentSessionId;
        if (!sid) {
            console.log('[TerminalManager] refreshActiveTerminal: no current session');
            return;
        }

        // Toggle loading state on the terminal tab
        try { (getContext()?.app?.modules?.tabManager)?.setTabLoading?.('terminal', true); } catch (_) {}

        try {
            // Resolve latest session metadata
            let sd = null;
            try { sd = this.sessionList?.getSessionData?.(sid) || null; } catch (_) { sd = null; }

            // Terminated sessions: dispose existing history view and refetch
            if (sd && sd.is_active === false) {
                const existing = this.sessions.get(sid);
                if (existing) {
                    try { existing.dispose?.(); } catch (_) {}
                    this.sessions.delete(sid);
                }
                await this.loadSessionHistory(sid);
                return;
            }

            // Local-only sessions: detach/reattach via LocalPTY (no history)
            const canUseLocalPTY = !!(window.desktop && window.desktop.isElectron && window.desktop.localpty);
            const isLocalOnly = !!(sd && sd.local_only === true);
            if (isLocalOnly && canUseLocalPTY) {
                try {
                    if (!this.currentSession) {
                        await this.attachToCurrentSession();
                        return;
                    }
                    // Detach without disposing resources, then reattach without history
                    try { this.currentSession.detach(false); } catch (_) {}
                    await this.currentSession.attach(false);
                    this.attachedSessions?.add?.(sid);
                    // Ensure the terminal is visible and sized
                    this.viewController.clearTerminalView();
                    if (this.currentSession.container) {
                        this.elements.terminalView.appendChild(this.currentSession.container);
                        try { this.currentSession.fit?.(); } catch (_) {}
                    }
                } catch (e) {
                    console.warn('[TerminalManager] Local-only refresh failed, falling back to visual reload:', e);
                    if (this.currentSession) this.reloadTerminalDisplay(this.currentSession, 'local refresh fallback');
                }
                return;
            }

            // Active remote session
            if (!this.currentSession) {
                // If not yet attached, attach now (will load history on attach)
                await this.attachToCurrentSession();
                return;
            }

            const existing = this.currentSession;
            const oldContainer = existing?.container || null;
            try { console.log('[TerminalManager] Refresh: existing session/container found?', { hasSession: !!existing, hasContainer: !!oldContainer }); } catch (_) {}

            // Remove old container from DOM before disposing to avoid stale viewport hooks
            try {
                if (oldContainer && oldContainer.parentElement) {
                    console.log('[TerminalManager] Refresh: removing old container from DOM');
                    oldContainer.parentElement.removeChild(oldContainer);
                }
            } catch (_) {}

            // Fully dispose the existing terminal instance and remove from tracking
            try {
                console.log('[TerminalManager] Refresh: disposing existing TerminalSession');
                existing?.dispose?.();
            } catch (e) {
                console.warn('[TerminalManager] Refresh: dispose threw', e);
            }
            this.sessions.delete(sid);
            this.attachedSessions?.delete?.(sid);
            this.currentSession = null;

            // Clear the terminal view before reattaching
            this.viewController.clearTerminalView();

            // Reuse attachToCurrentSession to build a fresh session (same as page load)
            try { this._lastParentAttachAt.set(sid, Date.now()); } catch (_) {}
            await this.attachToCurrentSession();
            try { this._lastParentAttachAt.set(sid, Date.now()); } catch (_) {}

        } finally {
            // Clear loading state
            try { (getContext()?.app?.modules?.tabManager)?.setTabLoading?.('terminal', false); } catch (_) {}
        }
    }

    /**
     * Ensure terminal is properly sized and focused.
     * Applies an immediate refit, a deferred refit, and then focuses on next frame.
     * Includes a light throttle to avoid redundant immediate refits within minIntervalMs.
     */
    ensureFitAndFocus(session, triggerSource = 'unknown', options = {}) {
        try {
            const sid = session && session.sessionId ? String(session.sessionId) : null;
            const deferMs = typeof options.deferMs === 'number' ? options.deferMs : 120;
            const minIntervalMs = typeof options.minIntervalMs === 'number' ? options.minIntervalMs : 200;

            const now = Date.now();
            const last = sid ? (this._lastFitFocusAt.get(sid) || 0) : 0;
            const withinWindow = (now - last) < minIntervalMs;

            if (!withinWindow) {
                this.reloadTerminalDisplay(session, triggerSource);
            }
            setTimeout(() => {
                try { this.reloadTerminalDisplay(session, `${triggerSource} (deferred)`); } catch (_) {}
            }, deferMs);

            try {
                requestAnimationFrame(() => {
                    try {
                        // Avoid stealing focus when a modal is visible (e.g., New Session modal during auto-attach/history load)
                        if (typeof session?.shouldPreventAutoFocus === 'function' && session.shouldPreventAutoFocus()) {
                            return;
                        }
                        session.focus?.();
                    } catch (_) {}
                });
            } catch (_) {}

            if (sid) this._lastFitFocusAt.set(sid, now);
        } catch (e) {
            // non-fatal
        }
    }

    formatDuration(startTime, endTime) {
        if (!endTime) return 'Still running';
        const duration = Math.floor(endTime - startTime);
        const hours = Math.floor(duration / 3600);
        const minutes = Math.floor((duration % 3600) / 60);
        const seconds = duration % 60;
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    async detachSession(sessionId) {
        try {
            // Find session to check if it's attached
            const session = this.sessions.get(sessionId);
            if (!session || !this.attachedSessions.has(sessionId)) {
                return;
            }

            // Detach the session
            session.detach();
            
            // Remove from attached sessions tracking
            this.attachedSessions.delete(sessionId);
            
            // Suppress future auto-attach for this session until user explicitly attaches
            try { this._suppressedChildAttach.add(sessionId); } catch (_) {}

            // If this is the currently active container tab, show attach prompt in-place
            try {
                if (this.activeChildSessionId === sessionId) {
                    this.showContainerAttachPrompt(sessionId);
                }
            } catch (_) {}

            // Keep session in sessions map so it can be reattached later
            // this.sessions.delete(sessionId); // Don't delete - preserve for reattach
            
            // Update compatibility tracking
            if (this.connectedSessionId === sessionId) {
                this.connectedSessionId = this.attachedSessions.size > 0 ? 
                    Array.from(this.attachedSessions)[0] : null;
            }
            
            // Issue #354 Fix: When detaching current session, preserve session data and show attach button
            // This ensures that after detaching, users see the attach button instead of "Select a session"
            if (this.currentSessionId === sessionId) {
                // Keep currentSession and currentSessionId so attach button works properly
                this.viewController.clearTerminalView();
                
                // Show attach button in terminal view so it appears in terminal tab
                const sessionListData = this.sessionList.getSessionData(sessionId);
                this.viewController.showAttachButton(sessionListData || { session_id: sessionId });
            }

            // Issue #356 Fix: Update attach/detach button state after detaching
            if (this.currentSessionId === sessionId) {
                const sessionListData = this.sessionList.getSessionData(sessionId);
                this.viewController.updateAttachDetachButton(sessionListData || { session_id: sessionId });
            }

            this.updateTextInputState();

        } catch (error) {
            console.error(`[Manager] Error detaching session ${sessionId}:`, error);
        }
    }

    /**
     * Handle a forced/remote detach initiated by the server or another client.
     * This updates local UI and state without sending a detach message back.
     * @param {string} sessionId
     */
    handleRemoteDetach(sessionId) {
        try {
            // Ignore stale 'detached' events that arrive right after a successful attach
            try {
                const now = Date.now();
                const childT = this._lastChildAttachAt?.get?.(sessionId) || 0;
                const parentT = this._lastParentAttachAt?.get?.(sessionId) || 0;
                const lastT = Math.max(childT, parentT);
                if (lastT && (now - lastT) < 1500) {
                    this._debug?.log?.('handleRemoteDetach: ignoring stale detached event', { sessionId, msSinceAttach: now - lastT });
                    return;
                }
            } catch (_) {}
            const session = this.sessions.get(sessionId);
            // Update local session attachment state without sending WS message
            if (session) {
                session.isAttached = false;
            }

            // Remove from attached sessions tracking if present
            if (this.attachedSessions && this.attachedSessions.has(sessionId)) {
                this.attachedSessions.delete(sessionId);
            }

            // Suppress auto-reattach until user explicitly attaches
            try { this._suppressedChildAttach.add(sessionId); } catch (_) {}

            // If this is the currently active container tab, show attach prompt in-place
            try {
                if (this.activeChildSessionId === sessionId) {
                    this.showContainerAttachPrompt(sessionId);
                }
            } catch (_) {}

            // Update compatibility tracking
            if (this.connectedSessionId === sessionId) {
                this.connectedSessionId = this.attachedSessions.size > 0 ?
                    Array.from(this.attachedSessions)[0] : null;
            }

            // If this was the currently viewed session, update the view to show the attach button
            if (this.currentSessionId === sessionId) {
                this.viewController.clearTerminalView();
                const sessionListData = this.sessionList.getSessionData(sessionId);
                this.viewController.showAttachButton(sessionListData || { session_id: sessionId });
                this.viewController.updateAttachDetachButton(sessionListData || { session_id: sessionId });
            }

            this.updateTextInputState();
        } catch (error) {
            console.error(`[Manager] Error handling remote detach for ${sessionId}:`, error);
        }
    }

    async attachToCurrentSession() {
        if (!this.currentSessionId) {
            console.error('[Manager] No current session ID to attach to');
            return;
        }

        try {
            // Safeguard: if a dedicated window exists for this session, do not attach in main window
            try {
                if (!this.isDedicatedWindow && window.desktop && window.desktop.isElectron && typeof window.desktop.getSessionWindow === 'function') {
                    const info = await window.desktop.getSessionWindow(this.currentSessionId);
                    if (info && info.ok && info.windowId) {
                        try { await window.desktop.focusSessionWindow(this.currentSessionId); } catch (_) {}
                        return false;
                    }
                }
            } catch (_) { /* ignore */ }
            // Prefer local PTY transport for local-only sessions to avoid WS/API attach
            let sessionDataForAttach = null;
            try { sessionDataForAttach = this.sessionList?.getSessionData?.(this.currentSessionId) || null; } catch (_) { sessionDataForAttach = null; }
            const isLocalOnlySession = !!(sessionDataForAttach && sessionDataForAttach.local_only === true);
            const canUseLocalPTY = !!(window.desktop && window.desktop.isElectron && window.desktop.localpty);
            if (isLocalOnlySession && canUseLocalPTY) {
                // If we don't have a session object yet, create one with LocalPTY transport
                if (!this.currentSession) {
                    const sessionContainer = document.createElement('div');
                    sessionContainer.className = 'terminal-session-container';
                    sessionContainer.style.width = '100%';
                    sessionContainer.style.height = '100%';

                    const transport = new LocalPTYClient(this.eventBus);
                    const localSession = new TerminalSession(
                        this.currentSessionId,
                        sessionContainer,
                        transport,
                        this.eventBus,
                        { ...sessionDataForAttach, local_only: true, load_history: false },
                        null
                    );

                    this.sessions.set(this.currentSessionId, localSession);
                    this.currentSession = localSession;

                    // Show the container before attach so overlays render correctly
                    this.viewController.clearTerminalView();
                    this.elements.terminalView.appendChild(sessionContainer);
                    localSession.init();
                } else {
                    // Ensure the existing container is visible
                    try {
                        if (this.currentSession && this.currentSession.container) {
                            this.viewController.clearTerminalView();
                            this.elements.terminalView.appendChild(this.currentSession.container);
                        }
                    } catch (_) {}
                }

                // Attach via LocalPTY (no history)
                try { this._lastParentAttachAt.set(this.currentSessionId, Date.now()); } catch (_) {}
                await this.currentSession.attach(false);
                try { this._lastParentAttachAt.set(this.currentSessionId, Date.now()); } catch (_) {}

                // Track attachment
                this.attachedSessions.add(this.currentSessionId);
                this.connectedSessionId = this.currentSessionId;

                // Ensure proper sizing after attach
                try { this.currentSession.fit?.(); } catch (_) {}

                // Clear any attach placeholder and keep the terminal visible
                this.viewController.clearTerminalView();
                if (this.currentSession.container) {
                    this.elements.terminalView.appendChild(this.currentSession.container);
                }

                this.updateSessionTabs?.();
                return true;
            }

            // If we don't have a session object yet, create it first
            if (!this.currentSession) {
                console.log(`[Manager] Creating session object for attach: ${this.currentSessionId}`);
                
                // Get session data
                const sessionData = this.sessionList.getSessionData(this.currentSessionId);
                
                // Create session container
                const sessionContainer = document.createElement('div');
                sessionContainer.className = 'terminal-session-container';
                sessionContainer.style.width = '100%';
                sessionContainer.style.height = '100%';
                
                // Create terminal session
                const session = new TerminalSession(
                    this.currentSessionId,
                    sessionContainer,
                    this.wsClient,
                    this.eventBus,
                    sessionData,
                    null // No pre-loaded history, will load during attach
                );
                
                // Store the session
                this.sessions.set(this.currentSessionId, session);
                this.currentSession = session;
                
                // Show the session container
                this.viewController.clearTerminalView();
                this.elements.terminalView.appendChild(sessionContainer);
                
                // Initialize the session
                session.init();
            }
            // Ensure the session container is visible BEFORE attaching so overlays render in-place
            try {
                if (this.currentSession && this.currentSession.container) {
                    this.viewController.clearTerminalView();
                    this.elements.terminalView.appendChild(this.currentSession.container);
                }
            } catch (_) {}
            
            // Attach the session with forceLoadHistory=true for manual attach
            try { this._lastParentAttachAt.set(this.currentSessionId, Date.now()); } catch (_) {}
            await this.currentSession.attach(true);
            try { this._lastParentAttachAt.set(this.currentSessionId, Date.now()); } catch (_) {}
            
            // Add to attached sessions tracking
            this.attachedSessions.add(this.currentSessionId);
            
            // Update compatibility tracking
            this.connectedSessionId = this.currentSessionId;
            
            // Clear the attach button and ensure the terminal is properly displayed
            this.viewController.clearTerminalView();
            if (this.currentSession.container) {
                this.elements.terminalView.appendChild(this.currentSession.container);
                
                // Ensure proper sizing and rendering
                requestAnimationFrame(() => {
                    // Capture current session reference to avoid race conditions
                    const sessionRef = this.currentSession;
                    try {
                        if (sessionRef && typeof sessionRef.fit === 'function') {
                            sessionRef.fit();
                        }
                    } catch (e) {
                        console.warn('[Manager] fit() after attach failed:', e);
                    }
                    // Focus the terminal after attachment (only on non-mobile to prevent keyboard popup)
                    setTimeout(() => {
                        try {
                            // Do not focus if search input currently has focus
                            const searchFocused = (document.activeElement === this.elements?.searchInput);
                            const current = this.currentSession;
                            // Only focus if the same session is still active
                            if (!searchFocused && current && current === sessionRef && !current.shouldPreventAutoFocus?.()) {
                                console.log('[Manager] Focusing terminal after manual attach');
                                current.focus?.();
                            } else {
                                console.log('[Manager] Skipping focus after manual attach (search focused, session changed, or mobile)');
                            }
                        } catch (_) { /* ignore */ }
                    }, 120);
                });
            }

            // Issue #356 Fix: Update attach/detach button state after attaching  
            const sessionListData = this.sessionList.getSessionData(this.currentSessionId);
            this.viewController.updateAttachDetachButton(sessionListData || { session_id: this.currentSessionId });
            this.updateTextInputState();
            
        } catch (error) {
            console.error(`[Manager] Error attaching to current session:`, error);
        }
    }

    async closeSession(sessionId) {
        this.showTerminateModal(sessionId);
    }

    closeEndedSession(sessionId) {
        if (!sessionId) return;
        const sessionData = this.sessionList?.getSessionData(sessionId);
        if (!sessionData || sessionData.is_active !== false) {
            return;
        }
        this.doDeleteSessionHistory(sessionId);
    }

    async doTerminateSession(sessionId) {
        try {
            // Prefer desktop local PTY termination for local-only sessions in Electron
            const sd = (typeof this.getAnySessionData === 'function')
                ? this.getAnySessionData(sessionId)
                : this.sessionList?.getSessionData?.(sessionId);
            const isLocalOnly = !!(sd && sd.local_only === true);
            const hasLocalPTY = !!(window.desktop && window.desktop.isElectron && window.desktop.localpty);

            if (isLocalOnly && hasLocalPTY) {
                try {
                    await Promise.resolve(window.desktop.localpty.terminate?.({ sessionId }));
                } catch (_) { /* non-fatal */ }

                // Optimistically mark ended in the store so UI reflects Ended state
                try { this.sessionList?.markSessionAsTerminated?.(sessionId); } catch (_) {}

                // If this is the current session, surface the terminated state in the view
                if (this.currentSessionId === sessionId) {
                    try { this.showSessionTerminatedMessage({ session_id: sessionId }); } catch (_) {}
                }
                return;
            }

            // Fallback to API termination for non-local sessions
            await apiService.terminateSession(sessionId);
            // For remote sessions, UI updates are handled via WebSocket events
        } catch (error) {
            errorHandler.handle(error, { context: 'terminate_session', sessionId });
        }
    }

    /**
     * Issue #633: Fully remove a session from the UI via keyboard shortcut.
     * Performs the equivalent of pressing the detach/terminate/close shortcut repeatedly:
     *  - If attached, detaches the session
     *  - Terminates the session without confirmation
     *  - Closes the terminated session once the termination completes
     *
     * This method schedules brief retries to close the session after termination is processed.
     *
     * @param {string} sessionId
     */
    removeSessionCompletely(sessionId) {
        if (!sessionId) return false;

        const getData = () => {
            try {
                if (typeof this.getAnySessionData === 'function') {
                    return this.getAnySessionData(sessionId);
                }
                return this.sessionList?.getSessionData?.(sessionId);
            } catch (_) {
                return null;
            }
        };

        const data = getData();
        if (!data) return false;

        const isActive = data.is_active !== false;
        const isAttached = this.attachedSessions?.has(sessionId) === true;

        try {
            if (isAttached) {
                this.detachSession(sessionId);
            }
        } catch (_) {
            // Non-fatal; continue with termination
        }

        try {
            if (isActive) {
                this.doTerminateSession(sessionId);
            }
        } catch (_) {}

        // Immediate attempt to remove from sidebar if already ended (preserve history)
        try { this._removeEndedSessionFromSidebar(sessionId); } catch (_) {}

        // Retry closing for a short period until termination is reflected in state
        const start = Date.now();
        const timeoutMs = 5000;
        const intervalMs = 150;
        const timer = setInterval(() => {
            try {
                const d = getData();
                // If session data is gone, consider it removed
                if (!d) {
                    clearInterval(timer);
                    return;
                }
                if (d.is_active === false) {
                    // Remove from sidebar without deleting history on the server
                    this._removeEndedSessionFromSidebar(sessionId);
                    clearInterval(timer);
                    return;
                }
            } catch (_) {
                clearInterval(timer);
                return;
            }
            if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
            }
        }, intervalMs);

        return true;
    }

    /**
     * Remove a terminated session from the sidebar and UI without deleting server-side history.
     * Mirrors doDeleteSessionHistory cleanup minus the DELETE API call.
     */
    _removeEndedSessionFromSidebar(sessionId) {
        try {
            if (!sessionId) return false;

            const sessionData = this.sessionList?.getSessionData(sessionId);
            if (!sessionData) return false;
            if (sessionData.is_active !== false) return false;

            // If this was the currently viewed session, compute next selection target
            let nextSessionToSelect = null;
            if (this.currentSessionId === sessionId) {
                const sessionItems = Array.from(this.elements.sessionList.querySelectorAll('.session-item'));
                const visibleSessions = sessionItems
                    .filter(item => item.style.display !== 'none')
                    .map(item => item.dataset.sessionId);
                if (visibleSessions.length > 1) {
                    const currentIndex = visibleSessions.indexOf(sessionId);
                    if (currentIndex !== -1) {
                        // Prefer the next item (below in the list)
                        if (currentIndex < visibleSessions.length - 1) {
                            nextSessionToSelect = visibleSessions[currentIndex + 1];
                        }
                        // If the removed session was last, fall back to the one above
                        else if (currentIndex > 0) {
                            nextSessionToSelect = visibleSessions[currentIndex - 1];
                        }
                    }
                }
            }

            // Remove from UI list
            this.sessionList.removeSession(sessionId);

            // Clean up attached session instance
            if (this.attachedSessions && this.attachedSessions.has(sessionId)) {
                const sess = this.sessions?.get?.(sessionId);
                if (sess) {
                    try { sess.dispose?.(); } catch (_) {}
                    try { this.sessions.delete(sessionId); } catch (_) {}
                }
                this.attachedSessions.delete(sessionId);
                if (this.connectedSessionId === sessionId) {
                    this.connectedSessionId = this.attachedSessions.size > 0
                        ? Array.from(this.attachedSessions)[0]
                        : null;
                }
            }

            if (this.currentSessionId === sessionId) {
                if (nextSessionToSelect) {
                    this.selectSession(nextSessionToSelect);
                } else {
                    // Use centralized cleanup to ensure TabManager hides the lower tabs bar
                    // and emits the appropriate events (tab-clear-session), preventing stray tabs.
                    this.clearTerminalView();
                }
            }
            this.updateSessionTabs?.();
            return true;
        } catch (_) {
            return false;
        }
    }

    async doDeleteSessionHistory(sessionId) {
        try {
            // If this was the currently viewed session, find the next one to select
            let nextSessionToSelect = null;
            if (this.currentSessionId === sessionId) {
                // Get all visible session items in their visual order
                const sessionItems = Array.from(this.elements.sessionList.querySelectorAll('.session-item'));
                const visibleSessions = sessionItems
                    .filter(item => item.style.display !== 'none')
                    .map(item => item.dataset.sessionId);
                
                if (visibleSessions.length > 1) {
                    // Find the index of the current session
                    const currentIndex = visibleSessions.indexOf(sessionId);
                    
                    if (currentIndex !== -1) {
                        // Try to select the next session below
                        if (currentIndex < visibleSessions.length - 1) {
                            nextSessionToSelect = visibleSessions[currentIndex + 1];
                        } 
                        // If no session below, select the one above
                        else if (currentIndex > 0) {
                            nextSessionToSelect = visibleSessions[currentIndex - 1];
                        }
                    }
                }
            }
            
            await apiService.clearSessionHistory(sessionId);
            // Remove session from UI
            this.sessionList.removeSession(sessionId);
            
            // If this session was attached, clean it up
            if (this.attachedSessions.has(sessionId)) {
                const session = this.sessions.get(sessionId);
                if (session) {
                    session.dispose(); // Completely dispose the session
                    this.sessions.delete(sessionId);
                }
                this.attachedSessions.delete(sessionId);
                
                // Update compatibility tracking
                if (this.connectedSessionId === sessionId) {
                    this.connectedSessionId = this.attachedSessions.size > 0 ? 
                        Array.from(this.attachedSessions)[0] : null;
                }
            }
            
            // If this was the currently viewed session, handle the selection
            if (this.currentSessionId === sessionId) {
                if (nextSessionToSelect) {
                    // Select the next available session
                    this.selectSession(nextSessionToSelect);
                } else {
                    // No sessions left, fully clear the view and tabs via the centralized path
                    // This also emits 'tab-clear-session' so TabManager hides the lower tabs bar.
                    this.clearTerminalView();
                }
            }
            this.updateSessionTabs();
        } catch (error) {
            console.error('Error deleting session history:', error);
            errorHandler.handle(error, { context: 'delete_session_history' });
        }
    }

    /**
     * Remove all terminated sessions from the sidebar/UI without deleting server history.
     * Returns the number of sessions removed.
     */
    removeAllEndedSessionsFromUI() {
        try {
            const getAll = this.sessionList && typeof this.sessionList.getAllSessions === 'function'
                ? this.sessionList.getAllSessions.bind(this.sessionList)
                : null;
            if (!getAll) return 0;

            const sessionsMap = getAll();
            if (!sessionsMap || typeof sessionsMap.forEach !== 'function') return 0;

            const toRemove = [];
            sessionsMap.forEach((data, sessionId) => {
                try {
                    if (data && data.is_active === false) toRemove.push(sessionId);
                } catch (_) { /* ignore */ }
            });

            let removed = 0;
            toRemove.forEach((sid) => {
                try {
                    if (this._removeEndedSessionFromSidebar(sid)) removed++;
                } catch (_) { /* ignore */ }
            });

            try { this.updateSessionTabs?.(); } catch (_) {}
            return removed;
        } catch (_) {
            return 0;
        }
    }

    // Note: handleWebSocketMessage and handleWebSocketMessageLegacy methods removed
    // WebSocket message handling is now done entirely through the registry system
    // in the WebSocket service with handlers registered in setupWebSocketHandlers()

    // 'session_resumed' legacy handler removed; creation handled via handleSessionUpdate('created')
    
    /**
     * Handle consolidated session updates from WebSocket
     * @param {Object} sessionData - Session data from server
     * @param {string} updateType - Type of update: "created", "updated", "terminated"
     */
    async handleSessionUpdate(sessionData, updateType) {
        if (sessionData && sessionData.parent_session_id) {
            const parentId = sessionData.parent_session_id;
            if (updateType === 'terminated') {
                this.unregisterChildSession(sessionData.session_id);
            } else {
                // Register or refresh the child session in internal maps
                this.registerChildSession(sessionData);
                // Immediately refresh child sub-entries under the parent in both sidebar and workspace views
                try { this.sessionList?.renderChildrenForParent?.(parentId); } catch (_) {}
                try { this.workspaceListComponent?.refreshChildrenForParent?.(parentId); } catch (_) {}
                if (this.activeChildSessionId === sessionData.session_id) {
                    // Respect auto-attach preference and suppression after explicit detaches
                    let autoAttach = false;
                    try { autoAttach = appStore.getState('preferences.terminal.autoAttachOnSelect') === true; } catch (_) {}
                    const suppressed = this._suppressedChildAttach?.has?.(sessionData.session_id) === true;
                    if (autoAttach && !suppressed) {
                        await this.attachChildSession(sessionData.session_id, { markActive: true });
                    } else {
                        this._debug?.log?.('handleSessionUpdate skip child attach (autoAttach off or suppressed)', {
                            childId: sessionData.session_id, autoAttach, suppressed
                        });
                    }
                }
            }
            return;
        }

        switch (updateType) {
            case 'created':
                // New terminal session was created - add to the list
                this.sessionList.addSession(sessionData, true);
                
                // Re-sort to ensure pinned sessions stay at the top
                this.sortSessionList();

                // Initialize activity indicator state from payload for fast-start sessions
                // This covers the race where output begins before we attach and miss the
                // initial 'active' transition over WebSocket.
                try {
                    const live = sessionData.is_active !== false;
                    let activeBool = null;
                    if (typeof sessionData.output_active === 'boolean') {
                        activeBool = !!sessionData.output_active;
                    } else if (typeof sessionData.activity_state === 'string') {
                        const s = sessionData.activity_state.toLowerCase();
                        activeBool = s === 'active' ? true : (s === 'inactive' ? false : null);
                    }
                    if (activeBool !== null) {
                        this.setSessionActivityState(sessionData.session_id, !!(activeBool && live));
                    }
                } catch (_) { /* non-fatal */ }
                
                // Check if template allows auto-attach
                let templateAutoAttach = true; // Default to true for backward compatibility
                if (sessionData.template_name) {
                    const template = this.formManager.availableTemplates.find(t => t.name === sessionData.template_name);
                    if (template && template.auto_attach === false) {
                        templateAutoAttach = false;
                    }
                }
                
                // Get current authenticated username
                const currentUser = appStore.getState()?.preferences?.auth?.username || 'default';
                
                // Auto-select session if template allows it and:
                // 1. This user created the session and we expect to auto-attach
                // 2. This user created the session (existing behavior)  
                // 3. No session is currently open and we're on the active tab
                const hasOriginClient = !!sessionData.origin_client_id;
                const initiatedByThisClient = hasOriginClient && sessionData.origin_client_id === this.clientId;
                const initiatedByOtherClient = hasOriginClient && sessionData.origin_client_id !== this.clientId;

                let shouldAutoSelect = false;
                if (initiatedByOtherClient) {
                    // Another client launched it; don't auto-select here
                    shouldAutoSelect = false;
                } else {
                    // Only auto-select when launched by this client or owned by this user
                    // Avoid pulling focus to sessions created by other users in real time
                    shouldAutoSelect = templateAutoAttach && (
                        initiatedByThisClient ||
                        this.expectAutoAttachNext ||
                        sessionData.created_by === currentUser
                    );
                }
                
                // If a server-side content search overlay is active, do not auto-select
                try {
                    const q = (this.searchQuery || '').trim();
                    if (q.length > 0) {
                        shouldAutoSelect = false;
                    }
                } catch (_) {}

                // If local filters (template/pinned/workspace/status) exclude this session, do not auto-select
                try {
                    const st = this.sessionList?.store?.getState()?.sessionList || {};
                    const filters = st.filters || {};
                    // Ignore text search in local matching; server overlay dictates content search
                    const effective = { ...filters, search: '' };
                    const matches = Array.isArray(SessionFilterService.filter([sessionData], effective))
                        ? SessionFilterService.filter([sessionData], effective).length > 0
                        : true;
                    if (!matches) {
                        shouldAutoSelect = false;
                    }
                } catch (_) {}
                
                if (shouldAutoSelect) {
                    // Ensure workspace context matches the created session
                    const ws = sessionData.workspace || 'Default';
                    if (this.currentWorkspace !== ws) {
                        this.currentWorkspace = ws;
                        if (this.sessionList && this.sessionList.store) {
                            this.sessionList.store.setPath('sessionList.filters.workspace', ws);
                            this.sessionList.setFilter('active');
                        }
                        if (this.workspaceListComponent) {
                            this.workspaceListComponent.setCurrent(ws);
                        }
                        this.updateWorkspaceHeader();
                        this.sessionList.render();
                        this.updateSessionTabs();
                    }
                    // If we're on the inactive tab, switch to active tab first
                    // since new sessions are always active
                    const currentTab = this.getCurrentActiveTab();
                    if (currentTab === 'inactive') {
                        const activeTab = document.querySelector('.filter-tab[data-filter="active"]');
                        if (activeTab) {
                            activeTab.click();
                        }
                    }
                    
                    this.selectSession(sessionData.session_id);
                    
                    // Clear the auto-attach flag after processing
                    if (this.expectAutoAttachNext) {
                        this.expectAutoAttachNext = false;
                    }
                }
                // Update workspace list after creation
                this.updateWorkspacesFromSessions();

                // If a search overlay is active (query present), re-run server search to include new matches
                try {
                    const q = (this.searchQuery || '').trim();
                    if (q.length > 0) {
                        if (this.searchRefreshTimer) clearTimeout(this.searchRefreshTimer);
                        this.searchRefreshTimer = setTimeout(() => {
                            try { this.performSearch(false); } catch (_) {}
                        }, 300);
                    }
                } catch (_) {}
                break;
                
            case 'updated':
                // Session was updated (title change, client count change, workspace change, etc.)
                // Check if session exists in our list
                const existingSessionData = this.sessionList.getSessionData(sessionData.session_id);
                if (existingSessionData) {
                    // Keep activity indicator in sync if server includes current state in update
                    try {
                        const live = (Object.prototype.hasOwnProperty.call(sessionData, 'is_active')
                            ? (sessionData.is_active !== false)
                            : (existingSessionData.is_active !== false));
                        if (typeof sessionData.output_active === 'boolean') {
                            this.setSessionActivityState(sessionData.session_id, !!(sessionData.output_active && live));
                        } else if (typeof sessionData.activity_state === 'string') {
                            const s = sessionData.activity_state.toLowerCase();
                            if (s === 'active' || s === 'inactive') {
                                this.setSessionActivityState(sessionData.session_id, !!(s === 'active' && live));
                            }
                        }
                    } catch (_) { /* ignore */ }
                    const notePropsProvided = Object.prototype.hasOwnProperty.call(sessionData, 'note') ||
                        Object.prototype.hasOwnProperty.call(sessionData, 'note_version') ||
                        Object.prototype.hasOwnProperty.call(sessionData, 'note_updated_at') ||
                        Object.prototype.hasOwnProperty.call(sessionData, 'note_updated_by');
                    const prevNoteVersion = existingSessionData.note_version;
                    const prevNote = existingSessionData.note;
                    const prevNoteUpdatedAt = existingSessionData.note_updated_at;
                    const prevNoteUpdatedBy = existingSessionData.note_updated_by;
                    // Check if workspace changed
                    const oldWorkspace = existingSessionData.workspace || 'Default';
                    // Only treat workspace as changed if the update explicitly included a workspace
                    // This avoids falsely resetting to 'Default' when unrelated updates (e.g., dynamic_title)
                    // arrive without a workspace field.
                    const newWorkspace = (Object.prototype.hasOwnProperty.call(sessionData, 'workspace')
                        ? (sessionData.workspace || 'Default')
                        : oldWorkspace);
                    const workspaceChanged = oldWorkspace !== newWorkspace;
                    
                    // Workspace change detection for debugging
                    // console.log(`[TerminalManager] Workspace check: ${oldWorkspace} -> ${newWorkspace}, changed: ${workspaceChanged}`);
                    
                    // Update client count if changed
                    if (sessionData.connected_client_count !== undefined) {
                        this.sessionList.updateSessionClientCount(
                            sessionData.session_id, 
                            sessionData.connected_client_count, 
                            sessionData.connected_client_ids || []
                        );
                    }
                    
                    // Update title if changed
                    if (sessionData.title !== existingSessionData.title) {
                        this.sessionList.updateSessionTitle(sessionData.session_id, sessionData.title);
                        // If this is the current session, update header immediately using configured mode
                        if (this.currentSessionId === sessionData.session_id) {
                            const effective = computeDisplayTitle({ ...existingSessionData, ...sessionData }, { fallbackOrder: [], defaultValue: 'Session' });
                            const templateName = sessionData.template_name || existingSessionData.template_name || null;
                            this.updateSessionInfoToolbar(effective, sessionData.session_id, templateName);
                        }
                    }
                    
                    // If dynamic title changed, update header depending on configured mode
                    const dynamicChanged = Object.prototype.hasOwnProperty.call(sessionData, 'dynamic_title') &&
                        sessionData.dynamic_title !== existingSessionData.dynamic_title;
                    if (dynamicChanged) {
                        const isCurrent = this.currentSessionId === sessionData.session_id;
                        if (isCurrent) {
                            const mode = getDynamicTitleMode();
                            let shouldUpdate = false;
                            if (mode === 'always') {
                                shouldUpdate = true;
                            } else if (mode === 'ifUnset') {
                                const hasExplicit = (existingSessionData.title && existingSessionData.title.trim()) ||
                                    (sessionData.title && sessionData.title.trim());
                                shouldUpdate = !hasExplicit;
                            } else {
                                // 'never' -> do not update in response to dynamic change
                                shouldUpdate = false;
                            }
                            if (shouldUpdate) {
                                const effective = computeDisplayTitle({ ...existingSessionData, ...sessionData }, { fallbackOrder: [], defaultValue: 'Session' });
                                const templateName = sessionData.template_name || existingSessionData.template_name || null;
                                this.updateSessionInfoToolbar(effective, sessionData.session_id, templateName);
                            }
                        }
                    }
                    
                    // Save History checkbox removed from header; no UI update needed here.
                    
                    // Update session data in the store
                    // Update the session in the store so other components see the changes
                    if (this.sessionList && this.sessionList.store) {
                        const store = this.sessionList.store;
                        const currentState = store.getState();
                        if (currentState.sessionList && currentState.sessionList.sessions) {
                            const sessions = new Map(currentState.sessionList.sessions);
                            const updatedSession = { ...existingSessionData, ...sessionData };
                            sessions.set(sessionData.session_id, updatedSession);
                            
                            store.setPath('sessionList.sessions', sessions);
                        }
                    }
                    
                    // Also update the local reference for backward compatibility
                    Object.assign(existingSessionData, sessionData);

                    // Keep stop inputs state in sync when included in payload
                    if (Object.prototype.hasOwnProperty.call(sessionData, 'stop_inputs_enabled') ||
                        Object.prototype.hasOwnProperty.call(sessionData, 'stop_inputs')) {
                        this.updateStopPromptsFromSession(existingSessionData);
                    }

                    if (notePropsProvided) {
                        const nextNoteVersion = existingSessionData.note_version;
                        const nextNote = existingSessionData.note;
                        const nextNoteUpdatedAt = existingSessionData.note_updated_at;
                        const nextNoteUpdatedBy = existingSessionData.note_updated_by;
                        const noteChanged =
                            nextNoteVersion !== prevNoteVersion ||
                            nextNote !== prevNote ||
                            nextNoteUpdatedAt !== prevNoteUpdatedAt ||
                            nextNoteUpdatedBy !== prevNoteUpdatedBy;
                        if (noteChanged) {
                            this.emitNoteUpdate(sessionData.session_id, {
                                note: nextNote,
                                version: nextNoteVersion,
                                updatedAt: nextNoteUpdatedAt,
                                updatedBy: nextNoteUpdatedBy
                            });
                        }
                    }

                    // If the updated session is currently selected, refresh header + toolbar controls
                    try {
                        if (this.currentSessionId === sessionData.session_id) {
                            // Always rebuild the header row so icon/spacing are correct
                            const effective = computeDisplayTitle({ ...existingSessionData }, { fallbackOrder: [], defaultValue: 'Session' });
                            const templateName2 = existingSessionData.template_name || null;
                            this.updateSessionInfoToolbar(effective, sessionData.session_id, templateName2);
                            this.viewController.showTerminalControls(existingSessionData);
                            // Also refresh terminal stdin gating in case visibility changed
                            try {
                            this.currentSession?.refreshInteractive?.();
                            } catch (_) {}
                        }
                    } catch (_) {}

                    // If we have a TerminalSession instance for this session (even if not current), refresh its gating
                    try {
                        const ts = this.sessions?.get?.(sessionData.session_id);
                        if (ts && ts.refreshInteractive) {
                            ts.refreshInteractive();
                        }
                    } catch (_) {}

                    // If a search overlay is active (query present), re-run server search to update matches
                    try {
                        const q = (this.searchQuery || '').trim();
                        if (q.length > 0) {
                            if (this.searchRefreshTimer) clearTimeout(this.searchRefreshTimer);
                            this.searchRefreshTimer = setTimeout(() => {
                                try { this.performSearch(false); } catch (_) {}
                            }, 300);
                        }
                    } catch (_) {}

                    // Handle workspace change
                    if (workspaceChanged) {
                        { const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs); if (dbg) console.log(`[TerminalManager] Processing workspace change for session ${sessionData.session_id}`); }
                        
                        // Use the sessionList's store which is properly initialized
                        const store = this.sessionList?.store || appStore;
                        if (!store) {
                            console.warn('[TerminalManager] Store not available for workspace update');
                            return;
                        }
                        const state = store.getState();
                        const currentWorkspace = state.workspaces?.current;
                        
                        { const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs); if (dbg) console.log(`[TerminalManager] Current workspace view: '${currentWorkspace}'`); }
                        
                        try {
                            // Add new workspace to the list if it doesn't exist
                        if (state.workspaces && state.workspaces.items) {
                            const workspaceSet = new Set(state.workspaces.items);
                            if (!workspaceSet.has(newWorkspace)) {
                                workspaceSet.add(newWorkspace);
                                store.setPath('workspaces.items', workspaceSet);
                            }
                        }
                        
                        // If session moved away from currently viewed workspace, refresh UI
                        const shouldRefreshUI = currentWorkspace && currentWorkspace === oldWorkspace && newWorkspace !== currentWorkspace;
                        { const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs); if (dbg) console.log(`[TerminalManager] UI refresh check: shouldRefresh=${shouldRefreshUI}`); }
                        { const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs); if (dbg) console.log(`[TerminalManager] Condition breakdown: currentWorkspace='${currentWorkspace}', oldWorkspace='${oldWorkspace}', newWorkspace='${newWorkspace}'`); }
                        
                        if (shouldRefreshUI) {
                            { const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs); if (dbg) console.log(`[TerminalManager] Refreshing UI - session moved away from current workspace`); }
                            // Refresh session tabs
                            if (this.sessionTabsManager) {
                                { const dbg = !!(appStore?.getState?.()?.preferences?.debug?.terminalManagerLogs); if (dbg) console.log(`[TerminalManager] Calling sessionTabsManager.refresh()`); }
                                this.sessionTabsManager.refresh();
                            } else {
                                console.warn(`[TerminalManager] sessionTabsManager not available`);
                            }
                            
                            // If this was the currently selected session, select another one
                            if (this.currentSessionId === sessionData.session_id) {
                                // Find another session in the current workspace
                                const sessionsInWorkspace = Array.from(state.sessionList?.sessions?.values() || [])
                                    .filter(s => (s.workspace || 'Default') === currentWorkspace && s.session_id !== sessionData.session_id);
                                
                                if (sessionsInWorkspace.length > 0) {
                                    // Select the first available session in the workspace
                                    this.selectSession(sessionsInWorkspace[0].session_id);
                                } else {
                                    // No other sessions in this workspace, clear selection
                                    this.currentSessionId = null;
                                    this.currentSession = null;
                                    // Clear the terminal display
                                    if (this.currentSession && this.currentSession.terminal) {
                                        this.currentSession.terminal.clear();
                                    }
                                }
                            }
                        }
                        
                        // If session moved into currently viewed workspace, refresh UI
                        if (currentWorkspace && currentWorkspace === newWorkspace && oldWorkspace !== currentWorkspace) {
                            // Refresh session tabs to show the new session
                            if (this.sessionTabsManager) {
                                this.sessionTabsManager.refresh();
                            }
                        }
                        
                        // Update workspaces list to reflect the change
                        this.updateWorkspacesFromSessions();
                        
                        } catch (error) {
                            console.error('[TerminalManager] Error in workspace change handling:', error);
                        }
                    }
                } else {
                    // Session doesn't exist locally, add it (edge case)
                    this.sessionList.addSession(sessionData, false);
                    // Ensure workspace list includes the session's workspace for non-admin viewers
                    try { this.updateWorkspacesFromSessions(); } catch (_) {}
                }
                break;
                
            case 'note_updated': {
                const sessionForNote = this.sessionList.getSessionData(sessionData.session_id);
                const mergedNoteSession = sessionForNote
                    ? { ...sessionForNote, ...sessionData }
                    : { ...sessionData };

                if (sessionForNote) {
                    this.sessionList.updateSession(mergedNoteSession);
                } else {
                    this.sessionList.addSession(mergedNoteSession, false, false);
                }

                this.emitNoteUpdate(sessionData.session_id, {
                    note: mergedNoteSession.note ?? '',
                    version: mergedNoteSession.note_version ?? 0,
                    updatedAt: mergedNoteSession.note_updated_at ?? null,
                    updatedBy: mergedNoteSession.note_updated_by ?? null
                });
                break;
            }

            case 'links_added':
                // New links were added to an existing session
                const sessionForLinks = this.sessionList.getSessionData(sessionData.session_id);
                if (sessionForLinks) {
                    // Update the session data with new links in the store
                    const updatedSessionData = {
                        ...sessionForLinks,
                        links: sessionData.links || []
                    };
                    this.sessionList.updateSession(updatedSessionData);
                    
                    // Check if this session is attached (current OR in attachedSessions set)
                    const isCurrentSession = this.currentSession && this.currentSession.sessionId === sessionData.session_id;
                    const isAttachedSession = this.attachedSessions.has(sessionData.session_id);
                    
                    if (isCurrentSession) {
                        this.updateSessionLinks(updatedSessionData);
                        this.updateSessionTransitionsUI();
                    }
                    
                    // Always emit event for attached sessions (including current session)
                    if (isCurrentSession || isAttachedSession) {
                        this.eventBus.emit('links-added', { 
                            sessionId: sessionData.session_id, 
                            links: sessionData.links || [],
                            sessionData: updatedSessionData
                        });
                    } else {
                    }
                    
                }
                break;
                
            case 'terminated': {
                const terminatedId = sessionData.session_id;
                const wasCurrentSession = this.currentSessionId === terminatedId;

                // If the session is not currently displayed in our sidebar/store,
                // do not re-add it on a terminated event. This prevents a session
                // that was intentionally removed via the hotkey flow from
                // reappearing with an "Ended" badge when the server finally emits
                // the termination event.
                const existingSessionData = this.sessionList.getSessionData(terminatedId);
                if (!existingSessionData) {
                    // Nothing to update in the sidebar; skip re-adding.
                    // Still perform lightweight cleanup for any in-memory instance.
                    const instance = this.sessions.get(terminatedId);
                    if (instance) {
                        try { instance.isAttached = false; } catch (_) {}
                        try { instance.detach?.(false); } catch (_) {}
                    }
                    if (this.attachedSessions.has(terminatedId)) {
                        this.attachedSessions.delete(terminatedId);
                    }
                    if (this.connectedSessionId === terminatedId) {
                        this.connectedSessionId = this.attachedSessions.size > 0
                            ? Array.from(this.attachedSessions)[0]
                            : null;
                    }
                    // Ensure workspace metadata reflects latest session set
                    try { this.updateWorkspacesFromSessions(); } catch (_) {}
                    break;
                }

                // Merge termination payload into existing sidebar state so the session stays visible
                const mergedSessionData = { ...existingSessionData, ...sessionData, is_active: false, __stickyTerminated: true };
                this.sessionList.updateSession(mergedSessionData);

                // Keep a local terminal instance around for read-only viewing
                const sessionInstance = this.sessions.get(terminatedId);
                if (sessionInstance) {
                    try {
                        sessionInstance.sessionData = { ...sessionInstance.sessionData, ...mergedSessionData };
                    } catch (_) {}
                    sessionInstance.isAttached = false;
                    try {
                        sessionInstance.detach(false);
                    } catch (e) {
                        console.warn('[TerminalManager] Detach during termination failed:', e);
                    }
                }

                if (this.attachedSessions.has(terminatedId)) {
                    this.attachedSessions.delete(terminatedId);
                }
                if (this.connectedSessionId === terminatedId) {
                    this.connectedSessionId = this.attachedSessions.size > 0
                        ? Array.from(this.attachedSessions)[0]
                        : null;
                }

                // Ensure workspace metadata reflects latest session set
                this.updateWorkspacesFromSessions();

                if (wasCurrentSession) {
                    try {
                        const latestData = this.sessionList.getSessionData(terminatedId) || mergedSessionData;
                        this.currentSessionId = terminatedId;

                        // Rehydrate the existing terminal container for read-only viewing when available
                        const currentInstance = this.sessions.get(terminatedId);
                        if (currentInstance && currentInstance.container) {
                            this.viewController.clearTerminalView();
                            this.elements.terminalView.appendChild(currentInstance.container);
                        } else {
                            this.viewController.clearTerminalView();
                            // For local-only desktop sessions, avoid showing the Load History button; render inline history view
                            try {
                                const sd = latestData || { session_id: terminatedId };
                                const inlineLocal = (sd && sd.local_only === true && sd.is_active === false && window.desktop && window.desktop.isElectron);
                                if (inlineLocal) {
                                    await this.viewController.showSessionHistory(sd, (a, b) => this.formatDuration(a, b));
                                } else {
                                    this.viewController.showLoadHistoryButton(sd);
                                }
                            } catch (_) {
                                this.viewController.showLoadHistoryButton(latestData);
                            }
                        }
                        // Ensure Close button is visible after rendering history/container
                        try { this.updateSessionUI(terminatedId, { updateType: 'terminated' }); } catch (_) {}
                    } catch (e) {
                        console.warn('[TerminalManager] Failed to refresh terminated session UI:', e);
                    }
                }

                break;
            }
                
            case 'deleted':
                // Session was deleted (save_session_history=false) - remove completely from UI
                
                // Check if this was the current active session
                const wasCurrentSessionDeleted = this.currentSession && this.currentSession.sessionId === sessionData.session_id;
                
                // If this session was attached, clean it up
                if (this.attachedSessions.has(sessionData.session_id)) {
                    const session = this.sessions.get(sessionData.session_id);
                    if (session) {
                        session.dispose(); // Completely dispose the session
                        this.sessions.delete(sessionData.session_id);
                    }
                    this.attachedSessions.delete(sessionData.session_id);
                    
                    // Update compatibility tracking
                    if (this.connectedSessionId === sessionData.session_id) {
                        this.connectedSessionId = this.attachedSessions.size > 0 ? 
                            Array.from(this.attachedSessions)[0] : null;
                    }
                }
                
                if (wasCurrentSessionDeleted) {
                    this.currentSession = null;
                    this.currentSessionId = null;
                    
                    // Show termination message for deleted sessions too
                    this.showSessionTerminatedMessage(sessionData);
                }

                // Remove the session completely from the list
                this.sessionList.removeSession(sessionData.session_id);
                break;
                
            default:
                console.warn(`[Manager] Unknown session update type: ${updateType}`);
        }
        
        // Update session tabs after any session update
        this.updateSessionTabs();
    }

    /**
     * Handle incoming notification from WebSocket
     * @param {Object} notification - Notification message from server
     */
    handleNotification(notification) {
        try {
            const type = notification.notification_type || notification.type || 'info';
            const prefs = appStore.getState('preferences.notifications') || {};

            // Always delegate to NotificationDisplay. It records into center and
            // gates toast visibility based on global + per-level show settings.
            try {
                notificationDisplay.handleNotification(notification);
            } catch (e) {
                console.warn('[Notification] display failed:', e);
            }

            // Sound: honored only if backend requested it and preferences allow.
            const requestSound = !!notification.sound;
            if (requestSound) {
                const globalSound = prefs.sound === true;
                const levelSound = prefs.levels?.[type]?.sound;
                const shouldSound = !!(globalSound && (levelSound !== false));

                if (shouldSound) {
                    audioManager.playNotificationSound(type);
                }
            }

            console.log('[Notification] Received:', notification);
        } catch (error) {
            console.error('[Notification] Error handling notification:', error);
        }
    }

    setActiveFilterTab(activeTab) {
        // Remove active class from all tabs
        this.elements.filterTabs.forEach(tab => {
            tab.classList.remove('active');
        });
        
        // Add active class to selected tab
        activeTab.classList.add('active');
    }

    showTerminalControls(sessionData) {
        // Terminate button depends on interactivity (hidden for read-only clients)
        const isInteractive = this.isSessionInteractive(sessionData);
        if (this.elements.closeBtn) this.elements.closeBtn.style.display = isInteractive ? 'block' : 'none';
        if (this.elements.detachBtn) {
            // Hide or disable detach/attach for local-only sessions in desktop
            const isLocal = !!(sessionData && sessionData.local_only === true);
            const inDesktop = !!(window.desktop && window.desktop.isElectron);
            if (isLocal && inDesktop) {
                // Prefer disabling with tooltip for clearer UX
                try {
                    this.elements.detachBtn.disabled = true;
                    this.elements.detachBtn.classList?.add('button-disabled');
                    this.elements.detachBtn.title = 'Not available for local sessions';
                } catch (_) {}
            } else {
                try {
                    this.elements.detachBtn.disabled = false;
                    this.elements.detachBtn.classList?.remove('button-disabled');
                    this.elements.detachBtn.title = '';
                } catch (_) {}
            }
            this.elements.detachBtn.style.display = 'block';
        }
        // Header Delete button removed
        
        // Show clear, text input, and mobile keyboard buttons only for interactive sessions
        // Default to interactive=true if field is missing (backward compatibility)
        // If explicitly set to false, respect that
        // Re-evaluate interactive state for other toolbar controls
        // (shared_readonly hides clear/text input for non-owners)
        // isInteractive already computed above
        
        // XXX this.elements.clearBtn.style.display = isInteractive ? 'block' : 'none';
        if (this.elements.textInputBtn) this.elements.textInputBtn.style.display = isInteractive ? 'block' : 'none';
        if (this.elements.mobileKeyboardBtn) this.elements.mobileKeyboardBtn.style.display = isInteractive ? 'block' : 'none';
        if (this.elements.promptsDropdownContainer) {
            this.elements.promptsDropdownContainer.style.display = isInteractive ? 'block' : 'none';
        }
        
        // If not interactive, close mobile keyboard if open
        if (!isInteractive) {
            this.mobileInterface.hideMobileKeyboard();
            // Also close prompts dropdown when session becomes non-interactive
            this.closePromptsDropdown();
        }
        
        // Save History checkbox removed from header; no-op here.
    }

    clearTerminalView() {
        // Do NOT detach sessions when clearing the view.
        // Just remove the current session's container from the DOM so attachments persist.
        if (this.currentSession && this.currentSession.container && this.currentSession.container.parentNode) {
            this.currentSession.container.parentNode.removeChild(this.currentSession.container);
        }
        // Keep the TerminalSession object and attachment state in memory.
        this.currentSession = null;

        // Clean up history terminal and related resources
        this.viewController.cleanupHistoryTerminal();

        // Clear terminal view and show placeholder
        this.viewController.clearTerminalView();
        this.viewController.showEmptyPlaceholder();
        
        // Clear sidebar selection
        this.sessionList.setActiveSession(null);
        
        // Update UI to no selection state
        this.updateSessionInfoToolbar('', '');
        this.currentSessionId = null;
        
        // Hide all terminal controls
        this.viewController.hideTerminalControls();
        try { document.body.classList.remove('session-selected'); } catch (_) {}
        
        // Hide the terminal tabs toolbar completely when no session
        this.setTabsToolbarVisibility(false);
        const tabsToolbar = this.getTabsToolbarElement();
        
        // Do not prune non-terminal views or buttons here; TabManager handles DOM cleanup.

        // Notify TabManager via event bus (decoupled)
        try { this.eventBus.emit('tab-clear-session'); } catch (_) {}
    }

    /**
     * Show session terminated message in terminal area
     * @param {Object} sessionData - The terminated session data
     */
    showSessionTerminatedMessage(sessionData) {
        // For local (desktop) sessions, keep the live terminal content visible
        // and switch controls to a read-only state instead of showing a button.
        try {
            const sid = String(sessionData?.session_id || '').trim();
            const sd = this.sessionList?.getSessionData?.(sid) || null;
            const isLocalOnly = !!(sd && sd.local_only === true);
            const inDesktop = !!(window.desktop && window.desktop.isElectron);
            const existing = this.sessions?.get?.(sid);
            if (sid && isLocalOnly && inDesktop && existing && existing.container) {
                // Ensure the existing terminal container remains visible
                // Do not clear or replace the terminal view; just refresh the UI to reflect ended state
                this.currentSession = existing;
                this.currentSessionId = sid;
                try { this.updateSessionUI(sid, { updateType: 'terminated' }); } catch (_) {}
                // No further action (avoid rendering the View History button)
                return;
            }
        } catch (_) { /* fall through to default flow */ }

        // Default behavior: show a View History button for terminated sessions
        const container = document.createElement('div');
        container.className = 'terminal-terminated';
        const p = document.createElement('p');
        p.textContent = 'Terminal session has ended.';
        const btn = document.createElement('button');
        btn.className = 'view-history-btn';
        btn.textContent = 'View History';
        btn.addEventListener('click', () => {
            this.viewSessionHistory(sessionData.session_id);
        });
        container.appendChild(p);
        container.appendChild(btn);

        // Set the terminal view content
        this.elements.terminalView.innerHTML = '';
        this.elements.terminalView.appendChild(container);
        
        // Clear session tracking but keep currentSessionId for context
        this.currentSession = null;
        // Update compatibility tracking - use any remaining attached session
        this.connectedSessionId = this.attachedSessions.size > 0 ? 
            Array.from(this.attachedSessions)[0] : null;
        
        // Hide terminal controls since session is no longer active
        this.viewController.hideTerminalControls();
    }

    /**
     * Close the current session and clear the terminal view
     * Automatically switches to next available session if any exist
     */
    async closeCurrentSession() {
        // Clear the current session tracking
        this.currentSession = null;
        this.currentSessionId = null;
        
        // Clear the terminal view and propagate full cleanup (hides tabs rows, emits events)
        // Use the manager-level clearTerminalView to ensure the TabManager receives
        // the tab-clear-session event and the terminal tabs toolbars are hidden.
        this.clearTerminalView();
        
        // Try to select another attached session
        if (this.attachedSessions.size > 0) {
            const nextSessionId = Array.from(this.attachedSessions)[0];
            try {
                // Ensure workspace context matches the next session to keep UI consistent
                const nextSessionData = this.sessionList?.getSessionData(nextSessionId);
                const targetWorkspace = (nextSessionData && nextSessionData.workspace) ? nextSessionData.workspace : 'Default';
                if (targetWorkspace && this.currentWorkspace !== targetWorkspace) {
                    // Switch workspace view first so sidebar, tabs, and filters align
                    this.enterWorkspace(targetWorkspace);
                    // Keep the UI tabs consistent with the underlying filter
                    const activeTab = Array.from(this.elements.filterTabs || []).find(tab => tab.dataset.filter === 'active');
                    if (activeTab) this.setActiveFilterTab(activeTab);
                }
            } catch (e) {
                console.warn('[Manager] Failed to align workspace after closing session:', e);
            }
            await this.selectSession(nextSessionId);
        } else {
            // No attached sessions, hide terminal controls and show empty placeholder
            this.viewController.hideTerminalControls();
            this.viewController.showEmptyPlaceholder();
        }
        
        // Update compatibility tracking - use any remaining attached session
        this.connectedSessionId = this.attachedSessions.size > 0 ? 
            Array.from(this.attachedSessions)[0] : null;
    }

    /**
     * Add a notification about session termination to the notification center
     * @param {Object} sessionData - The terminated session data
     */
    addSessionTerminationNotification(sessionData) {
        // Kept for backward compatibility; routed through NotificationDisplay pipeline
        const sessionTitle = sessionData.title || sessionData.command || 'Terminal Session';
        try {
            notificationDisplay.show({
                notification_type: 'warning',
                title: `${sessionTitle} Terminated`,
                message: 'Terminal session has ended',
                session_id: sessionData.session_id,
                is_active: false,
                timestamp: Date.now()
            });
        } catch (_) {}
    }

    /**
     * Switch to inactive filter and select the specified session
     * @param {string} sessionId - Session ID to view history for
     */
    async viewSessionHistory(sessionId) {
        // Load and display history directly in the terminal view
        await this.loadSessionHistory(sessionId);
    }

    /**
     * Show a status message in the terminal header
     * @param {string} message - The message to display
     * @param {number} timeout - How long to show the message (ms)
     * @param {boolean} isError - Whether this is an error message
     */
    showStatusMessage(message, timeout = 3000, isError = false) {
        const statusElement = document.getElementById('terminal-status-message');
        if (!statusElement) {
            console.warn('[Status] Status message element not found');
            return;
        }
        
        // Clear any existing timeout
        if (this.statusMessageTimeout) {
            clearTimeout(this.statusMessageTimeout);
        }
        
        // Set the message and styling
        statusElement.textContent = message;
        statusElement.classList.remove('error');
        if (isError) {
            statusElement.classList.add('error');
        }
        
        // Show the message
        statusElement.classList.add('show');
        
        // Hide after timeout
        this.statusMessageTimeout = setTimeout(() => {
            statusElement.classList.remove('show');
            // Clear text after fade out
            setTimeout(() => {
                statusElement.textContent = '';
            }, 300);
        }, timeout);
    }

    onPageActive() {
        // Called when terminal page becomes active
        // Auto-resize is handled automatically by xterm.js
    }

    handleSearchInput(query) {
        this.searchQuery = query.trim();
        
        // Clear existing debounce timer
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Debounce search by 300ms and apply filtering immediately
        this.searchDebounceTimer = setTimeout(() => {
            this.performSearch(false);
        }, 300);
    }

    async performSearch(preserveSelection = false) {
        if (!this.searchQuery) {
            // Empty search - clear overlay and restore original sessions
            try { this.sessionList?.store?.setPath('sessionList.filteredIds', null); } catch (_) {}
            // With no search query, just reapply filters to the existing session list
            this.applyTemplateFilterToCurrentSessions();
            this.applyPinnedFilterToCurrentSessions();
            return;
        }

        try {
            const query = this.searchQuery;
            const activeResults = await apiService.searchSessions(query, 'active');

            const stickySet = this.sessionList?.stickyTerminatedSessions instanceof Set
                ? this.sessionList.stickyTerminatedSessions
                : null;
            let stickyResults = [];
            let stickyStoreSessions = [];
            if (stickySet && stickySet.size > 0) {
                const storeState = this.sessionList?.store?.getState?.();
                const sessionState = storeState?.sessionList || {};
                const sessionsMap = sessionState.sessions instanceof Map ? sessionState.sessions : new Map();
                const filters = sessionState.filters || {};
                const getSessionData = (id) => {
                    try {
                        return this.sessionList?.getSessionData?.(id) || null;
                    } catch (_) {
                        return null;
                    }
                };

                stickyStoreSessions = SessionFilterService.collectStickySessions({
                    stickySet,
                    sessionsMap,
                    filters,
                    getSessionData
                });

                const allowedStickyIds = new Set(stickyStoreSessions.map(session => String(session.session_id)));
                if (allowedStickyIds.size > 0) {
                    try {
                        const inactiveResults = await apiService.searchSessions(query, 'inactive');
                        stickyResults = Array.isArray(inactiveResults)
                            ? inactiveResults.filter(item => item && allowedStickyIds.has(String(item.session_id)))
                            : [];
                    } catch (inactiveError) {
                        console.warn('[TerminalManager] Inactive session search failed:', inactiveError);
                    }
                }
            }

            const merged = new Map();
            const addToMerged = (item) => {
                if (item && item.session_id) {
                    merged.set(String(item.session_id), item);
                }
            };
            (Array.isArray(activeResults) ? activeResults : []).forEach(addToMerged);
            (Array.isArray(stickyResults) ? stickyResults : []).forEach(addToMerged);
            stickyStoreSessions.forEach(addToMerged);

            const combinedResults = Array.from(merged.values());
            this.displaySearchResults(combinedResults, { preserveSelection });
        } catch (error) {
            errorHandler.handle(error, { context: 'search_sessions', query: this.searchQuery });
        }
    }

    displaySearchResults(sessions, options = {}) {
        const preserveSelection = !!options.preserveSelection;
        const searchActive = !!(this.searchQuery && typeof this.searchQuery === 'string' && this.searchQuery.trim().length > 0);
        // Compute overlay of matching IDs and update store; do not mutate sessions map
        try {
            const store = this.sessionList.store;
            const state = store.getState();
            const currentSessions = state.sessionList?.sessions || new Map();
            const activeIds = Array.isArray(sessions)
                ? sessions
                    .map(s => (s && s.session_id ? String(s.session_id) : null))
                    .filter(Boolean)
                    .filter(id => currentSessions.has(id))
                : [];
            const stickyMatches = this.getMatchingStickySessions(this.searchQuery, currentSessions);
            const combined = [];
            const seen = new Set();
            activeIds.forEach(id => {
                if (!seen.has(id)) {
                    combined.push(id);
                    seen.add(id);
                }
            });
            stickyMatches.forEach(id => {
                if (!seen.has(id)) {
                    combined.push(id);
                    seen.add(id);
                }
            });
            store.setPath('sessionList.filteredIds', combined);
        } catch (e) {
            console.warn('[TerminalManager] Failed to set filteredIds overlay:', e);
        }
        
        // Apply current tab filter to the search results
        const activeTab = document.querySelector('.filter-tab.active');
        const currentFilter = activeTab ? activeTab.dataset.filter : 'all';
        this.sessionList.setFilter(currentFilter);
        
        // Update available template filters and apply template filter
        this.updateAvailableTemplateFilters();
        this.applyTemplateFilterToCurrentSessions();
        
        // If a search is active, do not auto-switch session/workspace at all.
        // Keep current selection even if it doesn't match; user must click a result to change.
        if (this.searchFreezeActive) {
            // If current selection is still visible, keep it highlighted in the list
            try {
                if (this.currentSessionId) {
                    const item = this.sessionList.sessions.get(this.currentSessionId);
                    if (item && item.style.display !== 'none') {
                        this.sessionList.setActiveSession(this.currentSessionId);
                        return; // keep current selection
                    }
                }
            } catch (_) {}
            // Otherwise, do nothing; user will choose manually
            return;
        }

        // No special preservation: selection restore logic will pick appropriate visible session

        // No special preservation: if current is not visible, it will be replaced below

        // Actively select a visible session after applying search
        try {
            const visibleSessions = (typeof this.sessionList?.getVisibleSessionsForCurrentFilters === 'function')
                ? this.sessionList.getVisibleSessionsForCurrentFilters()
                : [];
            const visibleIds = Array.isArray(visibleSessions) ? visibleSessions.map(s => s.session_id) : [];

            // If no visible sessions, clear the view
            if (visibleIds.length === 0) {
                this.clearTerminalView();
                return;
            }

            // If the current session is not visible anymore, pick a new one
            if (!this.currentSessionId || !visibleIds.includes(this.currentSessionId)) {
                // Prefer saved selection for current workspace if visible; else first visible
                let pick = null;
                try {
                    const ws = this.currentWorkspace || 'Default';
                    const savedId = this.workspaceSelections?.get(ws) || null;
                    if (savedId && visibleIds.includes(savedId)) {
                        pick = savedId;
                    }
                } catch (_) {}
                if (!pick) pick = visibleIds[0];

                this.selectAndHighlight(pick, { autoSelect: true });
                return;
            }
            // Else current remains visible; ensure highlight is consistent
            this.sessionList.setActiveSession(this.currentSessionId);
            try { this.sessionTabsManager?.setActiveSession?.(this.currentSessionId); } catch (_) {}
        } catch (_) {}

        // If nothing is visible, fall back to default behavior
        this.ensureVisibleSelection();
    }

    getMatchingStickySessions(query, currentSessions = new Map()) {
        if (!query || !query.trim()) return [];
        const normalizedQuery = query.trim();
        const stickySet = this.sessionList?.stickyTerminatedSessions instanceof Set
            ? this.sessionList.stickyTerminatedSessions
            : null;
        if (!stickySet || stickySet.size === 0) {
            return [];
        }

        const storeState = this.sessionList?.store?.getState?.();
        const sessionState = storeState?.sessionList || {};
        const sessionsMap = currentSessions instanceof Map
            ? currentSessions
            : (sessionState.sessions instanceof Map ? sessionState.sessions : new Map());
        const filters = sessionState.filters || {};

        const stickySessions = SessionFilterService.collectStickySessions({
            stickySet,
            sessionsMap,
            filters,
            getSessionData: (id) => {
                try {
                    return this.sessionList?.getSessionData?.(id) || null;
                } catch (_) {
                    return null;
                }
            }
        });

        const matches = [];
        stickySessions.forEach(sessionData => {
            try {
                if (SessionFilterService.matchesSearchFilter(sessionData, normalizedQuery)) {
                    matches.push(String(sessionData.session_id));
                }
            } catch (_) {}
        });
        return matches;
    }

    clearSearch() {
        this.elements.searchInput.value = '';
        this.elements.searchClear.style.display = 'none';
        this.searchQuery = '';
        try { this.sessionList.store.setPath('sessionList.filteredIds', null); } catch (_) {}
        
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Reapply filters against the full session list without reloading or detaching sessions
        this.applyFilters();
        // After sessions are restored, ensure the sidebar highlights the current session
        setTimeout(() => {
        try {
            if (this.currentSessionId) {
                this.sessionList.setActiveSession(this.currentSessionId);
                this.sessionTabsManager?.setActiveSession(this.currentSessionId);
                this.updateTextInputState();
            }
        } catch (_) {}
        }, 0);
    }

    /**
     * Ensure a visible session is selected after filtering changes.
     * - If current selection is still visible, keep it.
     * - Else prefer saved tab selection if visible.
     * - Else select the first visible session.
     */
    ensureVisibleSelection() {
        try {
            // Do not override recent manual selections
            if (Date.now() < (this.suppressAutoSelectionUntil || 0)) {
                return;
            }

            // Collect visible session IDs from the DOM
            const items = Array.from(this.elements.sessionList.querySelectorAll('.session-item'));
            let visibleIds = items
                .filter(el => el && el.style.display !== 'none')
                .map(el => el.dataset.sessionId)
                .filter(Boolean);

            // When searching within a specific workspace, prefer selections from that workspace.
            // If none exist, avoid snapping to another workspace; clear the view instead.
            if (this.searchQuery && this.currentWorkspace) {
                const inWorkspace = visibleIds.filter(id => {
                    try {
                        const sd = this.sessionList?.getSessionData(id);
                        const ws = (sd && (sd.workspace || 'Default')) || 'Default';
                        return ws === this.currentWorkspace;
                    } catch (_) { return false; }
                });
                if (inWorkspace.length > 0) {
                    visibleIds = inWorkspace;
                } else {
                    // If the user already has a current selection that belongs to this workspace, keep it
                    try {
                        if (this.currentSessionId) {
                            const sd = this.sessionList?.getSessionData(this.currentSessionId);
                            const ws = (sd && (sd.workspace || 'Default')) || 'Default';
                            if (ws === this.currentWorkspace) {
                                return; // keep current selection even if not in the reduced DOM set
                            }
                        }
                    } catch (_) {}
                    // No matching sessions in the current workspace under active filters/search
                    this.clearTerminalView();
                    return;
                }
            }

            if (visibleIds.length === 0) {
                // Nothing to select; clear view
                this.clearTerminalView();
                return;
            }

            // If current selection is still visible, do nothing
            if (this.currentSessionId && visibleIds.includes(this.currentSessionId)) {
                return;
            }

            // Try workspace-specific selection (for page refresh restoration)
            if (this.currentWorkspace) {
                console.log(`[TerminalManager] ensureVisibleSelection checking workspace "${this.currentWorkspace}"`);
                // First check in-memory selections, then check persisted selections
                let savedId = this.workspaceSelections.get(this.currentWorkspace);
                console.log(`[TerminalManager] In-memory selection for "${this.currentWorkspace}":`, savedId);
                if (!savedId) {
                    // Try to load from persistence if not in memory
                    try {
                        const res = getStateStore().loadSync && getStateStore().loadSync();
                        const st = res && res.ok ? (res.state || {}) : {};
                        const persistedSelections = st['workspace_session_selections'] || {};
                        console.log('[TerminalManager] Persisted selections found:', persistedSelections);
                        savedId = persistedSelections[this.currentWorkspace] || null;
                        console.log(`[TerminalManager] Persisted selection for "${this.currentWorkspace}":`, savedId);
                        // Update in-memory map if found
                        if (savedId) {
                            this.workspaceSelections.set(this.currentWorkspace, savedId);
                        }
                    } catch (e) {
                        console.warn('[TerminalManager] Failed to load persisted selections:', e);
                    }
                }
                console.log(`[TerminalManager] Final savedId: ${savedId}, visible: ${visibleIds.includes(savedId)}, visibleIds:`, visibleIds);
                if (savedId && visibleIds.includes(savedId)) {
                    console.log(`[TerminalManager] Restoring workspace selection: ${savedId}`);
                    this.selectSession(savedId);
                    return;
                }
            }

            // Try tab-specific selection
            const savedTabSel = this.getCurrentTabSelection();
            if (savedTabSel && visibleIds.includes(savedTabSel)) {
                this.selectSession(savedTabSel);
                return;
            }

            // Otherwise select the first visible session
            this.selectSession(visibleIds[0]);
        } catch (e) {
            console.warn('[Manager] ensureVisibleSelection failed:', e);
        }
    }

    /**
     * Update available template filters based on currently visible sessions
     */
    updateAvailableTemplateFilters() {
        this.availableTemplateFilters.clear();
        
        // Get current tab filter to determine which sessions to include
        // Use the same helper used elsewhere so defaults stay consistent
        const currentFilter = this.getCurrentFilter();
        
        // Get all sessions from store
        const allSessions = this.sessionList.getAllSessions();
        if (!allSessions) {
            console.warn('[TerminalManager] updateAvailableTemplateFilters: no sessions available');
            return;
        }
        
        // Get all sessions that belong to the current tab (regardless of template filtering visibility)
        let hasSessionsWithoutTemplate = false;
        // Track which template labels actually exist for the current filter (use badge label when present)
        const templatesInCurrent = new Set();
        allSessions.forEach((sessionData, sessionId) => {
            // Check if session belongs to current tab based on active/inactive filter
            let shouldInclude = false;
            switch (currentFilter) {
                case 'active':
                    shouldInclude = sessionData.is_active;
                    break;
                case 'inactive':
                    shouldInclude = !sessionData.is_active;
                    break;
                default:
                    shouldInclude = true;
            }
            
            if (shouldInclude) {
                // Treat local-only sessions as a first-class "Local" template for filtering
                let label = '';
                try {
                    if (sessionData && sessionData.local_only === true) {
                        label = 'Local';
                    } else if (sessionData && typeof sessionData.template_badge_label === 'string' && sessionData.template_badge_label.trim()) {
                        label = sessionData.template_badge_label.trim();
                    } else if (sessionData && sessionData.template_name) {
                        label = sessionData.template_name;
                    } else {
                        label = '';
                    }
                } catch (_) { label = ''; }

                if (label) {
                    this.availableTemplateFilters.add(label);
                    templatesInCurrent.add(label);
                } else {
                    hasSessionsWithoutTemplate = true;
                }
            }
        });
        
        // Add "None" option only if there are sessions without templates in current tab
        if (hasSessionsWithoutTemplate) {
            this.availableTemplateFilters.add('_no_template_');
        }
        
        // Reconcile selected template filters with what actually exists in the current view.
        // If a selected filter has no matching sessions, drop it so the button disappears.
        if (this.selectedTemplateFilters && this.selectedTemplateFilters.size > 0) {
            const nextSelected = new Set();
            this.selectedTemplateFilters.forEach(templateName => {
                if (templateName === '_no_template_') {
                    if (hasSessionsWithoutTemplate) {
                        nextSelected.add(templateName);
                        this.availableTemplateFilters.add(templateName);
                    }
                    // else: drop the selection silently
                } else if (templatesInCurrent.has(templateName)) {
                    nextSelected.add(templateName);
                    this.availableTemplateFilters.add(templateName);
                }
                // else: template no longer present; omit to remove its button
            });
            this.selectedTemplateFilters = nextSelected;
        }
        
        this.renderTemplateFilterOptions();
    }

    /**
     * Render template filter options based on available templates
     */
    renderTemplateFilterOptions() {
        const container = this.elements.templateFilterOptions;
        // Clear only the template options, not the clear button
        const clearButton = container.querySelector('.template-filter-clear');
        container.innerHTML = '';
        
        // Check if there are any visible sessions or selected template filters
        // Show container if there are sessions to filter OR if filters are currently selected
        const allSessions = this.sessionList.getAllSessions();
        const currentFilter = this.getCurrentFilter();
        
        const visibleSessions = SessionFilterService.filter(allSessions, {
            status: currentFilter,
            search: '',
            template: 'all',
            pinned: false
        });
        
        const hasVisibleSessions = visibleSessions.length > 0;
        
        // Show the filter container if there are visible sessions OR selected template filters
        if (hasVisibleSessions || this.selectedTemplateFilters.size > 0) {
            this.elements.templateFilterContainer.style.display = 'block';
        } else {
            this.elements.templateFilterContainer.style.display = 'none';
            return; // No need to render options if container is hidden
        }
        
        // Sort templates alphabetically, with "No template" last
        const sortedTemplates = Array.from(this.availableTemplateFilters).sort((a, b) => {
            if (a === '_no_template_') return 1;
            if (b === '_no_template_') return -1;
            return a.localeCompare(b);
        });
        
        sortedTemplates.forEach(templateName => {
            const option = document.createElement('div');
            option.className = 'template-filter-option';
            
            if (templateName === '_no_template_') {
                option.textContent = 'None';
                option.classList.add('no-template');
                option.dataset.template = '_no_template_';
            } else {
                option.textContent = templateName;
                option.dataset.template = templateName;
            }
            
            if (this.selectedTemplateFilters.has(templateName)) {
                option.classList.add('selected');
            }
            
            option.addEventListener('click', () => {
                this.toggleTemplateFilter(templateName);
            });
            
            container.appendChild(option);
        });
        
        // Only show the clear button if there are selected filters
        if (clearButton && this.selectedTemplateFilters.size > 0) {
            container.appendChild(clearButton);
        }
    }

    /**
     * Toggle a template filter selection
     */
    toggleTemplateFilter(templateName) {
        if (this.selectedTemplateFilters.has(templateName)) {
            this.selectedTemplateFilters.delete(templateName);
        } else {
            this.selectedTemplateFilters.add(templateName);
        }
        
        this.renderTemplateFilterOptions();
        this.applyFilters();
    }

    /**
     * Toggle pinned filter on/off
     */
    togglePinnedFilter() {
        this.pinnedFilterActive = !this.pinnedFilterActive;
        this.updatePinnedFilterButton();
        // Apply to workspaces (sidebar)
        try {
            this.sessionList?.store?.setPath('workspaces.filterPinned', this.pinnedFilterActive);
        } catch (e) {}
        // Maintain session filter behavior if ever used elsewhere
        // this.applyFilters();
    }

    /**
     * Update pinned filter button appearance
     */
    updatePinnedFilterButton() {
        if (this.pinnedFilterActive) {
            this.elements.pinnedFilterBtn.classList.add('active');
        } else {
            this.elements.pinnedFilterBtn.classList.remove('active');
        }
    }

    /**
     * Toggle Active Workspaces filter and persist preference
     */
    toggleActiveWorkspaceFilter() {
        this.activeWorkspacesOnly = !this.activeWorkspacesOnly;
        // Persist preference
        try { queueStateSet('terminal_active_workspaces_only', !!this.activeWorkspacesOnly, 200); } catch (_) {}
        // Update button appearance
        this.updateActiveFilterButton();
        // Apply to workspaces (sidebar)
        try { this.sessionList?.store?.setPath('workspaces.filterActive', this.activeWorkspacesOnly); } catch (_) {}
    }

    /**
     * Load Active Workspaces filter preference from localStorage (defaults to true)
     */
    loadActiveWorkspaceFilter() {
        let value = true;
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const st = res && res.ok ? (res.state || {}) : {};
            const raw = st['terminal_active_workspaces_only'];
            if (raw != null) value = (raw === true || raw === 'true');
        } catch (_) {}
        this.activeWorkspacesOnly = value;
        // Initialize button state and store path
        this.updateActiveFilterButton();
        try { this.sessionList?.store?.setPath('workspaces.filterActive', this.activeWorkspacesOnly); } catch (_) {}
    }

    /**
     * Update Active button appearance
     */
    updateActiveFilterButton() {
        const btn = document.getElementById('active-filter-btn');
        if (!btn) return;
        if (this.activeWorkspacesOnly) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }

    /**
     * Clear all template filters
     */
    clearTemplateFilter() {
        this.selectedTemplateFilters.clear();
        this.renderTemplateFilterOptions();
        this.applyFilters();
    }

    /**
     * Apply both search and template filters to sessions
     */
    async applyFilters() {
        // If we have a search query, perform search first
        if (this.searchQuery) {
            await this.performSearch(true);
        } else {
            // No search query, just apply filters to current sessions
            this.applyTemplateFilterToCurrentSessions();
            this.applyPinnedFilterToCurrentSessions();
        }
    }

    /**
     * Apply template filter to currently displayed sessions
     */
    applyTemplateFilterToCurrentSessions() {
        // Update template filter in store to trigger reactive rendering
        // Create a new Set to ensure store detects the change
        const templateFilter = this.selectedTemplateFilters.size > 0 ? new Set(this.selectedTemplateFilters) : 'all';
        this.sessionList.setTemplateFilter(templateFilter);
        // After the DOM updates, ensure the current selection is still visible
        // Skip auto-selection while search freeze is active to avoid snapping
        setTimeout(() => {
            try {
                if (!this.searchFreezeActive) {
                    this.ensureVisibleSelection();
                }
            } catch (_) {}
        }, 0);
        
    }

    /**
     * Apply pinned filter to currently displayed sessions
     */
    applyPinnedFilterToCurrentSessions() {
        // Update pinned filter in store to trigger reactive rendering
        this.sessionList.setPinnedFilter(this.pinnedFilterActive);
    }
    
    sortSessionsWithPins(sessions) {
        // Ensure sessions is an array
        if (!Array.isArray(sessions)) {
            console.warn('[TerminalManager] sortSessionsWithPins: sessions is not an array:', sessions);
            return [];
        }
        
        // Separate pinned and unpinned sessions
        const pinned = [];
        const unpinned = [];
        
        sessions.forEach(session => {
            if (this.sessionList && this.sessionList.isPinned(session.session_id)) {
                pinned.push(session);
            } else {
                unpinned.push(session);
            }
        });
        
        // Both arrays are already sorted by timestamp (newest first) from the server
        // Concatenate pinned sessions first, then unpinned
        return [...pinned, ...unpinned];
    }
    
    sortSessionList() {
        // Re-sort the visible session list to ensure pinned sessions are at the top
        const container = this.sessionList.container;
        const sessionItems = Array.from(container.children);
        
        // Sort items: pinned first (by timestamp), then unpinned (by timestamp)
        sessionItems.sort((a, b) => {
            const aId = a.dataset.sessionId;
            const bId = b.dataset.sessionId;
            const aPinned = this.sessionList.isPinned(aId);
            const bPinned = this.sessionList.isPinned(bId);
            
            // Get session data for timestamp comparison
            const aData = this.sessionList.getSessionData(aId);
            const bData = this.sessionList.getSessionData(bId);
            
            // If one is pinned and the other isn't, pinned comes first
            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return 1;
            
            // If both have same pin status, sort by timestamp (newer first)
            if (aData && bData) {
                return bData.created_at - aData.created_at;
            }
            
            return 0;
        });
        
        // Re-append items in sorted order
        sessionItems.forEach(item => {
            container.appendChild(item);
        });
    }
    
    /**
     * Clear localStorage session_id if no sessions are visible in current tab
     * This prevents confusion when refreshing page after viewing empty tabs
     */
    clearStorageIfNoSessions() {
        // Don't clear localStorage during initial page load/initialization
        // This allows session restoration from localStorage to work properly
        if (this.isInitializing !== false) {
            return;
        }
        
        // Check if there are any visible sessions in the current view
        const allSessions = this.sessionList.getAllSessions();
        const currentFilter = this.getCurrentFilter();
        
        // Use SessionFilterService to get visible sessions
        const visibleSessions = SessionFilterService.filter(allSessions, {
            status: currentFilter,
            search: '',
            template: 'all',
            pinned: false
        });
        
        // If no sessions are visible in current tab, user needs to manually select one
        if (visibleSessions.length === 0) {
            console.log('[TerminalManager] No sessions visible in current tab - user can manually select one');
        }
    }
    
    /**
     * Create template badge HTML with color support
     */
    createTemplateBadgeHtml(templateName) {
        // Get template data if available
        const template = this.getTemplateByName(templateName);
        const badgeStyle = template && template.color ? this.getTemplateBadgeStyle(template.color) : '';
        const label = (template && typeof template.badge_label === 'string' && template.badge_label.trim())
            ? template.badge_label.trim()
            : templateName;
        return `<span class="template-badge"${badgeStyle}>${label}</span>`;
    }

    /**
     * Create a pseudo-badge for non-template commands
     * Uses the same off-white color as the tab color dot for non-templates
     */
    createCommandBadgeHtml(label = 'Command') {
        const fallbackColor = '#f5f5f5';
        const badgeStyle = this.getTemplateBadgeStyle(fallbackColor);
        const text = typeof label === 'string' && label.trim() ? label.trim() : 'Command';
        return `<span class="template-badge"${badgeStyle}>${text}</span>`;
    }

    // Removed legacy visibility badge rendering; compact icons are used instead
    
    /**
     * Get template by name from available templates
     */
    getTemplateByName(templateName) {
        if (!this.formManager || !this.formManager.availableTemplates) {
            return null;
        }
        
        return this.formManager.availableTemplates.find(template => template.name === templateName);
    }
    
    /**
     * Get style attribute for template badge color
     */
    getTemplateBadgeStyle(color) {
        const parsedColor = parseColor(color);
        if (!parsedColor) {
            return '';
        }
        
        const textColor = getContrastColor(parsedColor);
        return ` style="background-color: ${parsedColor}; color: ${textColor}; border-color: ${parsedColor};"`;
    }
    
    /**
     * Update session tabs based on current session list and filter
     */
    updateSessionTabs() {
        if (!this.sessionTabsManager) return;
        // Enable tabs whenever there are visible sessions (respecting workspace + status filters)
        const visibleSessions = this.sessionTabsManager.getVisibleSessions();
        const inWorkspace = !!this.currentWorkspace;
        if (visibleSessions.length > 0 || inWorkspace) {
            this.sessionTabsManager.enable();
            this.updateTextInputState();
        } else {
            // Under active search, avoid clearing selection/tabs during transient re-renders
            const hasActiveSearch = !!(this.searchQuery && this.searchQuery.trim().length > 0);
            if (hasActiveSearch) {
                return; // keep current tabs/selection; sidebar will drive updates when results arrive
            }
            this.sessionTabsManager.disable();
            // Clear the terminal view when no sessions are visible only outside search
            this.clearTerminalView();
            this.updateTextInputState();
        }
    }

    getTabsToolbarElement() {
        if (this._tabsToolbarEl && this._tabsToolbarEl.isConnected) {
            return this._tabsToolbarEl;
        }
        try {
            this._tabsToolbarEl = document.getElementById('terminal-tabs');
        } catch (_) {
            this._tabsToolbarEl = null;
        }
        return this._tabsToolbarEl;
    }

    setTabsToolbarVisibility(visible) {
        if (typeof visible !== 'boolean') {
            return;
        }
        if (this._tabsToolbarVisible === visible) {
            return;
        }
        const toolbar = this.getTabsToolbarElement();
        if (!toolbar) {
            this._tabsToolbarVisible = visible;
            return;
        }
        toolbar.style.display = visible ? '' : 'none';
        this._tabsToolbarVisible = visible;
    }

    /**
     * Show set title modal for the currently active session
     */
    showSetTitleModalForActiveSession() {
        if (!this.currentSessionId) {
            console.warn('[Manager] No active session to set title for');
            return;
        }
        
        const sessionData = this.sessionList.getSessionData(this.currentSessionId);
        if (!sessionData) {
            console.warn('[Manager] Current session data not found');
            return;
        }
        
        this.sessionList.modals.showSetTitleModal(sessionData, (sessionId, newTitle) => {
            this.sessionList.updateSessionTitle(sessionId, newTitle);
            try { this.refreshHeaderForSession(sessionId); } catch (_) {}
        });
    }

    /**
     * Terminate the currently active session
     */
    terminateActiveSession() {
        if (!this.currentSessionId) {
            console.warn('[Manager] No active session to terminate');
            return;
        }
        
        const sessionData = this.sessionList.getSessionData(this.currentSessionId);
        if (!sessionData) {
            console.warn('[Manager] Current session data not found');
            return;
        }
        
        // Only allow termination of active sessions
        if (!sessionData.is_active) {
            console.warn('[Manager] Cannot terminate inactive session');
            return;
        }
        
        this.doTerminateSession(this.currentSessionId);
    }

    /**
     * Toggle pin status for the currently active session
     */
    togglePinActiveSession() {
        if (!this.currentSessionId) {
            console.warn('[Manager] No active session to toggle pin for');
            return;
        }
        
        this.sessionList.togglePinSession(this.currentSessionId);
    }

    /**
     * Move the currently active session up in the list
     */
    moveActiveSessionUp() {
        if (!this.currentSessionId) {
            console.warn('[Manager] No active session to move up');
            return;
        }
        
        this.moveSessionInList(this.currentSessionId, -1);
    }

    /**
     * Move the currently active session down in the list
     */
    moveActiveSessionDown() {
        if (!this.currentSessionId) {
            console.warn('[Manager] No active session to move down');
            return;
        }
        
        this.moveSessionInList(this.currentSessionId, 1);
    }

    /**
     * Move a session up or down in the list
     * @param {string} sessionId - The session ID to move
     * @param {number} direction - -1 for up, 1 for down
     */
    moveSessionInList(sessionId, direction) {
        // Get current visible session order
        const sessionItems = Array.from(this.elements.sessionList.querySelectorAll('.session-item'));
        const visibleSessions = sessionItems
            .filter(item => item.style.display !== 'none')
            .map(item => item.dataset.sessionId);

        const currentIndex = visibleSessions.indexOf(sessionId);
        if (currentIndex === -1) {
            console.warn('[Manager] Session not found in visible list');
            return;
        }

        const newIndex = currentIndex + direction;
        if (newIndex < 0 || newIndex >= visibleSessions.length) {
            console.warn('[Manager] Cannot move session beyond list bounds');
            return;
        }

        // Get the target session ID at the new position
        const targetSessionId = visibleSessions[newIndex];
        
        // Use the session list's drag and drop functionality to move the session
        this.sessionList.handleDrop(sessionId, targetSessionId, direction > 0 ? 'after' : 'before');
    }

    /**
     * Toggle the sidebar visibility
     */
    toggleSidebar() { this.sidebar.toggleSidebar(); }

    /**
     * Show the sidebar
     */
    showSidebar() { this.sidebar.showSidebar(); }

    /**
     * Hide the sidebar
     */
    hideSidebar() { this.sidebar.hideSidebar(); }
    
    /**
     * Update CSS variables so other UI (notes editor) mirrors terminal font settings.
     * @param {number} fontSize
     * @param {string} fontFamily
     */
    updateTerminalFontVariables(fontSize, fontFamily) {
        try {
            const root = document.documentElement;
            if (!root) return;

            if (Number.isFinite(fontSize)) {
                root.style.setProperty('--terminal-font-size', `${fontSize}px`);
            }

            if (typeof fontFamily === 'string' && fontFamily.trim()) {
                root.style.setProperty('--terminal-font-family', fontFamily);
            }
        } catch (_) {
            // Non-fatal: CSS variables are a convenience for non-terminal views
        }
    }

    /**
     * Update font settings for all active terminals
     * @param {number} fontSize - Font size in pixels
     * @param {string} fontFamily - Font family string
     */
    updateAllTerminalFonts(fontSize, fontFamily) {
        this.updateTerminalFontVariables(fontSize, fontFamily);

        // Update all existing terminal sessions
        for (const [sessionId, session] of this.sessions) {
            if (session && session.updateFontSettings) {
                session.updateFontSettings(fontSize, fontFamily);
            }
        }
        console.log(`[TerminalManager] Updated font settings for all terminals: ${fontSize}px, ${fontFamily}`);
    }

    // Internal helper: scroll a session's terminal viewport to the bottom
    _scrollSessionToBottom(sessionId) {
        try {
            const s = this.sessions?.get?.(sessionId);
            if (s && typeof s.scrollToBottom === 'function') s.scrollToBottom();
            else if (s?.terminal?.scrollToBottom) s.terminal.scrollToBottom();
        } catch (e) {
            try {
                const dbg = (typeof appStore !== 'undefined') && appStore.getState()?.preferences?.debug?.terminalManagerLogs;
                if (dbg) console.debug('[TerminalManager] scrollToBottom failed:', e);
            } catch (_) { /* ignore */ }
        }
    }

    // Internal helper: clear xterm selection for a session
    _clearSessionSelection(sessionId) {
        try {
            const s = this.sessions?.get?.(sessionId);
            if (s?.terminal && typeof s.terminal.clearSelection === 'function') {
                s.terminal.clearSelection();
            }
        } catch (e) {
            try {
                const dbg = (typeof appStore !== 'undefined') && appStore.getState()?.preferences?.debug?.terminalManagerLogs;
                if (dbg) console.debug('[TerminalManager] clearSelection failed:', e);
            } catch (_) { /* ignore */ }
        }
    }

    /**
     * Send raw input to a session and scroll its terminal to bottom afterwards.
     * Provided for callers that don't use the modal or notes helpers.
     */
    async sendInput(sessionId, text, options = {}) {
        try {
            if (!sessionId || !text) return false;
            const opts = Object.assign({ delayMs: 120, enterStyle: 'cr', normalizeCRLF: true, stripFinalNewline: true }, options);
            // Normalize payload similar to WS helper
            let payload = String(text ?? '');
            if (opts.normalizeCRLF !== false) payload = payload.replace(/\r\n/g, '\n');
            if (opts.stripFinalNewline !== false) payload = payload.replace(/\n$/, '');

            // Use API to inject input. Server broadcasts a stdin_injected event;
            // the client registers a local render marker on receipt (with line)
            // and POSTs it to the backend for durability.
            await apiService.sendSessionInput(sessionId, {
                data: payload,
                submit: true,
                raw: false,
                enter_style: (opts.enterStyle || 'cr'),
                notify: (options.notify === false) ? false : true
            });

            // Scroll to bottom post-send
            try {
                const s = this.sessions?.get?.(sessionId);
                if (s && typeof s.scrollToBottom === 'function') s.scrollToBottom();
                else if (s?.terminal?.scrollToBottom) s.terminal.scrollToBottom();
            } catch (_) {}
            return true;
        } catch (e) {
            console.warn('[TerminalManager] sendInput (API) failed, falling back to WS:', e);
            // Fallback to WS for resilience
            try {
                await sendStdinWithDelayedSubmit(this.wsClient, sessionId, text, options);
                return true;
            } catch (_) {
                return false;
            }
        }
    }

    /**
     * Update xterm theme for all active terminals
     * @param {('dark'|'light')} theme - Effective theme to apply
     */
    updateAllTerminalThemes(theme) {
        for (const [, session] of this.sessions) {
            if (session && typeof session.updateTheme === 'function') {
                session.updateTheme(theme);
            }
        }
        console.log(`[TerminalManager] Applied terminal theme: ${theme}`);
    }

    // Get known workspace names from store or derive from sessions
    getWorkspaceNames() {
        try {
            const wsState = this.sessionList?.store?.getState()?.workspaces;
            if (wsState && wsState.items && wsState.items.size !== undefined) {
                return Array.from(wsState.items);
            }
        } catch (e) {
            // fall through
        }
        const sessions = this.sessionList?.getAllSessions() || new Map();
        const set = new Set(['Default']);
        if (sessions instanceof Map) {
            sessions.forEach(s => set.add((s.workspace || 'Default')));
        }
        return Array.from(set);
    }

    getOrderedWorkspaces() {
        try {
            // Prefer explicit store order if available to match sidebar list
            const state = this.sessionList?.store?.getState();
            const items = state?.workspaces?.items;
            const order = state?.workspaces?.order;
            if (Array.isArray(order) && order.length > 0) {
                const itemSet = items instanceof Set ? items : new Set(order);
                return order.filter(n => itemSet.has(n));
            }
            const names = this.getWorkspaceNames();
            return names.sort((a, b) => a.localeCompare(b));
        } catch (e) {
            return ['Default'];
        }
    }

    /**
     * Get the list of workspaces that are currently visible in the sidebar,
     * preserving the same ordering and filter rules as WorkspaceList.render().
     * This ensures keyboard navigation skips over filtered-out workspaces.
     */
    getVisibleOrderedWorkspaces() {
        try {
            const storeState = this.sessionList?.store?.getState();
            const wsState = storeState?.workspaces || {};

            const itemsSet = wsState.items || new Set(['Default']);
            const pinnedSet = wsState.pinned || new Set();
            const filterPinned = !!wsState.filterPinned;
            const filterActive = wsState.filterActive !== false; // default true

            // Base order matches the sidebar behavior
            const baseOrder = (Array.isArray(wsState.order) && wsState.order.length > 0)
                ? wsState.order.slice()
                : Array.from(itemsSet);

            // Apply pinned filter to the order
            const ordered = baseOrder.filter(name => !filterPinned || pinnedSet.has(name));

            // Compute whether template/search filters are active (to mirror sidebar visibility rules)
            let templateFilterActive = false;
            try {
                const tmpl = storeState?.sessionList?.filters?.template;
                templateFilterActive = !!(tmpl && tmpl !== 'all' && ((tmpl instanceof Set && tmpl.size > 0) || (Array.isArray(tmpl) && tmpl.length > 0) || (typeof tmpl === 'string' && tmpl.trim() !== '')));
            } catch (_) { /* noop */ }

            const searchActive = !!(this.searchQuery && typeof this.searchQuery === 'string' && this.searchQuery.trim().length > 0);

            // Build filtered session array similar to WorkspaceList
            const sessionsMap = storeState?.sessionList?.sessions || new Map();
            const sessionArray = sessionsMap instanceof Map ? Array.from(sessionsMap.values()) : [];
            const pinnedSessions = storeState?.sessionList?.filters?.pinnedSessions || new Set();
            const templateFilter = storeState?.sessionList?.filters?.template || 'all';

            const filteredSessions = SessionFilterService.filter(sessionArray, {
                status: 'all',
                search: '', // search results are already materialized into sessions
                template: templateFilter,
                pinned: false,
                pinnedSessions,
                workspace: null
            });

            const hideForFilters = filterActive || templateFilterActive || searchActive;

            // Helper to count active sessions for a workspace
            const activeCountFor = (name) => {
                let count = 0;
                for (const s of filteredSessions) {
                    const ws = s.workspace || 'Default';
                    if (ws === name && s.is_active) count++;
                }
                return count;
            };

            const visible = [];
            for (const name of ordered) {
                if (itemsSet && !(itemsSet instanceof Set ? itemsSet.has(name) : true)) continue;
                if (hideForFilters && activeCountFor(name) === 0) continue;
                visible.push(name);
            }

            // If nothing is visible (e.g., no active sessions and filterActive on),
            // fall back to the unfiltered ordered list so navigation still works.
            return (visible.length > 0) ? visible : ordered;
        } catch (e) {
            // On any error, fall back to previous behavior
            return this.getOrderedWorkspaces();
        }
    }

    previousWorkspace() {
        // Use only currently visible workspaces (skip filtered-out ones)
        const names = this.getVisibleOrderedWorkspaces();
        if (!names || names.length === 0) return;
        if (!this.currentWorkspace) {
            // From no selection, start at the last workspace
            this.enterWorkspace(names[names.length - 1]);
            return;
        }
        const current = this.currentWorkspace;
        let idx = names.indexOf(current);
        if (idx === -1) idx = 0;
        const target = names[(idx - 1 + names.length) % names.length];
        this.enterWorkspace(target);
    }

    nextWorkspace() {
        // Use only currently visible workspaces (skip filtered-out ones)
        const names = this.getVisibleOrderedWorkspaces();
        if (!names || names.length === 0) return;
        if (!this.currentWorkspace) {
            // From no selection, start at the first workspace
            this.enterWorkspace(names[0]);
            return;
        }
        const current = this.currentWorkspace;
        let idx = names.indexOf(current);
        if (idx === -1) idx = 0;
        const target = names[(idx + 1) % names.length];
        this.enterWorkspace(target);
    }

    // Build workspace set from current sessions and update list component
    updateWorkspacesFromSessions() {
        try {
            const sessions = this.sessionList?.getAllSessions() || new Map();
            // Start with any existing store-defined workspaces (e.g., from server)
            let existing = [];
            try {
                const state = this.sessionList?.store?.getState();
                if (state?.workspaces?.items) {
                    existing = Array.from(state.workspaces.items);
                }
            } catch (_) { /* noop */ }

            const set = new Set(['Default', ...existing]);
            if (sessions instanceof Map) {
                sessions.forEach(s => set.add((s.workspace || 'Default')));
            }
            if (this.workspaceListComponent) {
                this.workspaceListComponent.setWorkspaces(set);
            }
        } catch (e) {
            console.warn('[TerminalManager] Failed to update workspaces:', e);
        }
    }

    // Enter workspace detail view (shows session list filtered to workspace)
    enterWorkspace(name) {
        // Snapshot currently attached child sessions if switching away from current workspace
        try {
            const nextWs = name || 'Default';
            if (this.currentWorkspace && this.currentWorkspace !== nextWs) {
                const snapshot = new Set();
                this.attachedSessions?.forEach?.((sid) => {
                    if (this.childSessions?.has?.(sid)) snapshot.add(sid);
                });
                this._attachedChildSnapshot = snapshot;
            }
        } catch (_) { this._attachedChildSnapshot = new Set(); }

        // User navigation: break search freeze so normal filtering/tab behavior resumes
        this.searchFreezeActive = false;
        this.currentWorkspace = name || 'Default';
        // Notify application of workspace context change
        try {
            this._debug?.log?.('enterWorkspace', { next: this.currentWorkspace, from: this.currentWorkspace });
            this.eventBus.emit('workspace-changed', { workspace: this.currentWorkspace, mode: 'detail' });
        } catch (_) {}
        // Update sidebar highlight
        if (this.workspaceListComponent) {
            this.workspaceListComponent.setCurrent(this.currentWorkspace);
        }
        // Keep workspace list visible; do not show session cards in sidebar
        if (this.elements.sessionList) this.elements.sessionList.style.display = 'none';
        this.updateWorkspaceHeader();

        // Apply workspace filter to session list and show active sessions in tabs
        if (this.sessionList && this.sessionList.store) {
            this.sessionList.store.setPath('sessionList.filters.workspace', this.currentWorkspace);
            this.sessionList.setFilter('active');
        }

        // Re-render tabs/content
        if (this.searchQuery) {
            // With freeze disabled, allow normal selection behavior under search
            // Defer selection/highlight to displaySearchResults; avoid DOM-based restore using stale list
            this.performSearch(false);
            return;
        } else {
            this._debug?.log?.('enterWorkspace render+tabs');
            this.sessionList.render();
            this.updateSessionTabs();
        }

        // Restore last selection for workspace or auto-select first visible (respecting active filters)
        try {
            // If search was just performed above (returned early), selection will be handled there
            // If search freeze is still active, skip selection changes
            if (this.searchFreezeActive) {
                return;
            }

            // Prefer keeping the current session if it belongs to this workspace
            try {
                const curId = this.currentSessionId || null;
                if (curId) {
                    const curData = this.getAnySessionData?.(curId) || this.sessionList?.getSessionData?.(curId);
                    const curWs = (curData && (curData.workspace || 'Default')) || 'Default';
                    const isLive = !curData || curData.is_active !== false; // treat unknown as live
                    if (curWs === this.currentWorkspace && isLive) {
                        // Ensure both sidebar and terminal view reflect the current session
                        if (this.currentSessionId !== curId) {
                            try { this.selectSession?.(curId, { autoSelect: true }); } catch (_) {}
                        }
                        this.sessionList?.setActiveSession?.(curId);
                        return;
                    }
                }
            } catch (_) { /* fall through to visible list checks */ }

            // Build visible list from DOM (reflects all active filters and workspace)
            const sessionItems = Array.from(this.elements.sessionList.querySelectorAll('.session-item'));
            const visibleIds = sessionItems
                .filter(item => item.style.display !== 'none')
                .map(item => item.dataset.sessionId)
                .filter(Boolean);

            // First check in-memory selections, then check persisted selections
            let savedId = this.workspaceSelections.get(this.currentWorkspace);
            if (!savedId) {
                // Try to load from persistence if not in memory
                try {
                    const res = getStateStore().loadSync && getStateStore().loadSync();
                    const st = res && res.ok ? (res.state || {}) : {};
                    const persistedSelections = st['workspace_session_selections'] || {};
                    savedId = persistedSelections[this.currentWorkspace] || null;
                    // Update in-memory map if found
                    if (savedId) {
                        this.workspaceSelections.set(this.currentWorkspace, savedId);
                    }
                } catch (_) {}
            }

            // If current session still visible, keep it
            if (this.currentSessionId && visibleIds.includes(this.currentSessionId)) {
                this._debug?.log?.('enterWorkspace keep-current-visible', { current: this.currentSessionId });
                this.sessionList.setActiveSession(this.currentSessionId);
                return;
            }

            // Else prefer saved selection if still visible
            if (savedId && visibleIds.includes(savedId)) {
                if (this.currentSessionId === savedId && this.currentSession) {
                    this._debug?.log?.('enterWorkspace saved-visible (no reselect)', { savedId });
                    this.sessionList.setActiveSession(savedId);
                } else {
                    this._debug?.log?.('enterWorkspace selecting-saved', { savedId });
                    this.selectSession(savedId, { autoSelect: true }).catch(() => {});
                }
                return;
            }

            // Else pick the first visible session if any
            if (visibleIds.length > 0) {
                this._debug?.log?.('enterWorkspace selecting-first-visible', { sessionId: visibleIds[0] });
                this.selectSession(visibleIds[0], { autoSelect: true }).catch(() => {});
            } else {
                this._debug?.log?.('enterWorkspace no-visible-sessions: clearing terminal view and tabs');
                this.clearTerminalView();
                this.updateSessionTabs();
            }
        } catch (e) {
            console.warn('[Manager] Failed to restore workspace selection:', e);
        }
    }

    // Return to workspace list view
    showWorkspaceList() {
        this.currentWorkspace = null;
        // Notify application of workspace context change
        try { this.eventBus.emit('workspace-changed', { workspace: null, mode: 'list' }); } catch (_) {}
        if (this.elements.sessionList) this.elements.sessionList.style.display = 'none';
        // Clear active workspace highlight in sidebar
        if (this.workspaceListComponent) {
            this.workspaceListComponent.setCurrent(null);
        }
        this.updateWorkspaceHeader();
        if (this.sessionList && this.sessionList.store) {
            this.sessionList.store.setPath('sessionList.filters.workspace', null);
            // Re-render and refresh tabs so all tabs show on the right
            try { this.sessionList.render(); } catch (_) {}
            this.updateSessionTabs();
        }
    }

    updateWorkspaceHeader() {
        const backBtn = this.elements?.workspacesBackBtn;
        if (backBtn) backBtn.style.display = 'none';
    }
}
