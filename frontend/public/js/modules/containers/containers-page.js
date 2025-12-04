/**
 * Containers Page - Refactored with ResizableTable
 * Lists running containers and allows connecting via exec into bash
 */

import { apiService } from '../../services/api.service.js';
import { ConfirmationModal } from '../ui/modal.js';
import { getContext } from '../../core/context.js';
import { ResizableTable } from '../../utils/resizable-table.js';
import { iconUtils } from '../../utils/icon-utils.js';

// Parse common container "Status" strings (e.g., "Up 55 minutes", "Up 8 hours",
// "Up about an hour") into total seconds for consistent sorting.
function parseStatusToSeconds(status) {
    if (!status) return -1;
    const s = String(status).toLowerCase();

    // Only rank "up/running" statuses; others sink to bottom
    const isUp = /\b(up|running)\b/.test(s);
    if (!isUp) return -1;

    let total = 0;

    // Handle "about an hour", "about a minute", etc.
    if (/about an? hour/.test(s)) total += 3600;
    if (/about an? minute/.test(s)) total += 60;
    if (/about an? day/.test(s)) total += 86400;

    // Handle "an hour", "a minute", "a day" without numbers
    if (/\ban hour\b/.test(s)) total += 3600;
    if (/\ba minute\b/.test(s)) total += 60;
    if (/\ba day\b/.test(s)) total += 86400;

    // "less than a second" -> effectively 0
    if (/less than a second/.test(s)) total += 0;

    // Sum any explicit numeric units we can find
    const patterns = [
        { re: /(\d+)\s*(d|day|days)\b/, mul: 86400 },
        { re: /(\d+)\s*(h|hr|hrs|hour|hours|horus)\b/, mul: 3600 }, // tolerate minor typos like "horus"
        { re: /(\d+)\s*(m|min|mins|minute|minutes)\b/, mul: 60 },
        { re: /(\d+)\s*(s|sec|secs|second|seconds)\b/, mul: 1 },
    ];
    for (const { re, mul } of patterns) {
        const matches = s.match(new RegExp(re, 'g')) || [];
        for (const m of matches) {
            const num = Number((m.match(/\d+/) || [0])[0]);
            if (!Number.isNaN(num)) total += num * mul;
        }
    }

    // If we detected it's "Up" but found no time tokens, treat as just started
    if (total === 0) return 0;
    return total;
}

const CONTAINER_COLUMNS = [
    { id: 'session', label: 'Session' },
    { id: 'name', label: 'Name' },
    { id: 'id', label: 'Container ID' },
    { id: 'image', label: 'Image' },
    { id: 'status', label: 'Status', getSortValue: (row) => parseStatusToSeconds(row?.status) },
    { id: 'actions', label: 'Actions', locked: true }
];

export class ContainersPage {
    constructor() {
        this.hasLoaded = false;
        this.isLoading = false;
        this.containers = [];
        this._allContainers = [];
        this.sessionInfoMap = new Map();
        this.filterHasSession = true;

        this.container = null;
        this.resizableTable = null;
        this.stopConfirmModal = null;
        this.terminateAllConfirmModal = null;

        this.init();
    }

    init() {
        this.createContainer();
        this.setupEventListeners();
    }

    onPageActive() {
        this.loadContainers();
    }

    createContainer() {
        this.container = document.createElement('div');
        this.container.id = 'containers-page';
        this.container.className = 'page';

        this.container.innerHTML = `
            <div class="history-page-content">
                <div class="history-header">
                    <h1 class="history-title">Containers</h1>
                    <div class="history-controls">
                        <label class="filter-checkbox">
                            <input type="checkbox" id="containers-filter-session" checked />
                            <span>Show only with sessions</span>
                        </label>
                        <button id="containers-terminate-all-btn" class="btn btn-danger" title="Terminate all containers and remove volumes">
                            Terminate All
                        </button>
                        <button id="containers-refresh-btn" class="btn btn-secondary history-refresh-btn">
                            <span class="refresh-icon"></span> Refresh
                        </button>
                    </div>
                </div>

                <div id="containers-table-wrapper">
                    <!-- ResizableTable will be rendered here -->
                </div>

                <div class="history-empty" id="containers-empty" style="display: none;">
                    <div class="empty-icon"></div>
                    <h3>No containers found</h3>
                    <p>No running containers were detected.</p>
                </div>
            </div>
        `;

        const appContent = document.querySelector('.app-content');
        if (appContent) {
            appContent.appendChild(this.container);
        }

        this.setupResizableTable();
    }

