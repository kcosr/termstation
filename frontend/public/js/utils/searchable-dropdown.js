/**
 * Searchable Dropdown Component
 * Provides search and multi-select functionality for dropdowns
 */

export class SearchableDropdown {
    constructor(selectElement, options = {}) {
        this.selectElement = selectElement;
        this.options = {
            multiSelect: options.multiSelect || false,
            searchPlaceholder: options.searchPlaceholder || 'Search...',
            onSelect: options.onSelect || (() => {}),
            onMultiSelect: options.onMultiSelect || (() => {}),
            ...options
        };
        
        this.isOpen = false;
        this.selectedIndex = 0;
        this.selectedItems = new Set();
        this.filteredOptions = [];
        
        this.init();
    }
    
    init() {
        // Hide original select
        this.selectElement.style.display = 'none';
        
        // Create wrapper
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'searchable-dropdown';
        this.selectElement.parentNode.insertBefore(this.wrapper, this.selectElement);
        
        // Create display element
        this.display = document.createElement('div');
        this.display.className = 'searchable-dropdown-display';
        this.display.tabIndex = 0;
        this.updateDisplay();
        this.wrapper.appendChild(this.display);
        
        // Create dropdown container
        this.dropdown = document.createElement('div');
        this.dropdown.className = 'searchable-dropdown-menu';
        this.dropdown.style.display = 'none';
        this.wrapper.appendChild(this.dropdown);
        
        // Create search input
        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.className = 'searchable-dropdown-search';
        this.searchInput.placeholder = this.options.searchPlaceholder;
        this.dropdown.appendChild(this.searchInput);
        
        // Create options list
        this.optionsList = document.createElement('div');
        this.optionsList.className = 'searchable-dropdown-options';
        this.dropdown.appendChild(this.optionsList);
        
        this.loadOptions();
        this.attachEventListeners();
    }
    
    loadOptions() {
        this.allOptions = Array.from(this.selectElement.options).map((option, index) => ({
            value: option.value,
            text: option.text,
            index: index,
            selected: option.selected
        }));
        
        if (this.options.multiSelect) {
            this.allOptions.forEach(opt => {
                if (opt.selected) {
                    this.selectedItems.add(opt.index);
                }
            });
        }
        
        this.filteredOptions = [...this.allOptions];
        this.renderOptions();
    }
    
