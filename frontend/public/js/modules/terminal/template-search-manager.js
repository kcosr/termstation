/**
 * Template Search Manager Module
 * Handles template dropdown search, keyboard navigation, and selection logic
 * Extracted from SessionFormManager to reduce complexity and improve maintainability
 */

export class TemplateSearchManager {
    static SEARCH_THROTTLE_MS = 150;
    static LONG_PRESS_MS = 500; // Threshold for long-press detection

    constructor(options = {}) {
        this.elements = options.elements || {};
        this.availableTemplates = options.availableTemplates || [];
        this.selectedTemplates = options.selectedTemplates || [];
        
        // Callbacks for communicating with parent form manager
        this.onSelectionChange = options.onSelectionChange || (() => {});
        this.onDropdownToggle = options.onDropdownToggle || (() => {});
        this.checkForConflicts = options.checkForConflicts || (() => false);
        
        // Internal state
        this.dropdownOpen = false;
        this.focusedOptionIndex = -1;
        this.dropdownOptions = [];
        this.searchTimeout = null;
        
        // Bind the escape handler so we can add/remove it
        this.documentEscapeHandler = (e) => {
            if (e.key === 'Escape' && this.dropdownOpen) {
                e.preventDefault();
                e.stopPropagation();
                this.hideDropdown();
            }
        };
        
        // Bind the focus out handler
        this.containerFocusOutHandler = (e) => {
            // Use setTimeout to allow the focus to move to the new element
            setTimeout(() => {
                const container = document.getElementById('template-select-container');
                if (container && !container.contains(document.activeElement) && this.dropdownOpen) {
                    this.hideDropdown();
                }
            }, 0);
        };
        
        // Ensure modal starts clean without any height adjustments
        const modalBody = document.querySelector('#new-session-modal .modal-body');
        const searchWrapper = document.querySelector('.template-search-wrapper');
        if (modalBody) {
            modalBody.classList.remove('dropdown-open');
        }
        if (searchWrapper) {
            searchWrapper.style.marginBottom = '';
        }
        
        this.setupEventListeners();
    }

    /**
     * Update the available templates
     */
    updateTemplates(templates) {
        this.availableTemplates = templates;
    }

    /**
     * Update the selected templates
     */
    updateSelection(selectedTemplates) {
        this.selectedTemplates = selectedTemplates;
    }

    /**
     * Check if a template matches the search text in name, description, or group
     */
    templateMatchesSearch(template, searchText) {
        const searchLower = searchText.toLowerCase().trim();
        const nameMatch = template.name && template.name.toLowerCase().includes(searchLower);
        const descMatch = template.description && template.description.toLowerCase().includes(searchLower);
        const groupMatch = template.group && template.group.toLowerCase().includes(searchLower);
        const shortcutMatch = template.shortcut && String(template.shortcut).toLowerCase().includes(searchLower);
        
        return nameMatch || descMatch || groupMatch || shortcutMatch;
    }

    setupEventListeners() {
        // Template search input
        if (this.elements.templateSearch) {
            // Show dropdown on focus
            this.elements.templateSearch.addEventListener('focus', () => {
                this.showDropdown();
            });

            // Show dropdown on click
            this.elements.templateSearch.addEventListener('click', () => {
                this.showDropdown();
            });

            this.elements.templateSearch.addEventListener('input', (e) => {
                const searchValue = e.target.value;
                
                // Clear existing timeout to avoid rapid re-rendering
                if (this.searchTimeout) {
                    clearTimeout(this.searchTimeout);
                }
                
                // Throttle search to improve performance
                this.searchTimeout = setTimeout(() => {
                    this.filterTemplates(searchValue);
                }, TemplateSearchManager.SEARCH_THROTTLE_MS);
            });

            // Keyboard navigation
            this.elements.templateSearch.addEventListener('keydown', (e) => {
                this.handleKeyboardNavigation(e);
            });

            // Close dropdown when clicking outside the container (limit to modal overlay)
            this.outsideClickTarget = document.getElementById('new-session-modal') || document;
            this.outsideClickHandler = (e) => {
                if (!e.target.closest('#template-select-container') && this.dropdownOpen) {
                    this.hideDropdown();
                }
            };
            this.outsideClickTarget.addEventListener('click', this.outsideClickHandler);
        }
    }

