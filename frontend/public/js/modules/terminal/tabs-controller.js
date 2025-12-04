/**
 * TabsController
 * Encapsulates TabManager operations and DOM event wiring for tabs.
 */
export class TabsController {
  constructor(tabManager) {
    this.tm = tabManager; // instance of TabManager
  }

  init() {
    // Wire URL error open buttons via delegation on the content area
    const area = this.tm.contentArea;
    const tabs = this.tm.tabsContainer;
    if (!area || !tabs) return;

    area.addEventListener('click', (e) => {
      const btn = e.target.closest('.url-error-open-btn');
      if (btn && area.contains(btn)) {
        e.preventDefault();
        const url = btn.getAttribute('data-url');
        if (url) window.open(url, '_blank');
      }
    });

    // Delegation for tab header interactions
    tabs.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('.terminal-tab');
      if (!tabBtn || !tabs.contains(tabBtn)) return;
      const tabId = tabBtn.getAttribute('data-tab-id');
      if (!tabId) return;
      // Close button inside tab
      if (e.target.closest('.terminal-tab-close')) {
        e.stopPropagation();
        this.close(tabId);
        return;
      }
      // Refresh button inside tab
      if (e.target.closest('.terminal-tab-refresh')) {
        e.stopPropagation();
        this.refresh(tabId);
        return;
      }
      // Otherwise switch to tab
      this.switchTo(tabId);
    });

    // Delegated context menu for URL tabs
    tabs.addEventListener('contextmenu', (e) => {
      const tabBtn = e.target.closest('.terminal-tab');
      if (!tabBtn || !tabs.contains(tabBtn)) return;
      const tabId = tabBtn.getAttribute('data-tab-id');
      if (!tabId) return;
      const tab = this.tm.getCurrentSessionTab(tabId);
      if (tab && tab.type === 'url' && typeof this.tm.showTabContextMenu === 'function') {
        e.preventDefault();
        this.tm.showTabContextMenu(e.pageX, e.pageY, tab);
      }
    });
  }

  refresh(tabId) {
    this.tm.refreshTab(tabId);
  }

  switchTo(tabId) {
    this.tm.switchToTab(tabId);
  }

  clearSession() {
    this.tm.clearSession();
  }

  close(tabId) {
    if (typeof this.tm.closeTab === 'function') {
      this.tm.closeTab(tabId);
    }
  }

    createButton(tab) {
        const btn = document.createElement('button');
        btn.className = 'terminal-tab';
        if (tab?.type) {
          btn.classList.add(`terminal-tab--${tab.type}`);
        }
        btn.dataset.tabId = tab.id;
        if (tab?.childSessionId) {
          btn.dataset.childSessionId = tab.childSessionId;
        }
        if (tab?.tooltip) {
          btn.title = String(tab.tooltip);
        } else if (tab?.title) {
          btn.title = String(tab.title);
        }
        // Title (icon-only for note tabs)
        const titleSpan = document.createElement('span');
    titleSpan.className = 'terminal-tab-title';
    if (tab?.type === 'note' || tab?.id === 'note') {
      try {
        // Use TabManager's iconUtils import to avoid a second import here
        const icon = this.tm && this.tm.iconUtils
          ? this.tm.iconUtils.createIcon('journal-text', { size: 14, className: 'terminal-tab-title-icon' })
          : null;
        if (icon) {
          titleSpan.appendChild(icon);
        } else {
          titleSpan.textContent = '';
        }
      } catch (_) {
        titleSpan.textContent = '';
      }
    } else {
      titleSpan.textContent = String(tab.title || '');
    }
    btn.appendChild(titleSpan);
    // Refresh button (also for command and workspace tabs)
    const refreshNeeded = (tab.type === 'url') || (tab.type === 'workspace') || (tab.type === 'terminal' && tab.localOnly !== true) || (tab.type === 'command');
    if (refreshNeeded) {
      const r = document.createElement('button');
      r.className = 'terminal-tab-refresh';
      r.title = (tab.type === 'url')
        ? 'Refresh'
        : (tab.type === 'workspace')
          ? 'Refresh files'
          : (tab.type === 'command' ? 'Run again' : 'Reload terminal');
      r.textContent = '↻';
      btn.appendChild(r);
    }
    // Close button for closeable tabs
    if (tab.closeable) {
      const c = document.createElement('button');
      c.className = 'terminal-tab-close';
      c.title = 'Close tab';
      c.textContent = '×';
      btn.appendChild(c);
    }
    // Insert URL tabs before the session Notes tab when present; otherwise append
    try {
      const noteBtn = this.tm.tabsContainer.querySelector('.terminal-tab[data-tab-id="note"]');
      if (tab.type === 'url' && noteBtn) {
        this.tm.tabsContainer.insertBefore(btn, noteBtn);
      } else {
        this.tm.tabsContainer.appendChild(btn);
      }
    } catch (_) {
      this.tm.tabsContainer.appendChild(btn);
    }
  }

  createAddButton() {
    // Remove any existing add button first (search in wrapper bar)
    const bar = (typeof this.tm.ensureTabsBar === 'function') ? this.tm.ensureTabsBar() : this.tm.tabsContainer.parentElement;
    if (!bar) return;
    const existing = bar.querySelector('.terminal-tab-add');
    if (existing) existing.remove();
    const addBtn = document.createElement('button');
    addBtn.className = 'terminal-tab-add';
    addBtn.title = 'Add new link tab';
    const title = document.createElement('span');
    title.className = 'terminal-tab-title';
    title.textContent = '+';
    addBtn.appendChild(title);
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof this.tm.createNewLinkTab === 'function') {
        this.tm.createNewLinkTab();
      }
    });
    bar.appendChild(addBtn);
  }

  updateTitle(tabId, title) {
    const btn = this.tm.tabsContainer.querySelector(`.terminal-tab[data-tab-id="${tabId}"] .terminal-tab-title`);
    if (btn) btn.textContent = String(title || '');
  }
}
