/**
 * Markdown helpers for collaborative session notes.
 */

/**
 * Escape HTML entities to prevent injection when rendering user content.
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

/**
 * Sanitize external URLs used inside rendered markdown links.
 * @param {string} url
 * @returns {string}
 */
export function sanitizeUrl(url) {
    if (typeof url !== 'string') return '#';
    const trimmed = url.trim();
    if (!trimmed) return '#';
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
        return '#';
    }
    try {
        return encodeURI(trimmed);
    } catch (_) {
        return '#';
    }
}

function applyInlineMarkdown(text) {
    if (typeof text !== 'string') return '';
    let safe = escapeHtml(text);
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/__(.+?)__/g, '<strong>$1</strong>');
    safe = safe.replace(/\*(.+?)\*/g, '<em>$1</em>');
    safe = safe.replace(/_(.+?)_/g, '<em>$1</em>');
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
    safe = safe.replace(/\[(.+?)\]\((.+?)\)/g, (_match, label, url) => {
        const href = sanitizeUrl(url);
        const textLabel = label;
        return `<a href="${href}" target="_blank" rel="noopener noreferrer">${textLabel}</a>`;
    });
    return safe;
}

/**
 * Basic markdown renderer used for the session notes preview pane.
 * Supports code fences, headings, unordered lists, emphasis, and links.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return '';
    }

    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inList = false;
    let inCodeBlock = false;
    let codeLang = '';

    const closeList = () => {
        if (inList) {
            html += '</ul>';
            inList = false;
        }
    };

    lines.forEach((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('```')) {
            if (!inCodeBlock) {
                inCodeBlock = true;
                codeLang = trimmed.slice(3).trim();
                const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
                html += `<pre class="note-code"><code${langAttr}>`;
            } else {
                inCodeBlock = false;
                html += '</code></pre>';
            }
            return;
        }

        if (inCodeBlock) {
            html += `${escapeHtml(line)}\n`;
            return;
        }

        if (trimmed === '') {
            closeList();
            html += '<p class="note-paragraph-spacer"></p>';
            return;
        }

        const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            closeList();
            const level = headingMatch[1].length;
            const content = applyInlineMarkdown(headingMatch[2]);
            html += `<h${level} class="note-heading note-heading-${level}">${content}</h${level}>`;
            return;
        }

        if (/^[-*+]\s+/.test(trimmed)) {
            if (!inList) {
                inList = true;
                html += '<ul class="note-list">';
            }
            const itemText = trimmed.replace(/^[-*+]\s+/, '');
            html += `<li>${applyInlineMarkdown(itemText)}</li>`;
            return;
        }

        closeList();
        html += `<p>${applyInlineMarkdown(line)}</p>`;
    });

    if (inList) {
        html += '</ul>';
    }
    if (inCodeBlock) {
        html += '</code></pre>';
    }
    return html;
}
