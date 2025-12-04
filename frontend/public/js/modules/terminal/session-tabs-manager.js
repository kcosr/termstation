/**
 * Session Tabs Manager
 * Manages the session tabs header that appears above terminal tabs
 */

import { SessionContextMenu } from './session-context-menu.js';
import { getContext } from '../../core/context.js';
import { SessionFilterService } from './session-filter-service.js';
import { parseColor } from '../../utils/color-utils.js';
import { apiService } from '../../services/api.service.js';
import { notificationDisplay } from '../../utils/notification-display.js';
import { computeDisplayTitle } from '../../utils/title-utils.js';
import { config } from '../../core/config.js';
import { getStateStore } from '../../core/state-store/index.js';
import { appStore } from '../../core/store.js';
import { countOtherClients } from '../../utils/clients-utils.js';
import { iconUtils } from '../../utils/icon-utils.js';
import { keyboardShortcuts } from '../shortcuts/keyboard-shortcuts.js';

export class SessionTabsManager {
    constructor(manager) {
        this.manager = manager;
        this.container = document.getElementById('session-tabs-container');
        this.tabsContainer = document.getElementById('session-tabs');
        this._tabsBar = null; // runtime wrapper hosting scroll area + add button
        this.sessionTabs = new Map(); // Map of session-id -> tab element
        this.activeSessionId = null;
        this.isEnabled = false;
        this.templateColors = new Map(); // Cache for template colors
        // Keep verbose debug logs off by default; toggle via window.__SESSION_TABS_DEBUG__ or config flags
        this.debugEnabled = false;
        
        // DnD state for tab reordering
        this.draggedSessionId = null;
        this.dragOverSessionId = null;
        this.dragOverPosition = null; // 'before' | 'after'
        
        // Initialize context menu - we'll pass the sessionList to the context menu
        this.contextMenu = new SessionContextMenu(this.manager.sessionList, this.container);
        this._shortcutDisposers = [];
        this._storeUnsubscribes = [];
        
        this.init();
    }

    debugLog(label, payload) {
        if (!this.debugEnabled) return;
        try {
            if (payload !== undefined) {
                console.log(`[SessionTabs] ${label}:`, payload);
            } else {
                console.log(`[SessionTabs] ${label}`);
            }
        } catch (_) {}
    }

