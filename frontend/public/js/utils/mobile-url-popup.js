/**
 * Mobile URL Popup Utility
 * Handles URL display and interaction popups for mobile devices
 */

import { TerminalAutoCopy } from './terminal-auto-copy.js';
import { TOUCH_CONFIG } from '../modules/terminal/terminal-touch-config.js';
import { iconUtils } from './icon-utils.js';

export class MobileUrlPopup {
    static activePopup = null;
    static popupTimeout = null;
    
    /**
     * Show a mobile URL popup with options to open, copy, or cancel
     * @param {string} url - The URL to display
     * @param {string} sessionId - The terminal session ID for copy operations
     * @param {Function} focusCallback - Callback to refocus terminal
     * @param {string} originalSelection - Original selected text (optional)
     */
    static show(url, sessionId, focusCallback, originalSelection = null) {
        // Remove any existing popup
        this.hide();
        
        // Create popup container
        const popup = document.createElement('div');
        popup.className = 'mobile-url-popup';
        popup.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            z-index: 10000;
            max-width: 90vw;
            text-align: center;
            font-family: var(--app-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
        `;
        
        // URL display (truncated if too long)
        const urlDisplay = document.createElement('div');
        urlDisplay.style.cssText = `
            margin-bottom: 15px;
            font-size: 14px;
            word-break: break-all;
            opacity: 0.8;
            max-height: 60px;
            overflow: hidden;
        `;
        urlDisplay.textContent = url.length > 60 ? url.substring(0, 60) + '...' : url;
        
        // Button container
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            gap: 12px;
            justify-content: center;
            flex-wrap: wrap;
        `;
        
        // Open button
        const openButton = this._createButton('Open', '#007AFF', () => {
            window.open(url, '_blank', 'noopener,noreferrer');
            this.hide();
        }, false, 'external-link');
        
        // Copy button - copy original text if available, otherwise URL
        const textToCopy = originalSelection || url;
        const copyLabel = originalSelection ? 'Copy Text' : 'Copy URL';
        const copyButton = this._createButton(copyLabel, 'rgba(255, 255, 255, 0.1)', () => {
            const refocusCallback = () => {
                setTimeout(() => {
                    if (focusCallback) focusCallback();
                }, TOUCH_CONFIG.REFOCUS_DELAY);
            };
            TerminalAutoCopy.copyToClipboard(textToCopy, `mobile-url-${sessionId}`, refocusCallback);
            this.hide();
        }, true, 'copy');
        
        // Add Copy URL button if we have original selection different from URL
        let copyUrlButton = null;
        if (originalSelection && originalSelection.trim() !== url) {
            copyUrlButton = this._createButton('Copy URL', 'rgba(255, 255, 255, 0.1)', () => {
                const refocusCallback = () => {
                    setTimeout(() => {
                        if (focusCallback) focusCallback();
                    }, TOUCH_CONFIG.REFOCUS_DELAY);
                };
                TerminalAutoCopy.copyToClipboard(url, `mobile-url-${sessionId}`, refocusCallback);
                this.hide();
            }, true, 'link');
        }
        
        // Cancel button
        const cancelButton = this._createButton('Cancel', 'rgba(255, 255, 255, 0.1)', () => {
            this.hide();
        }, true, 'x');
        
        // Assemble popup
        buttonContainer.appendChild(openButton);
        buttonContainer.appendChild(copyButton);
        if (copyUrlButton) {
            buttonContainer.appendChild(copyUrlButton);
        }
        buttonContainer.appendChild(cancelButton);
        popup.appendChild(urlDisplay);
        popup.appendChild(buttonContainer);
        
        // Add to document
        document.body.appendChild(popup);
        
        // Store reference for cleanup
        this.activePopup = popup;
        
        // Auto-hide after configured timeout
        this.popupTimeout = setTimeout(() => {
            this.hide();
        }, TOUCH_CONFIG.URL_POPUP_AUTO_HIDE);
        
        // Close on backdrop click
        popup.addEventListener('click', (e) => {
            if (e.target === popup) {
                this.hide();
            }
        });
    }
    
    /**
     * Hide the currently active popup
     */
    static hide() {
        if (this.activePopup) {
            this.activePopup.remove();
            this.activePopup = null;
        }
        if (this.popupTimeout) {
            clearTimeout(this.popupTimeout);
            this.popupTimeout = null;
        }
    }
    
    /**
     * Create a styled button element
     * @private
     */
    static _createButton(text, backgroundColor, clickHandler, hasBorder = false, iconName = null) {
        const button = document.createElement('button');
        
        // Add icon if provided
        if (iconName) {
            const icon = iconUtils.createIcon(iconName, { size: 16, color: 'white' });
            button.appendChild(icon);
            const textSpan = document.createElement('span');
            textSpan.textContent = ' ' + text;
            button.appendChild(textSpan);
        } else {
            button.textContent = text;
        }
        
        const borderStyle = hasBorder ? 'border: 1px solid rgba(255, 255, 255, 0.2);' : 'border: none;';
        button.style.cssText = `
            background: ${backgroundColor};
            color: white;
            ${borderStyle}
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            min-width: 120px;
        `;
        
        button.addEventListener('click', clickHandler);
        return button;
    }
}
