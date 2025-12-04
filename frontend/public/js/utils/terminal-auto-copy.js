/**
 * Terminal Auto-Copy Utility
 * Shared functionality for auto-copying text selections from xterm.js terminals
 */

import { getContext } from '../core/context.js';

export class TerminalAutoCopy {
    /**
     * Setup auto-copy functionality for a terminal instance
     * @param {Terminal} terminal - The xterm.js terminal instance
     * @param {string} identifier - Unique identifier for logging (e.g., session ID)
     * @param {Function} onCopyCallback - Optional callback to execute after successful copy
     * @returns {Function} Cleanup function to remove event listeners
     */
    static setup(terminal, identifier = 'terminal', onCopyCallback = null, options = {}) {
        if (!terminal || !terminal.element) {
            console.warn('[Auto-copy] Terminal or terminal element not available');
            return () => {};
        }

        const terminalElement = terminal.element;

        // Track active drag selection started inside xterm
        let dragSelecting = false;
        // Track the latest non-empty selection text observed during drag
        let lastDragSelection = '';
        const handleMouseDown = (e) => {
            // Only consider primary button drags
            if (e && e.button === 0) {
                // Clear any existing status immediately so next copy feedback is obvious
                try { TerminalAutoCopy.clearStatusMessage(); } catch (_) {}
                dragSelecting = true;
            }
        };

        // Core copy routine (deferred to let xterm finalize selection)
        const finalizeCopy = (event) => {
            const run = () => {
                if (!terminal || !terminal.getSelection) return;
                let selectedText = '';
                try {
                    if (terminal.hasSelection && terminal.hasSelection()) {
                        selectedText = terminal.getSelection();
                    }
                } catch (_) { /* ignore */ }
                // Fallback to last observed selection during drag if immediate check is empty
                if ((!selectedText || !selectedText.trim()) && lastDragSelection && lastDragSelection.trim()) {
                    selectedText = lastDragSelection;
                }
                // If Shift is held on release and a handler is provided, open send modal instead of copying
                if (event && event.shiftKey && selectedText && selectedText.trim()) {
                    try {
                        const handler = (options && typeof options.onShiftSend === 'function')
                            ? options.onShiftSend
                            : null;
                        if (handler) {
                            handler(selectedText);
                            return;
                        }
                        // Fallback: attempt to locate TerminalManager via app context
                        const mgr = getContext()?.app?.modules?.terminal;
                        if (mgr && typeof mgr.showTextInputModalWithIncluded === 'function') {
                            mgr.showTextInputModalWithIncluded(selectedText);
                            return;
                        }
                    } catch (_) { /* ignore and fall back to copy */ }
                }

                if (selectedText && selectedText.trim()) {
                    TerminalAutoCopy.copyToClipboard(selectedText, identifier, onCopyCallback);
                }
                // Reset cached selection after finalize to avoid stale copies
                lastDragSelection = '';
            };

            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => setTimeout(run, 0));
            } else {
                setTimeout(run, 20);
            }
        };

        // Listen for mouseup on the entire document (capture) to avoid being blocked by inner handlers
        const handleMouseUp = (event) => {
            // Only finalize if a drag started inside xterm
            if (!dragSelecting) return;
            // Defer until after xterm updates its internal selection state
            finalizeCopy(event);
            dragSelecting = false;
        };

        // Fallbacks when releasing outside the window or app region
        const handleWindowBlur = (event) => {
            if (!dragSelecting) return;
            finalizeCopy(event);
            dragSelecting = false;
        };
        const handleDocMouseLeave = (event) => {
            // relatedTarget === null indicates leaving the window in many browsers
            if (!dragSelecting) return;
            try {
                const rt = event?.relatedTarget || event?.toElement || null;
                if (rt === null) {
                    finalizeCopy(event);
                    dragSelecting = false;
                }
            } catch (_) { /* ignore */ }
        };
        const handlePointerCancel = (event) => {
            if (!dragSelecting) return;
            finalizeCopy(event);
            dragSelecting = false;
        };

        // While dragging, keep track of latest non-empty selection
        const handleDocMouseMove = (event) => {
            if (!dragSelecting) return;
            try {
                if (terminal.hasSelection && terminal.hasSelection()) {
                    const txt = terminal.getSelection();
                    if (txt && txt.trim()) {
                        lastDragSelection = txt;
                    }
                }
            } catch (_) { /* ignore */ }
        };

        // Add event listeners
        terminalElement.addEventListener('mousedown', handleMouseDown, { capture: true, passive: true });
        document.addEventListener('mouseup', handleMouseUp, { capture: true });
        window.addEventListener('blur', handleWindowBlur, { passive: true });
        document.addEventListener('mouseleave', handleDocMouseLeave, { passive: true });
        window.addEventListener('pointercancel', handlePointerCancel, { passive: true });
        document.addEventListener('mousemove', handleDocMouseMove, { passive: true });

        // Return cleanup function
        return () => {
            terminalElement.removeEventListener('mousedown', handleMouseDown, { capture: true, passive: true });
            document.removeEventListener('mouseup', handleMouseUp, { capture: true });
            window.removeEventListener('blur', handleWindowBlur, { passive: true });
            document.removeEventListener('mouseleave', handleDocMouseLeave, { passive: true });
            window.removeEventListener('pointercancel', handlePointerCancel, { passive: true });
            document.removeEventListener('mousemove', handleDocMouseMove, { passive: true });
        };
    }

    /**
     * Copy text to clipboard using modern API with fallback
     * @param {string} text - Text to copy
     * @param {string} identifier - Identifier for logging
     * @param {Function} onCopyCallback - Optional callback to execute after successful copy
     */
    static copyToClipboard(text, identifier = 'terminal', onCopyCallback = null) {
        // Try modern Clipboard API first (requires HTTPS or localhost)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
                .then(() => {
                    TerminalAutoCopy.showStatusMessage('Copied', 2000);
                    // Execute callback after successful copy
                    if (onCopyCallback && typeof onCopyCallback === 'function') {
                        onCopyCallback();
                    }
                })
                .catch(error => {
                    console.warn('[Auto-copy] Clipboard API failed, trying fallback:', error);
                    TerminalAutoCopy.copyUsingExecCommand(text, identifier, onCopyCallback);
                });
        } else {
            // Fallback to older execCommand method
            TerminalAutoCopy.copyUsingExecCommand(text, identifier, onCopyCallback);
        }
    }

    /**
     * Fallback copy method using execCommand
     * @param {string} text - Text to copy
     * @param {string} identifier - Identifier for logging
     * @param {Function} onCopyCallback - Optional callback to execute after successful copy
     */
    static copyUsingExecCommand(text, identifier = 'terminal', onCopyCallback = null) {
        try {
            // Create a temporary textarea element
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.top = '-9999px';
            textarea.style.left = '-9999px';
            textarea.setAttribute('readonly', '');
            document.body.appendChild(textarea);
            
            // Select the text
            textarea.select();
            textarea.setSelectionRange(0, text.length);
            
            // Try to copy
            const successful = document.execCommand('copy');
            
            // Clean up
            document.body.removeChild(textarea);
            
            if (successful) {
                TerminalAutoCopy.showStatusMessage('Copied', 2000);
                // Execute callback after successful copy
                if (onCopyCallback && typeof onCopyCallback === 'function') {
                    onCopyCallback();
                }
            } else {
                console.warn('[Auto-copy] ✗ execCommand copy failed');
                TerminalAutoCopy.showStatusMessage('Copy failed', 2000, true);
            }
        } catch (error) {
            console.error('[Auto-copy] ✗ Error using execCommand:', error);
            TerminalAutoCopy.showStatusMessage('Copy failed', 2000, true);
        }
    }

    /**
     * Show status message to user
     * @param {string} message - Message to display
     * @param {number} timeout - How long to show message in ms
     * @param {boolean} isError - Whether this is an error message
     */
    static showStatusMessage(message, timeout = 3000, isError = false) {
        // Get the status message element
        const statusElement = document.getElementById('terminal-status-message');
        if (!statusElement) {
            console.warn('[Status] Status message element not found');
            return;
        }
        
        // Clear any existing timeout
        if (TerminalAutoCopy.statusMessageTimeout) {
            clearTimeout(TerminalAutoCopy.statusMessageTimeout);
        }
        
        // Set the message and styling
        statusElement.textContent = message;
        statusElement.classList.remove('error');
        if (isError) {
            statusElement.classList.add('error');
        }
        
        // Show the message
        statusElement.classList.add('show');
        
        // Hide after timeout
        TerminalAutoCopy.statusMessageTimeout = setTimeout(() => {
            statusElement.classList.remove('show');
            // Clear text after fade out
            setTimeout(() => {
                statusElement.textContent = '';
            }, 300);
        }, timeout);
    }

    /**
     * Immediately clear any visible status message and cancel timers
     */
    static clearStatusMessage() {
        try {
            if (TerminalAutoCopy.statusMessageTimeout) {
                clearTimeout(TerminalAutoCopy.statusMessageTimeout);
                TerminalAutoCopy.statusMessageTimeout = null;
            }
            const statusElement = document.getElementById('terminal-status-message');
            if (statusElement) {
                statusElement.classList.remove('show');
                statusElement.classList.remove('error');
                statusElement.textContent = '';
            }
        } catch (_) { /* ignore */ }
    }
}

// Static property for timeout tracking
TerminalAutoCopy.statusMessageTimeout = null;
