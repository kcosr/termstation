import * as fs from 'fs';
import * as path from 'path';

function decodeHtmlEntities(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  // Fast replacements for common entities
  let s = input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Numeric entities: decimal and hex
  s = s.replace(/&#(\d+);/g, (_, d) => {
    try {
      const code = parseInt(d, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    } catch (_) { return _; }
  });
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    try {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    } catch (_) { return _; }
  });
  return s;
}

function htmlToText(html) {
  if (typeof html !== 'string') return '';
  // Remove script/style blocks conservatively
  let s = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '');
  // Replace tags with spaces to avoid concatenation of words across tags
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeHtmlEntities(s);
  // Normalize whitespace
  s = s.replace(/[\u00A0\s]+/g, ' ').trim();
  return s;
}

// Returns plain text content to use for history search for a given session object.
// Prefers HTML history file when present, else falls back to .log or in-memory buffer.
export async function getSearchableHistoryText(session) {
  try {
    if (!session) return '';

    // Active session: use in-memory buffer if present
    if (session.is_active && typeof session.outputHistory === 'string') {
      return String(session.outputHistory || '');
    }

    // Determine sessions dir
    const logsDir = session.script_logs_dir;
    if (!logsDir || typeof logsDir !== 'string') {
      // Fallback to in-memory if available
      return typeof session.outputHistory === 'string' ? String(session.outputHistory) : '';
    }

    // Compute candidate HTML path: honor stored filename if safe; otherwise default to <id>.html
    let htmlPath = null;
    try {
      const specified = (typeof session.history_html_file === 'string' && session.history_html_file.trim())
        ? session.history_html_file.trim()
        : null;
      let base = specified || `${session.session_id}.html`;
      // Defensive: reject any path traversal in stored filename; fall back to default name
      if (base.includes('/') || base.includes('\\')) {
        base = `${session.session_id}.html`;
      }
      htmlPath = path.join(logsDir, base);
    } catch (_) { htmlPath = null; }

    // Prefer HTML when available
    if (htmlPath) {
      try {
        const st = await fs.promises.stat(htmlPath).catch(() => null);
        if (st && st.isFile()) {
          const html = await fs.promises.readFile(htmlPath, 'utf8');
          return htmlToText(html);
        }
      } catch (_) { /* ignore and fall back */ }
    }

    // Fallback: read raw log file if present
    try {
      if (session.script_log_file) {
        const logPath = path.join(logsDir, session.script_log_file);
        const txt = await fs.promises.readFile(logPath, 'utf8');
        return String(txt || '');
      }
    } catch (_) { /* ignore */ }

    // Final fallback: in-memory buffer
    return typeof session.outputHistory === 'string' ? String(session.outputHistory) : '';
  } catch (_) {
    return '';
  }
}

export const __test__ = { decodeHtmlEntities, htmlToText };
