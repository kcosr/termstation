import { appStore } from '../../core/store.js';
import { apiService } from '../../services/api.service.js';

export class PasswordResetModal {
  constructor() {
    this.el = document.getElementById('password-reset-modal');
    this.current = document.getElementById('password-reset-current');
    this.newPassword = document.getElementById('password-reset-new');
    this.confirmPassword = document.getElementById('password-reset-confirm');
    this.submit = document.getElementById('password-reset-submit');
    this.cancel = document.getElementById('password-reset-cancel');
    this.error = document.getElementById('password-reset-error');
    this._force = false;
    this._escapeHandler = (e) => {
      if (e.key === 'Escape') {
        if (this._force) {
          e.preventDefault();
          e.stopPropagation();
        } else {
          e.preventDefault();
          e.stopPropagation();
          this.hide();
        }
      }
    };
    this._clickHandler = (e) => {
      if (e.target === this.el) {
        if (this._force) {
          e.preventDefault();
          e.stopPropagation();
        } else {
          e.preventDefault();
          e.stopPropagation();
          this.hide();
        }
      }
    };
  }

  init() {
    if (!this.el) return;
    this.submit?.addEventListener('click', () => this.submitReset());
    this.cancel?.addEventListener('click', (e) => {
      e.preventDefault();
      if (!this._force) this.hide();
    });
    // Enter to submit
    [this.current, this.newPassword, this.confirmPassword].forEach((el) => {
      el?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.submitReset();
        }
      });
    });
  }

  show(options = {}) {
    if (!this.el) return;
    this._force = options && options.force === true;
    if (this.cancel) {
      this.cancel.style.display = this._force ? 'none' : 'inline-block';
    }
    this.showError('');
    if (this.current) this.current.value = '';
    if (this.newPassword) this.newPassword.value = '';
    if (this.confirmPassword) this.confirmPassword.value = '';
    this.el.style.display = 'flex';
    this.el.classList.add('show');
    document.addEventListener('keydown', this._escapeHandler, true);
    this.el.addEventListener('click', this._clickHandler, true);
    setTimeout(() => {
      if (this.current && typeof this.current.focus === 'function') {
        this.current.focus();
      }
    }, 0);
  }

  hide() {
    if (!this.el) return;
    this.el.classList.remove('show');
    this.el.style.display = 'none';
    document.removeEventListener('keydown', this._escapeHandler, true);
    this.el.removeEventListener('click', this._clickHandler, true);
    this._force = false;
  }

  showError(message) {
    if (!this.error) return;
    if (!message) {
      this.error.textContent = '';
      this.error.style.display = 'none';
      return;
    }
    this.error.textContent = message;
    this.error.style.display = 'block';
  }

  async submitReset() {
    try {
      const currentPwd = (this.current?.value || '').trim();
      const newPwd = (this.newPassword?.value || '').trim();
      const confirmPwd = (this.confirmPassword?.value || '').trim();
      if (!currentPwd || !newPwd || !confirmPwd) {
        this.showError('All fields are required');
        return;
      }
      if (newPwd !== confirmPwd) {
        this.showError('New passwords do not match');
        return;
      }
      if (newPwd === currentPwd) {
        this.showError('New password must be different from the current password');
        return;
      }

      let username = '';
      try {
        username = appStore.getState('auth.username') || '';
      } catch (_) {
        username = '';
      }
      if (!username) {
        try {
          const info = appStore.getState('systemInfo') || {};
          if (info && typeof info.current_user === 'string') {
            username = info.current_user;
          }
        } catch (_) {
          username = '';
        }
      }
      if (!username) {
        this.showError('Unable to determine current username');
        return;
      }

      const previousAuth = apiService.headers.Authorization;
      try {
        apiService.setBasicAuth(username, currentPwd);
      } catch (_) {}

      let result = null;
      try {
        result = await apiService.post('/api/user/reset-password', { new_password: newPwd });
      } catch (err) {
        const msg = err && err.message ? String(err.message) : 'Failed to reset password';
        this.showError(msg);
        return;
      } finally {
        // Restore previous Authorization header
        try {
          if (previousAuth) {
            apiService.headers.Authorization = previousAuth;
          } else {
            delete apiService.headers.Authorization;
          }
        } catch (_) {}
      }

      try {
        const nextPrompt = !!(result && result.prompt_for_reset === true);
        appStore.setPath('auth.prompt_for_reset', nextPrompt);
      } catch (_) {}

      this.showError('');
      this.hide();
    } catch (e) {
      const msg = e && e.message ? String(e.message) : 'Failed to reset password';
      this.showError(msg);
    } finally {
      if (this.current) this.current.value = '';
      if (this.newPassword) this.newPassword.value = '';
      if (this.confirmPassword) this.confirmPassword.value = '';
    }
  }
}

export const passwordResetModal = new PasswordResetModal();

