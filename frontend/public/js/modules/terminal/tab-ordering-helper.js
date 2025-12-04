export function orderUrlTabsWithWorkspaceFirst(urlTabs) {
    if (!Array.isArray(urlTabs) || urlTabs.length <= 1) {
        return Array.isArray(urlTabs) ? [...urlTabs] : [];
    }

    const workspaceTabs = [];
    const rest = [];

    urlTabs.forEach((tab) => {
        const title = String(tab?.title || '').trim();
        // Treat both legacy "Workspace" and new "Files" labels
        // as workspace-style URL tabs and keep them grouped first.
        if (title === 'Workspace' || title === 'Files') {
            workspaceTabs.push(tab);
        } else {
            rest.push(tab);
        }
    });

    return [...workspaceTabs, ...rest];
}

/**
 * Compute the canonical ordering for a set of tabs belonging to a single session.
 * Ordering rules:
 *   - Terminal tab first
 *   - Container "Shell" tabs next, ordered by child session list
 *   - Command tabs next
 *   - Workspace file tab ("Files") after any shell/command tabs
 *   - URL tabs (with workspace-style URL tabs first within the URL group)
 *   - Any remaining/other tabs
 *   - Notes tab last
 *
 * The helper is intentionally pure so tests can exercise ordering behavior
 * without depending on the full TabManager/DOM wiring.
 *
 * @param {Array<object>} tabs - flat list of tab objects (single session)
 * @param {Array<object>} childSessions - ordered list of child session objects
 *   used to order container/shell tabs (each should expose `session_id`).
 * @returns {Array<object>} ordered tabs
 */
export function orderTabsWithWorkspaceAfterShellAndCommand(tabs, childSessions = []) {
    if (!Array.isArray(tabs) || tabs.length === 0) {
        return [];
    }

    const terminalTabs = [];
    const workspaceTabs = [];
    const containerMap = new Map();
    const commandTabs = [];
    const urlTabs = [];
    const noteTabs = [];
    const otherTabs = [];

    tabs.forEach((tab) => {
        if (!tab || !tab.id) return;

        if (tab.id === 'terminal') {
            terminalTabs.push(tab);
            return;
        }

        if (tab.id === 'workspace' || tab.type === 'workspace') {
            workspaceTabs.push(tab);
            return;
        }

        if (tab.type === 'container' && tab.childSessionId) {
            containerMap.set(tab.childSessionId, tab);
            return;
        }

        if (tab.type === 'command') {
            commandTabs.push(tab);
            return;
        }

        if (tab.id === 'note' || tab.type === 'note') {
            noteTabs.push(tab);
            return;
        }

        if (tab.type === 'url') {
            urlTabs.push(tab);
            return;
        }

        otherTabs.push(tab);
    });

    const orderedContainers = Array.isArray(childSessions)
        ? childSessions
            .map((session) => (session && session.session_id ? containerMap.get(session.session_id) : null))
            .filter(Boolean)
        : Array.from(containerMap.values());

    const orderedUrlTabs = orderUrlTabsWithWorkspaceFirst(urlTabs);

    return [
        ...terminalTabs,
        ...orderedContainers,
        ...commandTabs,
        ...workspaceTabs,
        ...orderedUrlTabs,
        ...otherTabs,
        ...noteTabs
    ];
}
