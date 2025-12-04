import { appStore } from '../../core/store.js';
import { settingsManager } from '../settings/settings-manager.js';
import { authOrchestrator } from '../../core/auth-orchestrator.js';
import { getApiOrigins, config } from '../../core/config.js';
import { profileManager } from '../../utils/profile-manager.js';
import { dropdownBackdrop } from '../../utils/dropdown-backdrop.js';

export class UserMenu {
    constructor() {
        this.elements = {
            container: document.getElementById('user-menu-container'),
            button: document.getElementById('user-menu-btn'),
            dropdown: document.getElementById('user-menu-dropdown'),
            username: document.getElementById('user-menu-username'),
            login: document.getElementById('user-menu-login'),
            logout: document.getElementById('user-menu-logout'),
            resetPassword: document.getElementById('user-menu-reset-password'),
            avatar: document.getElementById('user-menu-avatar'),
            loginPanel: document.getElementById('user-menu-login-panel'),
            loginUsername: document.getElementById('user-menu-username-input'),
            loginPassword: document.getElementById('user-menu-password-input'),
            loginSubmit: document.getElementById('user-menu-submit-login')
        };
        this.boundOutsideHandler = null;
        this._backdropCloser = null;
    }

    init() {
        if (!this.elements.button || !this.elements.dropdown) return;

        // Prevent clicks/touches within the dropdown from bubbling to the terminal (mobile safety)
        if (this.elements.dropdown) {
            const stopProp = (e) => { try { e.stopPropagation(); } catch (_) {} };
            ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'touchmove'].forEach((type) => {
                this.elements.dropdown.addEventListener(type, stopProp, false);
            });
        }

