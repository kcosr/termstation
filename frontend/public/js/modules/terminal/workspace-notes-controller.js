import { apiService } from '../../services/api.service.js';
import { iconUtils } from '../../utils/icon-utils.js';
import { renderMarkdown } from './notes-markdown.js';
import { createNoteEditor, applyNoteViewMode } from './note-editor.js';
import { NoteStatusClasses, computeDefaultStatusText, formatRelativeTime } from './note-status.js';
import { NotesModel } from './notes-model.js';
import { keyboardShortcuts } from '../shortcuts/keyboard-shortcuts.js';
import {
  computeMatches as nsuComputeMatches,
  selectRange as nsuSelectRange,
  clearTextareaSelection as nsuClearSelection,
  getSelectedText as nsuGetSelectedText,
  renderHighlights as nsuRenderHighlights,
  scrollCurrentMatchIntoView as nsuScrollCurrentIntoView,
  formatSearchCount as nsuFormatSearchCount
} from './notes-search-utils.js';

/**
 * Workspace Notes Controller
 * Lightweight notes editor for per-user workspace notes with optimistic versioning.
 */
export class WorkspaceNotesController {
  constructor({ tabManager, eventBus, appStore, getContext }) {
    this.tabManager = tabManager;
    this.eventBus = eventBus;
    this.appStore = appStore;
    this.getContext = getContext;

    this.models = new Map();
    this._shortcutDisposers = [];
    this._globalTab = null;
    this._globalViewRefs = null;
    this._globalHandlers = [];
    this._searchState = new Map();
    this._workspaceReturnState = null;
    this.handleWorkspaceOpen = this.handleWorkspaceOpen.bind(this);

    // Bind
    this.ensureTabIfEnabled = this.ensureTabIfEnabled.bind(this);
    this._handleSearchKey = this._handleSearchKey.bind(this);

    // Preference subscription handle
    this._prefsUnsub = null;
  }

  isEnabled() {
    try {
      const st = this.appStore?.getState?.() || {};
      const featureEnabled = st?.auth?.features?.notes_enabled === true;
      if (!featureEnabled) return false;
      const pref = st?.preferences?.notes?.showWorkspaceTab;
      return pref !== false;
    } catch (_) {
      return false;
    }
  }

  getWorkspaceName() {
    try {
      const app = this.getContext?.()?.app;
      return app?.modules?.terminal?.currentWorkspace || null;
    } catch (_) {
      return null;
    }
  }

  ensureTabIfEnabled(workspaceName, sessionId) {
    if (!this.isEnabled()) return;
    const ws = (workspaceName || '').trim();
    if (!ws) return;
    this.ensureModel(ws);
    this.ensureTab(ws, sessionId);
  }

  ensureModel(workspaceName) {
    const ws = (workspaceName || '').trim();
    if (!ws) return null;
    if (!this.models.has(ws)) {
      this.models.set(ws, this.createModel(ws));
    }
    return this.models.get(ws);
  }

  ensureState(workspaceName) {
    const model = this.ensureModel(workspaceName);
    return model ? model.getState() : null;
  }

  createModel(workspaceName) {
    const model = new NotesModel({
      id: `workspace:${workspaceName}`,
      debounceMs: 800,
      saveFn: ({ content, version }) => apiService.setWorkspaceNote(workspaceName, content, version),
      loadFn: () => apiService.getWorkspaceNote(workspaceName),
      computeStatusText: computeDefaultStatusText,
      relativeTimeFormatter: formatRelativeTime,
      getCurrentUser: () => this.getCurrentUsername(),
      onConflict: (snapshot) => {
        if (!snapshot) return false;
        model.updateState({ pendingRemote: snapshot });
        model.applyPendingRemote({
          statusState: 'warning',
          statusMessage: 'Update conflict detected. Loaded latest.',
          statusDelay: 2000,
          preserveDirtyContent: false
        });
        return true;
      }
    });

    model.updateState({
      viewMode: 'plain',
      splitOrientation: 'horizontal'
    });

    model.on('change', () => this.onModelChange(workspaceName));
    model.on('status', () => this.onModelStatus(workspaceName));

    model.loadLatest({ statusState: 'idle', statusMessage: null, statusDelay: 0 }).catch((error) => {
      console.warn('[WorkspaceNotes] Failed to load note:', error);
      model.setStatus('error', 'Failed to load note.');
    });

    return model;
  }

  onModelChange(workspaceName) {
    const model = this.models.get(workspaceName);
    if (!model) return;
    const state = model.getState();
    this.updateWorkspaceTabIndicator(workspaceName);

    const view = this.findWorkspaceView(workspaceName);
    if (!view) return;

    const textarea = view.querySelector('textarea.note-editor');
    if (textarea && document.activeElement !== textarea) {
      textarea.value = state.content || '';
    }

    const preview = view.querySelector('.note-preview');
    this.renderPreview(workspaceName, preview);
    this.applyViewMode(workspaceName, state.viewMode || 'plain', view);
    this.updateSendSelectionButtonState(workspaceName, textarea, view.querySelector('.note-send-selection'));
    this.updateStatus(workspaceName);
    // Live update search matches if panel open
    try {
      const refs = this._globalViewRefs;
      if (refs?.searchPanel && refs.searchPanel.hidden === false) {
        this._recomputeWorkspaceSearch(workspaceName);
      }
      this._renderWorkspaceHighlights(workspaceName);
    } catch (_) {}
  }

