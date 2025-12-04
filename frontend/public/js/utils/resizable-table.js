/**
 * ResizableTable
 * A clean, unified table component with proper column resizing and spacing
 */

export class ResizableTable {
    constructor(options = {}) {
        this.container = options.container;
        this.columns = options.columns || [];
        this.data = options.data || [];
        this.storageKey = options.storageKey || 'resizable-table';
        this.onRowClick = options.onRowClick || null;
        this.renderCell = options.renderCell || ((value) => this.escapeHtml(value));
        this.sortable = options.sortable !== false;
        this.selectable = options.selectable !== false;

        // Column visibility settings
        this.visibleColumns = new Set();
        this.lockedColumns = new Set();

        // Sorting state
        this.sortColumn = options.defaultSort || null;
        this.sortDirection = options.defaultSortDirection || 'asc';

        // Resizing state
        this.columnWidths = new Map();
        this.columnMinWidths = new Map(); // Dynamic minimums based on header text
        this.absoluteMinWidth = 40; // Absolute minimum for any column
        this.resizeColumnId = null;
        this.resizeNextColumnId = null;
        this.resizeStartX = 0;
        this.resizeStartWidth = 0;
        this.resizeNextStartWidth = 0;

        // Table elements
        this.tableWrapper = null;
        this.table = null;
        this.thead = null;
        this.tbody = null;
        this.colgroup = null;

        this.init();
    }

    init() {
        if (!this.container) return;

        // Load saved state
        this.loadState();

        // Create table structure
        this.createTable();

        // Set up event listeners
        this.setupEventListeners();

        // Initial render
        this.render();
    }

    createTable() {
        // Clear container
        this.container.innerHTML = '';

        // Create wrapper for scrolling
        this.tableWrapper = document.createElement('div');
        this.tableWrapper.className = 'resizable-table-wrapper';

        // Create table
        this.table = document.createElement('table');
        this.table.className = 'resizable-table';

        // Create colgroup for column widths
        this.colgroup = document.createElement('colgroup');
        this.table.appendChild(this.colgroup);

        // Create thead
        this.thead = document.createElement('thead');
        this.table.appendChild(this.thead);

        // Create tbody
        this.tbody = document.createElement('tbody');
        this.table.appendChild(this.tbody);

        // Add to DOM
        this.tableWrapper.appendChild(this.table);
        this.container.appendChild(this.tableWrapper);
    }

    render() {
        this.renderColgroup();
        this.renderHeader();
        this.renderBody();
    }

    renderColgroup() {
        this.colgroup.innerHTML = '';

        // Ensure all visible columns have explicit widths
        const visibleColumns = this.columns.filter(c => this.isColumnVisible(c.id));

        visibleColumns.forEach(column => {
            const col = document.createElement('col');
            // Use stored width if available
            const storedWidth = this.columnWidths.get(column.id);
            if (storedWidth) {
                col.style.width = `${storedWidth}px`;
            }
            // Width will be set after calculating minimums if not stored
            col.dataset.columnId = column.id;
            this.colgroup.appendChild(col);
        });
    }

    renderHeader() {
        this.thead.innerHTML = '';

        const tr = document.createElement('tr');
        const visibleColumns = this.columns.filter(c => this.isColumnVisible(c.id));

        visibleColumns.forEach((column, visibleIndex) => {
            const th = document.createElement('th');
            th.dataset.columnId = column.id;
            th.dataset.visibleIndex = visibleIndex;

            // Add sortable class and behavior
            if (this.sortable && column.sortable !== false) {
                th.className = 'sortable';
                if (this.sortColumn === column.id) {
                    th.classList.add('sorted', this.sortDirection);
                }
            }

            // Column content
            const content = document.createElement('div');
            content.className = 'th-content';

            const label = document.createElement('span');
            label.className = 'th-label';
            label.textContent = column.label;
            content.appendChild(label);

            // Sort indicator
            if (this.sortable && column.sortable !== false) {
                const sortIndicator = document.createElement('span');
                sortIndicator.className = 'sort-indicator';
                if (this.sortColumn === column.id) {
                    sortIndicator.classList.add('active', this.sortDirection);
                }
                content.appendChild(sortIndicator);
            }

            th.appendChild(content);

            // Add resize handle (except for the last column)
            if (visibleIndex < visibleColumns.length - 1) {
                const resizeHandle = document.createElement('div');
                resizeHandle.className = 'resize-handle';
                // This handle resizes the current column (to its left)
                resizeHandle.dataset.columnId = column.id;
                th.appendChild(resizeHandle);
            }

            tr.appendChild(th);
        });

        this.thead.appendChild(tr);

        // Calculate minimum widths based on header content
        this.calculateMinimumWidths();

        // Apply initial widths based on header minimums if not already set
        this.applyInitialWidths();
    }

