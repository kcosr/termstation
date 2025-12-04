/**
 * Tab Manager for Terminal + URL Viewing
 * Handles tab creation, switching, and URL iframe management
 */

import { apiService } from '../../services/api.service.js';
import { getContext } from '../../core/context.js';
import { appStore } from '../../core/store.js';
import { TabsController } from './tabs-controller.js';
import { iconUtils } from '../../utils/icon-utils.js';
import { computeDisplayTitle } from '../../utils/title-utils.js';
import { NotesController } from './notes-controller.js';
import { WorkspaceNotesController } from './workspace-notes-controller.js';
import { WorkspaceFilesView } from './workspace-files-view.js';
import { escapeHtml } from './notes-markdown.js';
import { keyboardShortcuts } from '../shortcuts/keyboard-shortcuts.js';
import { notificationDisplay } from '../../utils/notification-display.js';
import { InputModal } from '../ui/modal.js';
import { getStateStore } from '../../core/state-store/index.js';
import { queueStateSet } from '../../core/state-store/batch.js';
import { createDebug } from '../../utils/debug.js';
import { orderTabsWithWorkspaceAfterShellAndCommand } from './tab-ordering-helper.js';
import { shouldRegenerateTemplateLink, normalizeTemplateLinkError, computeChatLinkFonts } from './chat-link-helpers.js';

export class TabManager {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this._debug = createDebug('TabManager');
        this.sessionTabs = new Map(); // Map of session-id -> Map of tab-id -> tab data
        this.sessionActiveTab = new Map(); // Map of session-id -> active-tab-id
        this.containerTabLookup = new Map(); // Map of child session id -> { parentId, tabId }
        this.currentSessionId = null;
        this.activeTabId = 'terminal';
        this.tabCounter = 0;
        this.sessionLinkCache = new Map();
        this._linksPrefUnsub = null;
        this.globalTabs = new Map(); // Tabs not bound to a session (e.g., workspace-note)
        this.renameTabModal = null; // Lazy-initialized modal for renaming link tabs
        this._renameTabTarget = null; // Tracks the tab being renamed while modal is open

        this.notesController = new NotesController({
            tabManager: this,
            eventBus,
            appStore,
            apiService,
            getContext
        });
        this.workspaceNotesController = new WorkspaceNotesController({
            tabManager: this,
            eventBus,
            appStore,
            getContext
        });
        this._shortcutDisposers = [];
        
        // DOM references
        this.tabsContainer = null;
        this.contentArea = null;
        
        this.init();
        this.registerContainerEventHandlers();

        this.notesController.initialize();
        this.workspaceNotesController.initialize();

