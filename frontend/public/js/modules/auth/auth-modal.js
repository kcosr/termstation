import { appStore } from '../../core/store.js';
import { config } from '../../core/config.js';
import { settingsManager } from '../settings/settings-manager.js';
import { authOrchestrator } from '../../core/auth-orchestrator.js';
import { iconUtils } from '../../utils/icon-utils.js';

export class AuthModal {
  constructor() {
    this.el = document.getElementById('auth-modal');
    this.username = document.getElementById('auth-modal-username');
    this.password = document.getElementById('auth-modal-password');
    this.submit = document.getElementById('auth-modal-submit');
    this.error = document.getElementById('auth-modal-error');
    this.toggleApiBtn = document.getElementById('auth-toggle-api');
    this.apiPanel = document.getElementById('auth-api-settings');
    this.apiUrl = document.getElementById('auth-api-url');
    this.apiProxyGroup = document.getElementById('auth-api-proxy-group');
    this.apiProxyCheckbox = document.getElementById('auth-api-use-proxy');
    this.apiSave = null;
    this.hashBtn = document.getElementById('auth-generate-hash');
    this.hashOutput = document.getElementById('auth-hash-output');
    this.hashCopyBtn = document.getElementById('auth-hash-copy');
    this.profilesSection = document.getElementById('auth-profiles');
    this.profilesList = document.getElementById('auth-profiles-list');
    this._escapeHandler = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } };
    this._clickHandler = (e) => { if (e.target === this.el) { e.preventDefault(); e.stopPropagation(); } };
  }

  isLocalDesktopHttp() {
    try {
      const loc = window.location || null;
      const isElectron = !!(window.desktop && window.desktop.isElectron);
      const proto = String(loc && loc.protocol || '').toLowerCase();
      const host = String(loc && loc.hostname || '').toLowerCase();
      return isElectron && proto === 'http:' && (host === 'localhost' || host === '127.0.0.1');
    } catch (_) {
      return false;
    }
  }

  init() {
    if (!this.el) return;
    this.submit?.addEventListener('click', () => this.login());
    this.toggleApiBtn?.addEventListener('click', () => this.toggleApiSettings());
    // No explicit save button; API URL saves on successful login
    // Generate password hash for backend users.json
    this.hashBtn?.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const pwd = (this.password?.value || '').trim();
        if (!pwd) {
          if (this.error) { this.error.textContent = 'Enter a password to hash'; this.error.style.display = 'block'; }
          return;
        }
        // Prefer Electron (Node) crypto in desktop for robust hashing
        let line = null;
        try {
          if (window.desktop?.crypto?.generatePasswordHash) {
            const res = await window.desktop.crypto.generatePasswordHash(pwd, 150000, 16, 'sha256');
            if (res && res.ok && res.hash) line = res.hash;
          }
        } catch (_) {}
        if (!line) {
          line = await this.generatePasswordHash(pwd, 150000, 16);
        }
        if (this.hashOutput) {
          this.hashOutput.value = line;
          try { this.hashOutput.select(); document.execCommand('copy'); } catch (_) {}
        }
      } catch (err) {
        if (this.error) { this.error.textContent = 'Failed to generate hash'; this.error.style.display = 'block'; }
      }
    });
    // Copy button handler
    this.hashCopyBtn?.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const val = (this.hashOutput?.value || '').trim();
        if (!val) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(val);
        } else {
          // Fallback
          this.hashOutput?.select?.();
          document.execCommand('copy');
        }
        this.showCopiedTooltip(this.hashCopyBtn);
      } catch (_) {}
    });
    // Enter to submit
    const enterToSubmitFields = [this.username, this.password, this.apiUrl];
    enterToSubmitFields.forEach((el) => {
      el?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!this.submit?.disabled) this.login();
        }
      });
    });
    const syncSubmitState = () => this.updateSubmitState();
    enterToSubmitFields.forEach((el) => {
      el?.addEventListener('input', syncSubmitState);
      el?.addEventListener('change', syncSubmitState);
    });
    // Prefill API inputs from store
    try {
      const st = appStore.getState();
      if (this.username) this.username.value = st?.auth?.username || '';
      if (this.apiUrl) {
        const saved = (st?.api?.customUrl || '').trim();
        this.apiUrl.value = saved || config.DEFAULT_API_URL || config.API_BASE_URL || '';
      }
      // Initialize proxy checkbox (desktop + local HTTP frontend only)
      try {
        const isLocalHttp = this.isLocalDesktopHttp();
        if (this.apiProxyGroup) {
          this.apiProxyGroup.style.display = isLocalHttp ? 'block' : 'none';
        }
        if (isLocalHttp && this.apiProxyCheckbox) {
          // Seed from active profile, falling back to saved api setting if present
          (async () => {
            try {
              const { profileManager } = await import('../../utils/profile-manager.js');
              const active = await profileManager.getActive();
              if (active && typeof active.useApiProxy === 'boolean') {
                this.apiProxyCheckbox.checked = !!active.useApiProxy;
              } else if (st && st.api && typeof st.api.useApiProxy === 'boolean') {
                this.apiProxyCheckbox.checked = !!st.api.useApiProxy;
              }
            } catch (_) { /* non-fatal */ }
          })();
        }
      } catch (_) {}
      // Hide hash UI if not available in this environment
      try {
        let hashAvailable = false;
        if (window.desktop?.crypto?.generatePasswordHash) {
          hashAvailable = true;
        } else if (window.isSecureContext && window.crypto && window.crypto.subtle) {
          hashAvailable = true;
        }
        if (!hashAvailable) {
          try {
            const hbGroup = (this.hashBtn && typeof this.hashBtn.closest === 'function') ? this.hashBtn.closest('.form-group') : null;
            if (hbGroup) hbGroup.style.display = 'none';
          } catch (_) {}
          try {
            const hoGroup = (this.hashOutput && typeof this.hashOutput.closest === 'function') ? this.hashOutput.closest('.form-group') : null;
            if (hoGroup) hoGroup.style.display = 'none';
          } catch (_) {}
          try { this.hashCopyBtn?.style && (this.hashCopyBtn.style.display = 'none'); } catch (_) {}
        }
      } catch (_) {}
    } catch (_) {}
    this.updateSubmitState();
    // Render saved profiles list (under API settings)
    try { this.renderProfiles(); } catch (_) {}
  }

  show(options = {}) {
    if (!this.el) return;
    const expandApiSettings = options && options.expandApiSettings === true;
    this.error && (this.error.style.display = 'none');
    let hasPrefilledUsername = false;
    try {
      const st = appStore.getState();
      if (this.username && st?.auth) {
        this.username.value = st.auth.username || '';
        hasPrefilledUsername = !!(this.username.value && this.username.value.trim());
      }
      // Ensure proxy checkbox reflects the active profile whenever the modal is shown
      try {
        const isLocalHttp = this.isLocalDesktopHttp();
        if (this.apiProxyGroup) {
          this.apiProxyGroup.style.display = isLocalHttp ? 'block' : 'none';
        }
        if (this.apiProxyCheckbox) {
          if (!isLocalHttp) {
            this.apiProxyCheckbox.checked = false;
          } else {
            (async () => {
              try {
                const { profileManager } = await import('../../utils/profile-manager.js');
                const active = await profileManager.getActive();
                if (active && typeof active.useApiProxy === 'boolean') {
                  this.apiProxyCheckbox.checked = !!active.useApiProxy;
                } else if (st && st.api && typeof st.api.useApiProxy === 'boolean') {
                  this.apiProxyCheckbox.checked = !!st.api.useApiProxy;
                } else {
                  this.apiProxyCheckbox.checked = false;
                }
              } catch (_) {
                this.apiProxyCheckbox.checked = false;
              }
            })();
          }
        }
      } catch (_) {}
    } catch (_) {}
    // Use flex to activate centering rules from .modal.show
    this.el.style.display = 'flex';
    this.el.classList.add('show');
    document.addEventListener('keydown', this._escapeHandler, true);
    this.el.addEventListener('click', this._clickHandler, true);
    try {
      const theme = appStore.getState('ui')?.theme;
      if (theme) {
        requestAnimationFrame(() => {
          try { settingsManager.applyTheme(theme); } catch (_) {}
        });
      }
    } catch (_) {}
    this.updateSubmitState();
    if (expandApiSettings) {
      try { this.showApiSettings(); } catch (_) {}
    }
    setTimeout(() => {
      if (hasPrefilledUsername) {
        if (this.password && typeof this.password.focus === 'function') {
          this.password.focus();
          return;
        }
      }
      this.username?.focus();
    }, 0);
  }

  hide() {
    if (!this.el) return;
    this.el.classList.remove('show');
    this.el.style.display = 'none';
    document.removeEventListener('keydown', this._escapeHandler, true);
    this.el.removeEventListener('click', this._clickHandler, true);
  }

  toggleApiSettings() {
    if (!this.apiPanel) return;
    const visible = this.apiPanel.style.display !== 'none';
    if (visible) {
      this.apiPanel.style.display = 'none';
    } else {
      this.showApiSettings();
    }
  }

  showApiSettings() {
    if (!this.apiPanel) return;
    this.apiPanel.style.display = 'block';
    try { this.renderProfiles(); } catch (_) {}
  }

  // Removed explicit save method; API URL persists after successful login

  updateSubmitState() {
    try {
      const uname = (this.username?.value || '').trim();
      const pwd = (this.password?.value || '').trim();
      const api = (this.apiUrl?.value || '').trim();
      if (this.submit) {
        this.submit.disabled = !(uname && pwd && api);
      }
    } catch (_) {}
  }

  async generatePasswordHash(password, iterations = 150000, saltBytes = 16) {
    const enc = new TextEncoder();
    const salt = new Uint8Array(saltBytes);
    const webCrypto = (window.crypto && window.crypto.subtle) ? window.crypto : (self.crypto && self.crypto.subtle ? self.crypto : null);
    if (!webCrypto || !webCrypto.subtle || !window.isSecureContext) {
      throw new Error('PBKDF2 requires a secure context or desktop app');
    }
    (window.crypto || self.crypto).getRandomValues(salt);
    const passKey = await webCrypto.subtle.importKey(
      'raw',
      enc.encode(String(password)),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const bits = await webCrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, passKey, 32 * 8);
    const hash = new Uint8Array(bits);
    const toHex = (buf) => Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
    const saltHex = toHex(salt);
    const hashHex = toHex(hash);
    return `pbkdf2$${iterations}$${saltHex}$${hashHex}`;
  }

  showCopiedTooltip(anchorEl) {
    try {
      if (!anchorEl || typeof anchorEl.getBoundingClientRect !== 'function') return;
      const rect = anchorEl.getBoundingClientRect();
      const tip = document.createElement('div');
      tip.textContent = 'Copied';
      tip.style.position = 'fixed';
      tip.style.zIndex = '2147483647';
      tip.style.padding = '2px 6px';
      tip.style.borderRadius = '4px';
      tip.style.border = '1px solid var(--border-color)';
      tip.style.background = 'var(--bg-secondary)';
      tip.style.color = 'var(--text-primary)';
      tip.style.fontSize = '12px';
      tip.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
      tip.style.pointerEvents = 'none';
      tip.style.opacity = '0';
      tip.style.transition = 'opacity 120ms ease-out, transform 120ms ease-out';
      const top = Math.max(0, rect.top - 28);
      const left = Math.max(0, rect.left + rect.width/2 - 20);
      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
      document.body.appendChild(tip);
      // Force reflow then animate
      // eslint-disable-next-line no-unused-expressions
      tip.offsetHeight;
      tip.style.opacity = '1';
      tip.style.transform = 'translateY(-2px)';
      setTimeout(() => {
        tip.style.opacity = '0';
        tip.style.transform = 'translateY(-6px)';
        setTimeout(() => { try { tip.remove(); } catch (_) {} }, 180);
      }, 900);
    } catch (_) {}
  }

  async login() {
    const uname = (this.username?.value || '').trim();
    const pwd = (this.password?.value || '').trim();
    const enteredApiUrl = (this.apiUrl?.value || '').trim();
    const useLocalProxy = !!(this.apiProxyCheckbox && this.apiProxyCheckbox.checked);
    if (!uname || !pwd) return;

    // Gate socket:// usage to Electron desktop where the UDS bridge is available
    try {
      const isSocket = /^\s*(socket|unix|pipe):\/\//i.test(enteredApiUrl);
      const hasBridge = !!(window.desktop && window.desktop.http && typeof window.desktop.http.request === 'function');
      if (isSocket && !hasBridge) {
        if (this.error) {
          this.error.textContent = 'socket:// is only supported in the desktop app.';
          this.error.style.display = 'block';
        }
        return;
      }
    } catch (_) {}

    try {
      this.error && (this.error.style.display = 'none');
      await authOrchestrator.login({ username: uname, password: pwd, apiUrl: enteredApiUrl, useLocalProxy });
      this.hide();
      if (this.password) {
        this.password.value = '';
      }
    } catch (e) {
      try { console.error('[AuthModal] Login failed:', e); } catch (_) {}
      if (this.error) {
        // Friendlier message when the local proxy cannot be configured
        if (e && e.code === 'PROXY_CONFIG_FAILED') {
          const url = (enteredApiUrl || '').trim() || '(missing API URL)';
          this.error.textContent = `Login failed: unable to start local API proxy. Check that ${url} is reachable from this machine or try disabling the proxy checkbox.`;
          this.error.style.display = 'block';
          return;
        }
        const status = (e && typeof e.status === 'number') ? e.status : null;
        const statusText = (e && e.statusText) ? String(e.statusText) : '';
        const msgText = (e && e.message) ? String(e.message) : '';

        // Detect network fetch failure (no HTTP response)
        const isNetworkError = (!status && /Failed to fetch/i.test(msgText));
        let details = '';
        if (msgText && !isNetworkError) {
          // Prioritize server message over HTTP status code
          details = msgText;
        } else if (status) {
          details = `HTTP ${status}${statusText ? ' ' + statusText : ''}`;
        } else if (isNetworkError) {
          const url = enteredApiUrl || (window?.location?.origin || '');
          details = `Network error (no response) – could not reach ${url}`;
        } else {
          details = 'Unknown error';
        }

        this.error.textContent = `Login failed: ${details}`;
        this.error.style.display = 'block';
      }
    } finally {
      this.updateSubmitState();
    }
  }

  async renderProfiles() {
    try {
      if (!this.profilesList) return;
      const { profileManager } = await import('../../utils/profile-manager.js');
      const list = await profileManager.list();
      const activeId = await profileManager.getActiveId();
      this.profilesList.innerHTML = '';
      if (!list.length) {
        const none = document.createElement('div');
        none.className = 'form-help';
        none.textContent = 'No saved profiles';
        this.profilesList.appendChild(none);
        return;
      }
      const makeRow = (p) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.justifyContent = 'space-between';
        row.style.gap = '6px';

        const label = document.createElement('div');
        label.textContent = (p.label || `${p.username || ''}@${p.apiUrl}`).replace(/^@/, '');
        label.style.flex = '1 1 auto';
        if (p.id === activeId) {
          label.style.fontWeight = '600';
          label.title = 'Active profile';
        }

        const useBtn = document.createElement('button');
        useBtn.className = 'btn btn-secondary';
        useBtn.textContent = 'Use';
        useBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            if (this.username) this.username.value = p.username || '';
            if (this.apiUrl) this.apiUrl.value = p.apiUrl || '';
            await (await import('../../utils/profile-manager.js')).profileManager.setActive(p.id);
            // Sync proxy checkbox with selected profile
            try {
              const isLocalHttp = this.isLocalDesktopHttp();
              if (this.apiProxyGroup) {
                this.apiProxyGroup.style.display = isLocalHttp ? 'block' : 'none';
              }
              if (isLocalHttp && this.apiProxyCheckbox) {
                this.apiProxyCheckbox.checked = !!p.useApiProxy;
              }
            } catch (_) {}
            this.updateSubmitState();
          } catch (_) {}
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'btn-icon';
        delBtn.title = 'Delete profile';
        try { delBtn.appendChild(iconUtils.createIcon('trash-2', { size: 16, color: '#dc3545' })); } catch (_) {}
        delBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            const group = document.createElement('div');
            group.style.display = 'flex';
            group.style.alignItems = 'center';
            group.style.gap = '6px';

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'btn-icon';
            confirmBtn.title = 'Confirm delete';
            confirmBtn.appendChild(iconUtils.createIcon('check', { size: 16, color: '#28a745' }));

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn-icon';
            cancelBtn.title = 'Cancel';
            cancelBtn.appendChild(iconUtils.createIcon('x', { size: 16, color: '#6c757d' }));

            const restore = () => {
              try { row.removeChild(group); } catch (_) {}
              try { row.appendChild(useBtn); } catch (_) {}
              try { row.appendChild(delBtn); } catch (_) {}
            };

            confirmBtn.addEventListener('click', async (ev) => {
              ev.preventDefault();
              try {
                confirmBtn.disabled = true; cancelBtn.disabled = true;
                await (await import('../../utils/profile-manager.js')).profileManager.remove(p.id);
                await this.renderProfiles();
              } catch (_) {
                confirmBtn.disabled = false; cancelBtn.disabled = false;
              }
            });
            cancelBtn.addEventListener('click', (ev) => { ev.preventDefault(); restore(); });

            // Swap buttons
            try { row.removeChild(useBtn); } catch (_) {}
            try { row.removeChild(delBtn); } catch (_) {}
            group.appendChild(confirmBtn);
            group.appendChild(cancelBtn);
            row.appendChild(group);
          } catch (_) {}
        });

        row.appendChild(label);
        row.appendChild(useBtn);
        row.appendChild(delBtn);
        this.profilesList.appendChild(row);
      };
      // Active first, others below
      const active = list.find(x => x.id === activeId);
      if (active) makeRow(active);
      list.filter(x => x.id !== activeId).forEach(makeRow);
    } catch (e) {
      try { console.warn('[AuthModal] Failed to render profiles:', e); } catch (_) {}
    }
  }

}

export const authModal = new AuthModal();
