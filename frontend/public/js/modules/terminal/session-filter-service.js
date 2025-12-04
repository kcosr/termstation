/**
 * Session Filter Service
 * Centralized filtering logic for session lists
 */
export class SessionFilterService {
    static _badgeOrName(session) {
        try {
            // Treat local-only sessions as a distinct "Local" template for filtering purposes
            if (session && session.local_only === true) {
                return 'Local';
            }
            const lbl = (session && typeof session.template_badge_label === 'string' && session.template_badge_label.trim())
                ? session.template_badge_label.trim()
                : null;
            if (lbl) return lbl;
            const name = (session && typeof session.template_name === 'string') ? session.template_name : '';
            return name || '';
        } catch (_) { return ''; }
    }
    /**
     * Filter sessions based on provided criteria
     * @param {Map|Array} sessions - Session data (Map or Array)
     * @param {Object} filters - Filter criteria
     * @returns {Array} Filtered sessions
     */
    static filter(sessions, filters = {}) {
        const {
            status = 'all',        // 'all', 'active', 'inactive'
            search = '',           // Search query
            template = 'all',      // Template filter
            pinned = false,        // Show only pinned
            workspace = null       // Workspace name filter
        } = filters;

        // Convert Map to Array if necessary
        let sessionArray;
        if (sessions instanceof Map) {
            sessionArray = Array.from(sessions.values());
        } else if (Array.isArray(sessions)) {
            sessionArray = sessions;
        } else {
            console.warn('[SessionFilterService] Invalid sessions input:', sessions);
            return [];
        }

        return sessionArray
            .filter(session => !session?.parent_session_id)
            .filter(session => {
            return this.matchesStatusFilter(session, status) &&
                   this.matchesSearchFilter(session, search) &&
                   this.matchesTemplateFilter(session, template) &&
                   this.matchesPinnedFilter(session, pinned, filters.pinnedSessions) &&
                   this.matchesWorkspaceFilter(session, workspace);
        });
    }

    /**
     * Check if session matches status filter
     * @param {Object} session - Session data
     * @param {string} status - Status filter
     * @returns {boolean}
     */
    static matchesStatusFilter(session, status) {
        const hasActiveChildren = session?.has_active_children === true;
        const isActive = session?.is_active === true || hasActiveChildren;
        switch (status) {
            case 'active':
                return isActive;
            case 'inactive':
                return session.is_active === false && !hasActiveChildren;
            case 'all':
            default:
                return true;
        }
    }

    /**
     * Check if session matches search filter
     * @param {Object} session - Session data
     * @param {string} search - Search query
     * @returns {boolean}
     */
    static matchesSearchFilter(session, search) {
        if (!search || search.trim() === '') {
            return true;
        }

        const searchTerm = search.toLowerCase().trim();
        const searchableFields = [
            session.session_id,
            session.command,
            session.working_directory,
            session.title,
            session.template_name
        ];

        return searchableFields.some(field => {
            if (field && typeof field === 'string') {
                return field.toLowerCase().includes(searchTerm);
            }
            return false;
        });
    }

    /**
     * Check if session matches template filter
     * @param {Object} session - Session data
     * @param {string|Array|Set} template - Template filter (string, array of strings, or Set)
     * @returns {boolean}
     */
    static matchesTemplateFilter(session, template) {
        if (template === 'all' || !template) {
            return true;
        }

        // Handle multiple templates (OR logic)
        if (Array.isArray(template) || template instanceof Set) {
            const templateArray = Array.isArray(template) ? template : Array.from(template);
            if (templateArray.length === 0) {
                return true;
            }
            // Special case: sessions without a template
            if ((!session.template_name || !String(session.template_name).trim()) && templateArray.includes('_no_template_')) {
                return true;
            }
            const label = this._badgeOrName(session);
            // Check if session's label matches any of the selected template labels
            return label ? templateArray.includes(label) : false;
        }

        // Handle single template (backward compatibility)
        if ((!session.template_name || !String(session.template_name).trim()) && template === '_no_template_') return true;
        const label = this._badgeOrName(session);
        return label === template;
    }

    /**
     * Check if session matches pinned filter
     * @param {Object} session - Session data
     * @param {boolean} pinned - Show only pinned sessions
     * @param {Set} pinnedSessions - Set of pinned session IDs
     * @returns {boolean}
     */
    static matchesPinnedFilter(session, pinned, pinnedSessions) {
        if (!pinned) {
            return true;
        }

        return pinnedSessions && pinnedSessions.has(session.session_id);
    }

    /**
     * Check if session matches workspace filter
     * @param {Object} session
     * @param {string|null} workspace
     * @returns {boolean}
     */
    static matchesWorkspaceFilter(session, workspace) {
        if (!workspace || workspace === 'all') return true;
        const ws = session.workspace || 'Default';
        return ws === workspace;
    }

