import { renderMarkdown } from './notes-markdown.js';
import { iconUtils } from '../../utils/icon-utils.js';
import { createNoteEditor, applyNoteViewMode } from './note-editor.js';
import { NoteStatusClasses, computeDefaultStatusText, formatRelativeTime } from './note-status.js';
import { NotesModel } from './notes-model.js';
import { keyboardShortcuts } from '../shortcuts/keyboard-shortcuts.js';
import { sendStdinWithDelayedSubmit } from '../../utils/stdin-delayed-submit.js';
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
 * Encapsulates collaborative session notes state, UI, and persistence.
 */
export class NotesController {
    constructor({ tabManager, eventBus, appStore, apiService, getContext }) {
        this.tabManager = tabManager;
        this.eventBus = eventBus;
        this.appStore = appStore;
        this.apiService = apiService;
        this.getContext = getContext;

        this.noteModels = new Map();
        this._notesPrefUnsub = null;
        this._shortcutDisposers = [];
        this._lastSessionTabs = new Map();
        this._activeSessionTabs = new Map();
        this._searchState = new Map();

        this.handleNoteUpdated = this.handleNoteUpdated.bind(this);
        this.handleTabSwitched = this.handleTabSwitched.bind(this);
        this.handleGlobalKeydown = this.handleGlobalKeydown.bind(this);
        this._handleSearchKey = this._handleSearchKey.bind(this);
        this._handleSessionUpdated = this._handleSessionUpdated.bind(this);
    }

    _wireSearchControls(sessionId, tab) {
        if (!tab?.searchFindInput) return;
        const s = this.ensureSearchState(sessionId);
        const onFindInput = () => {
            s.lastQuery = tab.searchFindInput.value || '';
            this._recomputeSearchMatches(sessionId);
        };
        const onFindKeyDown = (ev) => {
            if (ev.key === 'Enter') {
                if (ev.shiftKey) this._gotoPrevMatch(sessionId);
                else this._gotoNextMatch(sessionId);
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
            if (ev.key === 'Escape') {
                const hasText = (tab.searchFindInput.value || '').length > 0;
                if (hasText) {
                    tab.searchFindInput.value = '';
                    s.lastQuery = '';
                    this._recomputeSearchMatches(sessionId);
                } else {
                    this.closeSearchPanel(sessionId);
                }
                ev.preventDefault();
                ev.stopPropagation();
            }
        };
        const onPrev = () => { this._gotoPrevMatch(sessionId); try { tab.searchFindInput.focus({ preventScroll: true }); } catch (_) {} };
        const onNext = () => { this._gotoNextMatch(sessionId); try { tab.searchFindInput.focus({ preventScroll: true }); } catch (_) {} };
        const onReplace = () => { this._replaceCurrent(sessionId); try { tab.searchReplaceInput.focus({ preventScroll: true }); } catch (_) {} };
        const onReplaceAll = () => { this._replaceAll(sessionId); try { tab.searchReplaceInput.focus({ preventScroll: true }); } catch (_) {} };
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
                try { if (tab.searchReplaceInput) tab.searchReplaceInput.value = ''; } catch (_) {}
                try { if (tab.searchFindInput) { tab.searchFindInput.focus(); tab.searchFindInput.select(); } } catch (_) {}
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
        };
        const onClose = () => this.closeSearchPanel(sessionId);

        tab.searchFindInput.addEventListener('input', onFindInput);
        tab.searchFindInput.addEventListener('keydown', onFindKeyDown);
        tab.searchPrevBtn.addEventListener('click', onPrev);
        tab.searchNextBtn.addEventListener('click', onNext);
        tab.searchReplaceBtn.addEventListener('click', onReplace);
        tab.searchReplaceAllBtn.addEventListener('click', onReplaceAll);
        tab.searchReplaceInput.addEventListener('keydown', onReplaceKeyDown);
        tab.searchCloseBtn.addEventListener('click', onClose);

        tab._searchHandlers = { onFindInput, onFindKeyDown, onPrev, onNext, onReplace, onReplaceAll, onReplaceKeyDown, onClose };
    }

    toggleSearchPanel(sessionId) {
        const s = this.ensureSearchState(sessionId);
        if (s?.open) this.closeSearchPanel(sessionId);
        else this.openSearchPanel(sessionId);
    }

    initialize() {
        if (this.eventBus?.on) {
            this.eventBus.on('note-updated', this.handleNoteUpdated);
            this.eventBus.on('tab-switched', this.handleTabSwitched);
            // React to live session updates (e.g., visibility changes) so we can
            // immediately toggle editor read-only without requiring a reload.
            this.eventBus.on('session:updated', this._handleSessionUpdated);
        }
        if (Array.isArray(this._shortcutDisposers)) {
            this._shortcutDisposers.forEach((dispose) => {
                try { dispose(); } catch (_) {}
            });
            this._shortcutDisposers = [];
        }
        if (typeof document !== 'undefined') {
            this._shortcutDisposers.push(
                keyboardShortcuts.registerShortcut({
                    id: 'notes.focus-toggle',
                    description: 'Focus or blur the session notes editor',
                    keys: ['Meta+ArrowDown', 'Alt+ArrowDown', 'Meta+ArrowUp', 'Alt+ArrowUp'],
                    priority: 30,
                    allowInInputs: true,
                    preventDefault: true,
                    when: () => this.tabManager?.activeTabId === 'note' && this.isEnabled(),
                    handler: (event) => this.handleGlobalKeydown(event)
                })
            );
            this._shortcutDisposers.push(
                keyboardShortcuts.registerShortcut({
                    id: 'notes.open-tab',
                    description: 'Switch to the session notes tab',
                    keys: ['Meta+N', 'Alt+N'],
                    priority: 35,
                    allowInInputs: true,
                    allowInEditable: true,
                    preventDefault: true,
                    when: () => {
                        if (!this.isEnabled()) return false;
                        if (this.tabManager?.activeTabId === 'workspace-note') return false;
                        const sessionId = this.tabManager?.currentSessionId;
                        return Boolean(sessionId);
                    },
                    handler: () => {
                        const activeTabId = this.tabManager?.activeTabId;
                        const sessionId = this.tabManager?.currentSessionId;
                        if (!sessionId) return false;

                        if (activeTabId === 'note') {
                            const fallbackId = this._lastSessionTabs.get(sessionId) || 'terminal';
                            let targetId = fallbackId;
                            try {
                                if (!this.tabManager?.getCurrentSessionTab(fallbackId)) {
                                    targetId = 'terminal';
                                }
                            } catch (_) {
                                targetId = 'terminal';
                            }
                            try {
                                this.tabManager.switchToTab(targetId);
                                this._lastSessionTabs.delete(sessionId);
                                return true;
                            } catch (error) {
                                console.warn('[NotesController] Failed to restore previous tab:', error);
                                return false;
                            }
                        }

                        if (!sessionId) return false;
                        if (activeTabId && activeTabId !== 'note' && activeTabId !== 'workspace-note') {
                            this._lastSessionTabs.set(sessionId, activeTabId);
                        }
                        const tab = this.ensureTab(sessionId);
                        if (!tab) return false;
                        try { this.tabManager.switchToTab('note'); } catch (_) { return false; }
                        // Auto-focus the note editor when switching to notes via shortcut
                        try {
                            const t = this.getNoteTab(sessionId)?.textarea || tab.textarea;
                            if (t && document.body.contains(t)) {
                                setTimeout(() => { try { t.focus({ preventScroll: true }); } catch (_) { try { t.focus(); } catch (_) {} } }, 50);
                            }
                        } catch (_) {}
                        return true;
                    }
                })
            );
            this._shortcutDisposers.push(
                keyboardShortcuts.registerShortcut({
                    id: 'notes.search',
                    description: 'Open search/replace in notes',
                    keys: ['Meta+F', 'Alt+F'],
                    priority: 40,
                    allowInInputs: true,
                    allowInEditable: true,
                    preventDefault: true,
                    when: () => {
                        if (!this.isEnabled()) return false;
                        if (this.tabManager?.activeTabId !== 'note') return false;
                        const sid = this.tabManager?.currentSessionId;
                        const model = this.ensureModel(sid);
                        const vm = model?.getState()?.viewMode || 'plain';
                        return vm === 'plain' || vm === 'split';
                    },
                    handler: (event) => this._handleSearchKey(event)
                })
            );
        }
        try {
            this._notesPrefUnsub = this.appStore?.subscribe?.('preferences.notes', (newPrefs, prevPrefs) => {
                this.onPreferencesChanged(newPrefs || {}, prevPrefs || {});
            });
        } catch (e) {
            console.warn('[NotesController] Failed to subscribe to notes preferences changes:', e);
        }
    }

