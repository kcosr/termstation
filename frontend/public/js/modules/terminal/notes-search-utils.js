// Shared utilities for notes controllers: search, selection, and highlights

export function computeMatches(text, query) {
  const out = [];
  const q = String(query || '');
  const t = String(text || '');
  if (!q) return out;
  let i = 0;
  while (i <= t.length - q.length) {
    const j = t.indexOf(q, i);
    if (j === -1) break;
    out.push([j, j + q.length]);
    i = j + q.length; // non-overlapping, case-sensitive
  }
  return out;
}

export function selectRange(textarea, start, end, focus = false) {
  if (!textarea) return;
  try {
    if (focus) {
      try { textarea.focus({ preventScroll: false }); } catch (_) { try { textarea.focus(); } catch (_) {} }
    }
    textarea.setSelectionRange(start, end, 'none');
  } catch (_) {}
}

export function clearTextareaSelection(textarea) {
  if (!textarea) return;
  try {
    textarea.setSelectionRange(textarea.selectionStart, textarea.selectionStart);
  } catch (_) {}
}

export function getSelectedText(textarea) {
  try {
    const start = textarea?.selectionStart ?? 0;
    const end = textarea?.selectionEnd ?? 0;
    if (typeof start !== 'number' || typeof end !== 'number' || start === end) return '';
    return String(textarea?.value || '').slice(Math.min(start, end), Math.max(start, end));
  } catch (_) {
    return '';
  }
}

export function renderHighlights({ text, matches, currentIndex, highlightsContentEl, textarea, editorStack, searchPanelVisible }) {
  if (!highlightsContentEl) return;
  const t = String(text || '');
  const m = Array.isArray(matches) ? matches : [];
  const cur = Number.isInteger(currentIndex) ? currentIndex : -1;
  const escape = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '';
  let last = 0;
  for (let i = 0; i < m.length; i++) {
    const [a, b] = m[i];
    if (a > last) html += escape(t.slice(last, a));
    const cls = (i === cur) ? 'note-hl note-hl--current' : 'note-hl';
    html += `<mark class="${cls}" data-idx="${i}">${escape(t.slice(a, b))}</mark>`;
    last = b;
  }
  if (last < t.length) html += escape(t.slice(last));
  highlightsContentEl.innerHTML = html;

  // Sync scroll position
  try {
    if (textarea) {
      highlightsContentEl.style.transform = `translateY(-${textarea.scrollTop}px)`;
    }
  } catch (_) {}

  // Toggle highlight rendering mode based on panel visibility
  try {
    if (editorStack) {
      editorStack.classList.toggle('note-editor--with-highlights', !!searchPanelVisible);
    }
  } catch (_) {}
}

export function scrollCurrentMatchIntoView({ highlightsContentEl, textarea, currentIndex }) {
  if (!highlightsContentEl || !textarea) return;
  const container = highlightsContentEl;
  let target = container.querySelector(`mark.note-hl[data-idx="${currentIndex}"]`);
  if (!target) target = container.querySelector('mark.note-hl--current');
  if (!target) return;
  const top = target.offsetTop || 0;
  const pad = 24;
  const viewH = textarea.clientHeight || 0;
  const maxScroll = Math.max(0, (container.scrollHeight || 0) - viewH);
  const desired = Math.max(0, Math.min(maxScroll, top - pad));
  try {
    textarea.scrollTop = desired;
    if (highlightsContentEl) {
      highlightsContentEl.style.transform = `translateY(-${textarea.scrollTop}px)`;
    }
  } catch (_) {}
}

export function formatSearchCount(currentIndex, total) {
  const totalCount = Number.isInteger(total) ? total : 0;
  const idx = Number.isInteger(currentIndex) && currentIndex >= 0 ? (currentIndex + 1) : 0;
  return totalCount > 0 ? `${idx} / ${totalCount}` : '0 / 0';
}

