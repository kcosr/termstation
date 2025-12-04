import { BrowserStateStore } from './browser-store.js';
import { DesktopStateStore } from './desktop-store.js';

export function getStateStore() {
  const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test((navigator && navigator.userAgent) || '');
  return isElectron ? DesktopStateStore : BrowserStateStore;
}

