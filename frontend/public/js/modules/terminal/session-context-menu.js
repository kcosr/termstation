/**
 * Session Context Menu
 * Handles context menu creation, positioning, and action handling for sessions
 */
import { iconUtils } from '../../utils/icon-utils.js';
import { apiService } from '../../services/api.service.js';
import { appStore } from '../../core/store.js';
import { TerminalAutoCopy } from '../../utils/terminal-auto-copy.js';
import { notificationDisplay } from '../../utils/notification-display.js';
import { getContext } from '../../core/context.js';
import { ConfirmationModal } from '../ui/modal.js';
import { openAddRuleModal, openListRulesModal, openSendInputNowModal } from '../ui/scheduled-input-modals.js';
import { computeDisplayTitle } from '../../utils/title-utils.js';
import { config } from '../../core/config.js';

export class SessionContextMenu {
    constructor(sessionList, container) {
        this.sessionList = sessionList;
        this.container = container;
        this.contextMenu = null;
        this.isOpen = false;
        this.stopConfirmModal = null;
        this.setup();
    }

    setup() {
        // Create context menu element
        this.contextMenu = document.createElement('div');
        // Add a specific class so mobile positioning rules can target only session menus
        this.contextMenu.className = 'terminal-context-menu session-context-menu';
        this.contextMenu.style.display = 'none';
        document.body.appendChild(this.contextMenu);

        // Setup global event listeners
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Hide context menu on click outside
        document.addEventListener('click', (e) => {
            if (!this.contextMenu.contains(e.target)) {
                this.hide();
            }
        });

        // Hide context menu on scroll
        this.container.addEventListener('scroll', () => {
            this.hide();
        }, { passive: true });

        // Hide context menu on window resize
        window.addEventListener('resize', () => {
            this.hide();
        });
    }

