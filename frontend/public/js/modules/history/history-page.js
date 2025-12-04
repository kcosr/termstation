/**
 * History Search and Navigation Page
 * Provides a sortable, filterable table view of terminated sessions and their history
 */

import { apiService } from '../../services/api.service.js';
import { parseColor, getContrastColor } from '../../utils/color-utils.js';
import { delegate } from '../../utils/delegate.js';
import { getContext } from '../../core/context.js';
import { ResizableTable } from '../../utils/resizable-table.js';
import { iconUtils } from '../../utils/icon-utils.js';

const HISTORY_COLUMNS = [
    // Default visible (in order): Template, Title, Ended, Status, Actions
    { id: 'template_name', label: 'Template' },
    { id: 'title', label: 'Title' },
    { id: 'ended_at', label: 'Ended' },
    { id: 'exit_code', label: 'Status' },
    { id: 'actions', label: 'Actions', locked: true },
    // Hidden by default but available via column picker
    { id: 'session_id', label: 'Session ID', mobileHiddenByDefault: true },
    { id: 'command', label: 'Command', mobileHiddenByDefault: true },
    { id: 'working_directory', label: 'Directory', mobileHiddenByDefault: true },
    { id: 'created_at', label: 'Created', mobileHiddenByDefault: true }
];

export class HistoryPage {
    constructor() {
        this.currentPage = 1;
        this.pageSize = 50;
        this.totalPages = 1;
        this.totalSessions = 0;
        this.sessions = [];
        this.searchQuery = '';
        this.templateFilter = 'all';
        this.dateFilter = 'all'; // all, today, week, month
        this.availableTemplates = [];
        this.templateColors = new Map();
        this.isLoading = false;
        this.searchTimeout = null;
        this.hasLoaded = false; // Lazy-load flag
        this.searchContent = false; // Whether to include large history content in search
        // Legacy modal state removed; history opens in main Terminal view

        this.container = null;
        this.tableContainer = null;
        this.searchInput = null;
        this.templateSelect = null;
        this.dateSelect = null;
        this.resizableTable = null;

        this.init();
    }
    
    init() {
        this.createContainer();
        this.setupEventListeners();
        // Do not fetch data on app startup; wait until page is shown
    }

    setupColumnVisibilityControls() {
        // Column visibility now handled by ResizableTable component
    }

    setupResizableTable() {
        const tableWrapper = this.container.querySelector('#history-table-wrapper');
        if (!tableWrapper) return;

        const columns = HISTORY_COLUMNS.map(col => ({
            id: col.id,
            label: col.label,
            field: col.id,
            sortable: col.id !== 'actions',
            locked: col.locked || false,
            defaultVisible: !col.mobileHiddenByDefault
        }));

        this.resizableTable = new ResizableTable({
            container: tableWrapper,
            columns: columns,
            data: [],
            // Bump storage key to avoid stale/empty saved column sets causing blank tables
            storageKey: 'history-table-v2',
            // Sort by end time descending by default for history views
            defaultSort: 'ended_at',
            defaultSortDirection: 'desc',
            sortable: true,
            selectable: true,
            renderCell: (value, column, row) => this.renderHistoryCell(value, column, row),
            onRowClick: (row, event) => {
                if (event.target.closest('.view-history-btn') || event.target.closest('.fork-session-btn')) return;
                this.openInTerminalView(row.session_id);
            }
        });

        // Add column visibility control to the controls
        const controls = this.container.querySelector('.history-controls');
        const refreshBtn = controls.querySelector('#history-refresh-btn');
        if (controls && refreshBtn) {
            const columnControl = this.resizableTable.getColumnVisibilityControl();
            controls.insertBefore(columnControl, refreshBtn);
        }
    }

