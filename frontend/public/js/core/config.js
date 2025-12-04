/**
 * Frontend Configuration
 * Centralized configuration for API endpoints and settings
 * Configuration is injected from the config system via window globals
 */

import { getSettingsStore } from './settings-store/index.js';
import { getStateStore } from './state-store/index.js';

const normalizeBase = (value) => {
    if (value == null) return '';
    if (typeof value !== 'string') return String(value);
    let normalized = value.trim();
    if (!normalized) return '';
    while (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
};

const toOrigin = (value) => {
    if (!value || typeof value !== 'string') return '';
    try {
        const parsed = new URL(value);
        const proto = String(parsed.protocol || '').toLowerCase();
        if (proto === 'http:' || proto === 'https:') return `${parsed.protocol}//${parsed.host}`;
        // Non-HTTP schemes (e.g., socket://) have no meaningful origin for fetch credentials
        return '';
    } catch (_) {
        return '';
    }
};

const computeOrigins = (apiBaseValue, wsBaseValue) => {
    const normalizedApiBase = normalizeBase(apiBaseValue);
    const normalizedWsBase = normalizeBase(wsBaseValue);
    return {
        apiBaseUrl: normalizedApiBase,
        wsBaseUrl: normalizedWsBase,
        apiOrigin: toOrigin(normalizedApiBase),
        wsOrigin: toOrigin(normalizedWsBase)
    };
};

let cachedOrigins = null;

const isDesktopLocalHttpFrontend = () => {
    try {
        const isElectron = !!(window.desktop && window.desktop.isElectron);
        const loc = window.location;
        if (!isElectron || !loc) return false;
        const proto = String(loc.protocol || '').toLowerCase();
        const host = String(loc.hostname || '').toLowerCase();
        return proto === 'http:' && (host === 'localhost' || host === '127.0.0.1');
    } catch (_) {
        return false;
    }
};

// Get configuration from environment or use defaults
const getConfig = () => {
    // Load saved settings synchronously via abstraction
    let savedSettings = null;
    try {
        const store = getSettingsStore();
        const res = store.loadSync && store.loadSync();
        if (res && res.ok && res.settings) savedSettings = res.settings;
    } catch (error) {
        console.error('[Config] Error loading saved settings:', error);
    }

    // Configuration is injected by the start script from the unified config system.
    // We treat TERMINAL_MANAGER_API_BASE_URL as a non-authoritative default; the
    // user-configured URL in settings (savedSettings.api.customUrl) always wins.
    const TERMINAL_MANAGER_API_BASE_URL = window.TERMINAL_MANAGER_API_BASE_URL || null;
    const savedApiUrl = normalizeBase(savedSettings?.api?.customUrl || '');
    const defaultInjectedApiUrl = normalizeBase(TERMINAL_MANAGER_API_BASE_URL || '');
    const hasSavedApiUrl = !!savedApiUrl;
    const hasInjectedApiDefault = !!defaultInjectedApiUrl;

    // Active auth profile (desktop) may carry a per-profile API URL and proxy preference.
    let activeProfileApiUrl = '';
    let activeProfileUseProxy = false;
    try {
        const ap = savedSettings?.authProfiles || {};
        const items = Array.isArray(ap.items) ? ap.items : [];
        const activeId = (ap && typeof ap.activeId === 'string') ? ap.activeId : '';
        if (activeId && items && items.length) {
            for (let i = 0; i < items.length; i += 1) {
                const p = items[i];
                if (!p || !p.id || p.id !== activeId) continue;
                activeProfileApiUrl = normalizeBase(p.apiUrl || '');
                activeProfileUseProxy = p.useApiProxy === true;
                break;
            }
        }
    } catch (_) {}
    
    // WebSocket configuration - injected from unified config
    const WS_CONFIG = window.TERMINAL_MANAGER_WS_CONFIG || {
        ping_interval_ms: 30000,
        ping_timeout_ms: 10000,
        max_reconnect_delay_ms: 30000,
        reconnect_delay_ms: 1000,
        reconnect_decay: 1.5
    };
    
    // Terminal configuration - injected from unified config. Kept for compatibility
    // with existing exports even though the frontend does not currently use these.
    const TERMINAL_CONFIG = window.TERMINAL_MANAGER_TERMINAL_CONFIG || {
        default_shell: '/bin/bash',
        default_working_dir: '~'
    };
    
    // Effective API base URL:
    // - Prefer user-configured URL from the active auth profile when present
    // - Fall back to saved global URL, then injected default from config.js
    // - Optionally route via a local HTTP proxy when running desktop + local frontend and profile enables it.
    const rawApiBaseCandidate = activeProfileApiUrl || savedApiUrl || defaultInjectedApiUrl || '';
    let apiBaseUrl = rawApiBaseCandidate;
    let wsBaseUrl = rawApiBaseCandidate;
    let apiProxyEnabled = false;

    if (rawApiBaseCandidate) {
        let parsed = null;
        try { parsed = new URL(rawApiBaseCandidate); } catch (_) { parsed = null; }
        const proto = parsed ? String(parsed.protocol || '').toLowerCase() : '';

        const isSocketScheme = (proto === 'socket:' || proto === 'unix:' || proto === 'pipe:');
        const canUseLocalProxy = isDesktopLocalHttpFrontend() && activeProfileUseProxy && proto === 'http:';

        if (canUseLocalProxy) {
            // HTTP API via local proxy; WebSocket connects directly to the backend.
            try {
                const loc = window.location;
                const origin = `${loc.protocol}//${loc.host}`;
                apiBaseUrl = normalizeBase(origin);
                // Derive WS base from the remote API URL so WS does not go through the HTTP proxy.
                try {
                    const apiUrl = parsed || new URL(rawApiBaseCandidate);
                    const wsProtocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
                    wsBaseUrl = `${wsProtocol}//${apiUrl.host}${apiUrl.pathname}`;
                } catch (_) {
                    wsBaseUrl = rawApiBaseCandidate;
                }
                apiProxyEnabled = true;
            } catch (_) {
                apiBaseUrl = rawApiBaseCandidate;
                wsBaseUrl = rawApiBaseCandidate;
                apiProxyEnabled = false;
            }
        } else if (isSocketScheme) {
            // UDS bridge: HTTP and WS both tunnel over the same socket/pipe URL.
            wsBaseUrl = rawApiBaseCandidate;
        } else {
            // Standard HTTP(S) base: derive WS base from protocol/host/path.
            try {
                const apiUrl = parsed || new URL(rawApiBaseCandidate);
                const wsProtocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
                wsBaseUrl = `${wsProtocol}//${apiUrl.host}${apiUrl.pathname}`;
            } catch (_) {
                wsBaseUrl = rawApiBaseCandidate;
            }
        }
    }

    const origins = computeOrigins(apiBaseUrl, wsBaseUrl);
    apiBaseUrl = origins.apiBaseUrl;
    wsBaseUrl = origins.wsBaseUrl;

    // Store default values for the settings UI. These represent the environment-provided
    // default only (TERMINAL_MANAGER_API_BASE_URL), not the user override.
    let defaultApiUrl = defaultInjectedApiUrl;
    let defaultApiPrefix = '';
    if (defaultApiUrl) {
        try {
            const parsed = new URL(defaultApiUrl);
            defaultApiPrefix = parsed.pathname || '';
        } catch (_) {
            defaultApiPrefix = '';
        }
    }
    defaultApiUrl = normalizeBase(defaultApiUrl);
    if (defaultApiPrefix && defaultApiPrefix.length > 1 && defaultApiPrefix.endsWith('/')) {
        defaultApiPrefix = defaultApiPrefix.slice(0, -1);
    }

    // Downloads mapping: { name: url }
    const DOWNLOADS = (() => {
        let map = {};
        try {
            const raw = window.TERMINAL_MANAGER_DOWNLOADS;
            if (typeof raw === 'string') {
                try { map = JSON.parse(raw) || {}; } catch (_) { map = {}; }
            } else if (raw && typeof raw === 'object') {
                map = raw;
            }
        } catch (_) { map = {}; }
        // Ensure only string->string entries
        const cleaned = {};
        try {
            Object.entries(map).forEach(([k, v]) => {
                if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) cleaned[k] = v;
            });
        } catch (_) {}
        return Object.freeze(cleaned);
    })();

    return {
        API_BASE_URL: apiBaseUrl,
        WS_BASE_URL: wsBaseUrl,
        API_ENDPOINTS: {
            SESSIONS: `${apiBaseUrl}/api/sessions`,
            SESSIONS_WITH_HISTORY: `${apiBaseUrl}/api/sessions/history/all`,
            SESSION: (id) => `${apiBaseUrl}/api/sessions/${id}`,
            SESSION_HISTORY: (id) => `${apiBaseUrl}/api/sessions/${id}/history`,
             SESSION_HISTORY_HTML: (id) => `${apiBaseUrl}/api/sessions/${id}/history/html`,
            SESSION_DELETE_HISTORY: (id) => `${apiBaseUrl}/api/sessions/${id}/history`,
            SESSION_RESIZE: (id) => `${apiBaseUrl}/api/sessions/${id}/resize`,
            SEARCH_SESSIONS: `${apiBaseUrl}/api/sessions/search`,
            INFO: `${apiBaseUrl}/api/info`
        },
        WS_ENDPOINT: (clientId) => `${wsBaseUrl}/ws/${clientId}`,
        
        // WebSocket settings - from unified config (no more hardcoded duplicates)
        RECONNECT_DELAY: WS_CONFIG.reconnect_delay_ms,
        MAX_RECONNECT_DELAY: WS_CONFIG.max_reconnect_delay_ms,
        PING_INTERVAL: WS_CONFIG.ping_interval_ms,
        RECONNECT_DECAY: WS_CONFIG.reconnect_decay,
        
        // Terminal settings - from unified config
        DEFAULT_SHELL: TERMINAL_CONFIG.default_shell,
        DEFAULT_WORKING_DIR: TERMINAL_CONFIG.default_working_dir,
        
        // Default configuration values for settings UI
        DEFAULT_API_URL: defaultApiUrl,
        DEFAULT_API_PREFIX: defaultApiPrefix,

        // API configuration metadata (for startup behavior)
        HAS_SAVED_API_URL: hasSavedApiUrl,
        HAS_INJECTED_API_DEFAULT: hasInjectedApiDefault,
        HAS_ANY_API_CONFIG: hasSavedApiUrl || hasInjectedApiDefault,
        
        // Static downloads configured by environment
        DOWNLOADS,

        // Additional metadata for consumers (e.g., desktop proxy awareness)
        REMOTE_API_BASE_URL: rawApiBaseCandidate,
        API_PROXY_ENABLED: apiProxyEnabled,

        // Debug flags (opt-in via injected window.TERMINAL_MANAGER_DEBUG_FLAGS or persisted state)
        DEBUG_FLAGS: (() => {
            let flags = {};
            try { flags = { ...(window.TERMINAL_MANAGER_DEBUG_FLAGS || {}) }; } catch (_) {}
            // Prefer StateStore sync; fallback to localStorage for web
            try {
                const res = getStateStore().loadSync && getStateStore().loadSync();
                const st = res && res.ok ? (res.state || {}) : {};
                const v = st['session_tabs_debug'];
                if (v === true || v === '1' || v === 1) flags.sessionTabsDnD = true;
                const verbose = st['verbose_logs'];
                if (verbose === true || verbose === '1' || verbose === 1) flags.verboseLogs = true;
            } catch (_) {}
            // No direct localStorage access here to keep persistence centralized
            return Object.freeze({
                sessionTabsDnD: Boolean(flags.sessionTabsDnD),
                wsLogs: Boolean(flags.wsLogs),
                verboseLogs: Boolean(flags.verboseLogs)
            });
        })()
    };
};

export const config = getConfig();

export function refreshConfig() {
    const next = getConfig();
    const currentKeys = Object.keys(config);
    for (const key of currentKeys) {
        delete config[key];
    }
    Object.assign(config, next);
    cachedOrigins = null;
    return config;
}

export function getApiOrigins(overrides = {}) {
    const hasOverrides = overrides && (overrides.apiBase || overrides.wsBase);
    if (hasOverrides) {
        return computeOrigins(
            overrides.apiBase ?? config.API_BASE_URL,
            overrides.wsBase ?? config.WS_BASE_URL
        );
    }
    if (!cachedOrigins) {
        cachedOrigins = Object.freeze(computeOrigins(config.API_BASE_URL, config.WS_BASE_URL));
    }
    return cachedOrigins;
}
