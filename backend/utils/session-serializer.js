import * as fs from 'fs';
import { templateLoader } from '../template-loader.js';
import { resolveSessionWorkspaceHostPath } from '../services/session-workspace-builder.js';
import { normalizeLinkForResponse } from './session-links.js';

export function serializeSessionSummary(session, options = {}) {
  const {
    includeLastActivity = true,
    includeHistoryFlags = false,
    includeLinks = false
  } = options;

  // Resolve badge label: prefer persisted value; fallback to template definition
  let badgeLabel = session.template_badge_label || null;
  try {
    if (!badgeLabel) {
      let tpl = null;
      if (session.template_id) {
        tpl = templateLoader.getTemplate(session.template_id);
      }
      if (!tpl && session.template_name) {
        try {
          const all = templateLoader.getAllTemplates();
          tpl = all.find((t) => t && t.name === session.template_name) || null;
        } catch (_) { /* ignore */ }
      }
      const bl = tpl && typeof tpl.badge_label === 'string' && tpl.badge_label.trim() ? tpl.badge_label.trim() : '';
      if (bl) badgeLabel = bl;
    }
  } catch (_) { /* ignore */ }

  const summary = {
    session_id: session.session_id,
    command: session.command,
    command_preview: session.command_preview,
    working_directory: session.working_directory,
    created_at: session.created_at,
    is_active: session.is_active,
    ended_at: session.ended_at,
    exit_code: session.exit_code,
    created_by: session.created_by,
    visibility: session.visibility,
    title: session.title,
    dynamic_title: session.dynamic_title,
    interactive: session.interactive,
    template_id: session.template_id,
    template_name: session.template_name,
    template_badge_label: badgeLabel,
    template_parameters: session.template_parameters,
    workspace: session.workspace,
    workspace_service_enabled_for_session: session.workspace_service_enabled_for_session === true,
    workspace_service_port: (function normalizePort() {
      const n = Number(session.workspace_service_port);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    })(),
    isolation_mode: session.isolation_mode || 'none',
    is_fork: session.is_fork === true,
    forked_from_session_id: session.forked_from_session_id || null,
    note: typeof session.note === 'string' ? session.note : '',
    note_version: Number.isInteger(session.note_version) ? session.note_version : 0,
    note_updated_at: session.note_updated_at || null,
    note_updated_by: session.note_updated_by || null
  };

  // Include host workspace path and derive workspace_service_available for
  // container/directory isolation modes so history views and sticky terminated
  // sessions can surface availability in the UI.
  let workspaceDirExists = null;
  try {
    const mode = String(session.isolation_mode || 'none').toLowerCase();
    if (mode === 'container' || mode === 'directory') {
      const hostPath = resolveSessionWorkspaceHostPath(session.session_id);
      summary.workspace_host_path = hostPath;
      if (hostPath) {
        workspaceDirExists = fs.existsSync(hostPath);
      }
    }
  } catch (_) {
    workspaceDirExists = null;
  }

  try {
    if (summary.workspace_service_enabled_for_session) {
      // When the workspace directory cannot be checked, treat availability as true.
      summary.workspace_service_available = workspaceDirExists !== false;
    } else {
      summary.workspace_service_available = false;
    }
  } catch (_) {
    summary.workspace_service_available = !!summary.workspace_service_enabled_for_session;
  }

  if (includeLastActivity) {
    summary.last_activity = session.last_activity;
  }
  if (includeHistoryFlags) {
    summary.load_history = session.load_history;
    summary.save_session_history = session.save_session_history;
    // Deprecated: transitions capture no longer used for timeline markers
    summary.capture_activity_transitions = false;
  }
  if (includeLinks) {
    const rawLinks = Array.isArray(session.links) ? session.links : [];
    let filteredLinks = rawLinks;
    try {
      // Preserve legacy behavior: when the workspace directory is missing,
      // filter out any Workspace service links from summaries.
      // Note: The `/service/workspace` path is from the pre-#93 architecture where
      // workspaces were served via a container helper. This filter handles sessions
      // created before the migration to the backend-hosted `/api/sessions/:id/workspace` API.
      if (workspaceDirExists === false && rawLinks.length > 0) {
        const sid = String(session.session_id || '').trim();
        const encodedSid = encodeURIComponent(sid);
        const pathFragment = `/sessions/${encodedSid}/service/workspace`;
        filteredLinks = rawLinks.filter((link) => {
          const url = (link && typeof link.url === 'string') ? link.url : '';
          if (!url) return true;
          return !url.includes(pathFragment);
        });
      }
    } catch (_) {
      filteredLinks = rawLinks;
    }
    // Normalize link metadata for API consumers and hide internal fields.
    try {
      summary.links = Array.isArray(filteredLinks)
        ? filteredLinks.map((l) => normalizeLinkForResponse(l)).filter(Boolean)
        : [];
    } catch (_) {
      summary.links = filteredLinks;
    }
  }

  return summary;
}

export function serializeSessionForSearch(session) {
  return serializeSessionSummary(session, {
    includeLastActivity: true,
    includeHistoryFlags: true,
    includeLinks: false
  });
}

export function serializeSessionForHistoryList(session) {
  return serializeSessionSummary(session, {
    includeLastActivity: true,
    includeHistoryFlags: true,
    includeLinks: true
  });
}

export function serializeSessionForPaginatedHistory(session) {
  return serializeSessionSummary(session, {
    includeLastActivity: false,
    includeHistoryFlags: false,
    includeLinks: false
  });
}