  onModelStatus(workspaceName) {
    this.updateStatus(workspaceName);
  }

  hasNoteContent(workspaceName) {
    try {
      if (!this.isEnabled()) return false;
      const model = this.ensureModel(workspaceName);
      const state = model?.getState?.();
      const c1 = typeof state?.content === 'string' ? state.content.trim() : '';
      const c2 = typeof state?.lastSavedContent === 'string' ? state.lastSavedContent.trim() : '';
      return (c1.length > 0) || (c2.length > 0);
    } catch (_) { return false; }
  }

  async loadFromServer(workspaceName) {
    try {
      const model = this.ensureModel(workspaceName);
      if (!model) return;
      await model.loadLatest({ statusState: 'success', statusMessage: 'Loaded latest changes', statusDelay: 1500 });
    } catch (e) {
      console.warn('[WorkspaceNotes] Failed to load note:', e);
      const model = this.models.get((workspaceName || '').trim());
      if (model) {
        model.setStatus('error', 'Failed to load note.');
      }
    }
  }

  getTabForSession(sessionId) {
    try {
      const sessionTabs = this.tabManager?.sessionTabs?.get(sessionId);
      const tabData = sessionTabs?.get('workspace-note');
      return tabData?.element || null;
    } catch (_) {
      return null;
    }
  }

  ensureTab(workspaceName, _sessionIdIgnored = null) {
    const ws = (workspaceName || '').trim();
    if (!ws) return null;

    const model = this.ensureModel(ws);
    const state = model?.getState();
    if (!state) return null;

    const hadTab = !!this._globalTab;
    if (!hadTab) {
      const created = this.createGlobalTab(ws, state);
      if (!created) return null;
    }

    const view = this.getGlobalView();
    if (!view) return null;

    const previousWorkspace = view.dataset?.workspace || '';
    const workspaceChanged = !hadTab || previousWorkspace !== ws;

    if (!view.isConnected && this.tabManager?.contentArea) {
      this.tabManager.contentArea.appendChild(view);
    }

    this.syncGlobalView(ws, state, {
      preserveFocused: !workspaceChanged,
      previousWorkspace
    });

    if (workspaceChanged) {
      this.loadFromServer(ws).catch(() => {});
    }

    return this._globalTab;
  }

  createGlobalTab(initialWorkspace, state) {
    const editor = createNoteEditor({
      contentArea: this.tabManager?.contentArea,
      tabId: 'workspace-note',
      sessionId: null,
      // Include base note-view styles so spacing matches session notes
      viewClass: 'note-view workspace-note-view',
      title: 'Notes',
      includeSendButton: true
    });
    if (!editor) return null;

    const effectiveState = state || this.ensureModel(initialWorkspace)?.getState();

    const {
      element: view,
      textarea,
      previewEl: preview,
      loadButton: loadBtn,
      sendSelectionButton: sendSelectionBtn,
      viewButtons,
      splitToggleButton,
      editorStack,
      highlightsEl,
      highlightsContentEl,
      searchToggleButton,
      searchPanel,
      searchFindInput,
      searchReplaceInput,
      searchPrevBtn,
      searchNextBtn,
      searchReplaceBtn,
      searchReplaceAllBtn,
      searchCloseBtn,
      searchCountEl
    } = editor;

    this._globalViewRefs = {
      view,
      textarea,
      preview,
      loadBtn,
      sendSelectionBtn,
      splitToggleButton,
      editorStack,
      highlightsEl,
      highlightsContentEl,
      searchToggleButton,
      searchPanel,
      searchFindInput,
      searchReplaceInput,
      searchPrevBtn,
      searchNextBtn,
      searchReplaceBtn,
      searchReplaceAllBtn,
      searchCloseBtn,
      searchCountEl
    };
    this._globalHandlers = [];

    view.dataset.workspace = initialWorkspace;
    textarea.classList.add('workspace-note-editor');

    const getWorkspace = () => (view.dataset?.workspace || '').trim();
    const updateSendSelectionState = () => {
      const currentWs = getWorkspace();
      if (!currentWs) return;
      this.updateSendSelectionButtonState(currentWs, textarea, sendSelectionBtn);
    };

    const onInput = () => {
      const currentWs = getWorkspace();
      if (!currentWs) return;
      this.onInput(currentWs, textarea);
      updateSendSelectionState();
    };

    const loadHandler = () => {
      const currentWs = getWorkspace();
      if (!currentWs) return;
      this.loadFromServer(currentWs);
    };

    const keydownHandler = (event) => {
      const currentWs = getWorkspace();
      if (!currentWs) return;
      this.handleEditorKeydown(event, currentWs, textarea);
    };

    const selectionUpdateHandler = () => {
      const currentWs = getWorkspace();
      if (!currentWs) return;
      updateSendSelectionState();
    };

    const sendSelectionHandler = () => {
      const currentWs = getWorkspace();
      if (!currentWs) return;
      this.handleSendSelectionButtonClick(currentWs, textarea);
    };

    this.registerGlobalHandler(textarea, 'input', onInput);
    this.registerGlobalHandler(loadBtn, 'click', loadHandler);
    this.registerGlobalHandler(textarea, 'keydown', keydownHandler);
    this.registerGlobalHandler(textarea, 'select', selectionUpdateHandler);
    this.registerGlobalHandler(textarea, 'keyup', selectionUpdateHandler);
    this.registerGlobalHandler(textarea, 'mouseup', selectionUpdateHandler);
    this.registerGlobalHandler(sendSelectionBtn, 'click', sendSelectionHandler);

    // Sync highlights with textarea scroll
    this.registerGlobalHandler(textarea, 'scroll', () => {
      try {
        if (this._globalViewRefs?.highlightsContentEl) {
          this._globalViewRefs.highlightsContentEl.style.transform = `translateY(-${textarea.scrollTop}px)`;
        }
      } catch (_) {}
    });

    (viewButtons || []).forEach((btn) => {
      if ((effectiveState?.viewMode || 'plain') === btn.dataset?.viewMode) {
        btn.classList.add('active');
      }
      const handler = () => {
        const currentWs = getWorkspace();
        if (!currentWs) return;
        this.setViewMode(currentWs, btn.dataset.viewMode);
      };
      this.registerGlobalHandler(btn, 'click', handler);
    });

    this.registerGlobalHandler(splitToggleButton, 'click', () => {
      const currentWs = getWorkspace();
      if (!currentWs) return;
      this.toggleSplitOrientation(currentWs);
    });

    if (searchToggleButton) {
      this.registerGlobalHandler(searchToggleButton, 'click', () => {
        const currentWs = getWorkspace();
        if (!currentWs) return;
        this.toggleSearchPanel(currentWs);
      });
    }

    // Wire search controls
    this._wireWorkspaceSearchControls(getWorkspace);

    const tab = {
      id: 'workspace-note',
      title: 'Notes',
      type: 'workspace-note',
      sessionId: null,
      element: view,
      closeable: false,
      cleanup: () => this.teardownGlobalTab()
    };

    this._globalTab = tab;

    this.syncGlobalView(initialWorkspace, effectiveState, {
      preserveFocused: false,
      previousWorkspace: ''
    });

    return tab;
  }

