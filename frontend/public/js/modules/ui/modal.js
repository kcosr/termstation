export class Modal {
    constructor(options = {}) {
        this.element = options.element || null;
        this.title = options.title || '';
        this.closeable = options.closeable !== false;
        this.autoClose = options.autoClose !== false;
        this.focusOnShow = options.focusOnShow !== false;
        this.restoreFocus = options.restoreFocus !== false;
        this.zIndex = options.zIndex || 1000;
        
        this.events = new EventTarget();
        this.isVisible = false;
        this.lastFocusedElement = null;
        
        if (!this.element) {
            throw new Error('Modal element is required');
        }

        this.init();
    }

    // Track visible modals in a simple stack so only the top-most
    // responds to global Escape presses.
    static _visibleStack = [];

    // Debug helpers (enabled when window.TS_DEBUG_MODALS === true or localStorage['ts.debug.modals'] === '1')
    static isDebug() {
        try {
            if (typeof window !== 'undefined') {
                // eslint-disable-next-line no-undef
                return !!(window.TS_DEBUG_MODALS || (window.localStorage && window.localStorage.getItem('ts.debug.modals') === '1'));
            }
        } catch (_) {}
        return false;
    }

    _id() {
        try { return `#${this.element?.id || '(no-id)'}${this.element?.classList?.contains('floating-modal') ? ' (floating)' : ''}`; } catch (_) { return '(modal)'; }
    }

    _log(msg, extra) {
        if (!Modal.isDebug()) return;
        try { console.debug(`[Modal] ${this._id()} ${msg}`, extra || ''); } catch (_) {}
    }
    
    // Determine if this modal is the top-most visible modal
    _isTopMost() {
        try {
            const stack = Modal._visibleStack || [];
            if (stack.length === 0) return true;
            return stack[stack.length - 1] === this;
        } catch (_) {
            return true;
        }
    }
    
    init() {
        this.setupEventListeners();
        this.setupAccessibility();
    }
    
    setupEventListeners() {
        if (this.closeable) {
            this.element.addEventListener('click', (e) => {
                // For floating modals, do NOT treat clicks on the element itself as a backdrop click.
                // Floating modals have no backdrop; closing is via explicit close button.
                const isFloating = this.element.classList?.contains('floating-modal');
                if (isFloating) return;
                if (e.target === this.element) {
                    this._log('backdrop click detected -> hide');
                    this.hide();
                }
            });
        }
        
        // Prevent pointer/click events from propagating to app behind the modal
        // For floating modals (e.g., draggable Send Text), allow 'up' events to bubble
        // so global mouseup/touchend listeners (drag end) can fire.
        const stop = (e) => { if (Modal.isDebug()) this._log(`stopPropagation on ${e.type}`, { target: e.target }); e.stopPropagation(); };
        const isFloating = this.element.classList.contains('floating-modal');
        this.element.addEventListener('click', stop);
        this.element.addEventListener('mousedown', stop);
        this.element.addEventListener('pointerdown', stop);
        this.element.addEventListener('touchstart', stop, { passive: true });
        // Only block 'up' events for non-floating, full-screen modals
        if (!isFloating) {
            this.element.addEventListener('mouseup', stop);
            this.element.addEventListener('pointerup', stop);
            this.element.addEventListener('touchend', stop, { passive: true });
        }
        
        // Global Escape handler: only the top-most visible modal should close
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!this.isVisible) return;
            if (!this._isTopMost()) return;
            // Prevent any other listeners (including other modals' doc listeners)
            // from processing this same Escape press.
            try {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation?.();
            } catch (_) { /* ignore */ }
            this._log('Escape pressed (top-most) -> hide');
            this.hide();
        });

        // Block Enter from reaching app-level listeners while modal is open,
        // without breaking form submission. Handle on the modal element in
        // the bubble phase so form field handlers still fire first.
        this.element.addEventListener('keydown', (e) => {
            if (!this.isVisible) return;
            if (e.key !== 'Enter') return;

            // Always stop propagation so document-level shortcuts don't fire
            e.stopPropagation();

            const tag = (e.target && e.target.tagName || '').toLowerCase();
            const isTextInput = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);

            if (!isTextInput) {
                // Prevent default when Enter is pressed outside inputs to avoid
                // page-level focus/scroll effects, and submit the form if present.
                e.preventDefault();
                const submitBtn = this.element.querySelector('[data-modal-submit]');
                if (submitBtn) {
                    submitBtn.click();
                } else if (this.form) {
                    // Fallback to form submit if submit button is not found
                    this.submit?.();
                }
            }
        });

        // Trap focus with Tab inside the modal while visible
        this.element.addEventListener('keydown', (e) => {
            if (!this.isVisible) return;
            if (e.key !== 'Tab') return;

            const focusable = this.element.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            if (!focusable || focusable.length === 0) {
                e.preventDefault();
                this.element.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];

            if (e.shiftKey) {
                if (document.activeElement === first || !this.element.contains(document.activeElement)) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        });

        // Use event delegation for close buttons to ensure reliability
        // This handles clicks in the capture phase before other handlers can interfere
        this.element.addEventListener('click', (e) => {
            const tgt = e.target;
            const closeBtn = tgt && typeof tgt.closest === 'function' ? tgt.closest('[data-modal-close]') : null;
            if (closeBtn && this.element.contains(closeBtn)) {
                this._log('close button clicked (capture)', { target: tgt, closeBtn });
                // Prevent any default action and stop propagation so nothing can cancel hide()
                e.preventDefault();
                e.stopImmediatePropagation?.();
                e.stopPropagation();
                try { this.hide(); this._log('hide() called from close button'); } catch (err) { this._log('hide() threw', err); }
                return;
            }
        }, true); // capture phase for priority
    }
    
    setupAccessibility() {
        this.element.setAttribute('role', 'dialog');
        this.element.setAttribute('aria-modal', 'true');
        this.element.setAttribute('tabindex', '-1');
        
        if (this.title) {
            const titleElement = this.element.querySelector('[data-modal-title]');
            if (titleElement) {
                titleElement.textContent = this.title;
                this.element.setAttribute('aria-labelledby', titleElement.id || 'modal-title');
            }
        }
    }
    
    show() {
        if (this.isVisible) return;

        this._log('show()');
        this.emit('beforeShow');
        
        if (this.restoreFocus) {
            this.lastFocusedElement = document.activeElement;
        }
        
        this.element.classList.add('show');
        // Only raise z-index; never lower it below CSS-computed value.
        if (!this.element.classList.contains('floating-modal')) {
            try {
                const computed = parseInt(window.getComputedStyle(this.element).zIndex, 10) || 0;
                const desired = Number.isFinite(this.zIndex) ? Number(this.zIndex) : 0;
                if (desired > computed) {
                    this.element.style.zIndex = String(desired);
                } else {
                    // Leave CSS z-index in place to avoid lowering stacking
                    this.element.style.zIndex = '';
                }
            } catch (_) { /* ignore */ }
        }
        this.isVisible = true;
        // Attach capture-phase guards for standard (non-floating) modals
        if (!this.element.classList.contains('floating-modal')) {
            this._attachCaptureGuards();
        }
        // Mark body as having an open modal and prevent background scroll
        try { document.body.classList.add('modal-open'); } catch (_) {}
        try { document.body.style.overflow = 'hidden'; } catch (_) {}
        
        // Push this modal to the top of the visible stack
        try {
            const stack = Modal._visibleStack;
            const idx = stack.indexOf(this);
            if (idx !== -1) stack.splice(idx, 1);
            stack.push(this);
        } catch (_) { /* ignore */ }

        if (this.focusOnShow) {
            setTimeout(() => {
                this.focusFirstElement();
            }, 100);
        }
        
        this.emit('show');
        this._log('shown');
    }
    
    hide() {
        if (!this.isVisible) return;

        this._log('hide()');
        this.emit('beforeHide');
        
        this.element.classList.remove('show');
        this.isVisible = false;
        // Remove capture-phase guards
        this._detachCaptureGuards();
        
        if (this.restoreFocus && this.lastFocusedElement) {
            this.lastFocusedElement.focus();
            this.lastFocusedElement = null;
        }
        // Clear global modal-open flag if no other modals are visible
        try {
            const anyVisible = document.querySelector('.modal.show, .floating-modal.show');
            if (!anyVisible) {
                document.body.classList.remove('modal-open');
                document.body.style.overflow = '';
            }
        } catch (_) {
            try { document.body.classList.remove('modal-open'); } catch (_) {}
            try { document.body.style.overflow = ''; } catch (_) {}
        }

        // Remove from visible stack
        try {
            const stack = Modal._visibleStack;
            const idx = stack.indexOf(this);
            if (idx !== -1) stack.splice(idx, 1);
        } catch (_) { /* ignore */ }

        this.emit('hide');
        this._log('hidden');
    }
    
    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }
    
    focusFirstElement() {
        const focusableElements = this.element.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        
        if (focusableElements.length > 0) {
            focusableElements[0].focus();
        } else {
            this.element.focus();
        }
    }
    
    validate() {
        return true;
    }

    // Capture-phase guard to prevent click-through to app-level listeners
    _attachCaptureGuards() {
        if (this._captureGuardsAttached) return;
        // Do not attach capture guards for floating modals like the mobile
        // text input modal; these require document-level 'up' events (e.g.,
        // mouseup/touchend) to reach draggable handlers.
        if (this.element && this.element.classList && this.element.classList.contains('floating-modal')) {
            return;
        }
        // For standard full-screen modals, guard pointer and click events
        // originating outside the modal to prevent click-through.
        const types = ['click', 'mousedown', 'pointerdown', 'touchstart', 'wheel', 'contextmenu'];
        this._captureHandlers = this._captureHandlers || new Map();
        const handler = (e) => {
            if (!this.isVisible) return;
            const inModal = this.element && this.element.contains(e.target);
            if (!inModal) {
                // If the event is inside another visible modal, do not block.
                // This allows the top-most modal to receive clicks, avoiding
                // the underlying modal swallowing events.
                try {
                    const otherModal = (e.target && typeof e.target.closest === 'function')
                        ? e.target.closest('.modal.show, .floating-modal.show')
                        : null;
                    if (otherModal && otherModal !== this.element) {
                        if (Modal.isDebug() && e.type === 'click') this._log(`allow ${e.type} (inside another modal)`, { target: e.target, otherModal });
                        return;
                    }
                } catch (_) { /* ignore */ }
                if (Modal.isDebug() && e.type === 'click') this._log(`blocked ${e.type} outside modal`, { target: e.target });
                e.stopImmediatePropagation();
            }
        };
        types.forEach((t) => {
            document.addEventListener(t, handler, true); // capture
            this._captureHandlers.set(t, handler);
        });
        this._captureGuardsAttached = true;
    }

    _detachCaptureGuards() {
        if (!this._captureGuardsAttached) return;
        const types = this._captureHandlers ? Array.from(this._captureHandlers.keys()) : [];
        types.forEach((t) => {
            const h = this._captureHandlers.get(t);
            if (h) document.removeEventListener(t, h, true);
        });
        this._captureHandlers?.clear?.();
        this._captureGuardsAttached = false;
    }

    // (debug tracing removed)
    
    emit(eventName, data = {}) {
        this.events.dispatchEvent(new CustomEvent(eventName, { detail: data }));
    }
    
    on(eventName, callback) {
        this.events.addEventListener(eventName, callback);
    }
    
    off(eventName, callback) {
        this.events.removeEventListener(eventName, callback);
    }
    
    destroy() {
        this.hide();
        this.events.removeEventListener();
    }
}