    renderHistoryCell(value, column, row) {
        switch(column.id) {
            case 'session_id':
                const shortId = row.session_id.substring(0, 8);
                return `<code title="${row.session_id}">${shortId}</code>`;

            case 'title': {
                const displayTitle = row.title || row.dynamic_title || '';
                const safeTitle = displayTitle || 'No title';
                return `<span title="${safeTitle}">${displayTitle || '-'}</span>`;
            }

            case 'command':
                return `<span title="${row.command}">${this.truncateText(row.command || '-', 40)}</span>`;

            case 'template_name':
                return row.template_name
                    ? this.createTemplateBadgeHtml(row.template_name)
                    : '<span class="template-badge">Command</span>';

            case 'working_directory':
                return `<span title="${row.working_directory}">${this.truncateText(this.formatPath(row.working_directory), 30)}</span>`;

            case 'created_at':
                return this.formatDateTime(row.created_at);

            case 'ended_at':
                return row.ended_at ? this.formatDateTime(row.ended_at) : '-';

            case 'exit_code': {
                // Render as human-friendly status
                if (row.exit_code == null || isNaN(Number(row.exit_code))) return '-';
                const code = Number(row.exit_code);
                const ok = code === 0;
                const text = ok ? 'Success' : `Error (${code})`;
                const exitCodeClass = ok ? 'exit-success' : 'exit-error';
                return `<span class="exit-code ${exitCodeClass}">${text}</span>`;
            }

            case 'actions':
                return `
                    <div class="history-actions">
                        <button class="btn btn-sm btn-secondary view-history-btn"
                                data-session-id="${row.session_id}"
                                title="View session history">
                            View History
                        </button>
                        <button class="btn btn-sm btn-primary fork-session-btn"
                                data-session-id="${row.session_id}"
                                title="Fork this session">
                            Fork
                        </button>
                    </div>`;

            default:
                return value || '-';
        }
    }

    /**
     * Called by the app router when the History page becomes active.
     * Lazily loads data the first time the user navigates here.
     */
    onPageActive() {
        // Always refresh when navigating to History
        // Previously only loaded once; users had to click Refresh
        this.loadHistoryData();
    }
    
    createContainer() {
        // Create main history page container
        this.container = document.createElement('div');
        this.container.id = 'history-page';
        this.container.className = 'page';
        
        this.container.innerHTML = `
            <div class="history-page-content">
                <div class="history-header">
                    <h1 class="history-title">Session History</h1>
                    <div class="history-controls">
                    <div class="history-search-container">
                            <input type="text" id="history-search" class="history-search-input" 
                                   placeholder="Search sessions (metadata only by default)" />
                            <div class="history-search-clear" id="history-search-clear" style="display: none;">×</div>
                        </div>
                        <label class="history-search-content-toggle" title="Include terminal output in search (slower)">
                            <input type="checkbox" id="history-search-content" /> Search content
                        </label>
                        <div class="history-filters">
                            <select id="history-template-filter" class="history-filter-select">
                                <option value="all">All Templates</option>
                            </select>
                            <select id="history-date-filter" class="history-filter-select">
                                <option value="all">All Time</option>
                                <option value="today">Today</option>
                                <option value="week">This Week</option>
                                <option value="month">This Month</option>
                            </select>
                        </div>
                        <button id="history-refresh-btn" class="btn btn-secondary history-refresh-btn">
                            <span class="refresh-icon" id="refresh-icon"></span> Refresh
                        </button>
                    </div>
                </div>
                
                <div class="history-stats" id="history-stats">
                    <span class="stat">Total: <strong id="total-sessions">0</strong></span>
                    <span class="stat">Showing: <strong id="showing-sessions">0</strong></span>
                    <span class="stat">Page: <strong id="current-page">1</strong> of <strong id="total-pages">1</strong></span>
                </div>
                
                <div class="history-pagination" id="history-pagination" style="display: none;">
                    <button id="first-page-btn" class="pagination-btn" title="First Page">
                        <span id="first-page-icon"></span>
                    </button>
                    <button id="prev-page-btn" class="pagination-btn" title="Previous Page">
                        <span id="prev-page-icon"></span>
                    </button>
                    <span class="pagination-info">
                        <input type="number" id="page-input" class="page-input" min="1" value="1" />
                        of <span id="pagination-total-pages">1</span>
                    </span>
                    <button id="next-page-btn" class="pagination-btn" title="Next Page">
                        <span id="next-page-icon"></span>
                    </button>
                    <button id="last-page-btn" class="pagination-btn" title="Last Page">
                        <span id="last-page-icon"></span>
                    </button>
                    
                    <select id="page-size-select" class="page-size-select">
                        <option value="25">25 per page</option>
                        <option value="50" selected>50 per page</option>
                        <option value="100">100 per page</option>
                        <option value="200">200 per page</option>
                    </select>
                </div>
                
                <div class="history-table-container" id="history-table-container">
                    <div class="loading-spinner" id="history-loading" style="display: none;">
                        <div class="spinner"></div>
                        <span>Loading history...</span>
                    </div>

                    <div id="history-table-wrapper">
                        <!-- ResizableTable will be rendered here -->
                    </div>
                    
                    <div class="history-empty" id="history-empty" style="display: none;">
                        <div class="empty-icon" id="empty-icon"></div>
                        <h3>No History Found</h3>
                        <p>No terminated sessions match your current filters.</p>
                    </div>
                </div>
            </div>
        `;
        
        // Insert into main content area
        const appContent = document.querySelector('.app-content');
        if (appContent) {
            appContent.appendChild(this.container);
        }
        
        // Cache element references
        this.tableContainer = this.container.querySelector('#history-table-container');
        this.searchInput = this.container.querySelector('#history-search');
        this.templateSelect = this.container.querySelector('#history-template-filter');
        this.dateSelect = this.container.querySelector('#history-date-filter');
        this.searchContentCheckbox = this.container.querySelector('#history-search-content');

        // Initialize search content preference from localStorage (default false)
        try {
            const stored = localStorage.getItem('history_search_content');
            this.searchContent = stored === '1';
            if (this.searchContentCheckbox) this.searchContentCheckbox.checked = this.searchContent;
        } catch (_) { this.searchContent = false; }

        // Setup ResizableTable
        this.setupResizableTable();
        this.setupColumnVisibilityControls();
        
        // Initialize pagination icons (they're created dynamically, so we need to initialize them here)
        this.initializePaginationIcons();
    }
    
