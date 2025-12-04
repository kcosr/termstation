/**
 * termstation Frontend Configuration
 * Environment: default (production)
 */

// Basic connection configuration (environment label only)
window.TERMINAL_MANAGER_ENVIRONMENT = 'prod';

// Downloads mapping (can be overridden via environment injection)
window.TERMINAL_MANAGER_DOWNLOADS = {
    'Android': 'https://termstation/TermStation.apk',
    'MacOS': 'https://termstation/TermStation.dmg',
    'Windows': 'https://termstation/TermStation.msi',
    'Linux': 'https://termstation/TermStation.AppImage'
};

// WebSocket configuration
window.TERMINAL_MANAGER_WS_CONFIG = {
    ping_interval_ms: 900000,
    max_reconnect_delay_ms: 30000,
    reconnect_delay_ms: 1000,
    reconnect_decay: 1.5
};

// Debug flags (optional; keep disabled in prod by default)
window.TERMINAL_MANAGER_DEBUG_FLAGS = {
    sessionTabsDnD: false,
    wsLogs: false
};