export class ConfirmationModal extends Modal {
    constructor(options = {}) {
        super(options);
        
        this.message = options.message || '';
        this.confirmText = options.confirmText || 'Confirm';
        this.cancelText = options.cancelText || 'Cancel';
        this.confirmCallback = options.onConfirm || null;
        this.cancelCallback = options.onCancel || null;
        this.destructive = options.destructive || false;
        
        this.setupConfirmationElements();

        // Handle Enter/Escape specifically for confirmation modals so
        // Enter confirms by default and does not trigger the header close (X)
        this.element.addEventListener('keydown', (e) => {
            if (!this.isVisible) return;
            const key = e.key;
            if (key !== 'Enter' && key !== 'Escape') return;

            // Always stop propagation so global shortcuts never receive these
            e.stopPropagation();

            if (key === 'Escape') {
                e.preventDefault();
                this.cancel();
                return;
            }

            // If Enter is pressed while not on the confirm button, treat it as confirm
            const target = e.target;
            const isConfirmBtn = !!(target && target.hasAttribute && target.hasAttribute('data-modal-confirm'));
            if (!isConfirmBtn) {
                e.preventDefault();
                this.confirm();
            }
            // If focus is already on the confirm button, let the default
            // button behavior occur on keyup (we've already stopped propagation)
        });

        // Add document-level key handling while visible to ensure reliability
        // on pages where focus might not be inside the modal element
        this._onDocKeyDown = (e) => {
            if (!this.isVisible) return;
            if (typeof this._isTopMost === 'function' && !this._isTopMost()) return;
            const key = e.key;
            if (key !== 'Enter' && key !== 'Escape') return;
            // Stop propagation so app/global handlers never receive it; ensure
            // subsequent listeners do not process this same event.
            try { e.stopPropagation(); e.stopImmediatePropagation?.(); } catch (_) {}
            if (key === 'Escape') {
                e.preventDefault();
                this.cancel();
                return;
            }
            // Enter defaults to confirm unless the confirm button itself has focus
            const confirmButton = this.element.querySelector('[data-modal-confirm]');
            const isConfirmBtn = confirmButton && e.target === confirmButton;
            if (!isConfirmBtn) {
                e.preventDefault();
                this.confirm();
            }
        };
        // Attach on show and detach on hide; use capture to preempt bubble listeners
        this.on('show', () => {
            document.addEventListener('keydown', this._onDocKeyDown, true);
        });
        this.on('hide', () => {
            document.removeEventListener('keydown', this._onDocKeyDown, true);
        });
    }
    
