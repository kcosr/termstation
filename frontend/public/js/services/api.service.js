/**
 * API Service - Centralized REST API abstraction layer
 * Handles all HTTP communication with the backend
 */
import { getApiOrigins } from '../core/config.js';

export class ApiService {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl || window.location.origin;
        this.headers = {
            'Content-Type': 'application/json',
            'X-No-Auth-Prompt': '1'
        };
        this.isAuthenticated = false;
        this._credentialsStrategy = null;
        this._infoRetryConfig = null;
        this._debug = false;
        this._sessionCookie = null; // e.g., "ts_session=..."
        try {
            // Allow opt-in verbose logs via query/localStorage
            const params = new URLSearchParams(window.location.search || '');
            if (params.get('apiDebug') === '1') this._debug = true;
        } catch (_) {}
        try {
            if (window.localStorage?.getItem('tm_api_debug') === '1') this._debug = true;
        } catch (_) {}
        this._socket = { enabled: false, socketPath: '', basePath: '' };
    }

    _detectSocketMode() {
        try {
            const raw = String(this.baseUrl || '').trim();
            if (!raw) { this._socket = { enabled: false, socketPath: '', basePath: '' }; return this._socket; }
            let u;
            try { u = new URL(raw); } catch (_) { u = null; }
            const proto = u ? String(u.protocol || '').toLowerCase() : (raw.startsWith('socket://') ? 'socket:' : (raw.startsWith('unix://') ? 'unix:' : (raw.startsWith('pipe://') ? 'pipe:' : '')));
            const isSock = (proto === 'socket:' || proto === 'unix:' || proto === 'pipe:');
            if (!isSock) { this._socket = { enabled: false, socketPath: '', basePath: '' }; return this._socket; }
            // For socket:///path style, pathname holds the socket path
            let socketPath = '';
            let basePath = '';
            if (u) {
                socketPath = u.pathname || '';
                basePath = u.searchParams?.get('base') || u.pathname?.replace(/\\\\.\\pipe\\[^/]+$/i, '') || '';
                // If basePath equals socket pathname (common), reset basePath to empty; endpoints include full paths
                basePath = basePath && basePath !== socketPath ? basePath : '';
            } else {
                socketPath = raw.replace(/^socket:\/\/|^unix:\/\/|^pipe:\/\//i, '');
            }
            this._socket = { enabled: true, socketPath, basePath };
            return this._socket;
        } catch (_) {
            this._socket = { enabled: false, socketPath: '', basePath: '' };
            return this._socket;
        }
    }

    getCredentialsMode() {
        try {
            if (typeof this._credentialsStrategy === 'function') {
                const result = this._credentialsStrategy({
                    baseUrl: this.baseUrl,
                    locationOrigin: window.location.origin
                });
                if (result === 'same-origin' || result === 'include') {
                    return result;
                }
            }
            const { apiOrigin } = getApiOrigins({ apiBase: this.baseUrl });
            if (!apiOrigin) return 'same-origin';
            return apiOrigin === window.location.origin ? 'same-origin' : 'include';
        } catch (_) {
            return 'same-origin';
        }
    }

    /**
     * Create a new terminal session
     * @param {Object} sessionData - Session configuration
     * @returns {Promise<Object>} Created session data
     */
    async createSession(sessionData) {
        return this.post('/api/sessions', sessionData);
    }

    /**
     * Get all active sessions
     * @returns {Promise<Array>} List of active sessions
     */
    async getSessions() {
        if (!this.isAuthenticated) {
            console.log('[ApiService] getSessions called but not authenticated, returning empty array');
            return [];
        }
        return this.get('/api/sessions');
    }

    /**
     * Get running containers (via backend podman integration)
     * @returns {Promise<{containers: Array}>}
     */
    async getContainers() {
        if (!this.isAuthenticated) {
            console.log('[ApiService] getContainers called but not authenticated, returning empty array');
            return { containers: [] };
        }
        return this.get('/api/containers');
    }

    /**
     * Attach to a container (server-synthesized session)
     * @param {string} name - Container name or short ID
     * @param {string} clientId - Optional client ID for context
     * @returns {Promise<Object>} Created session data
     */
    async attachContainer(name, options = {}) {
        const body = { name };
        if (options && options.clientId) body.client_id = options.clientId;
        if (options && options.parentSessionId) body.parent_session_id = options.parentSessionId;
        return this.post('/api/containers/attach', body);
    }

    /**
     * Execute a one-liner command inside a running container (creates a child session)
     * @param {string} name - Container name or short ID
     * @param {Object} options - { command, parentSessionId, clientId, title }
     * @returns {Promise<Object>} Created child session data
     */
    async execContainerCommand(name, options = {}) {
        const body = { name };
        if (options && typeof options.command === 'string') body.command = options.command;
        if (options && options.clientId) body.client_id = options.clientId;
        if (options && options.parentSessionId) body.parent_session_id = options.parentSessionId;
        if (options && typeof options.title === 'string') body.title = options.title;
        return this.post('/api/containers/exec', body);
    }

    /**
     * Execute a template-defined command tab for a session (no arbitrary commands)
     * @param {string} parentSessionId
     * @param {number} tabIndex - Index into session.command_tabs
     * @param {{ clientId?: string }} options
     */
    async runSessionCommandTab(parentSessionId, tabIndex, options = {}) {
        const body = { tab_index: Number(tabIndex) };
        if (options && options.clientId) body.client_id = options.clientId;
        return this.post(`/api/sessions/${encodeURIComponent(parentSessionId)}/command-tabs/exec`, body);
    }

    /**
     * Stop a container by name or id
     * @param {string} nameOrId - Container name or ID
     * @returns {Promise<Object>} Result
     */
    async stopContainer(nameOrId) {
        return this.post('/api/containers/stop', { name: nameOrId });
    }

    /**
     * Terminate all containers and prune volumes (permission-gated)
     * @returns {Promise<Object>} Result
     */
    async terminateAllContainers() {
        return this.post('/api/containers/terminate-all', {});
    }

    // Note: container lookup by session id is deprecated in the client.
    // Container sessions compute container name locally (sandbox-<session_id>).

    /**
     * Get all sessions including history (active and terminated)
     * @returns {Promise<Array>} List of all sessions with history
     */
    async getSessionsWithHistory() {
        return this.get('/api/sessions/history/all');
    }

    /**
     * Get paginated session history (metadata only, efficient for table view)
     * @param {Object} params - Query parameters (page, limit, search, etc.)
     * @returns {Promise<Object>} Paginated session history with metadata
     */
    async getPaginatedSessionHistory(params = {}) {
        const queryParams = new URLSearchParams();
        
        // Set default values and add to query params
        queryParams.set('page', params.page || 1);
        queryParams.set('limit', params.limit || 50);
        
        if (params.search) queryParams.set('search', params.search);
        if (params.template) queryParams.set('template', params.template);
        if (params.sortBy) queryParams.set('sortBy', params.sortBy);
        if (params.sortOrder) queryParams.set('sortOrder', params.sortOrder);
        if (params.dateFilter) queryParams.set('dateFilter', params.dateFilter);
        
        return this.get(`/api/sessions/history/paginated?${queryParams.toString()}`);
    }

    /**
     * Get a specific session by ID
     * @param {string} sessionId - Session identifier
     * @returns {Promise<Object>} Session data
     */
    async getSession(sessionId) {
        return this.get(`/api/sessions/${sessionId}`);
    }

    /**
     * Append a client-captured render marker (timestamp + line)
     * @param {string} sessionId
     * @param {{ t: number, line: number }} marker
     */
    async addSessionMarker(sessionId, marker) {
        const body = {
            t: Number.isFinite(Number(marker?.t)) ? Math.floor(Number(marker.t)) : Date.now(),
            line: Number.isFinite(Number(marker?.line)) ? Math.floor(Number(marker.line)) : 0
        };
        return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/markers`, body);
    }

    /**
     * Get session history
     * @param {string} sessionId - Session identifier
     * @returns {Promise<Array>} Session history entries
     */
    async getSessionHistory(sessionId) {
        return this.get(`/api/sessions/${sessionId}/history`);
    }

    /**
     * Send input to a session via API (creates hidden input markers on the server)
     * @param {string} sessionId
     * @param {{ data: string, submit?: boolean, raw?: boolean, enter_style?: 'cr'|'lf'|'crlf', activity_policy?: 'defer'|'immediate'|'suppress', simulate_typing?: boolean, typing_delay_ms?: number, notify?: boolean }} body
     */
    async sendSessionInput(sessionId, body) {
        const payload = { ...(body || {}) };
        // Default activity policy to "defer" when not explicitly provided
        if (payload.activity_policy === undefined || payload.activity_policy === null) {
            payload.activity_policy = 'defer';
        } else {
            const v = String(payload.activity_policy).toLowerCase();
            if (v === 'immediate' || v === 'suppress' || v === 'defer') {
                payload.activity_policy = v;
            } else {
                payload.activity_policy = 'defer';
            }
        }
        return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/input`, payload);
    }

    /**
     * Get deferred input queue for a session
     * @param {string} sessionId
     * @returns {Promise<{session_id: string, items: Array}>}
     */
    async getDeferredInput(sessionId) {
        return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/deferred-input`);
    }

    /**
     * Delete a single deferred input entry
     * @param {string} sessionId
     * @param {string} pendingId
     * @returns {Promise<void>}
     */
    async deleteDeferredInputItem(sessionId, pendingId) {
        return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/deferred-input/${encodeURIComponent(pendingId)}`);
    }

    /**
     * Clear all deferred input entries for a session
     * @param {string} sessionId
     * @returns {Promise<{cleared: number}>}
     */
    async clearDeferredInput(sessionId) {
        return this.delete(`/api/sessions/${encodeURIComponent(sessionId)}/deferred-input`);
    }

    /**
     * Get stop inputs configuration for a session
     * @param {string} sessionId
     * @returns {Promise<{session_id: string, stop_inputs_enabled: boolean, stop_inputs: Array, stop_inputs_rearm_remaining?: number, stop_inputs_rearm_max?: number}>}
     */
    async getStopPrompts(sessionId) {
        // Backend exposes both /stop-inputs (new) and /stop-prompts (legacy) paths.
        return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/stop-inputs`);
    }

    /**
     * Replace stop inputs array for a session
     * @param {string} sessionId
     * @param {Array} prompts
     * @param {number|undefined} rearmRemaining
     * @returns {Promise<{session_id: string, stop_inputs_enabled: boolean, stop_inputs: Array, stop_inputs_rearm_remaining?: number, stop_inputs_rearm_max?: number}>}
     */
    async setStopPrompts(sessionId, prompts, rearmRemaining) {
        const body = { stop_inputs: Array.isArray(prompts) ? prompts : [] };
        if (Number.isInteger(rearmRemaining) && rearmRemaining >= 0) {
            body.stop_inputs_rearm_remaining = rearmRemaining;
        }
        return this.put(`/api/sessions/${encodeURIComponent(sessionId)}/stop-inputs`, body);
    }

    /**
     * Toggle or set global stop inputs enabled flag
     * @param {string} sessionId
     * @param {boolean|undefined} enabled - When undefined, backend toggles the flag
     * @param {number|undefined} rearmRemaining - Optional rearm counter value (0..max)
     * @returns {Promise<{session_id: string, stop_inputs_enabled: boolean, stop_inputs_rearm_remaining?: number, stop_inputs_rearm_max?: number}>}
     */
    async setStopPromptsEnabled(sessionId, enabled, rearmRemaining) {
        const body = {};
        if (typeof enabled === 'boolean') body.enabled = enabled;
        if (Number.isInteger(rearmRemaining) && rearmRemaining >= 0) {
            body.stop_inputs_rearm_remaining = rearmRemaining;
        }
        return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/stop-inputs/enabled`, body);
    }

    /**
     * Toggle or set a single stop input's armed state
     * @param {string} sessionId
     * @param {string} promptId
     * @param {boolean|undefined} armed - When undefined, backend toggles the flag
     * @returns {Promise<{session_id: string, stop_inputs_enabled: boolean, stop_inputs: Array}>}
     */
    async toggleStopPrompt(sessionId, promptId, armed) {
        const body = {};
        if (typeof armed === 'boolean') body.armed = armed;
        return this.post(`/api/sessions/${encodeURIComponent(sessionId)}/stop-inputs/${encodeURIComponent(promptId)}/toggle`, body);
    }

    /**
     * Stream session history as raw text with optional Range/offset helpers
     * @param {string} sessionId
     * @param {{ signal?: AbortSignal, rangeStart?: number, rangeEnd?: number, tailBytes?: number, sinceOffset?: number }} options
     * @returns {Promise<{ response: Response, reader: ReadableStreamDefaultReader<string>, contentLength: number|null }>}
     */
    async streamSessionHistory(sessionId, options = {}) {
        const sock = this._detectSocketMode();
        if (sock.enabled && window.desktop?.http?.request) {
            try {
                const params = new URLSearchParams();
                if (Number.isInteger(options.tailBytes) && options.tailBytes >= 0) params.set('tail_bytes', String(options.tailBytes));
                if (Number.isInteger(options.sinceOffset) && options.sinceOffset >= 0) params.set('since_offset', String(options.sinceOffset));
                const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/history/raw${params.toString() ? `?${params.toString()}` : ''}`;
                const path = `${sock.basePath || ''}${endpoint}`;
                const headers = { 'Accept': 'text/plain', ...(this._sessionCookie ? { 'Cookie': this._sessionCookie } : {}) };
                const resp = await window.desktop.http.request({ socketPath: sock.socketPath, method: 'GET', path, headers });
                if (!resp || !resp.ok || (resp.status !== 200 && resp.status !== 206)) {
                    const err = new Error(`Failed to stream session history (${resp && resp.status})`);
                    err.status = resp && resp.status;
                    throw err;
                }
                const text = resp.body || '';
                let consumed = false;
                const reader = {
                    async read() { if (consumed) return { value: undefined, done: true }; consumed = true; return { value: text, done: false }; },
                    releaseLock() {}
                };
                const headersObj = resp.headers || {};
                const fakeResp = { ok: true, headers: { get: (name) => { const k = String(name||'').toLowerCase(); const v = headersObj[k] || headersObj[name]; return Array.isArray(v) ? v[0] : v || null; } } };
                let contentLength = null;
                try { const len = headersObj['content-length'] || headersObj['Content-Length']; const n = Number(len); if (Number.isFinite(n)) contentLength = n; } catch (_) {}
                return { response: fakeResp, reader, contentLength };
            } catch (e) {
                const err = new Error(String(e && e.message ? e.message : e));
                err.status = e && e.status;
                throw err;
            }
        }
        const params = new URLSearchParams();
        if (Number.isInteger(options.tailBytes) && options.tailBytes >= 0) params.set('tail_bytes', String(options.tailBytes));
        if (Number.isInteger(options.sinceOffset) && options.sinceOffset >= 0) params.set('since_offset', String(options.sinceOffset));
        const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/history/raw${params.toString() ? `?${params.toString()}` : ''}`;
        const url = `${this.baseUrl}${endpoint}`;
        const headers = { 'Accept': 'text/plain' };
        if (Number.isInteger(options.rangeStart) || Number.isInteger(options.rangeEnd)) {
            const start = Number.isInteger(options.rangeStart) ? Math.max(0, Math.floor(options.rangeStart)) : '';
            const end = Number.isInteger(options.rangeEnd) ? Math.max(0, Math.floor(options.rangeEnd)) : '';
            headers['Range'] = `bytes=${start}-${end}`;
        }
        const resp = await fetch(url, {
            method: 'GET',
            headers,
            credentials: this.getCredentialsMode(),
            signal: options.signal
        });
        if (!resp.ok && resp.status !== 206) {
            const err = new Error(`Failed to stream session history (${resp.status})`);
            err.status = resp.status;
            throw err;
        }
        // Determine content length if provided
        let contentLength = null;
        try {
            const len = resp.headers.get('Content-Length');
            if (len != null) {
                const n = Number(len);
                if (Number.isFinite(n)) contentLength = n;
            }
        } catch (_) {}

        // Setup UTF-8 text reader
        let reader;
        try {
            if (window.TextDecoderStream && resp.body && typeof resp.body.pipeThrough === 'function') {
                const textStream = resp.body.pipeThrough(new TextDecoderStream());
                reader = textStream.getReader();
            } else if (resp.body && typeof resp.body.getReader === 'function') {
                const rawReader = resp.body.getReader();
                const decoder = new TextDecoder('utf-8');
                reader = {
                    async read() {
                        const { value, done } = await rawReader.read();
                        if (done) return { value: undefined, done: true };
                        return { value: decoder.decode(value, { stream: true }), done: false };
                    },
                    releaseLock() { try { rawReader.releaseLock(); } catch (_) {} }
                };
            } else {
                // Fallback: fetch full text (no stream)
                const text = await resp.text();
                let consumed = false;
                reader = {
                    async read() {
                        if (consumed) return { value: undefined, done: true };
                        consumed = true; return { value: text, done: false };
                    },
                    releaseLock() {}
                };
            }
        } catch (e) {
            // Non-streaming fallback
            const text = await resp.text();
            let consumed = false;
            reader = {
                async read() { if (consumed) return { value: undefined, done: true }; consumed = true; return { value: text, done: false }; },
                releaseLock() {}
            };
        }

        return { response: resp, reader, contentLength };
    }
    
    /**
     * Fork an existing session
     * @param {string} sessionId - Source session identifier
     * @returns {Promise<Object>} Response with new session ID
     */
    async forkSession(sessionId, overrides = {}) {
        const payload = { fork_from_session_id: String(sessionId) };
        if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
            Object.assign(payload, overrides);
        }
        return this.post(`/api/sessions`, payload);
    }
    // No relaunch alias; fork is the canonical operation

    /**
     * Terminate a session
     * @param {string} sessionId - Session identifier
     * @returns {Promise<void>}
     */
    async terminateSession(sessionId) {
        return this.delete(`/api/sessions/${sessionId}`);
    }

    /**
     * Rename a session
     * @param {string} sessionId - Session identifier
     * @param {string} newName - New session name
     * @returns {Promise<Object>} Updated session data
     */
    async renameSession(sessionId, newName) {
        return this.patch(`/api/sessions/${sessionId}`, { name: newName });
    }

    /**
     * Resize a terminal session
     * @param {string} sessionId - Session identifier
     * @param {number} cols - Number of columns
     * @param {number} rows - Number of rows
     * @returns {Promise<void>}
     */
    async resizeSession(sessionId, cols, rows) {
        return this.post(`/api/sessions/${sessionId}/resize`, { cols, rows });
    }

    /**
     * Clear session history
     * @param {string} sessionId - Session identifier
     * @returns {Promise<void>}
     */
    async clearSessionHistory(sessionId) {
        return this.delete(`/api/sessions/${sessionId}/history`);
    }

    /**
     * Send input to a session
     * @param {string} sessionId - Session identifier
     * @param {string|Object} data - Input data or options object
     * @returns {Promise<void>}
     */
    async sendInput(sessionId, data) {
        // Accept either a raw string or an object { data: string, ...options }
        // When an object is provided, pass through additional options (e.g., submit, enter_style, notify, by)
        let body;
        if (data && typeof data === 'object') {
            if (typeof data.data === 'string') {
                body = { ...data };
            } else {
                body = { data: String(data) };
            }
        } else {
            body = { data };
        }
        return this.post(`/api/sessions/${sessionId}/input`, body);
    }

    /**
     * Upload an image file for a container session; backend copies into the container
     * @param {string} sessionId
     * @param {{ filename: string, base64: string, mimeType?: string }} payload
     * @returns {Promise<{container_path: string}>}
     */
    async uploadSessionImage(sessionId, payload) {
        const body = {
            filename: String(payload?.filename || ''),
            content: String(payload?.base64 || ''),
            mime_type: payload?.mimeType ? String(payload.mimeType) : undefined
        };
        return this.post(`/api/sessions/${sessionId}/upload-image`, body);
    }

    /**
     * Scheduled Input Rules API
     */
    async getInputRules(sessionId) {
        return this.get(`/api/sessions/${sessionId}/input/rules`);
    }

    async addInputRule(sessionId, spec) {
        return this.post(`/api/sessions/${sessionId}/input/rules`, spec || {});
    }

    async updateInputRule(sessionId, ruleId, patch) {
        return this.patch(`/api/sessions/${sessionId}/input/rules/${ruleId}`, patch || {});
    }

    async deleteInputRule(sessionId, ruleId) {
        return this.delete(`/api/sessions/${sessionId}/input/rules/${ruleId}`);
    }

    async clearInputRules(sessionId) {
        return this.delete(`/api/sessions/${sessionId}/input/rules`);
    }

    async triggerInputRule(sessionId, ruleId) {
        return this.post(`/api/sessions/${sessionId}/input/rules/${ruleId}/trigger`, {});
    }

    /**
     * Search sessions
     * @param {string} query - Search query
     * @param {string} filterType - Filter type (all, active, terminated)
     * @returns {Promise<Array>} Search results
     */
    async searchSessions(query, filterType = 'all', options = {}) {
        const payload = { query, filter_type: filterType };
        // Include content search only when explicitly requested
        if (options && options.searchContent === true) {
            payload.search_content = true;
        }
        return this.post('/api/sessions/search', payload);
    }

    /**
     * Get available command templates
     * @returns {Promise<Object>} Templates data
     */
    async getTemplates() {
        if (!this.isAuthenticated) {
            console.log('[ApiService] getTemplates called but not authenticated, returning empty object');
            return { templates: [] };
        }
        return this.get('/api/templates');
    }

    /**
     * Get current authenticated user profile
     * @returns {Promise<Object>} { username, groups, permissions, features }
     */
    async getCurrentUser() {
        // Note: backend mounts users router at '/api/user', not '/api/users'
        return this.get('/api/user/me');
    }

    /**
     * Admin: Rotate server cookie signing secret and issue a fresh session cookie
     * Gated by feature flag on the server; returns { ok: true } on success
     */
    async resetSessionToken() {
        try {
            return await this.post('/api/auth/reset-token', {});
        } catch (err) {
            if (err && err.status === 403) {
                // Surface a clear error when feature is disabled
                throw Object.assign(new Error('Feature disabled'), { status: 403, code: 'FEATURE_DISABLED' });
            }
            throw err;
        }
    }

    /**
     * Admin: Reload server config (templates/users/groups/links) from disk
     * Gated by feature flag on the server; returns a summary payload on success
     */
    async reloadServerConfig() {
        try {
            return await this.post('/api/system/reload-config', {});
        } catch (err) {
            if (err && err.status === 403) {
                // Surface a clear error when feature is disabled
                throw Object.assign(new Error('Feature disabled'), { status: 403, code: 'FEATURE_DISABLED' });
            }
            throw err;
        }
    }

    /**
     * Get global link groups for the header dropdown
     * @returns {Promise<{groups: Array}>}
     */
    async getLinks() {
        if (!this.isAuthenticated) {
            console.log('[ApiService] getLinks called but not authenticated, returning empty');
            return { groups: [] };
        }
        return this.get('/api/links');
    }

    /**
     * Notifications API
     */
    async getNotifications() {
        if (!this.isAuthenticated) {
            console.log('[ApiService] getNotifications called but not authenticated, returning empty');
            return { notifications: [] };
        }
        return this.get('/api/notifications');
    }

    async markNotificationRead(id) {
        return this.patch(`/api/notifications/${id}`, { read: true });
    }

    async deleteNotification(id) {
        return this.delete(`/api/notifications/${id}`);
    }

    async markAllNotificationsRead() {
        return this.patch('/api/notifications/mark-all-read', {});
    }

    async deleteAllNotifications() {
        return this.delete('/api/notifications');
    }

    async submitNotificationAction(notificationId, actionKey, inputs = {}) {
        const id = encodeURIComponent(String(notificationId));
        const body = {
            action_key: actionKey,
            inputs: inputs && typeof inputs === 'object' ? inputs : {}
        };
        return this.post(`/api/notifications/${id}/action`, body);
    }

    /**
     * Scheduled Input Rules API
     */
    async getScheduledInputRules(sessionId) {
        return this.get(`/api/sessions/${sessionId}/input/rules`);
    }

    async createScheduledInputRule(sessionId, rule) {
        // Accept flat rule object from UI and map to backend shape
        // UI passes: { type, data, offset_ms?, interval_ms?, submit, enter_style, raw, simulate_typing, typing_delay_ms, notify }
        const body = {
            type: rule?.type || 'offset',
            data: typeof rule?.data === 'string' ? rule.data : ''
        };
        if (body.type === 'offset') body.offset_ms = Math.max(0, Number(rule?.offset_ms || 0));
        if (body.type === 'interval') body.interval_ms = Math.max(0, Number(rule?.interval_ms || 0));
        if (body.type === 'interval' && rule?.stop_after !== undefined && rule?.stop_after !== null) {
            const sa = Math.floor(Number(rule.stop_after));
            if (Number.isFinite(sa) && sa > 0) body.stop_after = sa;
        }
        const policyRaw = typeof rule?.activity_policy === 'string' ? rule.activity_policy : 'immediate';
        const policy = (() => {
            const v = String(policyRaw).toLowerCase();
            if (v === 'suppress' || v === 'defer') return v;
            return 'immediate';
        })();
        body.options = {
            submit: rule?.submit !== false,
            enter_style: rule?.enter_style || 'cr',
            raw: !!rule?.raw,
            activity_policy: policy,
            simulate_typing: !!rule?.simulate_typing,
            typing_delay_ms: Number(rule?.typing_delay_ms) || 0,
            notify: rule?.notify !== false
        };
        return this.post(`/api/sessions/${sessionId}/input/rules`, body);
    }

    async clearScheduledInputRules(sessionId) {
        return this.delete(`/api/sessions/${sessionId}/input/rules`);
    }

    async pauseScheduledInputRule(sessionId, ruleId) {
        return this.patch(`/api/sessions/${sessionId}/input/rules/${encodeURIComponent(ruleId)}`, { paused: true });
    }

    async resumeScheduledInputRule(sessionId, ruleId) {
        return this.patch(`/api/sessions/${sessionId}/input/rules/${encodeURIComponent(ruleId)}`, { paused: false });
    }

    async triggerScheduledInputRule(sessionId, ruleId) {
        return this.post(`/api/sessions/${sessionId}/input/rules/${encodeURIComponent(ruleId)}/trigger`, {});
    }

    async removeScheduledInputRule(sessionId, ruleId) {
        return this.delete(`/api/sessions/${sessionId}/input/rules/${encodeURIComponent(ruleId)}`);
    }

    /**
     * Get dynamic options for a specific template parameter
     * @param {string} templateId - Template identifier
     * @param {string} parameterName - Parameter name
     * @returns {Promise<Object>} Parameter options data
     */
    async getParameterOptions(templateId, parameterName) {
        return this.get(`/api/templates/${templateId}/parameters/${parameterName}/options`);
    }

    /**
     * Get dynamic options for a parameter, providing variables for interpolation
     * @param {string} templateId
     * @param {string} parameterName
     * @param {Object} variables
     */
    async getParameterOptionsWithVariables(templateId, parameterName, variables = {}) {
        return this.post(`/api/templates/${templateId}/parameters/${parameterName}/options`, { variables });
    }


    /**
     * Get system information
     * @returns {Promise<Object>} System info data
     */
    async getInfo(options = {}) {
        let retryDelay = null;
        if (options && options.retryOn401 === true) {
            const explicitDelay = Number(options.retryDelayMs);
            retryDelay = Number.isFinite(explicitDelay) && explicitDelay >= 0 ? explicitDelay : 100;
            this._infoRetryConfig = null;
        } else if (this._infoRetryConfig) {
            retryDelay = this._infoRetryConfig.delayMs;
            this._infoRetryConfig = null;
        }

        try {
            return await this.get('/api/info');
        } catch (error) {
            if (retryDelay != null && error && error.status === 401) {
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
                return this.get('/api/info');
            }
            throw error;
        }
    }

    /**
     * Set session title
     * @param {string} sessionId - Session identifier
     * @param {string} title - New session title
     * @returns {Promise<Object>} Updated session data
     */
    async setSessionTitle(sessionId, title) {
        return this.put(`/api/sessions/${sessionId}/title`, { title });
    }

    /**
     * Set session save history flag
     * @param {string} sessionId - Session identifier
     * @param {boolean} saveSessionHistory - Whether to save session history
     * @returns {Promise<Object>} Updated session data
     */
    async setSessionSaveHistory(sessionId, saveSessionHistory) {
        return this.post(`/api/sessions/${sessionId}/save-history`, { save_session_history: saveSessionHistory });
    }

    /**
     * Update session workspace
     * @param {string} sessionId - Session identifier
     * @param {string} workspace - New workspace name
     * @returns {Promise<Object>} Updated session data
     */
    async updateSessionWorkspace(sessionId, workspace) {
        return this.put(`/api/sessions/${sessionId}/workspace`, { workspace });
    }

    /**
     * Workspace service API (per-session workspace web service)
     * Backend-hosted implementation under /api/sessions/:sid/workspace[...].
     */
    async listWorkspaceFiles(sessionId, path = '/') {
        const encodedSid = encodeURIComponent(sessionId);
        const params = new URLSearchParams();
        if (typeof path === 'string' && path && path !== '/') {
            params.set('path', path);
        }
        const qs = params.toString();
        return this.get(`/api/sessions/${encodedSid}/workspace/list${qs ? `?${qs}` : ''}`);
    }

    async downloadWorkspaceFile(sessionId, path, options = {}) {
        const encodedSid = encodeURIComponent(sessionId);
        const params = new URLSearchParams();
        if (typeof path === 'string' && path) {
            params.set('path', path);
        }
        if (options && options.download === true) {
            params.set('download', '1');
        }
        const endpoint = `/api/sessions/${encodedSid}/workspace/file${params.toString() ? `?${params.toString()}` : ''}`;
        const url = `${this.baseUrl}${endpoint}`;
        const resp = await fetch(url, {
            method: 'GET',
            credentials: this.getCredentialsMode()
        });
        if (!resp.ok) {
            let message = `Failed to download workspace file (${resp.status})`;
            try {
                const data = await resp.json();
                if (data && data.message) {
                    message = data.message;
                }
            } catch (_) {}
            const err = new Error(message);
            err.status = resp.status;
            throw err;
        }
        return resp;
    }

    async uploadWorkspaceFile(sessionId, path, fileOrBlob) {
        const encodedSid = encodeURIComponent(sessionId);
        const params = new URLSearchParams();
        if (typeof path === 'string' && path) {
            params.set('path', path);
        }
        const endpoint = `/api/sessions/${encodedSid}/workspace/file${params.toString() ? `?${params.toString()}` : ''}`;
        const url = `${this.baseUrl}${endpoint}`;
        const body = fileOrBlob;
        const headers = {};
        if (fileOrBlob && typeof fileOrBlob.type === 'string' && fileOrBlob.type) {
            headers['Content-Type'] = fileOrBlob.type;
        } else {
            headers['Content-Type'] = 'application/octet-stream';
        }
        const resp = await fetch(url, {
            method: 'PUT',
            headers,
            body,
            credentials: this.getCredentialsMode()
        });
        if (!resp.ok) {
            let message = `Failed to upload workspace file (${resp.status})`;
            try {
                const data = await resp.json();
                if (data && data.message) {
                    message = data.message;
                }
            } catch (_) {}
            const err = new Error(message);
            err.status = resp.status;
            throw err;
        }
        try {
            return await resp.json();
        } catch (_) {
            return {};
        }
    }

    /**
     * Update session visibility
     * @param {string} sessionId - Session identifier
     * @param {('public'|'private'|'shared_readonly')} visibility - New visibility
     * @returns {Promise<Object>} Result
     */
    async setSessionVisibility(sessionId, visibility) {
        return this.put(`/api/sessions/${sessionId}/visibility`, { visibility });
    }

    /**
     * Workspaces API
     */
    async getWorkspaces() {
        if (!this.isAuthenticated) {
            console.log('[ApiService] getWorkspaces called but not authenticated, returning empty array');
            return [];
        }
        return this.get('/api/workspaces');
    }

    async createWorkspace(name) {
        return this.post('/api/workspaces', { name });
    }

    async renameWorkspace(oldName, newName) {
        const encoded = encodeURIComponent(oldName);
        return this.put(`/api/workspaces/${encoded}`, { new_name: newName });
    }

    async deleteWorkspace(name) {
        const encoded = encodeURIComponent(name);
        return this.delete(`/api/workspaces/${encoded}`);
    }

    async updateWorkspace(name, updates) {
        const encoded = encodeURIComponent(name);
        return this.patch(`/api/workspaces/${encoded}`, updates || {});
    }

    async reorderWorkspaces(order) {
        return this.put('/api/workspaces/order', { order });
    }

    async reorderWorkspaceSessions(workspaceName, order) {
        const encoded = encodeURIComponent(workspaceName);
        return this.put(`/api/workspaces/${encoded}/sessions/order`, { order });
    }

    // Workspace notes API
    async getWorkspaceNote(name) {
        const encoded = encodeURIComponent(name);
        try {
            return await this.get(`/api/workspaces/${encoded}/note`);
        } catch (err) {
            if (err && err.status === 403 && (err.code === 'FEATURE_DISABLED' || /feature/i.test(String(err.message || '')))) {
                try { console.info(`[ApiService] Notes disabled (suppressed 403) for GET /api/workspaces/${encoded}/note`); } catch (_) {}
                return { content: '', version: 0, updated_at: null, updated_by: null, workspace: name };
            }
            throw err;
        }
    }

    async setWorkspaceNote(name, content, version) {
        const encoded = encodeURIComponent(name);
        const body = { content };
        if (Number.isInteger(version)) body.version = version;
        try {
            return await this.put(`/api/workspaces/${encoded}/note`, body);
        } catch (err) {
            if (err && err.status === 403 && (err.code === 'FEATURE_DISABLED' || /feature/i.test(String(err.message || '')))) {
                try { console.info(`[ApiService] Notes disabled (suppressed 403) for PUT /api/workspaces/${encoded}/note`); } catch (_) {}
                return { content: String(content || ''), version: Number.isInteger(version) ? version : 0, updated_at: null, updated_by: null, workspace: name };
            }
            throw err;
        }
    }

    /**
     * Add links to an existing session
     * @param {string} sessionId - Session identifier
     * @param {Array} links - Array of link objects with url and name properties
     * @returns {Promise<Object>} Updated session data
     */
    async addSessionLinks(sessionId, links) {
        return this.post(`/api/sessions/${sessionId}/links`, { links });
    }

    /**
     * Generate or regenerate HTML for a session link using the backend pre-view pipeline.
     * @param {string} sessionId - Session identifier
     * @param {number|string} linkRef - Either a positional index into the session.links array
     *   or a stable backend-assigned link_id string.
     * @param {Object|null} payloadOrTheme - Either:
     *   - A legacy theme object `{ bg_primary, ... }`, or
     *   - A payload `{ theme: { ... }, fonts?: { ui?: string, code?: string } }`.
     * @returns {Promise<Object|null>} Generation result (shape defined by backend)
     */
    async generateLinkHtml(sessionId, linkRef, payloadOrTheme = null) {
        const encodedSid = encodeURIComponent(sessionId);
        const ref = linkRef;
        let endpoint;
        if (typeof ref === 'string') {
            const trimmed = ref.trim();
            const isNumeric = trimmed !== '' && /^[0-9]+$/.test(trimmed);
            if (!trimmed) {
                endpoint = `/api/sessions/${encodedSid}/links/0/generate`;
            } else if (isNumeric) {
                const idx = Math.floor(Number(trimmed));
                endpoint = `/api/sessions/${encodedSid}/links/${idx}/generate`;
            } else {
                const encodedLinkId = encodeURIComponent(trimmed);
                endpoint = `/api/sessions/${encodedSid}/links/id/${encodedLinkId}/generate`;
            }
        } else if (Number.isFinite(Number(ref)) && Number(ref) >= 0) {
            const idx = Math.floor(Number(ref));
            endpoint = `/api/sessions/${encodedSid}/links/${idx}/generate`;
        } else {
            endpoint = `/api/sessions/${encodedSid}/links/0/generate`;
        }
        const body = {};
        const src = payloadOrTheme;
        if (src && typeof src === 'object') {
            const hasThemeProp = Object.prototype.hasOwnProperty.call(src, 'theme') && src.theme && typeof src.theme === 'object';
            const hasFontsProp = Object.prototype.hasOwnProperty.call(src, 'fonts') && src.fonts && typeof src.fonts === 'object';
            if (hasThemeProp || hasFontsProp) {
                if (hasThemeProp) {
                    body.theme = { ...src.theme };
                }
                if (hasFontsProp) {
                    const fonts = {};
                    try {
                        const rawFonts = src.fonts || {};
                        ['ui', 'code'].forEach((key) => {
                            if (Object.prototype.hasOwnProperty.call(rawFonts, key)) {
                                const raw = rawFonts[key];
                                if (raw != null) {
                                    const val = String(raw).trim();
                                    if (val) {
                                        fonts[key] = val;
                                    }
                                }
                            }
                        });
                    } catch (_) {
                        // best-effort
                    }
                    if (Object.keys(fonts).length > 0) {
                        body.fonts = fonts;
                    }
                }
            } else {
                // Backwards-compatible: treat src itself as a theme object
                body.theme = { ...src };
            }
        }
        return this.post(endpoint, body);
    }

    /**
     * Update a link in an existing session
     * @param {string} sessionId - Session identifier
     * @param {string} url - The URL of the link to update
     * @param {Object} updates - Object with fields to update (e.g., { name: 'New Name', refresh_on_view: true })
     * @returns {Promise<Object>} Updated session data
     */
    async updateSessionLink(sessionId, url, updates) {
        return this.patch(`/api/sessions/${sessionId}/links`, { url, ...updates });
    }

    /**
     * Remove a link from an existing session
     * @param {string} sessionId - Session identifier
     * @param {string} url - The URL of the link to remove
     * @returns {Promise<Object>} Updated session data
     */
    async removeSessionLink(sessionId, url) {
        const encodedUrl = encodeURIComponent(url);
        return this.delete(`/api/sessions/${sessionId}/links?url=${encodedUrl}`);
    }

    /**
     * Retrieve the collaborative note for a session
     * @param {string} sessionId - Session identifier
     * @returns {Promise<Object>} Note snapshot { content, version, updated_at, updated_by }
     */
    async getSessionNote(sessionId) {
        try {
            return await this.get(`/api/sessions/${sessionId}/note`);
        } catch (err) {
            if (err && err.status === 403 && (err.code === 'FEATURE_DISABLED' || /feature/i.test(String(err.message || '')))) {
                try { console.info(`[ApiService] Notes disabled (suppressed 403) for GET /api/sessions/${sessionId}/note`); } catch (_) {}
                return { content: '', version: 0, updated_at: null, updated_by: null };
            }
            throw err;
        }
    }

    /**
     * Update the collaborative note for a session
     * @param {string} sessionId - Session identifier
     * @param {Object} note - Note payload
     * @param {string} note.content - Note content in markdown format
     * @param {number} note.version - Expected note version for conflict detection
     * @returns {Promise<Object>} Updated note snapshot
     */
    async updateSessionNote(sessionId, note) {
        const payload = {
            content: note?.content ?? '',
            version: note?.version
        };
        try {
            return await this.put(`/api/sessions/${sessionId}/note`, payload);
        } catch (err) {
            if (err && err.status === 403 && (err.code === 'FEATURE_DISABLED' || /feature/i.test(String(err.message || '')))) {
                try { console.info(`[ApiService] Notes disabled (suppressed 403) for PUT /api/sessions/${sessionId}/note`); } catch (_) {}
                return { content: String(payload.content || ''), version: Number.isInteger(payload.version) ? payload.version : 0, updated_at: null, updated_by: null };
            }
            throw err;
        }
    }

    /**
     * Generic GET request
     * @private
     */
    async get(endpoint) { return this._request('GET', endpoint); }

    /**
     * Generic POST request
     * @private
     */
    async post(endpoint, data = {}) { return this._request('POST', endpoint, data); }

    /**
     * Generic PATCH request
     * @private
     */
    async patch(endpoint, data = {}) { return this._request('PATCH', endpoint, data); }

    /**
     * Generic PUT request
     * @private
     */
    async put(endpoint, data = {}) { return this._request('PUT', endpoint, data); }

    /**
     * Generic DELETE request
     * @private
     */
    async delete(endpoint) { return this._request('DELETE', endpoint); }

    async _request(method, endpoint, data) {
        const sock = this._detectSocketMode();
        if (sock.enabled && window.desktop?.http?.request) {
            const dbg = (...args) => { if (this._debug) { try { console.log('[ApiService]', ...args); } catch (_) {} } };
            const hasBody = !(method === 'GET' || method === 'DELETE');
            const path = `${sock.basePath || ''}${endpoint}`;
            const headers = { ...this.headers };
            if (this._sessionCookie) headers['Cookie'] = this._sessionCookie;
            dbg('Request(UDS)', { method, path, headers: headers });
            const res = await window.desktop.http.request({ socketPath: sock.socketPath, method, path, headers, body: hasBody ? JSON.stringify(data || {}) : undefined });
            if (!res || !res.ok) {
                // Normalize to fetch-like error
                const error = new Error((res && res.body) || 'Request failed');
                error.status = res && res.status;
                error.statusText = '';
                try {
                    const ct = (res && res.headers && ((res.headers['content-type']) || (res.headers['Content-Type']))) || '';
                    if (ct && typeof ct === 'string' && ct.includes('application/json')) {
                        try { const parsed = JSON.parse(res.body || '{}'); error.message = parsed.detail || parsed.message || error.message; error.code = parsed.code; error.context = parsed.context || {}; } catch (_) {}
                    }
                } catch (_) {}
                throw error;
            }
            // Parse JSON when applicable
            try {
                const ct = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '';
                if (ct && typeof ct === 'string' && ct.includes('application/json')) {
                    return JSON.parse(res.body || 'null');
                }
            } catch (_) {}
            return null;
        }
        const url = `${this.baseUrl}${endpoint}`;
        const dbg = (...args) => { if (this._debug) { try { console.log('[ApiService]', ...args); } catch (_) {} } };
        const sanitizeHeaders = (h) => {
            try {
                const o = { ...(h || {}) };
                if (o.Authorization) o.Authorization = o.Authorization.replace(/^(Basic|Bearer)\s+.*/i, '$1 <redacted>');
                return o;
            } catch (_) { return h; }
        };
        const hasBody = !(method === 'GET' || method === 'DELETE');
        const body = hasBody ? (data || {}) : undefined;
        dbg('Request', { method, url, headers: sanitizeHeaders(this.headers), body });
        // Use fetch (HTTP). Native HTTPS bypass has been removed.
        dbg('Transport=fetch');
        const response = await fetch(url, {
            method: method.toUpperCase(),
            headers: this.headers,
            body: hasBody ? JSON.stringify(data || {}) : undefined,
            credentials: this.getCredentialsMode()
        });
        if (!response.ok && this._debug) {
            try {
                const clone = response.clone();
                const text = await clone.text();
                dbg('Error(fetch)', { status: response.status, statusText: response.statusText, body: text && text.slice ? text.slice(0, 800) : text });
            } catch (_) {}
        }
        const parsed = await this.handleResponse(response);
        if (this._debug) dbg('Parsed(fetch)', parsed);
        return parsed;
    }

    setSessionCookieString(cookieHeaderValue) {
        try { this._sessionCookie = cookieHeaderValue && String(cookieHeaderValue).trim() ? String(cookieHeaderValue) : null; } catch (_) { this._sessionCookie = null; }
    }
    clearSessionCookieString() {
        this._sessionCookie = null;
    }

    /**
     * Handle HTTP response
     * @private
     */
    async handleResponse(response) {
        if (!response.ok) {
            const error = await this.parseError(response);
            throw error;
        }

        // Handle empty responses
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            return null;
        }

        try {
            return await response.json();
        } catch (e) {
            return null;
        }
    }

    /**
     * Parse error response
     * @private
     */
    async parseError(response) {
        const error = new Error();
        error.status = response.status;
        error.statusText = response.statusText;

        try {
            const data = await response.json();
            error.message = data.detail || data.message || response.statusText;
            error.code = data.code || null;
            error.context = data.context || {};
        } catch (e) {
            error.message = response.statusText;
        }

        return error;
    }

    /**
     * Set authorization header
     * @param {string} token - Authorization token
     */
    setAuthToken(token) {
        if (token) {
            this.headers['Authorization'] = `Bearer ${token}`;
        } else {
            delete this.headers['Authorization'];
        }
    }

    /**
     * Set HTTP Basic authentication
     * @param {string} username - Username
     * @param {string} password - Password
     */
    setBasicAuth(username, password) {
        if (username && password) {
            const credentials = btoa(`${username}:${password}`);
            this.headers['Authorization'] = `Basic ${credentials}`;
        } else {
            delete this.headers['Authorization'];
        }
    }

    /**
     * Set custom headers
     * @param {Object} headers - Custom headers to set
     */
    setHeaders(headers) {
        this.headers = { ...this.headers, ...headers };
    }

    /**
     * Set authentication status
     * @param {boolean} isAuthenticated - Whether the user is authenticated
     */
    setAuthenticated(isAuthenticated) {
        this.isAuthenticated = isAuthenticated;
        console.log(`[ApiService] Authentication status set to: ${isAuthenticated}`);
    }

    setCredentialsModeStrategy(strategy) {
        if (typeof strategy === 'function') {
            this._credentialsStrategy = strategy;
        } else if (typeof strategy === 'string' && (strategy === 'same-origin' || strategy === 'include')) {
            this._credentialsStrategy = () => strategy;
        } else if (strategy == null) {
            this._credentialsStrategy = null;
        }
    }

    scheduleInfoRetryOnce(delayMs = 100) {
        const numericDelay = Number(delayMs);
        const safeDelay = Number.isFinite(numericDelay) && numericDelay >= 0 ? numericDelay : 100;
        this._infoRetryConfig = { delayMs: safeDelay };
    }
}

// Export singleton instance - will be configured in app.js
export const apiService = new ApiService();
