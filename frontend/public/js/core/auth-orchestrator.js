import { apiService } from '../services/api.service.js';
import { appStore } from './store.js';
import { authSession } from '../utils/auth-session.js';
import { config, refreshConfig, getApiOrigins } from './config.js';
import { profileManager } from '../utils/profile-manager.js';
import { clearSessionCookieForOrigin } from '../utils/cookie-utils.js';

class AuthOrchestrator {
  constructor() {
    this.app = null;
  }

  initialize(app) {
    this.app = app;
  }

  async startInitialFlow() {
    if (!this.app) {
      throw new Error('AuthOrchestrator not initialized with application instance');
    }

    const { apiBaseUrl } = getApiOrigins();
    try {
      const res = await authSession.restoreCookies(apiBaseUrl);
      // Electron cookie restore can be async wrt fetch/XHR cookie jar; allow brief sync time
      try {
        const isElectron = !!(window.desktop && window.desktop.isElectron) || /electron/i.test(navigator.userAgent || '');
        if (isElectron && res && res.ok) {
          await new Promise((r) => setTimeout(r, 150));
        }
      } catch (_) {}
    } catch (_) {}
    try {
      // Give extra time for cookie availability before retrying /api/info
      apiService.scheduleInfoRetryOnce(250);
    } catch (_) {}

    const initResult = await this.app.initServerConnection();
    await this.app.runBootPipeline(initResult);
  }

  async login({ username, password, apiUrl, useLocalProxy }) {
    if (!this.app) {
      throw new Error('AuthOrchestrator not initialized with application instance');
    }

    const trimmedUsername = (username || '').trim();
    const trimmedPassword = (password || '').trim();
    const trimmedApiUrl = (apiUrl || '').trim();

    if (!trimmedUsername || !trimmedPassword) {
      throw new Error('Missing credentials');
    }

    const originalBase = apiService.baseUrl;
    try {
      // Decide the remote API base URL for the login call.
      const targetApiUrl = trimmedApiUrl || originalBase || config.API_BASE_URL || '';

      const loc = window.location || null;
      const isElectron = !!(window.desktop && window.desktop.isElectron);
      const proto = String(loc && loc.protocol || '').toLowerCase();
      const host = String(loc && loc.hostname || '').toLowerCase();
      const isLocalHttp = isElectron && proto === 'http:' && (host === 'localhost' || host === '127.0.0.1');

      let parsed = null;
      try { parsed = new URL(targetApiUrl); } catch (_) { parsed = null; }
      const apiProto = parsed ? String(parsed.protocol || '').toLowerCase() : '';

      const wantProxyForLogin = !!(useLocalProxy && isLocalHttp && apiProto === 'http:');

      if (wantProxyForLogin && window.desktop && window.desktop.apiProxy && typeof window.desktop.apiProxy.setTarget === 'function') {
        const res = await window.desktop.apiProxy.setTarget(targetApiUrl);
        if (!res || !res.ok || res.enabled !== true) {
          const msg = (res && res.error) ? String(res.error) : 'failed-to-configure-proxy';
          const err = new Error(`Failed to configure local API proxy: ${msg}`);
          err.code = 'PROXY_CONFIG_FAILED';
          throw err;
        }
        const origin = `${loc.protocol}//${loc.host}`;
        apiService.baseUrl = origin;
      } else if (targetApiUrl) {
        // No proxy: talk directly to the backend
        apiService.baseUrl = targetApiUrl;
      }

      apiService.setBasicAuth(trimmedUsername, trimmedPassword);

      const serverInfo = await apiService.getInfo();
      apiService.setAuthenticated(true);

      try {
        appStore.setState({ systemInfo: serverInfo });
      } catch (_) {}
      try {
        appStore.setPath('auth.username', trimmedUsername);
      } catch (_) {}

      // After a successful login, keep proxyEnabled consistent with what we used.
      const proxyEnabled = !!wantProxyForLogin;

      await this.persistSettingsAfterLogin({
        apiUrl: targetApiUrl,
        username: trimmedUsername,
        useLocalProxy: proxyEnabled
      });

      try {
        const { apiBaseUrl: persistedBase } = getApiOrigins();
        await authSession.saveCookies(persistedBase);
      } catch (_) {}

      try {
        apiService.setBasicAuth('', '');
      } catch (_) {}

      authSession.setLoggedIn(true);

      await this.bootWithKnownInfo(serverInfo);
    } catch (error) {
      apiService.setBasicAuth('', '');
      apiService.baseUrl = originalBase;
      throw error;
    }
  }