    /**
     * Attach unified press handlers to support click and long-press behaviors
     * Uses Pointer Events when available, with mouse/touch fallback.
     */
    attachPressHandlers(element, onClick, onLongPress) {
        if (!element) return;

        let pressTimer = null;
        let longPressed = false;

        const start = (e) => {
            // Only primary button for mouse; allow touches
            if (e && typeof e.button === 'number' && e.button !== 0) return;
            longPressed = false;
            clearTimeout(pressTimer);
            // Attempt to capture pointer to avoid leave/cancel due to minor movement
            try {
                if (e && e.pointerId != null && element.setPointerCapture) {
                    element.setPointerCapture(e.pointerId);
                }
            } catch (_) {}
            pressTimer = setTimeout(() => {
                longPressed = true;
                try { onLongPress && onLongPress(e); } catch (_) {}
            }, TemplateSearchManager.LONG_PRESS_MS);
        };

        const cancel = (e) => {
            clearTimeout(pressTimer);
            pressTimer = null;
            // Release capture if the pointer stream is canceled mid-press
            try {
                if (e && e.pointerId != null && element.releasePointerCapture) {
                    element.releasePointerCapture(e.pointerId);
                }
            } catch (_) {}
        };

        const end = (e) => {
            // If timer still pending, treat as normal click
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
                if (!longPressed) {
                    try { onClick && onClick(e); } catch (_) {}
                }
            }
            // Best-effort release of pointer capture
            try {
                if (e && e.pointerId != null && element.releasePointerCapture) {
                    element.releasePointerCapture(e.pointerId);
                }
            } catch (_) {}
        };

        // Prefer Pointer Events to avoid duplicate mouse/touch handling
        if (window && 'PointerEvent' in window) {
            element.addEventListener('pointerdown', start);
            element.addEventListener('pointerup', end);
            element.addEventListener('pointercancel', cancel);
        } else {
            // Mouse fallback
            element.addEventListener('mousedown', start);
            element.addEventListener('mouseup', end);
            // Touch fallback
            element.addEventListener('touchstart', start, { passive: true });
            element.addEventListener('touchend', end);
            element.addEventListener('touchcancel', cancel);
        }