    renderBody() {
        this.tbody.innerHTML = '';

        const sortedData = this.getSortedData();

        sortedData.forEach((row, rowIndex) => {
            const tr = document.createElement('tr');
            tr.className = 'table-row';
            if (this.selectable) {
                tr.classList.add('selectable');
            }
            tr.dataset.rowIndex = rowIndex;

            this.columns.forEach((column) => {
                if (!this.isColumnVisible(column.id)) return;

                const td = document.createElement('td');
                td.dataset.columnId = column.id;

                const value = this.getNestedValue(row, column.field || column.id);

                if (typeof this.renderCell === 'function') {
                    const rendered = this.renderCell(value, column, row);
                    if (typeof rendered === 'string') {
                        td.innerHTML = rendered;
                    } else if (rendered instanceof HTMLElement) {
                        td.appendChild(rendered);
                    }
                } else {
                    td.textContent = value || '';
                }

                tr.appendChild(td);
            });

            this.tbody.appendChild(tr);
        });
    }

    setupEventListeners() {
        // Header click for sorting
        this.thead.addEventListener('click', (e) => {
            const th = e.target.closest('th');
            if (!th || !th.classList.contains('sortable')) return;
            if (e.target.closest('.resize-handle')) return;

            const columnId = th.dataset.columnId;
            this.sort(columnId);
        });

        // Row click
        if (this.onRowClick) {
            this.tbody.addEventListener('click', (e) => {
                const tr = e.target.closest('tr');
                if (!tr) return;

                const rowIndex = parseInt(tr.dataset.rowIndex);
                const rowData = this.getSortedData()[rowIndex];
                if (rowData) {
                    this.onRowClick(rowData, e);
                }
            });
        }

        // Column resizing
        this.thead.addEventListener('mousedown', (e) => {
            const handle = e.target.closest('.resize-handle');
            if (!handle) return;

            e.preventDefault();
            this.startResize(e, handle.dataset.columnId);
        });

        // Global mouse events for resizing
        document.addEventListener('mousemove', (e) => this.handleResize(e));
        document.addEventListener('mouseup', () => this.endResize());
    }

    startResize(e, columnId) {
        if (!columnId) return;

        // Find the next visible column
        const visibleColumns = this.columns.filter(c => this.isColumnVisible(c.id));
        const currentIndex = visibleColumns.findIndex(c => c.id === columnId);

        if (currentIndex < 0) return;

        const nextColumn = currentIndex < visibleColumns.length - 1
            ? visibleColumns[currentIndex + 1]
            : null;

        if (!nextColumn) return; // Can't resize the last column

        this.resizeColumnId = columnId;
        this.resizeNextColumnId = nextColumn.id;
        this.resizeStartX = e.clientX;

        const col1 = this.colgroup.querySelector(`col[data-column-id="${columnId}"]`);
        const col2 = this.colgroup.querySelector(`col[data-column-id="${nextColumn.id}"]`);

        if (!col1 || !col2) return;

        // ALWAYS use actual rendered widths - col widths are not reliable with table-layout: auto
        const th1 = this.thead.querySelector(`th[data-column-id="${columnId}"]`);
        const th2 = this.thead.querySelector(`th[data-column-id="${nextColumn.id}"]`);

        if (!th1 || !th2) {
            console.error('Could not find table headers for resize');
            return;
        }

        // Get the actual rendered widths - use offsetWidth which is zoom-stable
        this.resizeStartWidth = th1.offsetWidth;
        this.resizeNextStartWidth = th2.offsetWidth;

        document.body.style.cursor = 'col-resize';
        this.table.classList.add('resizing');
    }

    calculateMinimumWidths() {
        // Calculate minimum width for each column based on its header content
        const visibleColumns = this.columns.filter(c => this.isColumnVisible(c.id));

        visibleColumns.forEach(column => {
            const th = this.thead.querySelector(`th[data-column-id="${column.id}"]`);
            if (th) {
                // Create a temporary element to measure text width
                const measurer = document.createElement('div');
                measurer.style.position = 'absolute';
                measurer.style.visibility = 'hidden';
                measurer.style.whiteSpace = 'nowrap';
                measurer.style.font = window.getComputedStyle(th).font;
                measurer.style.padding = '12px'; // Match th-content padding
                measurer.textContent = column.label;

                document.body.appendChild(measurer);
                const textWidth = measurer.offsetWidth;
                document.body.removeChild(measurer);

                // Add some padding for the resize handle and sort indicator
                const padding = 30; // Extra space for UI elements
                const minWidth = Math.max(this.absoluteMinWidth, textWidth + padding);

                this.columnMinWidths.set(column.id, minWidth);
            }
        });
    }

