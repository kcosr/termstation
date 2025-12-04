/**
 * Shared Note Editor UI builder used by session and workspace notes.
 * Returns DOM elements and references; controllers wire behaviors.
 */
import { iconUtils } from '../../utils/icon-utils.js';

export function createNoteEditor({
  contentArea,
  tabId = 'note',
  sessionId = null,
  viewClass = 'note-view',
  title = 'Notes',
  includeSendButton = true
} = {}) {
  if (!contentArea) return null;

  const contentView = document.createElement('div');
  contentView.className = `terminal-content-view ${viewClass}`;
  contentView.dataset.tabId = tabId;
  if (sessionId) contentView.dataset.sessionId = sessionId;

  const toolbar = document.createElement('div');
  toolbar.className = 'note-toolbar';

  const toggleGroup = document.createElement('div');
  toggleGroup.className = 'note-toolbar-group';

  const viewModes = [
    { id: 'plain', label: 'Plain' },
    { id: 'split', label: 'Split' },
    { id: 'markdown', label: 'Markdown' }
  ];
  const viewButtons = [];
  viewModes.forEach((mode) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note-toolbar-button';
    button.dataset.viewMode = mode.id;
    button.textContent = mode.label;
    viewButtons.push({ element: button, mode: mode.id });
    toggleGroup.appendChild(button);
  });

  const splitToggleButton = document.createElement('button');
  splitToggleButton.type = 'button';
  splitToggleButton.className = 'note-toolbar-button note-split-toggle';
  splitToggleButton.setAttribute('aria-label', 'Switch split orientation');
  splitToggleButton.title = 'Switch split orientation';
  try {
    const icon = iconUtils.createIcon('layout-split', {
      size: 16,
      className: 'note-split-toggle-icon'
    });
    splitToggleButton.appendChild(icon);
  } catch (_) {}

  const actionsGroup = document.createElement('div');
  actionsGroup.className = 'note-toolbar-actions';
  actionsGroup.appendChild(splitToggleButton);

  // Search/Replace button (icon-only)
  const searchToggleButton = document.createElement('button');
  searchToggleButton.type = 'button';
  searchToggleButton.className = 'note-toolbar-button note-split-toggle note-search-toggle';
  searchToggleButton.setAttribute('aria-label', 'Open search and replace');
  searchToggleButton.title = 'Search and replace (Meta/Alt+F)';
  try {
    const icon = iconUtils.createIcon('search', {
      size: 16,
      className: 'note-search-toggle-icon'
    });
    searchToggleButton.appendChild(icon);
  } catch (_) {}
  actionsGroup.appendChild(searchToggleButton);

  let sendSelectionButton = null;
  if (includeSendButton) {
    sendSelectionButton = document.createElement('button');
    sendSelectionButton.type = 'button';
    sendSelectionButton.className = 'note-send-selection';
    sendSelectionButton.textContent = 'Send';
    sendSelectionButton.setAttribute('aria-label', 'Send the selected note text to the terminal');
    sendSelectionButton.title = 'Send selection to terminal';
    sendSelectionButton.disabled = true;
    sendSelectionButton.setAttribute('aria-disabled', 'true');
    actionsGroup.appendChild(sendSelectionButton);
  }

  const leftContainer = document.createElement('div');
  leftContainer.className = 'note-toolbar-left';
  leftContainer.appendChild(toggleGroup);
  leftContainer.appendChild(actionsGroup);

  const statusGroup = document.createElement('div');
  statusGroup.className = 'note-toolbar-status';

  const statusEl = document.createElement('div');
  statusEl.className = 'note-status note-status--idle';
  statusEl.setAttribute('role', 'status');

  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.className = 'note-load-remote';
  loadBtn.textContent = 'Load latest changes';
  loadBtn.hidden = true;

  statusGroup.appendChild(statusEl);
  statusGroup.appendChild(loadBtn);

  toolbar.appendChild(leftContainer);
  toolbar.appendChild(statusGroup);

  // Inline search/replace panel (hidden by default)
  const searchPanel = document.createElement('div');
  searchPanel.className = 'note-search-panel';
  searchPanel.hidden = true;

  const searchHeader = document.createElement('div');
  searchHeader.className = 'note-search-header';
  const searchTitle = document.createElement('div');
  searchTitle.textContent = 'Search';
  const searchCloseBtn = document.createElement('button');
  searchCloseBtn.type = 'button';
  searchCloseBtn.className = 'note-search-close';
  searchCloseBtn.setAttribute('aria-label', 'Close search');
  try {
    const icon = iconUtils.createIcon('x', { size: 14 });
    searchCloseBtn.appendChild(icon);
  } catch (_) { searchCloseBtn.textContent = '×'; }
  searchHeader.appendChild(searchTitle);
  searchHeader.appendChild(searchCloseBtn);

  const row1 = document.createElement('div');
  row1.className = 'note-search-row';
  const searchFindInput = document.createElement('input');
  searchFindInput.type = 'text';
  searchFindInput.placeholder = 'Find';
  searchFindInput.className = 'note-search-input';
  const searchPrevBtn = document.createElement('button');
  searchPrevBtn.type = 'button';
  searchPrevBtn.className = 'note-search-nav';
  searchPrevBtn.textContent = 'Prev';
  const searchNextBtn = document.createElement('button');
  searchNextBtn.type = 'button';
  searchNextBtn.className = 'note-search-nav';
  searchNextBtn.textContent = 'Next';
  const searchCountEl = document.createElement('span');
  searchCountEl.className = 'note-search-count';
  row1.appendChild(searchFindInput);
  row1.appendChild(searchPrevBtn);
  row1.appendChild(searchNextBtn);
  row1.appendChild(searchCountEl);

  const row2 = document.createElement('div');
  row2.className = 'note-search-row';
  const searchReplaceInput = document.createElement('input');
  searchReplaceInput.type = 'text';
  searchReplaceInput.placeholder = 'Replace with';
  searchReplaceInput.className = 'note-search-input';
  const searchReplaceBtn = document.createElement('button');
  searchReplaceBtn.type = 'button';
  searchReplaceBtn.className = 'note-search-action';
  searchReplaceBtn.textContent = 'Replace';
  const searchReplaceAllBtn = document.createElement('button');
  searchReplaceAllBtn.type = 'button';
  searchReplaceAllBtn.className = 'note-search-action';
  searchReplaceAllBtn.textContent = 'Replace all';
  row2.appendChild(searchReplaceInput);
  row2.appendChild(searchReplaceBtn);
  row2.appendChild(searchReplaceAllBtn);

  searchPanel.appendChild(searchHeader);
  searchPanel.appendChild(row1);
  searchPanel.appendChild(row2);

  const editorContainer = document.createElement('div');
  editorContainer.className = 'note-editor-container';

  // Stack for highlights + textarea to enable match highlighting
  const editorStack = document.createElement('div');
  editorStack.className = 'note-editor-stack';

  const highlights = document.createElement('div');
  highlights.className = 'note-highlights';
  const highlightsContent = document.createElement('div');
  highlightsContent.className = 'note-highlights-content';
  highlights.appendChild(highlightsContent);

  const textarea = document.createElement('textarea');
  textarea.className = 'note-editor';
  textarea.spellcheck = true;

  editorStack.appendChild(highlights);
  editorStack.appendChild(textarea);

  const preview = document.createElement('div');
  preview.className = 'note-preview';
  preview.setAttribute('aria-live', 'polite');

  editorContainer.appendChild(editorStack);
  editorContainer.appendChild(preview);

  contentView.appendChild(toolbar);
  contentView.appendChild(searchPanel);
  contentView.appendChild(editorContainer);

  contentArea.appendChild(contentView);

  return {
    element: contentView,
    textarea,
    previewEl: preview,
    statusEl,
    loadButton: loadBtn,
    sendSelectionButton,
    viewButtons: viewButtons.map(v => v.element),
    splitToggleButton,
    editorStack,
    highlightsEl: highlights,
    highlightsContentEl: highlightsContent,
    searchToggleButton,
    // search panel refs
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
}