    destroy() {
        if (typeof this._notesPrefUnsub === 'function') {
            try { this._notesPrefUnsub(); } catch (_) {}
            this._notesPrefUnsub = null;
        }
        if (this.eventBus?.off) {
            try { this.eventBus.off('note-updated', this.handleNoteUpdated); } catch (_) {}
            try { this.eventBus.off('tab-switched', this.handleTabSwitched); } catch (_) {}
            try { this.eventBus.off('session:updated', this._handleSessionUpdated); } catch (_) {}
        }
        if (Array.isArray(this._shortcutDisposers)) {
            this._shortcutDisposers.forEach((dispose) => {
                try { dispose(); } catch (_) {}
            });
            this._shortcutDisposers = [];
        }
        this.noteModels.forEach((model) => {
            try { model.destroy(); } catch (_) {}
        });
        this.noteModels.clear();
    }

    _handleSessionUpdated(payload) {
        try {
            const sid = payload?.sessionData?.session_id;
            if (!sid) return;
            // Only touch UI if the session has a notes tab instantiated
            const tab = this.getNoteTab(sid);
            if (!tab) return;
            // Re-evaluate editability immediately based on latest visibility/permissions
            this.applyEditorAccess(sid);
            // Keep send-selection button state in sync
            this.updateSendSelectionButtonState(sid);
        } catch (_) { /* non-fatal */ }
    }

    isEnabled() {
        try {
            const st = this.appStore.getState();
            const featureEnabled = st?.auth?.features?.notes_enabled === true;
            if (!featureEnabled) return false;
            const pref = st?.preferences?.notes?.showSessionTab;
            return pref !== false;
        } catch (_) {
            return false;
        }
    }

    ensureModel(sessionId) {
        if (!sessionId) return null;
        if (!this.noteModels.has(sessionId)) {
            this.noteModels.set(sessionId, this.createModel(sessionId));
        }
        return this.noteModels.get(sessionId);
    }

    ensureState(sessionId) {
        const model = this.ensureModel(sessionId);
        if (!model) return null;
        const state = model.getState();
        state.viewMode = this.normalizeViewMode(state.viewMode);
        if (!Object.prototype.hasOwnProperty.call(state, 'lastSyncSignature')) {
            state.lastSyncSignature = null;
        }
        if (!Object.prototype.hasOwnProperty.call(state, 'splitOrientation')) {
            state.splitOrientation = 'horizontal';
        }
        state.splitOrientation = this.normalizeSplitOrientation(state.splitOrientation);
        return state;
    }

    createModel(sessionId) {
        const model = new NotesModel({
            id: `session:${sessionId}`,
            debounceMs: 800,
            saveFn: ({ content, version }) => this.apiService.updateSessionNote(sessionId, { content, version }),
            loadFn: () => this.apiService.getSessionNote(sessionId),
            computeStatusText: computeDefaultStatusText,
            relativeTimeFormatter: formatRelativeTime,
            getCurrentUser: () => this.getCurrentUsername(),
            onConflict: (snapshot) => {
                if (!snapshot) return false;
                model.markPendingRemote(snapshot, {
                    message: 'Update conflict detected. Load latest changes to continue.',
                    state: 'error',
                    showLoadButton: true
                });
                return true;
            }
        });

        model.updateState({
            viewMode: 'plain',
            splitOrientation: 'horizontal',
            lastSyncSignature: null
        });

        model.on('change', () => this.onModelChange(sessionId));
        model.on('status', () => this.onModelStatus(sessionId));

        return model;
    }

    onModelChange(sessionId) {
        this.refreshUI(sessionId, { overrideEditor: false });
    }

    onModelStatus(sessionId) {
        this.updateStatus(sessionId);
    }

    syncStateFromSession(sessionId, sessionData) {
        const model = this.ensureModel(sessionId);
        const state = model?.getState();
        if (!state || !sessionData) return state;

        const hasNote = Object.prototype.hasOwnProperty.call(sessionData, 'note');
        const hasVersion = Object.prototype.hasOwnProperty.call(sessionData, 'note_version');
        const hasUpdatedAt = Object.prototype.hasOwnProperty.call(sessionData, 'note_updated_at');
        const hasUpdatedBy = Object.prototype.hasOwnProperty.call(sessionData, 'note_updated_by');

        const patch = {};

        if (hasNote || hasVersion || hasUpdatedAt || hasUpdatedBy) {
            let incomingContent = state.lastSavedContent ?? '';
            let incomingUpdatedAt = null;
            let incomingUpdatedBy = null;
            let incomingVersion = undefined;

            if (hasNote) {
                if (typeof sessionData.note === 'string') {
                    incomingContent = sessionData.note;
                } else if (sessionData.note && typeof sessionData.note === 'object') {
                    const noteObj = sessionData.note;
                    incomingContent = typeof noteObj.content === 'string' ? noteObj.content : (state.lastSavedContent ?? '');
                    incomingUpdatedAt = noteObj.updated_at || noteObj.updatedAt || null;
                    incomingUpdatedBy = noteObj.updated_by || noteObj.updatedBy || null;
                    if (Number.isInteger(noteObj.version)) {
                        incomingVersion = noteObj.version;
                    }
                }
            }

            patch.lastSavedContent = incomingContent;
            if (!state.pendingRemote) {
                patch.content = incomingContent;
            }

            if (hasVersion && Number.isInteger(sessionData.note_version)) {
                patch.version = sessionData.note_version;
            } else if (Number.isInteger(incomingVersion)) {
                patch.version = incomingVersion;
            } else if (!hasVersion && typeof state.version !== 'number') {
                patch.version = 0;
            }

            if (hasUpdatedAt) {
                patch.updatedAt = sessionData.note_updated_at || null;
            } else if (incomingUpdatedAt != null) {
                patch.updatedAt = incomingUpdatedAt;
            }

            if (hasUpdatedBy) {
                patch.updatedBy = sessionData.note_updated_by || null;
            } else if (incomingUpdatedBy != null) {
                patch.updatedBy = incomingUpdatedBy;
            }
        }

        const normalizedViewMode = this.normalizeViewMode(state.viewMode);
        if (state.viewMode !== normalizedViewMode) {
            patch.viewMode = normalizedViewMode;
        }

        if (!Object.prototype.hasOwnProperty.call(state, 'lastSyncSignature')) {
            patch.lastSyncSignature = state.lastSyncSignature ?? null;
        }

        const normalizedSplit = this.normalizeSplitOrientation(state.splitOrientation);
        if (state.splitOrientation !== normalizedSplit) {
            patch.splitOrientation = normalizedSplit;
        }

        if (Object.keys(patch).length > 0) {
            model.updateState(patch);
        }

        return model.getState();
    }