    setupConfirmationElements() {
        const messageElement = this.element.querySelector('[data-modal-message]');
        const confirmButton = this.element.querySelector('[data-modal-confirm]');
        const cancelButton = this.element.querySelector('[data-modal-cancel]');
        
        if (messageElement && this.message) {
            messageElement.textContent = this.message;
        }
        
        if (confirmButton) {
            confirmButton.textContent = this.confirmText;
            if (this.destructive) {
                confirmButton.classList.add('destructive');
            }
            confirmButton.addEventListener('click', () => this.confirm());
        }
        
        if (cancelButton) {
            cancelButton.textContent = this.cancelText;
            cancelButton.addEventListener('click', () => this.cancel());
        }
    }

    // Prefer focusing the confirm button when the modal is shown so Enter
    // naturally confirms instead of targeting the close (X) button
    focusFirstElement() {
        const confirmButton = this.element.querySelector('[data-modal-confirm]');
        if (confirmButton) {
            confirmButton.focus();
            return;
        }
        const cancelButton = this.element.querySelector('[data-modal-cancel]');
        if (cancelButton) {
            cancelButton.focus();
            return;
        }
        // Fallback to default behavior
        super.focusFirstElement();
    }
    
    confirm() {
        this.emit('confirm');
        if (this.confirmCallback) {
            this.confirmCallback();
        }
    }
    
