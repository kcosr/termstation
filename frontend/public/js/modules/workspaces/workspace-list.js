/**
 * Workspace List Component
 * Renders list of workspaces in the sidebar and handles selection
 */

import { appStore } from '../../core/store.js';
import { computeDisplayTitle } from '../../utils/title-utils.js';
import { apiService } from '../../services/api.service.js';
import { getStateStore } from '../../core/state-store/index.js';
import { notificationDisplay } from '../../utils/notification-display.js';
import { iconUtils } from '../../utils/icon-utils.js';
import { countOtherClients } from '../../utils/clients-utils.js';
import { getContext } from '../../core/context.js';
import { delegate } from '../../utils/delegate.js';
import { SessionFilterService } from '../terminal/session-filter-service.js';
import { FormModal, ConfirmationModal } from '../ui/modal.js';

export class WorkspaceList {
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.store = appStore;
    this.unsubscribe = null;
    this.expanded = new Set(); // Set of workspace names that are expanded
    this.workspaceTab = new Map(); // Map<workspaceName, 'active'|'inactive'>
    this._seenWorkspaces = new Set(); // track to auto-expand newly seen workspaces
    // Track desired child highlight per parent to survive DOM rebuilds
    this._activeChildByParent = new Map(); // Map<parentId, childId|null>

