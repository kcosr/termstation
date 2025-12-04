/**
 * TemplateQuickOpen
 * A lightweight overlay for quickly searching templates and opening
 * the New Session modal with the selected template pre-selected.
 *
 * Behavior mirrors the Global Links dropdown for keyboard navigation:
 * - ArrowDown focuses the first visible item
 * - ArrowUp/Down navigate visible items
 * - Enter selects the focused item; if only one match, selects it directly
 * - Escape closes the overlay (handled by Modal)
 */

import { Modal } from '../ui/modal.js';

export class TemplateQuickOpen {
    constructor(manager) {
        this.manager = manager;
        this.modalEl = document.getElementById('template-quick-open-modal');
        this.inputEl = document.getElementById('template-quick-open-input');
        this.listEl = document.getElementById('template-quick-open-dropdown');
        this._itemsMeta = []; // [{ header, divider, items, group, title }]
        this._modal = null;
        this._unsubs = [];
        this._open = false;
        this._searchTimer = null;
    }

    init() {
        if (!this.modalEl || !this.inputEl || !this.listEl) return;
        this._modal = new Modal({ element: this.modalEl });
        // Re-focus input a moment after show to ensure caret position
        this._modal.on('show', () => {
            // Focus input shortly after opening
            setTimeout(() => { try { this.inputEl.focus(); this.inputEl.select(); } catch (_) {} }, 60);
            // While open, allow Cmd/Alt+Shift+M to close (toggle)
            const onKeyDown = (e) => {
                try {
                    const hasShift = !!e.shiftKey;
                    const hasMod = !!(e.metaKey || e.altKey);
                    const codeM = String(e.code || '').toLowerCase() === 'keym';
                    const keyM = String(e.key || '').toLowerCase() === 'm';
                    if (hasShift && hasMod && (codeM || keyM)) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.close();
                    }
                } catch (_) {}
            };
            document.addEventListener('keydown', onKeyDown, true);
            this._unsubs.push(() => document.removeEventListener('keydown', onKeyDown, true));
        });
        this._modal.on('hide', () => { this._open = false; });