    setupResizableTable() {
        const tableWrapper = this.container.querySelector('#containers-table-wrapper');
        if (!tableWrapper) return;

        this.resizableTable = new ResizableTable({
            container: tableWrapper,
            columns: CONTAINER_COLUMNS,
            data: [],
            storageKey: 'containers-table',
            defaultSort: 'status',
            defaultSortDirection: 'desc',
            sortable: true,
            selectable: false,
            renderCell: (value, column, row) => this.renderContainerCell(value, column, row)
        });

        // Add column visibility control
        const controls = this.container.querySelector('.history-controls');
        const refreshBtn = controls.querySelector('#containers-refresh-btn');
        if (controls && refreshBtn) {
            const columnControl = this.resizableTable.getColumnVisibilityControl();
            controls.insertBefore(columnControl, refreshBtn);
        }
    }

    renderContainerCell(value, column, row) {
        switch(column.id) {
            case 'session': {
                const sessId = this.extractSessionId(row);
                if (!sessId) return '-';

                const info = this.sessionInfoMap.get(String(sessId));
                const title = info?.title || '';
                const templateName = info?.template_name || '';
                const displayTitle = title || sessId;

                let badgeHtml = '';
                try {
                    const { app } = getContext();
                    const tm = app?.modules?.terminal;
                    if (tm) {
                        if (templateName) {
                            badgeHtml = tm.createTemplateBadgeHtml(templateName);
                        } else {
                            badgeHtml = tm.createCommandBadgeHtml();
                        }
                    }
                } catch (_) {}

                const connectedIds = Array.isArray(info?.connected_client_ids) ? info.connected_client_ids : [];
                const { app } = getContext();
                const currentClientId = app?.clientId;
                const otherClients = connectedIds.filter(id => id && id !== currentClientId);
                const hasOtherClients = otherClients.length > 0;

                let connectedIcon = '';
                if (hasOtherClients) {
                    const icon = iconUtils.createIcon('display', {
                        size: 14,
                        className: 'client-display-indicator',
                        title: `${otherClients.length} other client${otherClients.length === 1 ? '' : 's'} connected`
                    });
                    connectedIcon = `<span class="session-connected-icon">${icon.outerHTML}</span>`;
                }

                return `
                    <div class="terminal-title" title="${this.escapeHtml(displayTitle)}">
                        ${badgeHtml}
                        <span class="workspace-session-title">${this.escapeHtml(displayTitle)}</span>
                        ${connectedIcon}
                    </div>
                `;
            }

            case 'name':
                return this.escapeHtml(row.name || '');

            case 'id':
                const shortId = (row.id || '').substring(0, 12);
                return `<code>${this.escapeHtml(shortId)}</code>`;

            case 'image':
                return this.escapeHtml(row.image || '');

            case 'status':
                return this.escapeHtml(row.status || '');

            case 'actions':
                {
                    let canLogin = false;
                    try {
                        const { appStore } = getContext();
                        canLogin = appStore?.getState?.()?.auth?.permissions?.sandbox_login === true;
                    } catch (_) { canLogin = false; }
                    const ref = this.escapeHtml(row.id || row.name || '');
                    const stopBtn = `
                        <button class="btn btn-secondary btn-sm stop-btn"
                                onclick="window.containersPage?.stopContainer('${ref}')">
                            Stop
                        </button>`;
                    const loginBtn = canLogin ? `
                        <button class="btn btn-primary btn-sm connect-btn"
                                onclick="window.containersPage?.connectToContainer('${ref}')">
                            Login
                        </button>` : '';
                    return `${stopBtn}${loginBtn}`;
                }

            default:
                return value || '';
        }
    }