        try {
            this._linksPrefUnsub = appStore.subscribe('preferences.links', (newPrefs, prevPrefs) => {
                this.onLinksPreferencesChanged(newPrefs || {}, prevPrefs || {});
            });
        } catch (e) {
            console.warn('[TabManager] Failed to subscribe to links preferences changes:', e);
        }
    }
    
    init() {
        this.tabsContainer = document.getElementById('terminal-tabs');
        this.contentArea = document.getElementById('terminal-content-area');
        // Initialize TabsController (no dynamic import to avoid await in non-async context)
        try { this.controller = new TabsController(this); this.controller.init(); } catch (_) {}
        // Expose iconUtils so TabsController can render icon-only titles without a second import
        this.iconUtils = iconUtils;
        
        if (!this.tabsContainer || !this.contentArea) {
            console.error('Tab manager: Required DOM elements not found');
            return;
        }
        
        // Ensure a wrapper bar exists to host the non-scrolling + button
        try { this.ensureTabsBar(); } catch (_) {}

        // Load any persisted active-tab mapping
        this.loadSavedActiveTabs();

        // Setup event listeners
        this.setupEventListeners();
        
        // Setup keyboard shortcuts
        this.setupKeyboardShortcuts();
        
        // Removed global iframe focus blocking to allow interaction inside link tabs (Issue #661)

        // Listen for session changes
        this.eventBus.on('session-changed', (data) => {
            this.switchToSession(data.sessionId, data.sessionData);
        });

        // Workspace changes: ensure a workspace notes tab is available (when enabled)
        this.eventBus.on('workspace-changed', (payload) => {
            try {
                const ws = (payload && payload.workspace) ? String(payload.workspace) : null;
                if (!ws) return;
                // Only create/ensure when feature+preference enable it
                if (this.workspaceNotesController?.isEnabled?.() === true) {
                    const tab = this.workspaceNotesController.ensureTab(ws, null);
                    if (tab) {
                        this.globalTabs.set('workspace-note', tab);
                    }
                }
                // Force session tabs refresh so the Notes pseudo-tab appears even with 0 sessions
                try { getContext()?.app?.modules?.terminal?.sessionTabsManager?.refresh?.(); } catch (_) {}
                // If notes tab is active, ensure only the current workspace notes view is visible
                if (this.activeTabId === 'workspace-note') {
                    this.updateActiveTabDisplay();
                }
            } catch (e) {
                console.warn('[TabManager] Failed to handle workspace-changed:', e);
            }
        });
        
        // Listen for new links being added to any session
        this.eventBus.on('links-added', (data) => {
            console.log(`[TabManager] Received links-added event for session ${data.sessionId}`);
            if (data?.sessionId) {
                const cachedLinks = Array.isArray(data.links) ? data.links.filter(Boolean).map(link => ({ ...link })) : [];
                this.sessionLinkCache.set(data.sessionId, cachedLinks);
            }
            if (this.currentSessionId === data.sessionId) {
                console.log(`[TabManager] Creating tabs for new links in current session`);
                this.createTabsForSessionLinks(data.links, true);
            } else {
                console.log(`[TabManager] Links added to non-current session ${data.sessionId} - tabs will be created when switching to that session`);
            }
        });
        
        // Listen for session clear events from TerminalManager
        this.eventBus.on('tab-clear-session', () => {
            try {
                this.clearSession();
            } catch (e) {
                console.warn('[TabManager] Failed to clear session on event:', e);
            }
        });

        // Open workspace notes when requested from session tabs bar
        this.eventBus.on('workspace-open-notes', (payload) => {
            try {
                const ws = (payload && payload.workspace) ? String(payload.workspace) : null;
                if (!ws) return;
                if (this.workspaceNotesController?.isEnabled?.() !== true) return;
                // Ensure the workspace notes tab content exists (global scope when no session)
                const tab = this.workspaceNotesController.ensureTab(ws, null) || this.globalTabs.get('workspace-note');
                if (tab) this.globalTabs.set('workspace-note', tab);
                // Switch to the workspace notes content tab
                this.switchToTab('workspace-note');
                // Force-hide any session note content views to prevent visual mixups
                try {
                    const views = this.contentArea.querySelectorAll('.terminal-content-view');
                    views.forEach((v) => {
                        const id = v?.dataset?.tabId || '';
                        if (id === 'note') {
                            v.style.display = 'none';
                            v.classList.remove('active');
                        }
                    });
                } catch (_) {}
                // Clear session selection highlight in the sidebar and mark notes as selected
                try {
                    const app = getContext()?.app;
                    app?.modules?.terminal?.sessionList?.setActiveSession?.(null);
                    app?.modules?.terminal?.workspaceListComponent?.markNotesSelected?.(ws);
                    app?.modules?.terminal?.sessionTabsManager?.setActiveSession?.(':workspace-notes');
                } catch (_) {}
            } catch (e) {
                console.warn('[TabManager] Failed to open workspace notes:', e);
            }
        });
        
        // Listen for link updates (renames) from server
        this.eventBus.on('link-updated', (data) => {
            console.log(`[TabManager] Received link-updated event for session ${data.sessionId}`);
            if (data?.sessionId && data?.url) {
                const cached = this.sessionLinkCache.get(data.sessionId) || [];
                const next = cached.map((link) => {
                    if (link?.url === data.url) {
                        return { ...link, name: data.name ?? link.name };
                    }
                    return link;
                });
                this.sessionLinkCache.set(data.sessionId, next);
            }
            if (this.currentSessionId === data.sessionId) {
                // Find the tab with the matching URL and update its title
                const sessionTabs = this.sessionTabs.get(this.currentSessionId);
                if (sessionTabs) {
                    sessionTabs.forEach((tab) => {
                        if (tab.url === data.url) {
                            console.log(`[TabManager] Updating tab title from "${tab.title}" to "${data.name}"`);
                            tab.title = data.name;
                            
                            // Update the tab button in the DOM
                            const tabButton = this.tabsContainer.querySelector(`[data-tab-id="${tab.id}"]`);
                            if (tabButton) {
                                const titleElement = tabButton.querySelector('.terminal-tab-title');
                                if (titleElement) {
                                    titleElement.textContent = data.name;
                                }
                            }
                        }
                    });
                }
            }
        });
        
        // Update link refresh flag when provided in update events
        this.eventBus.on('link-updated', (data) => {
            try {
                if (!data || !data.sessionId || !data.url || !Object.prototype.hasOwnProperty.call(data, 'refresh_on_view')) return;
                const cached = this.sessionLinkCache.get(data.sessionId) || [];
                const next = cached.map((link) => link && link.url === data.url ? { ...link, refresh_on_view: !!data.refresh_on_view } : link);
                this.sessionLinkCache.set(data.sessionId, next);
                if (this.currentSessionId === data.sessionId) {
                    const sessionTabs = this.sessionTabs.get(this.currentSessionId);
                    if (sessionTabs) {
                        sessionTabs.forEach((tab) => {
                            if (tab.url === data.url) {
                                tab.refreshOnView = !!data.refresh_on_view;
                                try {
                                    const view = tab.element || this.contentArea.querySelector(`.terminal-content-view[data-tab-id="${tab.id}"]`);
                                    const cb = view ? view.querySelector('.url-refresh-checkbox') : null;
                                    if (cb) cb.checked = !!data.refresh_on_view;
                                } catch (_) {}
                            }
                        });
                    }
                }
            } catch (_) {}
        });
        
        // Listen for link removals from server
        this.eventBus.on('link-removed', (data) => {
            console.log(`[TabManager] Received link-removed event for session ${data.sessionId}`);
            if (data?.sessionId && data?.url) {
                const cached = this.sessionLinkCache.get(data.sessionId) || [];
                const filtered = cached.filter(link => link?.url !== data.url);
                this.sessionLinkCache.set(data.sessionId, filtered);
            }
            if (this.currentSessionId === data.sessionId) {
                // Find and close the tab with the matching URL
                const sessionTabs = this.sessionTabs.get(this.currentSessionId);
                if (sessionTabs) {
                    sessionTabs.forEach((tab, tabId) => {
                        if (tab.url === data.url) {
                            console.log(`[TabManager] Removing tab for URL: ${data.url}`);
                            this.closeTab(tabId);
                        }
                    });
                }
            }
        });

        this.eventBus.on('session:terminated', (payload) => {
            try {
                const sid = payload?.sessionData?.session_id || payload?.sessionId;
                if (!sid) return;
                this.notesController.handleSessionTerminated(sid);
                // For command-tab children, clear stale mapping and keep tab content
                try {
                    const mapping = this.containerTabLookup.get(sid);
                    if (mapping && mapping.tabId) {
                        const tabs = this.sessionTabs.get(mapping.parentId);
                        const tab = tabs ? tabs.get(mapping.tabId) : null;
                        if (tab && tab.type === 'command' && tab.childSessionId === sid) {
                            tab.childSessionId = null;
                        }
                        this.containerTabLookup.delete(sid);
                    }
                } catch (_) {}
                // If a session just terminated, refresh the tab display so the
                // terminal tabs bar can hide when no active sessions remain.
                try { this.updateActiveTabDisplay(); } catch (_) {}
            } catch (e) {
                console.warn('[TabManager] Failed to handle session terminated:', e);
            }
        });
    }
    loadSavedActiveTabs() {
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const st = res && res.ok ? (res.state || {}) : {};
            const saved = st['terminal_saved_tab_by_session'];
            if (saved && typeof saved === 'object') {
                Object.entries(saved).forEach(([sid, tabId]) => {
                    if (typeof sid === 'string' && typeof tabId === 'string') {
                        this.sessionActiveTab.set(sid, tabId);
                    }
                });
                this._debug.log('loaded saved tab mapping', Object.keys(saved).length);
            }
        } catch (e) {
            this._debug.warn('loadSavedActiveTabs failed', e);
        }
    }

    // Resolve a template badge label using TerminalManager's available templates
    getTemplateBadgeLabel(templateName) {
        if (!templateName) return null;
        try {
            const mgr = this.getTerminalManager();
            const templates = mgr?.formManager?.availableTemplates;
            if (Array.isArray(templates)) {
                const tpl = templates.find(t => t && t.name === templateName);
                const label = tpl && typeof tpl.badge_label === 'string' && tpl.badge_label.trim()
                    ? tpl.badge_label.trim()
                    : null;
                return label;
            }
        } catch (_) {}
        return null;
    }

    persistActiveTabs() {
        try {
            const obj = {};
            this.sessionActiveTab.forEach((tabId, sid) => { obj[String(sid)] = String(tabId); });
            queueStateSet('terminal_saved_tab_by_session', obj, 300);
        } catch (e) {
            // non-fatal
        }
    }

    registerContainerEventHandlers() {
        if (!this.eventBus) {
            return;
        }

        this.eventBus.on('container-session:reset', () => {
            this.resetContainerTabs();
        });

        this.eventBus.on('container-session:added', ({ parentId, sessionData }) => {
            this.ensureContainerTab(parentId, sessionData);
            this.refreshContainerTabTitles(parentId);
            if (this.currentSessionId === parentId) {
                this.refreshActiveSessionTabs();
            }
        });

        this.eventBus.on('container-session:updated', ({ parentId, sessionData }) => {
            this.ensureContainerTab(parentId, sessionData);
            this.refreshContainerTabTitles(parentId);
            if (this.currentSessionId === parentId) {
                this.refreshActiveSessionTabs();
            }
        });

        this.eventBus.on('container-session:removed', ({ parentId, sessionId }) => {
            this.removeContainerTab(sessionId);
            if (this.currentSessionId === parentId) {
                this.refreshActiveSessionTabs();
            }
        });

        this.eventBus.on('container-session:activate', ({ parentId, sessionId }) => {
            this.activateContainerTab(parentId, sessionId);
        });

        this.eventBus.on('container-session:refresh', ({ parentId }) => {
            this.refreshContainerTabTitles(parentId);
            if (this.currentSessionId === parentId) {
                this.refreshActiveSessionTabs();
            }
        });
    }

    getTerminalManager() {
        try {
            return getContext()?.app?.modules?.terminal || null;
        } catch (_) {
            return null;
        }
    }

    getChildSessionsInOrder(parentId) {
        const mgr = this.getTerminalManager();
        if (!mgr || typeof mgr.getChildSessions !== 'function') {
            return [];
        }
        try {
            const sessions = mgr.getChildSessions(parentId, { respectSidebarPreference: false });
            return Array.isArray(sessions) ? sessions : [];
        } catch (_) {
            return [];
        }
    }

    getChildSessionData(parentId, childId) {
        const sessions = this.getChildSessionsInOrder(parentId);
        return sessions.find(session => session?.session_id === childId) || null;
    }

    // Map a child session id to a specific tab id for attach target resolution
    mapChildToTab(parentId, childId, tabId) {
        if (!childId || !tabId) return;
        this.containerTabLookup.set(String(childId), { parentId: String(parentId || this.currentSessionId || ''), tabId: String(tabId) });
    }

    computeContainerTabTitle(parentId, sessionData) {
        const sessions = this.getChildSessionsInOrder(parentId);
        const index = sessions.findIndex(s => s?.session_id === sessionData.session_id);
        if (index === -1) {
            return 'Shell';
        }
        return sessions.length > 1 ? `Shell ${index + 1}` : 'Shell';
    }

    createContainerContentView(parentId, childId) {
        const tabId = `container-${childId}`;
        const existing = this.contentArea.querySelector(`.terminal-content-view[data-tab-id="${tabId}"]`);
        if (existing) {
            existing.dataset.sessionId = parentId;
            existing.dataset.childSessionId = childId;
            return existing;
        }
        const view = document.createElement('div');
        view.className = 'terminal-content-view container-terminal-view';
        view.dataset.tabId = tabId;
        view.dataset.sessionId = parentId;
        view.dataset.childSessionId = childId;
        view.style.display = 'none';
        this.contentArea.appendChild(view);
        return view;
    }

    createCommandContentView(parentId, tabId) {
        const existing = this.contentArea.querySelector(`.terminal-content-view[data-tab-id="${tabId}"]`);
        if (existing) {
            existing.dataset.sessionId = parentId;
            return existing;
        }
        const view = document.createElement('div');
        view.className = 'terminal-content-view command-terminal-view';
        view.dataset.tabId = tabId;
        view.dataset.sessionId = parentId;
        view.style.display = 'none';
        this.contentArea.appendChild(view);
        return view;
    }

    ensureContainerTab(parentId, sessionData) {
        if (!sessionData || !sessionData.session_id) {
            return null;
        }
        const tabId = `container-${sessionData.session_id}`;
        let tabs = this.sessionTabs.get(parentId);
        if (!tabs) {
            tabs = new Map();
            this.sessionTabs.set(parentId, tabs);
            this.initializeTerminalTabForSession(parentId);
        }

        let tab = tabs.get(tabId);
        const title = this.computeContainerTabTitle(parentId, sessionData);
        const tooltip = sessionData.container_name || sessionData.title || title;

        if (!tab) {
            const element = this.createContainerContentView(parentId, sessionData.session_id);
            tab = {
                id: tabId,
                title,
                tooltip,
                type: 'container',
                sessionId: parentId,
                childSessionId: sessionData.session_id,
                element,
                closeable: false
            };
            tabs.set(tabId, tab);
        } else {
            tab.title = title;
            tab.tooltip = tooltip;
            tab.childSessionId = sessionData.session_id;
            if (tab.element) {
                tab.element.dataset.childSessionId = sessionData.session_id;
                tab.element.dataset.sessionId = parentId;
            } else {
                tab.element = this.createContainerContentView(parentId, sessionData.session_id);
            }
        }

        this.containerTabLookup.set(sessionData.session_id, { parentId, tabId });

        if (this.currentSessionId === parentId) {
            this.updateContainerTabTitle(tabId, title, tooltip);
        }

        return tab;
    }

    updateContainerTabTitle(tabId, title, tooltip) {
        if (this.controller && typeof this.controller.updateTitle === 'function') {
            this.controller.updateTitle(tabId, title);
        } else {
            const titleEl = this.tabsContainer.querySelector(`.terminal-tab[data-tab-id="${tabId}"] .terminal-tab-title`);
            if (titleEl) {
                titleEl.textContent = title;
            }
        }
        const tabButton = this.tabsContainer.querySelector(`.terminal-tab[data-tab-id="${tabId}"]`);
        if (tabButton) {
            tabButton.title = tooltip || title;
        }
    }

    refreshContainerTabTitles(parentId) {
        const sessions = this.getChildSessionsInOrder(parentId);
        sessions.forEach((session, index) => {
            if (!session || !session.session_id) return;
            const mapping = this.containerTabLookup.get(session.session_id);
            if (!mapping) return;
            const tabs = this.sessionTabs.get(parentId);
            const tab = tabs ? tabs.get(mapping.tabId) : null;
            if (!tab) return;
            const title = sessions.length > 1 ? `Shell ${index + 1}` : 'Shell';
            const tooltip = session.container_name || session.title || title;
            tab.title = title;
            tab.tooltip = tooltip;
            this.updateContainerTabTitle(mapping.tabId, title, tooltip);
        });
    }

    removeContainerTab(childId) {
        const mapping = this.containerTabLookup.get(childId);
        if (!mapping) {
            return;
        }
        const { parentId, tabId } = mapping;
        const tabs = this.sessionTabs.get(parentId);
        const tab = tabs ? tabs.get(tabId) : null;

        // If the mapping points to a command tab, keep the tab open and only clear child mapping
        if (tab && tab.type === 'command') {
            try { tab.childSessionId = null; } catch (_) {}
            try {
                const btn = this.tabsContainer.querySelector(`.terminal-tab[data-tab-id="${tabId}"]`);
                if (btn) btn.removeAttribute('data-child-session-id');
            } catch (_) {}
            this.containerTabLookup.delete(childId);
            return;
        }
        if (tab && tab.element && tab.element.remove) {
            tab.element.remove();
        }
        const button = this.tabsContainer.querySelector(`.terminal-tab[data-tab-id="${tabId}"]`);
        if (button) {
            button.remove();
        }

        if (tabs) {
            tabs.delete(tabId);
        }

        this.containerTabLookup.delete(childId);

        if (this.activeTabId === tabId) {
            this.activeTabId = 'terminal';
        }

        // If saved active tab for parent pointed at this container, fall back to terminal and persist
        if (this.sessionActiveTab.get(parentId) === tabId) {
            this.sessionActiveTab.set(parentId, 'terminal');
            this.persistActiveTabs?.();
        }
    }

    resetContainerTabs() {
        const childIds = Array.from(this.containerTabLookup.keys());
        childIds.forEach(childId => this.removeContainerTab(childId));
        if (this.currentSessionId) {
            this.refreshActiveSessionTabs();
        }
    }

    refreshActiveSessionTabs() {
        if (!this.currentSessionId) {
            return;
        }
        this.hideAllTabs();
        this.showTabsForSession(this.currentSessionId);
        this.updateActiveTabDisplay();
        this.activateSavedTabForSession(this.currentSessionId, { forceSwitch: true });
    }

    activateSavedTabForSession(sessionId, options = {}) {
        if (!sessionId) return null;
        const preferredTabId = this.sessionActiveTab.get(sessionId);
        if (!preferredTabId) return null;
        const sessionTabs = this.sessionTabs.get(sessionId);
        if (!sessionTabs || !sessionTabs.has(preferredTabId)) {
            this._debug?.log?.('activateSavedTabForSession missing tab', { sessionId, preferredTabId, hasTabs: !!sessionTabs });
            return null;
        }
        const tab = sessionTabs.get(preferredTabId);
        if (this.currentSessionId === sessionId) {
            if (this.activeTabId !== preferredTabId || options.forceSwitch) {
                try { console.log(`[TabManager] restoring saved tab ${preferredTabId} for session ${sessionId}`); } catch (_) {}
                this.switchToTab(preferredTabId);
            }
        }
        return tab;
    }

    getSavedTabId(sessionId) {
        return this.sessionActiveTab.get(sessionId) || null;
    }

    getContainerViewElement(parentId, childId) {
        const mapping = this.containerTabLookup.get(childId);
        if (!mapping) {
            const sessionData = this.getChildSessionData(parentId, childId);
            if (sessionData) {
                const tab = this.ensureContainerTab(parentId, sessionData);
                return tab?.element || null;
            }
            return null;
        }
        const tabs = this.sessionTabs.get(parentId);
        const tab = tabs ? tabs.get(mapping.tabId) : null;
        if (tab && tab.element) {
            // Ensure command tabs remember their child mapping
            if (tab.type === 'command') {
                tab.childSessionId = childId;
                try { tab.element.dataset.childSessionId = childId; } catch (_) {}
            }
            return tab.element;
        }
        if (tab && tab.type === 'command') {
            const el = this.createCommandContentView(parentId, mapping.tabId);
            const tabsMap = this.sessionTabs.get(parentId);
            const t = tabsMap ? tabsMap.get(mapping.tabId) : null;
            if (t) {
                t.element = el;
                t.childSessionId = childId;
                try { el.dataset.childSessionId = childId; } catch (_) {}
            }
            return el;
        }
        return this.createContainerContentView(parentId, childId);
    }

    activateContainerTab(parentId, childId) {
        const mapping = this.containerTabLookup.get(childId);
        if (!mapping) {
            return;
        }
        if (this.currentSessionId !== parentId) {
            return;
        }
        this.switchToTab(mapping.tabId);
    }

    reorderActiveTab(direction) {
        const tab = this.getCurrentSessionTab(this.activeTabId);
        if (!tab) {
            return;
        }
        if (tab.id === 'terminal') {
            return;
        }

        if (tab.type === 'container' && tab.childSessionId) {
            const mgr = this.getTerminalManager();
            if (mgr && typeof mgr.reorderChildSession === 'function') {
                mgr.reorderChildSession(this.currentSessionId, tab.childSessionId, direction);
            }
            return;
        }

        const tabs = this.sessionTabs.get(this.currentSessionId);
        if (!tabs) {
            return;
        }

        const originalTabs = tabs;
        const groupCondition = (candidate) => {
            if (!candidate) return false;
            if (candidate.id === 'terminal') return false;
            if (candidate.type === 'container') return false;
            return true;
        };

        const ids = Array.from(originalTabs.keys());
        const groupIds = ids.filter((id) => groupCondition(originalTabs.get(id)));
        if (groupIds.length <= 1) {
            return;
        }

        const currentIndex = groupIds.indexOf(tab.id);
        if (currentIndex === -1) {
            return;
        }

        const delta = direction === 'left' ? -1 : 1;
        const targetIndex = currentIndex + delta;
        if (targetIndex < 0 || targetIndex >= groupIds.length) {
            return;
        }

        groupIds.splice(currentIndex, 1);
        groupIds.splice(targetIndex, 0, tab.id);

        const newTabs = new Map();
        let groupInserted = false;
        ids.forEach((id) => {
            const value = originalTabs.get(id);
            if (!groupCondition(value)) {
                newTabs.set(id, value);
                return;
            }
            if (groupInserted) {
                return;
            }
            groupIds.forEach((groupId) => {
                const groupTab = originalTabs.get(groupId);
                if (groupTab) {
                    newTabs.set(groupId, groupTab);
                }
            });
            groupInserted = true;
        });

        this.sessionTabs.set(this.currentSessionId, newTabs);
        this.sessionActiveTab.set(this.currentSessionId, tab.id);
        this.refreshActiveSessionTabs();
    }

    /**
     * Toggle a loading indicator on a tab button
     * @param {string} tabId - The tab id (e.g., 'terminal' or 'url-1')
     * @param {boolean} isLoading - Whether to show loading state
     */
    setTabLoading(tabId, isLoading) {
        try {
            if (!this.tabsContainer) return;
            const btn = this.tabsContainer.querySelector(`.terminal-tab[data-tab-id="${tabId}"]`);
            if (btn) {
                if (isLoading) {
                    btn.classList.add('loading');
                } else {
                    btn.classList.remove('loading');
                }
            }
        } catch (_) {
            // non-fatal
        }
    }

    ensureTabsBar() {
        const tabs = this.tabsContainer;
        if (!tabs) return null;
        const currentParent = tabs.parentElement;
        if (currentParent && currentParent.classList && currentParent.classList.contains('terminal-tabs-bar')) {
            return currentParent;
        }
        const bar = document.createElement('div');
        bar.className = 'terminal-tabs-bar';
        // Insert bar before tabs and move tabs inside
        if (currentParent) {
            currentParent.insertBefore(bar, tabs);
        }
        bar.appendChild(tabs);
        return bar;
    }
    
    setupEventListeners() {
        // Tab click handling
        this.tabsContainer.addEventListener('click', (e) => {
            try {
                const isAnyModalOpen = (() => {
                    try { return !!document.querySelector('.modal.show, .floating-modal.show'); } catch (_) { return false; }
                })();
                if (isAnyModalOpen) return; // Ignore clicks while a modal is open
            } catch (_) {}
            const tabButton = e.target.closest('.terminal-tab');
            const closeButton = e.target.closest('.terminal-tab-close');
            const refreshButton = e.target.closest('.terminal-tab-refresh');
            const addButton = e.target.closest('.terminal-tab-add');
            
            if (closeButton) {
                e.stopPropagation();
                const tabId = tabButton.dataset.tabId;
                this.closeTab(tabId);
            } else if (refreshButton) {
                e.stopPropagation();
                const tabId = tabButton.dataset.tabId;
                this.refreshTab(tabId);
            } else if (addButton) {
                e.stopPropagation();
                this.createNewLinkTab();
            } else if (tabButton) {
                const tabId = tabButton.dataset.tabId;
                this.switchToTab(tabId);
            }
        });
    }
    
    switchToSession(sessionId, sessionData = null) {
        if (this.currentSessionId === sessionId) {
            if (this.activeTabId === 'workspace-note') {
                const fallbackTab = this.sessionActiveTab.get(sessionId) || 'terminal';
                const targetTab = fallbackTab === 'workspace-note' ? 'terminal' : fallbackTab;
                const sessionTabs = this.sessionTabs.get(sessionId);
                if (sessionTabs && sessionTabs.has(targetTab)) {
                    this.switchToTab(targetTab);
                } else if (sessionTabs && sessionTabs.has('terminal')) {
                    this.switchToTab('terminal');
                }
            }
            return; // Already on this session
        }
        
        console.log('Switching to session:', sessionId);
        this.currentSessionId = sessionId;

        // Show the tabs container
        this.tabsContainer.style.display = '';
        
        // Hide all current tabs and content
        this.hideAllTabs();
        
        // Ensure this session has a tabs map and create tabs if new session
        const isNewSession = !this.sessionTabs.has(sessionId);
        this._debug?.log?.('switchToSession start', {
            sessionId,
            isNewSession,
            saved: this.sessionActiveTab.get(sessionId) || null,
            tabsKnown: this.sessionTabs.has(sessionId)
        });
        if (isNewSession) {
            this.sessionTabs.set(sessionId, new Map());
        }

        this.initializeTerminalTabForSession(sessionId, sessionData);
        this.ensureWorkspaceTabForSession(sessionId, sessionData);

        if (sessionData && Array.isArray(sessionData.links)) {
            const cachedLinks = sessionData.links.filter(Boolean).map(link => ({ ...link }));
            this.sessionLinkCache.set(sessionId, cachedLinks);
        } else if (sessionData) {
            this.sessionLinkCache.set(sessionId, []);
        }

        if (sessionData) {
            this.notesController.syncStateFromSession(sessionId, sessionData);
        } else {
            this.notesController.ensureState(sessionId);
        }

        if (this.notesController.isEnabled()) {
            this.notesController.ensureTab(sessionId);
        } else {
            this.notesController.removeTab(sessionId);
        }

        // Ensure workspace notes tab (if a workspace is selected)
        try {
            const ws = getContext()?.app?.modules?.terminal?.currentWorkspace || null;
            if (ws) {
                this.workspaceNotesController.ensureTabIfEnabled(ws, sessionId);
            }
        } catch (_) {}

        // Always check for session links and create tabs for them (new or existing session)
        if (sessionData && sessionData.links && sessionData.links.length > 0) {
            console.log(`[TabManager] Creating tabs for ${sessionData.links.length} session links`);
            this.createTabsForSessionLinks(sessionData.links);
        }
        // Create command tabs from template (container-only; actual exec deferred until activation)
        // Only create on first encounter of this session to avoid duplicates when switching back
        try {
            const ctabs = Array.isArray(sessionData?.command_tabs) ? sessionData.command_tabs : [];
            if (isNewSession && ctabs.length > 0) {
                this.createTabsForCommandTabs(ctabs);
            }
        } catch (_) {}
        
        // Show tabs for this session (creates DOM elements only)
        this.showTabsForSession(sessionId, isNewSession);
        
        // Restore the last active tab for this session, or default to terminal
        const sessionTabs = this.sessionTabs.get(sessionId);
        const restored = this.activateSavedTabForSession(sessionId, { forceSwitch: true });
        this._debug?.log?.('switchToSession restoreResult', { sessionId, restored: !!restored, tabId: restored?.id || null });

        if (!restored) {
            // No saved tab or it was invalid; default to terminal and persist mapping
            const preferredTabId = this.sessionActiveTab.get(sessionId) || null;
            if (!preferredTabId || !sessionTabs || !sessionTabs.has(preferredTabId)) {
                this.sessionActiveTab.set(sessionId, 'terminal');
                this.persistActiveTabs?.();
            }
            this.activeTabId = 'terminal';
            this.updateActiveTabDisplay();
        }

        if (this.notesController.isEnabled()) {
            this.notesController.refreshUI(sessionId, { overrideEditor: true });
            this.notesController.updateStatus(sessionId);
        }
    }
    
    initializeTerminalTabForSession(sessionId, sessionData = null) {
        const sessionTabs = this.sessionTabs.get(sessionId);
        // Ensure template badge label is present by resolving from available templates when missing
        const sdata = { ...(sessionData || {}) };
        if (!sdata.template_badge_label && sdata.template_name) {
            const lbl = this.getTemplateBadgeLabel(sdata.template_name);
            if (lbl) sdata.template_badge_label = lbl;
        }
        // Terminal tab title must NOT use the session title or dynamic title.
        // It should only reflect the template label (badge) or template name.
        // Example: Claude Web template should show "Claude", not the full session title (Issue #914).
        let terminalTitle = 'Command';
        const isLocalOnly = !!(sdata && sdata.local_only === true);
        if (isLocalOnly) {
            terminalTitle = 'Terminal';
        } else {
            try {
                const lbl = (sdata && typeof sdata.template_badge_label === 'string' && sdata.template_badge_label.trim())
                    ? sdata.template_badge_label.trim()
                    : '';
                if (lbl) {
                    terminalTitle = lbl;
                } else if (sdata && typeof sdata.template_name === 'string' && sdata.template_name) {
                    terminalTitle = sdata.template_name;
                }
            } catch (_) {}
        }
        
        sessionTabs.set('terminal', {
            id: 'terminal',
            title: terminalTitle,
            type: 'terminal',
            sessionId: sessionId,
            element: document.getElementById('terminal-view'),
            closeable: false,
            localOnly: isLocalOnly
        });
    }

    ensureWorkspaceTabForSession(sessionId, sessionData = null) {
        const tabs = this.sessionTabs.get(sessionId);
        if (!tabs) return;
        if (tabs.has('workspace')) return;

        const data = sessionData || {};
        const enabled = data.workspace_service_enabled_for_session === true;
        const availableFlag = Object.prototype.hasOwnProperty.call(data, 'workspace_service_available')
            ? (data.workspace_service_available === true)
            : true;

        if (!enabled) return;
        if (!availableFlag) return;

        const view = document.createElement('div');
        view.className = 'terminal-content-view workspace-files-view';
        view.dataset.sessionId = sessionId;
        view.dataset.tabId = 'workspace';
        this.contentArea.appendChild(view);

        const workspaceView = new WorkspaceFilesView({
            sessionId,
            rootElement: view
        });
        workspaceView.init();

        tabs.set('workspace', {
            id: 'workspace',
            title: 'Files',
            type: 'workspace',
            sessionId,
            element: view,
            closeable: false,
            preCreated: true,
            workspaceView,
            cleanup: () => {
                try { workspaceView.destroy(); } catch (_) {}
            }
        });
    }

    onLinksPreferencesChanged(newPrefs, prevPrefs) {
        const prevShow = prevPrefs && Object.prototype.hasOwnProperty.call(prevPrefs, 'showSessionTabs')
            ? prevPrefs.showSessionTabs !== false
            : true;
        const nextShow = Object.prototype.hasOwnProperty.call(newPrefs, 'showSessionTabs')
            ? newPrefs.showSessionTabs !== false
            : true;

        if (!nextShow && prevShow) {
            this.removeAllPreCreatedTabs();
        } else if (nextShow && !prevShow) {
            this.restorePreCreatedTabs();
        }
    }

    removeAllPreCreatedTabs() {
        this.sessionTabs.forEach((tabs, sessionId) => {
            const toRemove = [];
            tabs.forEach((tab, tabId) => {
                if (tab && tab.preCreated) {
                    toRemove.push({ tabId, tab, sessionId });
                }
            });
            toRemove.forEach(({ tabId, tab }) => {
                if (tab?.element && tab.element.remove) {
                    try { tab.element.remove(); } catch (_) {}
                }
                tabs.delete(tabId);
                if (this.sessionActiveTab.get(sessionId) === tabId) {
                    this.sessionActiveTab.set(sessionId, 'terminal');
                }
                if (sessionId === this.currentSessionId) {
                    if (this.activeTabId === tabId) {
                        this.activeTabId = 'terminal';
                    }
                    const btn = this.tabsContainer?.querySelector(`[data-tab-id="${tabId}"]`);
                    if (btn) {
                        try { btn.remove(); } catch (_) {}
                    }
                }
            });
        });

        if (this.currentSessionId) {
            this.hideAllTabs();
            this.showTabsForSession(this.currentSessionId);
        }
    }

    restorePreCreatedTabs() {
        const sessionId = this.currentSessionId;
        if (!sessionId) {
            return;
        }
        const cached = this.sessionLinkCache.get(sessionId);
        if (Array.isArray(cached) && cached.length > 0) {
            this.createTabsForSessionLinks(cached);
        }
        this.hideAllTabs();
        this.showTabsForSession(sessionId);

        // Restore preferred tab for this session if available
        try {
            const restored = this.activateSavedTabForSession(sessionId, { forceSwitch: true });
            this._debug?.log?.('switchToSession restore', { sessionId, restored: !!restored, active: this.activeTabId });
            if (!restored) {
                this.switchToTab('terminal');
            }
        } catch (e) { this._debug?.warn?.('switchToSession restore failed', e); }
    }

    createTabsForSessionLinks(links, createDOMElements = false) {
        console.log(`[TabManager] createTabsForSessionLinks called with ${links?.length || 0} links, createDOMElements=${createDOMElements}`);

        if (!links || !Array.isArray(links)) {
            console.log(`[TabManager] No valid links provided`);
            return;
        }

        if (!this.currentSessionId) {
            console.log('[TabManager] No active session for session links');
            return;
        }

        const normalizedLinks = links.filter(Boolean).map((link) => ({ ...link }));
        this.sessionLinkCache.set(this.currentSessionId, normalizedLinks);

        const showTabsPref = appStore.getState('preferences.links.showSessionTabs');
        if (showTabsPref === false) {
            console.log('[TabManager] Session link tabs disabled via preferences; skipping tab creation');
            return;
        }

        const sessionTabs = this.sessionTabs.get(this.currentSessionId);
        if (!sessionTabs) {
            console.log(`[TabManager] No session tabs found for currentSessionId=${this.currentSessionId}`);
            return;
        }

        console.log(`[TabManager] Processing ${normalizedLinks.length} links for session ${this.currentSessionId}`);

        normalizedLinks.forEach((link, index) => {
            const rawUrl = typeof link.url === 'string' ? link.url.trim() : '';
            const isTemplateLink = link.is_template_link === true;
            const hasPreViewCommand = link.has_pre_view_command === true
                || (typeof link.pre_view_command === 'string' && link.pre_view_command.trim());
            const templateLinkId = (function resolveTemplateLinkId(l) {
                try {
                    const id = typeof l.link_id === 'string' ? l.link_id.trim() : '';
                    return id || null;
                } catch (_) {
                    return null;
                }
            })(link);
            const hasUsableUrl = !!rawUrl || (isTemplateLink && hasPreViewCommand);

            console.log(`[TabManager] Processing link ${index}: ${rawUrl || '(no url)'} (template=${isTemplateLink}, has_pre_view_command=${hasPreViewCommand})`);

            if (!hasUsableUrl) {
                console.log(`[TabManager] Skipping link ${index} - no usable URL`);
                return;
            }

            // Check if we already have a tab for this link to avoid duplicates
            const existingTab = Array.from(sessionTabs.values()).find((tab) => {
                if (!tab || tab.type !== 'url') return false;
                if (rawUrl && tab.url === rawUrl) return true;
                if (!rawUrl && isTemplateLink && hasPreViewCommand && tab.isTemplateLink === true && tab.hasPreViewCommand === true) {
                    const tabLinkId = (function resolveTabLinkId(t) {
                        try {
                            const id = typeof t.templateLinkId === 'string' ? t.templateLinkId.trim() : '';
                            return id || null;
                        } catch (_) {
                            return null;
                        }
                    })(tab);
                    if (templateLinkId && tabLinkId && tabLinkId === templateLinkId) {
                        return true;
                    }
                    if (!templateLinkId && !tabLinkId) {
                        const tabIdx = Number.isFinite(Number(tab.linkIndex)) ? Math.floor(Number(tab.linkIndex)) : null;
                        if (tabIdx != null && tabIdx === index) {
                            return true;
                        }
                    }
                }
                return false;
            });
            if (existingTab) {
                console.log(`[TabManager] Tab already exists for link index ${index}`);
                return;
            }

            // Check if link should be shown
            const shouldShow = this.shouldShowLink(link);
            if (!shouldShow) {
                console.log(`[TabManager] Link ${rawUrl || '(no url)'} should not be shown`);
                return;
            }

            console.log(`[TabManager] Creating tab data for ${rawUrl || '(no url)'}`);

            const options = {
                refreshOnView: link.refresh_on_view === true,
                showUrlBar: link.show_url_bar !== false,
                passThemeColors: link.pass_theme_colors === true,
                refreshOnViewActive: link.refresh_on_view_active === true,
                refreshOnViewInactive: link.refresh_on_view_inactive === true,
                isTemplateLink,
                hasPreViewCommand,
                outputFilename: typeof link.output_filename === 'string' ? link.output_filename : null,
                linkIndex: index,
                templateLinkId
            };

            // Create pre-created tab data
            const displayTitle = link.name || rawUrl || 'Link';
            const tabId = this.createPreCreatedTabData(rawUrl, displayTitle, options);

            // If requested, also create DOM elements for active session
            if (createDOMElements && tabId) {
                const tab = sessionTabs.get(tabId);
                if (tab) {
                    console.log(`[TabManager] Creating DOM tab button for ${tabId}`);
                    if (this.controller && typeof this.controller.createButton === 'function') {
                        this.controller.createButton(tab);
                    } else {
                        this.createTabButton(tab);
                    }
                } else {
                    console.log(`[TabManager] Warning: Tab data not found for ${tabId}`);
                }
            } else {
                console.log(`[TabManager] Not creating DOM elements (createDOMElements=${createDOMElements}, tabId=${tabId})`);
            }
        });
    }

    // Build command tabs from template-provided specs
    createTabsForCommandTabs(tabs, createDOMElements = false) {
        if (!Array.isArray(tabs) || tabs.length === 0) return;
        if (!this.currentSessionId) return;
        const sessionTabs = this.sessionTabs.get(this.currentSessionId);
        if (!sessionTabs) return;
        tabs.forEach((spec, index) => {
            // Deduplicate by command (and optionally name) within the session
            const cmd = String(spec?.command || '');
            const name = String(spec?.name || 'Command');
            const exists = Array.from(sessionTabs.values()).some(t => t && t.type === 'command' && String(t.command || '') === cmd && String(t.title || '') === name);
            if (exists) return;
            const tabId = this.createPreCreatedCommandTabData(spec, index);
            if (createDOMElements && tabId) {
                const tab = sessionTabs.get(tabId);
                if (!tab) return;
                if (this.controller && typeof this.controller.createButton === 'function') {
                    this.controller.createButton(tab);
                } else {
                    this.createTabButton(tab);
                }
            }
        });
    }

    // Create a pre-created command tab (no child session yet)
    createPreCreatedCommandTabData(spec, tabIndex = null) {
        if (!this.currentSessionId) return null;
        this.tabCounter++;
        const tabId = `cmd-${this.tabCounter}`;
        const view = this.createCommandContentView(this.currentSessionId, tabId);
        const sessionTabs = this.sessionTabs.get(this.currentSessionId);
        const title = String(spec?.name || 'Command');
        sessionTabs.set(tabId, {
            id: tabId,
            title,
            tooltip: String(spec?.command || title),
            type: 'command',
            sessionId: this.currentSessionId,
            element: view,
            closeable: false,
            command: String(spec?.command || ''),
            tabIndex: Number.isInteger(tabIndex) ? tabIndex : null,
            refreshOnView: spec && spec.refresh_on_view === true,
            childSessionId: null,
            preCreated: true
        });
        return tabId;
    }
    
    shouldShowLink(link) {
        // Default behavior: show links for both active and inactive sessions
        // This matches the logic in manager.js shouldShowLink method
        const showActive = link.show_active !== false;
        const showInactive = link.show_inactive !== false;

        // For now, assume we should show the link
        // In a real implementation, you'd need session state info
        return showActive || showInactive;
    }
    
    hideAllTabs() {
        // Clear the tabs container completely
        this.tabsContainer.innerHTML = '';
        
        // Hide all content views except terminal
        this.contentArea.querySelectorAll('.terminal-content-view').forEach(view => {
            if (view.dataset.tabId !== 'terminal') {
                view.style.display = 'none';
            }
        });
        
    }
    
    showTabsForSession(sessionId, isNewSession = false) {
        const sessionTabs = this.sessionTabs.get(sessionId);
        if (!sessionTabs) return;

        // Render tabs using a canonical ordering:
        // Terminal -> Containers -> URL/Other -> Notes (always last)
        // getAllTabs() already computes this order relative to currentSessionId
        const orderedTabs = this.getAllTabs();
        orderedTabs.forEach((tab) => this.createTabButton(tab));

        // Add the + button after all tabs
        if (this.controller && typeof this.controller.createAddButton === 'function') {
            this.controller.createAddButton();
        } else {
            this.createAddTabButton();
        }

        this.updateActiveTabDisplay();
    }
    
    createTabButton(tab) {
        // Fallback path if controller is unavailable
        if (this.controller && typeof this.controller.createButton === 'function') {
            return this.controller.createButton(tab);
        }
        // Avoid duplicates: if a button for this tab id already exists, skip
        if (this.tabsContainer && tab && tab.id) {
            const existingBtn = this.tabsContainer.querySelector(`.terminal-tab[data-tab-id="${tab.id}"]`);
            if (existingBtn) {
                return existingBtn;
            }
        }
        const btn = document.createElement('button');
        btn.className = 'terminal-tab';
        if (tab?.type) {
            btn.classList.add(`terminal-tab--${tab.type}`);
        }
        btn.dataset.tabId = tab.id;
        if (tab?.childSessionId) {
            btn.dataset.childSessionId = tab.childSessionId;
        }
        if (tab?.tooltip) {
            btn.title = String(tab.tooltip);
        } else if (tab?.title) {
            btn.title = String(tab.title);
        }
        const title = document.createElement('span');
        title.className = 'terminal-tab-title';
        // For note tabs, show an icon instead of text label
        if (tab?.type === 'note' || tab?.id === 'note') {
            try {
                const icon = iconUtils.createIcon('journal-text', { size: 14, className: 'terminal-tab-title-icon' });
                title.appendChild(icon);
            } catch (_) {
                title.textContent = '';
            }
        } else {
            title.textContent = String(tab.title || '');
        }
        btn.appendChild(title);
        const refreshNeeded = (tab.type === 'url')
            || (tab.type === 'workspace')
            || (tab.type === 'terminal' && tab.localOnly !== true)
            || (tab.type === 'command');
        if (refreshNeeded) {
            const r = document.createElement('button');
            r.className = 'terminal-tab-refresh';
            r.title = (tab.type === 'url')
                ? 'Refresh'
                : (tab.type === 'workspace')
                    ? 'Refresh files'
                    : (tab.type === 'command' ? 'Run again' : 'Reload terminal');
            r.textContent = '↻';
            btn.appendChild(r);
        }
        if (tab.closeable) {
            const c = document.createElement('button');
            c.className = 'terminal-tab-close';
            c.title = 'Close tab';
            c.textContent = '×';
            btn.appendChild(c);
        }
        // Insert URL tabs before the session Notes tab when present; otherwise append
        const noteBtn = this.tabsContainer.querySelector('.terminal-tab[data-tab-id="note"]');
        if (tab.type === 'url' && noteBtn) {
            this.tabsContainer.insertBefore(btn, noteBtn);
        } else {
            this.tabsContainer.appendChild(btn);
        }
    }
    
    createAddTabButton() {
        // Remove any existing add button first from the bar wrapper
        const bar = this.ensureTabsBar();
        if (!bar) return;
        const existingAddButton = bar.querySelector('.terminal-tab-add');
        if (existingAddButton) {
            existingAddButton.remove();
        }

        if (this.controller && typeof this.controller.createAddButton === 'function') {
            this.controller.createAddButton();
            return;
        }
        const addButton = document.createElement('button');
        addButton.className = 'terminal-tab-add';
        addButton.title = 'Add new link tab';
        const t = document.createElement('span');
        t.className = 'terminal-tab-title';
        t.textContent = '+';
        addButton.appendChild(t);
        addButton.addEventListener('click', (e) => {
            e.preventDefault();
            this.createNewLinkTab();
        });
        bar.appendChild(addButton);
    }
    
    updateActiveTabDisplay() {
        // Update tab buttons
        this.tabsContainer.querySelectorAll('.terminal-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tabId === this.activeTabId);
        });
        
        // Update content views
        const currentSessionId = this.currentSessionId;
        this.contentArea.querySelectorAll('.terminal-content-view').forEach((view) => {
            const viewSessionId = view.dataset.sessionId || null;
            const belongsToCurrentSession = !viewSessionId || viewSessionId === currentSessionId;
            const isActive = belongsToCurrentSession && view.dataset.tabId === this.activeTabId;

            view.classList.toggle('active', isActive);
            if (isActive) {
                view.style.removeProperty('display');
            } else {
                view.style.display = 'none';
            }

            if (!belongsToCurrentSession) {
                view.classList.remove('active');
                view.style.display = 'none';
            }
        });

        // Hide the lower tabs bar entirely when viewing workspace-level notes,
        // or when no session is selected. Keep it visible for terminated
        // sessions so users can access Links/Notes after termination.
        try {
            const bar = this.ensureTabsBar();
            if (bar) {
                const shouldHide = (this.activeTabId === 'workspace-note') || !this.currentSessionId;
                bar.style.display = shouldHide ? 'none' : '';
                // Keep the underlying tabs container in sync
                try { this.tabsContainer.style.display = shouldHide ? 'none' : ''; } catch (_) {}
            }
        } catch (_) {}

    }
    
    createPreCreatedTabData(url, title, options = {}) {
        if (!this.currentSessionId) {
            console.warn('Cannot create pre-created tab data: no active session');
            return null;
        }

        this.tabCounter++;
        const tabId = `link-${this.tabCounter}`;
        const showUrlBar = options.showUrlBar !== false;
        const isTemplateLink = options.isTemplateLink === true;
        const hasPreViewCommand = options.hasPreViewCommand === true;
        const refreshOnViewActive = options.refreshOnViewActive === true;
        const refreshOnViewInactive = options.refreshOnViewInactive === true;

        // Create content view with placeholder and URL controls
        const contentView = document.createElement('div');
        contentView.className = 'terminal-content-view url-view';
        contentView.dataset.tabId = tabId;
        contentView.innerHTML = `
            <div class="url-controls"${showUrlBar ? '' : ' style="display:none;"'}>
                <input type="text" class="url-input" value="${escapeHtml(url)}" placeholder="Enter URL...">
                <button class="url-go-btn" title="Navigate to URL">Go</button>
                <input type="checkbox" class="url-refresh-checkbox">
            </div>
            <div class="url-loading">Click to load ${escapeHtml(title || url)}...</div>
        `;
        
        // Add content view to DOM
        this.contentArea.appendChild(contentView);
        
        // Setup URL input functionality for pre-created tab
        const urlInput = contentView.querySelector('.url-input');
        const goBtn = contentView.querySelector('.url-go-btn');
        const refreshCheckbox = contentView.querySelector('.url-refresh-checkbox');
        if (refreshCheckbox) refreshCheckbox.checked = !!options.refreshOnView;

        const navigateToUrl = () => {
            if (isTemplateLink && hasPreViewCommand) {
                // Template chat links use the generate+HTML pipeline instead of direct URL navigation
                this.prepareTemplateLinkTab(tabId, null, { reason: 'manual' });
                return;
            }
            const newUrl = urlInput.value.trim();
            if (newUrl && newUrl !== url) {
                // Load the URL for the first time or navigate to new URL
                this.loadUrlInTab(tabId, newUrl);
            } else if (newUrl === url) {
                // Load the current URL
                this.loadUrlInTab(tabId, url);
            }
        };

        goBtn.addEventListener('click', navigateToUrl);
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                navigateToUrl();
            }
        });
        
        // Get session tabs
        const sessionTabs = this.sessionTabs.get(this.currentSessionId);

        // Store tab data for this session (no DOM button yet)
        sessionTabs.set(tabId, {
            id: tabId,
            title: title || url,
            type: 'url',
            url: url,
            sessionId: this.currentSessionId,
            element: contentView,
            linkInput: urlInput,
            closeable: true,
            loaded: false,
            isLoading: false,
            preCreated: true,
            refreshOnView: !!options.refreshOnView,
            showUrlBar,
            isTemplateLink,
            hasPreViewCommand,
            refreshOnViewActive,
            refreshOnViewInactive,
            passThemeColors: options.passThemeColors === true,
            outputFilename: typeof options.outputFilename === 'string' ? options.outputFilename : null,
            templateLinkId: (function resolveTemplateLinkId(opt) {
                try {
                    const id = typeof opt.templateLinkId === 'string' ? opt.templateLinkId.trim() : '';
                    return id || null;
                } catch (_) {
                    return null;
                }
            })(options),
            linkIndex: Number.isFinite(Number(options.linkIndex)) ? Math.floor(Number(options.linkIndex)) : null,
            hasGeneratedOnce: false,
            isGenerating: false,
            lastGeneratedAt: null
        });

        // Wire refresh toggle to update and persist
        try {
            const tab = sessionTabs.get(tabId);
            if (refreshCheckbox) {
                const isTemplatePreView = tab && tab.isTemplateLink === true && tab.hasPreViewCommand === true;
                if (isTemplatePreView) {
                    // Template chat links use dedicated refresh flags; keep checkbox read-only / decorative
                    try { refreshCheckbox.disabled = true; } catch (_) {}
                } else {
                    refreshCheckbox.addEventListener('change', () => {
                        tab.refreshOnView = !!refreshCheckbox.checked;
                        if (this.currentSessionId && tab.url) {
                            try { apiService.updateSessionLink(this.currentSessionId, tab.url, { refresh_on_view: tab.refreshOnView }); } catch (_) {}
                        }
                    });
                }
            }
        } catch (_) {}

        return tabId;
    }
    
    createNewLinkTab() {
        if (!this.currentSessionId) {
            console.warn('Cannot create new link tab: no active session');
            return null;
        }

        this.tabCounter++;
        const tabId = `new-link-${this.tabCounter}`;

        // Create content view with URL input focused
        const contentView = document.createElement('div');
        contentView.className = 'terminal-content-view url-view';
        contentView.dataset.tabId = tabId;
        contentView.innerHTML = `
            <div class="url-controls">
                <input type="text" class="url-input" value="" placeholder="Enter URL...">
                <button class="url-go-btn" title="Navigate to URL">Go</button>
                <input type="checkbox" class="url-refresh-checkbox">
            </div>
            <div class="url-placeholder">Enter a URL above to create a new link tab</div>
        `;
        
        // Add content view to DOM
        this.contentArea.appendChild(contentView);
        
        // Setup URL input functionality
        const urlInput = contentView.querySelector('.url-input');
        const goBtn = contentView.querySelector('.url-go-btn');
        const refreshCheckbox2 = contentView.querySelector('.url-refresh-checkbox');
        if (refreshCheckbox2) refreshCheckbox2.checked = false;

        const navigateToUrl = () => {
            const newUrl = urlInput.value.trim();
            if (newUrl) {
                // Load the URL and update the tab
                this.loadUrlInTab(tabId, newUrl);
                // Update tab title and URL
                const sessionTabs = this.sessionTabs.get(this.currentSessionId);
                const tab = sessionTabs.get(tabId);
                if (tab) {
                    // Extract domain for title
                    let title = newUrl;
                    try {
                        const urlObj = new URL(newUrl);
                        title = urlObj.hostname;
                    } catch (e) {
                        title = 'URL';
                    }
                    tab.title = title;
                    tab.url = newUrl;
                    
                    // Update the tab button title
                    const tabButton = this.tabsContainer.querySelector(`[data-tab-id="${tabId}"]`);
                    if (tabButton) {
                        const titleElement = tabButton.querySelector('.terminal-tab-title');
                        if (titleElement) {
                            titleElement.textContent = title;
                        }
                    }
                }
            }
        };
        
        goBtn.addEventListener('click', navigateToUrl);
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                navigateToUrl();
            }
        });
        
        // Get session tabs
        const sessionTabs = this.sessionTabs.get(this.currentSessionId);

        // Store tab data for this session
        sessionTabs.set(tabId, {
            id: tabId,
            title: 'Link',
            type: 'url',
            url: '',
            sessionId: this.currentSessionId,
            element: contentView,
            linkInput: urlInput,
            closeable: true,
            loaded: false,
            isLoading: false,
            preCreated: false,
            refreshOnView: false,
            showUrlBar: true,
            isTemplateLink: false,
            hasPreViewCommand: false,
            refreshOnViewActive: false,
            refreshOnViewInactive: false,
            passThemeColors: false,
            outputFilename: null,
            linkIndex: null,
            hasGeneratedOnce: false,
            isGenerating: false,
            lastGeneratedAt: null
        });
        // Wire refresh toggle to update the local flag
        try {
            const tab = sessionTabs.get(tabId);
            if (refreshCheckbox2) {
                refreshCheckbox2.addEventListener('change', () => {
                    tab.refreshOnView = !!refreshCheckbox2.checked;
                });
            }
        } catch (_) {}
        
        // Create and add tab button
        const tab = sessionTabs.get(tabId);
        this.createTabButton(tab);
        
        // Remove the add button and re-add it after the new tab
        const addButton = this.tabsContainer.querySelector('.terminal-tab-add');
        if (addButton) {
            addButton.remove();
        }
        this.createAddTabButton();
        
        // Switch to the new tab
        this.switchToTab(tabId);
        
        // Focus the URL input after tab switch completes
        setTimeout(() => {
            if (urlInput && document.body.contains(urlInput)) {
                urlInput.focus();
                urlInput.select(); // Also select the text for easy replacement
            }
        }, 200);
        
        return tabId;
    }
    
    createUrlTab(url, title = null) {
        if (!this.currentSessionId) {
            console.warn('Cannot create URL tab: no active session');
            return null;
        }

        // Basic URL validation
        try {
            new URL(url);
        } catch (e) {
            console.error('Invalid URL provided to createUrlTab:', url);
            return null;
        }
        
        // First check if a tab for this URL already exists
        const sessionTabs = this.sessionTabs.get(this.currentSessionId);
        const existingTab = Array.from(sessionTabs.values()).find(tab => tab.url === url);
        
        if (existingTab) {
            // Just switch to the existing tab, don't create a new one
            this.switchToTab(existingTab.id);
            return existingTab.id;
        }
        
        this.tabCounter++;
        const tabId = `url-${this.tabCounter}`;

        // Extract domain for title if not provided
        if (!title) {
            try {
                const urlObj = new URL(url);
                title = urlObj.hostname;
            } catch (e) {
                title = 'URL';
            }
        }
        
        // Create content view
        const contentView = document.createElement('div');
        contentView.className = 'terminal-content-view url-view';
        contentView.dataset.tabId = tabId;
        contentView.innerHTML = `
            <div class="url-controls">
                <input type="text" class="url-input" value="${escapeHtml(url)}" placeholder="Enter URL...">
                <button class="url-go-btn" title="Navigate to URL">Go</button>
                <input type="checkbox" class="url-refresh-checkbox">
            </div>
            <div class="url-loading">Loading ${escapeHtml(url)}...</div>
        `;
        
        // Add content view to DOM
        this.contentArea.appendChild(contentView);
        
        // Setup URL input functionality
        const urlInput = contentView.querySelector('.url-input');
        const goBtn = contentView.querySelector('.url-go-btn');
        const refreshCheckbox3 = contentView.querySelector('.url-refresh-checkbox');
        if (refreshCheckbox3) refreshCheckbox3.checked = false;
        
        const navigateToUrl = () => {
            const newUrl = urlInput.value.trim();
            if (newUrl && newUrl !== url) {
                // Update the tab's URL and reload
                sessionTabs.get(tabId).url = newUrl;
                sessionTabs.get(tabId).loaded = false;
                sessionTabs.get(tabId).isLoading = false;
                this.loadUrlInTab(tabId, newUrl);
            }
        };
        
        goBtn.addEventListener('click', navigateToUrl);
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                navigateToUrl();
            }
        });
        
        // Store tab data for this session
        sessionTabs.set(tabId, {
            id: tabId,
            title: title,
            type: 'url',
            url: url,
            sessionId: this.currentSessionId,
            element: contentView,
            linkInput: urlInput,
            closeable: true,
            loaded: false,
            isLoading: false,
            preCreated: false,
            refreshOnView: false,
            showUrlBar: true,
            isTemplateLink: false,
            hasPreViewCommand: false,
            refreshOnViewActive: false,
            refreshOnViewInactive: false,
            passThemeColors: false,
            outputFilename: null,
            linkIndex: null,
            hasGeneratedOnce: false,
            isGenerating: false,
            lastGeneratedAt: null
        });
        // Wire refresh toggle to update and later persist
        try {
            const tab = sessionTabs.get(tabId);
            if (refreshCheckbox3) {
                refreshCheckbox3.addEventListener('change', () => {
                    tab.refreshOnView = !!refreshCheckbox3.checked;
                });
            }
        } catch (_) {}
        
        // Create and add tab button
        const tab = sessionTabs.get(tabId);
        this.createTabButton(tab);
        
        // Switch to the new tab
        this.switchToTab(tabId);
        
        // Load the URL in an iframe
        this.loadUrlInTab(tabId, url);
        
        return tabId;
    }
    
    getCurrentSessionTab(tabId) {
        // Prefer global tabs when available (e.g., workspace-note)
        if (this.globalTabs && this.globalTabs.has(tabId)) {
            return this.globalTabs.get(tabId);
        }
        if (!this.currentSessionId) return null;
        const sessionTabs = this.sessionTabs.get(this.currentSessionId);
        return sessionTabs ? sessionTabs.get(tabId) : null;
    }
    
    loadUrlInTab(tabId, url) {
        const tab = this.getCurrentSessionTab(tabId);
        if (!tab || tab.type !== 'url') {
            return;
        }

        // Template chat links use the dedicated generate+HTML pipeline instead of direct URL loading.
        if (this.isTemplatePreViewTab(tab)) {
            this.prepareTemplateLinkTab(tabId, tab, { reason: 'load' });
            return;
        }

        // Skip if already loaded and not refreshing
        if (tab.loaded && !tab.element.querySelector('.url-loading')) {
            return;
        }
        
        
        // Mark as loading and update placeholder
        tab.isLoading = true;
        const showUrlBar = tab.showUrlBar !== false;

        // Update content to show loading state with link input
        tab.element.innerHTML = `
            <div class="url-controls"${showUrlBar ? '' : ' style="display:none;"'}>
                <input type="text" class="url-input" value="${escapeHtml(url)}" placeholder="Enter URL...">
                <button class="url-go-btn" title="Navigate to URL">Go</button>
                <input type="checkbox" class="url-refresh-checkbox">
            </div>
            <div class="url-loading">Loading ${escapeHtml(url)}...</div>
        `;
        
        // Setup URL input functionality
        const urlInput = tab.element.querySelector('.url-input');
        const goBtn = tab.element.querySelector('.url-go-btn');
        const refreshCheckbox4 = tab.element.querySelector('.url-refresh-checkbox');
        if (refreshCheckbox4) refreshCheckbox4.checked = !!tab.refreshOnView;
        
        const navigateToUrl = () => {
            const newUrl = urlInput.value.trim();
            if (newUrl && newUrl !== url) {
                // Update the tab's URL and reload
                tab.url = newUrl;
                tab.loaded = false;
                tab.isLoading = false;
                this.loadUrlInTab(tabId, newUrl);
            }
        };
        
        goBtn.addEventListener('click', navigateToUrl);
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                navigateToUrl();
            }
        });
        if (refreshCheckbox4) {
            const isTemplatePreView = tab && tab.isTemplateLink === true && tab.hasPreViewCommand === true;
            if (isTemplatePreView) {
                try { refreshCheckbox4.disabled = true; } catch (_) {}
            } else {
                refreshCheckbox4.addEventListener('change', () => {
                    tab.refreshOnView = !!refreshCheckbox4.checked;
                    if (this.currentSessionId && tab.url) {
                        try { apiService.updateSessionLink(this.currentSessionId, tab.url, { refresh_on_view: tab.refreshOnView }); } catch (_) {}
                    }
                });
            }
        }
        
        // Store reference to the input for focus management
        tab.linkInput = urlInput;
        
        // Store reference to remember what had focus before content loads
        const previouslyFocusedElement = document.activeElement;

        // Always use iframe (desktop and web) to preserve original layout/behavior
        const iframe = document.createElement('iframe');
        iframe.className = 'url-iframe';
        iframe.title = `Content from ${url}`;
        iframe.style.display = 'none'; // Hide initially until loaded
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-popups allow-forms'); // Add sandbox to limit iframe capabilities
        tab.element.appendChild(iframe);
        
        // Helper for load completion
        const onLoaded = () => {
            // Mark as loaded
            tab.loaded = true;
            tab.isLoading = false;

            // Add link to session data on server side (only for new tabs, not pre-created ones)
            if (!tab.preCreated && this.currentSessionId) {
                try {
                    const app = getContext()?.app;
                    const sessionData = app?.modules?.terminal?.sessionList?.getSessionData?.(this.currentSessionId);
                    const exists = Array.isArray(sessionData?.links) && sessionData.links.some(l => l && l.url === url);
                    if (!exists) {
                        this.addLinkToSession(url, tab.title, !!tab.refreshOnView);
                    } else {
                        console.log('[TabManager] Link already exists in session, skipping add:', url);
                    }
                } catch (_) {
                    // Fall back to attempting add; server may dedupe
                    this.addLinkToSession(url, tab.title, !!tab.refreshOnView);
                }
            }

            // Show the content after a brief delay to ensure it's ready
            setTimeout(() => {
                // Remove loading message and show
                const loadingDiv = tab.element.querySelector('.url-loading');
                if (loadingDiv) {
                    loadingDiv.remove();
                }
                iframe.style.display = '';
            }, 500);
        };

        // Best-effort stringify for iframe error events
        const describeError = (err) => {
            try {
                if (!err) return 'unknown';
                if (err instanceof Error) return `${err.name}: ${err.message}`;
                if (typeof err === 'string') return err;
                const detail = {};
                const keys = ['message','name','type','status','statusText','errorCode','errorDescription','validatedURL','isMainFrame'];
                for (const k of keys) {
                    if (typeof err[k] !== 'undefined') detail[k] = err[k];
                }
                if (err?.target?.src) detail.src = err.target.src;
                if (err?.detail) {
                    detail.detail = typeof err.detail === 'object' ? err.detail : String(err.detail);
                }
                const json = JSON.stringify(detail);
                return json && json !== '{}' ? json : String(err);
            } catch (_) {
                try { return String(err); } catch { return 'unstringifiable-error'; }
            }
        };

        const onError = (error) => {
            console.error('Iframe failed to load:', url, describeError(error));
            tab.isLoading = false;
            this.showUrlError(tabId, url, 'Failed to load the URL');
        };

        const onAbort = (evt) => {
            console.warn('Iframe loading aborted:', url, describeError(evt));
            tab.isLoading = false;
            this.showUrlError(tabId, url, 'Loading was aborted');
        };

        // Wire events and set source (iframe only)
        iframe.onload = () => {
            onLoaded();
        };
        iframe.onerror = (e) => onError(e);
        iframe.onabort = (e) => onAbort(e);
        iframe.src = url;
    }
    
    showUrlError(tabId, url, errorMessage) {
        const tab = this.getCurrentSessionTab(tabId);
        if (!tab) return;
        
        console.error('Showing URL error for tab:', tabId, errorMessage);
        
        tab.element.innerHTML = `
            <div class="url-error">
                <h3>Unable to load content in tab</h3>
                <p>${escapeHtml(errorMessage)}</p>
                <p><strong>URL:</strong> ${escapeHtml(url)}</p>
                <p><em>Many web applications prevent loading in frames for security reasons.</em></p>
                <button class="url-error-open-btn" data-url="${escapeHtml(url)}">
                    Open in new window
                </button>
            </div>
        `;
        const btn = tab.element.querySelector('.url-error-open-btn');
        if (btn) {
            btn.addEventListener('click', (e) => {
                const targetUrl = e.currentTarget.getAttribute('data-url');
                if (targetUrl) window.open(targetUrl, '_blank');
            });
        }
    }

    isTemplatePreViewTab(tab) {
        return !!(tab
            && tab.type === 'url'
            && tab.isTemplateLink === true
            && tab.hasPreViewCommand === true
            && (
                (typeof tab.templateLinkId === 'string' && tab.templateLinkId.trim())
                || (tab.linkIndex != null && Number.isFinite(Number(tab.linkIndex)))
            ));
    }

    getCurrentSessionData() {
        if (!this.currentSessionId) return null;
        try {
            const mgr = this.getTerminalManager();
            const sessionList = mgr && mgr.sessionList;
            if (!sessionList || typeof sessionList.getSessionData !== 'function') return null;
            return sessionList.getSessionData(this.currentSessionId) || null;
        } catch (_) {
            return null;
        }
    }

    isCurrentSessionActive() {
        const data = this.getCurrentSessionData();
        return !!(data && data.is_active);
    }

    getSessionLinkHtmlUrl(sessionId, linkRef, options = {}) {
        const baseUrl = (apiService && typeof apiService.baseUrl === 'string' && apiService.baseUrl.trim())
            ? apiService.baseUrl.trim()
            : window.location.origin;
        const encodedSid = encodeURIComponent(sessionId);
        const ref = linkRef;
        let endpoint;
        if (typeof ref === 'string') {
            const trimmed = ref.trim();
            const isNumeric = trimmed !== '' && /^[0-9]+$/.test(trimmed);
            if (!trimmed) {
                endpoint = `/api/sessions/${encodedSid}/links/0/html`;
            } else if (isNumeric) {
                const idx = Math.floor(Number(trimmed));
                endpoint = `/api/sessions/${encodedSid}/links/${idx}/html`;
            } else {
                endpoint = `/api/sessions/${encodedSid}/links/id/${encodeURIComponent(trimmed)}/html`;
            }
        } else if (Number.isFinite(Number(ref)) && Number(ref) >= 0) {
            const idx = Math.floor(Number(ref));
            endpoint = `/api/sessions/${encodedSid}/links/${idx}/html`;
        } else {
            endpoint = `/api/sessions/${encodedSid}/links/0/html`;
        }
        let url = `${baseUrl}${endpoint}`;
        const cacheBust = options && options.cacheBust === true;
        if (cacheBust) {
            const paramName = options.cacheParamName || 't';
            const sep = url.includes('?') ? '&' : '?';
            url = `${url}${sep}${encodeURIComponent(paramName)}=${Date.now()}`;
        }
        return url;
    }

    buildThemePayloadForTab(tab) {
        if (!tab || tab.passThemeColors !== true) return null;
        try {
            const root = document.documentElement;
            const styles = getComputedStyle(root);
            const readVar = (name) => {
                try {
                    const v = styles.getPropertyValue(name);
                    return v && typeof v === 'string' ? v.trim() : '';
                } catch (_) {
                    return '';
                }
            };

            const cssVars = [
                '--bg-primary',
                '--bg-secondary',
                '--bg-tertiary',
                '--bg-hover',
                '--text-primary',
                '--text-secondary',
                '--text-dim',
                '--border-color',
                '--accent-color',
                '--accent-hover',
                '--danger-color',
                '--success-color',
                '--warning-color'
            ];

            const theme = {};
            cssVars.forEach((name) => {
                const value = readVar(name);
                if (!value) return;
                const key = name.replace(/^--/, '').replace(/-/g, '_');
                theme[key] = value;
            });

            const cleanedTheme = {};
            Object.entries(theme).forEach(([key, value]) => {
                if (value) cleanedTheme[key] = value;
            });

            let bodyFontFamily = '';
            try {
                const body = document.body;
                if (body && typeof getComputedStyle === 'function') {
                    const bodyStyles = getComputedStyle(body);
                    bodyFontFamily = bodyStyles && bodyStyles.fontFamily ? bodyStyles.fontFamily : '';
                }
            } catch (_) {
                bodyFontFamily = '';
            }

            let terminalFontFamily = '';
            try {
                const terminalEl = document.querySelector('.terminal-view');
                if (terminalEl && typeof getComputedStyle === 'function') {
                    const termStyles = getComputedStyle(terminalEl);
                    terminalFontFamily = termStyles && termStyles.fontFamily ? termStyles.fontFamily : '';
                }
            } catch (_) {
                terminalFontFamily = '';
            }

            const fonts = computeChatLinkFonts({
                fontUiVar: readVar('--font-ui'),
                bodyFontFamily,
                fontCodeVar: readVar('--font-code'),
                terminalFontFamily
            });

            const payload = {};
            if (Object.keys(cleanedTheme).length > 0) {
                payload.theme = cleanedTheme;
            }
            if (fonts && Object.keys(fonts).length > 0) {
                payload.fonts = fonts;
            }

            return Object.keys(payload).length > 0 ? payload : null;
        } catch (_) {
            return null;
        }
    }

    showTemplateLinkError(tabId, tab, error) {
        const targetTab = tab || this.getCurrentSessionTab(tabId);
        if (!targetTab) return;
        const normalized = normalizeTemplateLinkError(error || {});
        const message = normalized.message || 'An error occurred while preparing the chat view.';
        const details = normalized.details || '';

        const titleHtml = escapeHtml(normalized.title || 'Failed to prepare chat view');
        const messageHtml = escapeHtml(message);
        const detailsHtml = details ? escapeHtml(details) : '';

        targetTab.element.innerHTML = `
            <div class="url-error chat-error">
                <h3>${titleHtml}</h3>
                <p>${messageHtml}</p>
                ${detailsHtml ? `<pre class="chat-error-details">${detailsHtml}</pre>` : ''}
            </div>
        `;
    }

    async prepareTemplateLinkTab(tabId, tab, options = {}) {
        const targetTab = tab || this.getCurrentSessionTab(tabId);
        if (!targetTab || !this.isTemplatePreViewTab(targetTab) || !this.currentSessionId) {
            return;
        }
        const sessionId = this.currentSessionId;
        const templateLinkId = (function resolveTemplateLinkId(t) {
            try {
                const id = typeof t.templateLinkId === 'string' ? t.templateLinkId.trim() : '';
                return id || null;
            } catch (_) {
                return null;
            }
        })(targetTab);
        const linkIndex = (!templateLinkId && Number.isFinite(Number(targetTab.linkIndex)))
            ? Math.floor(Number(targetTab.linkIndex))
            : null;
        if (!templateLinkId && (linkIndex == null || linkIndex < 0)) {
            this.showTemplateLinkError(tabId, targetTab, { message: 'Missing link identifier for chat link.' });
            return;
        }
        const linkRef = templateLinkId || linkIndex;

        const isActive = this.isCurrentSessionActive();
        const reason = options && typeof options.reason === 'string' ? options.reason : 'view';
        const shouldRegen = shouldRegenerateTemplateLink({
            hasGeneratedOnce: !!targetTab.hasGeneratedOnce,
            refreshOnViewActive: targetTab.refreshOnViewActive === true,
            refreshOnViewInactive: targetTab.refreshOnViewInactive === true,
            isSessionActive: isActive,
            reason
        });

        // If we don't need a new generation and the iframe is already present, do nothing.
        if (!shouldRegen && targetTab.loaded && targetTab.element.querySelector('iframe.url-iframe')) {
            return;
        }

        const requestId = (targetTab._generateRequestId || 0) + 1;
        targetTab._generateRequestId = requestId;
        targetTab.isGenerating = true;
        targetTab.isLoading = true;
        this.setTabLoading(tabId, true);

        const showUrlBar = targetTab.showUrlBar !== false;
        const urlValue = targetTab.url || '';
        const placeholderText = 'Preparing chat view...';

        targetTab.element.innerHTML = `
            <div class="url-controls"${showUrlBar ? '' : ' style="display:none;"'}>
                <input type="text" class="url-input" value="${escapeHtml(urlValue)}" placeholder="Enter URL...">
                <button class="url-go-btn" title="Reload chat view">Go</button>
                <input type="checkbox" class="url-refresh-checkbox" disabled>
            </div>
            <div class="url-loading">${escapeHtml(placeholderText)}</div>
        `;

        const urlInput = targetTab.element.querySelector('.url-input');
        const goBtn = targetTab.element.querySelector('.url-go-btn');
        if (goBtn) {
            const triggerManual = (e) => {
                if (e) e.preventDefault();
                this.prepareTemplateLinkTab(tabId, targetTab, { reason: 'manual' });
            };
            goBtn.addEventListener('click', triggerManual);
            if (urlInput) {
                urlInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        triggerManual(e);
                    }
                });
            }
        }

        const payload = this.buildThemePayloadForTab(targetTab);

        try {
            await apiService.generateLinkHtml(sessionId, linkRef, payload);
            if (targetTab._generateRequestId !== requestId) {
                return;
            }
            targetTab.hasGeneratedOnce = true;
            targetTab.lastGeneratedAt = Date.now();
            targetTab.isGenerating = false;

            // Append iframe that points at the HTML endpoint with cache-busting
            const iframe = document.createElement('iframe');
            iframe.className = 'url-iframe';
            iframe.title = targetTab.title ? `Chat view: ${targetTab.title}` : 'Chat view';
            iframe.style.display = 'none';
            iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-popups allow-forms');
            targetTab.element.appendChild(iframe);

            const htmlUrl = this.getSessionLinkHtmlUrl(sessionId, linkRef, { cacheBust: true });

            iframe.onload = () => {
                if (targetTab._generateRequestId !== requestId) {
                    return;
                }
                targetTab.loaded = true;
                targetTab.isLoading = false;
                this.setTabLoading(tabId, false);
                const loadingDiv = targetTab.element.querySelector('.url-loading');
                if (loadingDiv) {
                    try { loadingDiv.remove(); } catch (_) {}
                }
                iframe.style.display = '';
            };
            iframe.onerror = (evt) => {
                if (targetTab._generateRequestId !== requestId) {
                    return;
                }
                targetTab.isLoading = false;
                this.setTabLoading(tabId, false);
                this.showTemplateLinkError(tabId, targetTab, evt || { message: 'Failed to load chat HTML.' });
            };

            iframe.src = htmlUrl;
        } catch (error) {
            if (targetTab._generateRequestId !== requestId) {
                return;
            }
            targetTab.isGenerating = false;
            targetTab.isLoading = false;
            this.setTabLoading(tabId, false);
            this.showTemplateLinkError(tabId, targetTab, error);
        }
    }

    refreshTab(tabId) {
        const tab = this.getCurrentSessionTab(tabId);
        if (!tab) {
            console.log(`[TabManager] refreshTab: Tab ${tabId} not found`);
            return;
        }

        console.log(`[TabManager] Refresh button clicked for tab ${tabId}, type: ${tab.type}`);

        if (tab.type === 'url') {
            if (this.isTemplatePreViewTab(tab)) {
                // Always re-run generate for template chat links before loading HTML.
                this.prepareTemplateLinkTab(tabId, tab, { reason: 'refresh' });
                return;
            }
            // Reset loaded state
            tab.loaded = false;
            tab.isLoading = false;
            
            // Clear the content and show loading
            tab.element.innerHTML = `
                <div class="url-loading">Refreshing ${escapeHtml(tab.url)}...</div>
            `;
            
            // Reload the URL
            this.loadUrlInTab(tabId, tab.url);
        } else if (tab.type === 'terminal') {
            console.log(`[TabManager] Emitting terminal-reload event for session ${this.currentSessionId}, tab ${tabId}`);
            // For terminal tabs, emit an event to reload the terminal (fit/resize)
            this.eventBus.emit('terminal-reload', {
                sessionId: this.currentSessionId,
                tabId: tabId
            });
        } else if (tab.type === 'command') {
            // Terminate any previous child session bound to this tab and run again
            const prevChild = tab.childSessionId;
            tab.childSessionId = null;
            // Clear content before re-run so output does not accumulate across runs
            try {
                if (tab.element) {
                    tab.element.innerHTML = '<div class="url-loading">Running command…</div>';
                }
            } catch (_) {}
            if (prevChild) {
                try { apiService.terminateSession?.(prevChild); } catch (_) {}
            }
            const mgr = this.getTerminalManager();
            if (mgr && typeof mgr.runContainerCommandForActiveSession === 'function') {
                mgr.runContainerCommandForActiveSession({ command: tab.command, title: tab.title, tabId });
            }
        } else if (tab.type === 'workspace') {
            // Refresh the workspace file listing
            if (tab.workspaceView && typeof tab.workspaceView.loadPath === 'function') {
                tab.workspaceView.loadPath(tab.workspaceView.currentPath || '/');
            }
        }
    }
    
    switchToTab(tabId) {
        const tab = this.getCurrentSessionTab(tabId);
        if (!tab || this.activeTabId === tabId) {
            return;
        }

        // Update active tab
        this.activeTabId = tabId;
        
        // Save the active tab for this session (skip global tabs like workspace notes)
        if (this.currentSessionId && tab.sessionId === this.currentSessionId) {
            this.sessionActiveTab.set(this.currentSessionId, tabId);
            this.persistActiveTabs();
        }
        
        // If this is a URL tab: optionally refresh on visit, otherwise lazy-load when first visited.
        // Template chat links use the generate+HTML pipeline instead of direct URL loading.
        if (tab.type === 'url') {
            if (this.isTemplatePreViewTab(tab)) {
                this.prepareTemplateLinkTab(tabId, tab, { reason: 'view' });
            } else if (tab.url && tab.url.trim()) {
                if (tab.refreshOnView === true) {
                    if (!tab.isLoading) this.refreshTab(tabId);
                } else if (!tab.loaded && !tab.isLoading) {
                    this.loadUrlInTab(tabId, tab.url);
                }
            }
        }
        // Command tabs: run on first activation; optionally rerun every view if refreshOnView is true
        if (tab.type === 'command') {
            const mgr = this.getTerminalManager();
            // Determine if we should force a re-run on view
            const shouldRerun = tab.refreshOnView === true;
            if (shouldRerun && tab.childSessionId) {
                const prevChild = tab.childSessionId;
                tab.childSessionId = null;
                try { if (tab.element) tab.element.innerHTML = '<div class="url-loading">Running command…</div>'; } catch (_) {}
                if (prevChild) {
                    try { apiService.terminateSession?.(prevChild); } catch (_) {}
                }
                if (mgr && typeof mgr.runContainerCommandForActiveSession === 'function') {
                    mgr.runContainerCommandForActiveSession({ command: tab.command, title: tab.title, tabId });
                }
            } else if (!tab.childSessionId) {
                // Initial run on first view
                try { if (tab.element) tab.element.innerHTML = '<div class="url-loading">Running command…</div>'; } catch (_) {}
                if (mgr && typeof mgr.runContainerCommandForActiveSession === 'function') {
                    mgr.runContainerCommandForActiveSession({ command: tab.command, title: tab.title, tabId });
                }
            }
        } else if (tab.type === 'workspace') {
            try {
                if (tab.workspaceView && typeof tab.workspaceView.loadPath === 'function') {
                    tab.workspaceView.loadPath(tab.workspaceView.currentPath || '/');
                }
            } catch (_) {
                // Non-fatal; status will be updated from view on error.
            }
        }
        
        // Update active tab display
        this._debug?.log?.('switchToTab', { tabId, type: tab.type });
        this.updateActiveTabDisplay();
        
        // If it's a URL tab without a URL (new link tab), focus the input
        if (tab.type === 'url' && !tab.url && tab.linkInput) {
            setTimeout(() => {
                if (tab.linkInput && document.body.contains(tab.linkInput)) {
                    tab.linkInput.focus();
                    tab.linkInput.select();
                }
            }, 100);
        }
        
        // Emit event for other components to handle tab switching
        this.eventBus.emit('tab-switched', {
            tabId: tabId,
            tab: tab
        });
    }
    
    clearSession() {
        // Clear the current session view but preserve tab data structures so we can restore state later
        console.log('[TabManager] Clearing session (preserving tab data)');

        // Allow tabs to cleanup transient resources, but keep their entries intact
        this.sessionTabs.forEach((tabs) => {
            tabs.forEach((tab) => {
                if (typeof tab?.cleanup === 'function') {
                    try { tab.cleanup(); } catch (_) {}
                }
            });
        });

        this.notesController.handleClearSession();

        // Do not clear sessionTabs or containerTabLookup; just clear DOM state
        this.currentSessionId = null;

        // Remove existing tab buttons (they will be recreated on next session activation)
        const allButtons = this.tabsContainer.querySelectorAll('.terminal-tab');
        allButtons.forEach(btn => { try { btn.remove(); } catch (_) {} });

        // Hide all non-terminal content views, but do not remove them.
        const allViews = this.contentArea.querySelectorAll('.terminal-content-view');
        allViews.forEach(view => {
            const id = view.dataset.tabId;
            if (id && id !== 'terminal') {
                try { view.style.display = 'none'; } catch (_) {}
                try { view.classList.remove('active'); } catch (_) {}
            }
        });
        // Reset active tab id; it will be restored from saved mapping when a session is reactivated
        this.activeTabId = 'terminal';

        // Hide the lower content tabs when no session is selected
        // Do not touch the top session tabs manager here. The TerminalViewController
        // is responsible for enabling/disabling the session tabs row depending on
        // whether there are any sessions or an empty state is shown. Re-enabling it
        // here caused the tabs row to remain visible after closing the last session.
        // Hide both the tabs container and the wrapper row (so the "+" button is hidden too)
        this.tabsContainer.style.display = 'none';
        try {
            const bar = this.ensureTabsBar();
            if (bar) bar.style.display = 'none';
        } catch (_) {}
    }
    
    closeTab(tabId) {
        const tab = this.getCurrentSessionTab(tabId);
        if (!tab || !tab.closeable) {
            return;
        }
        
        // Remove from DOM
        const tabButton = this.tabsContainer.querySelector(`[data-tab-id="${tabId}"]`);
        const contentView = this.contentArea.querySelector(`[data-tab-id="${tabId}"]`);
        
        if (tabButton) tabButton.remove();
        if (contentView) contentView.remove();
        
        // Remove from session tabs map
        const sessionTabs = this.sessionTabs.get(this.currentSessionId);
        if (sessionTabs) {
            sessionTabs.delete(tabId);
        }
        // Terminate any attached command child session
        if (tab && tab.type === 'command' && tab.childSessionId) {
            try { apiService.terminateSession?.(tab.childSessionId); } catch (_) {}
        }
        
        // If this was the active tab, switch to terminal tab
        if (this.activeTabId === tabId) {
            this.switchToTab('terminal');
        }
        
        // Emit event
        this.eventBus.emit('tab-closed', { tabId: tabId });
    }
    
    getActiveTab() {
        return this.getCurrentSessionTab(this.activeTabId);
    }
    
    getAllTabs() {
        if (!this.currentSessionId) return [];
        const sessionTabs = this.sessionTabs.get(this.currentSessionId);
        if (!sessionTabs) return [];

        const tabs = Array.from(sessionTabs.values());
        const childSessions = this.getChildSessionsInOrder(this.currentSessionId);

        return orderTabsWithWorkspaceAfterShellAndCommand(tabs, childSessions);
    }
    
    navigateTabs(direction) {
        // Get all tabs for the current session in order
        const allTabs = this.getAllTabs();
        if (allTabs.length <= 1) {
            return;
        }

        // Find current active tab index
        const currentIndex = allTabs.findIndex(tab => tab.id === this.activeTabId);
        if (currentIndex === -1) {
            return;
        }

        // Calculate next tab index based on direction
        let nextIndex;
        if (direction === 'left') {
            // Go to previous tab (or wrap to last)
            nextIndex = currentIndex === 0 ? allTabs.length - 1 : currentIndex - 1;
        } else if (direction === 'right') {
            // Go to next tab (or wrap to first) 
            nextIndex = currentIndex === allTabs.length - 1 ? 0 : currentIndex + 1;
        } else {
            return;
        }

        // Switch to the next tab
        const nextTab = allTabs[nextIndex];
        this.switchToTab(nextTab.id);
    }

    setupKeyboardShortcuts() {
        if (Array.isArray(this._shortcutDisposers)) {
            this._shortcutDisposers.forEach((dispose) => {
                try { dispose(); } catch (_) {}
            });
        }
        this._shortcutDisposers = [];

        const isModalOpen = () => {
            const modal = document.getElementById('new-session-modal');
            const terminateModal = document.getElementById('terminate-modal');
            const deleteModal = document.getElementById('delete-modal');
            if (modal?.classList?.contains('show')) return true;
            if (terminateModal?.classList?.contains('show')) return true;
            if (deleteModal?.classList?.contains('show')) return true;
            return false;
        };

        const baseOptions = {
            scope: 'terminal:tab-manager',
            priority: 15,
            when: () => !isModalOpen(),
            preventDefault: true
        };

        const registerShortcut = (config) => {
            const disposer = keyboardShortcuts.registerShortcut({
                ...baseOptions,
                ...config
            });
            this._shortcutDisposers.push(disposer);
        };

        const modCombos = (key) => [`Meta+${key}`, `Alt+${key}`];
        const modShiftCombos = (key) => [`Meta+Shift+${key}`, `Alt+Shift+${key}`];

        registerShortcut({
            id: 'tab-manager.navigate-left',
            description: 'Navigate to previous terminal/tab view',
            keys: [...modCombos('ArrowLeft')],
            handler: () => {
                if (this.activeTabId === 'workspace-note') {
                    return false;
                }
                this.navigateTabs('left');
                return true;
            }
        });

        registerShortcut({
            id: 'tab-manager.navigate-right',
            description: 'Navigate to next terminal/tab view',
            keys: [...modCombos('ArrowRight')],
            handler: () => {
                if (this.activeTabId === 'workspace-note') {
                    return false;
                }
                this.navigateTabs('right');
                return true;
            }
        });

        registerShortcut({
            id: 'tab-manager.reorder-left',
            description: 'Move active tab left within its group',
            keys: [...modShiftCombos('ArrowLeft')],
            handler: () => {
                if (this.activeTabId === 'workspace-note') {
                    return false;
                }
                this.reorderActiveTab('left');
                return true;
            }
        });

        registerShortcut({
            id: 'tab-manager.reorder-right',
            description: 'Move active tab right within its group',
            keys: [...modShiftCombos('ArrowRight')],
            handler: () => {
                if (this.activeTabId === 'workspace-note') {
                    return false;
                }
                this.reorderActiveTab('right');
                return true;
            }
        });
    }

    setupIframeFocusProtection() {
        // Track whether we're in the middle of keyboard navigation
        let isNavigating = false;
        let navigationTimeout = null;
        let monitorInterval = null;

        const startFocusMonitor = () => {
            if (monitorInterval) return;
            // Additional protection: Monitor activeElement changes only during navigation
            let lastKnownFocus = null;
            monitorInterval = setInterval(() => {
                if (!isNavigating) return; // guard (extra safety)
                if (document.activeElement !== lastKnownFocus) {
                    const currentFocus = document.activeElement;
                    // Check if an iframe stole focus
                    if (currentFocus && currentFocus.tagName === 'IFRAME') {
                        try { currentFocus.blur(); } catch (_) {}
                        // Restore focus to a safe element
                        if (lastKnownFocus && document.body.contains(lastKnownFocus) && lastKnownFocus.tagName !== 'IFRAME') {
                            try { lastKnownFocus.focus(); } catch (_) {}
                        }
                    } else if (currentFocus && currentFocus.tagName !== 'IFRAME') {
                        // Update last known safe focus
                        lastKnownFocus = currentFocus;
                    }
                }
            }, 50);
        };
        const stopFocusMonitor = () => {
            if (monitorInterval) {
                clearInterval(monitorInterval);
                monitorInterval = null;
            }
        };
        
        // Mark navigation state during keyboard shortcuts
        document.addEventListener('keydown', (event) => {
            const isShiftCmd = event.shiftKey && event.metaKey;
            const isShiftAlt = event.shiftKey && event.altKey;
            const isCmd = !event.shiftKey && event.metaKey && !event.ctrlKey;
            const isAlt = !event.shiftKey && event.altKey && !event.ctrlKey;
            
            // Check for both old and new shortcuts
            const isNavigationShortcut = 
                ((isShiftCmd || isShiftAlt) && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')) ||
                ((isCmd || isAlt) && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight'));
            
            if (isNavigationShortcut) {
                isNavigating = true;
                
                // Clear any existing timeout
                if (navigationTimeout) {
                    clearTimeout(navigationTimeout);
                }
                // Start monitoring focus only while navigating
                startFocusMonitor();
                
                // Set navigation flag to false after a delay
                navigationTimeout = setTimeout(() => {
                    isNavigating = false;
                    stopFocusMonitor();
                }, 1000);
            }
        }, true);
        
        // Global focus listener to detect and prevent iframe focus theft
        document.addEventListener('focus', (event) => {
            const target = event.target;
            
            // Check if focus is going to an iframe
            if (target && target.tagName === 'IFRAME' && target.classList.contains('url-iframe')) {
                // Always prevent focus during navigation
                if (isNavigating) {
                    event.preventDefault();
                    event.stopPropagation();
                    target.blur();
                    
                    // Try to return focus to the tab container or a safe element
                    const activeTabButton = this.tabsContainer.querySelector('.terminal-tab.active');
                    if (activeTabButton) {
                        activeTabButton.focus();
                    }
                    return false;
                }
                
                // Also prevent focus if the iframe's tab is not active
                const iframeTabId = target.closest('.terminal-content-view')?.dataset?.tabId;
                if (iframeTabId && iframeTabId !== this.activeTabId) {
                    event.preventDefault();
                    event.stopPropagation();
                    target.blur();
                    return false;
                }
            }
        }, true); // Use capture phase to catch events earlier
        
        // Focus monitoring now runs only during navigation shortcut windows via startFocusMonitor()
    }

    showTabContextMenu(x, y, tab) {
        // Create context menu if it doesn't exist
        if (!this.tabContextMenu) {
            this.createTabContextMenu();
        }
        
        // Build menu items for URL tab
        const menuItems = [
            {
                label: 'Open in browser',
                icon: 'external-link',
                action: () => {
                    if (tab.url) {
                        window.open(tab.url, '_blank');
                    }
                }
            },
            {
                label: 'Rename',
                icon: 'edit',
                action: () => this.renameTab(tab)
            },
            {
                label: 'Refresh',
                icon: 'refresh',
                action: () => this.refreshTab(tab.id)
            },
            {
                label: 'Close',
                icon: 'close',
                action: () => this.closeTab(tab.id)
            },
            {
                label: 'Remove from session',
                icon: 'remove',
                action: () => this.removeTabFromSession(tab)
            }
        ];
        // Alphabetize entries for a consistent experience
        try {
            menuItems.sort((a, b) => String(a?.label || '').toLowerCase().localeCompare(String(b?.label || '').toLowerCase(), undefined, { sensitivity: 'base' }));
        } catch (_) { /* non-fatal */ }
        
        // Clear existing content
        this.tabContextMenu.innerHTML = '';
        
        // Generate menu elements
        menuItems.forEach(item => {
            const menuElement = document.createElement('div');
            menuElement.className = 'context-menu-item';
            menuElement.innerHTML = `
                <span class="context-menu-label">${item.label}</span>
            `;
            
            menuElement.addEventListener('click', (e) => {
                e.stopPropagation();
                item.action();
                this.hideTabContextMenu();
            });
            
            this.tabContextMenu.appendChild(menuElement);
        });
        
        // Position and show the menu
        this.tabContextMenu.style.left = `${x}px`;
        this.tabContextMenu.style.top = `${y}px`;
        this.tabContextMenu.style.display = 'block';
        this.isTabContextMenuOpen = true;
    }
    
    createTabContextMenu() {
        this.tabContextMenu = document.createElement('div');
        this.tabContextMenu.className = 'terminal-context-menu';
        this.tabContextMenu.style.display = 'none';
        document.body.appendChild(this.tabContextMenu);
        
        // Hide context menu on click outside
        document.addEventListener('click', (e) => {
            if (this.isTabContextMenuOpen && !this.tabContextMenu.contains(e.target)) {
                this.hideTabContextMenu();
            }
        });
        
        // Hide context menu on scroll
        this.tabsContainer.addEventListener('scroll', () => {
            this.hideTabContextMenu();
        }, { passive: true });
        
        // Hide context menu on window resize
        window.addEventListener('resize', () => {
            this.hideTabContextMenu();
        });
    }
    
    hideTabContextMenu() {
        if (this.tabContextMenu) {
            this.tabContextMenu.style.display = 'none';
            this.isTabContextMenuOpen = false;
        }
    }
    
    async renameTab(tab) {
        // Show modal-based rename UI instead of blocking prompt
        try {
            this._showRenameTabModal(tab);
        } catch (e) {
            console.warn('[TabManager] Failed to open rename modal, falling back to prompt:', e);
            const fallback = prompt('Enter new name for the tab:', tab.title || 'Link');
            if (fallback && fallback.trim() && fallback.trim() !== tab.title) {
                if (tab.url && this.currentSessionId) {
                    try {
                        await apiService.updateSessionLink(this.currentSessionId, tab.url, { name: fallback.trim() });
                    } catch (error) {
                        console.error('[TabManager] Fallback rename failed:', error);
                        try {
                            notificationDisplay?.show?.({ notification_type: 'error', title: 'Rename Failed', message: 'Failed to rename tab. Please try again.' }, { duration: 5000 });
                        } catch (_) {}
                    }
                } else if (!tab.url) {
                    tab.title = fallback.trim();
                    const tabButton = this.tabsContainer.querySelector(`[data-tab-id="${tab.id}"]`);
                    if (tabButton) {
                        const titleElement = tabButton.querySelector('.terminal-tab-title');
                        if (titleElement) titleElement.textContent = fallback.trim();
                    }
                }
            }
        }
    }

    _ensureRenameTabModal() {
        if (this.renameTabModal) return this.renameTabModal;
        
        // Create modal element lazily and attach to document
        const el = document.createElement('div');
        el.id = 'rename-tab-modal';
        el.className = 'modal';
        el.setAttribute('tabindex', '-1');
        el.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2 data-modal-title>Rename Link Tab</h2>
                    <button class="modal-close" data-modal-close title="Close">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="rename-tab-form" onsubmit="return false">
                        <label for="rename-tab-name">New name</label>
                        <input type="text" id="rename-tab-name" name="name" data-modal-input class="form-input" autocomplete="off" required />
                        <div class="form-error" id="rename-tab-error" style="display:none;"></div>
                    </form>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-modal-close>Cancel</button>
                    <button type="submit" class="btn btn-primary" data-modal-submit form="rename-tab-form">Rename</button>
                </div>
            </div>`;
        document.body.appendChild(el);

        // Initialize as InputModal for single-field convenience
        this.renameTabModal = new InputModal({
            element: el,
            inputType: 'text',
            autoClose: false,
            onValidate: (formData) => {
                const proposed = (formData?.name || '').trim();
                const current = (this._renameTabTarget?.title || '').trim();
                return !!proposed && proposed !== current;
            },
            onSubmit: async () => {
                const tab = this._renameTabTarget;
                if (!tab) return;
                const value = (this.renameTabModal.getValue() || '').trim();
                // Basic validation
                if (!value || value === tab.title) {
                    this.renameTabModal.hide();
                    return;
                }
                
                if (tab.url && this.currentSessionId) {
                    try {
                        this.renameTabModal.setLoadingState(true, 'Renaming...');
                        await apiService.updateSessionLink(this.currentSessionId, tab.url, { name: value });
                        // Wait for WebSocket event to update UI, just close modal here
                        this.renameTabModal.hide();
                    } catch (error) {
                        console.error('[TabManager] Failed to rename link on server:', error);
                        try {
                            notificationDisplay?.show?.({ notification_type: 'error', title: 'Rename Failed', message: 'Failed to rename tab. Please try again.' }, { duration: 5000 });
                        } catch (_) {}
                        this.renameTabModal.setLoadingState(false);
                    }
                } else if (!tab.url) {
                    // Local-only tab (no URL yet): update immediately
                    tab.title = value;
                    const tabButton = this.tabsContainer.querySelector(`[data-tab-id="${tab.id}"]`);
                    if (tabButton) {
                        const titleElement = tabButton.querySelector('.terminal-tab-title');
                        if (titleElement) titleElement.textContent = value;
                    }
                    this.renameTabModal.hide();
                }
            }
        });
        // Reset target and loading state on hide
        this.renameTabModal.on('hide', () => {
            try { this.renameTabModal.setLoadingState(false); } catch (_) {}
            this._renameTabTarget = null;
        });
        return this.renameTabModal;
    }

    _showRenameTabModal(tab) {
        const modal = this._ensureRenameTabModal();
        this._renameTabTarget = tab || null;
        try { modal.setFieldValue('name', (tab?.title || 'Link')); } catch (_) { modal.setValue?.(tab?.title || 'Link'); }
        try { modal.show(); modal.focus?.(); modal.selectAll?.(); } catch (_) { modal.show(); }
    }
    
    async removeTabFromSession(tab) {
        // Remove from server session data first
        if (tab.url && this.currentSessionId) {
            try {
                console.log(`[TabManager] Sending remove request to server for link: ${tab.url}`);
                
                // Call the API to remove the link from the server
                await apiService.removeSessionLink(this.currentSessionId, tab.url);
                
                console.log(`[TabManager] Remove request sent successfully`);
                
                // Close the tab locally after successful server update
                this.closeTab(tab.id);
                
                // The server will send a 'link-removed' event via WebSocket
                // which will trigger any necessary UI updates
                
            } catch (error) {
                console.error(`[TabManager] Failed to remove link from session ${this.currentSessionId}:`, error);
                try {
                    notificationDisplay?.show?.({ notification_type: 'error', title: 'Remove Failed', message: 'Failed to remove tab from session. Please try again.' }, { duration: 5000 });
                } catch (_) {}
            }
        } else {
            // If no URL (new tab that was never loaded), just close locally
            this.closeTab(tab.id);
        }
    }

    async addLinkToSession(url, title, refresh = false) {
        try {
            const linkData = [{
                url: url,
                name: title || url,
                refresh_on_view: !!refresh
            }];
            
            console.log(`[TabManager] Adding link to session ${this.currentSessionId}:`, linkData);
            
            await apiService.addSessionLinks(this.currentSessionId, linkData);
            
            console.log(`[TabManager] Successfully added link to session ${this.currentSessionId}`);
            
            // The server will send a 'links-added' event via WebSocket
            // which will trigger any necessary UI updates
            
        } catch (error) {
            console.error(`[TabManager] Failed to add link to session ${this.currentSessionId}:`, error);
            // Don't show error to user as the tab still works locally
        }
    }

}
