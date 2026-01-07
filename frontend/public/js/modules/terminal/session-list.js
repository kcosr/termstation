/**
 * Session List Component
 * Manages the list of terminal sessions in the sidebar
 */

import { apiService } from '../../services/api.service.js';
import { queueStateSet } from '../../core/state-store/batch.js';
import { getStateStore } from '../../core/state-store/index.js';
import { SessionStatusManager } from './session-status.js';
import { SessionContextMenu } from './session-context-menu.js';
import { SessionModals } from './session-modals.js';
import { SessionFilterService } from './session-filter-service.js';
import { computeVisibleSessions } from './selectors/visible-sessions.js';
import { appStore } from '../../core/store.js';
import { computeDisplayTitle } from '../../utils/title-utils.js';
import { delegate } from '../../utils/delegate.js';
import { getContext } from '../../core/context.js';
import { parseColor, getContrastColor } from '../../utils/color-utils.js';
import { iconUtils } from '../../utils/icon-utils.js';

export class SessionList {
    constructor(container, manager) {
        this.container = container;
        this.manager = manager;
        this.store = appStore;
        this.sessions = new Map(); // Maps session_id -> DOM element (for DOM management)
        this.activeSessionId = null;
        this.unsubscribe = null;
        this.templateColors = new Map(); // Cache for template colors
        this.stickyTerminatedSessions = new Set(); // Sessions to keep visible after termination
        // Track prior activity state per session to support fade-out on transition to inactive
        this._lastActiveOutput = new Map();
        
        // Initialize specialized managers
        this.statusManager = new SessionStatusManager();
        this.contextMenu = new SessionContextMenu(this, container);
        
        // Drag and drop state
        this.draggedSession = null;
        this.dragOverSession = null;
        this.dragOverPosition = null; // 'before' or 'after'
        this.manualOrder = [];
        this.manualOrderByWorkspace = new Map(); // workspaceKey -> ordered session_ids array
        
        // Setup container-level drag events for dropping at the end
        this.setupContainerDragEvents();
        this.modals = new SessionModals();
        
        this.loadPinnedSessions();
        this.loadManualOrder();
        this.initializeStore();
        this.setupStoreSubscription();
        this._lastPublishedOrder = [];
        
        // Load templates early for colors
        this.loadTemplatesForColors();

        // Delegated events for dynamic list interactions
        this.bindDelegatedEvents();

        // Track per-parent child containers so we can update them efficiently
        this._childContainers = new Map(); // Map<parentId, HTMLElement>

        // Listen for container child session lifecycle to update sidebar children under parents
        this.bindChildSessionEvents();
    }

    // Compatibility helpers for legacy callers (server-state + local flags drive indicator)
    setActivityIndicator(sessionId, isOn) {
        // Legacy entry point retained for compatibility; activity is driven by
        // server-sent session_activity events and tracked in the store.
    }

    clearActivityIndicator(sessionId) {
        try {
            if (!sessionId) return;
            const state = this.store.getState() || {};
            const sessionListState = state.sessionList || {};
            const currentMap = sessionListState.activityStoppedWhileHidden;
            let nextMap = null;

            if (currentMap instanceof Map) {
                if (!currentMap.has(sessionId)) return;
                nextMap = new Map(currentMap);
                nextMap.delete(sessionId);
            } else if (currentMap && typeof currentMap === 'object') {
                const entries = Object.entries(currentMap);
                let changed = false;
                nextMap = new Map();
                for (const [key, value] of entries) {
                    if (key === String(sessionId)) {
                        if (value) changed = true;
                        continue;
                    }
                    if (value) nextMap.set(key, true);
                }
                if (!changed) return;
            } else {
                return;
            }

            this.store.setPath('sessionList.activityStoppedWhileHidden', nextMap);
            // Some consumers rely on lastUpdate to trigger re-render
            try { this.store.setPath('sessionList.lastUpdate', Date.now()); } catch (_) {}
        } catch (_) { /* ignore */ }
    }

    

    /**
     * Apply a manual order from the server without persisting or re-calling the API.
     * Used by sessions_reordered handler to keep local manualOrder in sync.
     */
    applyManualOrderFromServer(ids, workspace = null) {
        try {
            const arr = Array.isArray(ids) ? ids.filter(Boolean) : [];
            const targetWorkspace = workspace || this.getWorkspaceForManualOrder();
            const key = this.normalizeWorkspaceKey(targetWorkspace);
            this.manualOrderByWorkspace.set(key, [...arr]);

            const activeWorkspace = this.getWorkspaceForManualOrder();
            const activeKey = this.normalizeWorkspaceKey(activeWorkspace);
            if (activeKey === key) {
                this.manualOrder = this.manualOrderByWorkspace.get(key) || [];
                // Trigger re-render to publish visibleOrder and refresh tabs
                this.store.setPath('sessionList.lastUpdate', Date.now());
                if (this.manager && this.manager.sessionTabsManager) {
                    this.manager.sessionTabsManager.refresh();
                }
            }

            this.saveManualOrder();
        } catch (e) {
            console.warn('[SessionList] applyManualOrderFromServer failed:', e);
        }
    }

    bindDelegatedEvents() {
        const root = this.container;
        if (!root) return;

        // Dedicated buttons: fork and load history
        delegate(root, '.relaunch-btn, .fork-btn', 'click', (e, btn) => {
            e.stopPropagation();
            const sid = btn.closest('.session-item')?.dataset?.sessionId;
            if (sid && this.manager) {
                if (typeof this.manager.forkSession === 'function') {
                    this.manager.forkSession(sid);
                }
            }
        });

        delegate(root, '.load-history-btn', 'click', (e, btn) => {
            e.stopPropagation();
            const sid = btn.closest('.session-item')?.dataset?.sessionId;
            if (sid && this.manager && typeof this.manager.loadSessionHistory === 'function') {
                this.manager.loadSessionHistory(sid);
            }
        });

        // Session item selection
        delegate(root, '.session-item', 'click', async (e, item) => {
            // Ignore clicks on actionable children handled above
            if (e.target.closest('.relaunch-btn') || e.target.closest('.fork-btn') || e.target.closest('.load-history-btn')) return;
            if (this.contextMenu?.isContextMenuOpen && this.contextMenu.isContextMenuOpen()) return;
            const sid = item.getAttribute('data-session-id') || item.dataset.sessionId;
            if (!sid) return;
            // If the session is inactive/terminated, do not open from sidebar; use History page instead
            const sessionData = this.getFreshSessionData(sid, this.getSessionData(sid));

            // If this session has a dedicated desktop window open, focus it instead of switching locally
            try {
                if (window.desktop && window.desktop.isElectron && typeof window.desktop.getSessionWindow === 'function' && typeof window.desktop.focusSessionWindow === 'function') {
                    const info = await window.desktop.getSessionWindow(sid);
                    if (info && info.ok && info.windowId) {
                        try { await window.desktop.focusSessionWindow(sid); } catch (_) {}
                        const app = getContext()?.app;
                        app?.closeSidebarOverlay?.();
                        // Do not change selection locally; bringing the dedicated window to front fulfills the action
                        return;
                    }
                }
            } catch (_) { /* fall through to local selection */ }

            // Default behavior: enter the session's workspace (if different) then select the session
            if (this.manager) {
                try {
                    // Signal to TerminalManager which session should remain selected through re-renders
                    this.manager.pendingManualSelectionId = sid;
                    const ws = (sessionData && (sessionData.workspace || 'Default')) || 'Default';
                    if (typeof this.manager.enterWorkspace === 'function') {
                        if (!this.manager.currentWorkspace || this.manager.currentWorkspace !== ws) {
                            this.manager.enterWorkspace(ws);
                        }
                    }
                } catch (_) {}
                if (typeof this.manager.activateSession === 'function') {
                    this.manager.activateSession(sid, { manualClick: true });
                } else if (typeof this.manager.selectSession === 'function') {
                    this.manager.selectSession(sid, { manualClick: true });
                }
                // Ensure sidebar reflects selection after any re-render from workspace switch
                try { setTimeout(() => this.setActiveSession(sid), 0); } catch (_) {}
            }
            const app = getContext()?.app;
            app?.closeSidebarOverlay?.({ focusTerminal: true });
        });

        // Click on a container/login child sub-entry should navigate to parent session and that child tab
        delegate(root, '.session-child-item', 'click', async (e, childEl) => {
            // Prevent parent handler from also firing
            e.stopPropagation();
            const parentId = childEl.getAttribute('data-parent-id');
            const childId = childEl.getAttribute('data-child-id');
            if (!parentId || !childId) return;

            try {
                // Ensure we’re in the correct workspace for the parent session
                const parentData = this.getFreshSessionData(parentId, this.getSessionData(parentId));
                const ws = (parentData && (parentData.workspace || 'Default')) || 'Default';
                if (this.manager && typeof this.manager.enterWorkspace === 'function') {
                    if (!this.manager.currentWorkspace || this.manager.currentWorkspace !== ws) {
                        this.manager.enterWorkspace(ws);
                    }
                }
            } catch (_) {}

            try {
                // Select the parent session first
                if (this.manager && typeof this.manager.activateSession === 'function') {
                    this.manager.pendingManualSelectionId = parentId;
                    await this.manager.activateSession(parentId, { manualClick: true });
                } else if (this.manager && typeof this.manager.selectSession === 'function') {
                    this.manager.pendingManualSelectionId = parentId;
                    await this.manager.selectSession(parentId, { manualClick: true });
                }
                // After switching session, activate the container tab for the child
                setTimeout(() => {
                    try {
                        const tabMgr = this.manager?.getTabManager?.();
                        // Ensure the tab exists; TabManager will no-op if already present
                        const child = this.manager?.childSessions?.get?.(childId);
                        if (tabMgr && child) {
                            try { tabMgr.ensureContainerTab(parentId, child); } catch (_) {}
                            try { tabMgr.activateContainerTab(parentId, childId); } catch (_) {}
                        }
                        // Clear any prior parent's child highlight and then apply immediate highlight feedback
                        try {
                            const prevParent = this.activeSessionId && this.activeSessionId !== parentId ? this.activeSessionId : null;
                            if (prevParent) this.setActiveChildHighlight(prevParent, null);
                        } catch (_) {}
                        this.setActiveChildHighlight(parentId, childId);
                    } catch (_) {}
                }, 0);
            } catch (err) {
                console.warn('[SessionList] Failed to navigate to child container tab:', err);
            }

            const app = getContext()?.app;
            app?.closeSidebarOverlay?.({ focusTerminal: true });
        });

        // Context menu on child sub-entry: open the normal session menu for the child session
        delegate(root, '.session-child-item', 'contextmenu', (e, childEl) => {
            e.preventDefault();
            try {
                const childId = childEl.getAttribute('data-child-id') || childEl.dataset.childId;
                if (!childId) return;
                const data = this.manager?.childSessions?.get?.(childId) || { session_id: childId };
                if (this.contextMenu && typeof this.contextMenu.show === 'function') {
                    this.contextMenu.show(e.pageX, e.pageY, data);
                }
            } catch (_) {}
        });

        // Context menu (right-click)
        delegate(root, '.session-item', 'contextmenu', (e, item) => {
            e.preventDefault();
            const sid = item.getAttribute('data-session-id') || item.dataset.sessionId;
            if (!sid) return;
            const fresh = this.getFreshSessionData(sid, this.getSessionData(sid));
            if (this.contextMenu && typeof this.contextMenu.show === 'function') {
                this.contextMenu.show(e.pageX, e.pageY, fresh);
            }
        });

        // Long-press for context menu on touch devices
        const longPressTimers = new Map();
        delegate(root, '.session-item', 'touchstart', (e, item) => {
            const sid = item.getAttribute('data-session-id') || item.dataset.sessionId;
            if (!sid) return;
            const touch = e.touches && e.touches[0];
            longPressTimers.set(item, setTimeout(() => {
                const fresh = this.getFreshSessionData(sid, this.getSessionData(sid));
                const x = touch ? touch.pageX : 0;
                const y = touch ? touch.pageY : 0;
                try { e.preventDefault(); } catch(_){}
                if (this.contextMenu && typeof this.contextMenu.show === 'function') {
                    this.contextMenu.show(x, y, fresh);
                }
            }, 500));
        }, { passive: true });
        delegate(root, '.session-item', 'touchmove', (e, item) => {
            const t = longPressTimers.get(item);
            if (t) { clearTimeout(t); longPressTimers.delete(item); }
        }, { passive: true });
        delegate(root, '.session-item', 'touchend', (e, item) => {
            const t = longPressTimers.get(item);
            if (t) { clearTimeout(t); longPressTimers.delete(item); }
        }, { passive: true });
    }
    