    /**
     * Sort sessions with pinned sessions first
     * @param {Array} sessions - Session array
     * @param {Set} pinnedSessions - Set of pinned session IDs
     * @param {string} sortBy - Sort criteria ('created', 'title', 'status')
     * @param {string} sortOrder - 'asc' or 'desc'
     * @returns {Array} Sorted sessions
     */
    static sort(sessions, pinnedSessions = new Set(), sortBy = 'created', sortOrder = 'desc') {
        return sessions.sort((a, b) => {
            // Pinned sessions always come first
            const aPinned = pinnedSessions.has(a.session_id);
            const bPinned = pinnedSessions.has(b.session_id);
            
            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return 1;

            // Within pinned/unpinned groups, sort by criteria
            let comparison = 0;
            
            // Prefer workspace_order if both sessions have it and are in same workspace
            if ((a.workspace || 'Default') === (b.workspace || 'Default')) {
                const ao = typeof a.workspace_order === 'number' ? a.workspace_order : null;
                const bo = typeof b.workspace_order === 'number' ? b.workspace_order : null;
                if (ao !== null && bo !== null && ao !== bo) {
                    return ao - bo; // ascending order index
                }
            }

            switch (sortBy) {
                case 'created':
                    comparison = (a.created_at || 0) - (b.created_at || 0);
                    break;
                case 'title':
                    const aTitle = (a.title || a.session_id || '').toLowerCase();
                    const bTitle = (b.title || b.session_id || '').toLowerCase();
                    comparison = aTitle.localeCompare(bTitle);
                    break;
                case 'status':
                    // Active sessions first, then by created date
                    if (a.is_active !== b.is_active) {
                        comparison = (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0);
                    } else {
                        comparison = (a.created_at || 0) - (b.created_at || 0);
                    }
                    break;
                default:
                    comparison = (a.created_at || 0) - (b.created_at || 0);
            }

            return sortOrder === 'desc' ? -comparison : comparison;
        });
    }

    /**
     * Get available template options from sessions
     * @param {Map|Array} sessions - Session data
     * @returns {Array} Array of unique template names
     */
    static getAvailableTemplates(sessions) {
        let sessionArray;
        if (sessions instanceof Map) {
            sessionArray = Array.from(sessions.values());
        } else if (Array.isArray(sessions)) {
            sessionArray = sessions;
        } else {
            return [];
        }

        const templates = new Set();
        sessionArray.forEach(session => {
            if (session.template_name && session.template_name.trim()) {
                templates.add(session.template_name);
            }
        });

        return Array.from(templates).sort();
    }

    /**
     * Get session statistics for display
     * @param {Map|Array} sessions - Session data
     * @returns {Object} Statistics object
     */
    static getStatistics(sessions) {
        let sessionArray;
        if (sessions instanceof Map) {
            sessionArray = Array.from(sessions.values());
        } else if (Array.isArray(sessions)) {
            sessionArray = sessions;
        } else {
            return { total: 0, active: 0, inactive: 0 };
        }

        const stats = {
            total: sessionArray.length,
            active: 0,
            inactive: 0
        };

        sessionArray.forEach(session => {
            if (session.is_active) {
                stats.active++;
            } else {
                stats.inactive++;
            }
        });

        return stats;
    }

    /**
     * Normalize workspace filter value; treat blank/all as null
     * @param {string|null|undefined} workspace
     * @returns {string|null}
     */
    static normalizeWorkspaceFilter(workspace) {
        if (typeof workspace !== 'string') {
            return null;
        }
        const trimmed = workspace.trim();
        if (!trimmed || trimmed.toLowerCase() === 'all') {
            return null;
        }
        return trimmed;
    }

    /**
     * Collect sticky sessions that satisfy current filters
     * @param {Object} params
     * @param {Set} params.stickySet
     * @param {Map} params.sessionsMap
     * @param {Object} params.filters
     * @param {Function} params.getSessionData
     * @returns {Array<Object>}
     */
    static collectStickySessions({ stickySet, sessionsMap, filters = {}, getSessionData } = {}) {
        if (!(stickySet instanceof Set) || stickySet.size === 0) {
            return [];
        }

        const map = sessionsMap instanceof Map ? sessionsMap : new Map();
        const workspaceFilter = this.normalizeWorkspaceFilter(filters.workspace);
        const results = [];

        stickySet.forEach(rawId => {
            const sessionId = String(rawId);
            let session = map.get(sessionId);
            if (!session && map.has(rawId)) {
                session = map.get(rawId);
            }
            if (!session && typeof getSessionData === 'function') {
                try {
                    session = getSessionData(sessionId) || null;
                } catch (_) {
                    session = null;
                }
            }
            if (!session) {
                return;
            }
            if (workspaceFilter && !this.matchesWorkspaceFilter(session, workspaceFilter)) {
                return;
            }
            results.push(session);
        });

        return results;
    }
}
