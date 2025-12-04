import { config } from '../core/config.js';

const original = {
  log: console.log?.bind(console) ?? (() => {}),
  info: console.info?.bind(console) ?? console.log?.bind(console) ?? (() => {}),
  debug: console.debug?.bind(console) ?? console.log?.bind(console) ?? (() => {}),
};

const getQueryVerbose = () => {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('verboseLogs') === '1';
  } catch (_) {
    return false;
  }
};

const getStorageVerbose = () => {
  try {
    return window.localStorage?.getItem('tm_verbose_logs') === '1';
  } catch (_) {
    return false;
  }
};

const shouldUseVerbose = () => {
  if (config.DEBUG_FLAGS?.verboseLogs) return true;
  if (config.DEBUG_FLAGS?.wsLogs) return true;
  if (getQueryVerbose()) return true;
  if (getStorageVerbose()) return true;
  return false;
};

const isVerbose = shouldUseVerbose();

// Do not override console methods unless explicitly enabling verbose mode via helper.
// Let the categorized debug router handle gating based on settings.
if (isVerbose) {
  original.info('[Logger] Verbose logging enabled');
}

export const loggerUtils = {
  enableVerbose() {
    try { window.localStorage?.setItem('tm_verbose_logs', '1'); } catch (_) {}
    original.info('[Logger] Verbose logging enabled via loggerUtils.enableVerbose()');
  }
};