    applyInitialWidths() {
        // Apply initial column widths based on calculated minimums
        const visibleColumns = this.columns.filter(c => this.isColumnVisible(c.id));

        // Only set initial widths if we don't have stored widths
        visibleColumns.forEach(column => {
            if (!this.columnWidths.has(column.id)) {
                // Use a width slightly larger than minimum for better initial appearance
                // This gives some breathing room for content while still being compact
                const minWidth = this.columnMinWidths.get(column.id) || this.absoluteMinWidth;
                const initialWidth = minWidth + 20; // Add 20px for initial padding

                this.columnWidths.set(column.id, initialWidth);

                // Apply to col element
                const col = this.colgroup.querySelector(`col[data-column-id="${column.id}"]`);
                if (col) {
                    col.style.width = `${initialWidth}px`;
                }
            }
        });
    }

    handleResize(e) {
        if (!this.resizeColumnId || !this.resizeNextColumnId) return;

        const diff = e.clientX - this.resizeStartX;

        // Calculate desired new widths
        let newLeftWidth = this.resizeStartWidth + diff;
        let newRightWidth = this.resizeNextStartWidth - diff;

        // Get dynamic minimum widths for each column
        const leftMinWidth = this.columnMinWidths.get(this.resizeColumnId) || this.absoluteMinWidth;
        const rightMinWidth = this.columnMinWidths.get(this.resizeNextColumnId) || this.absoluteMinWidth;

        // Clamp to minimum width - allow reaching exactly minimum but not below
        newLeftWidth = Math.max(leftMinWidth, newLeftWidth);
        newRightWidth = Math.max(rightMinWidth, newRightWidth);

        // Recalculate to maintain total width when clamped
        const totalWidth = this.resizeStartWidth + this.resizeNextStartWidth;
        if (newLeftWidth === leftMinWidth) {
            newRightWidth = totalWidth - leftMinWidth;
        } else if (newRightWidth === rightMinWidth) {
            newLeftWidth = totalWidth - rightMinWidth;
        }

        // Apply the widths
        const col1 = this.colgroup.querySelector(`col[data-column-id="${this.resizeColumnId}"]`);
        const col2 = this.colgroup.querySelector(`col[data-column-id="${this.resizeNextColumnId}"]`);

        if (col1) col1.style.width = `${newLeftWidth}px`;
        if (col2) col2.style.width = `${newRightWidth}px`;

        // Store the widths
        this.columnWidths.set(this.resizeColumnId, newLeftWidth);
        this.columnWidths.set(this.resizeNextColumnId, newRightWidth);
    }

    endResize() {
        if (!this.resizeColumnId) return;

        // Update our stored widths with the actual rendered widths after resize
        const visibleColumns = this.columns.filter(c => this.isColumnVisible(c.id));
        visibleColumns.forEach(column => {
            const th = this.thead.querySelector(`th[data-column-id="${column.id}"]`);
            if (th) {
                const actualWidth = th.offsetWidth;
                this.columnWidths.set(column.id, actualWidth);

                // Also update the col element
                const col = this.colgroup.querySelector(`col[data-column-id="${column.id}"]`);
                if (col) {
                    col.style.width = `${actualWidth}px`;
                }
            }
        });

        this.resizeColumnId = null;
        this.resizeNextColumnId = null;
        document.body.style.cursor = '';
        this.table.classList.remove('resizing');

        this.saveState();
    }

    sort(columnId) {
        if (this.sortColumn === columnId) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortColumn = columnId;
            this.sortDirection = 'asc';
        }