    ensureTab(sessionId) {
        const sessionTabs = this.tabManager.sessionTabs.get(sessionId);
        if (!sessionTabs) return null;

        let noteTab = sessionTabs.get('note');
        const state = this.ensureState(sessionId);

        if (noteTab) {
            return noteTab;
        }

        const editor = createNoteEditor({
            contentArea: this.tabManager.contentArea,
            tabId: 'note',
            sessionId,
            viewClass: 'note-view',
            title: 'Notes',
            includeSendButton: true
        });
        if (!editor) return null;

        const { element: contentView, textarea, previewEl: preview, statusEl: status, loadButton: loadBtn, sendSelectionButton: sendSelectionBtn, viewButtons, splitToggleButton, searchToggleButton, editorStack, highlightsEl, highlightsContentEl, searchPanel, searchFindInput, searchReplaceInput, searchPrevBtn, searchNextBtn, searchReplaceBtn, searchReplaceAllBtn, searchCloseBtn, searchCountEl } = editor;

        // Wire view buttons active state
        (viewButtons || []).forEach((btn) => {
            if ((state.viewMode || 'plain') === btn.dataset?.viewMode) {
                btn.classList.add('active');
            }
            const handler = () => this.setViewMode(sessionId, btn.dataset.viewMode);
            btn.addEventListener('click', handler);
            // Keep a reference for cleanup
            btn._handler = handler;
        });
        // Wire split toggle
        const splitToggleHandler = () => this.toggleSplitOrientation(sessionId);
        splitToggleButton.addEventListener('click', splitToggleHandler);

        // Wire search/replace panel toggle
        const searchToggleHandler = () => this.toggleSearchPanel(sessionId);
        if (searchToggleButton) searchToggleButton.addEventListener('click', searchToggleHandler);

        // Initialize content
        textarea.value = state.content || '';

        const updateSendSelectionState = () => this.updateSendSelectionButtonState(sessionId);

        const inputHandler = () => {
            this.handleNoteInput(sessionId, textarea);
            updateSendSelectionState();
        };
        const blurHandler = (event) => {
            const model = this.ensureModel(sessionId);
            if (model) {
                model.saveNow().catch((error) => {
                    console.warn('[NotesController] Note save failed on blur:', error);
                });
            }
            const nextFocusTarget = event?.relatedTarget || document.activeElement;
            if (nextFocusTarget !== sendSelectionBtn) {
                this.clearTextareaSelection(textarea);
            }
            updateSendSelectionState();
        };
        const loadHandler = () => this.applyPendingRemote(sessionId);
        const keydownHandler = (event) => this.handleEditorKeydown(event, sessionId, textarea);
        const selectHandler = () => updateSendSelectionState();
        const keyupHandler = () => updateSendSelectionState();
        const mouseupHandler = () => updateSendSelectionState();
        const sendSelectionHandler = () => this.handleSendSelectionButtonClick(sessionId, textarea);

        textarea.addEventListener('input', inputHandler);
        textarea.addEventListener('focusout', blurHandler);
        textarea.addEventListener('keydown', keydownHandler);
        textarea.addEventListener('select', selectHandler);
        textarea.addEventListener('keyup', keyupHandler);
        textarea.addEventListener('mouseup', mouseupHandler);
        loadBtn.addEventListener('click', loadHandler);
        sendSelectionBtn.addEventListener('click', sendSelectionHandler);

        noteTab = {
            id: 'note',
            title: 'Notes',
            type: 'note',
            sessionId,
            element: contentView,
            textarea,
            previewEl: preview,
            statusEl: status,
            loadButton: loadBtn,
            sendSelectionButton: sendSelectionBtn,
            viewButtons: viewButtons.map(({ element }) => element),
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
            searchCountEl,
            closeable: false,
            cleanup: () => {
                textarea.removeEventListener('input', inputHandler);
                textarea.removeEventListener('focusout', blurHandler);
                textarea.removeEventListener('keydown', keydownHandler);
                textarea.removeEventListener('select', selectHandler);
                textarea.removeEventListener('keyup', keyupHandler);
                textarea.removeEventListener('mouseup', mouseupHandler);
                loadBtn.removeEventListener('click', loadHandler);
                sendSelectionBtn.removeEventListener('click', sendSelectionHandler);
                (viewButtons || []).forEach((element) => {
                    const handler = element._handler;
                    if (handler) element.removeEventListener('click', handler);
                    delete element._handler;
                });
                splitToggleButton.removeEventListener('click', splitToggleHandler);
                if (searchToggleButton) searchToggleButton.removeEventListener('click', searchToggleHandler);
                // Remove search panel handlers if present
                try {
                    const h = noteTab._searchHandlers;
                    if (h) {
                        if (noteTab.searchFindInput) {
                            noteTab.searchFindInput.removeEventListener('input', h.onFindInput);
                            noteTab.searchFindInput.removeEventListener('keydown', h.onFindKeyDown);
                        }
                        if (noteTab.searchPrevBtn) noteTab.searchPrevBtn.removeEventListener('click', h.onPrev);
                        if (noteTab.searchNextBtn) noteTab.searchNextBtn.removeEventListener('click', h.onNext);
                        if (noteTab.searchReplaceBtn) noteTab.searchReplaceBtn.removeEventListener('click', h.onReplace);
                        if (noteTab.searchReplaceAllBtn) noteTab.searchReplaceAllBtn.removeEventListener('click', h.onReplaceAll);
                        if (noteTab.searchReplaceInput) noteTab.searchReplaceInput.removeEventListener('keydown', h.onReplaceKeyDown);
                        if (noteTab.searchCloseBtn) noteTab.searchCloseBtn.removeEventListener('click', h.onClose);
                        delete noteTab._searchHandlers;
                    }
                } catch (_) {}
                // Remove scroll sync handler if stored
                try {
                    if (noteTab._scrollHandler) {
                        textarea.removeEventListener('scroll', noteTab._scrollHandler);
                        delete noteTab._scrollHandler;
                    }
                } catch (_) {}
                // Clear highlight DOM
                try { if (highlightsContentEl) highlightsContentEl.innerHTML = ''; } catch (_) {}
            }
        };

        sessionTabs.set('note', noteTab);

        this.renderPreview(sessionId, state.content || '');
        this.updateStatus(sessionId);
        this.applyViewMode(sessionId, state.viewMode || 'plain');
        this.applyEditorAccess(sessionId);
        this.updateSendSelectionButtonState(sessionId);
        // Sync highlights scroll with textarea
        const scrollHandler = () => {
            try {
                if (noteTab?.highlightsContentEl) {
                    noteTab.highlightsContentEl.style.transform = `translateY(-${textarea.scrollTop}px)`;
                }
            } catch (_) {}
        };
        textarea.addEventListener('scroll', scrollHandler, { passive: true });
        noteTab._scrollHandler = scrollHandler;
        // Initial render
        this._renderHighlights(sessionId);
        this._wireSearchControls(sessionId, noteTab);

        return noteTab;
    }