    this.initializeStore();
    // Listen for notes selection events to reflect in sidebar
    try {
      const ev = getContext()?.app?.eventBus;
      if (ev && typeof ev.on === 'function') {
        ev.on('workspace-open-notes', (payload) => {
          const ws = payload?.workspace || null;
          if (!ws) return;
          this.markNotesSelected(ws);
        });
        ev.on('session-changed', () => {
          this.clearNotesSelected();
        });
      }
    } catch (_) {}
    this.subscribe();
    this.render();
    // Ensure template colors are loaded so badges render with fills, then re-render
    this._templateColorsLoaded = false;
    this._templateColorsRetries = 0;
    this._templateColorsRetryTimer = null;
    this.ensureTemplateColorsLoaded();
    // Load persisted workspaces from backend
    this.loadFromServer();
    // Internal flag used if restore is invoked by TerminalManager post-load
    this._workspaceRestored = false;
    // Enable container-level DnD behaviors
    this.setupContainerDragEvents();
    // Bind delegated events for dynamic content
    this.bindDelegatedEvents();
    // Listen for container child session events to keep child rows and highlights in sync
    this._eventsBound = false;
    this._bindRetryCount = 0;
    this._bindRetryMax = 20;
    this._bindRetryDelay = 150;
    this.bindChildSessionEvents();
  }

  // Helper to safely read dragged id from DataTransfer
  getDraggedIdFromEvent(e) {
    try {
      const dt = e && e.dataTransfer;
      if (!dt || typeof dt.getData !== 'function') return null;
      const v = dt.getData('text/plain');
      return v || null;
    } catch (_) { return null; }
  }

  markNotesSelected(workspaceName) {
    try {
      const items = this.container?.querySelectorAll('.workspace-item');
      if (!items) return;
      items.forEach((el) => {
        const ws = el?.dataset?.workspace || '';
        if (ws === workspaceName) {
          el.classList.add('notes-selected');
        } else {
          el.classList.remove('notes-selected');
        }
      });
    } catch (_) {}
  }

  clearNotesSelected() {
    try {
      const items = this.container?.querySelectorAll('.workspace-item.notes-selected');
      items && items.forEach((el) => el.classList.remove('notes-selected'));
    } catch (_) {}
  }

  bindDelegatedEvents() {
    const root = this.container;
    if (!root) return;
    // Toggle expand/collapse
    delegate(root, '.workspace-toggle-btn', 'click', (e, btn) => {
      e.stopPropagation();
      const ws = btn.closest('.workspace-item')?.dataset?.workspace;
      if (ws) this.toggleWorkspace(ws);
    });
    // Workspace item click (select workspace)
    delegate(root, '.workspace-item', 'click', (e, item) => {
      // Ignore clicks on toggle or session rows
      if (e.target.closest('.workspace-toggle-btn')) return;
      if (e.target.closest('.workspace-session-row')) return;
      const name = item.dataset.workspace;
      if (!name) return;
      this.setCurrent(name);
      this.setMode('detail');
      if (this.onSelect) this.onSelect(name);
      try {
        const app = getContext()?.app;
        app?.closeSidebarOverlay?.();
      } catch (_) {}
    });
    // Context menu on workspace
    delegate(root, '.workspace-item', 'contextmenu', (e, item) => {
      e.preventDefault();
      e.stopPropagation();
      const name = item.dataset.workspace;
      if (!name) return;
      this.openContextMenu(e.pageX, e.pageY, name);
    });
    // Session row click (select session)
    delegate(root, '.workspace-session-row', 'click', (e, row) => {
      e.stopPropagation();
      try {
        const name = row.closest('.workspace-item')?.dataset?.workspace;
        const sid = row.getAttribute('data-session-id');
        if (!sid) return;
        // If the session is inactive, open the history view in the terminal module instead of the live terminal
        const sessions = this.store.getState().sessionList?.sessions || new Map();
        const sdata = sessions.get(sid);
        let stickySet = null;
        try {
          const tmSticky = getContext()?.app?.modules?.terminal?.sessionList?.stickyTerminatedSessions;
          stickySet = tmSticky instanceof Set ? tmSticky : null;
        } catch (_) {
          stickySet = null;
        }
        const isStickyTerminated = !!(stickySet && stickySet.has(sid));

        if (sdata && sdata.is_active === false && !isStickyTerminated) {
          const appRef = getContext()?.app;
          if (appRef?.modules?.history?.openInTerminalView) {
            appRef.modules.history.openInTerminalView(sid);
            appRef?.closeSidebarOverlay?.({ focusTerminal: true });
            return; // do not open standard terminal
          }
        }
        // Default: active sessions open in terminal
        const tm = getContext()?.app?.modules?.terminal;
        // Preserve selection through search-driven re-renders
        if (tm) {
          try { tm.pendingManualSelectionId = sid; } catch (_) {}
        }
        if (tm?.enterWorkspace && name) tm.enterWorkspace(name);
        tm?.selectSession?.(sid, { manualClick: true });
        // Ensure highlight re-applies after potential re-render
        try { setTimeout(() => { tm?.sessionList?.setActiveSession?.(sid); }, 0); } catch (_) {}
        const app = getContext()?.app;
        app?.closeSidebarOverlay?.({ focusTerminal: true });
      } catch (_) {}
    });
    // Click on workspace notes indicator
    delegate(root, '.workspace-note-indicator', 'click', (e, btn) => {
      e.preventDefault();
      e.stopPropagation();
      const ws = btn.closest('.workspace-item')?.dataset?.workspace;
      if (!ws) return;
      try {
        const ev = getContext()?.app?.eventBus;
        ev?.emit?.('workspace-open-notes', { workspace: ws });
        this.markNotesSelected(ws);
      } catch (_) {}
    });
  }

  bindChildSessionEvents() {
    // Skip if already bound
    if (this._eventsBound) {
      return true;
    }

    try {
      const bus = getContext()?.app?.modules?.terminal?.eventBus;
      if (!bus || typeof bus.on !== 'function') {
        // Retry binding if the terminal module isn't ready yet
        if (this._bindRetryCount < this._bindRetryMax) {
          this._bindRetryCount++;
          setTimeout(() => {
            this.bindChildSessionEvents();
          }, this._bindRetryDelay);
        } else {
          console.error('[WorkspaceList] Failed to bind child session events after', this._bindRetryMax, 'attempts');
        }
        return false;
      }

      const refresh = (payload) => {
        try {
          const parentId = (payload && (payload.parentId || payload.parent_id)) || null;
          if (!parentId) return;
          this.refreshChildrenForParent(parentId);
        } catch (_) {}
      };

      bus.on('container-session:added', refresh);
      bus.on('container-session:updated', refresh);
      bus.on('container-session:removed', refresh);
      bus.on('container-session:refresh', refresh);

      bus.on('container-session:activate', ({ parentId, sessionId }) => {
        this.setActiveChildHighlight(parentId, sessionId);
      });

      bus.on('tab-switched', (data = {}) => {
        try {
          const tab = data.tab || {};
          if (tab.type === 'container' && tab.childSessionId) {
            const childId = String(tab.childSessionId);
            const parentId = tab.sessionId || (getContext()?.app?.modules?.terminal?.childSessions?.get?.(childId)?.parent_session_id) || null;
            // Clear previous parent's highlight if switching away
            try {
              const prevParent = getContext()?.app?.modules?.terminal?.sessionList?.activeSessionId;
              const prevParentId = prevParent != null ? String(prevParent) : null;
              const normalizedParent = parentId != null ? String(parentId) : null;
              if (prevParentId && prevParentId !== normalizedParent) {
                this.setActiveChildHighlight(prevParentId, null);
              }
            } catch (_) {}
            this.setActiveChildHighlight(parentId, childId);
          } else {
            try {
              const parentId = tab.sessionId != null ? String(tab.sessionId) : null;
              const prevParent = getContext()?.app?.modules?.terminal?.sessionList?.activeSessionId;
              const prevParentId = prevParent != null ? String(prevParent) : null;
              if (parentId) {
                this.setActiveChildHighlight(parentId, null);
              }
              if (prevParentId && prevParentId !== parentId) {
                this.setActiveChildHighlight(prevParentId, null);
              }
            } catch (_) {}
          }
        } catch (err) {
          console.error('[WorkspaceList] Error in tab-switched handler:', err);
        }
      });

      // Mark as successfully bound
      this._eventsBound = true;
      return true;
    } catch (err) {
      console.error('[WorkspaceList] Error in bindChildSessionEvents:', err);
      return false;
    }
  }

  setActiveChildHighlight(parentId, childId) {
    try {
      if (!parentId) return;
      // Persist desired state so we can re-apply after any render/refresh
      try {
        if (childId) this._activeChildByParent.set(String(parentId), String(childId));
        else this._activeChildByParent.set(String(parentId), null);
      } catch (_) {}

      const apply = () => {
        try {
          const boxes = this.container.querySelectorAll(`.workspace-session-children[data-parent-id="${parentId}"]`);
          if (!boxes || boxes.length === 0) return false;
          boxes.forEach((box) => {
            const prevActive = box.querySelectorAll('.workspace-session-child.active');
            prevActive.forEach(el => el.classList.remove('active'));
            if (childId) {
              const el = box.querySelector(`.workspace-session-child[data-child-id="${childId}"]`);
              if (el) {
                el.classList.add('active');
              }
            }
          });
          return true;
        } catch (err) {
          console.error('[WorkspaceList] Error in apply:', err);
          return false;
        }
      };

      // Try now; if DOM not present yet, try on next frame
      const result = apply();
      if (!result) {
        try { requestAnimationFrame(() => { apply(); }); } catch (_) {}
      }
    } catch (err) {
      console.error('[WorkspaceList] Error in setActiveChildHighlight:', err);
    }
  }

  refreshChildrenForParent(parentId) {
    try {
      const tm = getContext()?.app?.modules?.terminal;
      if (!tm || typeof tm.getChildSessions !== 'function') return;
      const children = tm.getChildSessions(parentId) || [];
      const rows = this.container.querySelectorAll(`.workspace-session-row[data-session-id="${parentId}"]`);
      rows.forEach((row) => {
        const list = row.closest('.workspace-sessions');
        if (!list) return;
        // Remove any existing child boxes for this parent
        try {
          const existing = row.parentElement ? row.parentElement.querySelectorAll(`.workspace-session-children[data-parent-id="${parentId}"]`) : [];
          existing && existing.forEach(el => { try { el.remove(); } catch(_){} });
        } catch (_) {}
        if (!Array.isArray(children) || children.length === 0) return;
        const childBox = document.createElement('div');
        childBox.className = 'workspace-session-children';
        childBox.dataset.parentId = parentId;
        children.forEach((child, idx) => {
          if (!child || !child.session_id) return;
          const c = document.createElement('div');
          c.className = 'workspace-session-child';
          c.dataset.parentId = parentId;
          c.dataset.childId = child.session_id;
          c.setAttribute('draggable', 'true');
          const labelBase = String(child.title || child.container_name || '').trim();
          const label = labelBase || (children.length > 1 ? `Container ${idx + 1}` : 'Container');
          const ended = child.is_active === false;
          c.innerHTML = `
            <span class="activity-slot" aria-hidden="true"></span>
            <span class="workspace-session-child-title">${label}</span>
            ${ended ? '<span class="session-child-ended">Ended</span>' : ''}
          `;
          // Add activity indicator if session is actively outputting, or a static
          // indicator when output stopped while the session was not being viewed.
          try {
            const st = this.store.getState();
            let showPref = true;
            try { showPref = st?.preferences?.display?.showActivityIndicator !== false; } catch (_) { showPref = true; }
            let isActiveOutput = false;
            const stMap = st?.sessionList?.activityState;
            if (stMap instanceof Map) isActiveOutput = !!stMap.get(child.session_id);
            else if (stMap && typeof stMap === 'object') isActiveOutput = !!stMap[child.session_id];
            let hasStoppedWhileHidden = false;
            const stoppedMap = st?.sessionList?.activityStoppedWhileHidden;
            if (stoppedMap instanceof Map) hasStoppedWhileHidden = !!stoppedMap.get(child.session_id);
            else if (stoppedMap && typeof stoppedMap === 'object') hasStoppedWhileHidden = !!stoppedMap[child.session_id];
            const isLive = child && child.is_active !== false;
            const showPulsing = showPref && isActiveOutput && isLive;
            const showStatic = showPref && !showPulsing && hasStoppedWhileHidden && isLive;
            if (showPulsing || showStatic) {
              const slot = c.querySelector('.activity-slot');
              if (slot) {
                const dot = document.createElement('span');
                dot.className = 'activity-indicator status-indicator active';
                if (showPulsing) dot.classList.add('connected');
                else dot.classList.add('pending');
                slot.appendChild(dot);
              }
            }
          } catch (_) {}
          childBox.appendChild(c);
        });
        // Insert directly after the parent row
        list.insertBefore(childBox, row.nextSibling);
      });

      // Re-apply active highlight after rendering (in case DOM was rebuilt)
      try {
        const desired = this._activeChildByParent.get(String(parentId));
        if (desired !== undefined) {
          this.setActiveChildHighlight(parentId, desired);
        } else {
          // Fallback to TabManager state if no explicit desired highlight recorded
          const tm = getContext()?.app?.modules?.terminal;
          const tabMgr = tm?.getTabManager?.();
          const saved = tabMgr?.getSavedTabId?.(parentId) || null;
          if (saved && saved.startsWith('container-')) {
            const childId = saved.substring('container-'.length);
            this.setActiveChildHighlight(parentId, childId);
          }
        }
      } catch (_) {}
    } catch (_) {}
  }

  initializeStore() {
    const state = this.store.getState();
    if (!state.workspaces) {
      this.store.setState({
        workspaces: {
          items: new Set(['Default']),
          pinned: new Set(),
          filterPinned: false,
          filterActive: true,
          order: ['Default'],
          current: null,
          mode: 'list'
        }
      });
    }
  }

  subscribe() {
    this.unsubscribe = this.store.subscribe('workspaces', () => this.render());
    // Re-render when sessions change so stats are correct on initial load
    this.unsubscribeSessions = this.store.subscribe('sessionList.sessions', () => this.render());
    // Re-render when the active session changes so selected row highlight updates
    this.unsubscribeActive = this.store.subscribe('sessionList.activeSessionId', () => this.render());
    // Re-render when the template filter changes so workspace rows reflect sidebar filter
    this.unsubscribeTemplate = this.store.subscribe('sessionList.filters.template', () => this.render());
    // Re-render when search overlay (filteredIds) changes so sidebar updates immediately on search
    this.unsubscribeFilteredIds = this.store.subscribe('sessionList.filteredIds', () => this.render());
    // Also re-render on search text updates (for non-overlay local searches, if used)
    this.unsubscribeSearch = this.store.subscribe('sessionList.filters.search', () => this.render());
    // Keep sidebar in sync with manual reorders and published visible order
    this.unsubscribeVisibleOrder = this.store.subscribe('sessionList.visibleOrder', () => this.render());
    this.unsubscribeLastUpdate = this.store.subscribe('sessionList.lastUpdate', () => this.render());
  }

  destroy() {
    try { this.unsubscribe && this.unsubscribe(); } catch (_) {}
    try { this.unsubscribeSessions && this.unsubscribeSessions(); } catch (_) {}
    try { this.unsubscribeActive && this.unsubscribeActive(); } catch (_) {}
    try { this.unsubscribeTemplate && this.unsubscribeTemplate(); } catch (_) {}
    try { this.unsubscribeFilteredIds && this.unsubscribeFilteredIds(); } catch (_) {}
    try { this.unsubscribeSearch && this.unsubscribeSearch(); } catch (_) {}
  }

  setWorkspaces(names) {
    const items = new Set(names && names.size ? Array.from(names) : names || []);
    if (items.size === 0) items.add('Default');

    // Update order array to include any new workspace names
    const state = this.store.getState().workspaces || {};
    const currentOrder = Array.isArray(state.order) ? state.order : [];
    const currentItems = state.items || new Set();

    // Find new workspace names that aren't in the current items
    const newNames = Array.from(items).filter(name => !currentItems.has(name));

    // Append new names to the order array if any exist
    if (newNames.length > 0) {
      const updatedOrder = [...currentOrder, ...newNames];
      this.store.beginTransaction();
      this.store.setPath('workspaces.items', items);
      this.store.setPath('workspaces.order', updatedOrder);
      this.store.commitTransaction();
    } else {
      this.store.setPath('workspaces.items', items);
    }
  }

  setMode(mode) {
    this.store.setPath('workspaces.mode', mode);
  }

  setCurrent(name) {
    this.store.setPath('workspaces.current', name);
    // Persist last selected workspace to StateStore
    try {
      import('../../core/state-store/batch.js').then(({ queueStateSet }) => {
        queueStateSet('terminal_manager_last_workspace', name || '', 200);
      });
    } catch (_) { /* ignore storage failures */ }
  }

  render() {
    if (!this.container) return;
    // Keep trying to ensure colors until sessionList is ready
    if (!this._templateColorsLoaded && !this._templateColorsRetryTimer) {
      this.ensureTemplateColorsLoaded();
    }
    const state = this.store.getState().workspaces;
    const itemsSet = state.items || new Set();
    const order = Array.isArray(state.order) && state.order.length > 0
      ? state.order.filter(n => !state.filterPinned || (state.pinned || new Set()).has(n))
      : Array.from(itemsSet);
    const pinnedSet = state.pinned || new Set();
    const filterPinned = !!state.filterPinned;
    const filterActive = state.filterActive !== false; // default true
    const current = state.current || null;

    this.container.innerHTML = '';
    // Reset the numbering serial at the start of a full render pass
    this._visibleSessionSerial = 0;

    // Track visible workspace names during this render
    const visibleNames = [];

    // Preserve the order from the store (which reflects server order)

    // Inline add removed in favor of modal

    // Compute stats from sessions (apply template filter from sidebar)
    const sessionState = this.store.getState().sessionList || {};
    const sessions = sessionState.sessions || new Map();
    const filteredIds = sessionState.filteredIds || null;
    let sessionArray = sessions instanceof Map ? Array.from(sessions.values()) : [];
    // If an overlay of filteredIds is active (e.g., content search), restrict base set
    if (Array.isArray(filteredIds)) {
      const idSet = new Set(filteredIds);
      sessionArray = sessionArray.filter(s => idSet.has(s.session_id));
    }
    // Respect current template filter so workspace rows reflect the same view as the session tabs
    let filteredSessionArray = sessionArray;
    try {
      const sl = sessionState || {};
      const filters = sl.filters || {};
      const pinnedSessions = filters.pinnedSessions || new Set();
      // When filteredIds overlay is active, search is already materialized into sessionArray
      filteredSessionArray = SessionFilterService.filter(sessionArray, {
        status: 'all',
        search: Array.isArray(filteredIds) ? '' : (filters.search || ''),
        template: filters.template || 'all',
        pinned: false,
        pinnedSessions,
        workspace: null
      });
      this._templateFilterActive = !!(filters && filters.template && filters.template !== 'all' && ((filters.template instanceof Set && filters.template.size > 0) || (Array.isArray(filters.template) && filters.template.length > 0) || (typeof filters.template === 'string' && filters.template.trim() !== '')));
      // Determine if a search is active (via TerminalManager state or input value)
      try {
        const tm = getContext()?.app?.modules?.terminal;
        if (tm && typeof tm.searchQuery === 'string') {
          this._searchActive = tm.searchQuery.trim().length > 0;
        } else {
          const input = document.getElementById('session-search');
          this._searchActive = !!(input && input.value && input.value.trim().length > 0);
        }
      } catch (_) { this._searchActive = false; }
    } catch (_) {}

    order.forEach((name) => {
      if ((itemsSet && !itemsSet.has(name))) return;
      if (filterPinned && !pinnedSet.has(name)) return;
      const stats = this.getWorkspaceStats(filteredSessionArray, name);
      // Hide workspaces with no ACTIVE sessions when Active filter is on
      // Also hide when template/search filters are active to match sidebar view
      const hideForFilters = filterActive || this._templateFilterActive || this._searchActive;
      if (hideForFilters && (stats.live === 0)) {
        return;
      }
      // Count as visible for this render
      visibleNames.push(name);
      const item = document.createElement('div');
      // Auto-expand newly seen workspaces by default
      if (!this._seenWorkspaces.has(name)) {
        this._seenWorkspaces.add(name);
        this.expanded.add(name);
      }
      const isExpanded = this.expanded.has(name);
      item.className = 'workspace-item' + (current === name ? ' active' : '');
      item.dataset.workspace = name;

      // Header (title + expand button)
      const header = document.createElement('div');
      header.className = 'workspace-header';

      const titleEl = document.createElement('div');
      titleEl.className = 'workspace-title';
      titleEl.textContent = name;
      if (pinnedSet.has(name)) {
        const pinIcon = iconUtils.createIcon('pin', { size: 12, className: 'workspace-pin-icon', title: 'Pinned' });
        pinIcon.style.marginLeft = '6px';
        titleEl.appendChild(pinIcon);
      }
      header.appendChild(titleEl);

      const rightEl = document.createElement('div');
      rightEl.style.display = 'flex';
      rightEl.style.alignItems = 'center';
      rightEl.style.gap = '0.35rem';
      // Right side: notes indicator (if enabled) then expand/collapse button
      try {
        const st = this.store?.getState?.() || {};
        const featuresEnabled = st?.auth?.features?.notes_enabled === true;
        const showWs = st?.preferences?.notes?.showWorkspaceTab !== false;
        if (featuresEnabled && showWs) {
          const notesBtn = document.createElement('button');
          notesBtn.className = 'btn btn-icon workspace-note-indicator';
          notesBtn.title = 'Open workspace notes';
          const icon = iconUtils.createIcon('journal-text', { size: 14 });
          notesBtn.appendChild(icon);
          rightEl.appendChild(notesBtn);
        }
      } catch (_) {}

      // Expand/collapse button
      // isExpanded already computed above
      if (stats.active > 0) {
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn btn-icon workspace-toggle-btn';
        toggleBtn.title = isExpanded ? 'Collapse' : 'Expand';
        const chevron = iconUtils.createIcon(isExpanded ? 'chevron-up' : 'chevron-down', { size: 14 });
        toggleBtn.appendChild(chevron);
        rightEl.appendChild(toggleBtn);
      }

      header.appendChild(rightEl);
      item.appendChild(header);

      // Accept session drops on header to move across workspaces
      header.addEventListener('dragover', (e) => {
        if (this.draggedSessionId) {
          e.preventDefault();
          item.classList.add('workspace-session-drop');
        }
      });
      header.addEventListener('dragleave', () => {
        if (this.draggedSessionId) item.classList.remove('workspace-session-drop');
      });
      header.addEventListener('drop', async (e) => {
        if (!this.draggedSessionId) return;
        e.preventDefault();
        item.classList.remove('workspace-session-drop');
        const draggedId = this.draggedSessionId;
        this.draggedSessionId = null;
        try {
          // Use SessionList helper which handles local-only (Electron) and server sessions
          const tm = getContext()?.app?.modules?.terminal;
          if (tm?.sessionList && typeof tm.sessionList.assignToWorkspace === 'function') {
            tm.sessionList.assignToWorkspace(draggedId, name);
          } else {
            await apiService.updateSessionWorkspace(draggedId, name);
          }
        } catch (err) {
          notificationDisplay.show({ title: 'Move Failed', message: err?.message || 'Unable to move session', notification_type: 'error' });
        }
      });

      // Template badges row (unique templates for this workspace)
      // Only show when collapsed AND template colors are loaded to avoid flash of unstyled badges
      if (!isExpanded && this._templateColorsLoaded) {
        try {
          const tmplRow = document.createElement('div');
          tmplRow.className = 'workspace-template-badges';
          const seen = new Set();
          filteredSessionArray.forEach(s => {
            const ws = s.workspace || 'Default';
            if (ws !== name) return;
            // Only consider ACTIVE sessions for template badges
            if (!s.is_active) return;
            const tmpl = s.template_name || null;
            const label = tmpl || (s && s.local_only === true ? 'Local' : 'Command');
            if (seen.has(label)) return;
            seen.add(label);
            const tm = getContext()?.app?.modules?.terminal;
            if (tm?.sessionList?.createTemplateBadgeHtml) {
              try {
                const badgeHtml = tmpl
                  ? tm.sessionList.createTemplateBadgeHtml(tmpl)
                  : tm.sessionList.createCommandBadgeHtml(label);
                const tmp = document.createElement('div');
                tmp.innerHTML = badgeHtml;
                const badgeSpan = tmp.querySelector('.template-badge');
                if (badgeSpan) tmplRow.appendChild(badgeSpan);
              } catch (_) {}
            }
          });
          if (tmplRow.childElementCount > 0) {
            item.appendChild(tmplRow);
          }
        } catch (_) {}
      }

      // Removed active/inactive badges per new design

      // Apply collapsed styling when either explicitly collapsed OR when there are no sessions
      if (!isExpanded || stats.active === 0) {
        item.classList.add('collapsed');
      } else {
        item.classList.remove('collapsed');
      }

      // Mark item classes for notes/content indicators (only when enabled)
      try {
        const wsc = getContext()?.app?.modules?.tabManager?.workspaceNotesController;
        if (wsc && typeof wsc.isEnabled === 'function' && wsc.isEnabled()) {
          if (typeof wsc.hasNoteContent === 'function' && wsc.hasNoteContent(name)) {
            item.classList.add('has-note');
          }
        }
      } catch (_) {}

      // Expanded sessions list (only render list when expanded and there are sessions)
      if (isExpanded && stats.active > 0) {
        const inWs = filteredSessionArray.filter(s => (s.workspace || 'Default') === name);
        let stickySet = null;
        try {
          const tm = getContext()?.app?.modules?.terminal;
          stickySet = tm?.sessionList?.stickyTerminatedSessions instanceof Set ? tm.sessionList.stickyTerminatedSessions : null;
        } catch (_) {
          stickySet = null;
        }
        // Compute order: prefer the published sessionList.visibleOrder (which
        // reflects manual ordering and current filters), then fall back to
        // workspace_order/created_at for stability when no manual order exists.
        const byOrder = (a, b) => {
          const ao = typeof a.workspace_order === 'number' ? a.workspace_order : Infinity;
          const bo = typeof b.workspace_order === 'number' ? b.workspace_order : Infinity;
          if (ao !== bo) return ao - bo;
          // fallback by created_at
          return (a.created_at || 0) - (b.created_at || 0);
        };
        const state = this.store.getState() || {};
        const visibleOrder = Array.isArray(state?.sessionList?.visibleOrder)
          ? state.sessionList.visibleOrder
          : [];
        const hasVisibleOrder = visibleOrder.length > 0;
        const sessionsActive = inWs
          .filter(s => s.is_active || (stickySet ? stickySet.has(s.session_id) : false))
          .sort((a, b) => {
            if (hasVisibleOrder) {
              const ai = visibleOrder.indexOf(a.session_id);
              const bi = visibleOrder.indexOf(b.session_id);
              if (ai !== -1 && bi !== -1) return ai - bi;
              if (ai !== -1) return -1;
              if (bi !== -1) return 1;
            }
            return byOrder(a, b);
          });

        const list = document.createElement('div');
        list.className = 'workspace-sessions';

        const addRow = (sess) => {
          const row = document.createElement('div');
          row.className = 'workspace-session-row';
          row.setAttribute('draggable', 'true');
          row.dataset.sessionId = sess.session_id;
          // Mark selected row to mirror sidebar selection
          try {
            const selectedId = this.store.getState().sessionList?.activeSessionId || null;
            if (selectedId) {
              row.classList.toggle('selected', selectedId === sess.session_id);
            }
          } catch (_) {}
        // Build content: template badge + title
        const content = document.createElement('div');
        content.className = 'workspace-session-content';
          const tmpl = sess.template_name || null;
          if (this._templateColorsLoaded && getContext()?.app?.modules?.terminal?.sessionList) {
            try {
              const tm = getContext()?.app?.modules?.terminal;
              const isLocalOnly = !!(sess && sess.local_only === true);
              const badgeHtml = tmpl
                ? tm.sessionList.createTemplateBadgeHtml(tmpl)
                : tm.sessionList.createCommandBadgeHtml(isLocalOnly ? 'Local' : 'Command');
              const tmp = document.createElement('div');
              tmp.innerHTML = badgeHtml;
              // Extract only the inner badge span to keep inline, but prepend activity indicator dot
              const badgeSpan = tmp.querySelector('.template-badge');
              if (badgeSpan) {
                // Always reserve space for activity with a dedicated slot
                const slot = document.createElement('span');
                slot.className = 'activity-slot';
                try { slot.setAttribute('aria-hidden', 'true'); } catch(_) {}
                // Add pulsing or static indicator based on activity state
                try {
                  const st = this.store.getState();
                  // Respect preference toggle (default ON)
                  let showPref = true;
                  try { showPref = st?.preferences?.display?.showActivityIndicator !== false; } catch (_) { showPref = true; }
                  // Use only persistent server activity state
                  let isActiveOutput = false;
                  const stMap = st?.sessionList?.activityState;
                  if (stMap instanceof Map) isActiveOutput = !!stMap.get(sess.session_id);
                  else if (stMap && typeof stMap === 'object') isActiveOutput = !!stMap[sess.session_id];
                  const isLive = sess && sess.is_active !== false;
                  let hasStoppedWhileHidden = false;
                  const stoppedMap = st?.sessionList?.activityStoppedWhileHidden;
                  if (stoppedMap instanceof Map) hasStoppedWhileHidden = !!stoppedMap.get(sess.session_id);
                  else if (stoppedMap && typeof stoppedMap === 'object') hasStoppedWhileHidden = !!stoppedMap[sess.session_id];
                  const showPulsing = showPref && isActiveOutput && isLive;
                  const showStatic = showPref && !showPulsing && hasStoppedWhileHidden && isLive;
                  if (showPulsing || showStatic) {
                    const dot = document.createElement('span');
                    dot.className = 'activity-indicator status-indicator active';
                    if (showPulsing) dot.classList.add('connected');
                    else dot.classList.add('pending');
                    slot.appendChild(dot);
                  }
                } catch(_) {}
                content.appendChild(slot);
                content.appendChild(badgeSpan);
              }
              // Append compact visibility icon after the badge
              try {
                // Do not show visibility icons for local-only sessions
                if (sess && sess.local_only === true) {
                  // no icon for local sessions
                } else {
                  const visibility = sess.visibility || 'private';
                  const owner = String(sess.created_by || '');
                  const currentUser = (tm && typeof tm.getCurrentUsername === 'function')
                    ? String(tm.getCurrentUsername() || '')
                    : String((this.store?.getState()?.preferences?.auth?.username) || '');
                  const isOwner = !!currentUser && currentUser === owner;
                  let iconEl = null;
                  if (visibility === 'shared_readonly') {
                    if (isOwner) {
                      iconEl = iconUtils.createIcon('people', { size: 14, className: 'visibility-icon', title: 'Shared (read-only)' });
                    } else {
                      iconEl = iconUtils.createIcon('person-slash', { size: 14, className: 'visibility-icon', title: `Read-only (${owner})` });
                    }
                  } else if (visibility === 'public') {
                    iconEl = iconUtils.createIcon('globe', { size: 14, className: 'visibility-icon', title: isOwner ? 'Public (full access)' : `Public (${owner})` });
                  } else if (visibility === 'private' && !isOwner) {
                    iconEl = iconUtils.createIcon('lock', { size: 14, className: 'visibility-icon', title: `Private (${owner})` });
                  }
                  if (iconEl) {
                    iconEl.style.marginLeft = '6px';
                    content.appendChild(iconEl);
                  }
                }
              } catch (_) {}
            } catch (_) {}
          }
          const titleSpan = document.createElement('span');
          titleSpan.className = 'workspace-session-title';
          // Compute title based on settings; fallback to session id
          const displayTitle = computeDisplayTitle(sess, { fallbackOrder: [], defaultValue: sess.session_id });
          titleSpan.textContent = displayTitle;
          // Show session id on hover for easy reference
          try { titleSpan.title = sess?.session_id || ''; } catch (_) {}
          titleSpan.style.marginLeft = '6px';
          content.appendChild(titleSpan);

          if (!sess.is_active && stickySet && stickySet.has(sess.session_id)) {
            const endedBadge = document.createElement('span');
            endedBadge.className = 'session-status-indicator session-status-indicator--ended';
            endedBadge.textContent = 'ENDED';
            content.appendChild(endedBadge);
          }
          row.appendChild(content);

          // Right-side status area: always present; show client indicator and number label when applicable
          try {
            const status = document.createElement('div');
            status.className = 'workspace-session-status';
            const tm = getContext()?.app?.modules?.terminal;
            const currentClientId = tm?.clientId || null;
            const otherCount = countOtherClients(sess, currentClientId);
            if (otherCount > 0) {
              const icon = iconUtils.createIcon('display', { size: 16, className: 'client-display-indicator', title: `${otherCount} other client${otherCount === 1 ? '' : 's'} connected` });
              status.appendChild(icon);
            }

            // Add small numeric indicator for first 9 visible sessions across the sidebar
            const displayNumber = (this._visibleSessionSerial || 0) + 1; // 1-based
            if (displayNumber >= 1 && displayNumber <= 9) {
              const num = document.createElement('span');
              num.className = 'session-number-label';
              num.textContent = String(displayNumber);
              try { num.setAttribute('aria-hidden', 'true'); } catch (_) {}
              try { num.title = `Shortcut: Cmd/Alt+${displayNumber}`; } catch (_) {}
              status.appendChild(num);
            }
            row.appendChild(status);
          } catch (_) {}
          // DnD within workspace
          this.attachSessionRowDnD(row, name);
          row.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
          list.appendChild(row);

          // Render container/login child sessions as sub-entries under the parent row
          try {
            const children = (function getChildren() {
              try {
                const tm = getContext()?.app?.modules?.terminal;
                if (tm && typeof tm.getChildSessions === 'function') {
                  return tm.getChildSessions(sess.session_id) || [];
                }
              } catch (_) {}
              return [];
            })();
            if (Array.isArray(children) && children.length > 0) {
              const childBox = document.createElement('div');
              childBox.className = 'workspace-session-children';
              childBox.dataset.parentId = sess.session_id;
              const rowRef = row;
              children.forEach((child, idx) => {
                if (!child || !child.session_id) return;
                const c = document.createElement('div');
                c.className = 'workspace-session-child';
                c.dataset.parentId = sess.session_id;
                c.dataset.childId = child.session_id;
                c.setAttribute('draggable', 'true');
                const labelBase = String(child.title || child.container_name || '').trim();
                const label = labelBase || (children.length > 1 ? `Shell ${idx + 1}` : 'Shell');
                const ended = child.is_active === false;
                c.innerHTML = `
                  <span class="activity-slot" aria-hidden="true"></span>
                  <span class="workspace-session-child-title">${label}</span>
                  ${ended ? '<span class="session-child-ended">Ended</span>' : ''}
                `;
                // Add activity indicator if session is actively outputting, or a
                // static indicator when output stopped while the child was hidden
                try {
                  const st = this.store.getState();
                  let showPref = true;
                  try { showPref = st?.preferences?.display?.showActivityIndicator !== false; } catch (_) { showPref = true; }
                  let isActiveOutput = false;
                  const stMap = st?.sessionList?.activityState;
                  if (stMap instanceof Map) isActiveOutput = !!stMap.get(child.session_id);
                  else if (stMap && typeof stMap === 'object') isActiveOutput = !!stMap[child.session_id];
                  const isLive = child && child.is_active !== false;
                  let hasStoppedWhileHidden = false;
                  const stoppedMap = st?.sessionList?.activityStoppedWhileHidden;
                  if (stoppedMap instanceof Map) hasStoppedWhileHidden = !!stoppedMap.get(child.session_id);
                  else if (stoppedMap && typeof stoppedMap === 'object') hasStoppedWhileHidden = !!stoppedMap[child.session_id];
                  const showPulsing = showPref && isActiveOutput && isLive;
                  const showStatic = showPref && !showPulsing && hasStoppedWhileHidden && isLive;
                  if (showPulsing || showStatic) {
                    const slot = c.querySelector('.activity-slot');
                    if (slot) {
                      const dot = document.createElement('span');
                      dot.className = 'activity-indicator status-indicator active';
                      if (showPulsing) dot.classList.add('connected');
                      else dot.classList.add('pending');
                      slot.appendChild(dot);
                    }
                  }
                } catch (_) {}
                // Click: select parent and activate container tab
                c.addEventListener('click', async (e) => {
                  try { e.stopPropagation(); } catch (_) {}
                  try {
                    const tm = getContext()?.app?.modules?.terminal;
                    if (!tm) return;
                    // Ensure workspace context first
                    const ws = (sess && (sess.workspace || 'Default')) || 'Default';
                    if (!tm.currentWorkspace || tm.currentWorkspace !== ws) {
                      tm.enterWorkspace(ws);
                    }
                    // Select the parent session
                    if (typeof tm.activateSession === 'function') {
                      tm.pendingManualSelectionId = sess.session_id;
                      await tm.activateSession(sess.session_id, { manualClick: true });
                    } else {
                      await tm.selectSession(sess.session_id, { manualClick: true });
                    }
                    // Switch to the container tab
                    const tabMgr = tm?.getTabManager?.();
                    if (tabMgr) {
                      try { tabMgr.ensureContainerTab(sess.session_id, child); } catch (_) {}
                      try { tabMgr.activateContainerTab(sess.session_id, child.session_id); } catch (_) {}
                    }
                    // Sidebar highlight update too (if visible)
                    try { tm?.sessionList?.setActiveChildHighlight?.(sess.session_id, child.session_id); } catch (_) {}
                    // Workspace view highlight update
                    this.setActiveChildHighlight(sess.session_id, child.session_id);
                    // Close the sidebar overlay after navigation
                    try {
                      const app = getContext()?.app;
                      app?.closeSidebarOverlay?.({ focusTerminal: true });
                    } catch (_) {}
                  } catch (err) {
                    console.error('[WorkspaceList] Error in child click handler:', err);
                  }
                });
                // Right-click: open standard session context menu for the child
                c.addEventListener('contextmenu', (e) => {
                  try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
                  try {
                    const tm = getContext()?.app?.modules?.terminal;
                    const childData = tm?.childSessions?.get?.(child.session_id) || { session_id: child.session_id, parent_session_id: sess.session_id };
                    if (tm?.sessionList?.contextMenu && childData) {
                      tm.sessionList.contextMenu.show(e.pageX, e.pageY, childData);
                    }
                  } catch (_) {}
                });
                // Drag: behave like dragging the parent row
                c.addEventListener('dragstart', (e) => {
                  try { e.stopPropagation(); } catch (_) {}
                  this.draggedSessionId = sess.session_id;
                  rowRef.classList.add('dragging');
                  try { e.dataTransfer.setData('text/plain', sess.session_id); } catch (_) {}
                  try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
                  // Make the drag preview look like the parent session row, not the child
                  try {
                    const rect = rowRef.getBoundingClientRect();
                    const offsetX = e.clientX - rect.left;
                    const offsetY = e.clientY - rect.top;
                    if (typeof e.dataTransfer.setDragImage === 'function') {
                      e.dataTransfer.setDragImage(rowRef, Math.max(0, offsetX), Math.max(0, offsetY));
                    }
                  } catch (_) {}
                });
                c.addEventListener('dragend', () => {
                  rowRef.classList.remove('dragging');
                  this.draggedSessionId = null;
                  try {
                    list.querySelectorAll('.workspace-session-row.drag-over-before, .workspace-session-row.drag-over-after')
                      .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
                  } catch (_) {}
                });
                // Optional dragover to mirror parent indicators (container handles row indicators)
                childBox.appendChild(c);
              });
              list.appendChild(childBox);

              // Re-apply active highlight after rendering (in case DOM was rebuilt)
              try {
                const desired = this._activeChildByParent.get(String(sess.session_id));
                if (desired !== undefined) {
                  this.setActiveChildHighlight(sess.session_id, desired);
                } else {
                  const tm = getContext()?.app?.modules?.terminal;
                  const tabMgr = tm?.getTabManager?.();
                  const saved = tabMgr?.getSavedTabId?.(sess.session_id) || null;
                  if (saved && saved.startsWith('container-')) {
                    const childId = saved.substring('container-'.length);
                    this.setActiveChildHighlight(sess.session_id, childId);
                  }
                }
              } catch (_) {}
            }
          } catch (_) { /* non-fatal: omit children */ }

          // Increment global visible session serial for numbering
          this._visibleSessionSerial = (this._visibleSessionSerial || 0) + 1;
        };

        const visible = sessionsActive; // Only show active sessions in sidebar
        visible.forEach(addRow);

        // Container-level DnD for whitespace before-first / after-last
        try {
          list.addEventListener('dragover', (e) => {
            // If hovering a row, let the row handler control indicators
            const rowTarget = e.target && typeof e.target.closest === 'function' ? e.target.closest('.workspace-session-row') : null;
            if (rowTarget) return;
            const rows = Array.from(list.querySelectorAll('.workspace-session-row'));
            if (rows.length === 0) return;
            const first = rows[0];
            const last = rows[rows.length - 1];
            const firstRect = first.getBoundingClientRect();
            const lastRect = last.getBoundingClientRect();
            const y = e.clientY;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
            // Clear row indicators
            rows.forEach(r => r.classList.remove('drag-over-before', 'drag-over-after'));
            if (y < firstRect.top + 1) {
              first.classList.add('drag-over-before');
              this.dragOverSessionId = first.dataset.sessionId;
              this.dragOverSessionPos = 'before';
            } else if (y > lastRect.bottom - 1) {
              last.classList.add('drag-over-after');
              this.dragOverSessionId = last.dataset.sessionId;
              this.dragOverSessionPos = 'after';
            }
          });

          list.addEventListener('drop', async (e) => {
            // If dropping on a row, the row-level drop handles it
            const rowTarget = e.target && typeof e.target.closest === 'function' ? e.target.closest('.workspace-session-row') : null;
            if (rowTarget) return;
            const rows = Array.from(list.querySelectorAll('.workspace-session-row'));
            if (rows.length === 0) return;
            e.preventDefault();
            // Clear indicators
            rows.forEach(r => r.classList.remove('drag-over-before', 'drag-over-after'));
            const dragged = this.draggedSessionId || this.getDraggedIdFromEvent(e);
            if (!dragged) return;
            try {
              // Determine current and target workspaces
              const state = this.store.getState().sessionList;
              const all = Array.from(state.sessions?.values() || []);
              const draggedData = all.find(s => s.session_id === dragged) || null;
              const currentWs = (draggedData && (draggedData.workspace || 'Default')) || 'Default';
              const targetWs = name;

              if (currentWs !== targetWs) {
                try {
                  const tm = getContext()?.app?.modules?.terminal;
                  if (tm?.sessionList && typeof tm.sessionList.assignToWorkspace === 'function') {
                    tm.sessionList.assignToWorkspace(dragged, targetWs);
                  } else {
                    await apiService.updateSessionWorkspace(dragged, targetWs);
                  }
                } catch (err) {
                  notificationDisplay.show({ title: 'Move Failed', message: err?.message || 'Unable to move session', notification_type: 'error' });
                  return;
                }
              }

              const inTargetWs = all.filter(s => (s.workspace || 'Default') === targetWs && s.is_active).map(s => s.session_id);
              let ids = rows.map(r => r.dataset.sessionId).filter(id => inTargetWs.includes(id));
              ids = ids.filter(id => id !== dragged);

              // Decide before-first vs after-last based on pointer
              const first = rows[0];
              const last = rows[rows.length - 1];
              const firstRect = first.getBoundingClientRect();
              const lastRect = last.getBoundingClientRect();
              const y = e.clientY;
              if (y < firstRect.top + 1) {
                ids.unshift(dragged);
              } else if (y > lastRect.bottom - 1) {
                ids.push(dragged);
              } else {
                // Not whitespace edge; let row handler manage (shouldn’t hit here)
                return;
              }
              // Optimistically apply local order so UI updates immediately
              try {
                const tm = getContext()?.app?.modules?.terminal;
                tm?.sessionList?.updateManualOrder?.(ids);
                // Synchronously re-render sidebar to reflect the new order
                try { this.render(); } catch (_) {}
              } catch (_) {}

              // If any local-only sessions are in the order, skip server persistence
              try {
                const sMap = this.store.getState().sessionList?.sessions || new Map();
                const hasLocalOnly = ids.some(id => {
                  const s = sMap.get(id);
                  return s && s.local_only === true;
                });
                if (!hasLocalOnly && targetWs) {
                  await apiService.reorderWorkspaceSessions(targetWs, ids);
                }
              } catch (err) {
                // Non-fatal: UI already updated locally
                if (err) console.warn('[WorkspaceList] reorder persistence skipped/failed', err);
              }
            } catch (err) {
              notificationDisplay.show({ title: 'Reorder Failed', message: err?.message || 'Unable to reorder sessions', notification_type: 'error' });
            } finally {
              this.draggedSessionId = null;
              this.dragOverSessionId = null;
              this.dragOverSessionPos = null;
            }
          });
        } catch (_) {}
        item.appendChild(list);
      }

      // Click and contextmenu handled by delegated listeners

      // Enable drag-and-drop reordering
      item.setAttribute('draggable', 'true');
      this.attachDragEventListeners(item, name);

      // Long-press to open context menu on touch devices
      let longPressTimer = null;
      let touchMoved = false;
      item.addEventListener('touchstart', (e) => {
        touchMoved = false;
        longPressTimer = setTimeout(() => {
          if (!touchMoved) {
            try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
            const touch = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches ? e.changedTouches[0] : null);
            const x = touch ? touch.pageX : 0;
            const y = touch ? touch.pageY : 0;
            this.openContextMenu(x, y, name);
          }
        }, 500);
      }, { passive: true });
      item.addEventListener('touchmove', () => {
        touchMoved = true;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      }, { passive: true });
      item.addEventListener('touchend', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      }, { passive: true });
      item.addEventListener('touchcancel', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      }, { passive: true });

      this.container.appendChild(item);
    });

    // Do not auto-switch workspaces during search; user must click explicitly
    // (Keep previous behavior for template-only filtering disabled to avoid surprises)
    // Intentionally no-op: visible list is updated, selection stays as-is.
  }

  // Ensure template colors are available, then re-render badges when ready
  ensureTemplateColorsLoaded() {
    if (this._templateColorsLoaded) return;
    const MAX_RETRIES = 20;
    const RETRY_DELAY = 150;
    const attempt = () => {
      this._templateColorsRetryTimer = null;
      try {
        const sl = (typeof getContext === 'function' ? getContext()?.app?.modules?.terminal?.sessionList : null) || window?.app?.modules?.terminal?.sessionList;
        if (sl && typeof sl.loadTemplatesForColors === 'function') {
          Promise.resolve(sl.loadTemplatesForColors())
            .then(() => {
              this._templateColorsLoaded = true;
              try { this.render(); } catch (_) {}
              // Signal UI ready now that template colors are loaded (badges won't flash)
              try {
                var isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
                if (isElectron) {
                  if (!window.__APP_UI_READY__) {
                    window.__APP_UI_READY__ = true;
                    // Electron: rely on main-process gating; no CSS class flips needed
                    try { document.documentElement.style.backgroundColor = ''; } catch (_) {}
                    // Notify main process that UI is ready so window can be shown
                    try { window.desktop && typeof window.desktop.uiReady === 'function' && window.desktop.uiReady(); } catch (_) {}
                  }
                } else {
                  // Web: flip CSS gate classes
                  var root = document.documentElement;
                  root.classList.remove('app-loading');
                  root.classList.add('app-ready');
                  try { if (window.__APP_LOADING_TIMEOUT__) clearTimeout(window.__APP_LOADING_TIMEOUT__); } catch (_) {}
                }
              } catch (_) {}
            })
            .catch(() => {
              if (this._templateColorsRetries++ < MAX_RETRIES) {
                this._templateColorsRetryTimer = setTimeout(attempt, RETRY_DELAY);
              }
            });
        } else if (this._templateColorsRetries++ < MAX_RETRIES) {
          this._templateColorsRetryTimer = setTimeout(attempt, RETRY_DELAY);
        }
      } catch (_) {
        if (this._templateColorsRetries++ < MAX_RETRIES) {
          this._templateColorsRetryTimer = setTimeout(attempt, RETRY_DELAY);
        }
      }
    };
    if (!this._templateColorsRetryTimer) {
      attempt();
    }
  }

  // Expand or collapse helpers for keyboard shortcuts (Issue #398)
  collapseAll() {
    try {
      this.expanded.clear();
      this.render();
    } catch (_) {}
  }

  expandAll() {
    try {
      const state = this.store.getState().workspaces || {};
      const items = state.items instanceof Set ? Array.from(state.items) : (Array.isArray(state.items) ? state.items : []);
      const names = Array.isArray(state.order) && state.order.length > 0 ? state.order : items;
      this.expanded = new Set(names);
      this.render();
    } catch (_) {}
  }

  /**
   * Expand a single workspace by name
   * @param {string} name
   */
  expandWorkspace(name) {
    if (!name) return;
    this.expanded.add(name);
    this.render();
  }

  /**
   * Collapse a single workspace by name
   * @param {string} name
   */
  collapseWorkspace(name) {
    if (!name) return;
    this.expanded.delete(name);
    this.render();
  }

  /**
   * Toggle expand/collapse for a single workspace by name
   * @param {string} name
   */
  toggleWorkspace(name) {
    if (!name) return;
    if (this.expanded.has(name)) {
      this.expanded.delete(name);
    } else {
      this.expanded.add(name);
    }
    this.render();
  }

  // Inline add removed in favor of modal

  getWorkspaceStats(sessions, workspace) {
    let live = 0;
    let inactive = 0;
    let sticky = 0;
    let stickySet = null;
    try {
      const tm = getContext()?.app?.modules?.terminal;
      stickySet = tm?.sessionList?.stickyTerminatedSessions instanceof Set ? tm.sessionList.stickyTerminatedSessions : null;
    } catch (_) {
      stickySet = null;
    }

    sessions.forEach((s) => {
      const ws = s.workspace || 'Default';
      if (ws !== workspace) return;
      const isSticky = stickySet ? stickySet.has(s.session_id) : false;
      if (s.is_active) {
        live++;
      } else if (isSticky) {
        sticky++;
      } else {
        inactive++;
      }
    });
    return {
      active: live + sticky,
      live,
      inactive,
      sticky
    };
  }

  async loadFromServer() {
    try {
      // Preserve existing filterActive to avoid resetting on refresh
      const prevWs = this.store.getState().workspaces || {};
      const prevFilterActive = Object.prototype.hasOwnProperty.call(prevWs, 'filterActive') ? prevWs.filterActive : undefined;
      const resp = await apiService.getWorkspaces();
      const list = (resp && Array.isArray(resp.workspaces)) ? resp.workspaces : [];
      const nameList = list.map(w => (typeof w === 'string' ? w : w?.name)).filter(Boolean);
      const names = new Set(nameList);
      if (!names.has('Default')) names.add('Default');
      const pinned = new Set(list.filter(w => typeof w === 'object' && w?.pinned).map(w => w.name).filter(Boolean));
      // Batch update
      this.store.beginTransaction();
      this.store.setPath('workspaces.order', nameList);
      this.store.setPath('workspaces.items', names);
      this.store.setPath('workspaces.pinned', pinned);
      if (prevFilterActive !== undefined) {
        this.store.setPath('workspaces.filterActive', prevFilterActive === true);
      }
      this.store.commitTransaction();

      // Do not auto-restore here; TerminalManager will restore after sessions load
    } catch (err) {
      // Non-fatal: keep default/derived list
      console.warn('[WorkspaceList] Failed to load server workspaces:', err?.message || err);
    }
  }

  restoreLastSelectedWorkspace() {
    if (this._workspaceRestored) return;
    try {
      // Skip restore if a session_id URL parameter was processed
      const tm = (typeof getContext === 'function' ? getContext()?.app?.modules?.terminal : null) || null;
      if (tm && tm.sessionIdParameterProcessed) return;

      let saved = null;
      try {
        const res = getStateStore().loadSync && getStateStore().loadSync();
        const st = res && res.ok ? (res.state || {}) : {};
        saved = st['terminal_manager_last_workspace'] || null;
      } catch (_) { saved = null; }
      if (!saved) return;

      const wsState = this.store.getState().workspaces || {};
      const items = wsState.items instanceof Set ? wsState.items : new Set(Array.isArray(wsState.items) ? wsState.items : []);
      if (!items || !items.has(saved)) return;

      // Select the saved workspace and switch to detail mode
      this.setCurrent(saved);
      this.setMode('detail');
      if (this.onSelect) this.onSelect(saved);
      this._workspaceRestored = true;
    } catch (_) {
      // ignore restore failures
    }
  }

  async handleRename(oldName) {
    this.showRenameWorkspaceModal(oldName);
  }

  ensureRenameWorkspaceModal() {
    if (this.renameWorkspaceModal) return this.renameWorkspaceModal;
    // Create modal element if not present in DOM
    let modal = document.getElementById('rename-workspace-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'rename-workspace-modal';
      modal.className = 'modal';
      modal.setAttribute('tabindex', '-1');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'rename-workspace-title');
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h2 id="rename-workspace-title" data-modal-title>Rename Workspace</h2>
            <button class="modal-close" data-modal-close>&times;</button>
          </div>
          <div class="modal-body">
            <form id="rename-workspace-form">
              <div class="form-group">
                <label for="rename-workspace-name">Workspace</label>
                <input type="text" id="rename-workspace-name" name="rename-workspace-name" placeholder="New workspace name" required autocomplete="off">
                <div id="rename-workspace-error" class="form-error" style="display: none;"></div>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-modal-close>Cancel</button>
            <button type="submit" class="btn btn-primary" data-modal-submit form="rename-workspace-form">Rename</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }

    // Initialize FormModal controller
    this.renameWorkspaceModal = new FormModal({
      element: modal,
      title: 'Rename Workspace',
      autoClose: false,
      onSubmit: async (formData) => {
        const nameRaw = formData['rename-workspace-name'] || '';
        const newName = (nameRaw || '').trim();
        const oldName = this._renameWorkspaceOldName || '';
        const errEl = document.getElementById('rename-workspace-error');
        if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
        if (!newName || newName === oldName) return; // no-op
        try {
          await apiService.renameWorkspace(oldName, newName);
          notificationDisplay.show({
            title: 'Workspace Renamed',
            message: `Renamed to "${newName}"`,
            notification_type: 'success'
          });
          this.renameWorkspaceModal.hide();
        } catch (e) {
          const msg = e?.message || 'Unable to rename workspace';
          if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
          notificationDisplay.show({ title: 'Rename Failed', message: msg, notification_type: 'error' });
        }
      },
      onValidate: (formData) => {
        try {
          const oldName = this._renameWorkspaceOldName || '';
          const nameRaw = formData['rename-workspace-name'] || '';
          const val = (nameRaw || '').trim();
          if (!val) return false;
          if (val.toLowerCase() === 'default') return false; // reserved
          if (val === oldName) return false; // unchanged
          return true;
        } catch (_) { return false; }
      }
    });

    return this.renameWorkspaceModal;
  }

  showRenameWorkspaceModal(oldName) {
    if (!oldName || oldName === 'Default') return; // safeguard
    const modal = this.ensureRenameWorkspaceModal();
    // Do not auto-close the sidebar when opening this modal
    // Remember context for validation/submit
    this._renameWorkspaceOldName = oldName;
    // Prefill field and clear any previous error
    try {
      modal.setFieldValue('rename-workspace-name', oldName);
      const err = document.getElementById('rename-workspace-error');
      if (err) { err.textContent = ''; err.style.display = 'none'; }
    } catch (_) {}
    modal.show();
  }

  ensureDeleteWorkspaceModal() {
    if (this.deleteWorkspaceModal) return this.deleteWorkspaceModal;
    // Create modal element if not present in DOM
    let modal = document.getElementById('delete-workspace-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'delete-workspace-modal';
      modal.className = 'modal';
      modal.setAttribute('tabindex', '-1');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'delete-workspace-title');
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h2 id="delete-workspace-title" data-modal-title>Delete Workspace</h2>
            <button class="modal-close" data-modal-close>&times;</button>
          </div>
          <div class="modal-body">
            <p data-modal-message></p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-modal-cancel>Cancel</button>
            <button type="button" class="btn btn-danger" data-modal-confirm>Delete</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }

    this.deleteWorkspaceModal = new ConfirmationModal({
      element: modal,
      title: 'Delete Workspace',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      destructive: true
    });

    return this.deleteWorkspaceModal;
  }

  showDeleteWorkspaceModal(name) {
    if (!name || name === 'Default') return; // safeguard
    const modal = this.ensureDeleteWorkspaceModal();
    if (!modal) return;
    const msg = `Delete workspace "${name}"? This does not affect existing sessions.`;
    modal.setMessage(msg);
    // Provide a fresh confirm callback bound to this name
    modal.confirmCallback = async () => {
      try {
        modal.setLoadingState(true, 'Deleting...');
        await apiService.deleteWorkspace(name);
        modal.hide();
        notificationDisplay.show({
          title: 'Workspace Deleted',
          message: `Deleted "${name}"`,
          notification_type: 'success'
        });
      } catch (error) {
        modal.setLoadingState(false);
        const message = error?.message || 'Unable to delete workspace';
        modal.setMessage(message);
        notificationDisplay.show({
          title: 'Delete Failed',
          message,
          notification_type: 'error'
        });
      }
    };
    modal.show();
  }

  async handleDelete(name) {
    // Replace confirm() prompt with modal confirmation
    this.showDeleteWorkspaceModal(name);
  }

  openContextMenu(x, y, name) {
    // Remove existing menu if any
    this.closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'workspace-context-menu';
    menu.style.position = 'absolute';
    menu.style.background = 'var(--bg-primary, #222)';
    menu.style.border = '1px solid var(--border-color, #444)';
    menu.style.borderRadius = '6px';
    menu.style.padding = '6px 0';
    menu.style.zIndex = '10003';
    menu.style.minWidth = '180px';
    menu.style.boxShadow = '0 4px 14px rgba(0,0,0,0.3)';

    const addItem = (label, onClick, danger = false, disabled = false) => {
      const item = document.createElement('div');
      item.textContent = label;
      item.style.padding = '6px 12px';
      item.style.cursor = disabled ? 'not-allowed' : 'pointer';
      item.style.color = danger ? 'var(--danger, #ff6b6b)' : 'var(--text-primary, #ddd)';
      item.addEventListener('mouseenter', () => { if (!disabled) item.style.background = 'var(--bg-hover, #333)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      if (!disabled) {
        item.addEventListener('click', () => {
          this.closeContextMenu();
          onClick();
        });
      }
      menu.appendChild(item);
    };

    addItem('Rename…', () => this.handleRename(name), false, name === 'Default');
    // Create session in this workspace
    addItem('Create Session', () => {
      try {
        const tm = getContext()?.app?.modules?.terminal;
        if (tm) {
          if (tm.enterWorkspace) tm.enterWorkspace(name);
          if (tm.showNewSessionModal) tm.showNewSessionModal();
        }
      } catch (_) {}
    });
    // Pin/Unpin
    const isPinned = (this.store.getState().workspaces?.pinned || new Set()).has(name);
    addItem(isPinned ? 'Unpin' : 'Pin', async () => {
      try {
        await apiService.updateWorkspace(name, { pinned: !isPinned });
        // UI will update via workspaces_updated broadcast
      } catch (e) {
        notificationDisplay.show({ title: 'Update Failed', message: e?.message || 'Unable to update', notification_type: 'error' });
      }
    }, false, name === 'Default');
    // Move helpers (non-DnD fallback)
    addItem('Move Up', async () => {
      try {
        const order = Array.from(this.store.getState().workspaces?.items || []);
        const idx = order.indexOf(name);
        if (idx > 0) {
          [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      
          await apiService.reorderWorkspaces(order);
        }
      } catch (e) {
        notificationDisplay.show({ title: 'Reorder Failed', message: e?.message || 'Unable to reorder workspaces', notification_type: 'error' });
      }
    }, false, name === 'Default');
    addItem('Move Down', async () => {
      try {
        const order = Array.from(this.store.getState().workspaces?.items || []);
        const idx = order.indexOf(name);
        if (idx !== -1 && idx < order.length - 1) {
          [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
          
          await apiService.reorderWorkspaces(order);
        }
      } catch (e) {
        notificationDisplay.show({ title: 'Reorder Failed', message: e?.message || 'Unable to reorder workspaces', notification_type: 'error' });
      }
    }, false, name === 'Default');
    addItem('Delete', () => this.handleDelete(name), true, name === 'Default');

    document.body.appendChild(menu);
    // Position near click/touch point; keep within viewport bounds
    try {
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const scrollX = window.scrollX || window.pageXOffset || 0;
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const rect = menu.getBoundingClientRect();

      let leftPx = x;
      let topPx = y;

      // Clamp horizontally
      const maxLeft = scrollX + vw - rect.width - 8;
      const minLeft = scrollX + 8;
      if (leftPx > maxLeft) leftPx = maxLeft;
      if (leftPx < minLeft) leftPx = minLeft;

      // Clamp vertically
      const maxTop = scrollY + vh - rect.height - 8;
      const minTop = scrollY + 8;
      if (topPx > maxTop) topPx = maxTop;
      if (topPx < minTop) topPx = minTop;

      menu.style.left = `${leftPx}px`;
      menu.style.top = `${topPx}px`;
    } catch (_) {
      // Fallback: if calculation fails, keep original coordinates
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    }
    this._contextMenuEl = menu;

    const close = () => this.closeContextMenu();
    setTimeout(() => {
      document.addEventListener('click', close, { once: true });
      document.addEventListener('contextmenu', close, { once: true });
      window.addEventListener('blur', close, { once: true });
      window.addEventListener('resize', close, { once: true });
      window.addEventListener('scroll', close, { once: true, passive: true });
    }, 0);
  }

  closeContextMenu() {
    if (this._contextMenuEl) {
      try { this._contextMenuEl.remove(); } catch (e) {}
      this._contextMenuEl = null;
    }
  }

  attachDragEventListeners(item, name) {
    item.addEventListener('dragstart', (e) => {
      this.draggedWorkspace = name;
      item.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', name); } catch (_) {}
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragenter', (e) => {
      if (!this.draggedWorkspace || this.draggedWorkspace === name) return;
      e.preventDefault();
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      this.draggedWorkspace = null;
      // Remove all indicators
      this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
    });
    item.addEventListener('dragover', (e) => {
      if (!this.draggedWorkspace || this.draggedWorkspace === name) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      const rect = item.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      // Clear previous indicators
      this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
      if (e.clientY < midpoint) {
        item.classList.add('drag-over-before');
        this.dragOverPosition = 'before';
      } else {
        item.classList.add('drag-over-after');
        this.dragOverPosition = 'after';
      }
      this.dragOverTarget = name;
      this._lastDragTarget = name;
      this._lastDragPos = this.dragOverPosition;
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      const dragged = this.draggedWorkspace;
      const target = this.dragOverTarget || name;
      const position = this.dragOverPosition || 'before';
      // Clear indicators
      this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
      if (!dragged || !target || dragged === target) return;
      try {
        // Build new order from current store order
        const state = this.store.getState();
        const currentOrder = Array.from(state.workspaces?.items || []);
        const filtered = currentOrder.filter(n => n !== dragged);
        const targetIndex = filtered.indexOf(target);
        const insertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
        filtered.splice(insertIndex, 0, dragged);
        // Persist to server; UI will update via WebSocket broadcast
        await apiService.reorderWorkspaces(filtered);
      } catch (err) {
        notificationDisplay.show({ title: 'Reorder Failed', message: err?.message || 'Unable to reorder workspaces', notification_type: 'error' });
      } finally {
        this.draggedWorkspace = null;
        this.dragOverTarget = null;
        this.dragOverPosition = null;
      }
    });
  }

  setupContainerDragEvents() {
    if (!this.container) return;

    this.container.addEventListener('dragover', (e) => {
      if (!this.draggedWorkspace) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      // Track last hovered target via item handlers; here just ensure default is prevented
    });

    this.container.addEventListener('drop', async (e) => {
      if (!this.draggedWorkspace) return;
      e.preventDefault();
      this.container.querySelectorAll('.drag-over-before, .drag-over-after').forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
      try {
        const state = this.store.getState();
        const currentOrder = Array.from(state.workspaces?.items || []);
        const dragged = this.draggedWorkspace;
        let filtered = currentOrder.filter(n => n !== dragged);
        let target = this.dragOverTarget;
        let position = this.dragOverPosition || 'after';
        // If target not set (e.g., dropped in whitespace), infer end
        if (!target || !filtered.includes(target)) {
          filtered.push(dragged);
        } else {
          const targetIndex = filtered.indexOf(target);
          const insertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
          filtered.splice(insertIndex, 0, dragged);
        }
        await apiService.reorderWorkspaces(filtered);
      } catch (err) {
        notificationDisplay.show({ title: 'Reorder Failed', message: err?.message || 'Unable to reorder workspaces', notification_type: 'error' });
      } finally {
        this.draggedWorkspace = null;
        this.dragOverTarget = null;
        this.dragOverPosition = null;
      }
    });
  }

  attachSessionRowDnD(row, workspaceName) {
    const sessionId = row.dataset.sessionId;
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.draggedSessionId = sessionId;
      row.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', sessionId); } catch (_) {}
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      this.draggedSessionId = null;
      // Remove indicators
      this.container.querySelectorAll('.workspace-session-row.drag-over-before, .workspace-session-row.drag-over-after')
        .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
    });
    row.addEventListener('dragover', (e) => {
      // Always allow drop on rows; the drop handler validates dragged id
      if (this.draggedSessionId === sessionId) return; // dragging this same row within workspace
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch(_) {}
      const rect = row.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      // Clear indicators in this workspace section
      const container = row.closest('.workspace-sessions');
      if (container) {
        container.querySelectorAll('.workspace-session-row.drag-over-before, .workspace-session-row.drag-over-after')
          .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
      }
      if (e.clientY < midpoint) {
        row.classList.add('drag-over-before');
        this.dragOverSessionPos = 'before';
      } else {
        row.classList.add('drag-over-after');
        this.dragOverSessionPos = 'after';
      }
      this.dragOverSessionId = sessionId;
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      // Support cross-workspace drop by reading from dataTransfer when needed
      const dragged = this.draggedSessionId || (function(dt){ try { return dt && dt.getData && dt.getData('text/plain'); } catch(_) { return null; } })(e.dataTransfer);
      const target = this.dragOverSessionId || sessionId;
      const pos = this.dragOverSessionPos || 'before';
      // Clear indicators
      const container = row.closest('.workspace-sessions');
      if (container) {
        container.querySelectorAll('.workspace-session-row.drag-over-before, .workspace-session-row.drag-over-after')
          .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
      }
      if (!dragged || !target || dragged === target) return;
      try {
        // Determine current and target workspaces for the dragged session
        const state = this.store.getState().sessionList;
        const all = Array.from(state.sessions?.values() || []);
        const draggedData = all.find(s => s.session_id === dragged) || null;
        const currentWs = (draggedData && (draggedData.workspace || 'Default')) || 'Default';
        const targetWs = workspaceName;

        // If moving across workspaces, update the workspace first
        if (currentWs !== targetWs) {
          try {
            // Prefer SessionList helper for both local/Electron and server
            const tm = getContext()?.app?.modules?.terminal;
            if (tm?.sessionList && typeof tm.sessionList.assignToWorkspace === 'function') {
              tm.sessionList.assignToWorkspace(dragged, targetWs);
            } else {
              await apiService.updateSessionWorkspace(dragged, targetWs);
            }
          } catch (err) {
            notificationDisplay.show({ title: 'Move Failed', message: err?.message || 'Unable to move session', notification_type: 'error' });
            return;
          }
        }

        // Build new order from visible active list within the target workspace
        const inTargetWs = all.filter(s => (s.workspace || 'Default') === targetWs && s.is_active).map(s => s.session_id);
        const rows = Array.from((container || row.parentElement).querySelectorAll('.workspace-session-row'));
        // Start from the DOM order but restrict to the target workspace set
        let ids = rows.map(r => r.dataset.sessionId).filter(id => inTargetWs.includes(id));
        // Ensure the dragged id participates in ordering
        ids = ids.filter(id => id !== dragged);
        const tIndex = ids.indexOf(target);
        const insertIndex = pos === 'after' ? tIndex + 1 : tIndex;
        ids.splice(insertIndex, 0, dragged);
              // Optimistically apply local order so UI updates immediately
              try {
                const tm = getContext()?.app?.modules?.terminal;
                tm?.sessionList?.updateManualOrder?.(ids);
                // Synchronously re-render sidebar to reflect the new order
                try { this.render(); } catch (_) {}
              } catch (_) {}

        // Skip server persistence when any local-only sessions are involved
        try {
          const sMap = this.store.getState().sessionList?.sessions || new Map();
          const hasLocalOnly = ids.some(id => {
            const s = sMap.get(id);
            return s && s.local_only === true;
          });
          if (!hasLocalOnly && targetWs) {
            await apiService.reorderWorkspaceSessions(targetWs, ids);
          }
        } catch (err) {
          // Non-fatal: UI already updated locally
          if (err) console.warn('[WorkspaceList] reorder persistence skipped/failed', err);
        }
      } catch (err) {
        notificationDisplay.show({ title: 'Reorder Failed', message: err?.message || 'Unable to reorder sessions', notification_type: 'error' });
      } finally {
        this.draggedSessionId = null;
        this.dragOverSessionId = null;
        this.dragOverSessionPos = null;
      }
    });

    // Context menu on right-click for session row
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const sessionId = row.dataset.sessionId;
        const state = this.store.getState();
        const data = state.sessionList?.sessions?.get(sessionId) || null;
        const cm = getContext()?.app?.modules?.terminal?.sessionList?.contextMenu;
        if (cm && data) {
          cm.show(e.pageX, e.pageY, data);
        }
      } catch (_) {}
    });

    // Long press to open context menu (mobile)
    let lpTimer = null;
    let moved = false;
    row.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      moved = false;
      lpTimer = setTimeout(() => {
        if (!moved) {
          const touch = e.touches && e.touches[0] ? e.touches[0] : null;
          const x = touch ? touch.pageX : 0;
          const y = touch ? touch.pageY : 0;
          try {
            const sessionId = row.dataset.sessionId;
            const state = this.store.getState();
            const data = state.sessionList?.sessions?.get(sessionId) || null;
            const cm = getContext()?.app?.modules?.terminal?.sessionList?.contextMenu;
            if (cm && data) {
              cm.show(x, y, data);
            }
          } catch (_) {}
        }
      }, 500);
    }, { passive: true });
    row.addEventListener('touchmove', (e) => { e.stopPropagation(); moved = true; if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }, { passive: true });
    row.addEventListener('touchend', (e) => { e.stopPropagation(); if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }, { passive: true });
    row.addEventListener('touchcancel', (e) => { e.stopPropagation(); if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }, { passive: true });
  }
}
