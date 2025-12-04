/**
 * Icon Utilities - Centralized icon management using local Bootstrap icons
 * Provides consistent icon rendering and management across the application
 */

export class IconUtils {
    constructor() {
        this.iconCache = new Map();
        // Deduplicate concurrent loads for the same icon
        this.pendingLoads = new Map(); // name -> { elements: Set<SVGElement>, promise: Promise<string> }
        this.basePath = 'icons/vendor/bootstrap-icons/';
        
        // Icon mappings for different contexts - mapping to Bootstrap icon names
        this.iconMap = {
            // Severity/status icons
            critical: 'exclamation-octagon',
            error: 'x-circle',
            warning: 'exclamation-triangle',
            info: 'info-circle',
            
            // Action icons
            settings: 'gear',
            save: 'floppy',
            edit: 'pencil-square',
            note: 'file-text',
            
            // Context menu icons
            eye: 'eye',
            eraser: 'eraser',
            'message-square': 'chat-square-text',
            'pin-off': 'pin',
            pin: 'pin-angle',
            tag: 'tag',
            square: 'stop-fill',
            link: 'link-45deg',
            'external-link': 'box-arrow-up-right',
            'trash-2': 'trash',
            
            // UI icons
            'chevron-up': 'chevron-up',
            'chevron-down': 'chevron-down',
            search: 'search',
            copy: 'copy',
            x: 'x-lg',
            check: 'check-lg',
            
            // Movement icons
            move: 'arrows-move',
            'arrow-up': 'arrow-up',
            'arrow-down': 'arrow-down',
            
            // Additional icons
            keyboard: 'keyboard',
            bell: 'bell',
            disk: 'hdd',
            document: 'file-text'
        };

        // Map generic 'box' to the Bootstrap 'box-seam' icon we vendored
        this.iconMap['box'] = 'box-seam';
        // Aliases for common names used elsewhere
        this.iconMap['users'] = 'people';
        this.iconMap['public'] = 'globe';
        this.iconMap['clock-history'] = 'clock-history';
        // Fullscreen icons are not vendored; map to available display icon
        this.iconMap['fullscreen'] = 'display';
        this.iconMap['fullscreen-exit'] = 'display';
    }

    /**
     * Create an icon element using local Bootstrap icons
     * @param {string} iconName - The icon identifier (from iconMap or direct Bootstrap name)
     * @param {Object} options - Icon options
     * @returns {HTMLElement} Icon element
     */
    createIcon(iconName, options = {}) {
        const {
            size = 16,
            color = 'currentColor',
            className = '',
            title = ''
        } = options;

        // Get the actual Bootstrap icon name
        const bootstrapIconName = this.iconMap[iconName] || iconName;
        
        // Create icon element
        const iconElement = document.createElement('span');
        iconElement.className = `bi-icon ${className}`;
        if (title) {
            iconElement.title = title;
        }
        
        // Create SVG (reserve space immediately so layout doesn't shift)
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', size);
        svg.setAttribute('height', size);
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', color);
        svg.setAttribute('class', 'bi');

        iconElement.appendChild(svg);

        // If already cached, render synchronously
        if (this.iconCache.has(bootstrapIconName)) {
            svg.innerHTML = this.iconCache.get(bootstrapIconName);
            return iconElement;
        }

        // On desktop (Electron), synchronously fetch the SVG once to avoid initial flash
        if (this.isElectron()) {
            const inline = this.loadIconContentSync(bootstrapIconName);
            if (inline) {
                svg.innerHTML = inline;
                return iconElement;
            }
        }

        // Fallback: async load for web or if sync path failed
        this.enqueueIconLoad(bootstrapIconName, svg);
        
        return iconElement;
    }

    /**
     * Load SVG content from local file
     * @private
     */
    async loadIconContent(iconName, svgElement) {
        try {
            // Check cache first
            if (this.iconCache.has(iconName)) {
                try { console.log('[Icons] loadIconContent cache hit', { icon: iconName }); } catch(_) {}
                svgElement.innerHTML = this.iconCache.get(iconName);
                return;
            }

            // Fetch from local file
            const url = `${this.basePath}${iconName}.svg`;
            const response = await fetch(url, { cache: 'force-cache' });
            if (!response.ok) {
                throw new Error(`Icon not found: ${iconName}`);
            }
            const svgText = await response.text();
            try {
                const t1 = (window.performance && performance.now) ? performance.now() : Date.now();
                const ct = response.headers && response.headers.get ? (response.headers.get('content-type') || '') : '';
                console.log('[Icons] loadIconContent fetch ok', { icon: iconName, status: response.status, contentType: ct, tookMs: Math.round(t1 - t0) });
            } catch(_) {}
            
            // Extract the inner SVG content (paths, circles, etc.)
            const parser = new DOMParser();
            const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');
            const svgNode = svgDoc && svgDoc.querySelector ? svgDoc.querySelector('svg') : null;
            const svgContent = svgNode ? svgNode.innerHTML : null;
            if (!svgContent) {
                throw new Error('Invalid SVG document');
            }
            
            // Cache the content
            this.iconCache.set(iconName, svgContent);
            
            // Set the content
            svgElement.innerHTML = svgContent;
            
        } catch (error) {
            // Fallback: create a simple circle as placeholder
            svgElement.innerHTML = '<circle cx="8" cy="8" r="6"/>';
        }
    }