    getNoteTab(sessionId) {
        const sessionTabs = this.tabManager.sessionTabs.get(sessionId);
        if (!sessionTabs) return null;
        return sessionTabs.get('note') || null;
    }

    removeTab(sessionId) {
        const sessionTabs = this.tabManager.sessionTabs.get(sessionId);
        if (!sessionTabs || !sessionTabs.has('note')) return;
        const tab = sessionTabs.get('note');
        if (tab?.cleanup) {
            try { tab.cleanup(); } catch (_) {}
        }
        if (tab?.element?.remove) {
            try { tab.element.remove(); } catch (_) {}
        }
        sessionTabs.delete('note');
        const sessionActiveTab = this.tabManager.sessionActiveTab;
        if (sessionActiveTab.get(sessionId) === 'note') {
            sessionActiveTab.set(sessionId, 'terminal');
        }
        if (this.tabManager.currentSessionId === sessionId && this.tabManager.activeTabId === 'note') {
            this.tabManager.switchToTab('terminal');
        }
        const btn = this.tabManager.tabsContainer?.querySelector('.terminal-tab[data-tab-id="note"]');
        if (btn) {
            try { btn.remove(); } catch (_) {}
        }
        this.clearNoteSaveTimer(sessionId);
        const model = this.noteModels.get(sessionId);
        model?.destroy();
        this.noteModels.delete(sessionId);
    }

    setViewMode(sessionId, mode) {
        const model = this.ensureModel(sessionId);
        if (!model) return;
        const nextMode = this.normalizeViewMode(mode);
        model.updateState({ viewMode: nextMode });
        this.applyViewMode(sessionId, nextMode);
    }

    toggleSplitOrientation(sessionId) {
        const model = this.ensureModel(sessionId);
        const state = model?.getState();
        if (!state || this.normalizeViewMode(state.viewMode) !== 'split') {
            return;
        }
        const current = this.normalizeSplitOrientation(state.splitOrientation);
        const next = current === 'vertical' ? 'horizontal' : 'vertical';
        model.updateState({ splitOrientation: next });
        this.applyViewMode(sessionId, state.viewMode);
    }

    applyViewMode(sessionId, mode) {
        const tab = this.getNoteTab(sessionId);
        if (!tab) return;

        const normalized = this.normalizeViewMode(mode);
        const state = this.ensureState(sessionId);
        const orientation = this.normalizeSplitOrientation(state.splitOrientation);
        state.splitOrientation = orientation;
        const viewElement = tab.element;
        if (viewElement) {
            applyNoteViewMode({ container: viewElement, mode: normalized, splitOrientation: orientation });
        }

        if (tab.splitToggleButton) {
            // Show toggle only in split mode
            tab.splitToggleButton.style.display = normalized === 'split' ? '' : 'none';
            const label = orientation === 'vertical'
                ? 'Switch to side-by-side split'
                : 'Switch to top-to-bottom split';
            tab.splitToggleButton.classList.toggle('note-split-toggle--vertical', orientation === 'vertical');
            tab.splitToggleButton.setAttribute('aria-label', label);
            tab.splitToggleButton.setAttribute('aria-pressed', orientation === 'vertical' ? 'true' : 'false');
            tab.splitToggleButton.title = label;
        }

        if (tab.searchPanel) {
            const visible = (normalized === 'plain' || normalized === 'split');
            tab.searchPanel.style.display = visible ? '' : 'none';
            // If switching to Markdown-only, also fully close the panel so it won't pop back open
            if (!visible) {
                try { this.closeSearchPanel(sessionId); } catch (_) {}
            }
        }

        this.updateSendSelectionButtonState(sessionId);
    }