    // Debug logging helpers (toggle via window.__SESSION_TABS_DEBUG__ = true or localStorage 'session_tabs_debug' = '1')
    isDebugDnD() {
        try { if (window && window.__SESSION_TABS_DEBUG__ === true) return true; } catch (_) {}
        try { if (config?.DEBUG_FLAGS?.sessionTabsDnD) return true; } catch (_) {}
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const state = res && res.ok ? (res.state || {}) : {};
            if (state['session_tabs_debug'] === true || state['session_tabs_debug'] === '1') return true;
        } catch (_) {}
        try {
            const res = getStateStore().loadSync && getStateStore().loadSync();
            const st = res && res.ok ? (res.state || {}) : {};
            return (st['session_tabs_debug'] === true || st['session_tabs_debug'] === '1');
        } catch (_) { return false; }
    }
    logDnD(msg, data) {
        if (this.isDebugDnD()) {
            try { console.log('[SessionTabsDnD]', msg, data !== undefined ? data : ''); } catch (_) {}
        }
    }
    
    init() {
        if (!this.container || !this.tabsContainer) {
            console.error('Session tabs: Required DOM elements not found');
            return;
        }
        
        // Setup keyboard shortcuts for Command+Shift+Up/Down
        this.setupKeyboardShortcuts();

        // Listen for links-added event to update session tabs
        this.manager.eventBus.on('links-added', (eventData) => {
            this.handleLinksAdded(eventData);
        });
        
        // Setup container-level drag/drop for whitespace drops
        this.setupContainerDnD();
        // No window resize behavior needed for add button when using flex layout

        // Monitor sidebar-driven order changes and refresh tabs accordingly
        try {
            const store = this.manager?.sessionList?.store;
            if (store && typeof store.subscribe === 'function') {
                const unsub = store.subscribe('sessionList.visibleOrder', () => {
                    this.refresh();
                });
                this._storeUnsubscribes.push(unsub);
            }
        } catch (_) { /* non-fatal */ }
    }
    
    /**
     * Enable session tabs and populate with current sessions
     */
    enable() {
        this.isEnabled = true;
        this.container.style.display = 'block';
        document.body.classList.add('session-tabs-visible');
        this.refresh();
    }
    
    /**
     * Disable and hide session tabs
     */
    disable() {
        this.isEnabled = false;
        this.container.style.display = 'none';
        document.body.classList.remove('session-tabs-visible');
        this.clear();
    }
    
    /**
     * Refresh tabs based on current session list
     */
    refresh() {
        if (!this.isEnabled) return;
        
        // Ensure wrapper bar exists so + sits outside the scroll area but on same row
        this.ensureTabsBar();

        // Get filtered and sorted sessions from the session list
        const sessionList = this.manager.sessionList;
        if (!sessionList) return;
        
        const visibleSessions = this.buildVisibleSessions();

        // Clear and rebuild tabs
        this.clear();
        
        const orderLog = visibleSessions.map(s => s.session_id);
        this.logDnD('refresh visibleSessions order:', orderLog);
        this.debugLog('refresh order', orderLog);

        // Build session tabs first
        visibleSessions.forEach(sessionData => this.addSessionTab(sessionData));

        // Add workspace Notes tab at the end (before the + button) when enabled
        try {
            if (this.manager && this.manager.currentWorkspace) {
                const st = (() => { try { return appStore.getState(); } catch (_) { return {}; } })();
                const featuresEnabled = st?.auth?.features?.notes_enabled === true;
                const prefs = st?.preferences || {};
                const showWs = prefs?.notes?.showWorkspaceTab !== false;
                if (featuresEnabled && showWs) {
                    this.addWorkspaceNotesTab();
                }
            }
        } catch (_) {}
        
        // Add "+" button to create a new session at the end of the row
        this.createAddButton();
        
        // Update active session
        if (this.manager.currentSessionId) {
            this.setActiveSession(this.manager.currentSessionId);
        }
    }
    
    /**
     * Get visible sessions in their current sorted order
     * Uses the same filtering logic as the sidebar to ensure consistency
     */
    getVisibleSessions() {
        const sessions = this.buildVisibleSessions();
        this.debugLog('getVisibleSessions', sessions.map(s => s.session_id));
        return sessions;
    }

    buildVisibleSessions() {
        const state = this.manager.sessionList?.store?.getState()?.sessionList || {};
        const sessionsMap = state.sessions instanceof Map ? state.sessions : new Map();

        try {
            const order = Array.isArray(state.visibleOrder) ? state.visibleOrder : [];
            if (order.length > 0) {
                return order.map(id => sessionsMap.get(id)).filter(Boolean);
            }
        } catch (_) {}

        const fallback = this.manager.sessionList?.getVisibleSessionsForCurrentFilters() || [];
        const merged = this.mergeStickySessions(fallback, sessionsMap, state);
        this.debugLog('buildVisibleSessions fallback', merged.map(s => s.session_id));
        return merged;
    }

    // No direct applyOrder; tabs follow visibleOrder and refresh()

    mergeStickySessions(baseSessions, sessionsMap, state = {}) {
        const result = Array.isArray(baseSessions) ? [...baseSessions] : [];
        const seenIds = new Set(result.map(session => session.session_id));

        const stickySet = this.manager?.sessionList?.stickyTerminatedSessions instanceof Set
            ? this.manager.sessionList.stickyTerminatedSessions
            : null;

        const filters = state.filters || {};

        if (stickySet && stickySet.size > 0) {
            let stickySessions = SessionFilterService.collectStickySessions({
                stickySet,
                sessionsMap,
                filters,
                getSessionData: (id) => {
                    try {
                        return this.manager?.sessionList?.getSessionData?.(id) || null;
                    } catch (_) {
                        return null;
                    }
                }
            });
            // Keep sticky terminated sessions visible regardless of status filter so
            // users can still access per-session tabs (terminal, links, notes) after
            // server-side termination. The sidebar applies its own filters for list
            // visibility, but the tabs bar intentionally includes sticky entries.
            if (stickySessions.length > 0) {
                const pinned = state.filters?.pinnedSessions || new Set();
                if (this.manager.sessionList?.hasManualOrder?.()) {
                    stickySessions = this.manager.sessionList.sortByManualOrder([...stickySessions], pinned);
                } else {
                    stickySessions = SessionFilterService.sort([...stickySessions], pinned, state.sortBy, state.sortOrder);
                }

                stickySessions.forEach(session => {
                    if (!seenIds.has(session.session_id)) {
                        result.push(session);
                        seenIds.add(session.session_id);
                    }
                });
            }
        }

        const currentId = this.manager?.currentSessionId;
        if (currentId && sessionsMap.has(currentId) && !seenIds.has(currentId)) {
            const currentData = sessionsMap.get(currentId);
            if (currentData) {
                result.push(currentData);
            }
        }

        this.debugLog('mergeStickySessions result', result.map(s => s.session_id));
        return result;
    }

    /**
     * Add a session tab
     */
    addSessionTab(sessionData) {
        const tabButton = document.createElement('button');
        tabButton.className = 'session-tab';
        tabButton.dataset.sessionId = sessionData.session_id;
        tabButton.setAttribute('draggable', 'true');
        
        // Create tab title using settings, then fallback to template/command
        const tabTitle = computeDisplayTitle(sessionData, { fallbackOrder: ['template_name','command'], defaultValue: 'Session' });
        
        // Tooltip shows only the raw session ID
        const isTerminated = sessionData.is_active === false;
        const tooltipText = sessionData.session_id || '';
        
        // Get template color for the dot
        const templateColor = this.getTemplateColor(sessionData.template_name);
        const dotColor = templateColor || '#f5f5f5'; // Use off-white fallback for no template
        const colorDotStyle = ` style="background-color: ${dotColor};"`;
        
        // Check if session has links for indicator
        const hasLinks = sessionData.links && sessionData.links.length > 0;
        const linkIndicator = hasLinks ? `<span class="session-tab-link-indicator" title="This session has links">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.354 5.5H4a3 3 0 0 0 0 6h3a3 3 0 0 0 2.83-4H9c-.086 0-.17.01-.25.031A2 2 0 0 1 7 9.5a2 2 0 1 1-.25-3.969c.495-.043.995-.055 1.604-.055zm4.792.813a3 3 0 0 0-2.83-4h-3a3 3 0 1 0 2.83 4h.5a2 2 0 0 1 .25 3.969A2 2 0 0 1 9.5 7a2 2 0 0 1 .604-1.438z"/>
            </svg>
        </span>` : '';
        const terminatedIndicator = isTerminated
            ? '<span class="session-tab-ended" title="Session ended">Ended</span>'
            : '';

        if (isTerminated) {
            tabButton.classList.add('session-tab--terminated');
        }

        tabButton.innerHTML = `
            <span class="session-tab-color-dot"${colorDotStyle}></span>
            <span class="session-tab-title">${this.escapeHtml(tabTitle)}</span>
            ${linkIndicator}
            ${terminatedIndicator}
        `;

        // Right-side status: display icon when other clients are connected
        try {
            const otherCount = countOtherClients(sessionData, this.manager?.clientId || null);
            if (otherCount > 0) {
                const status = document.createElement('span');
                status.className = 'session-tab-status';
                const icon = iconUtils.createIcon('display', {
                    size: 16,
                    className: 'client-display-indicator',
                    title: `${otherCount} other client${otherCount === 1 ? '' : 's'} connected`
                });
                status.appendChild(icon);
                tabButton.appendChild(status);
            }
        } catch (_) {}
        
        // Set native tooltip (browser default font)
        tabButton.title = tooltipText;
        
        // Disable text selection
        tabButton.style.userSelect = 'none';
        tabButton.style.webkitUserSelect = 'none';
        tabButton.style.mozUserSelect = 'none';
        tabButton.style.msUserSelect = 'none';
        
        // Add click handler
        tabButton.addEventListener('click', async () => {
            this.selectSessionAndRestoreTab(sessionData.session_id);
        });
        
        // Add right-click context menu handler
        tabButton.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            // Get fresh session data from store for context menu
            const freshSessionData = this.manager.sessionList.getFreshSessionData(sessionData.session_id, sessionData);
            this.contextMenu.show(e.pageX, e.pageY, freshSessionData);
        });
        
        // Add long press support for mobile
        let longPressTimer = null;
        let longPressTriggered = false;
        
        tabButton.addEventListener('touchstart', (e) => {
            longPressTriggered = false;
            longPressTimer = setTimeout(() => {
                longPressTriggered = true;
                // Get touch coordinates
                const touch = e.touches[0];
                // Get fresh session data from store for context menu
                const freshSessionData = this.manager.sessionList.getFreshSessionData(sessionData.session_id, sessionData);
                this.contextMenu.show(touch.pageX, touch.pageY, freshSessionData);
                // Prevent default behavior and propagation
                e.preventDefault();
                e.stopPropagation();
            }, 500); // 500ms long press
        });
        
        tabButton.addEventListener('touchend', (e) => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            if (longPressTriggered) {
                e.preventDefault();
                e.stopPropagation();
            }
        });
        
        tabButton.addEventListener('touchmove', (e) => {
            // Cancel long press if user moves finger
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }, { passive: true });
        
        this.tabsContainer.appendChild(tabButton);
        this.sessionTabs.set(sessionData.session_id, tabButton);
        
        // Attach drag handlers for reordering
        this.attachTabDnDHandlers(tabButton, sessionData.session_id);
    }
    
    ensureTabsBar() {
        if (!this.container || !this.tabsContainer) return null;
        // If already wrapped, return
        const parent = this.tabsContainer.parentElement;
        if (parent && parent.classList && parent.classList.contains('session-tabs-bar')) {
            this._tabsBar = parent;
            return this._tabsBar;
        }
        // Create bar and move tabs inside
        const bar = document.createElement('div');
        bar.className = 'session-tabs-bar';
        this.container.insertBefore(bar, this.tabsContainer);
        bar.appendChild(this.tabsContainer);
        this._tabsBar = bar;
        return bar;
    }

    /**
     * Clear all tabs
     */
    clear() {
        this.tabsContainer.innerHTML = '';
        this.sessionTabs.clear();
        this.activeSessionId = null;
    }

    /**
     * Create the "+" add button for creating a new session
     */
    createAddButton() {
        const bar = this.ensureTabsBar();
        if (!bar) return;

        // Remove any existing add button first to avoid duplicates
        const existing = bar.querySelector('.session-tab-add');
        if (existing) existing.remove();

        const addBtn = document.createElement('button');
        addBtn.className = 'session-tab-add';
        addBtn.title = 'Create new session';
        // Reuse session-tab-title class for consistent typography
        const title = document.createElement('span');
        title.className = 'session-tab-title';
        title.textContent = '+';
        addBtn.appendChild(title);

        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            try {
                // Open the standard new session modal handled by TerminalManager
                this.manager.showNewSessionModal();
            } catch (err) {
                console.error('[SessionTabsManager] Failed to open new session modal:', err);
                try { notificationDisplay.show('Failed to open new session modal'); } catch (_) {}
            }
        });

        bar.appendChild(addBtn);
    }

    
    setupContainerDnD() {
        if (!this.tabsContainer) return;

        // Allow dropping in whitespace to move to end
        this.tabsContainer.addEventListener('dragover', (e) => {
            if (!this.draggedSessionId) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
        });

        this.tabsContainer.addEventListener('drop', async (e) => {
            if (!this.draggedSessionId) return;
            e.preventDefault();
            // Compute nearest insert position by mouse X so we don't always jump to end
            const insert = this.computeDropTargetByX(e.clientX);
            this.logDnD('container drop', { draggedId: this.draggedSessionId, clientX: e.clientX, insert });
            if (insert && insert.targetId) {
                await this.performReorder(this.draggedSessionId, insert.targetId, insert.position);
            } else {
                await this.performReorder(this.draggedSessionId, null, 'after'); // fallback to end
            }
            this.clearDragIndicators();
        });
    }

    attachTabDnDHandlers(tabEl, sessionId) {
        tabEl.addEventListener('dragstart', (e) => {
            this.draggedSessionId = sessionId;
            this._suppressScrollDuringDnD = true;
            tabEl.classList.add('dragging');
            this.logDnD('dragstart', { draggedId: sessionId });
            try { e.dataTransfer.setData('text/plain', sessionId); } catch (_) {}
            e.dataTransfer.effectAllowed = 'move';
        });

        tabEl.addEventListener('dragend', () => {
            tabEl.classList.remove('dragging');
            this.logDnD('dragend');
            this.draggedSessionId = null;
            this.dragOverSessionId = null;
            this.dragOverPosition = null;
            this._suppressScrollDuringDnD = false;
            this.clearDragIndicators();
        });

        tabEl.addEventListener('dragenter', (e) => {
            if (!this.draggedSessionId || this.draggedSessionId === sessionId) return;
            e.preventDefault();
        });

        tabEl.addEventListener('dragover', (e) => {
            if (!this.draggedSessionId || this.draggedSessionId === sessionId) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
            const rect = tabEl.getBoundingClientRect();
            const midpoint = rect.left + rect.width / 2;
            // Remove indicators from all tabs first
            this.clearDragIndicators();
            if (e.clientX < midpoint) {
                tabEl.classList.add('drag-over-before');
                this.dragOverPosition = 'before';
            } else {
                tabEl.classList.add('drag-over-after');
                this.dragOverPosition = 'after';
            }
            this.dragOverSessionId = sessionId;
            // Throttle logs by only logging when state changes
            this.logDnD('dragover', { over: sessionId, position: this.dragOverPosition, x: e.clientX, midpoint });
        });

        tabEl.addEventListener('drop', async (e) => {
            if (!this.draggedSessionId) return;
            e.preventDefault();
            e.stopPropagation();
            const target = this.dragOverSessionId || sessionId;
            const pos = this.dragOverPosition || 'before';
            this.logDnD('drop on tab', { draggedId: this.draggedSessionId, target, pos });
            await this.performReorder(this.draggedSessionId, target, pos);
            this.clearDragIndicators();
        });
    }

    /**
     * Add the workspace Notes pseudo-tab to the session tabs row
     */
    addWorkspaceNotesTab() {
        // Guard: do not add if already present in the row
        const existing = this.tabsContainer?.querySelector('.session-tab.session-tab--workspace-notes');
        if (existing) return existing;

        const btn = document.createElement('button');
        btn.className = 'session-tab session-tab--workspace-notes';
        // Use a sentinel ID so we can mark active
        const WS_NOTES_ID = ':workspace-notes';
        btn.dataset.sessionId = WS_NOTES_ID;
        // Title area with icon only
        const title = document.createElement('span');
        title.className = 'session-tab-title';
        try {
            const icon = iconUtils.createIcon('journal-text', { size: 14, className: 'terminal-tab-title-icon' });
            title.appendChild(icon);
        } catch (_) {}
        btn.appendChild(title);

        btn.title = 'Workspace notes';
        btn.style.userSelect = 'none';
        btn.style.webkitUserSelect = 'none';
        btn.style.mozUserSelect = 'none';
        btn.style.msUserSelect = 'none';

        btn.addEventListener('click', () => {
            try { this.manager?.eventBus?.emit?.('workspace-open-notes', { workspace: this.manager?.currentWorkspace }); } catch (_) {}
            this.setActiveSession(WS_NOTES_ID);
        });

        // Append at the end; createAddButton runs after and will place "+" last
        this.tabsContainer.appendChild(btn);
        this.sessionTabs.set(WS_NOTES_ID, btn);
        // Apply note indicator based on current workspace state
        try {
            const app = getContext()?.app;
            const ws = this.manager?.currentWorkspace || null;
            if (app?.modules?.tabManager?.workspaceNotesController && ws) {
                app.modules.tabManager.workspaceNotesController.updateWorkspaceTabIndicator(ws);
            }
        } catch (_) {}
        return btn;
    }

    clearDragIndicators() {
        if (!this.tabsContainer) return;
        this.tabsContainer.querySelectorAll('.session-tab.drag-over-before, .session-tab.drag-over-after')
            .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
    }

    async performReorder(draggedId, targetId, position) {
        try {
            // Determine current workspace
            const store = this.manager?.sessionList?.store;
            const workspace = store?.getState()?.workspaces?.current || 'Default';

            // Build ordered list of active session IDs in this workspace based on current tabs DOM
            const rawIds = Array.from(this.tabsContainer.querySelectorAll('.session-tab'))
                .map(el => el.dataset.sessionId)
                .filter(Boolean);
            const sessionsMap = store?.getState()?.sessionList?.sessions;
            const tabs = rawIds.filter((id) => {
                if (!id) return false;
                if (id.startsWith(':')) return false; // filter out pseudo-tabs like workspace notes
                if (sessionsMap instanceof Map) {
                    return sessionsMap.has(id);
                }
                return true;
            });

            // Ignore no-op drop on itself
            if (targetId && targetId === draggedId) {
                this.logDnD('performReorder: target equals dragged, ignoring');
                return;
            }

            // If dropping on whitespace, move to end
            let ids = tabs.filter(id => id !== draggedId);
            if (!targetId || !ids.includes(targetId)) {
                ids.push(draggedId);
            } else {
                const tIdx = ids.indexOf(targetId);
                const insertIdx = position === 'after' ? tIdx + 1 : tIdx;
                ids.splice(insertIdx, 0, draggedId);
            }

            this.logDnD('performReorder input', { workspace, draggedId, targetId, position, tabsBefore: tabs, idsBeforePin: [...ids] });

            // Enforce pinned-first rule to match render sorting
            try {
                const pinnedSet = store?.getState()?.sessionList?.filters?.pinnedSessions || new Set();
                const pinnedIds = ids.filter(id => pinnedSet.has(id));
                const unpinnedIds = ids.filter(id => !pinnedSet.has(id));
                ids = [...pinnedIds, ...unpinnedIds];
                this.logDnD('pinned grouping', { pinned: [...pinnedIds], unpinned: [...unpinnedIds], finalIds: [...ids] });
            } catch (_) {}

            // Mark DnD active to avoid smooth scroll that can feel delayed
            this._suppressScrollDuringDnD = true;
            // Optimistically update local manual order so UI reflects the change immediately
            try {
                this.manager?.sessionList?.updateManualOrder?.(ids);
                this.logDnD('updateManualOrder applied');
                // Ensure tabs bar updates synchronously with no delay
                try { this.refresh(); } catch (_) {}
                // Also refresh the sidebar immediately to keep views in sync
                try { this.manager?.sessionList?.render?.(); } catch (_) {}
            } catch (e) {
                if (this.isDebugDnD()) console.warn('[SessionTabsDnD] updateManualOrder failed', e);
            }

            // Persist to server only when appropriate (no local-only sessions and valid workspace)
            try {
                const anyLocalOnly = (() => {
                    try {
                        if (!(sessionsMap instanceof Map)) return false;
                        return ids.some(id => {
                            const s = sessionsMap.get(id);
                            return s && s.local_only === true;
                        });
                    } catch (_) { return false; }
                })();
                if (!workspace || anyLocalOnly) {
                    this.logDnD('API reorder skipped (local-only or no workspace)', { workspace, anyLocalOnly, ids });
                } else {
                    this.logDnD('API reorder start', { workspace, ids });
                    await apiService.reorderWorkspaceSessions(workspace, ids);
                    this.logDnD('API reorder success');
                }
            } catch (e) {
                // Fall back to local-only behavior; UI already updated
                this.logDnD('API reorder error, using local-only persistence', { error: e && (e.message || String(e)) });
            }
        } catch (err) {
            console.warn('[SessionTabsManager] Reorder failed:', err);
            try {
                notificationDisplay.show({ title: 'Reorder Failed', message: err?.message || 'Unable to reorder sessions', notification_type: 'error' });
            } catch (_) {}
        } finally {
            this.draggedSessionId = null;
            this.dragOverSessionId = null;
            this.dragOverPosition = null;
            this._suppressScrollDuringDnD = false;
        }
    }

    /**
     * Compute nearest drop target by mouse X within the scroll area.
     * Returns { targetId, position: 'before'|'after' } or null.
     */
    computeDropTargetByX(clientX) {
        const tabs = Array.from(this.tabsContainer.querySelectorAll('.session-tab'));
        if (!tabs.length) return null;
        const dragged = this.draggedSessionId;
        // Find first tab (not the dragged one) whose midpoint is to the right of clientX
        for (let i = 0; i < tabs.length; i++) {
            const rect = tabs[i].getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            const id = tabs[i].dataset.sessionId;
            if (!id) continue;
            if (dragged && id === dragged) continue;
            if (clientX < mid) {
                return { targetId: id, position: 'before' };
            }
        }
        // Otherwise, after the last tab
        // Pick the last tab that isn't the dragged one
        for (let i = tabs.length - 1; i >= 0; i--) {
            const id = tabs[i]?.dataset?.sessionId;
            if (id && id !== dragged) {
                return { targetId: id, position: 'after' };
            }
        }
        return null;
    }
    
    /**
     * Set active session tab
     */
    async setActiveSession(sessionId) {
        // Local tab switching only; do not focus dedicated windows from the main window
        // Remove active class from all tabs
        this.sessionTabs.forEach(tab => {
            tab.classList.remove('active');
        });
        
        // Add active class to selected tab
        const activeTab = this.sessionTabs.get(sessionId);
        if (activeTab) {
            activeTab.classList.add('active');
            this.activeSessionId = sessionId;
            this.debugLog('setActiveSession', sessionId);
            
            // Ensure active tab is visible (scroll into view if needed)
            if (!this._suppressScrollDuringDnD) {
                activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
        }
    }
    
    /**
     * Remove a session tab
     */
    removeSessionTab(sessionId) {
        const tab = this.sessionTabs.get(sessionId);
        if (tab) {
            tab.remove();
            this.sessionTabs.delete(sessionId);
        }
    }
    
    /**
     * Update a session tab (e.g., when title changes)
     */
    updateSessionTab(sessionData) {
        const tab = this.sessionTabs.get(sessionData.session_id);
        if (tab) {
            // Update tab title using settings
            let tabTitle = computeDisplayTitle(sessionData, { fallbackOrder: ['template_name','command'], defaultValue: 'Session' });
            
            // Truncate long titles
            if (tabTitle.length > 30) {
                tabTitle = tabTitle.substring(0, 27) + '...';
            }
            
            // Tooltip shows only the raw session ID
            const tooltipText = sessionData.session_id || '';
            const isTerminated = sessionData.is_active === false;
            
            // Get template color for the dot
            const templateColor = this.getTemplateColor(sessionData.template_name);
            const dotColor = templateColor || '#f5f5f5'; // Use off-white fallback for no template
            const colorDotStyle = ` style="background-color: ${dotColor};"`;
            
            // Check if session has links for indicator
            const hasLinks = sessionData.links && sessionData.links.length > 0;
            const linkIndicator = hasLinks ? `<span class="session-tab-link-indicator" title="This session has links">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M6.354 5.5H4a3 3 0 0 0 0 6h3a3 3 0 0 0 2.83-4H9c-.086 0-.17.01-.25.031A2 2 0 0 1 7 9.5a2 2 0 1 1-.25-3.969c.495-.043.995-.055 1.604-.055zm4.792.813a3 3 0 0 0-2.83-4h-3a3 3 0 1 0 2.83 4h.5a2 2 0 0 1 .25 3.969A2 2 0 0 1 9.5 7a2 2 0 0 1 .604-1.438z"/>
                </svg>
            </span>` : '';
            const terminatedIndicator = isTerminated
                ? '<span class="session-tab-ended" title="Session ended">Ended</span>'
                : '';

            tab.classList.toggle('session-tab--terminated', sessionData.is_active === false);
            
            tab.innerHTML = `
                <span class="session-tab-color-dot"${colorDotStyle}></span>
                <span class="session-tab-title">${this.escapeHtml(tabTitle)}</span>
                ${linkIndicator}
                ${terminatedIndicator}
            `;
            
            // Update native tooltip (browser default font)
            tab.title = tooltipText;
        }
    }
    
    /**
     * Navigate sessions using keyboard
     */
    navigateSessions(direction) {
        const visibleSessions = this.getVisibleSessions();
        const WS_NOTES_ID = ':workspace-notes';
        const hasWorkspaceNotes = !!this.tabsContainer.querySelector('.session-tab.session-tab--workspace-notes');

        // If workspace notes exists and it's currently active, move into sessions instead of wrapping
        if (hasWorkspaceNotes && this.activeSessionId === WS_NOTES_ID) {
            if (visibleSessions.length === 0) return;
            const idx = (direction === 'left') ? (visibleSessions.length - 1) : 0;
            const target = visibleSessions[idx];
            if (target) {
                this.selectSessionAndRestoreTab(target.session_id);
                return;
            }
        }

        if (visibleSessions.length === 0) {
            // If no sessions but workspace notes exists, toggle to workspace notes
            if (hasWorkspaceNotes) {
                try { this.manager.eventBus.emit('workspace-open-notes', { workspace: this.manager?.currentWorkspace }); } catch (_) {}
                this.setActiveSession(WS_NOTES_ID);
            }
            return;
        }

        // Find current session index
        let currentIndex = visibleSessions.findIndex(s => s.session_id === this.activeSessionId);
        if (currentIndex === -1) {
            currentIndex = direction === 'left' ? visibleSessions.length : -1;
        }

        // Calculate boundary behavior with workspace notes awareness
        if (direction === 'left') {
            if (currentIndex <= 0) {
                // Move to workspace notes when moving left from first
                if (hasWorkspaceNotes) {
                    try { this.manager.eventBus.emit('workspace-open-notes', { workspace: this.manager?.currentWorkspace }); } catch (_) {}
                    this.setActiveSession(WS_NOTES_ID);
                    return;
                }
                currentIndex = visibleSessions.length; // will decrement to last below
            }
            const newIndex = currentIndex - 1;
            const target = visibleSessions[newIndex];
            if (target) {
                this.selectSessionAndRestoreTab(target.session_id);
            }
            return;
        } else { // right
            if (currentIndex >= visibleSessions.length - 1) {
                // Move to workspace notes when moving right from last
                if (hasWorkspaceNotes) {
                    try { this.manager.eventBus.emit('workspace-open-notes', { workspace: this.manager?.currentWorkspace }); } catch (_) {}
                    this.setActiveSession(WS_NOTES_ID);
                    return;
                }
                currentIndex = -1; // will increment to 0 below
            }
            const newIndex = currentIndex + 1;
            const target = visibleSessions[newIndex];
            if (target) {
                this.selectSessionAndRestoreTab(target.session_id);
            }
            return;
        }
    }

    selectSessionAndRestoreTab(sessionId) {
        if (!sessionId) return;
        // If this session has a dedicated desktop window open, focus it instead of switching locally
        try {
            if (window.desktop && window.desktop.isElectron && typeof window.desktop.getSessionWindow === 'function' && typeof window.desktop.focusSessionWindow === 'function') {
                return window.desktop.getSessionWindow(sessionId)
                    .then(async (info) => {
                        if (info && info.ok && info.windowId) {
                            try { await window.desktop.focusSessionWindow(sessionId); } catch (_) {}
                            return; // do not switch locally
                        }
                        // Otherwise, proceed with local activation
                        if (this.manager && typeof this.manager.activateSession === 'function') {
                            this.manager.activateSession(sessionId, { manualClick: true });
                            return;
                        }
                        this.manager.selectSession(sessionId, { manualClick: true });
                        try { getContext()?.app?.modules?.tabManager?.switchToTab?.('terminal'); } catch (_) {}
                    })
                    .catch(() => {
                        // On any IPC failure, fall back to local activation
                        if (this.manager && typeof this.manager.activateSession === 'function') {
                            this.manager.activateSession(sessionId, { manualClick: true });
                            return;
                        }
                        this.manager.selectSession(sessionId, { manualClick: true });
                        try { getContext()?.app?.modules?.tabManager?.switchToTab?.('terminal'); } catch (_) {}
                    });
            }
        } catch (_) { /* ignore and fall through */ }

        if (this.manager && typeof this.manager.activateSession === 'function') {
            this.manager.activateSession(sessionId, { manualClick: true });
            return;
        }
        // Fallback to legacy behavior
        this.manager.selectSession(sessionId, { manualClick: true });
        try { getContext()?.app?.modules?.tabManager?.switchToTab?.('terminal'); } catch (_) {}
    }

    /**
     * Setup keyboard shortcuts
     */
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
            scope: 'terminal:session-tabs',
            priority: 20,
            when: () => this.isEnabled && !isModalOpen(),
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

        registerShortcut({
            id: 'session-tabs.navigate-left',
            description: 'Switch to previous session tab',
            keys: [...modShiftCombos('ArrowLeft')],
            preventDefault: true,
            handler: (_event, context) => {
                blurSidebarSearchIfNeeded(context?.target);
                this.navigateSessions('left');
                return true;
            }
        });

        registerShortcut({
            id: 'session-tabs.navigate-right',
            description: 'Switch to next session tab',
            keys: [...modShiftCombos('ArrowRight')],
            preventDefault: true,
            handler: (_event, context) => {
                blurSidebarSearchIfNeeded(context?.target);
                this.navigateSessions('right');
                return true;
            }
        });
    }
    
    /**
     * Get template color for a given template name
     */
    getTemplateColor(templateName) {
        if (!templateName) return null;
        
        // Try to get template color from cache first
        let color = this.templateColors.get(templateName);
        
        if (!color) {
            const template = this.getTemplateByName(templateName);
            if (template && template.color) {
                color = template.color;
                this.templateColors.set(templateName, color);
            }
        }
        
        return color ? parseColor(color) : null;
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
     * Handle links-added event - update session tab visual indicator
     */
    handleLinksAdded(eventData) {
        console.log('[SessionTabsManager] Handling links-added event for session:', eventData.sessionId);
        
        const { sessionId, sessionData } = eventData;
        
        // Find the tab for this session
        const tab = this.sessionTabs.get(sessionId);
        if (tab) {
            console.log('[SessionTabsManager] Updating tab visual indicator for session with links:', sessionId);
            this.updateSessionTab(sessionData);
        } else {
            console.log('[SessionTabsManager] Tab not found for session:', sessionId);
        }
    }

    /**
     * Create link indicator icon element
     */
    createLinkIndicator() {
        const linkIcon = document.createElement('span');
        linkIcon.className = 'session-tab-link-indicator';
        linkIcon.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.354 5.5H4a3 3 0 0 0 0 6h3a3 3 0 0 0 2.83-4H9c-.086 0-.17.01-.25.031A2 2 0 0 1 7 9.5a2 2 0 1 1-.25-3.969c.495-.043.995-.055 1.604-.055zm4.792.813a3 3 0 0 0-2.83-4h-3a3 3 0 1 0 2.83 4h.5a2 2 0 0 1 .25 3.969A2 2 0 0 1 9.5 7a2 2 0 0 1 .604-1.438z"/>
            </svg>
        `;
        linkIcon.title = 'This session has links';
        return linkIcon;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
