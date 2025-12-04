/**
 * Session Form Manager Module
 * Handles all form-related functionality for terminal session creation
 * Supports multi-select templates with searchable dropdown
 */

import { apiService } from '../../services/api.service.js';
import { config } from '../../core/config.js';
import { TemplateSearchManager } from './template-search-manager.js';
import { SuggestionsOverlay } from '../../utils/suggestions-overlay.js';
import { FormModal } from '../ui/modal.js';

export class SessionFormManager {
    static INTERACTIVE_HELP_TEXT = {
        INTERACTIVE: 'Users will be able to interact with the session.',
        NON_INTERACTIVE: 'Users will NOT be able to interact with the session.'
    };

    constructor(config = {}) {
        this.availableTemplates = [];
        this.selectedTemplates = [];
        this.forcedInteractiveValue = undefined;
        this.searchableDropdown = null;
        this.promptEditorModal = null;
        this._promptTargetInput = null;
        this._overlays = [];
        this._parameterChangeHandler = null;
        
        this.elements = {
            templateSearch: document.getElementById('template-search'),
            selectedTemplatesContainer: document.getElementById('selected-templates'),
            templateDropdown: document.getElementById('template-dropdown'),
            templateDescription: document.getElementById('template-description'),
            templateParameters: document.getElementById('template-parameters'),
            interactiveGroup: document.getElementById('interactive-group'),
            sessionInteractive: document.getElementById('session-interactive')
        };

        this.setupEventListeners();
        this.initializeTemplateSearch();
        this.initializePromptEditorModal();

        // Internal: headless parameter defaults for quick-create flows
        this._headlessDefaultParams = null; // Map<templateId, { paramName: value }>
    }

    initializeTemplateSearch() {
        this.templateSearchManager = new TemplateSearchManager({
            elements: this.elements,
            availableTemplates: this.availableTemplates,
            selectedTemplates: this.selectedTemplates,
            onSelectionChange: (selectedTemplates) => this.handleSelectionChange(selectedTemplates),
            onDropdownToggle: (isOpen) => this.handleDropdownToggle(isOpen),
            checkForConflicts: (template) => this.checkForConflicts(template)
        });
    }