    renderOptions() {
        this.optionsList.innerHTML = '';
        
        this.filteredOptions.forEach((option, filteredIndex) => {
            const optionElement = document.createElement('div');
            optionElement.className = 'searchable-dropdown-option';
            optionElement.dataset.index = option.index;
            optionElement.dataset.filteredIndex = filteredIndex;
            
            if (this.options.multiSelect) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = this.selectedItems.has(option.index);
                checkbox.className = 'searchable-dropdown-checkbox';
                optionElement.appendChild(checkbox);
            }
            
            const text = document.createElement('span');
            text.textContent = option.text;
            optionElement.appendChild(text);
            
            if (filteredIndex === this.selectedIndex) {
                optionElement.classList.add('highlighted');
            }
            
            if (this.selectedItems.has(option.index)) {
                optionElement.classList.add('selected');
            }
            
            this.optionsList.appendChild(optionElement);
        });
    }
    
    attachEventListeners() {
        // Display click to toggle
        this.display.addEventListener('click', () => this.toggle());
        
        // Display keyboard navigation
        this.display.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.toggle();
            } else if (e.key === 'ArrowDown' && !this.isOpen) {
                e.preventDefault();
                this.open();
            }
        });
        
        // Search input events
        this.searchInput.addEventListener('input', () => this.handleSearch());
        
        // Search input keyboard navigation - this is the key part for the fix
        this.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.moveSelection(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.moveSelection(-1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey && this.options.multiSelect) {
                    // IMPORTANT: Don't reset selectedIndex on shift+enter
                    this.toggleMultiSelect(this.selectedIndex);
                } else {
                    this.selectOption(this.selectedIndex);
                    this.close();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });
        
        // Option click
        this.optionsList.addEventListener('click', (e) => {
            const optionElement = e.target.closest('.searchable-dropdown-option');
            if (optionElement) {
                const filteredIndex = parseInt(optionElement.dataset.filteredIndex);
                if (this.options.multiSelect && (e.shiftKey || e.target.classList.contains('searchable-dropdown-checkbox'))) {
                    this.toggleMultiSelect(filteredIndex);
                } else {
                    this.selectOption(filteredIndex);
                    this.close();
                }
            }
        });
        
        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!this.wrapper.contains(e.target)) {
                this.close();
            }
        });
    }
    
    handleSearch() {
        const searchTerm = this.searchInput.value.toLowerCase();
        
        if (searchTerm === '') {
            this.filteredOptions = [...this.allOptions];
        } else {
            this.filteredOptions = this.allOptions.filter(option => 
                option.text.toLowerCase().includes(searchTerm)
            );
        }
        
        // Maintain selected index within bounds
        if (this.selectedIndex >= this.filteredOptions.length) {
            this.selectedIndex = Math.max(0, this.filteredOptions.length - 1);
        }
        
        this.renderOptions();
    }
    
    moveSelection(direction) {
        const newIndex = this.selectedIndex + direction;
        
        if (newIndex >= 0 && newIndex < this.filteredOptions.length) {
            this.selectedIndex = newIndex;
            this.renderOptions();
            this.scrollToSelected();
        }
    }
    
    scrollToSelected() {
        const selectedElement = this.optionsList.querySelector(`[data-filtered-index="${this.selectedIndex}"]`);
        if (selectedElement) {
            selectedElement.scrollIntoView({ block: 'nearest' });
        }
    }
    
    selectOption(filteredIndex) {
        if (filteredIndex < 0 || filteredIndex >= this.filteredOptions.length) {
            return;
        }
        
        const option = this.filteredOptions[filteredIndex];
        this.selectElement.value = option.value;
        this.selectElement.dispatchEvent(new Event('change'));
        
        if (!this.options.multiSelect) {
            this.selectedItems.clear();
            this.selectedItems.add(option.index);
        }
        
        this.updateDisplay();
        this.options.onSelect(option);
    }
    
    toggleMultiSelect(filteredIndex) {
        if (filteredIndex < 0 || filteredIndex >= this.filteredOptions.length) {
            return;
        }
        
        const option = this.filteredOptions[filteredIndex];
        
        if (this.selectedItems.has(option.index)) {
            this.selectedItems.delete(option.index);
        } else {
            this.selectedItems.add(option.index);
        }
        
        // Update the actual select element
        this.selectElement.options[option.index].selected = this.selectedItems.has(option.index);
        
        this.renderOptions();
        this.updateDisplay();
        this.options.onMultiSelect(Array.from(this.selectedItems).map(i => this.allOptions[i]));
        
        // Keep focus on search input and maintain selected index
        this.searchInput.focus();
    }
    
    updateDisplay() {
        if (this.options.multiSelect) {
            const selected = Array.from(this.selectedItems).map(i => this.allOptions[i].text);
            this.display.textContent = selected.length > 0 ? selected.join(', ') : 'Select items...';
        } else {
            const selectedOption = this.selectElement.options[this.selectElement.selectedIndex];
            this.display.textContent = selectedOption ? selectedOption.text : 'Select...';
        }
    }
    
    open() {
        if (this.isOpen) return;
        
        this.isOpen = true;
        this.dropdown.style.display = 'block';
        this.searchInput.value = '';
        this.handleSearch();
        this.searchInput.focus();
        
        // Set initial selected index based on current selection
        if (!this.options.multiSelect && this.selectElement.selectedIndex >= 0) {
            const currentValue = this.selectElement.value;
            const index = this.filteredOptions.findIndex(opt => opt.value === currentValue);
            if (index >= 0) {
                this.selectedIndex = index;
                this.renderOptions();
            }
        }
    }
    
    close() {
        if (!this.isOpen) return;
        
        this.isOpen = false;
        this.dropdown.style.display = 'none';
        this.display.focus();
    }
    
    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }
    
    destroy() {
        this.wrapper.remove();
        this.selectElement.style.display = '';
    }
}