    cancel() {
        this.emit('cancel');
        if (this.cancelCallback) {
            this.cancelCallback();
        }
        this.hide();
    }
    
    setMessage(message) {
        this.message = message;
        const messageElement = this.element.querySelector('[data-modal-message]');
        if (messageElement) {
            messageElement.textContent = message;
        }
    }
    
    setLoadingState(isLoading, text = null) {
        const confirmButton = this.element.querySelector('[data-modal-confirm]');
        const cancelButton = this.element.querySelector('[data-modal-cancel]');
        
        if (confirmButton) {
            confirmButton.disabled = isLoading;
            if (text && isLoading) {
                confirmButton.textContent = text;
            } else if (!isLoading) {
                confirmButton.textContent = this.confirmText;
            }
        }
        
        if (cancelButton) {
            cancelButton.disabled = isLoading;
        }
    }
    
    reset() {
        // Clear any running timer
        
        // Reset the modal to its initial state
        this.setLoadingState(false);
        
        const messageElement = this.element.querySelector('[data-modal-message]');
        if (messageElement && this.message) {
            messageElement.textContent = this.message;
        }
    }
    
    hide() {
        // Reset the modal state before hiding
        this.reset();
        super.hide();
    }
}

export class FormModal extends Modal {
    constructor(options = {}) {
        super(options);
        
        this.form = this.element.querySelector('form');
        this.submitCallback = options.onSubmit || null;
        this.validateCallback = options.onValidate || null;
        this.fields = new Map();
        
        this.setupFormElements();
    }
    
    setupFormElements() {
        if (this.form) {
            this.form.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submit();
            });
            
