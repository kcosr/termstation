/**
 * Helpers for session link metadata:
 * - Normalization for API responses (hide internal fields)
 * - Output filename sanitization for HTML artifacts
 */

/**
 * Normalize a raw session link object for clients.
 * Hides internal/private fields such as pre_view_command.
 */
export function normalizeLinkForResponse(link) {
  if (!link || typeof link.url !== 'string') return null;

  const url = link.url;
  const name = (typeof link.name === 'string' && link.name) ? link.name : url;

  const out = {
    url,
    name,
    // Existing flags with stable defaults
    refresh_on_view: link.refresh_on_view === true,
    show_active: link.show_active !== false,
    show_inactive: link.show_inactive !== false,
    // New chat link flags
    show_url_bar: link.show_url_bar !== false,
    pass_theme_colors: link.pass_theme_colors === true,
    refresh_on_view_active: link.refresh_on_view_active === true,
    refresh_on_view_inactive: link.refresh_on_view_inactive === true
  };

  // Stable backend-assigned identifier for template-defined links.
  try {
    if (typeof link.link_id === 'string' && link.link_id.trim()) {
      out.link_id = link.link_id.trim();
    }
  } catch (_) {
    // Best-effort only
  }

  // Optional output filename (already processed/sanitized by the backend)
  try {
    const raw = link.output_filename;
    if (typeof raw === 'string' && raw.trim()) {
      out.output_filename = raw.trim();
    }
  } catch (_) {
    // Best-effort only
  }

  // Surface a non-sensitive template flag when available
  try {
    if (link.template_link === true || link._template_link === true) {
      out.is_template_link = true;
    }
  } catch (_) {
    // ignore
  }

  // Never expose the actual pre_view_command; only expose whether one exists.
  try {
    const hasCmd = !!(link._pre_view_command || link.pre_view_command);
    out.has_pre_view_command = hasCmd;
  } catch (_) {
    out.has_pre_view_command = false;
  }

  return out;
}

/**
 * Sanitize an output filename so it is safe to place under the per-session
 * links directory. Strips path separators and forces a .html extension.
 *
 * Returns a bare filename (no directory components).
 */
export function sanitizeOutputFilename(rawName, fallbackBase) {
  let base = '';
  try {
    if (typeof rawName === 'string' && rawName.trim()) {
      base = rawName.trim();
    } else if (fallbackBase !== undefined && fallbackBase !== null) {
      base = String(fallbackBase);
    }
  } catch (_) {
    base = '';
  }

  if (!base) {
    base = 'index';
  }

  // Strip any path separators and leading dots to avoid traversal and
  // hidden files. Replace separators with underscores so names remain
  // somewhat recognizable.
  try {
    base = base.replace(/[/\\]+/g, '_');
    base = base.replace(/^\.+/, '');
  } catch (_) {
    // ignore; best-effort
  }

  if (!base) {
    base = 'index';
  }

  // Ensure .html extension (case-insensitive).
  if (!/\.html?$/i.test(base)) {
    base += '.html';
  }

  return base;
}
