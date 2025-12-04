import { FormModal, Modal } from './modal.js';
import { iconUtils } from '../../utils/icon-utils.js';
import { apiService } from '../../services/api.service.js';
import { notificationDisplay } from '../../utils/notification-display.js';

function createBaseModalElement(id, title) {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2 data-modal-title>${title}</h2>
                <button class="modal-close" data-modal-close>&times;</button>
            </div>
            <div class="modal-body"></div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-modal-close>Close</button>
                <button type="button" class="btn btn-primary" data-modal-submit>Submit</button>
            </div>
        </div>
    `;
    document.body.appendChild(el);
    return el;
}

export function openAddRuleModal(sessionId, options = {}) {
    const el = createBaseModalElement('scheduled-input-add-rule-modal', 'Add Scheduled Input Rule');
    const body = el.querySelector('.modal-body');
    body.innerHTML = `
        <form novalidate>
            <div class="form-group">
                <label for="si-input-text">Input Text</label>
                <textarea id="si-input-text" name="data" class="form-input" rows="4" placeholder="Text to send" required></textarea>
                <small class="form-help">Use Shift+Enter for newlines.</small>
            </div>
            <div class="form-group">
                <label for="si-type">Type</label>
                <select id="si-type" name="type">
                    <option value="offset">Offset</option>
                    <option value="interval">Interval</option>
                </select>
            </div>
                <div class="form-group" id="si-offset-group">
                    <label for="si-offset-s">Offset (s)</label>
                    <input type="number" id="si-offset-s" name="offset_s" class="form-input" min="0" value="60">
                </div>
                <div class="form-group" id="si-interval-group" style="display:none;">
                    <label for="si-interval-s">Interval (s)</label>
                    <input type="number" id="si-interval-s" name="interval_s" class="form-input" min="1" value="60">
                    <div class="form-group" id="si-stop-after-group">
                        <label for="si-stop-after">Stop After (turns)</label>
                        <input type="number" id="si-stop-after" name="stop_after" class="form-input" min="1" step="1" placeholder="e.g., 10">
                        <small class="form-help">Optional (interval only): number of sends before stopping.</small>
                    </div>
                </div>
            <div class="form-group">
                <div class="checkbox-wrapper">
                    <input type="checkbox" id="si-submit" name="submit" checked>
                    <label for="si-submit">Submit (send Enter)</label>
                </div>
            </div>
            <div class="form-group" id="si-enter-style-group">
                <label for="si-enter-style">Enter Style</label>
                <select id="si-enter-style" name="enter_style">
                    <option value="cr">CR (\r)</option>
                    <option value="lf">LF (\n)</option>
                    <option value="crlf">CRLF (\r\n)</option>
                </select>
            </div>
                <div class="form-group">
                    <div class="checkbox-wrapper">
                        <input type="checkbox" id="si-raw" name="raw">
                        <label for="si-raw">Raw (no submit/processing)</label>
                    </div>
                </div>
                <div class="form-group">
                    <label for="si-activity-policy">Activity policy</label>
                    <select id="si-activity-policy" name="activity_policy">
                        <option value="immediate">Immediate (always inject on schedule)</option>
                        <option value="suppress">Suppress when active</option>
                        <option value="defer">Defer while active, deliver on inactivity</option>
                    </select>
                    <small class="form-help">Controls behavior when the session is actively producing output.</small>
                </div>
                <div class="form-group">
                    <div class="checkbox-wrapper">
                        <input type="checkbox" id="si-simulate-typing" name="simulate_typing">
                        <label for="si-simulate-typing">Simulate typing</label>
                    </div>
            </div>
            <div class="form-group" id="si-typing-delay-group" style="display:none;">
                <label for="si-typing-delay-ms">Per-char delay (ms)</label>
                <input type="number" id="si-typing-delay-ms" name="typing_delay_ms" class="form-input" min="0" value="0">
            </div>
            <div class="form-group">
                <div class="checkbox-wrapper">
                    <input type="checkbox" id="si-notify" name="notify" checked>
                    <label for="si-notify">Show notification toast on delivery</label>
                </div>
            </div>
        </form>
    `;

    const modal = new FormModal({ element: el, onSubmit: async (data) => {
        try {
            const type = String(data.type || 'offset');
            const payload = {
                type,
                data: data.data || '',
                submit: data.submit === true,
                enter_style: (data.enter_style || 'cr'),
                raw: data.raw === true,
                activity_policy: (() => {
                    const rawPolicy = String(data.activity_policy || 'immediate').toLowerCase();
                    if (rawPolicy === 'suppress' || rawPolicy === 'defer') return rawPolicy;
                    return 'immediate';
                })(),
                simulate_typing: data.simulate_typing === true,
                typing_delay_ms: Number(data.typing_delay_ms) || 0,
                notify: data.notify !== false
            };
            // Convert seconds from UI to milliseconds for backend
            if (type === 'offset') {
                const sec = Number(data.offset_s);
                payload.offset_ms = Math.max(0, Number.isFinite(sec) ? Math.floor(sec * 1000) : 0);
            }
            if (type === 'interval') {
                const sec = Number(data.interval_s);
                payload.interval_ms = Math.max(0, Number.isFinite(sec) ? Math.floor(sec * 1000) : 0);
                const sa = Math.floor(Number(data.stop_after));
                if (Number.isFinite(sa) && sa > 0) payload.stop_after = sa;
            }

            modal.setLoadingState(true, 'Creating...');
            await apiService.createScheduledInputRule(sessionId, payload);
            modal.hide();
        } catch (e) {
            console.warn('[ScheduledInput] create rule failed:', e);
            modal.setLoadingState(false);
            notificationDisplay?.show?.({ notification_type: 'error', title: 'Create Failed', message: e?.message || 'Failed to add rule.', timestamp: new Date().toISOString() }, { duration: 6000 });
        }
    }});

    // Wire dynamic visibility
    const typeSel = el.querySelector('#si-type');
    const rawCb = el.querySelector('#si-raw');
    const simCb = el.querySelector('#si-simulate-typing');
    const offsetGroup = el.querySelector('#si-offset-group');
    const intervalGroup = el.querySelector('#si-interval-group');
    const enterGroup = el.querySelector('#si-enter-style-group');
    const submitCb = el.querySelector('#si-submit');
    const typingDelayGroup = el.querySelector('#si-typing-delay-group');
    const stopAfterInput = el.querySelector('#si-stop-after');
    const refreshVisibility = () => {
        const t = String(typeSel.value || 'offset');
        offsetGroup.style.display = (t === 'offset') ? '' : 'none';
        intervalGroup.style.display = (t === 'interval') ? '' : 'none';
        const raw = !!rawCb.checked;
        submitCb.disabled = raw;
        enterGroup.style.display = raw ? 'none' : '';
        typingDelayGroup.style.display = simCb.checked ? '' : 'none';
        if (stopAfterInput) stopAfterInput.disabled = (t !== 'interval');
    };
    // Build Advanced section (collapsed by default) and move advanced fields into it
    try {
        const toggleWrapper = document.createElement('div');
        toggleWrapper.className = 'form-group';
        toggleWrapper.innerHTML = '<button type="button" class="btn btn-secondary btn-sm" id="si-advanced-toggle" aria-controls="si-advanced-section" aria-expanded="false">Advanced ▸</button>';
        // Insert toggle after the interval group (both schedule params live above Advanced)
        if (intervalGroup && intervalGroup.parentNode) {
            intervalGroup.parentNode.insertBefore(toggleWrapper, intervalGroup.nextSibling);
        } else if (offsetGroup && offsetGroup.parentNode) {
            offsetGroup.parentNode.insertBefore(toggleWrapper, offsetGroup.nextSibling);
        } else if (body) {
            body.appendChild(toggleWrapper);
        }

        const advSection = document.createElement('div');
        advSection.id = 'si-advanced-section';
        advSection.setAttribute('hidden', '');
        if (toggleWrapper && toggleWrapper.parentNode) {
            toggleWrapper.parentNode.insertBefore(advSection, toggleWrapper.nextSibling);
        }

        const moveGroupByInput = (selector) => {
            const input = el.querySelector(selector);
            const group = input ? input.closest('.form-group') : null;
            if (group && advSection) advSection.appendChild(group);
        };
        // Move known advanced groups
        moveGroupByInput('#si-submit');
        const enterGroup = el.querySelector('#si-enter-style-group');
        if (enterGroup && advSection) advSection.appendChild(enterGroup);
        moveGroupByInput('#si-raw');
        moveGroupByInput('#si-simulate-typing');
        const typingDelayGroup = el.querySelector('#si-typing-delay-group');
        if (typingDelayGroup && advSection) advSection.appendChild(typingDelayGroup);
        moveGroupByInput('#si-notify');

        // Toggle behavior
        const advToggle = el.querySelector('#si-advanced-toggle');
        if (advToggle) {
            advToggle.addEventListener('click', () => {
                const expanded = advToggle.getAttribute('aria-expanded') === 'true';
                const nextExpanded = !expanded;
                advToggle.setAttribute('aria-expanded', String(nextExpanded));
                try { advToggle.textContent = nextExpanded ? 'Advanced ▾' : 'Advanced ▸'; } catch (_) {}
                if (nextExpanded) advSection.removeAttribute('hidden'); else advSection.setAttribute('hidden', '');
            });
        }
    } catch (e) {
        console.warn('[ScheduledInput] Advanced section setup failed:', e);
    }

    typeSel.addEventListener('change', refreshVisibility);
    rawCb.addEventListener('change', refreshVisibility);
    simCb.addEventListener('change', refreshVisibility);
    refreshVisibility();

    modal.show();
    return modal;
}

export function openListRulesModal(sessionId) {
    const el = createBaseModalElement('scheduled-input-list-rules-modal', 'Scheduled Input Rules');
    // Width is adjusted dynamically depending on whether rules exist
    // Replace submit button with Refresh
    const submitBtn = el.querySelector('[data-modal-submit]');
    if (submitBtn) { submitBtn.textContent = 'Refresh'; }
    // Insert an Add Rule button in footer
    try {
        const footer = el.querySelector('.modal-footer');
        if (footer) {
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'btn btn-secondary';
            addBtn.id = 'si-add-rule-btn';
            addBtn.textContent = 'Add Rule…';
            footer.insertBefore(addBtn, submitBtn || null);
            addBtn.addEventListener('click', () => {
                try {
                    const addModal = openAddRuleModal(sessionId);
                    addModal?.on?.('hide', () => { try { fetchAndRender(); } catch (_) {} });
                } catch (_) {}
            });
        }
    } catch (_) {}
    const body = el.querySelector('.modal-body');

    const renderEmpty = () => {
        body.innerHTML = '<p style="color: var(--text-secondary);">No rules configured for this session.</p>';
        try {
            el.classList.remove('modal--wide');
            el.classList.add('modal--narrow');
        } catch (_) {}
    };

    const renderLoading = () => {
        body.innerHTML = '<p>Loading…</p>';
    };

    const fetchAndRender = async () => {
        renderLoading();
        try {
            const resp = await apiService.getScheduledInputRules(sessionId);
            const rules = Array.isArray(resp) ? resp : (resp?.rules || []);
            if (!rules.length) { renderEmpty(); return; }
            // Ensure wide layout when rules are present
            try {
                el.classList.remove('modal--narrow');
                el.classList.add('modal--wide');
            } catch (_) {}

            const formatInterval = (ms) => {
                const n = Number(ms);
                if (!Number.isFinite(n) || n < 0) return '-';
                const units = [
                    { name: 'day', ms: 86400000 },
                    { name: 'hour', ms: 3600000 },
                    { name: 'minute', ms: 60000 },
                    { name: 'second', ms: 1000 },
                ];
                for (const u of units) {
                    if (n >= u.ms && n % u.ms === 0) {
                        const v = Math.floor(n / u.ms);
                        return `${v} ${u.name}${v === 1 ? '' : 's'}`;
                    }
                }
                if (n < 1000) return `${n} ms`;
                // Default to seconds with one decimal if not an exact multiple
                const secs = n / 1000;
                const rounded = Math.round(secs * 10) / 10;
                return `${rounded} seconds`;
            };
            body.innerHTML = `
                <table class="settings-table si-rules-table">
                    <thead>
                        <tr>
                            <th>Interval</th>
                            <th>Preview</th>
                            <th>Activity Policy</th>
                            <th>Next Run</th>
                            <th>Paused</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rules.map((r) => {
                            const preview = (r.data_preview || r.data || '').toString();
                            const next = r.next_run_at ? new Date(r.next_run_at).toLocaleString() : '';
                            const intervalDisplay = (r.type === 'interval' && Number.isFinite(Number(r.interval_ms))) ? formatInterval(Number(r.interval_ms)) : '-';
                            const policyRaw = (r.options && typeof r.options.activity_policy === 'string')
                                ? r.options.activity_policy
                                : 'immediate';
                            const policy = (() => {
                                const v = String(policyRaw).toLowerCase();
                                if (v === 'suppress') return 'Suppress';
                                if (v === 'defer') return 'Defer';
                                return 'Immediate';
                            })();
                            // Build action buttons with icons
                            const pauseAction = r.paused ? 'resume' : 'pause';
                            const pauseTitle = r.paused ? 'Resume' : 'Pause';
                            const pauseIconName = r.paused ? 'play' : 'pause';
                            const pauseBtn = (() => {
                                const btn = document.createElement('button');
                                btn.className = 'btn btn-icon si-rule-toggle';
                                btn.setAttribute('data-action', pauseAction);
                                btn.setAttribute('aria-label', pauseTitle);
                                btn.appendChild(iconUtils.createIcon(pauseIconName, { size: 18 }));
                                return btn.outerHTML;
                            })();

                            const triggerBtn = (() => {
                                const btn = document.createElement('button');
                                btn.className = 'btn btn-icon si-rule-trigger';
                                btn.setAttribute('aria-label', 'Trigger Now');
                                btn.appendChild(iconUtils.createIcon('arrow-clockwise', { size: 18 }));
                                return btn.outerHTML;
                            })();

                            const removeBtn = (() => {
                                const btn = document.createElement('button');
                                btn.className = 'btn btn-icon btn-danger si-rule-remove';
                                btn.setAttribute('aria-label', 'Remove');
                                btn.appendChild(iconUtils.createIcon('trash-2', { size: 18 }));
                                return btn.outerHTML;
                            })();

                            return `
                            <tr data-rule-id="${String(r.id)}">
                                <td>${intervalDisplay}</td>
                                <td class=\"si-preview-cell\">${preview}</td>
                                <td>${policy}</td>
                                <td>${next}</td>
                                <td>${r.paused ? 'Yes' : 'No'}</td>
                                <td class=\"si-actions\">${pauseBtn}${triggerBtn}${removeBtn}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            `;
            // Wire actions
            body.querySelectorAll('.si-rule-toggle').forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    const targetBtn = e.currentTarget || e.target.closest('.si-rule-toggle');
                    const tr = targetBtn?.closest('tr');
                    const id = tr?.getAttribute('data-rule-id');
                    const isResume = (targetBtn?.getAttribute('data-action') === 'resume');
                    try {
                        targetBtn.disabled = true;
                        if (isResume) await apiService.resumeScheduledInputRule(sessionId, id);
                        else await apiService.pauseScheduledInputRule(sessionId, id);
                        await fetchAndRender();
                    } catch (err) {
                        notificationDisplay?.show?.({ notification_type: 'error', title: 'Update Failed', message: err?.message || 'Failed to update rule.', timestamp: new Date().toISOString() }, { duration: 5000 });
                    } finally { targetBtn.disabled = false; }
                });
            });
            body.querySelectorAll('.si-rule-trigger').forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    const tr = e.target.closest('tr');
                    const id = tr?.getAttribute('data-rule-id');
                    try {
                        e.target.disabled = true;
                        await apiService.triggerScheduledInputRule(sessionId, id);
                    } catch (err) {
                        notificationDisplay?.show?.({ notification_type: 'error', title: 'Trigger Failed', message: err?.message || 'Failed to trigger rule.', timestamp: new Date().toISOString() }, { duration: 5000 });
                    } finally { e.target.disabled = false; }
                });
            });
            body.querySelectorAll('.si-rule-remove').forEach((btn) => {
                btn.addEventListener('click', async (e) => {
                    const tr = e.target.closest('tr');
                    const id = tr?.getAttribute('data-rule-id');
                    try {
                        e.target.disabled = true;
                        await apiService.removeScheduledInputRule(sessionId, id);
                        await fetchAndRender();
                    } catch (err) {
                        notificationDisplay?.show?.({ notification_type: 'error', title: 'Remove Failed', message: err?.message || 'Failed to remove rule.', timestamp: new Date().toISOString() }, { duration: 5000 });
                    } finally { e.target.disabled = false; }
                });
            });
        } catch (e) {
            console.warn('[ScheduledInput] list rules failed:', e);
            renderEmpty();
            notificationDisplay?.show?.({ notification_type: 'error', title: 'Load Failed', message: e?.message || 'Failed to load rules.', timestamp: new Date().toISOString() }, { duration: 5000 });
        }
    };

    const modal = new Modal({ element: el });
    const refresh = () => fetchAndRender();
    if (submitBtn) submitBtn.addEventListener('click', refresh);
    modal.on('show', refresh);
    modal.show();
    return modal;
}