        const onInput = () => {
            const value = this.inputEl.value || '';
            if (this._searchTimer) clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => {
                this.filter(value);
            }, 150);
        };
        const onKeyDown = (e) => this._handleInputKeys(e);
        this.inputEl.addEventListener('input', onInput);
        this.inputEl.addEventListener('keydown', onKeyDown);
        this._unsubs.push(() => this.inputEl.removeEventListener('input', onInput));
        this._unsubs.push(() => this.inputEl.removeEventListener('keydown', onKeyDown));

        // Close when clicking outside the floating modal
        const onDocPointerDown = (e) => {
            try {
                if (!this._open) return;
                const inside = this.modalEl.contains(e.target);
                if (!inside) {
                    this.close();
                }
            } catch (_) {}
        };
        document.addEventListener('mousedown', onDocPointerDown, true);
        document.addEventListener('touchstart', onDocPointerDown, { passive: true, capture: true });
        this._unsubs.push(() => document.removeEventListener('mousedown', onDocPointerDown, true));
        this._unsubs.push(() => document.removeEventListener('touchstart', onDocPointerDown, true));
    }

    async open() {
        if (!this._modal) this.init();
        if (!this._modal) return;
        // Ensure templates are loaded first time
        try {
            if (!Array.isArray(this.manager.formManager?.availableTemplates) || this.manager.formManager.availableTemplates.length === 0) {
                await this.manager.formManager.loadTemplates();
            }
        } catch (_) {}
        this.render();
        try { this.inputEl.value = ''; } catch (_) {}
        // Hide dropdown until user types and there are matches
        try { this.listEl.classList.remove('show'); this.listEl.style.display = 'none'; } catch (_) {}
        this.filter('');
        this._modal.show();
        this._open = true;
    }

    close() {
        try { this._modal?.hide?.(); } catch (_) {}
        this._open = false;
    }

    isOpen() {
        return this._open === true;
    }

    destroy() {
        this._unsubs.forEach(fn => { try { fn(); } catch(_) {} });
        this._unsubs = [];
        try { this._modal?.hide?.(); } catch (_) {}
        this._modal = null;
    }

    _templates() {
        const arr = Array.isArray(this.manager.formManager?.availableTemplates) ? this.manager.formManager.availableTemplates : [];
        // Only include templates explicitly not hidden
        return arr.filter(t => t && t.display !== false);
    }

    render() {
        const list = this.listEl;
        if (!list) return;
        list.innerHTML = '';
        this._itemsMeta = [];

        const templates = this._templates();
        // Special-case Local Shell at the top (no group header)
        try {
            const idx = templates.findIndex(t => t && t.isLocal === true);
            if (idx >= 0) {
                const t = templates[idx];
                const item = this._createItem(t);
                list.appendChild(item);
            }
        } catch (_) {}

        // Group remaining templates by group
        const groupsMap = new Map();
        const groupsSet = new Set();
        templates.forEach(t => {
            if (t && t.isLocal === true) return; // already handled
            const g = t.group || 'Other';
            if (!groupsMap.has(g)) groupsMap.set(g, []);
            groupsMap.get(g).push(t);
            groupsSet.add(g);
        });

        const groups = Array.from(groupsSet).sort();
        groups.forEach((g, gi) => {
            const header = document.createElement('div');
            header.className = 'dropdown-header';
            header.textContent = g;
            list.appendChild(header);
            const items = [];
            const arr = groupsMap.get(g) || [];
            arr.forEach(t => {
                const a = this._createItem(t);
                list.appendChild(a);
                items.push(a);
            });
            let divider = null;
            if (gi < groups.length - 1) {
                divider = document.createElement('div');
                divider.className = 'dropdown-divider';
                list.appendChild(divider);
            }
            this._itemsMeta.push({ header, divider, items, group: g, title: (g || '').toLowerCase() });
        });

        // If no templates, show info row
        if (list.children.length === 0) {
            const info = document.createElement('div');
            info.className = 'dropdown-info';
            info.textContent = 'No templates available';
            list.appendChild(info);
        }
    }

    _createItem(template) {
        const a = document.createElement('a');
        a.className = 'dropdown-item';
        a.href = '#';
        // Title row (name + optional shortcut on the right)
        const titleRow = document.createElement('div');
        titleRow.className = 'dropdown-title-row';
        const titleText = document.createElement('span');
        titleText.className = 'dropdown-title-text';
        titleText.textContent = template.name || template.id;
        titleRow.appendChild(titleText);
        const sc = (template && typeof template.shortcut === 'string') ? template.shortcut.trim() : '';
        if (sc) {
            const shortcutEl = document.createElement('span');
            shortcutEl.className = 'dropdown-shortcut';
            shortcutEl.textContent = `(${sc})`;
            titleRow.appendChild(shortcutEl);
        }
        a.appendChild(titleRow);
        // Subtext: show defaulted parameters (e.g., "Repo: devtools/terminals")
        const defaults = this._buildDefaultsSubtext(template);
        if (defaults) a.appendChild(defaults);
        a.setAttribute('role', 'menuitem');
        a.setAttribute('tabindex', '-1');
        a.dataset.templateId = template.id;
        a.addEventListener('click', (e) => {
            try { e.preventDefault(); } catch(_) {}
            // Default click → create immediately (auto behavior)
            // Shift+Click → open New Session modal with template preselected
            if (e && e.shiftKey) {
                this._onSelect(template);
                return;
            }
            this._createSessionForTemplate(template);
        });
        a.addEventListener('keydown', (e) => this._handleItemKeys(e));
        return a;
    }

    _buildDefaultsSubtext(template) {
        try {
            const params = Array.isArray(template?.parameters) ? template.parameters : [];
            const items = [];
            for (const p of params) {
                if (!p || p.display === false) continue;
                // Only show when a default value is provided (including boolean false/true)
                if (!Object.prototype.hasOwnProperty.call(p, 'default')) continue;
                const name = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : (p.name || '');
                if (!name) continue;
                let val = p.default;
                if (val === undefined || val === null) continue;
                // Normalize for display
                if (typeof val === 'boolean') {
                    val = val ? 'true' : 'false';
                } else {
                    val = String(val);
                }
                items.push(`${name}: ${val}`);
            }
            if (items.length === 0) return null;
            const sub = document.createElement('div');
            sub.className = 'dropdown-subtext';
            const text = items.join(', ');
            sub.textContent = text;
            sub.title = text; // full value on hover for long lists
            return sub;
        } catch (_) { return null; }
    }

    _visibleItems() {
        try { return Array.from(this.listEl.querySelectorAll('.dropdown-item')).filter(el => el.style.display !== 'none'); } catch (_) { return []; }
    }

    _focusFirstVisibleItem() {
        const items = this._visibleItems();
        if (items.length > 0) {
            try { items[0].focus(); } catch (_) {}
        }
    }

    _handleInputKeys(e) {
        const key = (e.key || '').toLowerCase();
        // Enter behavior from input:
        // - If exactly one result: Enter → create immediately; Shift+Enter → open modal
        // - If multiple results: do nothing (must choose a specific template)
        if (key === 'arrowdown') {
            e.preventDefault();
            e.stopPropagation();
            // Show dropdown on ArrowDown even with empty query
            this._ensureListVisible();
            this._focusFirstVisibleItem();
            return;
        }
        if (key === 'enter') {
            const items = this._visibleItems();
            if (items.length !== 1) {
                // More than one (or none): ignore Enter
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            const id = String(items[0].dataset.templateId || '');
            const tpl = this._findTemplateById(id);
            if (tpl) {
                if (e.shiftKey) {
                    this._onSelect(tpl);
                } else {
                    this._createSessionForTemplate(tpl);
                }
            }
            return;
        }
        if (key === 'escape') {
            // Close overlay on Escape
            e.preventDefault();
            e.stopPropagation();
            this.close();
        }
    }

    _moveFocusFrom(item, delta) {
        const items = this._visibleItems();
        if (items.length === 0) {
            try { this.inputEl.focus(); } catch (_) {}
            return;
        }
        let idx = items.indexOf(item);
        if (idx < 0) idx = delta > 0 ? -1 : 0;
        if (delta < 0 && idx <= 0) { this.inputEl.focus(); return; }
        let next = idx + delta;
        if (next < 0) next = items.length - 1;
        if (next >= items.length) next = 0;
        try { items[next].focus(); } catch (_) {}
    }

    _handleItemKeys(e) {
        const key = (e.key || '').toLowerCase();
        const target = e.currentTarget;
        if (key === 'arrowdown') { e.preventDefault(); this._moveFocusFrom(target, 1); return; }
        if (key === 'arrowup')   { e.preventDefault(); this._moveFocusFrom(target, -1); return; }
        if (key === 'enter')     {
            e.preventDefault();
            e.stopPropagation();
            // Enter on a focused item → create immediately; Shift+Enter → open modal
            try {
                const id = String(target.dataset.templateId || '');
                const tpl = this._findTemplateById(id);
                if (tpl) {
                    if (e.shiftKey) {
                        this._onSelect(tpl);
                    } else {
                        this._createSessionForTemplate(tpl);
                    }
                }
            } catch (_) { /* ignore */ }
            return;
        }
        if (key === 'tab')       { this.close(); return; }
        if (key === 'escape')    { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    }

    filter(queryStr) {
        const q = (queryStr || '').trim().toLowerCase();
        const hasQuery = q.length > 0;

        // Simple visibility toggle for headers/items by group
        const counts = [];
        let visibleTotal = 0;
        this._itemsMeta.forEach((gm, gi) => {
            let visibleInGroup = 0;
            (gm.items || []).forEach((a) => {
                const text = (a.textContent || '').toLowerCase();
                const id = String(a.dataset.templateId || '').toLowerCase();
                const template = this._findTemplateById(id);
                const group = (template?.group || '').toLowerCase();
                const shortcut = (template?.shortcut || '').toLowerCase();
                // Match name, id, group, or description
                let hit = !hasQuery;
                if (!hit) {
                    hit = text.indexOf(q) !== -1 || id.indexOf(q) !== -1 || group.indexOf(q) !== -1 || shortcut.indexOf(q) !== -1;
                }
                if (!hit && template && template.description) {
                    hit = (template.description.toLowerCase().indexOf(q) !== -1);
                }
                a.style.display = hit ? '' : 'none';
                if (hit) visibleInGroup++;
            });
            if (gm.header) gm.header.style.display = visibleInGroup > 0 ? '' : 'none';
            counts[gi] = visibleInGroup;
            visibleTotal += visibleInGroup;
        });
        // Dividers only between visible groups
        this._itemsMeta.forEach((gm, gi) => {
            if (!gm.divider) return;
            const anyAfter = counts.slice(gi + 1).some(c => c > 0);
            gm.divider.style.display = (counts[gi] > 0 && anyAfter) ? '' : 'none';
        });

        // Handle Local Shell row (outside groups) — always present at top when available
        try {
            const first = this.listEl.firstElementChild;
            if (first && first.classList.contains('dropdown-item')) {
                const id = String(first.dataset.templateId || '').toLowerCase();
                const template = this._findTemplateById(id);
                if (template && template.isLocal === true) {
                    const text = (first.textContent || '').toLowerCase();
                    const hit = !hasQuery || text.indexOf(q) !== -1;
                    first.style.display = hit ? '' : 'none';
                    if (hit) visibleTotal += 1;
                }
            }
        } catch (_) {}

        // Only show dropdown when there is a query and matches exist
        const shouldShow = hasQuery && visibleTotal > 0;
        try {
            if (shouldShow) {
                this.listEl.classList.add('show');
                this.listEl.style.display = '';
            } else {
                this.listEl.classList.remove('show');
                this.listEl.style.display = 'none';
            }
        } catch (_) {}
    }

    _ensureListVisible() {
        try {
            this.listEl.classList.add('show');
            this.listEl.style.display = '';
        } catch (_) {}
    }

    _findTemplateById(id) {
        const arr = this._templates();
        return arr.find(t => (t.id || '').toLowerCase() === String(id || '').toLowerCase());
    }

    async _onSelect(template) {
        try {
            this.close();
            // Open New Session modal and pre-select the template
            await this.manager.showNewSessionModal();
            if (this.manager?.formManager?.templateSearchManager) {
                try {
                    this.manager.formManager.templateSearchManager.selectSingleTemplate(template);
                } catch (_) {
                    // Fallback: set selection directly
                    this.manager.formManager.selectedTemplates = [template];
                    this.manager.formManager.updateSelectedTemplatesDisplay();
                    this.manager.formManager.updateParameterForm();
                }
            }
        } catch (e) {
            console.warn('[TemplateQuickOpen] Failed to select template:', e);
        }
    }

    async _createSessionForTemplate(template) {
        try {
            this.close();
            // Pre-select without opening the New Session modal
            try {
                const formManager = this.manager?.formManager;
                if (formManager && typeof formManager.handleSelectionChange === 'function') {
                    formManager.handleSelectionChange([template]);
                } else if (formManager) {
                    formManager.selectedTemplates = [template];
                    try { formManager.updateSelectedTemplatesDisplay?.(); } catch (_) {}
                    try { formManager.updateParameterForm?.(); } catch (_) {}
                }
                this._ensureQuickCreateWorkspaceSelection();
                // Resolve headless defaults so dynamic select params (e.g., branches) pick first option
                if (formManager && typeof formManager.computeHeadlessDefaultsForTemplates === 'function') {
                    await formManager.computeHeadlessDefaultsForTemplates([template]);
                }
            } catch (_) {}
            await this.manager.createNewSession();
        } catch (e) {
            console.warn('[TemplateQuickOpen] Immediate create failed:', e);
        }
    }

    _ensureQuickCreateWorkspaceSelection() {
        try {
            const manager = this.manager;
            if (!manager) return;
            const select = document.getElementById('session-workspace-select');
            const hidden = document.getElementById('session-workspace');
            if (!select) {
                if (hidden) {
                    const currentWorkspace = (manager.currentWorkspace && manager.currentWorkspace !== 'Default')
                        ? manager.currentWorkspace
                        : '';
                    hidden.value = currentWorkspace;
                }
                return;
            }

            const existingValues = new Set(Array.from(select.options || []).map(opt => opt.value));
            if (!existingValues.has('')) {
                const defaultOption = document.createElement('option');
                defaultOption.value = '';
                defaultOption.textContent = 'Default';
                select.appendChild(defaultOption);
                existingValues.add('');
            }

            try {
                const workspaceNames = (typeof manager.getWorkspaceNames === 'function')
                    ? manager.getWorkspaceNames()
                    : [];
                workspaceNames
                    .filter(name => name && name !== 'Default')
                    .forEach(name => {
                        if (!existingValues.has(name)) {
                            const opt = document.createElement('option');
                            opt.value = name;
                            opt.textContent = name;
                            select.appendChild(opt);
                            existingValues.add(name);
                        }
                    });
            } catch (_) { /* ignore */ }

            const currentWorkspace = (manager.currentWorkspace && manager.currentWorkspace !== 'Default')
                ? manager.currentWorkspace
                : '';
            if (currentWorkspace && !existingValues.has(currentWorkspace)) {
                const opt = document.createElement('option');
                opt.value = currentWorkspace;
                opt.textContent = currentWorkspace;
                select.appendChild(opt);
                existingValues.add(currentWorkspace);
            }
            select.value = currentWorkspace;
            if (hidden) {
                hidden.value = currentWorkspace;
            }
        } catch (_) { /* ignore */ }
    }
}
