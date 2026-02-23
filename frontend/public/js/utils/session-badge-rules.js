import { appStore } from '../core/store.js';

const SESSION_BADGE_DEFAULTS = {
    enabled: false,
    rules: []
};

let _compiledRulesCacheKey = null;
let _compiledRulesCacheValue = [];

function coerceBoolDefaultFalse(value) {
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
        if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
    }
    return false;
}

function normalizeRule(rule, index = 0) {
    const src = (rule && typeof rule === 'object') ? rule : {};
    const id = (typeof src.id === 'string' && src.id.trim()) ? src.id.trim() : `rule-${index + 1}`;
    const pattern = (typeof src.pattern === 'string') ? src.pattern.trim() : '';
    const badgeText = (typeof src.badgeText === 'string') ? src.badgeText.trim() : '';
    const color = (typeof src.color === 'string') ? src.color.trim() : '';
    return {
        id,
        enabled: src.enabled !== false,
        pattern,
        badgeText,
        color
    };
}

export function normalizeSessionBadgePreferences(rawPrefs) {
    const src = (rawPrefs && typeof rawPrefs === 'object') ? rawPrefs : {};
    const rawRules = Array.isArray(src.rules) ? src.rules : [];
    return {
        enabled: coerceBoolDefaultFalse(src.enabled),
        rules: rawRules.map((rule, index) => normalizeRule(rule, index)).filter((rule) => !!rule.pattern)
    };
}

export function createDefaultSessionBadgeRule() {
    return {
        id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        enabled: true,
        pattern: '',
        badgeText: '',
        color: '#f5f5f5'
    };
}

export function getSessionBadgePreferences() {
    try {
        const raw = appStore.getState('preferences.sessionBadges');
        return normalizeSessionBadgePreferences(raw);
    } catch (_) {
        return { ...SESSION_BADGE_DEFAULTS };
    }
}

function toRegex(pattern) {
    const raw = String(pattern || '').trim();
    if (!raw) return null;

    let source = raw;
    const delimited = raw.match(/^\/([\s\S]+)\/[a-z]*$/i);
    if (delimited && delimited[1]) {
        source = delimited[1];
    }

    try {
        return new RegExp(source, 'i');
    } catch (_) {
        return null;
    }
}

function compileRules(rules = []) {
    const key = JSON.stringify(rules);
    if (key === _compiledRulesCacheKey) {
        return _compiledRulesCacheValue;
    }
    const compiled = rules.map((rule) => {
        const regex = toRegex(rule.pattern);
        if (!regex) return null;
        return { ...rule, regex };
    }).filter(Boolean);
    _compiledRulesCacheKey = key;
    _compiledRulesCacheValue = compiled;
    return compiled;
}

export function resolveSessionBadgeRule(sessionData = {}, options = {}) {
    try {
        if (!sessionData || typeof sessionData !== 'object') return null;
        // Scope: remote sessions only.
        if (sessionData.local_only === true) return null;

        // Match against the same precedence users expect in session naming:
        // explicit static title first, then dynamic terminal title.
        const staticTitle = (typeof sessionData.title === 'string')
            ? sessionData.title.trim()
            : '';
        const dynamicTitle = (typeof sessionData.dynamic_title === 'string')
            ? sessionData.dynamic_title.trim()
            : '';
        const matchSource = staticTitle || dynamicTitle;
        if (!matchSource) return null;

        const prefs = normalizeSessionBadgePreferences(
            options.preferences || getSessionBadgePreferences()
        );
        if (!prefs.enabled) return null;

        const compiled = compileRules(prefs.rules);
        for (const rule of compiled) {
            if (!rule.enabled) continue;
            const match = matchSource.match(rule.regex);
            if (!match) continue;

            let label = rule.badgeText;
            if (!label && typeof match[1] === 'string' && match[1].trim()) {
                label = match[1].trim();
            }
            if (!label) continue;

            return {
                id: rule.id,
                pattern: rule.pattern,
                label,
                color: rule.color || ''
            };
        }
    } catch (_) {
        // ignore
    }
    return null;
}