    /**
     * Queue/deduplicate icon loads and update all waiting elements when done.
     * @private
     */
    enqueueIconLoad(iconName, svgElement) {
        // If cached, set immediately
        if (this.iconCache.has(iconName)) {
            try { console.log('[Icons] cache hit', { icon: iconName }); } catch(_) {}
            svgElement.innerHTML = this.iconCache.get(iconName);
            return;
        }
        // Attach to existing in-flight request
        if (this.pendingLoads.has(iconName)) {
            const entry = this.pendingLoads.get(iconName);
            entry.elements.add(svgElement);
            return;
        }
        // Start new request using existing loader and distribute result
        const elements = new Set([svgElement]);
        const promise = (async () => {
            const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            await this.loadIconContent(iconName, tmp);
            const inner = tmp.innerHTML || '';
            if (inner) this.iconCache.set(iconName, inner);
            return inner;
        })();
        this.pendingLoads.set(iconName, { elements, promise });
        promise.then((content) => {
            const html = content && content.length ? content : '<circle cx="8" cy="8" r="6"/>';
            for (const el of elements) { try { el.innerHTML = html; } catch(_) {} }
        }).catch(() => {
            const html = '<circle cx="8" cy="8" r="6"/>';
            for (const el of elements) { try { el.innerHTML = html; } catch(_) {} }
        }).finally(() => {
            this.pendingLoads.delete(iconName);
        });
    }

    /**
     * Synchronously load SVG content (Electron only) to prevent icon flash at first paint
     * @private
     */
    loadIconContentSync(iconName) {
        try {
            // Check cache
            if (this.iconCache.has(iconName)) {
                try { console.log('[Icons] loadIconContentSync cache hit', { icon: iconName }); } catch(_) {}
                return this.iconCache.get(iconName);
            }
            // Use sync XHR; allowed in Electron and avoids initial flicker
            const xhr = new XMLHttpRequest();
            const url = `${this.basePath}${iconName}.svg`;
            xhr.open('GET', url, false);
            xhr.overrideMimeType && xhr.overrideMimeType('image/svg+xml');
            try { xhr.send(null); } catch (_) { return null; }
            if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
                const text = xhr.responseText;
                // Parse minimally to extract inner content
                const parser = new DOMParser();
                const svgDoc = parser.parseFromString(text, 'image/svg+xml');
                const node = svgDoc && svgDoc.querySelector && svgDoc.querySelector('svg');
                const inner = node ? node.innerHTML : null;
                if (inner) {
                    this.iconCache.set(iconName, inner);
                    return inner;
                }
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    /**
     * Detect Electron runtime (renderer)
     * @private
     */
    isElectron() {
        try {
            if (window.desktop && window.desktop.isElectron) return true;
            const ua = navigator.userAgent || '';
            return /electron/i.test(ua);
        } catch (_) {
            return false;
        }
    }

    /**
     * Replace emoji with icon in a text node or element
     * @param {string} text - Text containing emojis
     * @param {Object} emojiMap - Map of emojis to icon names
     * @returns {DocumentFragment} Document fragment with text and icons
     */
    replaceEmojisInText(text, emojiMap = {}) {
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        
        // Default emoji mappings
        const defaultEmojiMap = {
            '⛔': 'critical',
            '❌': 'error', 
            '⚠️': 'warning',
            'ℹ️': 'info',
            '⚙️': 'settings',
            '💾': 'save',
            '📝': 'note',
            '⌨️': 'keyboard',
            '🔔': 'bell'
        };
        
        const fullEmojiMap = { ...defaultEmojiMap, ...emojiMap };
        
        // Find and replace emojis
        for (const [emoji, iconName] of Object.entries(fullEmojiMap)) {
            let index = text.indexOf(emoji, lastIndex);
            while (index !== -1) {
                // Add text before emoji
                if (index > lastIndex) {
                    const textNode = document.createTextNode(text.substring(lastIndex, index));
                    fragment.appendChild(textNode);
                }
                
                // Add icon instead of emoji
                const icon = this.createIcon(iconName, { size: 16 });
                fragment.appendChild(icon);
                
                lastIndex = index + emoji.length;
                index = text.indexOf(emoji, lastIndex);
            }
        }
        
        // Add remaining text
        if (lastIndex < text.length) {
            const textNode = document.createTextNode(text.substring(lastIndex));
            fragment.appendChild(textNode);
        }
        
        return fragment;
    }
}

// Create and export singleton instance
export const iconUtils = new IconUtils();
