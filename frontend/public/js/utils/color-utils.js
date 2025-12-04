/**
 * Color utilities for template badge colors
 * Supports common color names and hex values
 */

// Common color name mappings
const COLOR_MAP = {
    // CSS named colors
    'red': '#ff0000',
    'blue': '#0000ff',
    'green': '#008000',
    'orange': '#ffa500',
    'purple': '#800080',
    'yellow': '#ffff00',
    'cyan': '#00ffff',
    'magenta': '#ff00ff',
    'pink': '#ffc0cb',
    'brown': '#a52a2a',
    'gray': '#808080',
    'grey': '#808080',
    'black': '#000000',
    'white': '#ffffff',
    
    // Additional useful colors
    'darkred': '#8b0000',
    'darkblue': '#00008b',
    'darkgreen': '#006400',
    'lightblue': '#add8e6',
    'lightgreen': '#90ee90',
    'lightgray': '#d3d3d3',
    'lightgrey': '#d3d3d3',
    'darkgray': '#a9a9a9',
    'darkgrey': '#a9a9a9',
    
    // Professional/theme colors
    'primary': '#007bff',
    'secondary': '#6c757d',
    'success': '#28a745',
    'warning': '#ffc107',
    'danger': '#dc3545',
    'info': '#17a2b8',
    'light': '#f8f9fa',
    'dark': '#343a40'
};

/**
 * Parse color string and return a valid CSS color value
 * @param {string} color - Color name or hex value
 * @returns {string|null} Valid CSS color or null if invalid
 */
export function parseColor(color) {
    if (!color || typeof color !== 'string') {
        return null;
    }
    
    const colorLower = color.toLowerCase().trim();
    
    // Check if it's a named color
    if (COLOR_MAP[colorLower]) {
        return COLOR_MAP[colorLower];
    }
    
    // Check if it's a hex color (with or without #)
    const hexMatch = colorLower.match(/^#?([a-f0-9]{3}|[a-f0-9]{6})$/);
    if (hexMatch) {
        return '#' + hexMatch[1];
    }
    
    // Check if it's already a valid CSS color (rgb, rgba, hsl, etc.)
    if (isValidCSSColor(colorLower)) {
        return colorLower;
    }
    
    return null;
}

/**
 * Check if a string is a valid CSS color
 * @param {string} color - Color string to validate
 * @returns {boolean} True if valid CSS color
 */
function isValidCSSColor(color) {
    // Create a temporary element to test color validity
    const element = document.createElement('div');
    element.style.color = color;
    return element.style.color !== '';
}

/**
 * Get contrast color (black or white) for a given background color
 * @param {string} backgroundColor - Background color
 * @returns {string} 'black' or 'white' for optimal contrast
 */
export function getContrastColor(backgroundColor) {
    const color = parseColor(backgroundColor);
    if (!color) {
        return 'black';
    }
    
    // Convert to RGB
    const rgb = hexToRgb(color);
    if (!rgb) {
        return 'black';
    }
    
    // Calculate relative luminance
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    
    // Return black for light backgrounds, white for dark backgrounds
    return luminance > 0.5 ? 'black' : 'white';
}

/**
 * Convert hex color to RGB object
 * @param {string} hex - Hex color string
 * @returns {object|null} RGB object or null if invalid
 */
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

/**
 * Get list of available color names
 * @returns {Array} Array of color name strings
 */
export function getAvailableColors() {
    return Object.keys(COLOR_MAP);
}