    initializePromptEditorModal() {
        try {
            const modalEl = document.getElementById('prompt-editor-modal');
            if (!modalEl) return;
            this.promptEditorModal = new FormModal({
                element: modalEl,
                title: 'Edit Prompt',
                autoClose: true,
                onSubmit: (formData) => {
                    try {
                        const value = formData['prompt-editor-text'] || '';
                        if (this._promptTargetInput) {
                            this._promptTargetInput.value = value;
                            // Bubble input and change events so any listeners update
                            this._promptTargetInput.dispatchEvent(new Event('input', { bubbles: true }));
                            this._promptTargetInput.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    } catch (_) { /* no-op */ }
                }
            });

            // While the Prompt Editor is open, hide the underlying New Session modal
            try {
                this.promptEditorModal.on('show', () => {
                    const parent = document.getElementById('new-session-modal');
                    if (parent) parent.classList.add('temporarily-hidden');
                });
                this.promptEditorModal.on('hide', () => {
                    const parent = document.getElementById('new-session-modal');
                    if (parent) parent.classList.remove('temporarily-hidden');
                    // After closing the Prompt Editor, focus the New Session submit button
                    // so pressing Enter immediately submits the form (Issue #858).
                    try {
                        const submit = document.getElementById('modal-create');
                        // Use a short timeout to allow any focus restoration by the base
                        // modal to complete, then move focus to the primary action.
                        if (submit) {
                            setTimeout(() => { try { submit.focus(); } catch (_) {} }, 0);
                        }
                    } catch (_) { /* ignore */ }
                });
            } catch (_) { /* ignore */ }
        } catch (e) {
            console.warn('Failed to initialize prompt editor modal:', e);
        }
    }

    handleSelectionChange(selectedTemplates) {
        this.selectedTemplates = selectedTemplates;
        this.updateSelectedTemplatesDisplay();
        this.updateParameterForm();
        // Apply default workspace if applicable
        this.applyDefaultWorkspaceFromSelection();
    }

    handleDropdownToggle(isOpen) {
        // Handle any dropdown state changes if needed
    }

    applyDefaultWorkspaceFromSelection() {
        try {
            if (!Array.isArray(this.selectedTemplates)) return;
            if (this.selectedTemplates.length !== 1) return; // Only when a single template is selected
            const tmpl = this.selectedTemplates[0];
            const dwRaw = (tmpl && typeof tmpl.default_workspace === 'string') ? tmpl.default_workspace.trim() : '';
            if (!dwRaw) return;
            const select = document.getElementById('session-workspace-select');
            if (!select) return;
            const normalizedValue = dwRaw.toLowerCase() === 'default' ? '' : dwRaw;
            // Add option if not present (skip default placeholder which already exists)
            if (normalizedValue !== '' && !Array.from(select.options).some(o => o.value === normalizedValue)) {
                const opt = document.createElement('option');
                opt.value = normalizedValue;
                opt.textContent = dwRaw;
                select.appendChild(opt);
            }
            select.value = normalizedValue;
        } catch (e) {
            console.warn('Failed to set default workspace from template:', e);
        }
    }

    setupEventListeners() {
        // No additional event listeners needed - template search manager handles its own
    }

    async loadTemplates() {
        try {
            const response = await apiService.getTemplates();
            this.availableTemplates = response.templates || [];

            // Inject synthetic "Local Shell" template (frontend-only) as a sentinel when available
            try {
                const canLocal = !!(window.desktop && window.desktop.isElectron && window.desktop.localpty);
                if (canLocal) {
                    const hasLocal = Array.isArray(this.availableTemplates) && this.availableTemplates.some(t => t && t.isLocal === true);
                    if (!hasLocal) {
                        const localTemplate = {
                            id: 'local-shell',
                            name: 'Local Shell',
                            description: 'Open a shell on this machine',
                            group: 'Local',
                            isLocal: true,
                            display: true,
                            // Ensure selection is single-only via conflicts logic
                            interactive: { value: true },
                            aria_label: 'Local Shell template'
                        };
                        // Prepend so it appears first; TemplateSearchManager will render it before groups
                        this.availableTemplates = [localTemplate, ...this.availableTemplates];
                    }
                }
            } catch (injectError) {
                console.warn('[SessionFormManager] Failed to inject Local Shell template:', injectError);
            }

            this.populateTemplateDropdown();
            // Update the template search manager with new templates
            if (this.templateSearchManager) {
                this.templateSearchManager.updateTemplates(this.availableTemplates);
            }
            this.updateSubmissionState();
        } catch (error) {
            console.error('Failed to load templates:', error);
            this.availableTemplates = [];
            this.updateSubmissionState();
        }
    }

    populateTemplateDropdown() {
        if (this.templateSearchManager) {
            this.templateSearchManager.renderTemplateOptions();
        }
    }

    checkForConflicts(newTemplate) {
        // Synthetic Local Shell cannot be combined with any other template
        try {
            if (newTemplate && newTemplate.isLocal === true) {
                return this.selectedTemplates && this.selectedTemplates.length > 0;
            }
            if (Array.isArray(this.selectedTemplates) && this.selectedTemplates.some(t => t && t.isLocal === true)) {
                return true;
            }
        } catch (_) { /* ignore */ }

        // Check for parameter conflicts
        for (const selectedTemplate of this.selectedTemplates) {
            if (this.hasParameterConflict(selectedTemplate, newTemplate)) {
                return true;
            }
        }

        return false;
    }

    hasParameterConflict(template1, template2) {
        if (!template1.parameters || !template2.parameters) {
            return false;
        }

        const params1 = template1.parameters.filter(p => p.display !== false);
        const params2 = template2.parameters.filter(p => p.display !== false);

        for (const param1 of params1) {
            for (const param2 of params2) {
                if (param1.name === param2.name) {
                    // Check if they have different forced values
                    if (param1.value !== undefined && param2.value !== undefined && param1.value !== param2.value) {
                        return true;
                    }
                    // Check if one is required with a specific value and the other has a different default
                    if (param1.required && param2.required && param1.default !== param2.default) {
                        return true;
                    }
                }
            }
        }

        // Check interactive conflicts
        if (template1.interactive && template2.interactive) {
            if (template1.interactive.value !== undefined && 
                template2.interactive.value !== undefined && 
                template1.interactive.value !== template2.interactive.value) {
                return true;
            }
        }

        return false;
    }

    updateSelectedTemplatesDisplay() {
        if (!this.elements.selectedTemplatesContainer) return;
        
        this.elements.selectedTemplatesContainer.innerHTML = '';

        this.selectedTemplates.forEach(template => {
            const tag = document.createElement('div');
            tag.className = 'selected-template-tag';

            const name = document.createElement('span');
            name.textContent = template.name;
            tag.appendChild(name);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-tag';
            removeBtn.innerHTML = '×';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.templateSearchManager) {
                    this.templateSearchManager.toggleTemplate(template);
                }
            });
            tag.appendChild(removeBtn);

            this.elements.selectedTemplatesContainer.appendChild(tag);
        });

        // Update description with helpful hints
        if (this.elements.templateDescription) {
            if (this.selectedTemplates.length === 0) {
                this.elements.templateDescription.textContent = 'Click to select one template, Shift+click or long-press for multiple';
            } else if (this.selectedTemplates.length === 1) {
                const t = this.selectedTemplates[0] || {};
                const description = t.description || '';
                if (t.isLocal === true) {
                    const hint = description ? ' • Cannot be combined with other templates' : 'Local Shell cannot be combined with other templates';
                    this.elements.templateDescription.textContent = description ? (description + hint) : hint;
                } else {
                    const hint = description ? ` • Shift+click or long-press for multiple selection` : 'Shift+click or long-press other templates for multiple selection';
                    this.elements.templateDescription.textContent = description + hint;
                }
            } else {
                this.elements.templateDescription.textContent = `${this.selectedTemplates.length} templates selected • Click to select one, Shift+click or long-press to add more`;
            }
        }
        
        // Reload the searchable dropdown with new options
        if (this.searchableDropdown) {
            this.searchableDropdown.loadOptions();
        }
    }


    updateParameterForm() {
        const container = this.elements.templateParameters;
        if (!container) return;
        
        container.innerHTML = '';

        // No custom command path; if nothing selected, parameters remain empty
        if (this.selectedTemplates.length === 0) {
            if (this.elements.interactiveGroup) {
                this.elements.interactiveGroup.style.display = 'block';
            }
            this.updateInteractiveControls();
            return;
        }

        // Isolation selector (single template only)
        try {
            this._currentAllowedIsolationModes = undefined;
            this._currentDefaultIsolationMode = undefined;
            if (this.selectedTemplates.length === 1) {
                const tpl = this.selectedTemplates[0] || {};
                const all = ['none','directory','container'];
                const allowed = (Array.isArray(tpl.isolation_modes) && tpl.isolation_modes.length)
                    ? tpl.isolation_modes.map(s => String(s).toLowerCase()).filter(s => all.includes(s))
                    : all.slice();
                // Default selection uses template.isolation when present and allowed; otherwise first allowed
                let defIso = (typeof tpl.isolation === 'string' && tpl.isolation) ? String(tpl.isolation).toLowerCase() : 'none';
                if (!allowed.includes(defIso)) defIso = allowed[0] || 'none';
                this._currentAllowedIsolationModes = allowed.slice();
                this._currentDefaultIsolationMode = defIso;

                if (allowed.length > 1) {
                    const group = document.createElement('div');
                    group.className = 'form-group';
                    const label = document.createElement('label');
                    label.className = 'form-label';
                    label.setAttribute('for', 'session-isolation-select');
                    label.textContent = 'Isolation';
                    const select = document.createElement('select');
                    select.id = 'session-isolation-select';
                    select.name = 'isolation_mode';
                    const mk = (val, text) => { const o = document.createElement('option'); o.value = val; o.textContent = text; return o; };
                    const labelFor = (m) => (m === 'container' ? 'Container' : (m === 'directory' ? 'Directory' : 'None'));
                    allowed.forEach(m => select.appendChild(mk(m, labelFor(m))));
                    select.value = defIso;
                    group.appendChild(label);
                    group.appendChild(select);
                    container.appendChild(group);
                }
                // When only one allowed mode, hide selector and auto-apply later in buildSessionRequests
            }
        } catch (_) { /* ignore */ }

        // Collect all unique parameters from selected templates
        const parameterMap = new Map();
        
        this.selectedTemplates.forEach(template => {
            if (template.parameters) {
                template.parameters.forEach(param => {
                    if (param.display !== false) {
                        if (!parameterMap.has(param.name)) {
                            parameterMap.set(param.name, {
                                ...param,
                                templates: [template.id]
                            });
                        } else {
                            // Merge parameter definitions
                            const existing = parameterMap.get(param.name);
                            existing.templates.push(template.id);
                            // Use the most restrictive settings
                            if (param.required) {
                                existing.required = true;
                            }
                            if (param.value !== undefined) {
                                existing.value = param.value;
                            }
                        }
                    }
                });
            }
        });

        // Generate form fields for all parameters
        parameterMap.forEach((param, paramName) => {
            const formGroup = document.createElement('div');
            formGroup.className = 'form-group';

            let input;
            let label; // only used for non-boolean, or as the inline label in checkbox wrapper
            if (param.type === 'boolean') {
                // Render as a left-aligned checkbox like the Interactive control
                const wrapper = document.createElement('div');
                wrapper.className = 'checkbox-wrapper';
                input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = param.default !== undefined ? param.default : false;
                // Assign id early so label can reference it
                input.id = `template-param-${param.name}`;
                input.name = param.name;
                input.required = param.required || false;
                input.dataset.templates = JSON.stringify(param.templates);
                wrapper.appendChild(input);
                // Inline label to the right of checkbox
                const inlineLabel = document.createElement('label');
                inlineLabel.setAttribute('for', input.id);
                inlineLabel.textContent = param.label;
                // Append required star and template count to inline label
                if (param.required) {
                    const required = document.createElement('span');
                    required.className = 'template-parameter-required';
                    required.textContent = ' *';
                    inlineLabel.appendChild(required);
                }
                if (param.templates.length < this.selectedTemplates.length) {
                    const templatesText = document.createElement('span');
                    templatesText.style.fontSize = '0.8rem';
                    templatesText.style.color = 'var(--text-dim)';
                    templatesText.style.marginLeft = '0.5rem';
                    templatesText.textContent = `(${param.templates.length} template${param.templates.length > 1 ? 's' : ''})`;
                    inlineLabel.appendChild(templatesText);
                }
                wrapper.appendChild(inlineLabel);
                formGroup.appendChild(wrapper);
            } else {
                // Non-boolean, non-select: show a block label above the input
                label = document.createElement('label');
                label.textContent = param.label;
                if (param.required) {
                    const required = document.createElement('span');
                    required.className = 'template-parameter-required';
                    required.textContent = ' *';
                    label.appendChild(required);
                }
                // Show which templates use this parameter
                if (param.templates.length < this.selectedTemplates.length) {
                    const templatesText = document.createElement('span');
                    templatesText.style.fontSize = '0.8rem';
                    templatesText.style.color = 'var(--text-dim)';
                    templatesText.style.marginLeft = '0.5rem';
                    templatesText.textContent = `(${param.templates.length} template${param.templates.length > 1 ? 's' : ''})`;
                    label.appendChild(templatesText);
                }
                formGroup.appendChild(label);

                input = document.createElement('input');
                input.type = param.type === 'number' ? 'number' : 'text';
                input.placeholder = param.placeholder || '';
                // Suppress browser autofill/recents for better custom suggestions UX
                try { input.setAttribute('autocomplete', 'off'); } catch (_) {}
                try { input.setAttribute('autocapitalize', 'none'); } catch (_) {}
                try { input.setAttribute('autocorrect', 'off'); } catch (_) {}
                try { input.setAttribute('spellcheck', 'false'); } catch (_) {}
                // Respect explicit non-empty defaults only. Treat undefined/null/empty-string as no default.
                if (param.default !== undefined && param.default !== null && String(param.default).trim() !== '') {
                    input.value = param.default;
                }
            }

            // For boolean, we already appended inside wrapper
            if (param.type !== 'boolean') {
                input.id = `template-param-${param.name}`;
                input.name = param.name;
                input.required = param.required || false;
                input.dataset.templates = JSON.stringify(param.templates);

                // If this is the common "prompt" field, render an Edit button that opens a large textarea modal
                if (String(param.name).toLowerCase() === 'prompt') {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'input-with-action';

                    // Keep the input flexible
                    input.classList.add('input-with-action-field');
                    wrapper.appendChild(input);

                    const editBtn = document.createElement('button');
                    editBtn.type = 'button';
                    editBtn.className = 'btn btn-secondary btn-inline';
                    // Avoid duplicate IDs; no static id required
                    editBtn.title = 'Open large prompt editor';
                    editBtn.setAttribute('aria-label', 'Open large text editor for prompt');
                    editBtn.textContent = 'Edit…';
                    editBtn.addEventListener('click', () => {
                        try {
                            if (!this.promptEditorModal) this.initializePromptEditorModal();
                            if (!this.promptEditorModal) return;
                            this._promptTargetInput = input;
                            this.promptEditorModal.setFieldValue('prompt-editor-text', input.value || '');
                            this.promptEditorModal.show();
                        } catch (_) { /* ignore */ }
                    });
                    wrapper.appendChild(editBtn);

                    formGroup.appendChild(wrapper);
                } else {
                    // For text/select inputs with dynamic/static suggestions, attach reusable overlay
                    if ((param.has_dynamic_options === true) || (param.type === 'select')) {
                        try {
                            if (param.has_dynamic_options === true) input.dataset.dynamic = 'true';
                            try {
                                const deps = Array.isArray(param.depends_on) ? param.depends_on : [];
                                input.dataset.dependsOn = JSON.stringify(deps);
                            } catch (_) {}
                            formGroup.appendChild(input);
                            const templateId = (Array.isArray(param.templates) && param.templates.length) ? param.templates[0] : null;
                            const getOptions = async () => {
                                if (param.has_dynamic_options === true && templateId) {
                                    const vars = this.collectCurrentParameterValues();
                                    const resp = await apiService.getParameterOptionsWithVariables(templateId, param.name, vars);
                                    return Array.isArray(resp?.options) ? resp.options : [];
                                }
                                if (Array.isArray(param.options)) return param.options.map(o => ({ value: o.value, label: o.label }));
                                return [];
                            };
                            const overlayComp = new SuggestionsOverlay(input, { getOptions, openOnFocus: true, filterWhileTyping: true });
                            input._overlayRef = overlayComp;
                            this._overlays.push(overlayComp);

                            // Auto-select first option when appropriate:
                            // - parameter is required
                            // - input currently has no value (no explicit default provided)
                            // - options list is non-empty
                            // - for dynamic options, happens with current variable state
                            try {
                                const shouldAutoselect = !!input.required && String(input.value || '').trim() === '';
                                if (shouldAutoselect) {
                                    Promise.resolve(getOptions()).then((opts) => {
                                        try {
                                            const options = Array.isArray(opts) ? opts : [];
                                            if (options.length > 0 && String(input.value || '').trim() === '') {
                                                const first = options[0] && (options[0].value ?? options[0].label);
                                                if (first !== undefined) {
                                                    try { input.dataset.suppressNextOverlayOpen = '1'; } catch (_) {}
                                                    try { input.dataset.suppressNextFocusOpen = '1'; } catch (_) {}
                                                    input.value = String(first);
                                                    input.dispatchEvent(new Event('input', { bubbles: true }));
                                                    input.dispatchEvent(new Event('change', { bubbles: true }));
                                                }
                                            }
                                        } catch (_) { /* ignore */ }
                                    }).catch(() => {});
                                }
                            } catch (_) { /* ignore */ }
                        } catch (_) {
                            formGroup.appendChild(input);
                        }
                    } else {
                        formGroup.appendChild(input);
                    }
                }
            }

            if (param.description) {
                const help = document.createElement('small');
                help.className = 'form-help';
                help.textContent = param.description;
                formGroup.appendChild(help);
            }

            container.appendChild(formGroup);

            // Hide container_image when isolation != 'container'
            try {
                if (paramName === 'container_image' && this.selectedTemplates.length === 1) {
                    const iso = document.getElementById('session-isolation-select');
                    let currentIsContainer = false;
                    if (iso) {
                        currentIsContainer = (iso.value === 'container');
                    } else {
                        // No selector shown (single allowed mode) — use default
                        const defIso = this._currentDefaultIsolationMode || 'none';
                        currentIsContainer = (defIso === 'container');
                    }
                    if (!currentIsContainer) formGroup.style.display = 'none';
                    if (iso) {
                        iso.addEventListener('change', () => {
                            formGroup.style.display = (iso.value === 'container') ? '' : 'none';
                        });
                    }
                }
            } catch (_) { /* ignore */ }

            // No-op: select handled as text+overlay; dynamic/static suggestions managed above
        });

        // Generic: re-load dynamic suggestion overlays whenever any parameter value changes
        try {
            // Avoid stacking multiple listeners when the parameter form is rebuilt
            if (this._parameterChangeHandler) {
                try { container.removeEventListener('change', this._parameterChangeHandler); } catch (_) {}
            }
            this._parameterChangeHandler = async (e) => {
                const variables = this.collectCurrentParameterValues();

                // Update custom dynamic suggestion overlays for text inputs without datalist
                const dynamicSuggestInputs = container.querySelectorAll('input[data-dynamic="true"]:not([list])');
                dynamicSuggestInputs.forEach(async (inp) => {
                    if (inp === e.target || inp.name === e.target.name) return;
                    try {
                        const changed = e.target.name;
                        const dependsOn = JSON.parse(inp.dataset.dependsOn || '[]');
                        if (!(Array.isArray(dependsOn) && dependsOn.includes(changed))) return;
                    } catch (_) { return; }
                    const overlayComp = inp._overlayRef || null;
                    const templates = inp.dataset.templates ? JSON.parse(inp.dataset.templates) : [];
                    const templateId = Array.isArray(templates) && templates.length ? templates[0] : null;
                    if (!templateId) return;
                    try {
                        const vars = variables;
                        const response = await apiService.getParameterOptionsWithVariables(templateId, inp.name, vars);
                        const items = Array.isArray(response?.options) ? response.options : [];
                        if (overlayComp && typeof overlayComp.setOptions === 'function') {
                            overlayComp.setOptions(items);
                        }
                        // If this dependent input is required and empty, auto-select the first available option
                        try {
                            const needsValue = !!inp.required && String(inp.value || '').trim() === '';
                            const opts = items;
                            if (needsValue && opts.length > 0) {
                                const first = opts[0] && (opts[0].value ?? opts[0].label);
                                if (first !== undefined) {
                                    try { inp.dataset.suppressNextOverlayOpen = '1'; } catch (_) {}
                                    try { inp.dataset.suppressNextFocusOpen = '1'; } catch (_) {}
                                    inp.value = String(first);
                                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                            }
                        } catch (_) { /* ignore */ }
                    } catch (_) {
                        // ignore
                    }
                });
            };
            container.addEventListener('change', this._parameterChangeHandler);
        } catch (e) {
            console.warn('Failed to set up generic dynamic loader:', e);
        }

        this.updateInteractiveControls();
    }

    // Deprecated: select inputs are handled via text+overlay component

    updateInteractiveControls() {
        if (!this.elements.interactiveGroup) return;
        
        // Check if any selected template forces interactive value
        let forcedValue = undefined;
        let hasConflict = false;

        this.selectedTemplates.forEach(template => {
            if (template.interactive && template.interactive.value !== undefined) {
                if (forcedValue !== undefined && forcedValue !== template.interactive.value) {
                    hasConflict = true;
                }
                forcedValue = template.interactive.value;
            }
        });

        this.elements.interactiveGroup.style.display = 'block';
        const checkboxWrapper = this.elements.interactiveGroup.querySelector('.checkbox-wrapper');
        const helpElement = document.getElementById('interactive-help');
        
        if (!checkboxWrapper) return;
        
        if (forcedValue !== undefined && !hasConflict) {
            checkboxWrapper.innerHTML = `<span class="form-label">Interactive</span>`;
            
            if (forcedValue) {
                helpElement.textContent = SessionFormManager.INTERACTIVE_HELP_TEXT.INTERACTIVE;
            } else {
                helpElement.textContent = SessionFormManager.INTERACTIVE_HELP_TEXT.NON_INTERACTIVE;
            }
            
            this.forcedInteractiveValue = forcedValue;
        } else {
            checkboxWrapper.innerHTML = `
                <input type="checkbox" id="session-interactive" checked>
                <label for="session-interactive">Interactive</label>
            `;
            
            this.elements.sessionInteractive = document.getElementById('session-interactive');
            
            this.updateInteractiveHelpText();
            
            this.elements.sessionInteractive.addEventListener('change', () => {
                this.updateInteractiveHelpText();
            });
            
            this.forcedInteractiveValue = undefined;
        }
    }

    updateInteractiveHelpText() {
        const helpElement = document.getElementById('interactive-help');
        if (this.elements.sessionInteractive && helpElement) {
            if (this.elements.sessionInteractive.checked) {
                helpElement.textContent = SessionFormManager.INTERACTIVE_HELP_TEXT.INTERACTIVE;
            } else {
                helpElement.textContent = SessionFormManager.INTERACTIVE_HELP_TEXT.NON_INTERACTIVE;
            }
        }
    }

    collectCurrentParameterValues() {
        const vars = {};
        const container = this.elements.templateParameters;
        if (!container) return vars;
        const inputs = container.querySelectorAll('[id^="template-param-"]');
        inputs.forEach(input => {
            const name = input.name;
            if (!name) return;
            if (input.type === 'checkbox') {
                vars[name] = input.checked;
            } else {
                vars[name] = input.value || '';
            }
        });
        return vars;
    }

    

    collectTemplateParameters() {
        const parametersByTemplate = {};
        
        // Collect all parameter values
        const allParameters = {};
        const paramInputs = this.elements.templateParameters.querySelectorAll('[id^="template-param-"]');
        
        paramInputs.forEach(input => {
            const paramName = input.name;
            const templates = JSON.parse(input.dataset.templates || '[]');
            
            let value;
            if (input.type === 'checkbox') {
                value = input.checked;
            } else if (input.type === 'number') {
                value = input.value ? parseFloat(input.value) : null;
            } else {
                value = input.value || null;
            }
            
            // Add this parameter value to each template that uses it
            templates.forEach(templateId => {
                if (!parametersByTemplate[templateId]) {
                    parametersByTemplate[templateId] = {};
                }
                if (value !== null) {
                    parametersByTemplate[templateId][paramName] = value;
                }
            });
        });

        return parametersByTemplate;
    }

    validateForm(formData) {
        // Disallow submission when no templates are available
        if (!Array.isArray(this.availableTemplates) || this.availableTemplates.length === 0) {
            // Surface a helpful message in the description area
            if (this.elements.templateDescription) {
                this.elements.templateDescription.textContent = 'No templates are available for your account. Please contact an administrator.';
            }
            // Also defensively disable the submit button
            const submitBtn = document.getElementById('modal-create');
            if (submitBtn) submitBtn.disabled = true;
            return false;
        }
        // Validate required parameters
        const paramInputs = this.elements.templateParameters.querySelectorAll('[required]');
        for (const input of paramInputs) {
            if (input.type === 'checkbox') {
                continue; // Checkboxes are always valid
            }
            if (!input.value || input.value.trim() === '') {
                input.focus();
                return false;
            }
        }
        return true;
    }

    updateSubmissionState() {
        try {
            const submitBtn = document.getElementById('modal-create');
            const hasTemplates = Array.isArray(this.availableTemplates) && this.availableTemplates.length > 0;
            if (submitBtn) submitBtn.disabled = !hasTemplates;
            if (!hasTemplates && this.elements.templateDescription) {
                this.elements.templateDescription.textContent = 'No templates are available for your account. Please contact an administrator.';
            }
        } catch (_) {}
    }

    getInteractiveValue() {
        if (this.forcedInteractiveValue !== undefined) {
            return this.forcedInteractiveValue;
        } else if (this.elements.sessionInteractive) {
            return this.elements.sessionInteractive.checked;
        } else {
            return true;
        }
    }

    buildFormData(clientId, terminalSize) {
        const formData = {
            title: document.getElementById('session-title').value.trim() || null,
            cols: terminalSize.cols,
            rows: terminalSize.rows,
            interactive: this.getInteractiveValue(),
            visibility: (() => {
                const el = document.getElementById('session-visibility');
                const val = el ? el.value : 'private';
                return val || 'private';
            })(),
            workspace: (() => {
                const select = document.getElementById('session-workspace-select');
                if (select) {
                    const val = select.value || '';
                    return val.trim() || 'Default';
                }
                const input = document.getElementById('session-workspace');
                return (input?.value || 'Default').trim() || 'Default';
            })()
        };

        // No custom command path; ensure at least one real template (exclude synthetic Local Shell)
        let selected = this.selectedTemplates;
        if (!Array.isArray(selected) || selected.length === 0) {
            const realTemplates = (this.availableTemplates || []).filter(t => t && t.isLocal !== true);
            const defaultTpl = realTemplates.find(t => t && t.default === true && t.display !== false);
            const fallback = defaultTpl || (realTemplates.length > 0 ? realTemplates[0] : null);
            selected = fallback ? [fallback] : [];
        }

        // Handle multiple templates - create a session request for each
        const sessionRequests = [];
        const parametersByTemplate = this.collectTemplateParameters();
        selected.forEach(template => {
            // Merge headless defaults (used by quick-create without opening the modal)
            const headless = (this._headlessDefaultParams && this._headlessDefaultParams[template.id]) || null;
            const mergedParams = { ...(headless || {}), ...(parametersByTemplate[template.id] || {}) };
            const sessionData = {
                ...formData,
                template_id: template.id,
                template_parameters: mergedParams
            };

            // Include isolation override when present (single template)
            try {
                const iso = document.getElementById('session-isolation-select');
                if (iso && iso.value) {
                    sessionData.isolation_mode = iso.value;
                } else if (Array.isArray(template.isolation_modes) && template.isolation_modes.length === 1) {
                    // Auto-apply single allowed mode when selector hidden
                    sessionData.isolation_mode = String(template.isolation_modes[0]).toLowerCase();
                }
            } catch (_) {}
            
            // Override interactive if template forces it
            if (template.interactive && template.interactive.value !== undefined) {
                sessionData.interactive = template.interactive.value;
            }
            
            sessionRequests.push(sessionData);
        });

        return sessionRequests;
    }

    resetForm() {
        this.selectedTemplates = [];
        this.forcedInteractiveValue = undefined;
        
        if (this.elements.templateSearch) {
            this.elements.templateSearch.value = '';
        }
        
        // Update template search manager
        if (this.templateSearchManager) {
            this.templateSearchManager.updateSelection([]);
            this.templateSearchManager.refresh();
        }
        
        this.updateSelectedTemplatesDisplay();
        
        if (this.elements.templateParameters) {
            this.elements.templateParameters.innerHTML = '';
        }
        
        this.updateInteractiveControls();

        // Reset visibility to default (private)
        try {
            const sel = document.getElementById('session-visibility');
            if (sel) sel.value = 'private';
        } catch (_) {}
    }

    /**
     * Cleanup method to destroy the template search manager
     */
    destroy() {
        if (this.templateSearchManager) {
            this.templateSearchManager.destroy();
        }
        try { (this._overlays || []).forEach(o => { try { o.destroy(); } catch(_) {} }); } catch(_) {}
        this._overlays = [];
    }

    clearErrors() {
        const errorElements = document.querySelectorAll('.error-message');
        errorElements.forEach(element => element.remove());
        
        const fieldElements = document.querySelectorAll('.form-field-error');
        fieldElements.forEach(element => element.classList.remove('form-field-error'));
    }
}