  async persistSettingsAfterLogin({ apiUrl, username, useLocalProxy }) {
    try {
      const { getSettingsStore } = await import('./settings-store/index.js');
      const store = getSettingsStore();
      if (apiUrl) {
        appStore.setState({ api: { customUrl: apiUrl, customPrefix: '', useApiProxy: !!useLocalProxy } });
      }
      const current = appStore.getState();
      // Merge with existing settings to preserve keys like authProfiles
      let existing = {};
      try { existing = (await store.load()) || {}; } catch (_) {}
      const merged = {
        ...existing,
        preferences: current.preferences,
        ui: { theme: current.ui?.theme },
        api: current.api,
        auth: { username: current.auth?.username || username || '' }
      };
      await store.save(merged);
      try {
        await profileManager.upsert({
          username: username || current.auth?.username || '',
          apiUrl: apiUrl || current.api?.customUrl || config.API_BASE_URL,
          useApiProxy: !!useLocalProxy
        });
      } catch (_) {}
      refreshConfig();
      apiService.baseUrl = config.API_BASE_URL;
    } catch (_) {}
  }

  async switchProfile(profileId) {
    if (!this.app) {
      throw new Error('AuthOrchestrator not initialized with application instance');
    }
    const profiles = await profileManager.list();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error('Profile not found');

    // Persist a short-lived hint so the next load can show a profile switch toast
    try {
      const label = (() => {
        try {
          if (profile.label && profile.label.trim()) return profile.label.trim();
        } catch (_) {}
        const uname = (profile.username || '').trim();
        const url = (profile.apiUrl || '').trim();
        if (uname && url) return `${uname}@${url}`;
        if (uname) return uname;
        if (url) return url;
        return '';
      })();
      const payload = {
        id: profile.id,
        label,
        username: profile.username || '',
        apiUrl: profile.apiUrl || '',
        ts: Date.now()
      };
      try {
        window.sessionStorage.setItem('ts_profile_switch_toast', JSON.stringify(payload));
      } catch (_) { /* non-fatal */ }
    } catch (_) { /* non-fatal */ }

    try { await profileManager.setActive(profileId); } catch (_) {}
    try {
      appStore.setState({
        api: {
          customUrl: profile.apiUrl,
          customPrefix: '',
          useApiProxy: !!profile.useApiProxy
        }
      });
    } catch (_) {}

    // Persist selection to settings so a reload uses the new profile
    try {
      const { getSettingsStore } = await import('./settings-store/index.js');
      const store = getSettingsStore();
      let existing = {};
      try { existing = (await store.load()) || {}; } catch (_) {}
      existing.api = { customUrl: profile.apiUrl, customPrefix: '', useApiProxy: !!profile.useApiProxy };
      existing.auth = { username: profile.username || '' };
      await store.save(existing);
    } catch (_) {}

    // Restore cookies for the new profile (desktop) and validate pre-reload.
    // Use the effective API base (which may point at the local proxy) so cookie origin matches.
    try {
      const { apiBaseUrl } = getApiOrigins();
      await authSession.restoreCookies(apiBaseUrl);
    } catch (_) {}

    // Refresh config + base URL and verify cookie works before reload
    refreshConfig();
    apiService.baseUrl = config.API_BASE_URL;
    let cookieValid = false;
    try {
      const info = await apiService.getInfo({ retryOn401: true, retryDelayMs: 150 });
      if (info && (info.current_user || info.version)) cookieValid = true;
    } catch (_) { cookieValid = false; }

    // Small delay to allow Electron cookie writes to flush
    try { await new Promise(r => setTimeout(r, 250)); } catch (_) {}

    // Reload the app to fully switch context (same behavior as logout)
    try {
      const isDesktop = !!(window.desktop && window.desktop.isElectron);
      if (isDesktop && window.desktop?.reloadWindow) {
        await window.desktop.reloadWindow();
      } else {
        window.location.reload();
      }
    } catch (_) {}

    return { ok: true, reloaded: true };
  }

  async bootWithKnownInfo(serverInfo) {
    const initResult = await this.app.initServerConnection({
      serverInfo,
      authRequired: Boolean(serverInfo && serverInfo.auth_enabled)
    });
    await this.app.runBootPipeline(initResult);
  }

  async logout() {
    if (!this.app) {
      throw new Error('AuthOrchestrator not initialized with application instance');
    }

    try { await apiService.post('/api/auth/logout', {}); } catch (_) {}

    // Clear any runtime desktop API proxy target so a subsequent login
    // starts from a clean state; per-profile useApiProxy remains persisted.
    try {
      if (window.desktop && window.desktop.apiProxy && typeof window.desktop.apiProxy.setTarget === 'function') {
        window.desktop.apiProxy.setTarget('');
      }
    } catch (_) {}

    // Clear persisted cookies in Electron and browser cookie when same-origin
    try {
      const { apiBaseUrl, apiOrigin } = getApiOrigins();
      try { await authSession.clearCookies(apiBaseUrl); } catch (_) {}
      try { clearSessionCookieForOrigin(apiOrigin || window.location.origin); } catch (_) {}
    } catch (_) {}

    apiService.setBasicAuth('', '');
    apiService.setAuthenticated(false);

    try {
      authSession.setLoggedIn(false);
    } catch (_) {}

    try {
      const currentInfo = appStore.getState('systemInfo') || {};
      appStore.setState({ systemInfo: { ...currentInfo, current_user: '' } });
    } catch (_) {}

    await this.app.handleLogoutCleanup();
  }
}

export const authOrchestrator = new AuthOrchestrator();