    addSession(sessionData, prepend = false, applyFilter = true) {
        if (sessionData && sessionData.parent_session_id) {
            // Child sessions render as tabs inside their parent and should not appear in the sidebar
            return;
        }
        // Add session to store
        const currentSessions = this.store.getState().sessionList.sessions;
        const newSessions = new Map(currentSessions);
        const sessionClone = { ...sessionData };
        newSessions.set(sessionClone.session_id, sessionClone);
        this.store.setPath('sessionList.sessions', newSessions);
        
        // The render method will handle DOM updates through store subscription
        if (applyFilter) {
            // Trigger re-render by updating a timestamp (forces reactive update)
            this.store.setPath('sessionList.lastUpdate', Date.now());
        }
        
        if (sessionClone.__stickyTerminated) {
            this.stickyTerminatedSessions.add(sessionClone.session_id);
        } else {
            this.stickyTerminatedSessions.delete(sessionClone.session_id);
        }

        // Update template filters when adding a session
        if (this.manager && this.manager.updateAvailableTemplateFilters) {
            this.manager.updateAvailableTemplateFilters();
        }
    }
    
    updateSession(sessionData) {
        const sessionId = sessionData.session_id;

        if (sessionData && sessionData.parent_session_id) {
            this.removeSession(sessionId);
            return;
        }

        // Update session in store
        const currentSessions = this.store.getState().sessionList.sessions;
        if (currentSessions.has(sessionId)) {
            const newSessions = new Map(currentSessions);
            const prev = currentSessions.get(sessionId) || {};
            // Merge updates to preserve fields (e.g., links) when omitted
            let merged = { ...prev, ...sessionData };
            if (sessionData.links === undefined) merged.links = prev.links;
            if (sessionData.note === undefined) merged.note = prev.note;
            if (sessionData.note_version === undefined) merged.note_version = prev.note_version;
            if (sessionData.note_updated_at === undefined) merged.note_updated_at = prev.note_updated_at;
            if (sessionData.note_updated_by === undefined) merged.note_updated_by = prev.note_updated_by;
            // Preserve dynamic_title unless explicitly set; allow persisting on reload
            if (!Object.prototype.hasOwnProperty.call(sessionData, 'dynamic_title')) {
                merged.dynamic_title = prev.dynamic_title;
            }

            const isTerminated = merged.is_active === false;
            const hasStickyFlag = merged.__stickyTerminated === true || prev.__stickyTerminated === true;

            if (isTerminated && hasStickyFlag) {
                merged.__stickyTerminated = true;
                this.stickyTerminatedSessions.add(sessionId);
            } else if (isTerminated && this.stickyTerminatedSessions.has(sessionId)) {
                merged.__stickyTerminated = true;
            } else {
                if (merged.__stickyTerminated) {
                    const { __stickyTerminated, ...rest } = merged;
                    merged = { ...rest };
                }
                this.stickyTerminatedSessions.delete(sessionId);
            }

            newSessions.set(sessionId, merged);
            this.store.setPath('sessionList.sessions', newSessions);
            
            // Optional: debug logging via toggles can be added here if needed
            
            // Update template filters when updating a session
            if (this.manager && this.manager.updateAvailableTemplateFilters) {
                this.manager.updateAvailableTemplateFilters();
            }
        } else {
            console.warn(`[SessionList] Cannot update session ${sessionId} - session not found in store`);
        }
    }
    
    removeSession(sessionId) {
        // Remove session from store
        const currentSessions = this.store.getState().sessionList.sessions;
        if (currentSessions.has(sessionId)) {
            const newSessions = new Map(currentSessions);
            newSessions.delete(sessionId);
            this.store.setPath('sessionList.sessions', newSessions);
            this.stickyTerminatedSessions.delete(sessionId);
            
            // Remove from pinned sessions if it was pinned
            const pinnedSessions = this.store.getState().sessionList.filters.pinnedSessions;
            if (pinnedSessions.has(sessionId)) {
                const newPinned = new Set(pinnedSessions);
                newPinned.delete(sessionId);
                this.store.setPath('sessionList.filters.pinnedSessions', newPinned);
                this.savePinnedSessions();
            }
            
            // Clear active session if it was the removed one
            if (this.store.getState().sessionList.activeSessionId === sessionId) {
                this.store.setPath('sessionList.activeSessionId', null);
            }
            
            // Update template filters when removing a session
            if (this.manager && this.manager.updateAvailableTemplateFilters) {
                this.manager.updateAvailableTemplateFilters();
            }
        }
    }
    
    async setActiveSession(sessionId) {
        // Local selection only; do not focus dedicated windows from the main window
        // Clear any child highlight from the previously active parent session
        try {
            const prevId = this.activeSessionId;
            if (prevId && prevId !== sessionId) {
                this.setActiveChildHighlight(prevId, null);
            }
        } catch (_) {}
        
        // Update active session in store
        this.store.setPath('sessionList.activeSessionId', sessionId);
        this.activeSessionId = sessionId;

        // Selecting a session counts as viewing it; clear any pending
        // "stopped while hidden" indicator for this session.
        try { this.clearActivityIndicator(sessionId); } catch (_) {}
        
        // The render method will handle DOM updates
        // but we need to ensure immediate visual feedback
        this.updateActiveSessionDisplay(sessionId);
    }

