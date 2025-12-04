const DEFAULT_THEME = 'auto';

/**
 * Normalize a persisted theme value.
 * Returns the trimmed string or null when the value is not usable.
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeThemeValue(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed !== '' ? trimmed : null;
}

function getActiveProfileTheme(authProfiles) {
    const data = (authProfiles && typeof authProfiles === 'object') ? authProfiles : {};
    const items = Array.isArray(data.items) ? data.items : [];
    const activeProfileId = typeof data.activeId === 'string' ? data.activeId : '';

    if (!activeProfileId || items.length === 0) {
        return { activeProfileId: activeProfileId || '', profileTheme: null };
    }

    for (let i = 0; i < items.length; i += 1) {
        const profile = items[i];
        if (!profile || profile.id !== activeProfileId) continue;
        const overrides = (profile.overrides && typeof profile.overrides === 'object') ? profile.overrides : {};
        const uiOverrides = (overrides.ui && typeof overrides.ui === 'object') ? overrides.ui : {};
        return {
            activeProfileId,
            profileTheme: normalizeThemeValue(uiOverrides.theme)
        };
    }

    return { activeProfileId, profileTheme: null };
}

/**
 * Extract the stored theme state from a persisted settings object.
 * @param {Object} settings
 * @returns {{globalTheme: string|null, profileTheme: string|null, activeProfileId: string, effectiveTheme: string}}
 */
export function getThemeStateFromSettings(settings) {
    const config = (settings && typeof settings === 'object') ? settings : {};
    const globalTheme = normalizeThemeValue(config?.ui?.theme);
    const { activeProfileId, profileTheme } = getActiveProfileTheme(config.authProfiles);
    const effectiveTheme = normalizeThemeValue(profileTheme || globalTheme) || DEFAULT_THEME;

    return {
        globalTheme,
        profileTheme,
        activeProfileId,
        effectiveTheme
    };
}

/**
 * Resolve the effective theme directly from settings.
 * @param {Object} settings
 * @returns {string}
 */
export function getEffectiveThemeFromSettings(settings) {
    return getThemeStateFromSettings(settings).effectiveTheme;
}

/**
 * Determine which theme values should be persisted given the current selection and scope.
 * @param {Object} params
 * @param {Object} params.prevSettings - Previously saved settings
 * @param {string} params.selectedTheme - Newly selected theme value
 * @param {boolean} params.scopeIsProfile - Whether the save applies to the active profile only
 * @param {string} params.activeProfileId - Currently active profile identifier
 * @returns {{nextGlobalTheme: string, nextProfileTheme: (string|null), effectiveTheme: string, activeProfileId: string}}
 */
export function computeThemePersistence({ prevSettings, selectedTheme, scopeIsProfile, activeProfileId }) {
    const prev = getThemeStateFromSettings(prevSettings);
    const normalizedSelection = normalizeThemeValue(selectedTheme) || DEFAULT_THEME;
    const resolvedProfileId = activeProfileId || prev.activeProfileId || '';
    const hasProfileScope = !!(scopeIsProfile && resolvedProfileId);

    const nextGlobalTheme = hasProfileScope
        ? (prev.globalTheme || DEFAULT_THEME)
        : normalizedSelection;

    const nextProfileTheme = hasProfileScope ? normalizedSelection : null;
    const effectiveTheme = normalizeThemeValue(nextProfileTheme || nextGlobalTheme) || DEFAULT_THEME;

    return {
        nextGlobalTheme,
        nextProfileTheme,
        effectiveTheme,
        activeProfileId: resolvedProfileId
    };
}

/**
 * Update the authProfiles structure with a theme override for the active profile.
 * @param {Object} authProfiles
 * @param {string} activeProfileId
 * @param {string|null} profileTheme
 * @returns {Object|undefined}
 */
export function applyProfileThemeOverride(authProfiles, activeProfileId, profileTheme) {
    if (!activeProfileId) return authProfiles;
    const existing = (authProfiles && typeof authProfiles === 'object') ? authProfiles : null;
    const source = existing || {};
    const items = Array.isArray(source.items) ? source.items : [];
    const normalizedTheme = normalizeThemeValue(profileTheme);

    if (items.length === 0) {
        return authProfiles;
    }

    let updated = false;
    const nextItems = items.map((profile) => {
        if (!profile || profile.id !== activeProfileId) return profile;

        const currentOverrides = (profile.overrides && typeof profile.overrides === 'object') ? profile.overrides : undefined;
        const currentUi = (currentOverrides?.ui && typeof currentOverrides.ui === 'object') ? currentOverrides.ui : undefined;
        const previousTheme = normalizeThemeValue(currentUi?.theme);

        if (normalizedTheme) {
            if (previousTheme === normalizedTheme) {
                return profile;
            }
            const overrides = currentOverrides ? { ...currentOverrides } : {};
            const uiOverrides = currentUi ? { ...currentUi } : {};
            uiOverrides.theme = normalizedTheme;
            overrides.ui = uiOverrides;
            updated = true;
            return { ...profile, overrides };
        }

        if (previousTheme == null) {
            return profile;
        }

        const overrides = currentOverrides ? { ...currentOverrides } : {};
        const uiOverrides = currentUi ? { ...currentUi } : {};
        delete uiOverrides.theme;
        if (Object.keys(uiOverrides).length > 0) {
            overrides.ui = uiOverrides;
        } else if ('ui' in overrides) {
            delete overrides.ui;
        }

        let nextProfile = { ...profile };
        if (Object.keys(overrides).length > 0) {
            nextProfile.overrides = overrides;
        } else if ('overrides' in nextProfile) {
            delete nextProfile.overrides;
        }
        updated = true;
        return nextProfile;
    });

    if (!updated) {
        return authProfiles;
    }

    return {
        ...(source || {}),
        items: nextItems
    };
}