            // Handle Enter key for form submission, including inside multiline textareas
            this.form.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    // Enter submits; Shift+Enter inserts newline naturally without submission
                    e.preventDefault();
                    this.submit();
                }
            });
        }
        
        const submitButton = this.element.querySelector('[data-modal-submit]');
        if (submitButton) {
            submitButton.addEventListener('click', () => this.submit());
        }
        
        this.collectFields();
    }
    
    // Override focusFirstElement to focus the first form field instead of the close button
    focusFirstElement() {
        // Try to focus the first input field in the form
        const firstInput = this.form ? this.form.querySelector('input, select, textarea') : null;
        if (firstInput) {
            firstInput.focus();
        } else {
            // Fall back to parent behavior
            super.focusFirstElement();
        }
    }
    
    collectFields() {
        const inputs = this.element.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
            this.fields.set(input.name || input.id, input);
        });
    }
    
    getFieldValue(fieldName) {
        const field = this.fields.get(fieldName);
        if (!field) return null;
        
        if (field.type === 'checkbox') {
            return field.checked;
        } else if (field.type === 'radio') {
            const checked = this.element.querySelector(`input[name="${fieldName}"]:checked`);
            return checked ? checked.value : null;
        }
        return field.value;
    }
    
    setFieldValue(fieldName, value) {
        const field = this.fields.get(fieldName);
        if (!field) return;
        
        if (field.type === 'checkbox') {
            field.checked = Boolean(value);
        } else if (field.type === 'radio') {
            const option = this.element.querySelector(`input[name="${fieldName}"][value="${value}"]`);
            if (option) option.checked = true;
        } else {
            field.value = value;
        }
    }
    
    getFormData() {
        const data = {};
        this.fields.forEach((field, name) => {
            data[name] = this.getFieldValue(name);
        });
        return data;
    }
    
    clearForm() {
        this.fields.forEach((field) => {
            if (field.type === 'checkbox' || field.type === 'radio') {
                field.checked = false;
            } else {
                field.value = '';
            }
        });
    }
    
    validate() {
        if (this.validateCallback) {
            return this.validateCallback(this.getFormData());
        }
        
        const requiredFields = this.element.querySelectorAll('[required]');
        for (const field of requiredFields) {
            if (!field.value.trim()) {
                field.focus();
                return false;
            }
        }
        
        return true;
    }
    
    submit() {
        if (!this.validate()) {
            this.emit('validationError');
            return;
        }
        
        const formData = this.getFormData();
        this.emit('submit', formData);
        
        if (this.submitCallback) {
            this.submitCallback(formData);
        }
        
        if (this.autoClose) {
            this.hide();
        }
    }
    
    setLoadingState(isLoading, text = null) {
        const submitButton = this.element.querySelector('[data-modal-submit]');
        const inputs = this.element.querySelectorAll('input, select, textarea, button');
        
        inputs.forEach(input => {
            input.disabled = isLoading;
        });
        
        if (submitButton && text && isLoading) {
            submitButton.textContent = text;
        }
    }
}

export class InputModal extends FormModal {
    constructor(options = {}) {
        super(options);
        
        this.inputType = options.inputType || 'text';
        this.placeholder = options.placeholder || '';
        this.defaultValue = options.defaultValue || '';
        this.multiline = options.multiline || false;
        
        this.setupInputElement();
    }
    
    setupInputElement() {
        let inputElement = this.element.querySelector('[data-modal-input]');
        
        if (inputElement) {
            if (this.multiline && inputElement.tagName !== 'TEXTAREA') {
                const textarea = document.createElement('textarea');
                textarea.setAttribute('data-modal-input', '');
                textarea.className = inputElement.className;
                textarea.id = inputElement.id;
                textarea.name = inputElement.name;
                inputElement.parentNode.replaceChild(textarea, inputElement);
                inputElement = textarea;
            }
            
            // Only set type for input elements, not textarea
            if (inputElement.tagName === 'INPUT') {
                inputElement.type = this.inputType;
            }
            inputElement.placeholder = this.placeholder;
            inputElement.value = this.defaultValue;
            
            this.inputElement = inputElement;

            // Handle Enter/Shift+Enter inside multiline inputs:
            // - Enter submits the modal (no modifiers)
            // - Shift+Enter inserts a newline
            try {
                this.inputElement.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter') return;
                    // Allow Shift+Enter to insert newline
                    if (e.shiftKey) return;
                    // Ignore if any other modifier is pressed
                    if (e.ctrlKey || e.altKey || e.metaKey) return;
                    // Submit on plain Enter
                    e.preventDefault();
                    e.stopPropagation();
                    this.submit();
                });
            } catch (_) { /* ignore */ }
        }
    }
    
    getValue() {
        return this.inputElement ? this.inputElement.value : '';
    }
    
    setValue(value) {
        if (this.inputElement) {
            this.inputElement.value = value;
        }
    }
    
    focus() {
        if (this.inputElement) {
            this.inputElement.focus();
        }
    }
    
    selectAll() {
        if (this.inputElement) {
            this.inputElement.select();
        }
    }
}

// Utility: central check for any open modal overlay (blocking or floating)
// Returns true if any element matching `.modal.show` or `.floating-modal.show` exists.
export function isAnyModalOpen() {
    try {
        return !!document.querySelector('.modal.show, .floating-modal.show');
    } catch (_) {
        return false;
    }
}