    updateActiveSessionDisplay(sessionId) {
        // Remove selection classes from all items
        this.sessions.forEach(item => {
            item.classList.remove('active');
            item.classList.remove('selected');
        });
        
        // Add active class to selected item (if sessionId is not null)
        if (sessionId) {
            const sessionItem = this.sessions.get(sessionId);
            if (sessionItem) {
                // Keep legacy 'active' for backward compatibility and add explicit 'selected'
                sessionItem.classList.add('active');
                sessionItem.classList.add('selected');
                // Ensure the active session is visible in the scrollable list
                sessionItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }
    
    clear() {
        // Clear store state
        this.store.setPath('sessionList.sessions', new Map());
        this.store.setPath('sessionList.activeSessionId', null);
        this.store.setPath('sessionList.activityStoppedWhileHidden', new Map());
        
        // Clear DOM
        this.container.innerHTML = '';
        this.sessions.clear();
        this.activeSessionId = null;
        this.stickyTerminatedSessions.clear();
        // Note: We don't clear pinnedSessions here as they persist across reloads
    }
    
    formatPath(path) {
        // Shorten long paths
        const homePath = '/home/';
        if (path.startsWith(homePath)) {
            const afterHome = path.substring(homePath.length);
            const parts = afterHome.split('/');
            if (parts.length > 0) {
                return `~/${parts.slice(1).join('/')}`;
            }
        }
        
        // Truncate very long paths
        if (path.length > 30) {
            return '...' + path.substring(path.length - 27);
        }
        
        return path;
    }
    
    updateSessionClientCount(sessionId, clientCount, connectedClientIds = []) {
        const currentSessions = this.store.getState().sessionList.sessions;
        const sessionData = currentSessions.get(sessionId);
        
        if (sessionData && sessionData.is_active) {
            // Update session data with new client count
            const updatedSessionData = {
                ...sessionData,
                connected_client_count: clientCount,
                connected_client_ids: connectedClientIds
            };
            
            const newSessions = new Map(currentSessions);
            newSessions.set(sessionId, updatedSessionData);
            this.store.setPath('sessionList.sessions', newSessions);
            
            console.log(`[SessionList] updateSessionClientCount for ${sessionId}: clientCount=${clientCount}`);
        }
    }

    
    markSessionAsTerminated(sessionId) {
        const currentSessions = this.store.getState().sessionList.sessions;
        const sessionData = currentSessions.get(sessionId);
        
        if (sessionData) {
            console.log(`[SessionList] Marking session ${sessionId} as terminated (was is_active=${sessionData.is_active})`);
            
            // Update the session data to mark it as inactive
            const updatedSessionData = { ...sessionData, is_active: false, __stickyTerminated: true };
            const newSessions = new Map(currentSessions);
            newSessions.set(sessionId, updatedSessionData);
            this.store.setPath('sessionList.sessions', newSessions);
            this.stickyTerminatedSessions.add(sessionId);
            
            console.log(`[SessionList] After termination: is_active=${updatedSessionData.is_active}`);
            
            // Update template filters when terminating a session to remove unused templates
            if (this.manager && this.manager.updateAvailableTemplateFilters) {
                this.manager.updateAvailableTemplateFilters();
            }
        }
    }
    
    setFilter(filter) {
        this.store.setPath('sessionList.filters.status', filter);
    }
    
    setSearchFilter(search) {
        this.store.setPath('sessionList.filters.search', search);
    }
    
    setTemplateFilter(template) {
        this.store.setPath('sessionList.filters.template', template);
    }
    
    setPinnedFilter(pinned) {
        this.store.setPath('sessionList.filters.pinned', pinned);
    }
    
    /**
     * Reactive render method - updates DOM based on store state
     */
    render() {
        const state = this.store.getState().sessionList;
        if (!state) return;
        const { activeSessionId } = state;
        const manualOrder = this.getActiveManualOrder();
        let sortedSessions = computeVisibleSessions(state, { manualOrder });

        // Keep the current session and sticky terminated sessions visible even if filters would hide them.
        // Preserve their relative ordering by projecting the final list from the "all" view instead of
        // simply appending them to the bottom of the current filter.
        try {
            const sessionsMap = state.sessions instanceof Map ? state.sessions : new Map();
            const stickySet = this.stickyTerminatedSessions instanceof Set ? this.stickyTerminatedSessions : new Set();
            const needsExtras = stickySet.size > 0 || (activeSessionId && sessionsMap.has(activeSessionId) && (sessionsMap.get(activeSessionId)?.is_active === false));

            if (needsExtras) {
                const allState = {
                    ...state,
                    filters: { ...state.filters, status: 'all' }
                };
                const allSorted = computeVisibleSessions(allState, { manualOrder });

                // Build the set of IDs we want to show: those already visible under the current filter,
                // plus sticky terminated sessions and the current session (even when terminated).
                const baseIds = Array.isArray(sortedSessions)
                    ? new Set(sortedSessions.map(s => s.session_id))
                    : new Set();
                const extraIds = new Set(stickySet);
                if (activeSessionId) extraIds.add(activeSessionId);
                const includeIds = new Set([...baseIds, ...extraIds]);

                // Rebuild the visible list in the order produced by the "all" view so that sticky
                // terminated sessions stay where they were instead of jumping to the bottom.
                const finalList = [];
                allSorted.forEach((session) => {
                    if (includeIds.has(session.session_id)) {
                        finalList.push(session);
                    }
                });

                sortedSessions = finalList;
            }
        } catch (_) {}

        // Publish exact visible order for other views (tabs)
        try {
            const orderIds = Array.isArray(sortedSessions)
                ? Array.from(new Set(sortedSessions.map(s => s.session_id)))
                : [];
            this.store.setPath('sessionList.visibleOrder', orderIds);
            this._lastPublishedOrder = Array.isArray(orderIds) ? [...orderIds] : [];
        } catch (_) {}

        // Update DOM efficiently
        const pinnedSessions = state.filters?.pinnedSessions || new Set();
        this.updateDOM(sortedSessions, activeSessionId, pinnedSessions);
        
        // Always refresh session tabs to reflect filtered sessions
        if (this.manager && this.manager.sessionTabsManager) {
            this.manager.sessionTabsManager.refresh();
        }
    }

    /**
     * Compute visible sessions in the final order used by the sidebar (and tabs)
     * - Respects filteredIds overlay if present (e.g., content search)
     * - Applies remaining filters (status, template, pinned, workspace)
     * - Applies manual order or default sort consistently
     */
    getVisibleSessionsForCurrentFilters() {
        const state = this.store.getState().sessionList;
        if (!state) return [];
        const manualOrder = this.getActiveManualOrder();
        return computeVisibleSessions(state, { manualOrder });
    }
    
    /**
     * Efficiently update DOM elements based on filtered/sorted sessions
     */
    updateDOM(sortedSessions, activeSessionId, pinnedSessions) {
        // Create a Set of session IDs that should be visible
        const visibleSessionIds = new Set(sortedSessions.map(s => s.session_id));
        
        // Hide sessions that shouldn't be visible
        this.sessions.forEach((sessionItem, sessionId) => {
            if (!visibleSessionIds.has(sessionId)) {
                sessionItem.style.display = 'none';
            }
        });
        
        // Update visible sessions and maintain order
        let lastElement = null;
        sortedSessions.forEach((sessionData, index) => {
            const sessionId = sessionData.session_id;
            let sessionItem = this.sessions.get(sessionId);
            
            // Create element if it doesn't exist
            if (!sessionItem) {
                sessionItem = this.createSessionElement(sessionData, pinnedSessions, index + 1);
                this.sessions.set(sessionId, sessionItem);
                // Now that the element is registered and in DOM, render any children
                try { this.renderChildrenForParent(sessionId); } catch (_) {}
            } else {
                // Update existing element
                this.updateSessionElement(sessionItem, sessionData, pinnedSessions, index + 1);
            }
            
            // Ensure correct order in DOM
            if (lastElement) {
                if (lastElement.nextSibling !== sessionItem) {
                    this.container.insertBefore(sessionItem, lastElement.nextSibling);
                }
            } else {
                if (this.container.firstChild !== sessionItem) {
                    this.container.insertBefore(sessionItem, this.container.firstChild);
                }
            }
            
            // Show the element
            sessionItem.style.display = 'flex';
            
            // Update selected/active state
            const isSelected = sessionId === activeSessionId;
            sessionItem.classList.toggle('active', isSelected);
            sessionItem.classList.toggle('selected', isSelected);
            // Activity change class removed; indicator now driven by server state only
            
            lastElement = sessionItem;
        });
    }
    
    /**
     * Create a new session element
     */
    createSessionElement(sessionData, pinnedSessions, displayNumber = null) {
        const sessionItem = document.createElement('div');
        sessionItem.className = 'session-item';
        sessionItem.dataset.sessionId = sessionData.session_id;
        sessionItem.draggable = true;
        
        this.updateSessionElement(sessionItem, sessionData, pinnedSessions, displayNumber);
        this.attachEventListeners(sessionItem, sessionData);
        this.attachDragEventListeners(sessionItem, sessionData);
        
        return sessionItem;
    }
    
    /**
     * Update an existing session element
     */
    updateSessionElement(sessionItem, sessionData, pinnedSessions, displayNumber = null) {
        // Check if this session is pinned
        const isPinned = pinnedSessions.has(sessionData.session_id);
        let showChildPref = true;
        try {
            showChildPref = this.store.getState().preferences?.display?.showContainerShellsInSidebar === true;
        } catch (_) {
            showChildPref = false;
        }
        
        // Format session info
        const shortId = sessionData.session_id.substring(0, 8);
        const command = sessionData.command || '/bin/bash';
        const directory = this.formatPath(sessionData.working_directory);
        const createdDate = new Date(sessionData.created_at * 1000);
        const time = createdDate.toLocaleDateString() + ' ' + createdDate.toLocaleTimeString();
        const templateName = sessionData.template_name;
        
        // Calculate session status using StatusManager
        const currentClientId = this.manager ? this.manager.clientId : null;
        const connectedSessionId = this.manager ? this.manager.connectedSessionId : null;
        const displayInfo = this.statusManager.calculateDisplayInfo(sessionData, currentClientId, connectedSessionId);
        
        const { statusHtml, sessionClass } = displayInfo;
        
        // Update classes
        sessionItem.className = 'session-item';
        if (isPinned) {
            sessionItem.classList.add('pinned');
        }
        sessionItem.classList.add(sessionClass);
        if (!showChildPref) {
            sessionItem.classList.add('session-children-hidden');
        }
        
        const pinIconHtml = isPinned ? '<svg class="pin-indicator" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" title="Pinned"><path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A6 6 0 0 1 5 6.708V2.277a3 3 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354Z"/></svg>' : '';
        
        // Create template badge and title on separate lines
        let templateHtml = '';
        if (templateName) {
            templateHtml = this.createTemplateBadgeHtml(templateName);
        } else {
            templateHtml = this.createCommandBadgeHtml();
        }
        // Local-only indicator (determine from session data; do not depend on desktop bridge presence)
        const isLocalOnly = !!(sessionData && sessionData.local_only === true);
        if (isLocalOnly) {
            try { sessionItem.classList.add('session-local'); } catch (_) {}
            // Replace the default Command badge text with Local for local-only sessions
            templateHtml = this.createCommandBadgeHtml('Local');
        }
        
        // No outer slot; slot will be included inside .session-template markup
        const effectiveTitle = computeDisplayTitle(sessionData, { fallbackOrder: [], defaultValue: '' });
        const titleHtml = effectiveTitle ? `<div class="session-title">${effectiveTitle}</div>` : '';
        
        sessionItem.innerHTML = `
            ${pinIconHtml}
            <div class="session-info">
                ${templateHtml}
                ${titleHtml}
                <div class="session-command">${command}</div>
                <div class="session-details">
                    <span class="session-id">${shortId}</span>
                    <span class="session-directory">${directory}</span>
                </div>
                <div class="session-time">${time}</div>
                <div class="session-children" data-parent-id="${sessionData.session_id}"></div>
            </div>
            <div class="session-status">
                ${statusHtml}
            </div>
        `;

        // Append indicators
        this.appendActivityIndicator(sessionItem, sessionData);
        this.appendVisibilityIcon(sessionItem, sessionData);

        // Render any child container/login sessions under this parent
        try { this.renderChildrenForParent(sessionData.session_id); } catch (_) {}

        // Append small numeric indicator on the right for the first 9 visible sessions
        try {
            const n = Number(displayNumber);
            if (Number.isFinite(n) && n >= 1 && n <= 9) {
                const statusEl = sessionItem.querySelector('.session-status');
                if (statusEl) {
                    const num = document.createElement('span');
                    num.className = 'session-number-label';
                    num.textContent = String(n);
                    try { num.setAttribute('aria-hidden', 'true'); } catch (_) {}
                    try { num.title = `Shortcut: Cmd/Alt+${n}`; } catch (_) {}
                    statusEl.appendChild(num);
                }
            }
        } catch (_) {}
    }
    
    /**
     * Attach event listeners to a session element
     */
    attachEventListeners(sessionItem, sessionData) {
        // Keep minimal mousedown handler to stop propagation for nested controls if needed
        sessionItem.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
    }
    
    showSetTitleModal(sessionData) {
        this.modals.showSetTitleModal(sessionData, (sessionId, newTitle) => {
            this.updateSessionTitle(sessionId, newTitle);
        });
    }
    
    
    updateSessionTitle(sessionId, title) {
        const currentSessions = this.store.getState().sessionList.sessions;
        const sessionData = currentSessions.get(sessionId);
        if (sessionData) {
            // Parent session title update
            const updatedSessionData = { ...sessionData, title };
            const newSessions = new Map(currentSessions);
            newSessions.set(sessionId, updatedSessionData);
            this.store.setPath('sessionList.sessions', newSessions);
            try { this.render(); } catch (_) {}
            // Only refresh the header if this session is currently selected in this window
            try {
                if (this.manager && this.manager.currentSessionId === sessionId) {
                    // Call without args to refresh using the current session context
                    this.manager.refreshHeaderForSession();
                }
            } catch (_) {}
            return;
        }

        // Child session title update
        try {
            const isChild = typeof this.manager?.isChildSession === 'function' ? this.manager.isChildSession(sessionId) : false;
            if (isChild) {
                // Event-based behavior: child label updates arrive via WebSocket and are handled in TerminalManager.handleSessionUpdate()
            }
        } catch (_) {}
    }
    
    async toggleSaveHistory(sessionData) {
        const newSaveHistory = !(sessionData.save_session_history !== false);
        try {
            await apiService.setSessionSaveHistory(sessionData.session_id, newSaveHistory);
            
            // Update session data in store
            const currentSessions = this.store.getState().sessionList.sessions;
            const updatedSessionData = { ...sessionData, save_session_history: newSaveHistory };
            const newSessions = new Map(currentSessions);
            newSessions.set(sessionData.session_id, updatedSessionData);
            this.store.setPath('sessionList.sessions', newSessions);
            
            console.log(`Updated save_session_history for ${sessionData.session_id}: ${newSaveHistory}`);
        } catch (error) {
            console.error('Failed to update save_session_history:', error);
        }
    }
    
    initializeStore() {
        // Initialize session-related state in store if not present
        const currentState = this.store.getState();
        if (!currentState.sessionList) {
            this.store.setState({
                sessionList: {
                    sessions: new Map(),
                    filters: {
                        status: 'active',
                        search: '',
                        template: 'all',
                        pinned: false,
                        pinnedSessions: new Set(),
                        workspace: null
                    },
                    activeSessionId: null,
                    sortBy: 'created',
                    sortOrder: 'desc',
                    activityState: new Map(),
                    // Sessions where output became inactive while not being viewed
                    activityStoppedWhileHidden: new Map()
                }
            });
        }
    }

    setupStoreSubscription() {
        // Subscribe to session list state changes
        this.unsubscribe = this.store.subscribe('sessionList', (newState, prevState) => {
            this.render();
        });
    }

    loadPinnedSessions() {
        try {
            let saved = null;
            try {
                const res = getStateStore().loadSync && getStateStore().loadSync();
                const st = res && res.ok ? (res.state || {}) : {};
                saved = st['terminal_pinned_sessions'];
            } catch (_) {}
            const pinnedArray = Array.isArray(saved) ? saved : (typeof saved === 'string' ? (() => { try { return JSON.parse(saved); } catch { return []; } })() : []);
            const pinnedSet = new Set(pinnedArray);
            this.store.setPath('sessionList.filters.pinnedSessions', pinnedSet);
        } catch (error) {
            console.error('Failed to load pinned sessions:', error);
            this.store.setPath('sessionList.filters.pinnedSessions', new Set());
        }
    }
    
    savePinnedSessions() {
        try {
            const pinnedSessions = this.store.getState().sessionList.filters.pinnedSessions;
            const pinned = Array.from(pinnedSessions);
            try { queueStateSet('terminal_pinned_sessions', pinned, 200); } catch (_) {}
        } catch (error) {
            console.error('Failed to save pinned sessions:', error);
        }
    }
    
    togglePinSession(sessionId) {
        const currentPinned = this.store.getState().sessionList.filters.pinnedSessions;
        const newPinned = new Set(currentPinned);
        
        if (newPinned.has(sessionId)) {
            newPinned.delete(sessionId);
            console.log(`[SessionList] Unpinning session ${sessionId}`);
        } else {
            newPinned.add(sessionId);
            console.log(`[SessionList] Pinning session ${sessionId}`);
        }
        
        this.store.setPath('sessionList.filters.pinnedSessions', newPinned);
        this.savePinnedSessions();
    }
    
    isPinned(sessionId) {
        const pinnedSessions = this.store.getState().sessionList.filters.pinnedSessions;
        return pinnedSessions.has(sessionId);
    }

    bindChildSessionEvents() {
        try {
            const bus = this.manager && this.manager.eventBus;
            if (!bus || !bus.on) return;
            const rerender = (payload) => {
                try {
                    const parentId = (payload && (payload.parentId || payload.parent_id)) || null;
                    if (!parentId) return;
                    this.renderChildrenForParent(parentId);
                } catch (_) {}
            };
            bus.on('container-session:added', rerender);
            bus.on('container-session:updated', rerender);
            bus.on('container-session:removed', rerender);
            bus.on('container-session:refresh', rerender);
            // Highlight active child when container tab is activated via any source
            // Note: We don't rerender on activate, just update the highlight
            bus.on('container-session:activate', ({ parentId, sessionId }) => {
                try { this.setActiveChildHighlight(parentId, sessionId); } catch (_) {}
            });
            // Track tab switches to keep child highlight in sync
            bus.on('tab-switched', (data = {}) => {
                try {
                    const tab = data.tab || {};
                    if (tab.type === 'container' && tab.childSessionId) {
                        const childId = String(tab.childSessionId);
                        const parentId = this.manager?.childSessions?.get?.(childId)?.parent_session_id || tab.sessionId || this.manager?.currentSessionId || null;
                        // Clear prior parent's child highlight if switching away
                        try {
                            const prevParent = this.activeSessionId != null ? String(this.activeSessionId) : null;
                            const normalizedParent = parentId != null ? String(parentId) : null;
                            if (prevParent && prevParent !== normalizedParent) {
                                this.setActiveChildHighlight(prevParent, null);
                            }
                        } catch (_) {}
                        this.setActiveChildHighlight(parentId, childId);
                    } else {
                        // Any non-child tab should clear child highlights for the active parent session
                        try {
                            const parentId = tab.sessionId != null ? String(tab.sessionId) : null;
                            const prevParent = this.activeSessionId != null ? String(this.activeSessionId) : null;
                            if (parentId) {
                                this.setActiveChildHighlight(parentId, null);
                            }
                            if (prevParent && prevParent !== parentId) {
                                this.setActiveChildHighlight(prevParent, null);
                            }
                        } catch (_) {}
                    }
                } catch (_) {}
            });
            bus.on('container-session:reset', () => {
                try { this._childContainers.clear(); } catch (_) {}
                // Re-render all currently visible parents
                try {
                    const state = this.store.getState().sessionList;
                    const sessions = state?.sessions instanceof Map ? state.sessions : new Map();
                    sessions.forEach((_, pid) => this.renderChildrenForParent(pid));
                } catch (_) {}
            });
            // Preference changes are centrally handled by TerminalManager.refreshSidebarChildrenForPreference()
        } catch (_) { /* non-fatal */ }
    }

    setActiveChildHighlight(parentId, childId) {
        try {
            if (!parentId) return;
            const parentEl = this.sessions.get(parentId) || this.container.querySelector(`.session-item[data-session-id="${parentId}"]`);
            if (!parentEl) return;
            const box = parentEl.querySelector('.session-children');
            if (!box) return;
            // Clear existing
            box.querySelectorAll('.session-child-item.active').forEach(el => el.classList.remove('active'));
            if (childId) {
                const el = box.querySelector(`.session-child-item[data-child-id="${childId}"]`);
                if (el) el.classList.add('active');
            }
        } catch (_) {}
    }

    getChildContainer(parentId) {
        if (!parentId) return null;
        // Prefer cached element; fall back to querying the DOM (in case cache is not yet populated)
        let parentEl = this.sessions.get(parentId);
        try {
            if (!parentEl) {
                parentEl = this.container.querySelector(`.session-item[data-session-id="${parentId}"]`);
            }
        } catch (_) {}
        if (!parentEl) return null;
        let container = parentEl.querySelector('.session-children');
        if (!container) {
            container = document.createElement('div');
            container.className = 'session-children';
            container.dataset.parentId = parentId;
            const info = parentEl.querySelector('.session-info');
            if (info) info.appendChild(container); else parentEl.appendChild(container);
        }
        this._childContainers.set(parentId, container);
        return container;
    }

    renderChildrenForParent(parentId) {
        try {
            if (!parentId) return;
            // Respect preference: show only when explicitly enabled
            let showPref = false;
            try { showPref = this.store.getState().preferences?.display?.showContainerShellsInSidebar === true; } catch (_) { showPref = false; }

            // Find an existing container without creating a new one when hidden
            let parentEl = this.sessions.get(parentId);
            try { if (!parentEl) parentEl = this.container.querySelector(`.session-item[data-session-id="${parentId}"]`); } catch (_) {}
            let container = parentEl ? parentEl.querySelector('.session-children') : null;
            // Debug logging removed
            if (parentEl) {
                try { parentEl.classList.toggle('session-children-hidden', !showPref); } catch (_) {}
            }
            if (!showPref) {
                return;
            }

            // Ensure container exists when showing
            container = container || this.getChildContainer(parentId);
            if (!container) return;

            // Clear existing entries
            container.innerHTML = '';

            // Collect child sessions in order from TerminalManager
            const children = (this.manager && typeof this.manager.getChildSessions === 'function')
                ? (this.manager.getChildSessions(parentId) || [])
                : [];
            if (!children || children.length === 0) {
                return; // nothing to render
            }

            children.forEach((child, idx) => {
                if (!child || !child.session_id) return;
                const el = this.createChildItemElement(parentId, child, idx);
                if (el) container.appendChild(el);
            });

            // Re-apply active highlight after rendering (in case DOM was rebuilt)
            try {
                const tabMgr = this.manager?.getTabManager?.();
                const saved = tabMgr?.getSavedTabId?.(parentId) || null;
                if (saved && saved.startsWith('container-')) {
                    const childId = saved.substring('container-'.length);
                    this.setActiveChildHighlight(parentId, childId);
                }
            } catch (_) {}
        } catch (e) {
            console.warn('[SessionList] Failed to render child sessions for parent', parentId, e);
        }
    }

    createChildItemElement(parentId, childData, index = 0) {
        try {
            const childId = childData.session_id;
            const name = String(childData.title || childData.container_name || '').trim();
            const label = name || (index >= 0 ? `Shell ${index + 1}` : 'Shell');
            const isActive = childData.is_active !== false;
            const el = document.createElement('div');
            el.className = 'session-child-item';
            el.dataset.parentId = parentId;
            el.dataset.childId = childId;
            el.setAttribute('draggable', 'true');

            // Activity indicator slot + title + status
            const statusHtml = isActive ? '' : '<span class="session-child-ended">Ended</span>';
            el.innerHTML = `
                <span class="activity-slot" aria-hidden="true"></span>
                <span class="session-child-title">${String(label)}</span>
                ${statusHtml}
            `;

            // Append pulsing activity indicator for the child session (reuses main-session logic)
            this.appendChildActivityIndicator(el, childData);

            // Click behavior: handled via delegated handler; add a simple mousedown stop to avoid parent selection on drag
            el.addEventListener('mousedown', (evt) => { evt.stopPropagation(); });

            // Drag behavior: proxy to parent session row (dragging child moves the whole session)
            this.attachChildDragHandlers(el, parentId);

            // Mark selected child when its container tab is the saved active tab for the parent
            try {
                const tabMgr = this.manager?.getTabManager?.();
                const saved = tabMgr?.getSavedTabId?.(parentId) || null;
                if (saved && saved === `container-${childId}` && this.store.getState().sessionList.activeSessionId === parentId) {
                    el.classList.add('active');
                }
            } catch (_) {}

            return el;
        } catch (e) {
            console.warn('[SessionList] Failed to create child item element:', e);
            return null;
        }
    }

    /**
     * Append or update the activity indicator for a child session row element
     * Mirrors appendActivityIndicator but targets a child session element
     */
    appendChildActivityIndicator(childEl, childData) {
        try {
            if (!childEl || !childData) return;
            const container = childEl; // childEl is the row container
            const slot = container.querySelector('.activity-slot');
            let dot = container.querySelector('.activity-indicator');

            // Respect global preference (same toggle as main sessions)
            let showPref = true;
            try { showPref = this.store.getState().preferences?.display?.showActivityIndicator !== false; } catch (_) { showPref = true; }

            // Child activity is tracked in the same activityState map keyed by session_id
            let isActiveOutput = false;
            let hasStoppedWhileHidden = false;
            try {
                const st = this.store.getState();
                const stMap = st?.sessionList?.activityState;
                if (stMap instanceof Map) isActiveOutput = !!stMap.get(childData.session_id);
                else if (stMap && typeof stMap === 'object') isActiveOutput = !!stMap[childData.session_id];
                const stoppedMap = st?.sessionList?.activityStoppedWhileHidden;
                if (stoppedMap instanceof Map) hasStoppedWhileHidden = !!stoppedMap.get(childData.session_id);
                else if (stoppedMap && typeof stoppedMap === 'object') hasStoppedWhileHidden = !!stoppedMap[childData.session_id];
            } catch (_) {}

            const isLive = childData && childData.is_active !== false;
            const sid = childData && childData.session_id;
            const wasActive = !!this._lastActiveOutput.get(sid);
            const showPulsing = showPref && isActiveOutput && isLive;
            const showStatic = showPref && !showPulsing && hasStoppedWhileHidden && isLive;

            if (showPulsing || showStatic) {
                if (!dot) {
                    dot = document.createElement('span');
                    dot.className = 'activity-indicator status-indicator active';
                    try { dot.setAttribute('aria-hidden', 'true'); } catch(_) {}
                    if (slot) {
                        slot.appendChild(dot);
                    } else {
                        container.insertBefore(dot, container.firstChild || null);
                    }
                }
                // Pulse to indicate activity; show static indicator when output stopped while hidden
                if (showPulsing) {
                    dot.classList.remove('pending');
                    dot.classList.add('connected');
                } else {
                    dot.classList.remove('connected');
                    dot.classList.add('pending');
                }
                dot.classList.add('active');
                this._lastActiveOutput.set(sid, true);
            } else {
                // Inactive: fade-out then remove like main sessions
                if (dot) {
                    dot.classList.remove('connected');
                    dot.classList.remove('pending');
                    if (!wasActive) {
                        try { dot.remove(); } catch (_) {}
                    } else {
                        dot.classList.add('active');
                        requestAnimationFrame(() => {
                            try { dot.classList.remove('active'); } catch (_) {}
                        });
                        try {
                            const removeAfter = () => { try { dot.remove(); } catch (_) {} };
                            dot.addEventListener('transitionend', removeAfter, { once: true });
                            setTimeout(removeAfter, 250);
                        } catch (_) {
                            setTimeout(() => { try { dot.remove(); } catch (_) {} }, 250);
                        }
                    }
                } else if (wasActive && showPref) {
                    // If DOM rebuilt, insert a temporary dot just to animate the fade-out
                    try {
                        const temp = document.createElement('span');
                        temp.className = 'activity-indicator status-indicator active';
                        temp.setAttribute('aria-hidden', 'true');
                        if (slot) { slot.appendChild(temp); } else { container.insertBefore(temp, container.firstChild || null); }
                        requestAnimationFrame(() => { try { temp.classList.remove('active'); } catch (_) {} });
                        const removeTemp = () => { try { temp.remove(); } catch (_) {} };
                        try {
                            temp.addEventListener('transitionend', removeTemp, { once: true });
                            setTimeout(removeTemp, 250);
                        } catch (_) {
                            setTimeout(removeTemp, 250);
                        }
                    } catch (_) {}
                }
                this._lastActiveOutput.set(sid, false);
            }
        } catch (_) { /* ignore */ }
    }

    attachChildDragHandlers(childEl, parentId) {
        // Start dragging as the parent session
        childEl.addEventListener('dragstart', (e) => {
            try { e.stopPropagation(); } catch (_) {}
            this.draggedSession = parentId;
            const parentEl = this.sessions.get(parentId);
            if (parentEl) parentEl.classList.add('dragging');
            try { e.dataTransfer.setData('text/plain', parentId); } catch (_) {}
            try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
            // Make the drag preview look like the parent session row, not the child
            try {
                const rect = parentEl ? parentEl.getBoundingClientRect() : null;
                const offsetX = rect ? (e.clientX - rect.left) : 0;
                const offsetY = rect ? (e.clientY - rect.top) : 0;
                if (parentEl && typeof e.dataTransfer.setDragImage === 'function') {
                    e.dataTransfer.setDragImage(parentEl, Math.max(0, offsetX), Math.max(0, offsetY));
                }
            } catch (_) {}
        });

        childEl.addEventListener('dragend', (e) => {
            try { e.stopPropagation(); } catch (_) {}
            const parentEl = this.sessions.get(parentId);
            if (parentEl) parentEl.classList.remove('dragging');
            this.draggedSession = null;
            this.dragOverSession = null;
            this.dragOverPosition = null;
            try {
                this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(item => {
                    item.classList.remove('drag-over-before', 'drag-over-after');
                });
            } catch (_) {}
        });

        // While dragging over a child, compute before/after using the parent row’s rect
        childEl.addEventListener('dragover', (e) => {
            if (!this.draggedSession) return;
            try { e.preventDefault(); } catch (_) {}
            try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
            const parentEl = this.sessions.get(parentId);
            if (!parentEl) return;
            const rect = parentEl.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            // Remove previous indicators
            try { this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(item => item.classList.remove('drag-over-before', 'drag-over-after')); } catch (_) {}
            if (e.clientY < midpoint) {
                parentEl.classList.add('drag-over-before');
                this.dragOverPosition = 'before';
            } else {
                parentEl.classList.add('drag-over-after');
                this.dragOverPosition = 'after';
            }
            this.dragOverSession = parentId;
        });

        childEl.addEventListener('dragleave', () => {
            const parentEl = this.sessions.get(parentId);
            if (parentEl) parentEl.classList.remove('drag-over-before', 'drag-over-after');
        });

        childEl.addEventListener('drop', (e) => {
            if (!this.draggedSession) return;
            try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
            const targetId = this.dragOverSession || parentId;
            const pos = this.dragOverPosition || 'before';
            if (targetId && this.draggedSession && this.draggedSession !== targetId) {
                this.handleDrop(this.draggedSession, targetId, pos);
            }
            const parentEl = this.sessions.get(parentId);
            if (parentEl) parentEl.classList.remove('drag-over-before', 'drag-over-after');
            this.draggedSession = null;
            this.dragOverSession = null;
            this.dragOverPosition = null;
        });
    }
    
    /**
     * Get session data from store
     */
    getSessionData(sessionId) {
        const sessions = this.store.getState().sessionList.sessions;
        return sessions.get(sessionId);
    }
    
    /**
     * Get fresh session data from store with fallback
     */
    getFreshSessionData(sessionId, fallbackData = null) {
        return this.getSessionData(sessionId) || fallbackData;
    }
    
    /**
     * Get all session data from store
     */
    getAllSessions() {
        return this.store.getState().sessionList.sessions;
    }

    /**
     * Snapshot current sticky terminated sessions for later restoration
     * Used when the sidebar reloads sessions to keep sticky entries visible
     */
    getStickyTerminatedSessionsSnapshot() {
        const snapshots = [];
        try {
            const stickySet = this.stickyTerminatedSessions instanceof Set ? this.stickyTerminatedSessions : new Set();
            stickySet.forEach(sessionId => {
                const data = this.getSessionData(sessionId);
                if (!data) return;
                // Do not persist local-only terminated sessions across reloads.
                // For local sessions, we want them to remain visible until a reload
                // (to mirror server-side sticky behavior), and then disappear.
                // Server-backed sessions (non-local) should continue to be snapshotted.
                const isLocalOnly = !!(data && data.local_only === true);
                if (isLocalOnly) return;
                snapshots.push({ ...data, __stickyTerminated: true, is_active: false });
            });
        } catch (_) {}
        return snapshots;
    }
    
    /**
     * Create template badge HTML with color support
     */
    createTemplateBadgeHtml(templateName) {
        // Try to get template color and label
        let color = this.templateColors.get(templateName);
        let label = templateName;

        // If not cached, try to get from available templates
        const template = this.getTemplateByName(templateName);
        if (template) {
            if (!color && template.color) {
                color = template.color;
                this.templateColors.set(templateName, color);
            }
            if (typeof template.badge_label === 'string' && template.badge_label.trim()) {
                label = template.badge_label.trim();
            }
        }

        const badgeStyle = color ? this.getTemplateBadgeStyle(color) : '';

        return `<div class="session-template"><span class="activity-slot" aria-hidden="true"></span><span class="visibility-icon-slot" aria-hidden="true"></span><span class="template-badge"${badgeStyle}>${label}</span></div>`;
    }

    createCommandBadgeHtml(label = 'Command') {
        const fallbackColor = '#f5f5f5';
        const badgeStyle = this.getTemplateBadgeStyle(fallbackColor);
        const text = typeof label === 'string' && label.trim() ? label.trim() : 'Command';
        return `<div class="session-template"><span class="activity-slot" aria-hidden="true"></span><span class="visibility-icon-slot" aria-hidden="true"></span><span class="template-badge"${badgeStyle}>${text}</span></div>`;
    }

    appendVisibilityIcon(sessionItem, sessionData) {
        try {
            // Do not show visibility icons for local-only sessions
            if (sessionData && sessionData.local_only === true) return;
            // Prefer inserting into the dedicated slot BEFORE the template badge inside session-template
            const badgeContainer = sessionItem.querySelector('.session-template');
            const slot = sessionItem.querySelector('.session-template .visibility-icon-slot')
                || sessionItem.querySelector('.visibility-icon-slot');
            if (!slot && !badgeContainer) return;
            const visibility = sessionData.visibility || 'private';
            const owner = String(sessionData.created_by || '');
            const currentUser = (this.manager && typeof this.manager.getCurrentUsername === 'function')
                ? String(this.manager.getCurrentUsername() || '')
                : String((appStore.getState()?.preferences?.auth?.username) || '');
            const isOwner = !!currentUser && currentUser === owner;
            let iconName = null;
            let title = '';
            if (visibility === 'shared_readonly') {
                if (isOwner) { iconName = 'people'; title = 'Shared (read-only)'; }
                else { iconName = 'person-slash'; title = `Read-only (${owner})`; }
            } else if (visibility === 'public') {
                // Show globe for both owner and non-owner
                iconName = 'globe';
                title = isOwner ? 'Public (full access)' : `Public (${owner})`;
            } else if (visibility === 'private') {
                // Only show lock for other users' private sessions to avoid clutter
                if (!isOwner) { iconName = 'lock'; title = `Private (${owner})`; }
            }
            if (iconName) {
                const el = iconUtils.createIcon(iconName, { size: 14, className: 'visibility-icon', title });
                if (slot) {
                    slot.appendChild(el);
                } else if (badgeContainer) {
                    // Fallback: insert before the badge inside the container
                    try { badgeContainer.insertBefore(el, badgeContainer.firstChild || null); } catch (_) {}
                }
            }
        } catch (_) {}
    }

    /**
     * Append or update the activity indicator (dot) before the template badge
     * Temporarily always displayed for confirmation; shows green for active, red for terminated
     */
    appendActivityIndicator(sessionItem, sessionData) {
        try {
            const container = sessionItem.querySelector('.session-template');
            if (!container) return;
            const slot = container.querySelector('.activity-slot');
            let dot = container.querySelector('.activity-indicator');
            // Respect user preference to show/hide the indicator (default ON)
            let showPref = true;
            try { showPref = this.store.getState().preferences?.display?.showActivityIndicator !== false; } catch (_) { showPref = true; }
            // Show pulsing indicator when marked active by server state; show
            // a static variant when output previously stopped while session
            // was not being viewed.
            let isActiveOutput = false;
            let hasStoppedWhileHidden = false;
            try {
                const st = this.store.getState();
                const stMap = st?.sessionList?.activityState;
                if (stMap instanceof Map) isActiveOutput = !!stMap.get(sessionData.session_id);
                else if (stMap && typeof stMap === 'object') isActiveOutput = !!stMap[sessionData.session_id];
                const stoppedMap = st?.sessionList?.activityStoppedWhileHidden;
                if (stoppedMap instanceof Map) hasStoppedWhileHidden = !!stoppedMap.get(sessionData.session_id);
                else if (stoppedMap && typeof stoppedMap === 'object') hasStoppedWhileHidden = !!stoppedMap[sessionData.session_id];
            } catch (_) {}
            const isLive = sessionData && sessionData.is_active !== false;
            const sid = sessionData && sessionData.session_id;
            const wasActive = !!this._lastActiveOutput.get(sid);
            const showPulsing = showPref && isActiveOutput && isLive;
            const showStatic = showPref && !showPulsing && hasStoppedWhileHidden && isLive;

            if (showPulsing || showStatic) {
                if (!dot) {
                    dot = document.createElement('span');
                    dot.className = 'activity-indicator status-indicator active';
                    try { dot.setAttribute('aria-hidden', 'true'); } catch(_) {}
                    if (slot) {
                        slot.appendChild(dot);
                    } else {
                        container.insertBefore(dot, container.firstChild || null);
                    }
                }
                // Ensure correct state class for pulsing vs static indicator
                if (showPulsing) {
                    dot.classList.remove('pending');
                    dot.classList.add('connected');
                } else {
                    dot.classList.remove('connected');
                    dot.classList.add('pending');
                }
                // Ensure visible during active/static state
                dot.classList.add('active');
                this._lastActiveOutput.set(sid, true);
            } else {
                // Not active: fade out the indicator before removing
                if (dot) {
                    // Stop pulsing and mark as inactive
                    dot.classList.remove('connected');
                    dot.classList.remove('pending');
                    // If it was not previously active, remove immediately; otherwise fade out
                    if (!wasActive) {
                        try { dot.remove(); } catch (_) {}
                    } else {
                        // Ensure it's currently visible, then drop to 0 opacity next frame
                        dot.classList.add('active');
                        requestAnimationFrame(() => {
                            try { dot.classList.remove('active'); } catch (_) {}
                        });
                        // Remove after transition completes
                        try {
                            const removeAfter = () => { try { dot.remove(); } catch (_) {} };
                            dot.addEventListener('transitionend', removeAfter, { once: true });
                            // Always set a timeout backup in case transitionend doesn't fire
                            setTimeout(removeAfter, 250);
                        } catch (_) {
                            // Fallback: timed removal
                            setTimeout(() => { try { dot.remove(); } catch (_) {} }, 250);
                        }
                    }
                } else if (wasActive && showPref) {
                    // If DOM was rebuilt and we lost the dot, insert a temporary one just to animate fade-out
                    try {
                        const temp = document.createElement('span');
                        temp.className = 'activity-indicator status-indicator active';
                        temp.setAttribute('aria-hidden', 'true');
                        if (slot) { slot.appendChild(temp); } else { container.insertBefore(temp, container.firstChild || null); }
                        requestAnimationFrame(() => { try { temp.classList.remove('active'); } catch (_) {} });
                        try {
                            const removeTemp = () => { try { temp.remove(); } catch (_) {} };
                            temp.addEventListener('transitionend', removeTemp, { once: true });
                            // Timeout backup to ensure cleanup
                            setTimeout(removeTemp, 250);
                        } catch (_) {
                            setTimeout(() => { try { temp.remove(); } catch (_) {} }, 250);
                        }
                    } catch (_) {}
                }
                this._lastActiveOutput.set(sid, false);
            }
        } catch (_) {}
    }
    
    /**
     * Get template by name from available templates
     */
    getTemplateByName(templateName) {
        if (!this.manager || !this.manager.formManager || !this.manager.formManager.availableTemplates) {
            return null;
        }
        
        return this.manager.formManager.availableTemplates.find(template => template.name === templateName);
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
     * Load templates early for color support
     */
    async loadTemplatesForColors() {
        if (this.manager && this.manager.formManager) {
            try {
                await this.manager.formManager.loadTemplates();
                // Refresh template colors cache and re-render if needed
                this.templateColors.clear();
                this.render();
            } catch (error) {
                console.warn('Failed to load templates for colors:', error);
            }
        }
    }
    
    /**
     * Manual order management methods
     * 
     * When manual ordering is active:
     * 1. Pinned sessions always appear first
     * 2. Manually ordered sessions appear next in their saved order
     * 3. New sessions (not in manual order) appear at the bottom,
     *    sorted by creation date descending (newest first)
     */
    getWorkspaceForManualOrder() {
        const state = this.store?.getState?.() || {};
        const sessionListState = state.sessionList || {};

        const filterWorkspace = sessionListState?.filters?.workspace;
        if (filterWorkspace && filterWorkspace !== 'all' && filterWorkspace !== 'All Workspaces') {
            return filterWorkspace;
        }

        if (this.manager && this.manager.currentWorkspace) {
            return this.manager.currentWorkspace;
        }

        // Default workspace identifier when none is selected
        return 'Default';
    }

    normalizeWorkspaceKey(workspace) {
        if (!workspace || workspace === 'all' || workspace === 'All Workspaces') {
            return '__global__';
        }
        return workspace;
    }

    getActiveManualOrderKey() {
        const workspace = this.getWorkspaceForManualOrder();
        const key = this.normalizeWorkspaceKey(workspace);
        if (!this.manualOrderByWorkspace.has(key)) {
            this.manualOrderByWorkspace.set(key, []);
        }
        return key;
    }

    getActiveManualOrder() {
        const key = this.getActiveManualOrderKey();
        const order = this.manualOrderByWorkspace.get(key) || [];
        this.manualOrder = order;
        return order;
    }

    hasManualOrder() {
        const order = this.getActiveManualOrder();
        return order && order.length > 0;
    }

    sortByManualOrder(sessions, pinnedSessions) {
        const manualOrder = this.getActiveManualOrder();
        return sessions.sort((a, b) => {
            // Pinned sessions always come first
            const aPinned = pinnedSessions.has(a.session_id);
            const bPinned = pinnedSessions.has(b.session_id);

            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return 1;

            // Use manual order for sorting
            const aIndex = manualOrder.indexOf(a.session_id);
            const bIndex = manualOrder.indexOf(b.session_id);
            
            // If both are in manual order, sort by order
            if (aIndex !== -1 && bIndex !== -1) {
                return aIndex - bIndex;
            }
            
            // If only one is in manual order, it comes first
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            
            // If neither is in manual order, sort by creation date descending
            // This means new sessions appear at the top of the unordered section
            return (b.created_at || 0) - (a.created_at || 0);
        });
    }
    
    updateManualOrder(newOrder) {
        const workspaceKey = this.getActiveManualOrderKey();
        const order = Array.isArray(newOrder) ? newOrder.filter(Boolean) : [];
        this.manualOrderByWorkspace.set(workspaceKey, [...order]);
        this.manualOrder = this.manualOrderByWorkspace.get(workspaceKey) || [];
        this.saveManualOrder();
        // Trigger re-render
        this.store.setPath('sessionList.lastUpdate', Date.now());

        // Refresh session tabs to reflect the new order
        if (this.manager && this.manager.sessionTabsManager) {
            this.manager.sessionTabsManager.refresh();
        }
        try { this.manager?.updateSessionTabs?.(); } catch (_) {}

        // Persist workspace order to the backend when operating within a workspace
        try {
            const workspace = (this.manager && this.manager.currentWorkspace) ? this.manager.currentWorkspace : null;
            if (workspace) {
                // Enforce pinned-first rule to match render sorting
                const pinnedSet = this.store.getState().sessionList?.filters?.pinnedSessions || new Set();
                let ids = [...order];
                const pinnedIds = ids.filter(id => pinnedSet.has(id));
                const unpinnedIds = ids.filter(id => !pinnedSet.has(id));
                ids = [...pinnedIds, ...unpinnedIds];
                // Filter to sessions that actually belong to this workspace
                try {
                    const sessionsMap = this.store.getState().sessionList?.sessions || new Map();
                    ids = ids.filter(id => {
                        const data = sessionsMap.get(id);
                        const ws = (data && (data.workspace || 'Default')) || 'Default';
                        return ws === workspace;
                    });
                    // If the order contains any local-only sessions, skip server persistence
                    const hasLocalOnly = ids.some(id => {
                        const data = sessionsMap.get(id);
                        return data && data.local_only === true;
                    });
                    if (hasLocalOnly) {
                        // UI already updated optimistically via updateManualOrder + state persistence
                        return;
                    }
                } catch (_) {}

                // Fire-and-forget API call; UI already updated optimistically
                apiService.reorderWorkspaceSessions(workspace, ids).catch((e) => {
                    console.warn('[SessionList] Failed to persist reorder:', e);
                });
            }
        } catch (e) {
            // Non-fatal; keep UI updated locally
            try { console.warn('[SessionList] persist reorder error:', e); } catch (_) {}
        }
    }
    
    clearManualOrder() {
        const workspaceKey = this.getActiveManualOrderKey();
        this.manualOrderByWorkspace.set(workspaceKey, []);
        this.manualOrder = [];
        this.saveManualOrder();
        // Trigger re-render
        this.store.setPath('sessionList.lastUpdate', Date.now());
    }
    
    loadManualOrder() {
        try {
            let saved = null;
            try {
                const res = getStateStore().loadSync && getStateStore().loadSync();
                const st = res && res.ok ? (res.state || {}) : {};
                saved = st['terminal_manual_order'];
            } catch (_) {}
            if (typeof saved === 'string') {
                try {
                    saved = JSON.parse(saved);
                } catch (_) {
                    saved = null;
                }
            }

            this.manualOrderByWorkspace = new Map();

            if (saved && typeof saved === 'object') {
                Object.entries(saved).forEach(([workspaceKey, order]) => {
                    if (!Array.isArray(order)) return;
                    const normalizedKey = this.normalizeWorkspaceKey(workspaceKey);
                    const filtered = order.filter(Boolean);
                    this.manualOrderByWorkspace.set(normalizedKey, [...filtered]);
                });
            }

            const activeKey = this.getActiveManualOrderKey();
            if (!this.manualOrderByWorkspace.has(activeKey)) {
                this.manualOrderByWorkspace.set(activeKey, []);
            }
            this.manualOrder = this.manualOrderByWorkspace.get(activeKey) || [];
        } catch (error) {
            console.error('Failed to load manual order:', error);
            this.manualOrderByWorkspace = new Map();
            const fallbackKey = this.getActiveManualOrderKey();
            this.manualOrderByWorkspace.set(fallbackKey, []);
            this.manualOrder = [];
        }
    }

    saveManualOrder() {
        try {
            const payload = {};
            this.manualOrderByWorkspace.forEach((order, workspaceKey) => {
                if (Array.isArray(order) && order.length > 0) {
                    payload[workspaceKey] = Array.from(order);
                }
            });
            try { queueStateSet('terminal_manual_order', payload, 200); } catch (_) {}
        } catch (error) {
            console.error('Failed to save manual order:', error);
        }
    }
    
    moveSessionToTop(sessionId) {
        const currentOrder = this.getCurrentVisibleOrder();
        const index = currentOrder.indexOf(sessionId);
        if (index > 0) {
            currentOrder.splice(index, 1);
            currentOrder.unshift(sessionId);
            this.updateManualOrder(currentOrder);
            
            // Refresh session tabs to reflect the new order
            if (this.manager && this.manager.sessionTabsManager) {
                this.manager.sessionTabsManager.refresh();
            }
        }
    }
    
    moveSessionToBottom(sessionId) {
        const currentOrder = this.getCurrentVisibleOrder();
        const index = currentOrder.indexOf(sessionId);
        if (index !== -1 && index < currentOrder.length - 1) {
            currentOrder.splice(index, 1);
            currentOrder.push(sessionId);
            this.updateManualOrder(currentOrder);
            
            // Refresh session tabs to reflect the new order
            if (this.manager && this.manager.sessionTabsManager) {
                this.manager.sessionTabsManager.refresh();
            }
        }
    }
    
    assignToWorkspace(sessionId, workspace) {
        try {
            const state = this.store.getState();
            const sessionsMap = state?.sessionList?.sessions || new Map();
            const data = sessionsMap.get(sessionId);
            const target = (workspace && workspace.trim()) ? workspace.trim() : 'Default';

            // If this is a local-only session in Electron, perform a local reassignment
            const isElectron = !!(typeof window !== 'undefined' && window.desktop && window.desktop.isElectron);
            if (data && data.local_only === true && isElectron) {
                const prevWs = (data.workspace || 'Default');

                // Update the session's workspace locally
                this.updateSession({ session_id: sessionId, workspace: target });

                // Move id across manual order buckets
                try {
                    const prevKey = this.normalizeWorkspaceKey(prevWs);
                    const nextKey = this.normalizeWorkspaceKey(target);
                    // Ensure both buckets exist
                    if (!this.manualOrderByWorkspace.has(prevKey)) this.manualOrderByWorkspace.set(prevKey, []);
                    if (!this.manualOrderByWorkspace.has(nextKey)) this.manualOrderByWorkspace.set(nextKey, []);

                    // Remove from previous order if present
                    const prevOrder = this.manualOrderByWorkspace.get(prevKey) || [];
                    const filteredPrev = prevOrder.filter(id => id !== sessionId);
                    this.manualOrderByWorkspace.set(prevKey, filteredPrev);

                    // Append to end of target workspace order (after pinned sort will apply on render)
                    const nextOrder = this.manualOrderByWorkspace.get(nextKey) || [];
                    if (!nextOrder.includes(sessionId)) nextOrder.push(sessionId);
                    this.manualOrderByWorkspace.set(nextKey, nextOrder);

                    // Persist updated manual order across workspaces so it survives navigation/reload
                    try { this.saveManualOrder(); } catch (_) {}
                    // Trigger re-render so sidebar/tabs refresh
                    this.store.setPath('sessionList.lastUpdate', Date.now());
                    if (this.manager && this.manager.sessionTabsManager) {
                        try { this.manager.sessionTabsManager.refresh(); } catch (_) {}
                    }
                } catch (_) { /* non-fatal */ }

                // Persist local session workspace association for reload recovery
                try {
                    const res = getStateStore().loadSync && getStateStore().loadSync();
                    const st = res && res.ok ? (res.state || {}) : {};
                    const existing = (st && typeof st['local_session_workspaces'] === 'object') ? st['local_session_workspaces'] : {};
                    const map = Object.assign({}, existing, { [sessionId]: target });
                    try { queueStateSet('local_session_workspaces', map, 0); } catch (_) {}
                } catch (_) { /* ignore */ }

                // Switch view to the target workspace and keep the session selected
                try {
                    if (this.manager && typeof this.manager.enterWorkspace === 'function') {
                        this.manager.enterWorkspace(target);
                    }
                    // Ensure selection persists in the new workspace
                    if (typeof this.setActiveSession === 'function') {
                        this.setActiveSession(sessionId);
                    }
                } catch (_) { /* ignore */ }

                return; // Done locally; skip server call
            }

            // Default server-backed path
            apiService.updateSessionWorkspace(sessionId, target)
                .catch(error => {
                    console.error(`Failed to assign session to workspace:`, error);
                });
        } catch (error) {
            console.error('assignToWorkspace failed:', error);
        }
    }
    
    getCurrentVisibleOrder() {
        // Get current visible sessions in order
        const visibleOrder = [];
        this.container.querySelectorAll('.session-item').forEach(item => {
            if (item.style.display !== 'none') {
                visibleOrder.push(item.dataset.sessionId);
            }
        });
        return visibleOrder;
    }
    
    /**
     * Setup container-level drag events for dropping at the end of the list
     */
    setupContainerDragEvents() {
        // Allow dragging over the container itself
        this.container.addEventListener('dragover', (e) => {
            if (!this.draggedSession) return;
            
            // Check if we're actually in the empty space below all items
            const visibleItems = Array.from(this.container.querySelectorAll('.session-item')).filter(
                item => item.style.display !== 'none'
            );
            
            if (visibleItems.length === 0) return;
            
            const lastItem = visibleItems[visibleItems.length - 1];
            const lastItemRect = lastItem.getBoundingClientRect();
            
            // Only handle if cursor is below the last item
            if (e.clientY > lastItemRect.bottom) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                // Remove all existing drag indicators
                this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(item => {
                    item.classList.remove('drag-over-before', 'drag-over-after');
                });
                
                // Don't add indicator if we're dragging the last item itself
                if (lastItem.dataset.sessionId !== this.draggedSession) {
                    lastItem.classList.add('drag-over-after');
                    this.dragOverSession = lastItem.dataset.sessionId;
                    this.dragOverPosition = 'after';
                }
            }
        });
        
        // Handle drop on container (for end of list)
        this.container.addEventListener('drop', (e) => {
            if (!this.draggedSession) return;
            
            // Check if we're actually in the empty space below all items
            const visibleItems = Array.from(this.container.querySelectorAll('.session-item')).filter(
                item => item.style.display !== 'none'
            );
            
            if (visibleItems.length === 0) return;
            
            const lastItem = visibleItems[visibleItems.length - 1];
            const lastItemRect = lastItem.getBoundingClientRect();
            
            // Only handle if cursor is below the last item
            if (e.clientY > lastItemRect.bottom) {
                e.preventDefault();
                
                // Remove all drag indicators
                this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(item => {
                    item.classList.remove('drag-over-before', 'drag-over-after');
                });
                
                // Move to end of list
                const currentOrder = this.getCurrentVisibleOrder();
                const draggedIndex = currentOrder.indexOf(this.draggedSession);
                
                if (draggedIndex !== -1) {
                    // Remove from current position
                    currentOrder.splice(draggedIndex, 1);
                    // Add to end
                    currentOrder.push(this.draggedSession);
                    // Update manual order and re-render immediately to keep UI in sync
                    this.updateManualOrder(currentOrder);
                    try { this.render(); } catch (_) {}
                }
                
                this.draggedSession = null;
                this.dragOverSession = null;
                this.dragOverPosition = null;
            }
        });
    }
    
    /**
     * Attach drag event listeners to a session element
     */
    attachDragEventListeners(sessionItem, sessionData) {
        // Drag start
        sessionItem.addEventListener('dragstart', (e) => {
            this.draggedSession = sessionData.session_id;
            sessionItem.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', sessionData.session_id);
            // Cross-window drag support: inform desktop main of current drag
            try {
                if (window.desktop && window.desktop.isElectron && window.desktop.drag && typeof window.desktop.drag.startSession === 'function') {
                    const clientId = (this.manager && this.manager.clientId) ? this.manager.clientId : '';
                    window.desktop.drag.startSession(sessionData.session_id, clientId);
                }
            } catch (_) { /* ignore */ }
        });
        
        // Drag end
        sessionItem.addEventListener('dragend', (e) => {
            sessionItem.classList.remove('dragging');
            this.draggedSession = null;
            this.dragOverSession = null;
            this.dragOverPosition = null;
            
            // Remove all drag-over classes
            this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(item => {
                item.classList.remove('drag-over-before', 'drag-over-after');
            });

            // Fallback: if no explicit drop was processed, detect order change by DOM and persist
            try {
                const currentOrder = this.getCurrentVisibleOrder();
                const prev = Array.isArray(this._lastPublishedOrder) ? this._lastPublishedOrder : [];
                const changed = currentOrder.length === prev.length && currentOrder.some((id, idx) => id !== prev[idx]);
                if (changed) {
                    this.updateManualOrder(currentOrder);
                }
            } catch (_) {}
            // Cross-window drag support: clear desktop main drag state
            try { if (window.desktop?.drag?.endSession) window.desktop.drag.endSession(); } catch (_) {}
        });
        
        // Drag over
        sessionItem.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            if (this.draggedSession && this.draggedSession !== sessionData.session_id) {
                const rect = sessionItem.getBoundingClientRect();
                const midpoint = rect.top + rect.height / 2;
                
                // Remove previous drag-over classes
                this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(item => {
                    item.classList.remove('drag-over-before', 'drag-over-after');
                });
                
                // Determine if we're in the top or bottom half
                if (e.clientY < midpoint) {
                    sessionItem.classList.add('drag-over-before');
                    this.dragOverPosition = 'before';
                } else {
                    sessionItem.classList.add('drag-over-after');
                    this.dragOverPosition = 'after';
                }
                
                this.dragOverSession = sessionData.session_id;
            }
        });
        
        // Drag leave
        sessionItem.addEventListener('dragleave', (e) => {
            if (e.target === sessionItem) {
                sessionItem.classList.remove('drag-over-before', 'drag-over-after');
            }
        });
        
        // Drop
        sessionItem.addEventListener('drop', (e) => {
            e.preventDefault();
            sessionItem.classList.remove('drag-over-before', 'drag-over-after');
            
            if (this.draggedSession && this.dragOverSession && this.draggedSession !== this.dragOverSession) {
                this.handleDrop(this.draggedSession, this.dragOverSession, this.dragOverPosition);
            }
        });
    }
    
    handleDrop(draggedId, targetId, position) {
        const currentOrder = this.getCurrentVisibleOrder();
        const draggedIndex = currentOrder.indexOf(draggedId);
        const targetIndex = currentOrder.indexOf(targetId);
        
        if (draggedIndex !== -1 && targetIndex !== -1) {
            // Remove dragged item from its current position
            currentOrder.splice(draggedIndex, 1);
            
            // Calculate new index based on position and whether we're moving up or down
            let newIndex = targetIndex;
            if (position === 'after') {
                // If dragging from above, the target index shifts down after removal
                newIndex = draggedIndex < targetIndex ? targetIndex : targetIndex + 1;
            } else {
                // If dragging from below, use target index directly
                newIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
            }
            
            // Insert at new position
            currentOrder.splice(newIndex, 0, draggedId);
            
            // Update manual order and re-render immediately to keep UI in sync
            this.updateManualOrder(currentOrder);
            try { this.render(); } catch (_) {}
        }
    }
    
    /**
     * Cleanup method
     */
    destroy() {
        if (this.unsubscribe) {
            this.unsubscribe();
        }
    }
}