    initializePaginationIcons() {
        // Initialize pagination icons that weren't created when app.js ran initializeIcons()
        const icons = [
            { id: 'refresh-icon', name: 'arrow-refresh', size: 16 },
            { id: 'empty-icon', name: 'folder2', size: 48 },
            { id: 'first-page-icon', name: 'chevron-double-left', size: 14 },
            { id: 'prev-page-icon', name: 'chevron-left', size: 14 },
            { id: 'next-page-icon', name: 'chevron-right', size: 14 },
            { id: 'last-page-icon', name: 'chevron-double-right', size: 14 }
        ];
        
        icons.forEach(({ id, name, size }) => {
            const el = this.container.querySelector(`#${id}`);
            if (el) {
                // Skip if an icon already exists
                const hasIcon = !!(el.querySelector('svg') || el.querySelector('.bi-icon'));
                if (!hasIcon) {
                    el.appendChild(iconUtils.createIcon(name, { size }));
                }
            }
        });
    }
    
    setupEventListeners() {
        // Search input with debounce
        this.searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value;
            this.updateSearchClear();
            
            // Debounce search to avoid too many API calls
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.currentPage = 1; // Reset to first page
                this.loadHistoryData();
            }, 500);
        });
        
        // Search clear button
        const searchClear = this.container.querySelector('#history-search-clear');
        searchClear.addEventListener('click', () => {
            this.searchInput.value = '';
            this.searchQuery = '';
            this.updateSearchClear();
            this.currentPage = 1;
            this.loadHistoryData();
        });
        
        // Template filter
        this.templateSelect.addEventListener('change', (e) => {
            this.templateFilter = e.target.value;
            this.currentPage = 1;
            this.loadHistoryData();
        });
        
        // Date filter
        this.dateSelect.addEventListener('change', (e) => {
            this.dateFilter = e.target.value;
            this.currentPage = 1;
            this.loadHistoryData();
        });

        // Toggle: include content in search
        this.searchContentCheckbox.addEventListener('change', (e) => {
            this.searchContent = !!e.target.checked;
            // Persist preference
            try { localStorage.setItem('history_search_content', this.searchContent ? '1' : '0'); } catch (_) {}
            // If we have a query, re-run search immediately; otherwise do nothing
            if ((this.searchQuery || '').trim()) {
                this.currentPage = 1;
                this.loadHistoryData();
            }
        });
        
        
        // Refresh button
        const refreshBtn = this.container.querySelector('#history-refresh-btn');
        refreshBtn.addEventListener('click', () => {
            this.loadHistoryData();
        });

        // No clear-ended button in History header; top toolbar provides this action

        // Table actions (delegated clicks on action buttons)
        const tableWrapper = this.container.querySelector('#history-table-wrapper');
        tableWrapper.addEventListener('click', async (e) => {
            const viewBtn = e.target.closest('.view-history-btn');
            const forkBtn = e.target.closest('.fork-session-btn');
            if (!viewBtn && !forkBtn) return;
            e.stopPropagation();
            const sid = (viewBtn || forkBtn)?.getAttribute('data-session-id');
            if (!sid) return;

            if (viewBtn) {
                this.openInTerminalView(sid);
                return;
            }
            if (forkBtn) {
                try {
                    const tm = getContext()?.app?.modules?.terminal;
                    if (tm && typeof tm.forkSession === 'function') {
                        await tm.forkSession(sid);
                    } else {
                        // Fallback: call API directly
                        await apiService.forkSession(sid);
                    }
                } catch (_) { /* notifications handled by terminal manager */ }
                return;
            }
        });
        
        // Pagination controls
        const firstPageBtn = this.container.querySelector('#first-page-btn');
        const prevPageBtn = this.container.querySelector('#prev-page-btn');
        const nextPageBtn = this.container.querySelector('#next-page-btn');
        const lastPageBtn = this.container.querySelector('#last-page-btn');
        const pageInput = this.container.querySelector('#page-input');
        const pageSizeSelect = this.container.querySelector('#page-size-select');
        
        firstPageBtn.addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage = 1;
                this.loadHistoryData();
            }
        });
        
        prevPageBtn.addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.loadHistoryData();
            }
        });
        
        nextPageBtn.addEventListener('click', () => {
            if (this.currentPage < this.totalPages) {
                this.currentPage++;
                this.loadHistoryData();
            }
        });
        
        lastPageBtn.addEventListener('click', () => {
            if (this.currentPage < this.totalPages) {
                this.currentPage = this.totalPages;
                this.loadHistoryData();
            }
        });
        
        pageInput.addEventListener('change', (e) => {
            const newPage = parseInt(e.target.value);
            if (newPage >= 1 && newPage <= this.totalPages && newPage !== this.currentPage) {
                this.currentPage = newPage;
                this.loadHistoryData();
            }
        });
        
        pageSizeSelect.addEventListener('change', (e) => {
            this.pageSize = parseInt(e.target.value);
            this.currentPage = 1; // Reset to first page when changing page size
            this.loadHistoryData();
        });
    }
    
    updateSearchClear() {
        const searchClear = this.container.querySelector('#history-search-clear');
        if (this.searchQuery) {
            searchClear.style.display = 'block';
        } else {
            searchClear.style.display = 'none';
        }
    }
    
    async loadHistoryData() {
        if (this.isLoading) return;

        this.isLoading = true;
        this.showLoading(true);

        try {
            const query = (this.searchQuery || '').trim();
            if (query) {
                if (this.searchContent) {
                    await this.loadHistorySearchResults(query);
                } else {
                    // Metadata-only search uses efficient paginated endpoint
                    await this.loadHistoryPaginated();
                }
            } else {
                await this.loadHistoryPaginated();
            }
            this.hasLoaded = true;
        } catch (error) {
            console.error('Failed to load history data:', error);
            this.showError('Failed to load session history. Please try refreshing the page.');
        } finally {
            this.isLoading = false;
            this.showLoading(false);
        }
    }

    async loadHistoryPaginated() {
        const response = await apiService.getPaginatedSessionHistory({
            page: this.currentPage,
            limit: this.pageSize,
            search: this.searchQuery,
            template: this.templateFilter,
            sortBy: this.resizableTable?.sortColumn || 'created_at',
            sortOrder: this.resizableTable?.sortDirection || 'desc',
            dateFilter: this.dateFilter
        });

        this.sessions = Array.isArray(response.sessions) ? response.sessions : [];
        this.totalSessions = response.pagination?.total ?? this.sessions.length;
        this.totalPages = response.pagination?.totalPages ?? 1;
        this.availableTemplates = Array.isArray(response.filters?.availableTemplates)
            ? response.filters.availableTemplates
            : [];

        this.updateTemplateFilterOptions();
        this.updateStats();
        this.updatePagination();
        this.updateTable();
    }

    async loadHistorySearchResults(query) {
        let results = await apiService.searchSessions(query, 'inactive', { searchContent: true });
        if (!Array.isArray(results)) {
            results = [];
        }

        // Keep only terminated sessions the backend returns
        let filtered = results.filter(session => session && session.session_id);

        // Capture templates before filters so the dropdown reflects the result set
        this.availableTemplates = [...new Set(
            filtered
                .map(session => session.template_name)
                .filter(template => template && template.trim())
        )].sort();
        this.updateTemplateFilterOptions();

        if (this.templateFilter && this.templateFilter !== 'all') {
            filtered = filtered.filter(session => session.template_name === this.templateFilter);
        }

        filtered = this.applyDateFilter(filtered);
        const sorted = this.sortHistorySessions(filtered);

        const limit = Number.isFinite(this.pageSize) && this.pageSize > 0 ? this.pageSize : 50;
        this.sessions = sorted.slice(0, limit);
        this.totalSessions = sorted.length;
        this.totalPages = 1;
        this.currentPage = 1;

        this.updateStats();
        this.updatePagination();
        this.updateTable();
    }

    applyDateFilter(sessions = []) {
        if (!Array.isArray(sessions)) return [];
        if (!this.dateFilter || this.dateFilter === 'all') return [...sessions];

        const now = new Date();
        let filterDate = null;

        switch (this.dateFilter) {
            case 'today':
                filterDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                break;
            case 'week':
                filterDate = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
                break;
            case 'month':
                filterDate = new Date(now.getFullYear(), now.getMonth(), 1);
                break;
            default:
                break;
        }

        if (!filterDate) {
            return [...sessions];
        }

        return sessions.filter(session => {
            const created = Number(session?.created_at);
            if (!Number.isFinite(created)) return false;
            const createdDate = new Date(created * 1000);
            if (Number.isNaN(createdDate.getTime())) return false;
            return createdDate >= filterDate;
        });
    }

    sortHistorySessions(sessions = []) {
        // Sorting now handled by ResizableTable component
        // This method kept for backward compatibility
        return Array.isArray(sessions) ? [...sessions] : [];
    }
    
    updateTemplateFilterOptions() {
        // Clear existing options (except "All Templates")
        this.templateSelect.innerHTML = '<option value="all">All Templates</option>';
        
        // Add template options from backend response
        this.availableTemplates.forEach(templateName => {
            const option = document.createElement('option');
            option.value = templateName;
            option.textContent = templateName;
            if (templateName === this.templateFilter) {
                option.selected = true;
            }
            this.templateSelect.appendChild(option);
        });
    }
    
    updatePagination() {
        const pagination = this.container.querySelector('#history-pagination');
        const currentPageSpan = this.container.querySelector('#current-page');
        const totalPagesSpan = this.container.querySelector('#total-pages');
        const pageInput = this.container.querySelector('#page-input');
        const paginationTotalPages = this.container.querySelector('#pagination-total-pages');
        
        const firstPageBtn = this.container.querySelector('#first-page-btn');
        const prevPageBtn = this.container.querySelector('#prev-page-btn');
        const nextPageBtn = this.container.querySelector('#next-page-btn');
        const lastPageBtn = this.container.querySelector('#last-page-btn');
        
        // Update pagination display
        currentPageSpan.textContent = this.currentPage;
        totalPagesSpan.textContent = this.totalPages;
        pageInput.value = this.currentPage;
        pageInput.max = this.totalPages;
        paginationTotalPages.textContent = this.totalPages;
        
        // Enable/disable buttons
        firstPageBtn.disabled = this.currentPage <= 1;
        prevPageBtn.disabled = this.currentPage <= 1;
        nextPageBtn.disabled = this.currentPage >= this.totalPages;
        lastPageBtn.disabled = this.currentPage >= this.totalPages;
        
        // Show/hide pagination based on whether we have multiple pages
        if (this.totalPages > 1) {
            pagination.style.display = 'flex';
        } else {
            pagination.style.display = 'none';
        }
    }
    
    
    
    updateStats() {
        const totalElement = this.container.querySelector('#total-sessions');
        const showingElement = this.container.querySelector('#showing-sessions');
        
        totalElement.textContent = this.totalSessions;
        showingElement.textContent = this.sessions.length;
    }
    
    updateTable() {
        const emptyState = this.container.querySelector('#history-empty');
        const tableWrapper = this.container.querySelector('#history-table-wrapper');

        if (!this.resizableTable || !tableWrapper || !emptyState) {
            console.error('[HistoryPage] Missing required elements for table rendering');
            return;
        }

        if (this.sessions.length === 0) {
            tableWrapper.style.display = 'none';
            emptyState.style.display = 'block';
        } else {
            tableWrapper.style.display = 'block';
            emptyState.style.display = 'none';
            this.resizableTable.setData(this.sessions);
        }
    }
    
    /**
     * Legacy helper retained for compatibility.
     * All calls now redirect to the terminal-based history view.
     */
    async openSessionDetails(sessionId) {
        return this.openInTerminalView(sessionId);
    }

    /**
     * Add the selected history session to the sticky terminated list in Terminal UI
     * and select it like a normal terminated session.
     */
    async openInTerminalView(sessionId) {
        try {
            const appRef = getContext()?.app;
            const tm = appRef?.modules?.terminal;
            if (!tm || !tm.sessionList) {
                console.warn('[HistoryPage] Terminal module not ready');
                return;
            }

            // Find the row data we already have; fallback to API for completeness
            let rowData = Array.isArray(this.sessions)
                ? this.sessions.find(s => s && s.session_id === sessionId)
                : null;
            if (!rowData) {
                try { rowData = await apiService.getSession(sessionId); } catch (_) {}
            }
            const stickyData = {
                session_id: sessionId,
                title: rowData?.title,
                command: rowData?.command,
                template_name: rowData?.template_name,
                working_directory: rowData?.working_directory,
                created_at: rowData?.created_at,
                ended_at: rowData?.ended_at,
                exit_code: rowData?.exit_code,
                workspace: rowData?.workspace || 'Default',
                isolation_mode: rowData?.isolation_mode || 'none',
                workspace_host_path: rowData?.workspace_host_path || '',
                workspace_service_enabled_for_session: rowData?.workspace_service_enabled_for_session === true,
                workspace_service_available: rowData?.workspace_service_available === true,
                interactive: false,
                is_active: false,
                __stickyTerminated: true
            };

            // Add or update in sidebar store with sticky flag
            const existing = tm.sessionList.getSessionData(sessionId);
            if (existing) {
                tm.sessionList.updateSession(stickyData);
            } else {
                tm.sessionList.addSession(stickyData, true);
            }

            // Ensure workspaces reflect available sessions
            try { tm.updateWorkspacesFromSessions(); } catch (_) {}

            // Enter the session's workspace so sidebar/tabs reflect correct context
            try {
                const ws = stickyData.workspace || 'Default';
                if (!tm.currentWorkspace || tm.currentWorkspace !== ws) {
                    tm.enterWorkspace(ws);
                } else {
                    // Re-render to ensure tabs/visible order include sticky session
                    try { tm.sessionList.render(); } catch (_) {}
                    try { tm.updateSessionTabs?.(); } catch (_) {}
                }
            } catch (_) {}

            // Select the session; TerminalManager will attach history view via ensureHistorySession
            if (typeof tm.activateSession === 'function') {
                await tm.activateSession(sessionId, { manualClick: true });
            } else {
                await tm.selectSession(sessionId, { manualClick: true });
            }
        } catch (e) {
            console.error('[HistoryPage] Failed to open history session in Terminal view:', e);
        }
    }

    // Utility methods
    truncateText(text, maxLength) {
        if (!text) return '';
        return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
    }
    
    formatPath(path) {
        if (!path) return '';
        
        const homePath = '/home/';
        if (path.startsWith(homePath)) {
            const afterHome = path.substring(homePath.length);
            const parts = afterHome.split('/');
            if (parts.length > 0) {
                return `~/${parts.slice(1).join('/')}`;
            }
        }
        
        if (path.length > 30) {
            return '...' + path.substring(path.length - 27);
        }
        
        return path;
    }
    
    formatDateTime(timestamp) {
        if (!timestamp) return '';
        
        let date;
        
        // Handle different timestamp formats
        if (typeof timestamp === 'string') {
            // ISO 8601 string format (e.g., "2025-08-30T19:25:45.557Z")
            date = new Date(timestamp);
        } else if (typeof timestamp === 'number') {
            // Handle both seconds and milliseconds numeric timestamps
            if (timestamp > 1000000000000) {
                // Looks like milliseconds
                date = new Date(timestamp);
            } else {
                // Assume seconds
                date = new Date(timestamp * 1000);
            }
        } else {
            return 'Invalid Date';
        }
        
        // Check if the date is valid
        if (isNaN(date.getTime())) {
            return 'Invalid Date';
        }
        
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) {
            // Today - show time
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else if (diffDays === 1) {
            // Yesterday
            return 'Yesterday';
        } else if (diffDays < 7) {
            // This week - show day name
            return date.toLocaleDateString([], { weekday: 'long' });
        } else {
            // Older - show date
            return date.toLocaleDateString();
        }
    }
    
    /**
     * Create template badge HTML with color support
     */
    createTemplateBadgeHtml(templateName) {
        // Try to get template color from cache first
        let color = this.templateColors.get(templateName);
        
        // If not cached, try to get from available templates via app (AppContext first)
        if (!color) {
            const appRef = getContext()?.app;
            const available = appRef?.modules?.terminal?.formManager?.availableTemplates;
            if (available) {
                const template = available.find(t => t.name === templateName);
                if (template && template.color) {
                    color = template.color;
                    this.templateColors.set(templateName, color);
                }
            }
        }
        
        const badgeStyle = color ? this.getTemplateBadgeStyle(color) : '';
        
        return `<span class="template-badge"${badgeStyle}>${templateName}</span>`;
    }
    
    /**
     * Get template badge style with color
     */
    getTemplateBadgeStyle(color) {
        const parsedColor = parseColor(color);
        if (!parsedColor) {
            return '';
        }
        
        const textColor = getContrastColor(parsedColor);
        return ` style="background-color: ${parsedColor}; color: ${textColor}; border-color: ${parsedColor};"`;
    }
    
    showLoading(show) {
        const loadingElement = this.container.querySelector('#history-loading');
        const tableWrapper = this.container.querySelector('#history-table-wrapper');
        const emptyElement = this.container.querySelector('#history-empty');
        const statsElement = this.container.querySelector('#history-stats');
        const pagination = this.container.querySelector('#history-pagination');

        if (show) {
            if (loadingElement) loadingElement.style.display = 'flex';
            if (tableWrapper) tableWrapper.style.display = 'none';
            if (emptyElement) emptyElement.style.display = 'none';
            if (statsElement) statsElement.style.display = 'none';
            if (pagination) pagination.style.display = 'none';
        } else {
            if (loadingElement) loadingElement.style.display = 'none';
            if (statsElement) statsElement.style.display = '';
            // pagination and table visibility will be set by updateTable()
        }
    }
    
    showError(message) {
        // Simple error display - could be enhanced with a proper notification system
        console.error(message);
        alert(message);
    }
    
    // Remove eager reloads; lazy-load handled by the earlier onPageActive()
    // Keep show() purely for visibility toggling if ever used elsewhere
    show() {
        this.container.style.display = 'block';
        this.container.classList.add('active');
        document.querySelectorAll('.page').forEach(page => {
            if (page !== this.container) {
                page.classList.remove('active');
                page.style.display = 'none';
            }
        });
    }
    
    hide() {
        this.container.style.display = 'none';
        this.container.classList.remove('active');
    }
    
    destroy() {
        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
    }
}
