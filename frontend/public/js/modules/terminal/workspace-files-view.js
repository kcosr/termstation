import { apiService } from '../../services/api.service.js';
import { appStore } from '../../core/store.js';
import { escapeHtml } from './notes-markdown.js';
import { notificationDisplay } from '../../utils/notification-display.js';

/**
 * WorkspaceFilesView
 * Simple per-session workspace browser backed by the workspace web service API.
 */
export class WorkspaceFilesView {
  constructor({ sessionId, rootElement }) {
    this.sessionId = sessionId;
    this.rootElement = rootElement;
    this.currentPath = '/';
    this._bound = [];
    this._loading = false;
  }

  _isUploadEnabled() {
    try {
      return appStore.getState()?.auth?.features?.workspace_uploads_enabled === true;
    } catch (_) {
      return false;
    }
  }

  init() {
    if (!this.rootElement) return;
    this.rootElement.classList.add('workspace-files-view');
    this.rootElement.dataset.sessionId = this.sessionId;
    this.rootElement.dataset.tabId = 'workspace';

    const uploadEnabled = this._isUploadEnabled();
    const uploadHtml = uploadEnabled ? `
          <label class="workspace-files-upload-label">
            <span>Upload</span>
            <input type="file" class="workspace-files-upload-input" multiple>
          </label>` : '';

    this.rootElement.innerHTML = `
      <div class="workspace-files-toolbar">
        <div class="workspace-files-path-group">
          <button type="button" class="workspace-files-up-btn" title="Go up one directory" aria-label="Go up one directory">↩</button>
          <span class="workspace-files-path" aria-live="polite"></span>
        </div>
        <div class="workspace-files-actions">${uploadHtml}
        </div>
      </div>
      <div class="workspace-files-body">
        <table class="workspace-files-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        <div class="workspace-files-empty" hidden>No files in this directory.</div>
      </div>
      <div class="workspace-files-status" aria-live="polite"></div>
    `;

    this.pathLabel = this.rootElement.querySelector('.workspace-files-path');
    this.statusEl = this.rootElement.querySelector('.workspace-files-status');
    this.tbody = this.rootElement.querySelector('.workspace-files-table tbody');
    this.emptyState = this.rootElement.querySelector('.workspace-files-empty');
    const upBtn = this.rootElement.querySelector('.workspace-files-up-btn');
    const uploadInput = this.rootElement.querySelector('.workspace-files-upload-input');

    if (upBtn) {
      const handler = (e) => {
        e.preventDefault();
        this.navigateUp();
      };
      upBtn.addEventListener('click', handler);
      this._bound.push(() => upBtn.removeEventListener('click', handler));
    }
    if (uploadInput) {
      const handler = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        try {
          await this.uploadFiles(files);
        } finally {
          // Reset input so the same file can be selected again
          try { e.target.value = ''; } catch (_) {}
        }
      };
      uploadInput.addEventListener('change', handler);
      this._bound.push(() => uploadInput.removeEventListener('change', handler));
    }

    if (this.tbody) {
      const handler = (e) => this.handleTableClick(e);
      this.tbody.addEventListener('click', handler);
      this._bound.push(() => this.tbody.removeEventListener('click', handler));
    }

