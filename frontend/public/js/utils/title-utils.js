/**
 * Title Utilities
 * Centralizes logic for computing the display title for sessions
 */

import { appStore } from '../core/store.js';

/**
 * Get the configured dynamic title mode.
 * Returns one of: 'ifUnset' | 'always' | 'never'. Defaults to 'ifUnset'.
 */
export function getDynamicTitleMode() {
    try {
        const mode = appStore.getState('preferences.terminal.dynamicTitleMode');
        if (mode === 'always' || mode === 'never' || mode === 'ifUnset') return mode;
    } catch (_) {}
    return 'ifUnset';
}

/**
 * Compute candidate titles order based on configured mode.
 * @param {Object} sessionData
 * @returns {string[]} array of candidates in priority order
 */
export function getTitleCandidates(sessionData = {}) {
    const explicit = (sessionData.title && String(sessionData.title).trim()) ? sessionData.title : '';
    const dynamic = (sessionData.dynamic_title && String(sessionData.dynamic_title).trim()) ? sessionData.dynamic_title : '';
    const mode = getDynamicTitleMode();
    if (mode === 'always') {
        return [dynamic, explicit].filter(Boolean);
    } else if (mode === 'never') {
        return [explicit].filter(Boolean);
    }
    // ifUnset
    return [explicit, dynamic].filter(Boolean);
}

/**
 * Compute a display title using configured dynamic title mode and fallbacks.
 * @param {Object} sessionData
 * @param {Object} options
 * @param {string[]} [options.fallbackOrder] - keys to try in order as fallback (e.g., ['template_name','command'])
 * @param {string} [options.defaultValue] - final fallback value; defaults to 'Session'
 * @returns {string}
 */
export function computeDisplayTitle(sessionData = {}, options = {}) {
    const fallbackOrder = Array.isArray(options.fallbackOrder) ? options.fallbackOrder : [];
    const defaultValue = Object.prototype.hasOwnProperty.call(options, 'defaultValue') ? options.defaultValue : 'Session';

    // Try configured candidates first
    const primary = getTitleCandidates(sessionData);
    for (const t of primary) {
        if (t && String(t).trim()) return String(t);
    }

    // Try requested fallback fields (prefer badge label when template_name requested)
    const expandedFallback = [];
    for (const key of fallbackOrder) {
        if (key === 'template_name') {
            expandedFallback.push('template_badge_label', 'template_name');
        } else {
            expandedFallback.push(key);
        }
    }
    for (const key of expandedFallback) {
        const val = sessionData && sessionData[key];
        if (val && String(val).trim()) return String(val);
    }

    // Final implicit fallback to badge label or template name if present
    try {
        const lbl = (sessionData && typeof sessionData.template_badge_label === 'string' && sessionData.template_badge_label.trim())
            ? sessionData.template_badge_label.trim()
            : '';
        if (lbl) return lbl;
        const nm = (sessionData && typeof sessionData.template_name === 'string' && sessionData.template_name.trim())
            ? sessionData.template_name.trim()
            : '';
        if (nm) return nm;
    } catch (_) {}

    return String(defaultValue ?? '');
}
