/**
 * SessionToolbarController
 * - Manages title/session ID display areas
 * - Wires toolbar controls (clear, detach, close, delete, text input)
 * - Exposes update method for session info
 */

import { apiService } from '../../services/api.service.js';
import { iconUtils } from '../../utils/icon-utils.js';

export class SessionToolbarController {
  constructor(elements, manager) {
    this.elements = elements;
    this.manager = manager;
    this._unsubs = [];
    this._terminateLabel = null;
  }

  init() {
    const {
      clearBtn,
      detachBtn,
      closeBtn,
      textInputBtn,
    } = this.elements || {};

    if (clearBtn) {
      const handler = async () => {
        const mgr = this.manager;
        const targetId = (typeof mgr.getActiveEffectiveSessionId === 'function')
          ? mgr.getActiveEffectiveSessionId()
          : mgr.currentSessionId;
        if (!targetId) return;

        const sessionData = (typeof mgr.getAnySessionData === 'function')
          ? mgr.getAnySessionData(targetId)
          : mgr.sessionList.getSessionData(targetId);
        if (!sessionData || !sessionData.is_active) {
          console.warn('Cannot clear terminal - session is not active');
          return;
        }

        const isInteractive = mgr.isSessionInteractive(sessionData);
        if (!isInteractive) {
          console.warn('Cannot clear terminal - session is not interactive');
          return;
        }

        // Clear the correct terminal instance
        const targetSession = mgr.sessions?.get?.(targetId) || null;
        if (targetSession) {
          targetSession.clear?.();
        }

        try {
          await apiService.clearSessionHistory(targetId);
        } catch (error) {
          console.warn('Failed to clear server-side history:', error);
        }
      };
      clearBtn.addEventListener('click', handler);
      this._unsubs.push(() => clearBtn.removeEventListener('click', handler));
    }

    if (detachBtn) {
      const handler = () => {
        if (detachBtn.disabled) return;
        const mgr = this.manager;
        const sessionId = (typeof mgr.getActiveEffectiveSessionId === 'function')
          ? mgr.getActiveEffectiveSessionId()
          : mgr.currentSessionId;
        if (!sessionId) return;
        const currentSession = mgr.sessions?.get?.(sessionId) || mgr.currentSession;
        const isCurrentSessionAttached =
          currentSession && currentSession.sessionId === sessionId && currentSession.isAttached;
        const isInAttachedSet = mgr.attachedSessions && mgr.attachedSessions.has(sessionId);
        const isAttached = isCurrentSessionAttached || isInAttachedSet;

        if (isAttached) {
          mgr.detachSession(sessionId);
        } else {
          // If a container child tab is active, attach that child; otherwise attach parent
          if (mgr.activeChildSessionId && sessionId === mgr.activeChildSessionId && typeof mgr.attachChildSession === 'function') {
            mgr.attachChildSession(sessionId, { markActive: true, focus: true });
          } else {
            mgr.attachToCurrentSession();
          }
        }
      };
      detachBtn.addEventListener('click', handler);
      this._unsubs.push(() => detachBtn.removeEventListener('click', handler));
    }

    if (closeBtn) {
      const handler = () => {
        const mgr = this.manager;
        const targetId = (typeof mgr.getActiveEffectiveSessionId === 'function')
          ? mgr.getActiveEffectiveSessionId()
          : mgr.currentSessionId;
        if (!targetId) return;
        const sessionData = (typeof mgr.getAnySessionData === 'function')
          ? mgr.getAnySessionData(targetId)
          : mgr.sessionList.getSessionData(targetId);
        if (!sessionData) return;
        if (sessionData.is_active) {
          mgr.closeSession(targetId);
        } else {
          mgr.closeEndedSession(targetId);
        }
      };
      closeBtn.addEventListener('click', handler);
      this._unsubs.push(() => closeBtn.removeEventListener('click', handler));
    }

    // Delete button removed from header; use History page or context menu instead.

    // Save History checkbox removed from header; context menu still provides this toggle.

    if (textInputBtn) {
      const handler = () => {
        const mgr = this.manager;
        if (mgr.textInputModal?.isVisible) {
          mgr.hideTextInputModal();
        } else {
          mgr.showTextInputModal();
        }
      };
      textInputBtn.addEventListener('click', handler);
      this._unsubs.push(() => textInputBtn.removeEventListener('click', handler));
    }
  }