    async show(x, y, sessionData) {
        this.isOpen = true;
        
        // Fetch available workspaces from server (fallback to local)
        let availableWorkspaces = [];
        try {
            const resp = await apiService.getWorkspaces();
            const list = Array.isArray(resp?.workspaces) ? resp.workspaces : [];
            availableWorkspaces = list.map(w => (typeof w === 'string' ? w : w?.name)).filter(Boolean);
        } catch (e) {
            availableWorkspaces = this.getAvailableWorkspaces();
        }
        
        // Build menu items based on session state
        const menuItems = await this.buildMenuItems(sessionData, availableWorkspaces);
        // Alphabetize top-level entries for consistency across sidebar and tabs
        try {
            menuItems.sort((a, b) => {
                const la = String(a?.label || '').toLowerCase();
                const lb = String(b?.label || '').toLowerCase();
                return la.localeCompare(lb, undefined, { sensitivity: 'base' });
            });
        } catch (_) { /* non-fatal */ }
        
        // Clear existing content
        this.contextMenu.innerHTML = '';
        
        // Generate menu elements
        menuItems.forEach(item => {
            const menuElement = document.createElement('div');
            menuElement.className = 'context-menu-item';
            menuElement.setAttribute('data-action', item.label.toLowerCase());
            
            if (item.isSubmenu) {
                menuElement.classList.add('context-menu-submenu');
                
                // Create main item
                const iconSpan = document.createElement('span');
                iconSpan.className = 'context-menu-icon';
                iconSpan.appendChild(iconUtils.createIcon(item.icon, { size: 16 }));
                
                const labelSpan = document.createElement('span');
                labelSpan.className = 'context-menu-label';
                labelSpan.textContent = item.label;
                
                const arrowSpan = document.createElement('span');
                arrowSpan.className = 'context-submenu-arrow';
                arrowSpan.textContent = '▶';
                
                menuElement.appendChild(iconSpan);
                menuElement.appendChild(labelSpan);
                menuElement.appendChild(arrowSpan);
                
                // Create submenu
                const submenu = document.createElement('div');
                submenu.className = 'context-submenu';
                
                item.submenuItems.forEach(subItem => {
                    // Support nested submenus inside the first submenu level (for Clients -> [client] -> actions)
                    const subElement = document.createElement('div');
                    subElement.className = 'context-submenu-item';

                    if (subItem.isSubmenu) {
                        // This submenu item itself hosts a submenu (e.g., a Client row)
                        subElement.classList.add('context-menu-submenu');

                        // Client row: label only (no icon), plus arrow
                        const subLabelSpan = document.createElement('span');
                        subLabelSpan.className = 'context-menu-label';
                        subLabelSpan.textContent = subItem.label;
                        const subArrowSpan = document.createElement('span');
                        subArrowSpan.className = 'context-submenu-arrow';
                        subArrowSpan.textContent = '▶';
                        subElement.appendChild(subLabelSpan);
                        subElement.appendChild(subArrowSpan);

                        // Build second-level submenu
                        const nested = document.createElement('div');
                        nested.className = 'context-submenu';
                        (subItem.submenuItems || []).forEach((actionItem) => {
                            const actionEl = document.createElement('div');
                            actionEl.className = 'context-submenu-item';

                            // No leading icon for nested actions (clean, text-only)
                            const actLabelSpan = document.createElement('span');
                            actLabelSpan.className = 'context-menu-label';
                            actLabelSpan.textContent = actionItem.label;
                            actionEl.appendChild(actLabelSpan);
                            if (actionItem.header) {
                                actionEl.classList.add('context-submenu-header');
                            }
                            nested.appendChild(actionEl);
                        });
                        subElement.appendChild(nested);
                        submenu.appendChild(subElement);
                    } else {
                        // Regular first-level submenu item
                        if (subItem.icon) {
                            const subIconSpan = document.createElement('span');
                            subIconSpan.className = 'context-menu-icon';
                            subIconSpan.appendChild(iconUtils.createIcon(subItem.icon, { size: 16 }));
                            subElement.appendChild(subIconSpan);
                        } else {
                            const spacer = document.createElement('span');
                            spacer.className = 'context-menu-icon';
                            subElement.appendChild(spacer);
                        }
                        const subLabelSpan = document.createElement('span');
                        subLabelSpan.className = 'context-menu-label';
                        subLabelSpan.textContent = subItem.label;
                        subElement.appendChild(subLabelSpan);
                        submenu.appendChild(subElement);
                    }
                });
                
                menuElement.appendChild(submenu);
            } else {
                const iconSpan = document.createElement('span');
                iconSpan.className = 'context-menu-icon';
                iconSpan.appendChild(iconUtils.createIcon(item.icon, { size: 16 }));
                
                const labelSpan = document.createElement('span');
                labelSpan.className = 'context-menu-label';
                labelSpan.textContent = item.label;
                
                menuElement.appendChild(iconSpan);
                menuElement.appendChild(labelSpan);
            }
            
            this.contextMenu.appendChild(menuElement);
        });

        // Add click handlers to menu items
        menuItems.forEach((item, index) => {
            const menuElement = this.contextMenu.children[index];
            
            if (item.isSubmenu) {
                // Handle submenu items
                // Pick only first-level submenu items, not nested ones
                const submenuRoot = menuElement.querySelector(':scope > .context-submenu') || menuElement.querySelector('.context-submenu');
                const submenuItems = submenuRoot ? submenuRoot.querySelectorAll(':scope > .context-submenu-item') : menuElement.querySelectorAll('.context-submenu > .context-submenu-item');
                submenuItems.forEach((submenuElement, subIndex) => {
                    const def = item.submenuItems[subIndex];
                    // If this submenu item hosts its own submenu, handle hover open
                    if (def && def.isSubmenu) {
                        const open = () => {
                            submenuElement.classList.add('submenu-open');
                            // After opening, adjust nested submenu to fit viewport vertically
                            try {
                                const nestedAdj = submenuElement.querySelector('.context-submenu');
                                if (nestedAdj) {
                                    // Reset any previous offset
                                    nestedAdj.style.top = '0px';
                                    const r = nestedAdj.getBoundingClientRect();
                                    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
                                    // If overflowing bottom, shift up
                                    const overflowBottom = r.bottom - vh;
                                    if (overflowBottom > 0) {
                                        nestedAdj.style.top = `${-(overflowBottom + 8)}px`;
                                    }
                                    // If overflowing top, push down
                                    const overflowTop = r.top;
                                    if (overflowTop < 0) {
                                        nestedAdj.style.top = `${(parseFloat(nestedAdj.style.top) || 0) + (8 - overflowTop)}px`;
                                    }
                                }
                            } catch (_) {}
                        };
                        const closeIfNotHovering = () => {
                            // Defer slightly to allow pointer to move into nested submenu
                            setTimeout(() => {
                                const nested = submenuElement.querySelector('.context-submenu');
                                const overParent = submenuElement.matches(':hover');
                                const overNested = nested && nested.matches(':hover');
                                if (!overParent && !overNested) {
                                    submenuElement.classList.remove('submenu-open');
                                }
                            }, 20);
                        };

                        submenuElement.addEventListener('mouseenter', open);
                        submenuElement.addEventListener('mouseleave', closeIfNotHovering);

                        // Keep submenu open when hovering the nested submenu
                        try {
                            const nestedEl = submenuElement.querySelector('.context-submenu');
                            if (nestedEl) {
                                nestedEl.addEventListener('mouseenter', open);
                                nestedEl.addEventListener('mouseleave', closeIfNotHovering);
                            }
                        } catch (_) {}
                        // Attach click handlers to the nested action items
                        const nestedRoot = submenuElement.querySelector(':scope > .context-submenu') || submenuElement.querySelector('.context-submenu');
                        const nestedActions = nestedRoot ? nestedRoot.querySelectorAll(':scope > .context-submenu-item') : submenuElement.querySelectorAll('.context-submenu .context-submenu-item');
                        nestedActions.forEach((actionEl, idx) => {
                            const actionItem = (def.submenuItems || [])[idx];
                            if (!actionItem || actionItem.header) return; // skip headers
                            actionEl.addEventListener('click', (e) => {
                                e.stopPropagation();
                                if (typeof actionItem.action === 'function') actionItem.action();
                            });
                        });
                    } else {
                        submenuElement.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const sub = item.submenuItems[subIndex];
                            if (sub && typeof sub.action === 'function') sub.action();
                        });
                    }
                });
                
                // Show/hide submenu on hover
                menuElement.addEventListener('mouseenter', () => {
                    menuElement.classList.add('submenu-open');
                });
                
                menuElement.addEventListener('mouseleave', () => {
                    menuElement.classList.remove('submenu-open');
                });
            } else {
                menuElement.addEventListener('click', (e) => {
                    e.stopPropagation();
                    item.action();
                });
            }
        });

        // Position and show the menu
        this.position(x, y);
    }

    hide() {
        if (this.contextMenu) {
            this.contextMenu.style.display = 'none';
            this.isOpen = false;
        }
    }

    position(x, y) {
        this.contextMenu.style.display = 'block';
        this.contextMenu.style.left = `${x}px`;
        this.contextMenu.style.top = `${y}px`;

        // Adjust position if menu goes off-screen
        const rect = this.contextMenu.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        if (rect.right > windowWidth) {
            this.contextMenu.style.left = `${x - rect.width}px`;
        }

        if (rect.bottom > windowHeight) {
            this.contextMenu.style.top = `${y - rect.height}px`;
        }
    }

    async buildMenuItems(sessionData, availableWorkspaces = []) {
        const menuItems = [];
        const manager = this.sessionList.manager;
        const currentUser = (manager && typeof manager.getCurrentUsername === 'function')
            ? String(manager.getCurrentUsername() || '')
            : String((manager?.store?.getState()?.preferences?.auth?.username) || '');
        const owner = String(sessionData?.created_by || '');
        const isOwner = String(currentUser || '') === owner;
        const isLocalOnly = !!(sessionData && sessionData.local_only === true);
        const isChild = !!(sessionData && sessionData.parent_session_id);
        const parentId = isChild ? sessionData.parent_session_id : null;

        // View option is always available (parent -> terminal tab, child -> container tab)
        menuItems.push({
            label: 'View',
            icon: 'eye',
            action: async () => {
                try {
                    if (isChild && parentId) {
                        if (typeof manager.activateSession === 'function') {
                            await manager.activateSession(parentId);
                        } else {
                            await manager.selectSession(parentId);
                        }
                        try {
                            const tabMgr = manager?.getTabManager?.();
                            if (tabMgr) {
                                const child = manager?.childSessions?.get?.(sessionData.session_id) || sessionData;
                                try { tabMgr.ensureContainerTab(parentId, child); } catch (_) {}
                                try { tabMgr.activateContainerTab(parentId, sessionData.session_id); } catch (_) {}
                            }
                        } catch (_) {}
                    } else {
                        if (typeof manager.activateSession === 'function') {
                            await manager.activateSession(sessionData.session_id);
                        } else {
                            await manager.selectSession(sessionData.session_id);
                        }
                        try { manager?.getTabManager?.()?.switchToTab?.('terminal'); } catch (_) {}
                    }
                } finally {
                    this.hide();
                }
            }
        });

        // Open in dedicated window
        try {
            const titleText = (() => {
                try { return computeDisplayTitle(sessionData, { fallbackOrder: ['template_name','command'], defaultValue: sessionData.session_id }); } catch (_) { return sessionData.session_id; }
            })();
            if (window.desktop && window.desktop.isElectron && typeof window.desktop.openSessionWindow === 'function') {
                // Electron: use IPC, with toggle behavior via get/close when available
                let isOpen = false;
                try {
                    if (typeof window.desktop.getSessionWindow === 'function') {
                        const info = await window.desktop.getSessionWindow(sessionData.session_id);
                        isOpen = !!(info && info.ok && info.windowId);
                    }
                } catch (_) { isOpen = false; }

                if (isOpen && typeof window.desktop.closeSessionWindow === 'function') {
                    menuItems.push({
                        label: 'Close dedicated window',
                        icon: 'x-circle',
                        action: async () => {
                            try { await window.desktop.closeSessionWindow(sessionData.session_id); } catch (_) {}
                            this.hide();
                        }
                    });
                } else {
                    menuItems.push({
                        label: 'Open in dedicated window',
                        icon: 'box-arrow-up-right',
                        action: async () => {
                            try { await window.desktop.openSessionWindow(sessionData.session_id, titleText); } catch (_) {}
                            this.hide();
                        }
                    });
                }
                // Desktop-only: add an "Open in Browser" convenience below (omit for local-only)
                if (!(sessionData && sessionData.local_only === true)) {
                    menuItems.push({
                        label: 'Open in browser',
                        icon: 'box-arrow-up-right',
                        action: async () => {
                            try {
                                const url = (window.WindowModeUtils && WindowModeUtils.buildWindowModeUrl)
                                    ? WindowModeUtils.buildWindowModeUrl(sessionData.session_id)
                                    : (window.location.origin + window.location.pathname + `?session_id=${encodeURIComponent(sessionData.session_id)}&window=1&ui=window`);
                                if (window.desktop && typeof window.desktop.openExternal === 'function') {
                                    await window.desktop.openExternal(url);
                                } else {
                                    window.open(url, '_blank', 'noopener,noreferrer');
                                }
                            } catch (_) {}
                            this.hide();
                        }
                    });
                }
            } else {
                // Web: open a new tab/window with window-mode UI; we cannot track state, so always offer open
                menuItems.push({
                    label: 'Open in dedicated window',
                    icon: 'box-arrow-up-right',
                    action: async () => {
                        try {
                            const url = (window.WindowModeUtils && WindowModeUtils.buildWindowModeUrl)
                                ? WindowModeUtils.buildWindowModeUrl(sessionData.session_id)
                                : (window.location.origin + window.location.pathname + `?session_id=${encodeURIComponent(sessionData.session_id)}&window=1&ui=window`);
                            window.open(url, '_blank', 'noopener,noreferrer');
                        } catch (_) {}
                        this.hide();
                    }
                });
            }
        } catch (_) { /* ignore */ }

        // Clear option only for active interactive sessions
        if (sessionData.is_active && manager.isSessionInteractive(sessionData)) {
            menuItems.push({
                label: 'Clear',
                icon: 'eraser',
                action: async () => {
                    // Select the session first if not already selected
                    if (manager.currentSessionId !== sessionData.session_id) {
                        if (typeof manager.activateSession === 'function') {
                            manager.activateSession(sessionData.session_id);
                        } else {
                            manager.selectSession(sessionData.session_id);
                        }
                    }
                    // Then clear the local terminal
                    try { if (manager.currentSession) manager.currentSession.clear(); } catch (_) {}
                    // And request server-side history deletion (mirror toolbar behavior)
                    try {
                        await apiService.clearSessionHistory(sessionData.session_id);
                    } catch (error) {
                        console.warn('[SessionContextMenu] Failed to clear server-side history:', error);
                    } finally {
                        this.hide();
                    }
                }
            });
        }

        // Text input option only for active interactive sessions
        if (sessionData.is_active && manager.isSessionInteractive(sessionData)) {
            menuItems.push({
                label: 'Text input',
                icon: 'message-square',
                action: async () => {
                    try {
                        if (isChild && parentId) {
                            // Ensure parent + child tab active for correct routing
                            if (manager.currentSessionId !== parentId) {
                                await manager.selectSession(parentId);
                            }
                            try { await manager.attachChildSession(sessionData.session_id, { markActive: true, focus: true }); } catch (_) {}
                        } else {
                            if (manager.currentSessionId !== sessionData.session_id) {
                                await manager.selectSession(sessionData.session_id);
                            }
                        }
                        manager.showTextInputModal();
                    } finally { this.hide(); }
                }
            });
        }

        // Attach/Detach option for active sessions - Issue #356 Fix
        const isAttached = manager && manager.attachedSessions && 
            manager.attachedSessions.has(sessionData.session_id);
        const isElectron = !!(window.desktop && window.desktop.isElectron);
        if (sessionData.is_active && !(isElectron && isLocalOnly)) {
            if (isAttached) {
                menuItems.push({
                    label: 'Detach',
                    icon: 'terminal-dash',
                    action: () => {
                        manager.detachSession(sessionData.session_id);
                        this.hide();
                    }
                });
            } else {
                menuItems.push({
                    label: 'Attach',
                    icon: 'link',
                    action: () => {
                        // Select the session first if not already selected
                        if (manager.currentSessionId !== sessionData.session_id) {
                            manager.selectSession(sessionData.session_id);
                        }
                        // Then attach it
                        manager.attachToCurrentSession();
                        this.hide();
                    }
                });
            }

            // Login to Container – only for container-isolated sessions; compute container name locally
            if (this._isContainerSession(sessionData)) {
                let canLogin = false;
                try {
                    const perms = appStore?.getState?.()?.auth?.permissions || {};
                    canLogin = perms.sandbox_login === true;
                } catch (_) { canLogin = false; }
                if (canLogin) {
                menuItems.push({
                    label: 'Login to Container',
                    icon: 'terminal',
                    action: async () => {
                        try {
                            const ref = this._getContainerName(sessionData);
                            const { app } = getContext();
                            const clientId = app && app.clientId ? app.clientId : null;
                            const terminalManager = app?.modules?.terminal;
                            const created = await apiService.attachContainer(ref, {
                                clientId,
                                parentSessionId: sessionData.session_id
                            });
                            if (created && terminalManager?.ensureContainerSessionReady) {
                                await terminalManager.ensureContainerSessionReady(created, { activate: true });
                            }
                            try { app?.showPage?.('terminal'); } catch (_) {}
                        } catch (error) {
                            notificationDisplay.show({
                                title: 'Failed to Login to Container',
                                message: error?.message || 'Unable to connect to the container for this session.',
                                notification_type: 'error',
                                session_id: sessionData.session_id
                            });
                        } finally {
                            this.hide();
                        }
                    }
                });
                }
            }
        }

        // Clients submenu - list all connected clients (including myself)
        try {
            const clientsDetailed = Array.isArray(sessionData.connected_clients_info)
                ? sessionData.connected_clients_info
                : (Array.isArray(sessionData.connected_client_ids)
                    ? sessionData.connected_client_ids.map(id => ({ client_id: id, username: 'default' }))
                    : []);

            if (sessionData.is_active && clientsDetailed.length > 0) {
                const currentClientId = manager && manager.clientId ? manager.clientId : null;
                // Sort so that the current client (me) appears at the top
                const clientsSorted = [...clientsDetailed].sort((a, b) => {
                    const aMe = currentClientId && a.client_id === currentClientId ? 1 : 0;
                    const bMe = currentClientId && b.client_id === currentClientId ? 1 : 0;
                    return bMe - aMe; // put 'me' first when present
                });
                const submenuItems = clientsSorted.map(c => {
                    const uname = c.username && String(c.username).trim() ? c.username : 'default';
                    const label = (currentClientId && c.client_id === currentClientId) ? `${uname} (me)` : uname;
                    return {
                        label,
                        isSubmenu: true,
                        submenuItems: [
                            { header: true, label: `Client ID: ${c.client_id}` },
                            {
                                label: 'Detach',
                                icon: 'terminal-dash',
                                action: () => {
                                    try {
                                        manager.wsClient.send('detach_client', {
                                            session_id: sessionData.session_id,
                                            target_client_id: c.client_id
                                        });
                                    } catch (e) {
                                        console.warn('[SessionContextMenu] Failed to send detach_client:', e);
                                    }
                                    this.hide();
                                }
                            }
                        ]
                    };
                });

                menuItems.push({
                    label: 'Clients',
                    icon: 'card-list',
                    isSubmenu: true,
                    submenuItems
                });
            }
        } catch (e) {
            // Non-fatal if clients info unavailable
        }

        // Pin/Unpin option - available for all sessions. For child sessions, pin the parent.
        const pinTargetId = isChild && parentId ? parentId : sessionData.session_id;
        const isPinned = this.sessionList.isPinned(pinTargetId);
        menuItems.push({
            label: isPinned ? 'Unpin' : 'Pin',
            icon: isPinned ? 'pin-off' : 'pin',
            action: () => {
                this.sessionList.togglePinSession(pinTargetId);
                this.hide();
            }
        });

        // Rename option - allow for owner OR local-only sessions (no server call needed)
        if (isOwner || isLocalOnly) {
            menuItems.push({
                label: 'Rename',
                icon: 'tag',
                action: () => {
                    this.sessionList.showSetTitleModal(sessionData);
                    this.hide();
                }
            });
        }

        // Toggle Save History option - owner only
        if (isOwner) {
            const saveHistoryLabel = sessionData.save_session_history !== false ? 'Disable save history' : 'Enable save history';
            const saveHistoryIcon = sessionData.save_session_history !== false ? 'save' : 'note';
            menuItems.push({
                label: saveHistoryLabel,
                icon: saveHistoryIcon,
                action: () => {
                    this.sessionList.toggleSaveHistory(sessionData);
                    this.hide();
                }
            });
        }

        // Open workspace option - only in Electron desktop when API host is local
        // Uses the same feature flag logic as the workspace tab
        try {
            const canOpenWorkspace = this._canOpenWorkspace(sessionData);
            if (canOpenWorkspace.show) {
                menuItems.push({
                    label: 'Open workspace dir',
                    icon: 'folder2-open',
                    action: async () => {
                        try {
                            const result = await window.desktop.openPath(canOpenWorkspace.path);
                            if (!result.ok) {
                                notificationDisplay?.show?.({
                                    notification_type: 'error',
                                    title: 'Open Workspace Failed',
                                    message: result.error || 'Unable to open workspace folder.',
                                    timestamp: new Date().toISOString()
                                }, { duration: 5000 });
                            }
                        } catch (e) {
                            notificationDisplay?.show?.({
                                notification_type: 'error',
                                title: 'Open Workspace Failed',
                                message: e?.message || 'Unable to open workspace folder.',
                                timestamp: new Date().toISOString()
                            }, { duration: 5000 });
                        } finally {
                            this.hide();
                        }
                    }
                });
            }
        } catch (_) { /* non-fatal */ }

        // Copy submenu - quick copy of common attributes
        const sessionIdToCopy = sessionData.session_id || '';
        const commandToCopy = sessionData.command || '/bin/bash';
        let workspacePathToCopy = '';
        try {
            const mode = String(sessionData.isolation_mode || '').toLowerCase();
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
        } catch (_) { /* non-fatal */ }

        const copySubmenuItems = [
            {
                label: 'Session object',
                icon: 'copy',
                action: () => {
                    try {
                        const json = JSON.stringify(sessionData, null, 2);
                        TerminalAutoCopy.copyToClipboard(json, 'session');
                    } catch (e) {
                        // Fallback: attempt safe stringify
                        const safe = JSON.stringify(sessionData, (k, v) => {
                            if (v instanceof Map) return Object.fromEntries(v);
                            if (v instanceof Set) return Array.from(v);
                            return v;
                        }, 2);
                        TerminalAutoCopy.copyToClipboard(safe, 'session');
                    }
                    this.hide();
                }
            },
            {
                label: 'Session ID',
                icon: 'copy',
                action: () => {
                    TerminalAutoCopy.copyToClipboard(sessionIdToCopy, 'session');
                    this.hide();
                }
            },
            {
                label: 'Command',
                icon: 'copy',
                action: () => {
                    TerminalAutoCopy.copyToClipboard(commandToCopy, 'session');
                    this.hide();
                }
            }
        ];

        if (workspacePathToCopy) {
            copySubmenuItems.push({
                label: 'Workspace path',
                icon: 'copy',
                action: () => {
                    TerminalAutoCopy.copyToClipboard(workspacePathToCopy, 'session');
                    this.hide();
                }
            });
        }

        try {
            copySubmenuItems.sort((a, b) => {
                const la = String(a?.label || '').toLowerCase();
                const lb = String(b?.label || '').toLowerCase();
                return la.localeCompare(lb, undefined, { sensitivity: 'base' });
            });
        } catch (_) { /* non-fatal */ }

        menuItems.push({
            label: 'Copy',
            icon: 'copy',
            isSubmenu: true,
            submenuItems: copySubmenuItems
        });

        // Move option - submenu with Top and Bottom (child entries move the parent session)
        menuItems.push({
            label: 'Move',
            icon: 'move',
            isSubmenu: true,
            submenuItems: [
                {
                    label: 'Top',
                    icon: 'arrow-up',
                    action: () => {
                        const target = isChild && parentId ? parentId : sessionData.session_id;
                        this.sessionList.moveSessionToTop(target);
                        this.hide();
                    }
                },
                {
                    label: 'Bottom',
                    icon: 'arrow-down',
                    action: () => {
                        const target = isChild && parentId ? parentId : sessionData.session_id;
                        this.sessionList.moveSessionToBottom(target);
                        this.hide();
                    }
                }
            ]
        });

        // Scheduled Inputs single entry (opens list modal)
        // Not available for local-only sessions in the desktop app
        try {
            if (!isLocalOnly) {
                menuItems.push({
                    label: 'Scheduled inputs',
                    icon: 'alarm',
                    action: () => {
                        try { openListRulesModal(sessionData.session_id); } catch (_) {}
                        this.hide();
                    }
                });
            }
        } catch (_) {}

        // Visibility option - submenu
        try {
            const currentVisibility = sessionData.visibility || 'private';
            const visOptions = [
                { label: 'Private (only you)', value: 'private', icon: 'lock' },
                { label: 'Shared (read-only for others)', value: 'shared_readonly', icon: 'users' },
                { label: 'Public (full access)', value: 'public', icon: 'globe' }
            ].filter(Boolean);

            const visSubmenuItems = visOptions.map(opt => ({
                label: (opt.value === currentVisibility ? '• ' : '') + opt.label,
                icon: opt.icon,
                action: async () => {
                    try {
                        await apiService.setSessionVisibility(sessionData.session_id, opt.value);
                        notificationDisplay?.show?.({ notification_type: 'success', title: 'Visibility Updated', message: `Set to ${opt.label}.`, timestamp: new Date().toISOString() }, { duration: 3000 });
                    } catch (e) {
                        console.error('[SessionContextMenu] set visibility failed:', e);
                        notificationDisplay?.show?.({ notification_type: 'error', title: 'Update Failed', message: e?.message || 'Failed to update visibility.', timestamp: new Date().toISOString() }, { duration: 5000 });
                    } finally {
                        this.hide();
                    }
                }
            }));
            // Visibility changes are server-side only; hide for local-only sessions
            if (isOwner && !isLocalOnly) {
                menuItems.push({
            label: 'Visibility',
                    icon: 'share',
                    isSubmenu: true,
                    submenuItems: visSubmenuItems
                });
            }
        } catch (_) {}

        // Assign to Workspace option - submenu with available workspaces (not for child sessions)
        const workspaces = (availableWorkspaces && availableWorkspaces.length)
            ? availableWorkspaces
            : this.getAvailableWorkspaces();
        const currentWorkspace = sessionData.workspace || 'Default';
        if (!isChild && (isOwner || isLocalOnly) && (workspaces.length > 1 || (workspaces.length === 1 && workspaces[0] !== currentWorkspace))) {
            const workspaceSubmenuItems = workspaces
                .filter(ws => ws !== currentWorkspace)
                .map(workspace => ({
                    label: workspace,
                    icon: 'folder',
                    action: () => {
                        this.sessionList.assignToWorkspace(sessionData.session_id, workspace);
                        this.hide();
                    }
                }));
            
            if (workspaceSubmenuItems.length > 0) {
            menuItems.push({
                label: 'Assign to workspace',
                    icon: 'layers',
                    isSubmenu: true,
                    submenuItems: workspaceSubmenuItems
                });
            }
        }

        // Stop Container option - only for container-isolated sessions; compute name locally
        if (!isChild && this._isContainerSession(sessionData) && isOwner) {
            menuItems.push({
                label: 'Stop container',
                icon: 'stop-circle',
                action: async () => {
                try {
                    const ref = this._getContainerName(sessionData);

                    // Use confirmation modal
                    const modal = this.ensureStopModal();
                    if (!modal) {
                        if (window.confirm(`Stop container "${ref}"?`)) {
                            await apiService.stopContainer(ref);
                            notificationDisplay?.show?.({ notification_type: 'success', title: 'Container Stopped', message: `Stopped ${ref}.`, timestamp: new Date().toISOString() }, { duration: 4000 });
                        }
                        this.hide();
                        return;
                    }
                    modal.setMessage(`Stop container "${ref}"?`);
                    modal.confirmCallback = async () => {
                        try {
                            modal.setLoadingState(true, 'Stopping...');
                            await apiService.stopContainer(ref);
                            notificationDisplay?.show?.({ notification_type: 'success', title: 'Container Stopped', message: `Stopped ${ref}.`, timestamp: new Date().toISOString() }, { duration: 4000 });
                            modal.hide();
                        } catch (err) {
                            console.error('[SessionContextMenu] Stop Container failed:', err);
                            modal.setLoadingState(false);
                            modal.setMessage(err?.message || 'Failed to stop container.');
                        } finally {
                            this.hide();
                        }
                    };
                    modal.show();
                } catch (err) {
                    console.error('[SessionContextMenu] Stop Container failed:', err);
                    notificationDisplay?.show?.({ notification_type: 'error', title: 'Stop Failed', message: err?.message || 'Failed to stop container.', timestamp: new Date().toISOString() }, { duration: 6000 });
                } finally {
                    this.hide();
                }
                }
            });
        }

        // Terminate option only for active sessions and when interactive for this client (not read-only)
        if (sessionData.is_active && manager.isSessionInteractive(sessionData)) {
            menuItems.push({
                label: 'Terminate',
                icon: 'terminal-x',
                action: () => {
                    manager.closeSession(sessionData.session_id);
                    this.hide();
                }
            });
        } else if (sessionData.is_active === false) {
        // Fork option for terminated sessions
        if (!isLocalOnly) {
            const forkMenu = this._buildForkMenuItem(sessionData);
            if (forkMenu) menuItems.push(forkMenu);
        }
            menuItems.push({
                label: 'Close session',
                icon: 'x',
                action: () => {
                    manager.closeEndedSession(sessionData.session_id);
                    this.hide();
                }
            });
        }

        // Fork option for active sessions as well
        if (sessionData.is_active) {
            if (!isLocalOnly) {
                const forkMenu = this._buildForkMenuItem(sessionData);
                if (forkMenu) menuItems.push(forkMenu);
            }
        }

        // Session Links sub-menu - available when there are links
        const links = sessionData.links || [];
        if (links.length > 0) {
            const visibleLinks = links.filter(link => this._shouldShowLink(link, sessionData));
            if (visibleLinks.length > 0) {
                menuItems.push({
                    label: 'Session links',
                    icon: 'link',
                    isSubmenu: true,
                    submenuItems: visibleLinks.map(link => ({
                        label: link.name || link.url,
                        icon: 'external-link',
                        action: () => {
                            window.open(link.url, '_blank', 'noopener,noreferrer');
                            this.hide();
                        }
                    }))
                });
            }
        }

        // Delete option only for inactive sessions and for owners
        if (!sessionData.is_active && isOwner) {
            menuItems.push({
                label: 'Delete',
                icon: 'trash-2',
                action: () => {
                    manager.deleteSessionHistory(sessionData.session_id);
                    this.hide();
                }
            });
        }

        return menuItems;
    }

    isContextMenuOpen() {
        return this.isOpen;
    }

    _isContainerSession(sessionData) {
        try {
            if (sessionData && sessionData.isolation_mode === 'container') return true;
            // Fallback: infer from template id via app templates if available
            const { app } = getContext();
            const tm = app?.modules?.terminal;
            const tid = sessionData?.template_id;
            if (tm?.formManager && Array.isArray(tm.formManager.availableTemplates) && tid) {
                const tmpl = tm.formManager.availableTemplates.find(t => t && t.id === tid);
                if (tmpl && tmpl.isolation === 'container') return true;
            }
        } catch (_) { /* ignore */ }
        return false;
    }

    _getContainerName(sessionData) {
        const explicit = sessionData?.container_name;
        if (explicit && explicit.trim()) return explicit;
        const sid = String(sessionData?.session_id || '').trim();
        return sid ? `sandbox-${sid}` : 'sandbox-unknown';
    }

    _formatIsolationLabel(mode) {
        const normalized = String(mode || 'none').toLowerCase();
        switch (normalized) {
            case 'container':
                return 'Container';
            case 'directory':
                return 'Directory (workspace on host)';
            case 'none':
            default:
                return 'None (host shell)';
        }
    }

    _buildForkMenuItem(sessionData) {
        if (!sessionData || !sessionData.session_id) return null;
        const currentIsolation = String(sessionData.isolation_mode || 'none').toLowerCase();

        // Determine allowed isolation modes from the template (default: all)
        let allowed = ['container','directory','none'];
        try {
            const { app } = getContext();
            const tm = app?.modules?.terminal;
            const tid = sessionData?.template_id;
            if (tm?.formManager && Array.isArray(tm.formManager.availableTemplates) && tid) {
                const tmpl = tm.formManager.availableTemplates.find(t => t && t.id === tid);
                if (tmpl && Array.isArray(tmpl.isolation_modes) && tmpl.isolation_modes.length) {
                    allowed = tmpl.isolation_modes.map(s => String(s).toLowerCase()).filter(s => ['container','directory','none'].includes(s));
                }
            }
        } catch (_) { /* ignore */ }

        const options = [
            {
                label: 'Container',
                icon: 'package',
                overrides: { isolation_mode: 'container' }
            },
            {
                label: 'Directory',
                icon: 'folder',
                overrides: { isolation_mode: 'directory' }
            },
            {
                label: 'None',
                icon: 'terminal',
                overrides: { isolation_mode: 'none' }
            }
        ].filter(opt => allowed.includes(opt.overrides.isolation_mode));

        const submenuItems = options.map((opt) => {
            let text = opt.label;
            if (opt.overrides && opt.overrides.isolation_mode === currentIsolation) {
                text = `${text} (current)`;
            }

            return {
                label: text,
                icon: opt.icon,
                action: async () => {
                    try {
                        if (opt.overrides) {
                            await this.sessionList.manager.forkSession(sessionData.session_id, opt.overrides);
                        } else {
                            await this.sessionList.manager.forkSession(sessionData.session_id);
                        }
                    } catch (_) { /* manager surfaces notifications */ }
                    this.hide();
                }
            };
        });

        return {
            label: 'Fork',
            icon: 'git',
            isSubmenu: true,
            submenuItems
        };
    }

    /**
     * Decide whether a link should be shown for a given session
     * Mirrors LinksController logic to avoid depending on manager methods
     */
    _shouldShowLink(link, sessionData) {
        const isActive = !!sessionData?.is_active;
        const showActive = link.show_active !== false;
        const showInactive = link.show_inactive !== false;
        if (isActive && !showActive) return false;
        if (!isActive && !showInactive) return false;
        return true;
    }

    /**
     * Determine if "Open workspace" menu item should be shown.
     * Requires:
     * - Running in Electron desktop app
     * - API host is localhost, 127.0.0.1, or a socket (unix/pipe)
     * - workspace_service_enabled_for_session is true on the session
     * - Session has a workspace path (container or directory isolation mode)
     * @returns {{ show: boolean, path?: string }}
     */
    _canOpenWorkspace(sessionData) {
        // Must be running in Electron
        if (!(window.desktop && window.desktop.isElectron && typeof window.desktop.openPath === 'function')) {
            return { show: false };
        }

        // Check API host is local (localhost, 127.0.0.1, or socket)
        try {
            const apiUrl = config.API_BASE_URL || '';
            if (!apiUrl) {
                return { show: false };
            }
            const parsed = new URL(apiUrl);
            const proto = String(parsed.protocol || '').toLowerCase();
            const host = String(parsed.hostname || '').toLowerCase();

            // Allow socket protocols (unix, pipe, socket)
            const isSocket = proto === 'socket:' || proto === 'unix:' || proto === 'pipe:';
            // Allow localhost variants
            const isLocalHost = host === 'localhost' || host === '127.0.0.1';

            if (!isSocket && !isLocalHost) {
                return { show: false };
            }
        } catch (_) {
            return { show: false };
        }

        // Check workspace service is enabled for this session (same logic as workspace tab)
        const enabled = sessionData?.workspace_service_enabled_for_session === true;
        const availableFlag = Object.prototype.hasOwnProperty.call(sessionData || {}, 'workspace_service_available')
            ? (sessionData.workspace_service_available === true)
            : true;
        if (!enabled || !availableFlag) {
            return { show: false };
        }

        // Get workspace path from session data
        let workspacePath = '';
        try {
            const mode = String(sessionData?.isolation_mode || '').toLowerCase();
            if (mode === 'container' || mode === 'directory') {
                const hostPath = typeof sessionData.workspace_host_path === 'string'
                    ? sessionData.workspace_host_path.trim()
                    : '';
                if (hostPath) {
                    workspacePath = hostPath;
                } else if (mode === 'directory' && typeof sessionData.working_directory === 'string') {
                    const dir = sessionData.working_directory.trim();
                    if (dir) workspacePath = dir;
                }
            }
        } catch (_) { /* non-fatal */ }

        if (!workspacePath) {
            return { show: false };
        }

        return { show: true, path: workspacePath };
    }

    getAvailableWorkspaces() {
        const workspaceSet = new Set(['Default']); // Always include Default
        
        // Multiple strategies to get workspaces
        
        // Strategy 1: Get from app store if available
        try {
            const state = appStore.getState();
            if (state.workspaces && state.workspaces.items) {
                const items = state.workspaces.items;
                if (items instanceof Set) {
                    items.forEach(ws => workspaceSet.add(ws));
                } else if (Array.isArray(items)) {
                    items.forEach(ws => workspaceSet.add(ws));
                }
            }
        } catch (e) {
            console.warn('[SessionContextMenu] Could not access app store:', e);
        }
        
        // Strategy 2: Get from sessionList manager store
        try {
            if (this.sessionList && this.sessionList.manager && this.sessionList.manager.store) {
                const state = this.sessionList.manager.store.getState();
                
                // Add workspaces from the workspace list
                if (state.workspaces && state.workspaces.items) {
                    const items = state.workspaces.items;
                    if (items instanceof Set) {
                        items.forEach(ws => workspaceSet.add(ws));
                    } else if (Array.isArray(items)) {
                        items.forEach(ws => workspaceSet.add(ws));
                    }
                }
                
                // Also add workspaces from existing sessions in the store
                if (state.sessionList && state.sessionList.sessions) {
                    const sessions = state.sessionList.sessions;
                    if (sessions instanceof Map) {
                        sessions.forEach(session => {
                            if (session.workspace) {
                                workspaceSet.add(session.workspace);
                            }
                        });
                    }
                }
            }
        } catch (e) {
            console.warn('[SessionContextMenu] Could not access sessionList manager store:', e);
        }
        
        // Strategy 3: Get from manager's sessions directly
        try {
            if (this.sessionList && this.sessionList.getAllSessions) {
                const sessions = this.sessionList.getAllSessions();
                if (sessions instanceof Map) {
                    sessions.forEach(session => {
                        if (session.workspace) {
                            workspaceSet.add(session.workspace);
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('[SessionContextMenu] Could not access sessionList directly:', e);
        }
        
        // Debug logging can be enabled for troubleshooting
        // console.log('[SessionContextMenu] Available workspaces:', Array.from(workspaceSet));
        
        return Array.from(workspaceSet).sort((a, b) => a.localeCompare(b));
    }

    ensureStopModal() {
        if (this.stopConfirmModal) return this.stopConfirmModal;
        const el = document.getElementById('confirm-stop-container-modal');
        if (!el) return null;
        this.stopConfirmModal = new ConfirmationModal({
            element: el,
            title: 'Stop Container',
            message: 'Are you sure you want to stop this container?',
            confirmText: 'Stop',
            cancelText: 'Cancel',
            destructive: true
        });
        return this.stopConfirmModal;
    }
}
