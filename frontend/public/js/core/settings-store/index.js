import { BrowserSettingsStore } from './browser-store.js';
import { DesktopSettingsStore } from './desktop-store.js';

export function getSettingsStore() {
  const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test((navigator && navigator.userAgent) || '');
  return isElectron ? DesktopSettingsStore : BrowserSettingsStore;
}