    setupEventListeners() {
        const refreshBtn = this.container.querySelector('#containers-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.loadContainers());
        }

        const terminateAllBtn = this.container.querySelector('#containers-terminate-all-btn');
        if (terminateAllBtn) {
            terminateAllBtn.addEventListener('click', () => this.terminateAllContainers());
        }

        const filterCheckbox = this.container.querySelector('#containers-filter-session');
        if (filterCheckbox) {
            filterCheckbox.addEventListener('change', (e) => {
                this.filterHasSession = e.target.checked;
                this.applyFilters();
                this.updateTable();
            });
        }

        // Expose instance for button onclick handlers
        window.containersPage = this;
    }

    async loadContainers() {
        if (this.isLoading) return;
        this.isLoading = true;

        try {
            const data = await apiService.getContainers();
            const list = (data && Array.isArray(data.containers)) ? data.containers : [];
            this._allContainers = list;

            // Build session info map
            try {
                const sessions = await apiService.getSessions();
                if (Array.isArray(sessions)) {
                    this.sessionInfoMap = new Map();
                    sessions.forEach(s => {
                        if (s && s.session_id) {
                            this.sessionInfoMap.set(String(s.session_id), {
                                title: s.title || '',
                                template_name: s.template_name || '',
                                connected_client_ids: Array.isArray(s.connected_client_ids) ? s.connected_client_ids : [],
                                is_active: s.is_active !== false
                            });
                        }
                    });
                }
            } catch (_) {
                this.sessionInfoMap = new Map();
            }

            // Ensure terminal templates are loaded for badge colors
            try {
                const { app } = getContext();
                const tm = app?.modules?.terminal;
                if (tm?.formManager && Array.isArray(tm.formManager.availableTemplates) && tm.formManager.availableTemplates.length === 0) {
                    await tm.formManager.loadTemplates();
                }
            } catch (_) {}

            this.hasLoaded = true;
            this.applyFilters();
            this.updateTable();
            this.updateTerminateAllButtonState();
        } catch (e) {
            console.error('[ContainersPage] Failed to load containers:', e);
            this.showError('Failed to load containers.');
        } finally {
            this.isLoading = false;
        }
    }

    applyFilters() {
        const source = Array.isArray(this._allContainers) ? this._allContainers : [];
        let filtered = source;

        if (this.filterHasSession) {
            filtered = source.filter(c => {
                const sid = this.extractSessionId(c);
                return !!sid;
            });
        }

        this.containers = filtered;
    }

    extractSessionId(c) {
        return c?.session_id || (c?.raw && c.raw.Labels && (c.raw.Labels.session_id || c.raw.Labels.SESSION_ID)) || '';
    }

    updateTable() {
        const emptyState = this.container.querySelector('#containers-empty');
        const tableWrapper = this.container.querySelector('#containers-table-wrapper');

        if (!this.resizableTable || !tableWrapper || !emptyState) {
            console.error('[ContainersPage] Missing required elements');
            return;
        }

        if (this.containers.length === 0) {
            tableWrapper.style.display = 'none';
            emptyState.style.display = 'flex';
        } else {
            tableWrapper.style.display = 'block';
            emptyState.style.display = 'none';
            this.resizableTable.setData(this.containers);
        }
    }

    updateTerminateAllButtonState() {
        const btn = this.container.querySelector('#containers-terminate-all-btn');
        if (!btn) return;
        // Permission gating: terminate_containers
        let allowed = false;
        try {
            const { appStore } = getContext();
            allowed = appStore?.getState?.()?.auth?.permissions?.terminate_containers === true;
        } catch (_) { allowed = false; }

        const hasAny = Array.isArray(this._allContainers) && this._allContainers.length > 0;
        btn.disabled = !allowed || !hasAny;
        btn.title = !allowed
            ? 'You do not have permission to terminate containers'
            : (!hasAny ? 'No containers found to terminate' : 'Terminate all containers and remove volumes');
    }