        // Setup toggle
        this.elements.button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isOpen = this.elements.dropdown.classList.contains('show');
            if (isOpen) {
                this.closeDropdown();
            } else {
                this.openDropdown();
            }
        });

        // Actions
        this.elements.login?.addEventListener('click', async () => {
            try { (await import('../auth/auth-modal.js')).authModal.show(); } catch (_) {}
        });
        this.elements.logout?.addEventListener('click', () => this.logout());
        this.elements.resetPassword?.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                const mod = await import('../auth/password-reset-modal.js');
                if (mod && mod.passwordResetModal && typeof mod.passwordResetModal.show === 'function') {
                    mod.passwordResetModal.show({ force: false });
                }
            } catch (_) {}
        });
        // Open Settings from dropdown header
        try {
            const openBtn = document.getElementById('user-menu-open-settings');
            openBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeDropdown();
                settingsManager.openModal();
            });
        } catch (_) {}
        // Inline login removed; use blocking auth modal

        // Initial render and subscribe to updates
        this.render();
        this.renderProfiles();
        try {
            appStore.subscribe('systemInfo', () => this.render());
            appStore.subscribe('auth.features', () => this.render());
        } catch (_) {}
        // Periodically refresh profiles list when dropdown opens
        try {
            this.elements.button?.addEventListener('click', async () => {
                await this.renderProfiles();
            });
        } catch (_) {}
    }

    openDropdown() {
        this.elements.dropdown.classList.add('show');
        this.elements.button.setAttribute('aria-expanded', 'true');
        this.installOutsideHandler();
        // Show backdrop to prevent clicks from reaching terminal
        if (!this._backdropCloser) {
            this._backdropCloser = () => this.closeDropdown();
        }
        dropdownBackdrop.show(this._backdropCloser);
    }

    closeDropdown() {
        this.elements.dropdown.classList.remove('show');
        this.elements.button.setAttribute('aria-expanded', 'false');
        this.removeOutsideHandler();
        // Hide backdrop
        if (this._backdropCloser) {
            dropdownBackdrop.hide(this._backdropCloser);
        }
    }

    installOutsideHandler() {
        if (this.boundOutsideHandler) return;
        this.boundOutsideHandler = (ev) => {
            const t = ev.target;
            if (!this.elements.container.contains(t)) {
                this.closeDropdown();
            }
        };
        document.addEventListener('click', this.boundOutsideHandler);
    }

    removeOutsideHandler() {
        if (this.boundOutsideHandler) {
            document.removeEventListener('click', this.boundOutsideHandler);
            this.boundOutsideHandler = null;
        }
    }

    async render() {
        try {
            const info = appStore.getState('systemInfo') || {};
            const uname = info && typeof info.current_user === 'string' ? info.current_user : '';
            // Load active profile to avoid stale username display after switching
            let active = null;
            try { active = await profileManager.getActive(); } catch (_) { active = null; }
            const effectiveUsername = (active && active.username) ? String(active.username) : String(uname || '');
            const authed = !!uname;
            // Status line now shows active profile name only
            const statusEl = document.getElementById('user-menu-status');
            if (statusEl) {
                try {
                    if (active) {
                        const label = active.label || `${active.username || ''}@${active.apiUrl || ''}`.replace(/^@/, '');
                        statusEl.textContent = label && label.trim() ? label : 'No active profile';
                    } else {
                        // Fallback to current runtime (username + API base) when no saved active profile yet
                        const { apiBaseUrl } = getApiOrigins();
                        const fallback = `${(uname || '').trim() ? `${uname}@` : ''}${apiBaseUrl || ''}`.replace(/^@/, '');
                        statusEl.textContent = (fallback && fallback.trim()) ? fallback : 'No active profile';
                    }
                } catch (_) {
                    const { apiBaseUrl } = getApiOrigins();
                    const fallback = `${(uname || '').trim() ? `${uname}@` : ''}${apiBaseUrl || ''}`.replace(/^@/, '');
                    statusEl.textContent = (fallback && fallback.trim()) ? fallback : 'No active profile';
                }
            }
            // Basic avatar: first letter (wrapped to allow precise vertical nudge)
            if (this.elements.avatar) {
                const letter = effectiveUsername && effectiveUsername.trim().length > 0
                    ? effectiveUsername.trim().charAt(0).toUpperCase()
                    : '?';
                this.elements.avatar.innerHTML = `<span class="avatar-initial">${letter}</span>`;
            }
            let features = {};
            try { features = appStore.getState('auth.features') || {}; } catch (_) { features = {}; }
            const canReset = authed && features.password_reset_enabled === true;
            // Toggle login/logout/reset visibility
            if (authed) {
                if (this.elements.login) this.elements.login.style.display = 'none';
                if (this.elements.logout) this.elements.logout.style.display = 'block';
                if (this.elements.resetPassword) this.elements.resetPassword.style.display = canReset ? 'block' : 'none';
            } else {
                if (this.elements.login) this.elements.login.style.display = 'block';
                if (this.elements.logout) this.elements.logout.style.display = 'none';
                if (this.elements.resetPassword) this.elements.resetPassword.style.display = 'none';
                if (this.elements.avatar) this.elements.avatar.innerHTML = '<span class="avatar-initial">?</span>';
            }
        } catch (_) {}
    }

    async renderProfiles() {
        try {
            if (!this.elements?.dropdown) return;
            // Load profiles
            const list = await profileManager.list();
            const activeId = await profileManager.getActiveId();
            const others = Array.isArray(list) ? list.filter((p) => p.id !== activeId) : [];

            // Profiles section (conditionally shown)
            let profilesSection = document.getElementById('user-profiles-section');
            if (!others.length) {
                // Remove profiles section if it exists
                if (profilesSection && profilesSection.parentNode) {
                    try { profilesSection.parentNode.removeChild(profilesSection); } catch (_) {}
                }
            } else {
                // Ensure a container exists for profiles list
                if (!profilesSection) {
                    profilesSection = document.createElement('div');
                    profilesSection.id = 'user-profiles-section';
                    profilesSection.style.borderTop = '1px solid var(--border-color)';
                    profilesSection.style.marginTop = '4px';
                    profilesSection.style.paddingTop = '4px';
                    this.elements.dropdown.appendChild(profilesSection);
                }
                profilesSection.innerHTML = '';

                const header = document.createElement('div');
                header.className = 'dropdown-info';
                header.textContent = 'Profiles';
                profilesSection.appendChild(header);

                // List other profiles as switches
                others.forEach((p) => {
                    const btn = document.createElement('button');
                    btn.className = 'dropdown-item';
                    btn.textContent = (p.label || `${p.username || ''}@${p.apiUrl}`).replace(/^@/, '');
                    btn.addEventListener('click', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        try { await authOrchestrator.switchProfile(p.id); } catch (err) { console.error('[UserMenu] switchProfile failed:', err); }
                        this.closeDropdown();
                    });
                    profilesSection.appendChild(btn);
                });
            }

            // Always attempt to render Downloads section beneath Profiles
            await this.renderDownloadsSection();
        } catch (e) {
            console.error('[UserMenu] Failed to render profiles:', e);
        }
    }

    async renderDownloadsSection() {
        try {
            if (!this.elements?.dropdown) return;

            // Read downloads mapping from configuration: { name: url }
            const downloads = (config && config.DOWNLOADS && typeof config.DOWNLOADS === 'object') ? config.DOWNLOADS : {};
            const entries = Object.entries(downloads).filter(([name, url]) => typeof name === 'string' && typeof url === 'string' && name.trim() && url.trim());

            // Manage Downloads section container
            let dlSection = document.getElementById('user-downloads-section');

            if (!entries.length) {
                // Remove section if nothing to show
                if (dlSection && dlSection.parentNode) {
                    try { dlSection.parentNode.removeChild(dlSection); } catch (_) {}
                }
                return;
            }

            // Ensure Downloads section exists
            if (!dlSection) {
                dlSection = document.createElement('div');
                dlSection.id = 'user-downloads-section';
                dlSection.style.borderTop = '1px solid var(--border-color)';
                dlSection.style.marginTop = '4px';
                dlSection.style.paddingTop = '4px';
            } else {
                dlSection.innerHTML = '';
            }

            // Header
            const header = document.createElement('div');
            header.className = 'dropdown-info';
            header.textContent = 'Downloads';
            dlSection.appendChild(header);

            // Render each configured download link
            for (const [name, url] of entries) {
                const a = document.createElement('a');
                a.href = url;
                a.className = 'dropdown-item';
                a.textContent = name;
                a.setAttribute('rel', 'noopener noreferrer');
                a.setAttribute('target', '_blank');
                // Suggest a filename for download when possible
                try {
                    const u = new URL(url, window.location.origin);
                    const fn = (u.pathname || '').split('/').filter(Boolean).pop();
                    if (fn && fn.trim()) a.setAttribute('download', fn.trim()); else a.setAttribute('download', '');
                } catch (_) {
                    a.setAttribute('download', '');
                }
                dlSection.appendChild(a);
            }
            // Always position Downloads as the last item in the dropdown
            try { this.elements.dropdown.appendChild(dlSection); } catch (_) {}
        } catch (_) {
            // Silent fail: do not break dropdown rendering
        }
    }

    async logout() {
        let logoutError = null;
        try {
            await authOrchestrator.logout();
        } catch (error) {
            logoutError = error;
            console.error('[UserMenu] Logout failed:', error);
        }

        this.closeDropdown();

        if (!logoutError) {
            try {
                const isDesktop = !!(window.desktop && window.desktop.isElectron);
                if (isDesktop) {
                    await window.desktop?.reloadWindow?.();
                } else {
                    setTimeout(() => { try { window.location.reload(); } catch (_) {} }, 50);
                }
            } catch (_) {}
        }
    }
}

export const userMenu = new UserMenu();