// Headless default resolution helpers
SessionFormManager.prototype.computeHeadlessDefaultsForTemplates = async function(selectedTemplates) {
    try {
        const list = Array.isArray(selectedTemplates) ? selectedTemplates : (Array.isArray(this.selectedTemplates) ? this.selectedTemplates : []);
        const out = {};
        for (const tpl of list) {
            if (!tpl || tpl.isLocal === true) continue;
            const pdefs = Array.isArray(tpl.parameters) ? tpl.parameters : [];
            const vars = {};
            // Seed with explicit defaults and constant values
            for (const p of pdefs) {
                if (!p || !p.name) continue;
                if (Object.prototype.hasOwnProperty.call(p, 'value')) {
                    vars[p.name] = p.value;
                } else if (Object.prototype.hasOwnProperty.call(p, 'default')) {
                    // Allow boolean, number, and string defaults
                    vars[p.name] = p.default;
                }
            }
            // For dynamic selects on REQUIRED parameters, fetch options and prefer first entry when no value present
            // Do not auto-select for optional parameters (e.g., Sandbox repo) to avoid unintended defaults
            for (const p of pdefs) {
                if (!p || p.type !== 'select' || p.has_dynamic_options !== true) continue;
                if (p.required !== true) continue; // only resolve defaults for required selects
                const cur = vars[p.name];
                const hasVal = Object.prototype.hasOwnProperty.call(vars, p.name)
                    && !(cur === undefined || cur === null || (typeof cur === 'string' && cur.trim() === ''));
                if (hasVal) continue;
                try {
                    const resp = await apiService.getParameterOptionsWithVariables(tpl.id, p.name, vars);
                    const opts = Array.isArray(resp?.options) ? resp.options : [];
                    if (opts.length > 0) {
                        vars[p.name] = opts[0].value;
                    }
                } catch (e) {
                    // Non-fatal: leave unset
                }
            }
            out[tpl.id] = vars;
        }
        this._headlessDefaultParams = out;
        return out;
    } catch (_) {
        this._headlessDefaultParams = this._headlessDefaultParams || null;
        return this._headlessDefaultParams || {};
    }
};