/**
 * Apply view mode classes and toolbar button highlighting on a note editor container.
 */
export function applyNoteViewMode({ container, mode = 'plain', splitOrientation = 'horizontal' }) {
  if (!container) return;
  const normalized = (mode === 'split' || mode === 'markdown') ? mode : 'plain';
  const orient = (splitOrientation === 'vertical') ? 'vertical' : 'horizontal';

  container.classList.remove('note-view--mode-plain', 'note-view--mode-split', 'note-view--mode-markdown');
  container.classList.add(`note-view--mode-${normalized}`);
  // Apply split orientation classes on the container to match CSS expectations
  container.classList.remove('note-view--split-horizontal', 'note-view--split-vertical');
  if (normalized === 'split') {
    container.classList.add(orient === 'vertical' ? 'note-view--split-vertical' : 'note-view--split-horizontal');
  }
  const textarea = container.querySelector('textarea.note-editor');
  const editorStackEl = container.querySelector('.note-editor-stack');
  const preview = container.querySelector('.note-preview');
  if (normalized === 'plain') {
    if (editorStackEl) editorStackEl.style.display = '';
    if (textarea) textarea.style.display = '';
    if (preview) preview.style.display = 'none';
  } else if (normalized === 'split') {
    if (editorStackEl) editorStackEl.style.display = '';
    if (textarea) textarea.style.display = '';
    if (preview) preview.style.display = '';
  } else { // markdown
    if (editorStackEl) editorStackEl.style.display = 'none';
    if (textarea) textarea.style.display = 'none';
    if (preview) preview.style.display = '';
  }
  // Update active state on view buttons
  const buttons = container.querySelectorAll('.note-toolbar-button[data-view-mode]');
  buttons.forEach((btn) => {
    const targetMode = btn.dataset.viewMode;
    btn.classList.toggle('active', targetMode === normalized);
  });
}