        // Treat context menu (common on touch long-press) as a long-press and suppress menu
        element.addEventListener('contextmenu', (e) => {
            try { e.preventDefault(); } catch (_) {}
            if (pressTimer && !longPressed) {
                clearTimeout(pressTimer);
                pressTimer = null;
                longPressed = true;
                try { onLongPress && onLongPress(e); } catch (_) {}
            }
        });
    }

    renderTemplateOptions(filterText = '') {
        if (!this.elements.templateDropdown) {
            console.error('Template dropdown element not found');
            return;
        }
        
        this.elements.templateDropdown.innerHTML = '';
        this.dropdownOptions = [];
        this.focusedOptionIndex = -1;

        // Add dropdown header with close button
        const dropdownHeader = this.createDropdownHeader();
        this.elements.templateDropdown.appendChild(dropdownHeader);

        let filteredTemplates = this.availableTemplates.filter(template => template.display !== false);

        // Apply search filter
        if (filterText) {
            filteredTemplates = filteredTemplates.filter(template => 
                this.templateMatchesSearch(template, filterText)
            );
        }

        // Special-case: render synthetic Local Shell first (not grouped)
        try {
            const idx = filteredTemplates.findIndex(t => t && t.isLocal === true);
            if (idx >= 0) {
                const localTpl = filteredTemplates[idx];
                // Remove from list so it doesn't get grouped below
                filteredTemplates = filteredTemplates.slice(0, idx).concat(filteredTemplates.slice(idx + 1));
                const localOption = this.createTemplateOption(localTpl, false);
                // Improve accessibility labelling
                try { localOption.setAttribute('aria-label', localTpl.aria_label || localTpl.name || 'Local Shell'); } catch (_) {}
                this.elements.templateDropdown.appendChild(localOption);
                this.dropdownOptions.push({ type: 'template', data: localTpl });
            }
        } catch (_) { /* ignore */ }

        // Group templates by group for better organization
        const templatesByGroup = new Map();
        const availableGroups = new Set();
        
        filteredTemplates.forEach(template => {
            const group = template.group || 'Other';
            availableGroups.add(group);
            if (!templatesByGroup.has(group)) {
                templatesByGroup.set(group, []);
            }
            templatesByGroup.get(group).push(template);
        });

        // Note: Custom command option removed; only real templates are listed

        // Add grouped options
        const sortedGroups = Array.from(availableGroups).sort();
        
        sortedGroups.forEach(group => {
            const templates = templatesByGroup.get(group);
            
            // Show group header if we have multiple groups or if there's a search filter
            const shouldShowGroupHeader = availableGroups.size > 1 || (filterText && filterText.trim());
            
            if (shouldShowGroupHeader) {
                const groupOption = this.createGroupOption(group, templates, filterText);
                this.elements.templateDropdown.appendChild(groupOption);
                this.dropdownOptions.push({ type: 'group', data: { group, templates } });
            }
            
            // Add individual templates
            templates.forEach(template => {
                const option = this.createTemplateOption(template, availableGroups.size > 1);
                // Provide accessible label if specified on template
                try { option.setAttribute('aria-label', template.aria_label || template.name || 'Template'); } catch (_) {}
                this.elements.templateDropdown.appendChild(option);
                this.dropdownOptions.push({ type: 'template', data: template });
            });
        });

        // Show "no results" message if only header exists
        if (this.elements.templateDropdown.children.length === 1) {
            const noResults = document.createElement('div');
            noResults.className = 'template-option disabled';
            noResults.textContent = 'No templates found';
            this.elements.templateDropdown.appendChild(noResults);
        } else {
            // Auto-focus single template result (excluding groups)
            this.autoFocusSingleResult();
        }

        // Update modal height to match dropdown content size
        if (this.dropdownOpen) {
            // Use setTimeout to ensure DOM has fully updated with new content
            setTimeout(() => this.updateModalHeight(), 10);
        }
    }

    createTemplateOption(template, showGroup = false) {
        const option = document.createElement('div');
        option.className = 'template-option';
        
        const isSelected = this.selectedTemplates.some(t => t.id === template.id);
        if (isSelected) {
            option.classList.add('selected');
        }

        // Check for conflicts if this template would be selected
        const hasConflict = this.checkForConflicts(template);
        if (hasConflict && !isSelected) {
            option.classList.add('disabled');
        }

        const label = document.createElement('div');
        label.className = 'template-option-label';

        const name = document.createElement('div');
        name.className = 'template-option-name';
        name.textContent = template.name;
        label.appendChild(name);

        if (template.group && showGroup) {
            const group = document.createElement('div');
            group.className = 'template-option-group';
            group.textContent = template.group;
            label.appendChild(group);
        }

        option.appendChild(label);

        if (!option.classList.contains('disabled')) {
            this.attachPressHandlers(
                option,
                // onClick
                (e) => {
                    e && e.stopPropagation && e.stopPropagation();
                    this.handleTemplateClick(template, e || {});
                },
                // onLongPress: behave like Shift+click (toggle without closing)
                (e) => {
                    e && e.stopPropagation && e.stopPropagation();
                    this.handleTemplateLongPress(template, e || {});
                }
            );
        }

        return option;
    }

    createGroupOption(groupName, templates, searchText = '') {
        const option = document.createElement('div');
        option.className = 'template-group-option';
        
        const displayName = groupName === 'Other' ? 'Uncategorized' : groupName;
        
        // Removed search-match highlighting to avoid confusion with selection
        
        const groupText = document.createElement('span');
        groupText.className = 'group-name';
        
        groupText.textContent = displayName;
        
        option.appendChild(groupText);
        
        const count = document.createElement('span');
        count.className = 'group-count';
        count.textContent = `${templates.length} template${templates.length === 1 ? '' : 's'}`;
        option.appendChild(count);

        this.attachPressHandlers(
            option,
            // onClick
            (e) => {
                e && e.stopPropagation && e.stopPropagation();
                this.handleGroupClick(templates, e || {});
            },
            // onLongPress: behave like Shift+click on group (toggle group selection)
            (e) => {
                e && e.stopPropagation && e.stopPropagation();
                this.handleGroupLongPress(templates, e || {});
            }
        );

        return option;
    }

    autoFocusSingleResult() {
        // Count only template options (not groups)
        const templateOptions = this.dropdownOptions.filter(option => option.type === 'template');
        
        // If there's exactly one template result, auto-focus it
        if (templateOptions.length === 1) {
            // Find the index of this template in all dropdown options
            const templateIndex = this.dropdownOptions.findIndex(option => 
                option.type === 'template' && 
                option.data.id === templateOptions[0].data.id
            );
            
            if (templateIndex >= 0) {
                this.focusedOptionIndex = templateIndex;
                this.updateOptionFocus();
            }
        }
    }

    createDropdownHeader() {
        const header = document.createElement('div');
        header.className = 'template-dropdown-header';
        
        const titleContainer = document.createElement('div');
        titleContainer.className = 'dropdown-title-container';
        
        const title = document.createElement('span');
        title.className = 'dropdown-title';
        title.textContent = 'Select Templates';
        titleContainer.appendChild(title);
        
        const hint = document.createElement('span');
        hint.className = 'dropdown-hint';
        hint.textContent = 'Shift+click or long-press for multiple';
        titleContainer.appendChild(hint);
        
        header.appendChild(titleContainer);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button'; // Prevent form submission
        closeBtn.className = 'dropdown-close-btn';
        closeBtn.innerHTML = '×';
        closeBtn.title = 'Close dropdown';
        closeBtn.tabIndex = -1; // Prevent tab navigation to this button
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideDropdown();
        });
        header.appendChild(closeBtn);

        return header;
    }

    handleKeyboardNavigation(e) {
        // Handle Escape separately - it should close dropdown when open, or bubble up when closed
        if (e.key === 'Escape') {
            if (this.dropdownOpen) {
                e.preventDefault();
                e.stopPropagation();
                this.hideDropdown();
            }
            // If dropdown is closed, don't prevent default - let it bubble up to close modal
            return;
        }

        // For other keys, only handle when dropdown is open
        if (!this.dropdownOpen || this.dropdownOptions.length === 0) {
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                e.stopPropagation();
                this.focusNextOption();
                break;
            case 'ArrowUp':
                e.preventDefault();
                e.stopPropagation();
                this.focusPreviousOption();
                break;
            case 'Enter':
                e.preventDefault();
                e.stopPropagation();
                this.selectFocusedOption(e.shiftKey);
                break;
        }
    }

    focusNextOption() {
        this.focusedOptionIndex = Math.min(this.focusedOptionIndex + 1, this.dropdownOptions.length - 1);
        this.updateOptionFocus();
    }

    focusPreviousOption() {
        this.focusedOptionIndex = Math.max(this.focusedOptionIndex - 1, -1);
        this.updateOptionFocus();
    }

    updateOptionFocus() {
        // Remove focus from all options
        const allOptions = this.elements.templateDropdown.querySelectorAll('.template-option, .template-group-option');
        allOptions.forEach(option => option.classList.remove('focused'));

        // Focus the current option
        if (this.focusedOptionIndex >= 0 && this.focusedOptionIndex < allOptions.length) {
            const focusedOption = allOptions[this.focusedOptionIndex];
            focusedOption.classList.add('focused');
            focusedOption.scrollIntoView({ block: 'nearest' });
        }
    }

    selectFocusedOption(isShiftKey = false) {
        if (this.focusedOptionIndex >= 0 && this.focusedOptionIndex < this.dropdownOptions.length) {
            const option = this.dropdownOptions[this.focusedOptionIndex];
            if (option.type === 'template') {
                if (isShiftKey) {
                    // Shift+Enter: toggle selection without closing dropdown (like Shift+click)
                    this.toggleTemplate(option.data, false);
                } else {
                    // Regular Enter: select only this template and close dropdown
                    this.selectSingleTemplate(option.data);
                    this.hideDropdown();
                }
            } else if (option.type === 'group') {
                if (isShiftKey) {
                    // Shift+Enter: toggle group selection without closing dropdown
                    this.selectTemplateGroup(option.data.templates);
                } else {
                    // Regular Enter: select only this group and close dropdown
                    this.selectSingleGroup(option.data.templates);
                    this.hideDropdown();
                }
            }
        }
    }

    handleTemplateClick(template, event) {
        const isShiftClick = event.shiftKey;
        
        if (isShiftClick) {
            // Shift+click: toggle selection without closing dropdown
            this.toggleTemplate(template, false);
        } else {
            // Regular click: select only this template and close dropdown
            this.selectSingleTemplate(template);
            this.hideDropdown();
        }
    }
    
    handleTemplateLongPress(template, _event) {
        // Long‑press: toggle selection without closing dropdown (same as Shift+click)
        this.toggleTemplate(template, false);
    }

    handleGroupClick(templates, event) {
        const isShiftClick = event.shiftKey;
        
        if (isShiftClick) {
            // Shift+click: toggle group selection without closing dropdown
            this.selectTemplateGroup(templates);
        } else {
            // Regular click: select only this group and close dropdown
            this.selectSingleGroup(templates);
            this.hideDropdown();
        }
    }

    handleGroupLongPress(templates, _event) {
        // Long‑press: toggle group selection without closing dropdown (same as Shift+click)
        this.selectTemplateGroup(templates);
    }

    selectSingleTemplate(template) {
        // Clear all existing selections and select only this template
        this.selectedTemplates.length = 0;
        
        if (!this.checkForConflicts(template)) {
            this.selectedTemplates.push(template);
        }
        
        this.onSelectionChange(this.selectedTemplates);
        this.renderTemplateOptions(this.elements.templateSearch ? this.elements.templateSearch.value : '');
    }

    selectSingleGroup(templates) {
        // Clear all existing selections and select only templates from this group
        this.selectedTemplates.length = 0;
        
        // Add templates from this group that don't have conflicts
        templates.forEach(template => {
            if (!this.checkForConflicts(template)) {
                this.selectedTemplates.push(template);
            }
        });
        
        this.onSelectionChange(this.selectedTemplates);
        this.renderTemplateOptions(this.elements.templateSearch ? this.elements.templateSearch.value : '');
    }

    toggleTemplate(template, closeDropdown = true) {
        const index = this.selectedTemplates.findIndex(t => t.id === template.id);
        
        if (index > -1) {
            // Remove template
            this.selectedTemplates.splice(index, 1);
        } else {
            // Check for conflicts before adding
            if (!this.checkForConflicts(template)) {
                this.selectedTemplates.push(template);
            }
        }

        this.onSelectionChange(this.selectedTemplates);
        this.renderTemplateOptions(this.elements.templateSearch ? this.elements.templateSearch.value : '');
        
        // Close dropdown if requested (used for Shift+click behavior)
        if (closeDropdown) {
            this.hideDropdown();
        }
    }

    selectTemplateGroup(templates) {
        // Check if all templates in this group are already selected
        const allSelected = templates.every(template => 
            this.selectedTemplates.some(selected => selected.id === template.id)
        );

        if (allSelected) {
            // Deselect all templates in this group
            templates.forEach(template => {
                const index = this.selectedTemplates.findIndex(selected => selected.id === template.id);
                if (index > -1) {
                    this.selectedTemplates.splice(index, 1);
                }
            });
        } else {
            // Select all templates in this group that don't have conflicts
            templates.forEach(template => {
                const isSelected = this.selectedTemplates.some(selected => selected.id === template.id);
                if (!isSelected && !this.checkForConflicts(template)) {
                    this.selectedTemplates.push(template);
                }
            });
        }

        this.onSelectionChange(this.selectedTemplates);
        this.renderTemplateOptions(this.elements.templateSearch ? this.elements.templateSearch.value : '');
    }

    filterTemplates(searchText) {
        this.renderTemplateOptions(searchText);
        this.showDropdown();
        // Height will be updated automatically in renderTemplateOptions
    }

    showDropdown() {
        if (this.elements.templateDropdown) {
            this.elements.templateDropdown.style.display = 'block';
            this.dropdownOpen = true;
            
            // Make dropdown non-focusable to prevent tab navigation
            this.elements.templateDropdown.tabIndex = -1;
            
            // Add document-level escape handler
            document.addEventListener('keydown', this.documentEscapeHandler, true);
            
            // Add focus out handler to container
            const container = document.getElementById('template-select-container');
            if (container) {
                container.addEventListener('focusout', this.containerFocusOutHandler);
            }
            
            // Add class and set dynamic height for modal body
            const modalBody = document.querySelector('#new-session-modal .modal-body');
            if (modalBody) {
                modalBody.classList.add('dropdown-open');
                // Use small timeout to ensure dropdown is visible before measuring
                setTimeout(() => this.updateModalHeight(), 10);
            }
            
            this.onDropdownToggle(true);
        }
    }

    hideDropdown() {
        if (this.elements.templateDropdown) {
            this.elements.templateDropdown.style.display = 'none';
            this.dropdownOpen = false;
            
            // Remove document-level escape handler
            document.removeEventListener('keydown', this.documentEscapeHandler, true);
            
            // Remove focus out handler from container
            const container = document.getElementById('template-select-container');
            if (container) {
                container.removeEventListener('focusout', this.containerFocusOutHandler);
            }
            
            // Remove class and reset modal adjustments
            const modalBody = document.querySelector('#new-session-modal .modal-body');
            const searchWrapper = document.querySelector('.template-search-wrapper');
            if (modalBody) {
                modalBody.classList.remove('dropdown-open');
            }
            if (searchWrapper) {
                searchWrapper.style.marginBottom = ''; // Reset search wrapper margin
            }
            
            this.onDropdownToggle(false);
        }
    }

    /**
     * Update modal height based on dropdown content
     */
    updateModalHeight() {
        const dropdown = this.elements.templateDropdown;
        const searchWrapper = document.querySelector('.template-search-wrapper');
        
        if (dropdown && searchWrapper && this.dropdownOpen) {
            // Reset previous adjustments
            searchWrapper.style.marginBottom = '';
            
            // Force a reflow
            dropdown.offsetHeight;
            
            // Get the dropdown's actual rendered height
            const dropdownHeight = dropdown.getBoundingClientRect().height;
            
            // Add margin-bottom to search wrapper to create space for the dropdown
            const marginNeeded = dropdownHeight + 10; // Small buffer
            searchWrapper.style.marginBottom = `${marginNeeded}px`;
        }
    }

    /**
     * Public method to trigger re-rendering
     */
    refresh() {
        const searchText = this.elements.templateSearch ? this.elements.templateSearch.value : '';
        this.renderTemplateOptions(searchText);
    }

    /**
     * Cleanup method
     */
    destroy() {
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
        }
        // Remove event handlers if dropdown is open
        if (this.dropdownOpen) {
            document.removeEventListener('keydown', this.documentEscapeHandler, true);
            const container = document.getElementById('template-select-container');
            if (container) {
                container.removeEventListener('focusout', this.containerFocusOutHandler);
            }
        }
        // Remove outside-click listener if present
        try {
            if (this.outsideClickTarget && this.outsideClickHandler) {
                this.outsideClickTarget.removeEventListener('click', this.outsideClickHandler);
                this.outsideClickTarget = null;
                this.outsideClickHandler = null;
            }
        } catch (_) {}
    }
}