    this.updatePathLabel('/');
    this.setStatus('');
    // Initial load
    this.loadPath('/').catch((err) => {
      this.setStatus(`Failed to load workspace: ${escapeHtml(err && err.message ? err.message : String(err))}`);
    });
  }

  destroy() {
    try {
      this._bound.forEach((fn) => { try { fn(); } catch (_) {} });
    } catch (_) {}
    this._bound = [];
  }

  normalizePath(raw) {
    const s = (typeof raw === 'string' ? raw : String(raw || '')).replace(/\\/g, '/');
    if (!s || s === '.' || s === '/') return '/';
    const trimmed = s.startsWith('/') ? s : `/${s}`;
    // Collapse duplicate slashes
    return trimmed.replace(/\/{2,}/g, '/');
  }

  childPath(name) {
    const base = this.normalizePath(this.currentPath || '/');
    const cleanName = String(name || '').replace(/\//g, '');
    if (!cleanName) return base;
    if (base === '/') return `/${cleanName}`;
    return `${base}/${cleanName}`;
  }

  updatePathLabel(path) {
    if (!this.pathLabel) return;
    const p = this.normalizePath(path);
    this.pathLabel.textContent = p;
  }

  setStatus(message) {
    if (!this.statusEl) return;
    const msg = String(message || '').trim();
    this.statusEl.textContent = msg;
  }

  async loadPath(path) {
    if (this._loading) return;
    this._loading = true;
    const nextPath = this.normalizePath(path);
    this.updatePathLabel(nextPath);
    try {
      const data = await apiService.listWorkspaceFiles(this.sessionId, nextPath);
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      this.currentPath = this.normalizePath(data?.path || nextPath);
      this.updatePathLabel(this.currentPath);
      this.renderEntries(entries);
      this.setStatus('');
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      this.renderEntries([]);
      this.setStatus(escapeHtml(msg));
    } finally {
      this._loading = false;
    }
  }

  renderEntries(entries) {
    if (!this.tbody) return;
    this.tbody.innerHTML = '';
    const list = Array.isArray(entries) ? entries.slice() : [];
    // Directories first, then files; simple name sort within groups
    list.sort((a, b) => {
      const aDir = (a && a.type === 'directory') ? 0 : 1;
      const bDir = (b && b.type === 'directory') ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      const an = (a && a.name) ? String(a.name).toLowerCase() : '';
      const bn = (b && b.name) ? String(b.name).toLowerCase() : '';
      return an.localeCompare(bn);
    });

    for (const entry of list) {
      if (!entry || typeof entry.name !== 'string') continue;
      const tr = document.createElement('tr');
      tr.dataset.name = entry.name;
      tr.dataset.type = entry.type || (entry.isDir ? 'directory' : 'file');

      const nameCell = document.createElement('td');
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'workspace-files-name-btn';
      nameBtn.textContent = entry.name;
      nameCell.appendChild(nameBtn);

      const typeCell = document.createElement('td');
      typeCell.textContent = tr.dataset.type === 'directory' ? 'Directory' : 'File';

      const actionsCell = document.createElement('td');
      if (tr.dataset.type === 'directory') {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'workspace-files-open-btn';
        openBtn.textContent = 'Open';
        actionsCell.appendChild(openBtn);
      } else {
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'workspace-files-download-btn';
        dlBtn.textContent = 'Download';
        actionsCell.appendChild(dlBtn);
      }

      tr.appendChild(nameCell);
      tr.appendChild(typeCell);
      tr.appendChild(actionsCell);
      this.tbody.appendChild(tr);
    }

    if (this.emptyState) {
      const isEmpty = !this.tbody.children.length;
      this.emptyState.hidden = !isEmpty;
    }
  }

  handleTableClick(event) {
    const target = event.target;
    if (!target) return;
    const row = target.closest('tr');
    if (!row) return;
    const name = row.dataset.name || '';
    const type = row.dataset.type || 'file';

    if (!name) return;

    if (target.classList.contains('workspace-files-download-btn')) {
      event.preventDefault();
      this.downloadFile(name);
      return;
    }
    if (target.classList.contains('workspace-files-open-btn') || target.classList.contains('workspace-files-name-btn')) {
      event.preventDefault();
      if (type === 'directory') {
        this.navigateInto(name);
      } else {
        // Clicking filename opens the file (download + open with default app)
        this.openFile(name);
      }
    }
  }

  navigateInto(name) {
    const next = this.childPath(name);
    this.loadPath(next).catch((err) => {
      this.setStatus(`Failed to open directory: ${escapeHtml(err && err.message ? err.message : String(err))}`);
    });
  }

  navigateUp() {
    const cur = this.normalizePath(this.currentPath || '/');
    if (cur === '/') return;
    const parts = cur.split('/').filter(Boolean);
    parts.pop();
    const next = parts.length ? `/${parts.join('/')}` : '/';
    this.loadPath(next).catch((err) => {
      this.setStatus(`Failed to navigate up: ${escapeHtml(err && err.message ? err.message : String(err))}`);
    });
  }

  async downloadFile(name) {
    const path = this.childPath(name);
    try {
      const resp = await apiService.downloadWorkspaceFile(this.sessionId, path, { download: true });
      const blob = await resp.blob();

      // Use native Electron save dialog if available (desktop app)
      if (typeof window !== 'undefined' && window.desktop?.saveBlob) {
        // Convert blob to base64 (Blob doesn't serialize across context bridge)
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const result = await window.desktop.saveBlob(base64, name);
        if (result && result.ok) {
          return;
        }
        if (result && result.canceled) {
          // User canceled save dialog - not an error
          return;
        }
        if (result && result.error) {
          this._showError('Download Failed', result.error);
          return;
        }
        // Fall through to browser download if something unexpected happened
      }

      // Browser fallback: use blob URL + anchor click
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (_) {}
      }, 1000);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      this._showError('Download Failed', msg);
    }
  }

  async openFile(name) {
    const path = this.childPath(name);
    try {
      const resp = await apiService.downloadWorkspaceFile(this.sessionId, path, { download: true });
      const blob = await resp.blob();

      // Use native Electron download-and-open if available (desktop app)
      if (typeof window !== 'undefined' && window.desktop?.downloadAndOpen) {
        // Convert blob to base64
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const result = await window.desktop.downloadAndOpen(base64, name);
        if (result && result.ok) {
          return;
        }
        if (result && result.error) {
          this._showError('Open Failed', result.error);
          return;
        }
        // Fall through to browser download if something unexpected happened
      }

      // Browser fallback: just download the file (can't open directly)
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (_) {}
      }, 1000);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      this._showError('Open Failed', msg);
    }
  }

  _showError(title, message) {
    try {
      notificationDisplay.show({
        notification_type: 'error',
        title,
        message
      }, { duration: 5000 });
    } catch (_) {
      // Fallback to console if notification fails
      console.error(`[WorkspaceFilesView] ${title}: ${message}`);
    }
  }

  async uploadFiles(files) {
    if (!Array.isArray(files) || !files.length) return;
    const base = this.normalizePath(this.currentPath || '/');
    for (const file of files) {
      const targetPath = base === '/' ? `/${file.name}` : `${base}/${file.name}`;
      try {
        await apiService.uploadWorkspaceFile(this.sessionId, targetPath, file);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        this._showError('Upload Failed', `${file.name}: ${msg}`);
        // Continue with remaining files
      }
    }
    await this.loadPath(base);
  }
}