    async connectToContainer(ref) {
        if (!ref) return;

        try {
            // Permission gating: sandbox_login
            let allowed = false;
            try {
                const { appStore } = getContext();
                allowed = appStore?.getState?.()?.auth?.permissions?.sandbox_login === true;
            } catch (_) { allowed = false; }
            if (!allowed) {
                this.showError('Access denied. Container login is disabled.');
                return;
            }

            const { app } = getContext();
            const clientId = app?.clientId || null;
            const terminalManager = app?.modules?.terminal;
            const parentSessionId = terminalManager?.currentSessionId || null;
            const created = await apiService.attachContainer(ref, {
                clientId,
                parentSessionId
            });

            if (created && terminalManager?.ensureContainerSessionReady) {
                await terminalManager.ensureContainerSessionReady(created, { activate: true });
            }

            if (app && typeof app.showPage === 'function') {
                app.showPage('terminal');
            }
        } catch (e) {
            console.error('[ContainersPage] Failed to connect:', e);
            this.showError(e?.message || 'Failed to connect to container.');
        }
    }

    async stopContainer(ref) {
        if (!ref) return;

        const modal = this.ensureStopModal();
        if (!modal) {
            if (window.confirm(`Stop container "${ref}"?`)) {
                await this._doStopContainer(ref);
            }
            return;
        }

        modal.setMessage(`Stop container "${this.escapeHtml(ref)}"?`);
        modal.confirmCallback = async () => {
            try {
                modal.setLoadingState(true, 'Stopping...');
                await apiService.stopContainer(ref);
                modal.hide();
                await this.loadContainers();
            } catch (err) {
                console.error('[ContainersPage] Failed to stop container:', err);
                modal.setLoadingState(false);
                modal.setMessage(err?.message || 'Failed to stop container.');
            }
        };
        modal.show();
    }

    async _doStopContainer(ref) {
        try {
            await apiService.stopContainer(ref);
            await this.loadContainers();
        } catch (err) {
            console.error('[ContainersPage] Failed to stop container:', err);
            this.showError(err?.message || 'Failed to stop container.');
        }
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

    ensureTerminateAllModal() {
        if (this.terminateAllConfirmModal) return this.terminateAllConfirmModal;
        const el = document.getElementById('confirm-terminate-all-containers-modal');
        if (!el) return null;
        this.terminateAllConfirmModal = new ConfirmationModal({
            element: el,
            title: 'Terminate All Containers',
            message: 'Are you sure you want to terminate all containers and remove all volumes? This action cannot be undone.',
            confirmText: 'Terminate All',
            cancelText: 'Cancel',
            destructive: true
        });
        return this.terminateAllConfirmModal;
    }

    async terminateAllContainers() {
        // Permission gating client-side (server enforces as well)
        let allowed = false;
        try {
            const { appStore } = getContext();
            allowed = appStore?.getState?.()?.auth?.permissions?.terminate_containers === true;
        } catch (_) { allowed = false; }
        if (!allowed) return;

        const modal = this.ensureTerminateAllModal();
        if (!modal) {
            if (window.confirm('Terminate all containers and remove all volumes?')) {
                await this._doTerminateAllContainers();
            }
            return;
        }
        modal.setMessage('Are you sure you want to terminate all containers and remove all volumes? This action cannot be undone.');
        modal.confirmCallback = async () => {
            try {
                modal.setLoadingState(true, 'Terminating...');
                await apiService.terminateAllContainers();
                modal.hide();
                await this.loadContainers();
            } catch (err) {
                console.error('[ContainersPage] Failed to terminate all containers:', err);
                modal.setLoadingState(false);
                modal.setMessage(err?.message || 'Failed to terminate containers.');
            }
        };
        modal.show();
    }

    async _doTerminateAllContainers() {
        try {
            await apiService.terminateAllContainers();
            await this.loadContainers();
        } catch (err) {
            console.error('[ContainersPage] Failed to terminate all containers:', err);
            this.showError(err?.message || 'Failed to terminate containers.');
        }
    }

    showError(message) {
        const empty = this.container.querySelector('#containers-empty');
        const table = this.container.querySelector('#containers-table-wrapper');
        if (empty) {
            empty.style.display = 'flex';
            empty.querySelector('h3').textContent = 'Error';
            empty.querySelector('p').textContent = message || 'An error occurred.';
        }
        if (table) table.style.display = 'none';
    }

    escapeHtml(text) {
        if (text == null) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