        this.render();
        this.saveState();
    }

    getSortedData() {
        if (!this.sortColumn) return [...this.data];

        const column = this.columns.find(c => c.id === this.sortColumn);
        if (!column) return [...this.data];

        const field = column.field || column.id;

        return [...this.data].sort((a, b) => {
            // Allow per-column custom comparator
            if (typeof column.compare === 'function') {
                const cmp = column.compare(a, b, this.sortDirection);
                return this.sortDirection === 'asc' ? cmp : -cmp;
            }

            // Default: compare by field value, but allow custom sort value accessor
            let aVal;
            let bVal;

            if (typeof column.getSortValue === 'function') {
                aVal = column.getSortValue(a);
                bVal = column.getSortValue(b);
            } else {
                aVal = this.getNestedValue(a, field);
                bVal = this.getNestedValue(b, field);
            }

            let comparison = 0;

            if (aVal == null && bVal == null) return 0;
            if (aVal == null) return 1;
            if (bVal == null) return -1;

            const aNum = typeof aVal === 'string' ? Number(aVal) : aVal;
            const bNum = typeof bVal === 'string' ? Number(bVal) : bVal;

            if (typeof aNum === 'number' && typeof bNum === 'number' && !Number.isNaN(aNum) && !Number.isNaN(bNum)) {
                comparison = aNum - bNum;
            } else {
                comparison = String(aVal).localeCompare(String(bVal));
            }

            return this.sortDirection === 'asc' ? comparison : -comparison;
        });
    }

    getNestedValue(obj, path) {
        return path.split('.').reduce((acc, part) => acc && acc[part], obj);
    }

    isColumnVisible(columnId) {
        const column = this.columns.find(c => c.id === columnId);
        if (!column) return false;

        if (column.locked) return true;
        return this.visibleColumns.has(columnId);
    }

    setColumnVisibility(columnId, visible) {
        if (visible) {
            this.visibleColumns.add(columnId);
        } else {
            this.visibleColumns.delete(columnId);
        }

        this.render();
        this.saveState();
    }

    calculateAutoWidth(column) {
        // Calculate a reasonable default width based on column content
        const labelLength = (column.label || '').length;
        const baseWidth = labelLength * 8 + 40; // 8px per character + padding
        return Math.max(this.minColumnWidth, Math.min(300, baseWidth));
    }

    setData(data) {
        this.data = data || [];
        this.renderBody();
    }

    loadState() {
        // Initialize visible columns
        this.columns.forEach(column => {
            if (column.defaultVisible !== false || column.locked) {
                this.visibleColumns.add(column.id);
            }
            if (column.locked) {
                this.lockedColumns.add(column.id);
            }
        });

        // Load from localStorage if available
        if (!this.storageKey) return;

        try {
            const key = `resizable-table:${window.location.pathname}:${this.storageKey}`;
            const saved = localStorage.getItem(key);
            if (!saved) return;

            const state = JSON.parse(saved);

            // Restore column visibility
            if (state.visibleColumns) {
                this.visibleColumns = new Set(state.visibleColumns);
                // Ensure locked columns remain visible
                this.lockedColumns.forEach(id => this.visibleColumns.add(id));
            }

            // Restore column widths
            if (state.columnWidths) {
                this.columnWidths = new Map(Object.entries(state.columnWidths));
            }

            // Restore sort state
            if (state.sortColumn) {
                this.sortColumn = state.sortColumn;
                this.sortDirection = state.sortDirection || 'asc';
            }
        } catch (e) {
            console.error('Failed to load table state:', e);
        }
    }

    saveState() {
        if (!this.storageKey) return;

        try {
            const key = `resizable-table:${window.location.pathname}:${this.storageKey}`;
            const state = {
                visibleColumns: Array.from(this.visibleColumns),
                columnWidths: Object.fromEntries(this.columnWidths),
                sortColumn: this.sortColumn,
                sortDirection: this.sortDirection
            };

            localStorage.setItem(key, JSON.stringify(state));
        } catch (e) {
            console.error('Failed to save table state:', e);
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getColumnVisibilityControl() {
        const wrapper = document.createElement('div');
        wrapper.className = 'column-visibility-control';

        const button = document.createElement('button');
        button.className = 'btn btn-secondary';
        button.textContent = 'Columns';

        const dropdown = document.createElement('div');
        dropdown.className = 'column-dropdown';
        dropdown.style.display = 'none';

        this.columns.forEach(column => {
            if (column.locked) return;

            const item = document.createElement('label');
            item.className = 'column-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.visibleColumns.has(column.id);
            checkbox.addEventListener('change', (e) => {
                this.setColumnVisibility(column.id, e.target.checked);
            });

            const label = document.createElement('span');
            label.textContent = column.label;

            item.appendChild(checkbox);
            item.appendChild(label);
            dropdown.appendChild(item);
        });

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = dropdown.style.display === 'block';
            dropdown.style.display = isVisible ? 'none' : 'block';
        });

        // Prevent dropdown from closing when clicking inside it
        dropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            dropdown.style.display = 'none';
        });

        wrapper.appendChild(button);
        wrapper.appendChild(dropdown);

        return wrapper;
    }
}