    async handleEditorKeydown(event, sessionId, textarea) {
        if (!event || !textarea) return;
        if (event.repeat) return;
        if (event.key !== 'Enter') return;
        if (!event.shiftKey) return;

        const usesMeta = event.metaKey && !event.ctrlKey;
        const usesAlt = event.altKey && !event.ctrlKey;
        if (!usesMeta && !usesAlt) return;

        if (textarea.readOnly) {
            return;
        }

        const selection = this.getSelectedText(textarea);
        if (!selection || !selection.trim()) {
            return;
        }

        if (!this.canSendSelectionToTerminal(sessionId)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const sent = await this.sendSelectionToTerminal(sessionId, selection);
        if (sent) {
            try { this.tabManager?.switchToTab?.('terminal'); } catch (_) {}
            this.clearTextareaSelection(textarea);
        }

        this.updateSendSelectionButtonState(sessionId);
    }

    _handleSearchKey(_event) {
        try {
            const sid = this.tabManager?.currentSessionId;
            if (!sid) return false;
            const model = this.ensureModel(sid);
            const vm = model?.getState()?.viewMode || 'plain';
            if (vm !== 'plain' && vm !== 'split') return false;
            this.openSearchPanel(sid);
            return true;
        } catch (_) {
            return false;
        }
    }

    ensureSearchState(sessionId) {
        if (!sessionId) return null;
        if (!this._searchState.has(sessionId)) {
            this._searchState.set(sessionId, {
                matches: [],
                current: -1,
                lastQuery: '',
                open: false
            });
        }
        return this._searchState.get(sessionId);
    }

    openSearchPanel(sessionId) {
        const tab = this.getNoteTab(sessionId);
        if (!tab?.textarea || !tab?.searchPanel) return;
        const state = this.ensureModel(sessionId)?.getState() || {};
        const viewMode = (state.viewMode || 'plain');
        if (viewMode !== 'plain' && viewMode !== 'split') return;
        const s = this.ensureSearchState(sessionId);
        if (tab.searchPanel.hidden === false) {
            try { tab.searchFindInput.focus(); tab.searchFindInput.select(); } catch (_) {}
            this._renderHighlights(sessionId);
            return;
        }
        tab.searchPanel.hidden = false;
        s.open = true;

        // Prefill from selection or last query
        const selection = this.getSelectedText(tab.textarea);
        const prefill = selection && selection.length > 0 ? selection : (s.lastQuery || '');
        if (tab.searchFindInput) {
            tab.searchFindInput.value = prefill;
            try { tab.searchFindInput.focus(); tab.searchFindInput.select(); } catch (_) {}
        }
        this._recomputeSearchMatches(sessionId);
        if (s.matches && s.matches.length > 0) {
            // If selection matches a hit, jump there; else jump to first
            let idx = 0;
            if (selection && selection.length > 0) {
                const start = tab.textarea.selectionStart || 0;
                idx = s.matches.findIndex(([a, b]) => a === start && b === start + selection.length);
                if (idx < 0) {
                    const caret = start;
                    idx = s.matches.findIndex(([a]) => a >= caret);
                    if (idx < 0) idx = 0;
                }
            }
            this._gotoMatch(sessionId, idx);
        } else {
            this._updateSearchCount(sessionId);
            this._renderHighlights(sessionId);
        }
    }

    closeSearchPanel(sessionId) {
        const tab = this.getNoteTab(sessionId);
        const s = this.ensureSearchState(sessionId);
        if (!tab?.searchPanel) return;
        tab.searchPanel.hidden = true;
        s.open = false;
        // Disable highlight rendering mode
        if (tab.editorStack) {
            tab.editorStack.classList.remove('note-editor--with-highlights');
        }
    }

    _buildSearchOverlay(_sessionId, _tab) {
        // No-op: overlay removed in favor of inline search panel
        return null;
    }

    _recomputeSearchMatches(sessionId) {
        const s = this.ensureSearchState(sessionId);
        const tab = this.getNoteTab(sessionId);
        if (!s || !tab?.textarea || !tab?.searchFindInput) return;
        const text = String(tab.textarea.value || '');
        const query = String(tab.searchFindInput.value || '');
        s.matches = this._computeMatches(text, query);
        if (s.matches.length === 0) {
            s.current = -1;
        } else {
            const caret = typeof tab.textarea.selectionStart === 'number' ? tab.textarea.selectionStart : 0;
            let idx = s.matches.findIndex(([a]) => a >= caret);
            if (idx < 0) idx = 0;
            s.current = idx;
        }
        this._updateSearchCount(sessionId);
        this._renderHighlights(sessionId);
        this._scrollCurrentMatchIntoView(sessionId);
    }

    _computeMatches(text, query) {
        return nsuComputeMatches(text, query);
    }

    _updateSearchCount(sessionId) {
        const s = this.ensureSearchState(sessionId);
        const tab = this.getNoteTab(sessionId);
        if (!tab?.searchCountEl) return;
        const total = s.matches?.length || 0;
        tab.searchCountEl.textContent = nsuFormatSearchCount(s.current, total);
    }

    _gotoMatch(sessionId, index) {
        const s = this.ensureSearchState(sessionId);
        const tab = this.getNoteTab(sessionId);
        if (!s || !tab?.textarea) return;
        if (!s.matches || s.matches.length === 0) return;
        const len = s.matches.length;
        const idx = ((index % len) + len) % len;
        s.current = idx;
        const [start, end] = s.matches[idx];
        const keepFindFocus = (typeof document !== 'undefined') && (document.activeElement === tab.searchFindInput);
        if (keepFindFocus) {
            this.clearTextareaSelection(tab.textarea);
        } else {
            this._selectRange(tab.textarea, start, end, true);
        }
        this._updateSearchCount(sessionId);
        this._renderHighlights(sessionId);
        this._scrollCurrentMatchIntoView(sessionId);
    }

    _gotoNextMatch(sessionId) {
        const s = this.ensureSearchState(sessionId);
        if (!s || !s.matches || s.matches.length === 0) return;
        const next = s.current >= 0 ? s.current + 1 : 0;
        this._gotoMatch(sessionId, next);
    }

    _gotoPrevMatch(sessionId) {
        const s = this.ensureSearchState(sessionId);
        if (!s || !s.matches || s.matches.length === 0) return;
        const prev = s.current >= 0 ? s.current - 1 : 0;
        this._gotoMatch(sessionId, prev);
    }

    _replaceCurrent(sessionId) {
        const s = this.ensureSearchState(sessionId);
        const tab = this.getNoteTab(sessionId);
        if (!s || !tab?.textarea) return;
        if (!s.matches || s.matches.length === 0 || s.current < 0) return;
        const [start, end] = s.matches[s.current];
        const text = String(tab.textarea.value || '');
        const replacement = String(tab?.searchReplaceInput?.value || '');
        const before = text.slice(0, start);
        const after = text.slice(end);
        const newText = before + replacement + after;
        tab.textarea.value = newText;
        this.handleNoteInput(sessionId, tab.textarea);
        // Recompute matches and move to next occurrence after replaced text
        const nextCaret = start + replacement.length;
        this._recomputeSearchMatches(sessionId);
        const nextIdx = (s.matches || []).findIndex(([a]) => a >= nextCaret);
        if (nextIdx >= 0) this._gotoMatch(sessionId, nextIdx);
        else this._updateSearchCount(sessionId);
        this._renderHighlights(sessionId);
    }

    _replaceAll(sessionId) {
        const s = this.ensureSearchState(sessionId);
        const tab = this.getNoteTab(sessionId);
        if (!s || !tab?.textarea) return;
        const query = String(tab?.searchFindInput?.value || '');
        if (!query) return;
        const replacement = String(tab?.searchReplaceInput?.value || '');
        const text = String(tab.textarea.value || '');
        if (query.length === 0) return;
        const newText = text.split(query).join(replacement);
        tab.textarea.value = newText;
        this.handleNoteInput(sessionId, tab.textarea);
        this._recomputeSearchMatches(sessionId);
        this._updateSearchCount(sessionId);
        this._renderHighlights(sessionId);
    }

    _renderHighlights(sessionId) {
        const tab = this.getNoteTab(sessionId);
        if (!tab?.highlightsContentEl) return;
        const s = this.ensureSearchState(sessionId);
        nsuRenderHighlights({
            text: String(tab.textarea?.value || ''),
            matches: Array.isArray(s?.matches) ? s.matches : [],
            currentIndex: Number.isInteger(s?.current) ? s.current : -1,
            highlightsContentEl: tab.highlightsContentEl,
            textarea: tab.textarea,
            editorStack: tab.editorStack,
            searchPanelVisible: tab.searchPanel && tab.searchPanel.hidden === false
        });
    }

    _scrollCurrentMatchIntoView(sessionId) {
        const tab = this.getNoteTab(sessionId);
        const s = this.ensureSearchState(sessionId);
        if (!tab?.highlightsContentEl || !tab?.textarea || !s || !Array.isArray(s.matches)) return;
        if (s.current < 0 || s.current >= s.matches.length) return;
        nsuScrollCurrentIntoView({
            highlightsContentEl: tab.highlightsContentEl,
            textarea: tab.textarea,
            currentIndex: s.current
        });
    }

    _selectRange(textarea, start, end, focus) { nsuSelectRange(textarea, start, end, focus); }

    getSelectedText(textarea) { return nsuGetSelectedText(textarea); }

    clearTextareaSelection(textarea) { nsuClearSelection(textarea); }

    updateSendSelectionButtonState(sessionId) {
        const tab = this.getNoteTab(sessionId);
        if (!tab?.sendSelectionButton || !tab?.textarea) return;

        const textarea = tab.textarea;
        const isFocused = (typeof document !== 'undefined') && document.activeElement === textarea;
        const hasSelection = isFocused && Boolean(this.getSelectedText(textarea)?.trim());
        const canSend = this.canSendSelectionToTerminal(sessionId);
        const enabled = hasSelection && canSend && !textarea.readOnly;

        tab.sendSelectionButton.disabled = !enabled;
        tab.sendSelectionButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }

    handleTabSwitched(payload) {
        try {
            const sessionId = payload?.tab?.sessionId || this.tabManager?.currentSessionId;
            const newTabId = payload?.tabId || null;
            if (newTabId === 'workspace-note') {
                return;
            }
            if (sessionId && newTabId) {
                const previousTabId = this._activeSessionTabs.get(sessionId);
                if (newTabId === 'note' && previousTabId && previousTabId !== 'note' && previousTabId !== 'workspace-note') {
                    this._lastSessionTabs.set(sessionId, previousTabId);
                }
                if (newTabId !== 'note') {
                    this._lastSessionTabs.delete(sessionId);
                }
                this._activeSessionTabs.set(sessionId, newTabId);
            }

            if (!sessionId) return;
            const tab = this.getNoteTab(sessionId);
            if (!tab?.textarea) return;
            if (!payload || payload.tabId !== 'note') {
                this.clearTextareaSelection(tab.textarea);
            }
            this.updateSendSelectionButtonState(sessionId);
        } catch (_) {}
    }

    handleGlobalKeydown(event) {
        if (!event) return false;
        const key = event.key;
        if (key !== 'ArrowDown' && key !== 'ArrowUp') return false;
        if (event.shiftKey || event.ctrlKey) return false;

        const usesMeta = event.metaKey && !event.altKey;
        const usesAlt = event.altKey && !event.metaKey;
        if (!usesMeta && !usesAlt) {
            return false;
        }

        const sessionId = this.tabManager?.currentSessionId;
        if (!sessionId) return false;
        if (this.tabManager?.activeTabId !== 'note') return false;

        const tab = this.getNoteTab(sessionId);
        if (!tab?.textarea) return false;

        const textarea = tab.textarea;
        const isTextareaFocused = document.activeElement === textarea;

        if (key === 'ArrowDown') {
            if (isTextareaFocused) return false;
            try { textarea.focus({ preventScroll: true }); } catch (_) { try { textarea.focus(); } catch (_) {} }
            this.clearTextareaSelection(textarea);
            this.updateSendSelectionButtonState(sessionId);
            return true;
        }

        if (key === 'ArrowUp') {
            if (!isTextareaFocused) return false;
            try { textarea.blur(); } catch (_) {}
            this.clearTextareaSelection(textarea);
            this.updateSendSelectionButtonState(sessionId);
            return true;
        }

        return false;
    }

    async handleSendSelectionButtonClick(sessionId, textarea) {
        if (!textarea || textarea.readOnly) {
            return;
        }

        if (!this.canSendSelectionToTerminal(sessionId)) {
            return;
        }

        const selection = this.getSelectedText(textarea);
        if (!selection || !selection.trim()) {
            return;
        }

        const sent = await this.sendSelectionToTerminal(sessionId, selection);
        if (sent) {
            try { this.tabManager?.switchToTab?.('terminal'); } catch (_) {}
            this.clearTextareaSelection(textarea);
        }

        this.updateSendSelectionButtonState(sessionId);
    }

    canSendSelectionToTerminal(sessionId) {
        try {
            const sessionData = this.getSessionDataForNotes(sessionId);
            if (!sessionData) return false;
            if (sessionData.is_active === false) return false;

            const app = this.getContext?.()?.app;
            const terminalManager = app?.modules?.terminal;
            if (!terminalManager) return false;

            if (typeof terminalManager.isSessionAttached === 'function' && !terminalManager.isSessionAttached(sessionId)) {
                return false;
            }

            if (typeof terminalManager.isSessionInteractive === 'function' && !terminalManager.isSessionInteractive(sessionData)) {
                return false;
            }

            return this.hasInteractionPermission(sessionData, terminalManager);
        } catch (_) {
            return false;
        }
    }

    hasInteractionPermission(sessionData, terminalManager) {
        if (!sessionData) return false;
        const visibility = (sessionData.visibility || 'private').toLowerCase();
        const currentUser = (terminalManager?.getCurrentUsername?.() || this.getCurrentUsername() || '').trim();
        const owner = String(sessionData.created_by || '').trim();

        const permissionObject = sessionData.permissions || sessionData.viewer_permissions;
        if (permissionObject && Object.prototype.hasOwnProperty.call(permissionObject, 'can_interact')) {
            if (permissionObject.can_interact === true) {
                return true;
            }
            if (permissionObject.can_interact === false) {
                return false;
            }
        }

        if (!currentUser) {
            return false;
        }

        if (visibility === 'public') {
            return true;
        }

        if (visibility === 'shared_readonly') {
            return currentUser === owner;
        }

        if (visibility === 'private') {
            return currentUser === owner;
        }

        return false;
    }

    async sendSelectionToTerminal(sessionId, text) {
        if (!text) return false;
        try {
            const terminalManager = this.getContext?.()?.app?.modules?.terminal;
            if (!terminalManager?.wsClient?.send) return false;
            const ok = await sendStdinWithDelayedSubmit(terminalManager.wsClient, sessionId, text, {
                delayMs: 120,
                enterStyle: 'cr',
                normalizeCRLF: true,
                stripFinalNewline: true
            });
            // After sending, ensure the terminal viewport is at the end
            try { terminalManager?._scrollSessionToBottom?.(sessionId); } catch (_) {}
            return ok;
        } catch (error) {
            console.warn('[NotesController] Failed to send selected text to terminal:', error);
            return false;
        }
    }

    refreshUI(sessionId, options = {}) {
        const tab = this.getNoteTab(sessionId);
        if (!tab) return;
        const state = this.ensureState(sessionId);

        const overrideEditor = options.overrideEditor !== false;
        if (overrideEditor && tab.textarea) {
            tab.textarea.value = state.content || '';
        }

        const previewSource = overrideEditor && tab.textarea
            ? state.content || ''
            : (tab.textarea?.value ?? state.content ?? '');

        this.renderPreview(sessionId, previewSource);
        this.applyViewMode(sessionId, state.viewMode || 'plain');
        this.applyEditorAccess(sessionId);
        this.updateStatus(sessionId);
        this.updateSendSelectionButtonState(sessionId);
        this.updateNoteTabIndicator(sessionId);
    }

    normalizeViewMode(mode) {
        const fallback = 'plain';
        if (!mode) return fallback;
        switch (mode) {
            case 'plain':
            case 'split':
            case 'markdown':
                return mode;
            case 'edit':
                return 'plain';
            case 'preview':
                return 'markdown';
            default:
                return fallback;
        }
    }

    normalizeSplitOrientation(orientation) {
        if (!orientation) return 'horizontal';
        const value = String(orientation).toLowerCase();
        if (value === 'vertical' || value === 'rows') {
            return 'vertical';
        }
        return 'horizontal';
    }

    applyEditorAccess(sessionId) {
        const tab = this.getNoteTab(sessionId);
        if (!tab?.textarea) return;
        const editable = this.canEditSessionNotes(sessionId);
        tab.textarea.readOnly = !editable;
        tab.textarea.classList.toggle('note-editor--readonly', !editable);
        this.updateSendSelectionButtonState(sessionId);
    }

    renderPreview(sessionId, text) {
        const tab = this.getNoteTab(sessionId);
        if (!tab || !tab.previewEl) return;
        const value = typeof text === 'string' ? text : '';
        if (!value.trim()) {
            tab.previewEl.innerHTML = '';
            return;
        }
        tab.previewEl.innerHTML = renderMarkdown(value);
    }

    updateNoteTabIndicator(sessionId) {
        if (!sessionId || !this.tabManager?.tabsContainer) {
            return;
        }

        const tabButton = this.tabManager.tabsContainer.querySelector('.terminal-tab[data-tab-id="note"]');
        if (!tabButton) {
            return;
        }

        const state = this.ensureState(sessionId);
        const sources = [
            state?.content,
            state?.pendingRemote?.content,
            state?.lastSavedContent,
            state?.pendingSave?.content
        ];

        const hasNote = sources.some((value) => {
            if (typeof value !== 'string') return false;
            return value.trim().length > 0;
        });

        tabButton.classList.toggle('terminal-tab--has-note', hasNote);

        // Color the title icon instead of adding a separate badge
        // (falls back to previous indicator if needed)
        try {
            const titleIcon = tabButton.querySelector('.terminal-tab-title .bi');
            if (titleIcon) {
                return;
            }
        } catch (_) {}
        // Legacy fallback: keep indicator behavior if title icon is missing
        let indicator = tabButton.querySelector('.terminal-tab-note-indicator');
        if (hasNote) {
            if (!indicator) {
                indicator = document.createElement('span');
                indicator.className = 'terminal-tab-note-indicator';
                indicator.setAttribute('aria-hidden', 'true');
                indicator.title = 'Session note available';
                try {
                    const icon = iconUtils.createIcon('journal-text', { size: 14, className: 'terminal-tab-note-icon' });
                    indicator.appendChild(icon);
                } catch (_) {}
                tabButton.appendChild(indicator);
            } else {
                indicator.title = 'Session note available';
            }
        } else if (indicator) {
            indicator.remove();
        }
    }

    updateStatus(sessionId, message = undefined, stateName = undefined, options = {}) {
        const model = this.ensureModel(sessionId);
        if (!model) return;

        const hasOverride = message !== undefined || stateName !== undefined || (options && Object.keys(options).length > 0);
        if (hasOverride) {
            const targetState = stateName || model.getStatus().state;
            model.setStatus(targetState, message, options);
            return;
        }

        const tab = this.getNoteTab(sessionId);
        if (!tab || !tab.statusEl) return;

        const status = model.getStatus();
        tab.statusEl.classList.remove(...NoteStatusClasses);
        tab.statusEl.classList.add(`note-status--${status.state}`);
        const computed = computeDefaultStatusText(model.getState(), formatRelativeTime, this.getCurrentUsername());
        const text = status.state === 'idle' ? computed : (status.message || computed);
        tab.statusEl.textContent = text;

        if (tab.loadButton) {
            tab.loadButton.hidden = !status.showLoadButton;
        }

        this.updateNoteTabIndicator(sessionId);
    }

    handleNoteInput(sessionId, textarea) {
        if (!this.isEnabled()) return;
        const model = this.ensureModel(sessionId);
        if (!model) return;
        model.setContent(textarea?.value ?? '');
        model.updateState({ lastSyncSignature: null });
        // Update search results live if search panel is open
        try {
            const tab = this.getNoteTab(sessionId);
            if (tab?.searchPanel && tab.searchPanel.hidden === false) {
                this._recomputeSearchMatches(sessionId);
            }
        } catch (_) {}
    }

    clearNoteSaveTimer(sessionId) {
        const model = this.noteModels.get(sessionId);
        model?.cancelScheduledSave();
    }

    scheduleNoteSave(sessionId) {
        if (!this.isEnabled()) return;
        const model = this.ensureModel(sessionId);
        model?.scheduleSave();
    }

    async saveNote(sessionId) {
        if (!this.isEnabled()) return;
        const model = this.ensureModel(sessionId);
        if (!model) return;
        await model.saveNow({ currentUser: this.getCurrentUsername() });
    }

    async saveNoteInternal(sessionId) {
        return this.saveNote(sessionId);
    }

    applyPendingRemote(sessionId) {
        const model = this.ensureModel(sessionId);
        if (!model) return;
        const applied = model.applyPendingRemote({
            statusState: 'success',
            statusMessage: 'Loaded latest changes',
            statusDelay: 2000
        });
        if (applied && sessionId === this.tabManager.currentSessionId) {
            this.refreshUI(sessionId, { overrideEditor: true });
        }
    }

    handleNoteUpdated(data) {
        if (!data || !data.sessionId) return;
        const sessionId = data.sessionId;
        const model = this.ensureModel(sessionId);
        const state = model?.getState();
        if (!model || !state) return;
        const incomingContent = typeof data.note === 'string' ? data.note : '';
        const incomingVersion = Number.isInteger(data.version) ? data.version : state.version;
        const incomingUpdatedAt = data.updatedAt || null;
        const incomingUpdatedBy = data.updatedBy || null;

        const pendingSave = state.pendingSave;
        const currentUser = this.getCurrentUsername();

        const matchesPendingSave = !!(pendingSave
            && incomingContent === pendingSave.content
            && (incomingVersion === pendingSave.versionSent || incomingVersion === pendingSave.versionSent + 1 || incomingVersion >= pendingSave.versionSent)
            && (!incomingUpdatedBy || incomingUpdatedBy === pendingSave.user || pendingSave.user === '' || incomingUpdatedBy === currentUser));

        if (matchesPendingSave) {
            const resolvedUpdatedAt = incomingUpdatedAt ?? state.updatedAt;
            const resolvedUpdatedBy = incomingUpdatedBy ?? (pendingSave.user || state.updatedBy);
            const patch = {
                pendingRemote: null,
                pendingSave: null,
                lastSavedContent: incomingContent,
                version: incomingVersion,
                updatedAt: resolvedUpdatedAt,
                updatedBy: resolvedUpdatedBy,
                lastSyncSignature: {
                    version: incomingVersion,
                    updatedAt: resolvedUpdatedAt,
                    updatedBy: resolvedUpdatedBy
                }
            };
            if (state.content === pendingSave.content) {
                patch.content = incomingContent;
            }
            model.updateState(patch);
            if (sessionId === this.tabManager.currentSessionId) {
                this.refreshUI(sessionId, { overrideEditor: true });
                this.updateStatus(sessionId, 'Saved', 'success', { delay: 1500 });
            }
            return;
        }

        const signature = state.lastSyncSignature;
        const matchesLocalSave = !!(signature
            && incomingVersion === signature.version
            && incomingContent === state.lastSavedContent
            && (signature.updatedBy == null || signature.updatedBy === (incomingUpdatedBy ?? signature.updatedBy)));

        if (matchesLocalSave) {
            const syncedSignature = {
                version: incomingVersion,
                updatedAt: incomingUpdatedAt ?? signature?.updatedAt ?? state.updatedAt,
                updatedBy: incomingUpdatedBy ?? signature?.updatedBy ?? state.updatedBy
            };
            model.updateState({
                pendingRemote: null,
                pendingSave: null,
                updatedAt: syncedSignature.updatedAt,
                updatedBy: syncedSignature.updatedBy,
                lastSyncSignature: syncedSignature
            });
            if (data.isCurrent && this.isEnabled()) {
                this.updateStatus(sessionId, 'Saved', 'success', { delay: 1500 });
            }
            return;
        }

        const contentChanged = incomingContent !== state.lastSavedContent || incomingVersion !== state.version;

        if (!contentChanged) {
            const resolvedUpdatedAt = incomingUpdatedAt ?? state.updatedAt;
            const resolvedUpdatedBy = incomingUpdatedBy ?? state.updatedBy;
            model.updateState({
                updatedAt: resolvedUpdatedAt,
                updatedBy: resolvedUpdatedBy,
                lastSyncSignature: {
                    version: incomingVersion,
                    updatedAt: resolvedUpdatedAt,
                    updatedBy: resolvedUpdatedBy
                },
                pendingSave: null
            });
            if (data.isCurrent && this.isEnabled()) {
                this.updateStatus(sessionId);
            }
            return;
        }

        const hasUnsavedChanges = state.content !== state.lastSavedContent;
        if (hasUnsavedChanges && data.isCurrent) {
            model.markPendingRemote({
                content: incomingContent,
                version: incomingVersion,
                updated_at: incomingUpdatedAt,
                updated_by: incomingUpdatedBy
            }, {
                message: 'Remote changes detected. Load latest to continue editing.',
                state: 'warning',
                showLoadButton: true
            });
            model.updateState({
                lastSyncSignature: null
            });
            return;
        }

        model.updateState({
            pendingRemote: null,
            pendingSave: null,
            content: incomingContent,
            lastSavedContent: incomingContent,
            version: incomingVersion,
            updatedAt: incomingUpdatedAt,
            updatedBy: incomingUpdatedBy,
            lastSyncSignature: {
                version: incomingVersion,
                updatedAt: incomingUpdatedAt,
                updatedBy: incomingUpdatedBy
            }
        });

        if (data.isCurrent && this.isEnabled()) {
            if (!this.getNoteTab(sessionId)) {
                this.ensureTab(sessionId);
            }
            this.refreshUI(sessionId, { overrideEditor: true });
            this.updateStatus(sessionId, undefined, 'success', { delay: 2000 });
        }
    }

    onPreferencesChanged(newPrefs, prevPrefs) {
        const prevShow = prevPrefs && Object.prototype.hasOwnProperty.call(prevPrefs, 'showSessionTab')
            ? prevPrefs.showSessionTab !== false
            : true;
        const nextShow = Object.prototype.hasOwnProperty.call(newPrefs, 'showSessionTab')
            ? newPrefs.showSessionTab !== false
            : true;

        if (!nextShow && prevShow) {
            this.removeNoteTabsGlobally();
        } else if (nextShow && !prevShow) {
            this.restoreNoteTabs();
        }
    }

    removeNoteTabsGlobally() {
        this.tabManager.sessionTabs.forEach((_, sessionId) => {
            this.removeTab(sessionId);
        });
        if (this.tabManager.currentSessionId) {
            this.tabManager.hideAllTabs();
            this.tabManager.showTabsForSession(this.tabManager.currentSessionId);
            this.tabManager.updateActiveTabDisplay();
        }
    }

    restoreNoteTabs() {
        if (this.tabManager.currentSessionId && this.isEnabled()) {
            this.ensureTab(this.tabManager.currentSessionId);
            this.tabManager.hideAllTabs();
            this.tabManager.showTabsForSession(this.tabManager.currentSessionId);
            this.tabManager.updateActiveTabDisplay();
            this.refreshUI(this.tabManager.currentSessionId, { overrideEditor: true });
            this.updateStatus(this.tabManager.currentSessionId);
        }
    }

    handleSessionTerminated(sessionId) {
        this.clearNoteSaveTimer(sessionId);
        const model = this.noteModels.get(sessionId);
        if (model) {
            model.cancelScheduledSave();
            model.updateState({ isTerminated: true });
        }

        // Keep the note tab available but refresh access and status in read-only mode
        try {
            this.applyEditorAccess(sessionId);
            this.updateStatus(sessionId, undefined, 'idle');
            const tab = this.getNoteTab(sessionId);
            this.clearTextareaSelection(tab?.textarea);
            this.updateSendSelectionButtonState(sessionId);
        } catch (_) {}
    }

    handleClearSession() {
        this.noteModels.forEach((model, sessionId) => {
            this.clearNoteSaveTimer(sessionId);
            model.destroy();
        });
        this.noteModels.clear();
    }

    getSessionDataForNotes(sessionId) {
        try {
            const app = this.getContext?.()?.app;
            const terminalManager = app?.modules?.terminal;
            const fromList = terminalManager?.sessionList?.getSessionData?.(sessionId);
            if (fromList) {
                return fromList;
            }
            try {
                const historySession = terminalManager?.sessions?.get?.(sessionId);
                if (historySession?.sessionData) {
                    return historySession.sessionData;
                }
            } catch (_) {}
            return null;
        } catch (_) {
            return null;
        }
    }

    canEditSessionNotes(sessionId) {
        const sessionData = this.getSessionDataForNotes(sessionId);
        if (!sessionData) return false;
        try {
            const app = this.getContext?.()?.app;
            const terminalManager = app?.modules?.terminal;
            // Delegate to the same permission logic used for terminal interaction.
            // This already honors server-provided can_interact when present and
            // falls back to visibility/ownership rules.
            return this.hasInteractionPermission(sessionData, terminalManager);
        } catch (_) {
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
