/**
 * Session Modals
 * Handles modal creation and management for session-related operations
 */

import { apiService } from '../../services/api.service.js';
import { getStateStore } from '../../core/state-store/index.js';
import { queueStateSet } from '../../core/state-store/batch.js';

export class SessionModals {
    constructor() {
        // No persistent state needed
    }

    /**
     * Show modal for setting session title
     * @param {Object} sessionData - Session data object
     * @param {Function} onTitleUpdated - Callback when title is updated
     */
    showSetTitleModal(sessionData, onTitleUpdated) {
        // Create modal overlay
        const overlay = this.createModalOverlay();
        
        // Create modal
        const modal = this.createSetTitleModal(sessionData, overlay, onTitleUpdated);
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        // Focus the input and select existing text
        const titleInput = modal.querySelector('#titleInput');
        titleInput.focus();
        titleInput.select();
    }

    createModalOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
        `;
        // Make overlay focusable so it can capture key events in capture phase
        try { overlay.setAttribute('tabindex', '-1'); } catch (_) {}
        return overlay;
    }

    createSetTitleModal(sessionData, overlay, onTitleUpdated) {
        const modal = document.createElement('div');
        modal.className = 'set-title-modal';
        modal.style.cssText = `
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 1.5rem;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        `;

        const currentTitle = sessionData.title || '';
        const shortId = sessionData.session_id.substring(0, 8);

        modal.innerHTML = `
            <h3 style="color: var(--text-primary); margin-top: 0; margin-bottom: 1rem;">Set Terminal Title</h3>
            <p style="color: var(--text-dim); margin-bottom: 1rem;">Session: ${shortId}</p>
            <input type="text" id="titleInput" placeholder="Enter title..." 
                   value="${currentTitle}" 
                   style="width: 100%; padding: 0.75rem; border: 1px solid var(--border-color); 
                          border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); 
                          font-size: 1rem; margin-bottom: 1rem;" />
            <div style="display: flex; gap: 0.75rem; justify-content: flex-end;">
                <button id="cancelBtn" style="padding: 0.5rem 1rem; border: 1px solid var(--border-color); 
                               border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); 
                               cursor: pointer;">Cancel</button>
                <button id="setBtn" style="padding: 0.5rem 1rem; border: none; border-radius: 4px; 
                               background: var(--accent-color); color: white; cursor: pointer;">Set Title</button>
            </div>
        `;

        this.setupModalEventHandlers(modal, overlay, sessionData, onTitleUpdated);
        
        return modal;
    }

    setupModalEventHandlers(modal, overlay, sessionData, onTitleUpdated) {
        const titleInput = modal.querySelector('#titleInput');
        const cancelBtn = modal.querySelector('#cancelBtn');
        const setBtn = modal.querySelector('#setBtn');

        const keydownHandler = (e) => {
            try {
                if (e && (e.key === 'Enter' || e.key === 'Escape')) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                if (e && e.key === 'Enter') {
                    setBtn.click();
                } else if (e && e.key === 'Escape') {
                    closeModal();
                }
            } catch (_) {}
        };

        const closeModal = () => {
            // Remove key handlers before detaching overlay
            try { modal.removeEventListener('keydown', keydownHandler, true); } catch (_) {}
            try { overlay.removeEventListener('keydown', keydownHandler, true); } catch (_) {}
            document.body.removeChild(overlay);
        };

        cancelBtn.addEventListener('click', closeModal);

        setBtn.addEventListener('click', async () => {
            const newTitle = titleInput.value.trim();
            try {
                // Local-only sessions are updated purely on the frontend and persisted via desktop state store
                if (sessionData && sessionData.local_only === true && window.desktop && window.desktop.isElectron) {
                    try {
                        // Persist per-session titles in desktop state under 'local_session_titles'
                        const res = getStateStore().loadSync && getStateStore().loadSync();
                        const st = res && res.ok ? (res.state || {}) : {};
                        const map = (st && typeof st['local_session_titles'] === 'object') ? { ...st['local_session_titles'] } : {};
                        if (newTitle) {
                            map[sessionData.session_id] = newTitle;
                        } else {
                            // Empty title -> remove override so dynamic title/fallbacks apply
                            try { delete map[sessionData.session_id]; } catch (_) {}
                        }
                        queueStateSet('local_session_titles', map);
                    } catch (_) { /* ignore */ }
                    // Broadcast to other windows for immediate sync
                    try { window.desktop.notifyLocalTitleUpdated?.({ sessionId: sessionData.session_id, title: newTitle }); } catch (_) {}
                    if (onTitleUpdated) {
                        onTitleUpdated(sessionData.session_id, newTitle);
                    }
                } else {
                    await this.setSessionTitle(sessionData.session_id, newTitle);
                    if (onTitleUpdated) {
                        onTitleUpdated(sessionData.session_id, newTitle);
                    }
                }
                closeModal();
            } catch (error) {
                console.error('Failed to set title:', error);
                this.showError(modal, 'Failed to set title. Please try again.');
            }
        });

        // Handle Enter and Escape keys
        try {
            // Capture key events at modal and overlay to prevent them reaching the terminal
            modal.addEventListener('keydown', keydownHandler, true);
            overlay.addEventListener('keydown', keydownHandler, true);
            titleInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                }
                if (e.key === 'Enter') {
                    setBtn.click();
                } else if (e.key === 'Escape') {
                    closeModal();
                }
            });
        } catch (_) {}

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeModal();
            }
        });
    }

    showError(modal, errorMessage) {
        // Remove any existing error
        const existingError = modal.querySelector('.modal-error');
        if (existingError) {
            existingError.remove();
        }

        // Show error in the modal
        const errorDiv = document.createElement('div');
        errorDiv.className = 'modal-error';
        errorDiv.style.cssText = 'color: #ff6b6b; font-size: 0.9rem; margin-top: 0.5rem;';
        errorDiv.textContent = errorMessage;
        
        const buttonContainer = modal.querySelector('div:last-child');
        modal.insertBefore(errorDiv, buttonContainer);
    }

    async setSessionTitle(sessionId, title) {
        return await apiService.setSessionTitle(sessionId, title);
    }
}