  syncGlobalView(workspaceName, state, options = {}) {
    const refs = this._globalViewRefs;
    const view = refs?.view;
    if (!view) return;

    const model = this.models.get(workspaceName);
    const noteState = model?.getState?.() || state;

    const previousWorkspace = typeof options.previousWorkspace === 'string'
      ? options.previousWorkspace
      : (view.dataset?.workspace || '');
    view.dataset.workspace = workspaceName;

    const textarea = refs?.textarea;
    const shouldPreserveValue = Boolean(options.preserveFocused) && previousWorkspace === workspaceName && document.activeElement === textarea;
    if (textarea && !shouldPreserveValue) {
      textarea.value = noteState?.content || '';
    }

    this.renderPreview(workspaceName, refs?.preview);
    this.applyViewMode(workspaceName, noteState?.viewMode || 'plain', view);
    this.updateStatus(workspaceName);
    this.updateSendSelectionButtonState(workspaceName, textarea, refs?.sendSelectionBtn);
    this.updateWorkspaceTabIndicator(workspaceName);
  }

  registerGlobalHandler(element, type, handler) {
    if (!element || typeof element.addEventListener !== 'function' || typeof handler !== 'function') return;
    element.addEventListener(type, handler);
    this._globalHandlers.push({ element, type, handler });
  }

  teardownGlobalTab() {
    if (Array.isArray(this._globalHandlers)) {
      this._globalHandlers.forEach(({ element, type, handler }) => {
        try {
          element.removeEventListener(type, handler);
        } catch (_) {}
      });
    }
    this._globalHandlers = [];

    const view = this.getGlobalView();
    if (view) {
      try { view.remove(); } catch (_) {}
    }

    this._globalViewRefs = null;
    this._globalTab = null;
  }

  getGlobalView() {
    return this._globalViewRefs?.view || null;
  }

  onInput(workspaceName, textarea) {
    const model = this.ensureModel(workspaceName);
    if (!model) return;
    model.setContent(textarea?.value ?? '');
    // Live update search matches if panel is open
    try {
      const refs = this._globalViewRefs;
      if (refs?.searchPanel && refs.searchPanel.hidden === false) {
        this._recomputeWorkspaceSearch(workspaceName);
      }
    } catch (_) {}
  }

  updateWorkspaceTabIndicator(workspaceName) {
    try {
      const model = this.ensureModel(workspaceName);
      const state = model?.getState?.();
      const hasNote = !!(typeof state?.content === 'string' && state.content.trim().length > 0) ||
                      !!(typeof state?.lastSavedContent === 'string' && state.lastSavedContent.trim().length > 0);
      const tabBtn = document.querySelector('.session-tab.session-tab--workspace-notes');
      if (!tabBtn) return;
      // Color the base icon by toggling class on the tab button
      tabBtn.classList.toggle('session-tab--has-note', hasNote);
    } catch (_) {}
  }

  // Rendering and behavior helpers mirroring session notes
  renderPreview(workspaceName, previewEl) {
    try {
      const st = this.ensureState(workspaceName);
      const html = renderMarkdown(st?.content || '');
      if (previewEl) previewEl.innerHTML = html;
    } catch (_) {}
  }

  setViewMode(workspaceName, mode) {
    const m = this.normalizeViewMode(mode);
    const model = this.ensureModel(workspaceName);
    const st = model?.getState();
    model?.updateState({ viewMode: m });
    const view = this.findWorkspaceView(workspaceName);
    if (view) this.applyViewMode(workspaceName, m, view);
  }

