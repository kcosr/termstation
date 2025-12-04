/**
 * Simple Font Provider
 * Provides the two universally working terminal fonts
 */

export class FontDetector {
    /**
     * Get available fonts - just the two that work everywhere
     * @returns {Array} Array of font objects with name and value
     */
    getAvailableFonts() {
        return [
            { name: 'Courier New (Default)', value: '"Courier New", monospace' },
            { name: 'System Monospace', value: 'monospace' }
        ];
    }

    /**
     * Get default font
     * @returns {string} Default font family value
     */
    getDefaultFont() {
        return '"Courier New", monospace';
    }
}

// Export singleton instance
export const fontDetector = new FontDetector();