  updateSessionInfo(title, sessionId, templateName = null) {
    const sessionData = this.manager?.sessionList?.getSessionData?.(sessionId);
    const isLocalOnly = !!(sessionData && sessionData.local_only === true);

    // Treat placeholder titles ("Session", "No session selected") as empty,
    // but for local-only desktop sessions fall back to the session's display
    // identity (session_id) so the header shows the Local badge + title from
    // the moment the session is created (Issue #9).
    let effectiveTitle = title;
    const hasNonPlaceholderTitle =
      effectiveTitle && effectiveTitle !== 'No session selected' && effectiveTitle !== 'Session';
    if (!hasNonPlaceholderTitle && isLocalOnly && sessionData && sessionData.session_id) {
      effectiveTitle = sessionData.dynamic_title || sessionData.title || sessionData.session_id;
    }
    const hasTitle =
      effectiveTitle && effectiveTitle !== 'No session selected' && effectiveTitle !== 'Session';

    // Update terminal header (for desktop)
    const terminalTitle = this.elements?.terminalTitle;
    const terminalSessionId = this.elements?.terminalSessionId;
    const closeBtn = this.elements?.closeBtn;
    if (closeBtn && this._terminateLabel === null) {
      this._terminateLabel = closeBtn.textContent || 'Terminate';
    }
    const isTerminated = sessionData && sessionData.is_active === false;
    if (closeBtn) {
      closeBtn.textContent = isTerminated ? 'Close' : (this._terminateLabel || 'Terminate');
      closeBtn.title = isTerminated ? 'Close session' : 'Terminate session';
    }
    if (terminalTitle && terminalSessionId) {
      if (hasTitle || templateName !== null) {
        // Always show a badge: template badge if available, otherwise Command pseudo-badge
        let badgeHtml = '';
        if (templateName) {
          badgeHtml = this.manager.createTemplateBadgeHtml
            ? this.manager.createTemplateBadgeHtml(templateName)
            : `<span class=\"template-badge\">${templateName}</span>`;
        } else {
          // For local-only sessions, use a white "Local" badge instead of "Command"
          if (isLocalOnly && this.manager.createCommandBadgeHtml) {
            badgeHtml = this.manager.createCommandBadgeHtml('Local');
          } else {
            badgeHtml = this.manager.createCommandBadgeHtml
              ? this.manager.createCommandBadgeHtml()
              : `<span class=\"template-badge\">Command</span>`;
          }
        }
        // Do not add an additional colored LOCAL badge; the white badge will say "Local"
        // Remove legacy visibility badge; compact icon is appended below
        // Use workspace list styles for consistent alignment + truncation
        try { terminalTitle.classList.add('workspace-session-content'); } catch (_) {}
        const safeTitle = String(effectiveTitle || '');
        const statusBadgeHtml = isTerminated
          ? '<span class="session-status-indicator session-status-indicator--ended" title="Session ended">ENDED</span>'
          : '';
        // Insert a slot for a compact visibility icon (spacing handled by CSS gap)
        terminalTitle.innerHTML = `${badgeHtml} <span class=\"visibility-icon-slot\"></span> <span class=\"workspace-session-title\">${safeTitle}${statusBadgeHtml}</span>`;

        // Append compact visibility icon based on current viewer vs owner
        try {
          const sd = this.manager.sessionList?.getSessionData(this.manager.currentSessionId);
          const slot = terminalTitle.querySelector('.visibility-icon-slot');
          if (sd && slot) {
            // Do not show visibility icons for local-only sessions
            if (sd.local_only === true) {
              try { if (slot) slot.remove(); } catch (_) {}
              return;
            }
            const visibility = sd.visibility || 'private';
            const owner = String(sd.created_by || '');
            const currentUser = (this.manager && typeof this.manager.getCurrentUsername === 'function')
              ? String(this.manager.getCurrentUsername() || '')
              : String((this.manager?.store?.getState()?.preferences?.auth?.username) || '');
            const isOwner = !!currentUser && currentUser === owner;
            if (visibility === 'shared_readonly') {
              if (isOwner) {
                const el = iconUtils.createIcon('people', { size: 14, className: 'visibility-icon', title: 'Shared (read-only)' });
                slot.appendChild(el);
              } else {
                const el = iconUtils.createIcon('person-slash', { size: 14, className: 'visibility-icon', title: `Read-only (${owner})` });
                slot.appendChild(el);
              }
            } else if (visibility === 'public') {
              const el = iconUtils.createIcon('globe', { size: 14, className: 'visibility-icon', title: isOwner ? 'Public (full access)' : `Public (${owner})` });
              slot.appendChild(el);
            } else if (visibility === 'private' && !isOwner) {
              const el = iconUtils.createIcon('lock', { size: 14, className: 'visibility-icon', title: `Private (${owner})` });
              slot.appendChild(el);
            }
            // If no icon was appended (e.g., private), remove slot to avoid extra spacing
            try { if (slot && slot.childNodes.length === 0) slot.remove(); } catch (_) {}
          }
        } catch (_) {}

        // No header-level other-clients indicator (moved to session tabs)

        // Do not show session ID in header when badge/title are present
        terminalSessionId.textContent = '';
        terminalTitle.style.display = '';
        terminalSessionId.style.display = 'none';
      } else if (sessionId) {
        // No custom title but have session - only show session ID
        try { terminalTitle.classList.remove('workspace-session-content'); } catch (_) {}
        terminalTitle.style.display = 'none';
        terminalSessionId.textContent = isTerminated ? `${sessionId} (Ended)` : sessionId;
        terminalSessionId.style.display = '';
      } else {
        // No session selected - leave title blank (no placeholder text)
        try { terminalTitle.classList.remove('workspace-session-content'); } catch (_) {}
        terminalTitle.textContent = '';
        terminalSessionId.textContent = '';
        terminalTitle.style.display = '';
        terminalSessionId.style.display = 'none';
      }
    }

    // Update session info toolbar (deprecated when WorkspaceScroller is active)
    // If workspace scroller is active, do not manipulate the toolbar visibility or content
    const hasWorkspaceScroller = !!document.getElementById('workspace-scroller');
    if (!hasWorkspaceScroller) {
      const sessionInfoToolbar = this.elements?.sessionInfoToolbar;
      const sessionTitleLine = this.elements?.sessionTitleLine;
      const sessionIdLine = this.elements?.sessionIdLine;
      if (sessionInfoToolbar && sessionTitleLine && sessionIdLine) {
        if (hasTitle) {
          sessionTitleLine.textContent = effectiveTitle;
          sessionIdLine.textContent = '';
          sessionInfoToolbar.classList.remove('hidden');
        } else {
          sessionTitleLine.textContent = '';
          sessionIdLine.textContent = '';
          sessionInfoToolbar.classList.add('hidden');
        }
      }
    }
  }

  destroy() {
    try {
      this._unsubs.forEach((fn) => fn());
    } finally {
      this._unsubs = [];
    }
  }
}