  toggleSplitOrientation(workspaceName) {
    const model = this.ensureModel(workspaceName);
    const st = model?.getState();
    const next = (st?.splitOrientation === 'vertical') ? 'horizontal' : 'vertical';
    model?.updateState({ splitOrientation: next });
    const view = this.findWorkspaceView(workspaceName);
    if (view) this.applyViewMode(workspaceName, st?.viewMode || 'plain', view);
  }

  applyViewMode(workspaceName, mode, view) {
    const m = this.normalizeViewMode(mode);
    const st = this.ensureState(workspaceName);
    const container = view || this.findWorkspaceView(workspaceName);
    if (!container) return;
    try {
      applyNoteViewMode({ container, mode: m, splitOrientation: st.splitOrientation || 'horizontal' });
    } catch (_) {}
    // Update split toggle button state/visibility
    try {
      const btn = container.querySelector('.note-split-toggle');
      if (btn) {
        btn.style.display = m === 'split' ? '' : 'none';
        const orient = (st.splitOrientation === 'vertical') ? 'vertical' : 'horizontal';
        const label = orient === 'vertical'
          ? 'Switch to side-by-side split'
          : 'Switch to top-to-bottom split';
        btn.classList.toggle('note-split-toggle--vertical', orient === 'vertical');
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-pressed', orient === 'vertical' ? 'true' : 'false');
        btn.title = label;
      }
    } catch (_) {}

    // Show search panel only for plain/split
    try {
      const panel = container.querySelector('.note-search-panel');
      if (panel) {
        panel.style.display = (m === 'plain' || m === 'split') ? '' : 'none';
        if (!(m === 'plain' || m === 'split')) {
          try { this.closeSearchPanel(workspaceName); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  normalizeViewMode(mode) {
    return (mode === 'split' || mode === 'markdown') ? mode : 'plain';
  }

  findWorkspaceView(workspaceName) {
    try {
      const view = this.getGlobalView();
      if (!view) return null;
      const target = (workspaceName || '').trim();
      if (!target) return view;
      const current = (view.dataset?.workspace || '').trim();
      return current === target ? view : null;
    } catch (_) { return null; }
  }

  handleEditorKeydown(event, workspaceName, textarea) {
    try {
      if (!event || !textarea) return;
      if (event.repeat) return;
      const isEnter = event.key === 'Enter';
      const withShift = !!event.shiftKey;
      const usesMeta = event.metaKey && !event.ctrlKey;
      const usesAlt = event.altKey && !event.ctrlKey;
      if (isEnter && withShift && (usesMeta || usesAlt)) {
        // Send selection to terminal (same as session notes)
        const selection = this.getSelectedText(textarea);
        if (selection && selection.trim() && this.canSendSelectionToTerminal()) {
          event.preventDefault();
          event.stopPropagation();
          const sent = this.sendSelectionToTerminal(selection.endsWith('\n') ? selection : selection + '\n');
          if (sent) {
            try { this.tabManager?.switchToTab?.('terminal'); } catch (_) {}
            this.clearTextareaSelection(textarea);
          }
        }
        return;
      }
    } finally {
      // Keep send button state in sync
      setTimeout(() => {
        try {
          const btn = this.findWorkspaceView(workspaceName)?.querySelector('.note-send-selection');
          this.updateSendSelectionButtonState(workspaceName, textarea, btn);
        } catch (_) {}
      }, 0);
    }
  }

  updateSendSelectionButtonState(workspaceName, textarea, button) {
    if (!button) return;
    const isFocused = (typeof document !== 'undefined') && document.activeElement === textarea;
    const hasSel = isFocused && nsuGetSelectedText(textarea).trim().length > 0;
    if (!hasSel || !this.canSendSelectionToTerminal()) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    } else {
      button.disabled = false;
      button.removeAttribute('aria-disabled');
    }
  }

  getSelectedText(textarea) { return nsuGetSelectedText(textarea); }

  handleSendSelectionButtonClick(workspaceName, textarea) {
    if (!textarea || textarea.readOnly) return;
    if (!this.canSendSelectionToTerminal()) return;
    const selection = nsuGetSelectedText(textarea);
    if (!selection || !selection.trim()) return;
    const sent = this.sendSelectionToTerminal(selection);
    if (sent) {
      try { textarea.blur(); } catch (_) {}
      this.clearTextareaSelection(textarea);
    }
  }

  // --- Inline search/replace for workspace notes ---
  _handleSearchKey(_event) {
    try {
      const ws = this.getWorkspaceName();
      if (!ws) return false;
      this.openSearchPanel(ws);
      return true;
    } catch (_) { return false; }
  }

  ensureSearchState(workspaceName) {
    const ws = (workspaceName || '').trim();
    if (!ws) return null;
    if (!this._searchState.has(ws)) {
      this._searchState.set(ws, { matches: [], current: -1, lastQuery: '', open: false });
    }
    return this._searchState.get(ws);
  }

  _wireWorkspaceSearchControls(getWorkspace) {
    const refs = this._globalViewRefs;
    if (!refs?.searchFindInput) return;
    const onFindInput = () => {
      const ws = getWorkspace();
      const st = this.ensureSearchState(ws);
      st.lastQuery = refs.searchFindInput.value || '';
      this._recomputeWorkspaceSearch(ws);
    };
    const onFindKeyDown = (ev) => {
      const ws = getWorkspace();
      if (ev.key === 'Enter') {
        if (ev.shiftKey) this._gotoWorkspacePrev(ws);
        else this._gotoWorkspaceNext(ws);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.key === 'Escape') {
        const hasText = (refs.searchFindInput.value || '').length > 0;
        if (hasText) {
          refs.searchFindInput.value = '';
          const st = this.ensureSearchState(ws);
          if (st) st.lastQuery = '';
          this._recomputeWorkspaceSearch(ws);
        } else {
          this.closeSearchPanel(ws);
        }
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    const onPrev = () => { this._gotoWorkspacePrev(getWorkspace()); try { refs.searchFindInput.focus({ preventScroll: true }); } catch (_) {} };
    const onNext = () => { this._gotoWorkspaceNext(getWorkspace()); try { refs.searchFindInput.focus({ preventScroll: true }); } catch (_) {} };
    const onReplace = () => { this._replaceWorkspaceCurrent(getWorkspace()); try { refs.searchReplaceInput.focus({ preventScroll: true }); } catch (_) {} };
    const onReplaceAll = () => { this._replaceWorkspaceAll(getWorkspace()); try { refs.searchReplaceInput.focus({ preventScroll: true }); } catch (_) {} };
    const onReplaceKeyDown = (ev) => {
      if (ev.key === 'Enter') {
        const replaceAll = (!!ev.metaKey && !ev.ctrlKey) || (!!ev.altKey && !ev.ctrlKey);
        if (replaceAll) { onReplaceAll(); }
        else { onReplace(); }
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.key === 'Escape') {
        try { if (refs.searchReplaceInput) refs.searchReplaceInput.value = ''; } catch (_) {}
        try { if (refs.searchFindInput) { refs.searchFindInput.focus(); refs.searchFindInput.select(); } } catch (_) {}
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    };
    const onClose = () => this.closeSearchPanel(getWorkspace());

    this.registerGlobalHandler(refs.searchFindInput, 'input', onFindInput);
    this.registerGlobalHandler(refs.searchFindInput, 'keydown', onFindKeyDown);
    this.registerGlobalHandler(refs.searchPrevBtn, 'click', onPrev);
    this.registerGlobalHandler(refs.searchNextBtn, 'click', onNext);
    this.registerGlobalHandler(refs.searchReplaceBtn, 'click', onReplace);
    this.registerGlobalHandler(refs.searchReplaceAllBtn, 'click', onReplaceAll);
    this.registerGlobalHandler(refs.searchReplaceInput, 'keydown', onReplaceKeyDown);
    this.registerGlobalHandler(refs.searchCloseBtn, 'click', onClose);
  }

  toggleSearchPanel(workspaceName) {
    const st = this.ensureSearchState(workspaceName);
    if (st?.open) this.closeSearchPanel(workspaceName);
    else this.openSearchPanel(workspaceName);
  }

  openSearchPanel(workspaceName) {
    const ws = (workspaceName || '').trim();
    const refs = this._globalViewRefs;
    if (!ws || !refs?.searchPanel || !refs?.textarea) return;
    if (refs.searchPanel.hidden === false) {
      try { refs.searchFindInput.focus(); refs.searchFindInput.select(); } catch (_) {}
      return;
    }
    refs.searchPanel.hidden = false;
    const st = this.ensureSearchState(ws);
    st.open = true;
    const selection = nsuGetSelectedText(refs.textarea);
    const prefill = selection && selection.length > 0 ? selection : (st.lastQuery || '');
    refs.searchFindInput.value = prefill;
    try { refs.searchFindInput.focus(); refs.searchFindInput.select(); } catch (_) {}
    this._recomputeWorkspaceSearch(ws);
    if (st.matches && st.matches.length > 0) {
      let idx = 0;
      if (selection && selection.length > 0) {
        const start = refs.textarea.selectionStart || 0;
        idx = st.matches.findIndex(([a, b]) => a === start && b === start + selection.length);
        if (idx < 0) {
          const caret = start;
          idx = st.matches.findIndex(([a]) => a >= caret);
          if (idx < 0) idx = 0;
        }
      }
      this._gotoWorkspaceMatch(ws, idx);
    } else {
      this._updateWorkspaceSearchCount(ws);
    }
  }

  closeSearchPanel(workspaceName) {
    const refs = this._globalViewRefs;
    const st = this.ensureSearchState(workspaceName);
    if (!refs?.searchPanel) return;
    refs.searchPanel.hidden = true;
    if (st) st.open = false;
    if (refs?.editorStack) refs.editorStack.classList.remove('note-editor--with-highlights');
  }

  _recomputeWorkspaceSearch(workspaceName) {
    const refs = this._globalViewRefs;
    const st = this.ensureSearchState(workspaceName);
    if (!refs?.textarea || !refs?.searchFindInput || !st) return;
    const text = String(refs.textarea.value || '');
    const query = String(refs.searchFindInput.value || '');
    st.matches = nsuComputeMatches(text, query);
    if (st.matches.length === 0) {
      st.current = -1;
    } else {
      const caret = typeof refs.textarea.selectionStart === 'number' ? refs.textarea.selectionStart : 0;
      let idx = st.matches.findIndex(([a]) => a >= caret);
      if (idx < 0) idx = 0;
      st.current = idx;
    }
    this._updateWorkspaceSearchCount(workspaceName);
    this._renderWorkspaceHighlights(workspaceName);
  }

  _computeMatches(text, query) { return nsuComputeMatches(text, query); }

  _gotoWorkspaceMatch(workspaceName, index) {
    const refs = this._globalViewRefs;
    const st = this.ensureSearchState(workspaceName);
    if (!refs?.textarea || !st || !st.matches || st.matches.length === 0) return;
    const len = st.matches.length;
    const idx = ((index % len) + len) % len;
    st.current = idx;
    const [start, end] = st.matches[idx];
    const keepFindFocus = (typeof document !== 'undefined') && (document.activeElement === refs.searchFindInput);
    if (keepFindFocus) {
      nsuClearSelection(refs.textarea);
    } else {
      nsuSelectRange(refs.textarea, start, end, true);
    }
    this._updateWorkspaceSearchCount(workspaceName);
    this._renderWorkspaceHighlights(workspaceName);
    this._scrollWorkspaceCurrentIntoView(workspaceName);
  }

  _gotoWorkspaceNext(workspaceName) {
    const st = this.ensureSearchState(workspaceName);
    if (!st || !st.matches || st.matches.length === 0) return;
    const next = st.current >= 0 ? st.current + 1 : 0;
    this._gotoWorkspaceMatch(workspaceName, next);
  }

  _gotoWorkspacePrev(workspaceName) {
    const st = this.ensureSearchState(workspaceName);
    if (!st || !st.matches || st.matches.length === 0) return;
    const prev = st.current >= 0 ? st.current - 1 : 0;
    this._gotoWorkspaceMatch(workspaceName, prev);
  }

  _replaceWorkspaceCurrent(workspaceName) {
    const refs = this._globalViewRefs;
    const st = this.ensureSearchState(workspaceName);
    if (!refs?.textarea || !st || !st.matches || st.current < 0) return;
    const [start, end] = st.matches[st.current];
    const text = String(refs.textarea.value || '');
    const replacement = String(refs.searchReplaceInput?.value || '');
    const before = text.slice(0, start);
    const after = text.slice(end);
    const newText = before + replacement + after;
    refs.textarea.value = newText;
    this.onInput(workspaceName, refs.textarea);
    const nextCaret = start + replacement.length;
    this._recomputeWorkspaceSearch(workspaceName);
    const nextIdx = (st.matches || []).findIndex(([a]) => a >= nextCaret);
    if (nextIdx >= 0) this._gotoWorkspaceMatch(workspaceName, nextIdx);
    else this._updateWorkspaceSearchCount(workspaceName);
    this._renderWorkspaceHighlights(workspaceName);
    this._scrollWorkspaceCurrentIntoView(workspaceName);
  }

  _replaceWorkspaceAll(workspaceName) {
    const refs = this._globalViewRefs;
    const st = this.ensureSearchState(workspaceName);
    if (!refs?.textarea || !st) return;
    const query = String(refs.searchFindInput?.value || '');
    if (!query) return;
    const replacement = String(refs.searchReplaceInput?.value || '');
    const text = String(refs.textarea.value || '');
    if (query.length === 0) return;
    const newText = text.split(query).join(replacement);
    refs.textarea.value = newText;
    this.onInput(workspaceName, refs.textarea);
    this._recomputeWorkspaceSearch(workspaceName);
    this._updateWorkspaceSearchCount(workspaceName);
    this._renderWorkspaceHighlights(workspaceName);
    this._scrollWorkspaceCurrentIntoView(workspaceName);
  }

  _scrollWorkspaceCurrentIntoView(workspaceName) {
    const refs = this._globalViewRefs;
    const st = this.ensureSearchState(workspaceName);
    if (!refs?.highlightsContentEl || !refs?.textarea || !st || !Array.isArray(st.matches)) return;
    if (st.current < 0 || st.current >= st.matches.length) return;
    nsuScrollCurrentIntoView({
      highlightsContentEl: refs.highlightsContentEl,
      textarea: refs.textarea,
      currentIndex: st.current
    });
  }

  _renderWorkspaceHighlights(workspaceName) {
    const refs = this._globalViewRefs;
    if (!refs?.highlightsContentEl) return;
    const st = this.ensureSearchState(workspaceName);
    nsuRenderHighlights({
      text: String(refs.textarea?.value || ''),
      matches: Array.isArray(st?.matches) ? st.matches : [],
      currentIndex: Number.isInteger(st?.current) ? st.current : -1,
      highlightsContentEl: refs.highlightsContentEl,
      textarea: refs.textarea,
      editorStack: refs.editorStack,
      searchPanelVisible: refs.searchPanel && refs.searchPanel.hidden === false
    });
  }

  _updateWorkspaceSearchCount(workspaceName) {
    const refs = this._globalViewRefs;
    const st = this.ensureSearchState(workspaceName);
    if (!refs?.searchCountEl || !st) return;
    const total = st.matches?.length || 0;
    refs.searchCountEl.textContent = nsuFormatSearchCount(st.current, total);
  }

  _selectRange(textarea, start, end, focus) { nsuSelectRange(textarea, start, end, focus); }

  clearTextareaSelection(textarea) { nsuClearSelection(textarea); }

  canSendSelectionToTerminal() {
    try {
      const app = this.getContext?.()?.app;
      const terminalManager = app?.modules?.terminal;
      const sid = terminalManager?.currentSessionId;
      if (!sid) return false;
      if (typeof terminalManager.isSessionAttached === 'function' && !terminalManager.isSessionAttached(sid)) return false;
      const sessionData = terminalManager?.sessionList?.getSessionData?.(sid) || null;
      if (!sessionData) return false;
      if (typeof terminalManager.isSessionInteractive === 'function' && !terminalManager.isSessionInteractive(sessionData)) return false;
      // Visibility/permission: reuse sessionNotes permission rules if needed
      return true;
    } catch (_) {
      return false;
    }
  }

  sendSelectionToTerminal(text) {
    try {
      const app = this.getContext?.()?.app;
      const terminalManager = app?.modules?.terminal;
      const sid = terminalManager?.currentSessionId;
      if (!sid || !text) return false;
      terminalManager?.sendInput?.(sid, text);
      return true;
    } catch (_) { return false; }
  }

  updateStatus(workspaceName, message = undefined, stateName = undefined, options = {}) {
    try {
      const model = this.ensureModel(workspaceName);
      if (!model) return;

      const hasOverride = message !== undefined || stateName !== undefined || (options && Object.keys(options).length > 0);
      if (hasOverride) {
        model.setStatus(stateName || model.getStatus().state, message, options);
        return;
      }

      const view = this.findWorkspaceView(workspaceName);
      if (!view) return;
      const statusEl = view.querySelector('.note-status');
      const loadBtn = view.querySelector('.note-load-remote');
      if (!statusEl) return;

      const status = model.getStatus();
      statusEl.classList.remove(...NoteStatusClasses);
      statusEl.classList.add(`note-status--${status.state}`);
      const computed = computeDefaultStatusText(model.getState(), formatRelativeTime, this.getCurrentUsername());
      const text = status.state === 'idle' ? computed : (status.message || computed);
      statusEl.textContent = text;

      if (loadBtn) {
        loadBtn.hidden = true;
      }
    } catch (_) {}
  }

  initialize() {
    if (Array.isArray(this._shortcutDisposers)) {
      this._shortcutDisposers.forEach((dispose) => {
        try { dispose(); } catch (_) {}
      });
      this._shortcutDisposers = [];
    }
    if (typeof document !== 'undefined') {
      this._shortcutDisposers.push(
        keyboardShortcuts.registerShortcut({
          id: 'workspace-notes.focus-toggle',
          description: 'Focus or blur the workspace notes editor',
          keys: ['Meta+ArrowDown', 'Alt+ArrowDown', 'Meta+ArrowUp', 'Alt+ArrowUp'],
          priority: 30,
          allowInInputs: true,
          preventDefault: true,
          when: () => this.isEnabled() && this.tabManager?.activeTabId === 'workspace-note',
          handler: (event) => this.handleWorkspaceNotesShortcut(event)
        })
      );
      this._shortcutDisposers.push(
        keyboardShortcuts.registerShortcut({
          id: 'workspace-notes.open-tab',
          description: 'Switch to the workspace notes tab',
          keys: ['Meta+Shift+N', 'Alt+Shift+N'],
          priority: 35,
          allowInInputs: true,
          allowInEditable: true,
          preventDefault: true,
          when: () => {
            if (!this.isEnabled()) return false;
            const workspace = this.getWorkspaceName();
            if (!workspace) return false;
            if (this.tabManager?.activeTabId === 'workspace-note') {
              return Boolean(this._workspaceReturnState);
            }
            return true;
          },
          handler: () => {
            const workspace = this.getWorkspaceName();
            if (!workspace) return false;

            if (this.tabManager?.activeTabId === 'workspace-note') {
              return this.restoreWorkspaceReturnTarget();
            }

            this.captureWorkspaceReturnTarget();

            let handled = false;
            try {
              if (typeof this.eventBus?.emit === 'function') {
                this.eventBus.emit('workspace-open-notes', { workspace });
                handled = true;
              }
            } catch (error) {
              console.warn('[WorkspaceNotes] Failed to emit workspace-open-notes:', error);
            }

            if (!handled) {
              const tab = this.ensureTab(workspace, null);
              if (!tab) return false;
              try { this.tabManager?.globalTabs?.set('workspace-note', tab); } catch (_) {}
              try { this.tabManager?.switchToTab('workspace-note'); } catch (_) { return false; }
              handled = true;
            }

            // Auto-focus the workspace note editor when switching via shortcut
            try {
              const view = this.findWorkspaceView(workspace);
              const textarea = view ? view.querySelector('textarea.note-editor') : null;
              if (textarea && document.body.contains(textarea)) {
                setTimeout(() => { try { textarea.focus({ preventScroll: true }); } catch (_) { try { textarea.focus(); } catch (_) {} } }, 50);
              }
            } catch (_) {}

            return handled;
          }
        })
      );
      this._shortcutDisposers.push(
        keyboardShortcuts.registerShortcut({
          id: 'workspace-notes.search',
          description: 'Open search/replace in workspace notes',
          keys: ['Meta+F', 'Alt+F'],
          priority: 40,
          allowInInputs: true,
          allowInEditable: true,
          preventDefault: true,
          when: () => this.isEnabled() && this.tabManager?.activeTabId === 'workspace-note',
          handler: (event) => this._handleSearchKey(event)
        })
      );
    }
    if (this.eventBus?.on) {
      try { this.eventBus.on('workspace-open-notes', this.handleWorkspaceOpen); } catch (_) {}
    }
    // React to notes preference changes: tear down workspace notes when disabled
    try {
      if (this.appStore?.subscribe) {
        this._prefsUnsub = this.appStore.subscribe('preferences.notes', () => {
          if (!this.isEnabled()) {
            try { this.tabManager?.globalTabs?.delete?.('workspace-note'); } catch (_) {}
            this.teardownGlobalTab();
          }
        });
      }
    } catch (_) {}
    try {
      this.eventBus?.on?.('tab-switched', (data) => {
        if (data?.tabId !== 'workspace-note') return;
        const ws = this.getWorkspaceName();
        if (!ws) return;
        const st = this.ensureState(ws);
        const view = this.findWorkspaceView(ws);
        if (!view) return;
        const textarea = view.querySelector('textarea.note-editor');
        const preview = view.querySelector('.note-preview');
        if (textarea && textarea !== document.activeElement) textarea.value = st.content || '';
        this.renderPreview(ws, preview);
        this.applyViewMode(ws, st.viewMode || 'plain', view);
        this.updateStatus(ws);
      });
    } catch (_) {}
  }

  handleWorkspaceNotesShortcut(event) {
    if (!event) return false;
    const key = event.key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return false;
    if (event.shiftKey || event.ctrlKey) return false;

    const usesMeta = event.metaKey && !event.altKey;
    const usesAlt = event.altKey && !event.metaKey;
    if (!usesMeta && !usesAlt) {
      return false;
    }

    const wsName = this.getWorkspaceName();
    if (!wsName) return false;
    const viewEl = this.findWorkspaceView(wsName);
    const textarea = viewEl ? viewEl.querySelector('textarea.note-editor') : null;
    if (!textarea) return false;

    const isFocused = document.activeElement === textarea;

    if (key === 'ArrowDown') {
      if (isFocused) return false;
      try { textarea.focus({ preventScroll: true }); } catch (_) { try { textarea.focus(); } catch (_) {} }
      return true;
    }

    if (key === 'ArrowUp') {
      if (!isFocused) return false;
      try { textarea.blur(); } catch (_) {}
      return true;
    }

    return false;
  }

  destroy() {
    if (Array.isArray(this._shortcutDisposers)) {
      this._shortcutDisposers.forEach((dispose) => {
        try { dispose(); } catch (_) {}
      });
      this._shortcutDisposers = [];
    }
    if (typeof this._prefsUnsub === 'function') {
      try { this._prefsUnsub(); } catch (_) {}
      this._prefsUnsub = null;
    }
    if (this.eventBus?.off) {
      try { this.eventBus.off('workspace-open-notes', this.handleWorkspaceOpen); } catch (_) {}
    }
    this._workspaceReturnState = null;
    this.teardownGlobalTab();
  }

  handleWorkspaceOpen(payload) {
    try {
      if (!payload || !payload.workspace) return;
      this.captureWorkspaceReturnTarget();
    } catch (error) {
      console.warn('[WorkspaceNotes] Failed to handle workspace-open-notes event:', error);
    }
  }

  captureWorkspaceReturnTarget() {
    try {
      if (!this.tabManager) return;
      if (this._workspaceReturnState) return;

      const sessionId = this.tabManager.currentSessionId || null;
      let activeTabId = this.tabManager.activeTabId || 'terminal';

      if (activeTabId === 'workspace-note' && sessionId) {
        try {
          const fallbackId = this.tabManager.sessionActiveTab?.get?.(sessionId);
          if (fallbackId && fallbackId !== 'workspace-note') {
            activeTabId = fallbackId;
          } else {
            activeTabId = 'terminal';
          }
        } catch (_) {
          activeTabId = 'terminal';
        }
      }

      if (activeTabId === 'workspace-note' || !activeTabId) {
        activeTabId = 'terminal';
      }

      this._workspaceReturnState = {
        sessionId,
        tabId: activeTabId
      };
    } catch (error) {
      console.warn('[WorkspaceNotes] Failed to capture workspace return target:', error);
    }
  }

  restoreWorkspaceReturnTarget() {
    const state = this._workspaceReturnState;
    if (!state) return false;

    const { sessionId, tabId } = state;
    const targetTabId = tabId && tabId !== 'workspace-note' ? tabId : 'terminal';

    const context = this.getContext?.();
    const app = context?.app;

    try {
      if (sessionId) {
        this.tabManager.switchToSession(sessionId);
        if (this.tabManager.activeTabId !== targetTabId) {
          try { this.tabManager.switchToTab(targetTabId); } catch (_) {}
        }
        try { app?.modules?.terminal?.sessionList?.setActiveSession?.(sessionId); } catch (_) {}
        try { app?.modules?.terminal?.workspaceListComponent?.clearNotesSelected?.(); } catch (_) {}
        try { app?.modules?.terminal?.sessionTabsManager?.setActiveSession?.(sessionId); } catch (_) {}
      } else {
        this.tabManager.switchToTab(targetTabId);
        try { app?.modules?.terminal?.workspaceListComponent?.clearNotesSelected?.(); } catch (_) {}
        try { app?.modules?.terminal?.sessionTabsManager?.setActiveSession?.(null); } catch (_) {}
      }

      this._workspaceReturnState = null;
      return true;
    } catch (error) {
      console.warn('[WorkspaceNotes] Failed to restore workspace return target:', error);
      return false;
    }
  }

  getCurrentUsername() {
    try {
      const st = this.appStore?.getState?.();
      const prefUser = st?.preferences?.auth?.username;
      if (prefUser && String(prefUser).trim()) return String(prefUser).trim();
      const infoUser = st?.systemInfo?.current_user;
      if (infoUser && String(infoUser).trim()) return String(infoUser).trim();
    } catch (_) {}
    return '';
  }
}
