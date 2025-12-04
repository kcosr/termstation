/**
 * Helpers for template-based chat link tabs that use the backend
 * pre-view HTML generation pipeline.
 */

/**
 * Normalize a CSS font-family string:
 * - Trim leading/trailing whitespace
 * - Drop a single pair of surrounding quotes when the entire value is quoted
 *
 * Inner quotes (for multi-word font names) are preserved.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeFontFamilyString(value) {
    if (value == null) return '';
    let out = String(value).trim();
    if (!out) return '';
    const first = out[0];
    const last = out[out.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
        out = out.slice(1, -1).trim();
    }
    return out;
}

/**
 * Compute the effective UI + code fonts for chat link tabs from a combination
 * of CSS variable values and computed fallbacks.
 *
 * - UI font prefers the `--font-ui` CSS variable, falling back to the
 *   computed `font-family` on the body element when missing.
 * - Code font prefers the `--font-code` CSS variable, falling back to the
 *   computed `font-family` of the primary terminal view, and finally to a
 *   known default (typically "monospace") when none are available.
 *
 * All outputs are normalized via `normalizeFontFamilyString`. Empty results
 * are omitted from the returned object; if both are empty, `null` is returned.
 *
 * @param {Object} opts
 * @param {string} [opts.fontUiVar] - Raw value from CSS var --font-ui
 * @param {string} [opts.bodyFontFamily] - Computed font-family for document.body
 * @param {string} [opts.fontCodeVar] - Raw value from CSS var --font-code
 * @param {string} [opts.terminalFontFamily] - Computed font-family for .terminal-view
 * @param {string} [opts.defaultCodeFont] - Fallback when no other code font is available
 * @returns {{ ui?: string, code?: string } | null}
 */
export function computeChatLinkFonts(opts = {}) {
    const {
        fontUiVar,
        bodyFontFamily,
        fontCodeVar,
        terminalFontFamily,
        defaultCodeFont = 'monospace'
    } = opts || {};

    const uiSource = (fontUiVar && String(fontUiVar).trim())
        ? fontUiVar
        : (bodyFontFamily || '');
    const codeSource = (fontCodeVar && String(fontCodeVar).trim())
        ? fontCodeVar
        : (terminalFontFamily && String(terminalFontFamily).trim())
            ? terminalFontFamily
            : (defaultCodeFont || '');

    const ui = normalizeFontFamilyString(uiSource);
    const code = normalizeFontFamilyString(codeSource);

    const out = {};
    if (ui) out.ui = ui;
    if (code) out.code = code;

    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Decide whether a template chat link should be regenerated when its tab
 * becomes active or when the user explicitly refreshes it.
 *
 * @param {Object} opts
 * @param {boolean} opts.hasGeneratedOnce - Whether this link has successfully generated before
 * @param {boolean} opts.refreshOnViewActive - Auto-refresh while the session is active
 * @param {boolean} opts.refreshOnViewInactive - Auto-refresh after the session has terminated
 * @param {boolean} opts.isSessionActive - Current session active state
 * @param {string} [opts.reason] - Optional reason ("view" | "refresh" | "manual")
 * @returns {boolean}
 */
export function shouldRegenerateTemplateLink(opts = {}) {
    const {
        hasGeneratedOnce,
        refreshOnViewActive,
        refreshOnViewInactive,
        isSessionActive,
        reason
    } = opts || {};

    const reasonStr = typeof reason === 'string' ? reason.toLowerCase() : '';

    // Explicit user actions (refresh button or manual trigger) always regenerate.
    if (reasonStr === 'refresh' || reasonStr === 'manual') {
        return true;
    }

    // First view should always generate at least once.
    if (!hasGeneratedOnce) {
        return true;
    }

    // After the first view, respect the active/inactive refresh flags.
    if (isSessionActive) {
        return !!refreshOnViewActive;
    }
    return !!refreshOnViewInactive;
}

/**
 * Normalize an error from the generateLinkHtml endpoint into a simple shape
 * that the UI can render. Attempts to preserve backend-provided { error, details }
 * when available, while remaining compatible with ApiService.parseError.
 *
 * @param {any} error
 * @returns {{ title: string, message: string, details: string }}
 */
export function normalizeTemplateLinkError(error) {
    const base = {
        title: 'Failed to prepare chat view',
        message: '',
        details: ''
    };
    if (!error) return base;

    const ctx = (error && typeof error === 'object' && error.context && typeof error.context === 'object')
        ? error.context
        : {};

    // Prefer explicit backend error string when present
    const msgFromErrorField = typeof error.error === 'string' ? error.error : null;
    let msg = msgFromErrorField
        || (typeof error.message === 'string' ? error.message : '')
        || '';

    if (msgFromErrorField === 'LINK_NOT_FOUND') {
        msg = 'The chat link is no longer available. It may have been removed from the session.';
    }

    // Prefer explicit details field; fall back to context details/error when provided
    let details = '';
    if (typeof error.details === 'string') {
        details = error.details;
    } else if (typeof ctx.details === 'string') {
        details = ctx.details;
    } else if (typeof ctx.error === 'string') {
        details = ctx.error;
    }

    return {
        title: base.title,
        message: msg,
        details
    };
}