export function openSendInputNowModal(sessionId) {
    const el = createBaseModalElement('scheduled-input-send-now-modal', 'Send Input');
    const body = el.querySelector('.modal-body');
    body.innerHTML = `
        <form novalidate>
            <div class="form-group">
                <label for="sin-input-text">Input Text</label>
                <textarea id="sin-input-text" name="data" class="form-input" rows="4" placeholder="Text to send" required></textarea>
                <small class="form-help">Use Shift+Enter for newlines.</small>
            </div>
            <div class="form-group">
                <div class="checkbox-wrapper">
                    <input type="checkbox" id="sin-submit" name="submit" checked>
                    <label for="sin-submit">Submit (send Enter)</label>
                </div>
            </div>
            <div class="form-group" id="sin-enter-style-group">
                <label for="sin-enter-style">Enter Style</label>
                <select id="sin-enter-style" name="enter_style">
                    <option value="cr">CR (\r)</option>
                    <option value="lf">LF (\n)</option>
                    <option value="crlf">CRLF (\r\n)</option>
                </select>
            </div>
            <div class="form-group">
                <div class="checkbox-wrapper">
                    <input type="checkbox" id="sin-raw" name="raw">
                    <label for="sin-raw">Raw (no submit/processing)</label>
                </div>
            </div>
            <!-- Activity policy for direct send uses backend default "defer" when omitted.
                 UI does not expose this as a control for now. -->
            <div class="form-group">
                <div class="checkbox-wrapper">
                    <input type="checkbox" id="sin-simulate-typing" name="simulate_typing">
                    <label for="sin-simulate-typing">Simulate typing</label>
                </div>
            </div>
            <div class="form-group" id="sin-typing-delay-group" style="display:none;">
                <label for="sin-typing-delay-ms">Per-char delay (ms)</label>
                <input type="number" id="sin-typing-delay-ms" name="typing_delay_ms" class="form-input" min="0" value="0">
            </div>
            <div class="form-group">
                <div class="checkbox-wrapper">
                    <input type="checkbox" id="sin-notify" name="notify" checked>
                    <label for="sin-notify">Show notification toast on delivery</label>
                </div>
            </div>
        </form>
    `;

    const modal = new FormModal({ element: el, onSubmit: async (data) => {
        try {
            const payload = {
                data: data.data || '',
                submit: data.submit === true,
                enter_style: data.enter_style || 'cr',
                raw: data.raw === true,
                simulate_typing: data.simulate_typing === true,
                typing_delay_ms: Number(data.typing_delay_ms) || 0,
                notify: data.notify !== false
            };
            modal.setLoadingState(true, 'Sending...');
            await apiService.sendInput(sessionId, payload);
            notificationDisplay?.show?.({ notification_type: 'success', title: 'Input Sent', message: 'Input delivered to session.', timestamp: new Date().toISOString() }, { duration: 2500 });
            modal.hide();
        } catch (e) {
            console.warn('[ScheduledInput] send now failed:', e);
            modal.setLoadingState(false);
            notificationDisplay?.show?.({ notification_type: 'error', title: 'Send Failed', message: e?.message || 'Failed to send input.', timestamp: new Date().toISOString() }, { duration: 6000 });
        }
    }});

    // Dynamic visibility
    const rawCb = el.querySelector('#sin-raw');
    const simCb = el.querySelector('#sin-simulate-typing');
    const submitCb = el.querySelector('#sin-submit');
    const enterGroup = el.querySelector('#sin-enter-style-group');
    const typingDelayGroup = el.querySelector('#sin-typing-delay-group');
    const refresh = () => {
        const raw = !!rawCb.checked;
        submitCb.disabled = raw;
        enterGroup.style.display = raw ? 'none' : '';
        typingDelayGroup.style.display = simCb.checked ? '' : 'none';
    };
    rawCb.addEventListener('change', refresh);
    simCb.addEventListener('change', refresh);
    refresh();

    modal.show();
    return modal;
}
