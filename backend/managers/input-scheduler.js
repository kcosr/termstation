/**
 * Input Scheduler Manager
 *
 * Schedules per-session input injection rules that fire at an absolute offset
 * from session start or at aligned intervals relative to a session's
 * creation time. Ephemeral in-memory only; rules are cleared when sessions
 * terminate.
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { config } from '../config-loader.js';
import { registerDeferredInput, clearDeferredInputForSession } from '../utils/input-deferral.js';

function normalizeActivityPolicy(value) {
  try {
    const v = typeof value === 'string' ? value.toLowerCase() : '';
    if (v === 'suppress' || v === 'defer') return v;
    return 'immediate';
  } catch (_) {
    return 'immediate';
  }
}

/**
 * RuleState structure
 * {
 *   id,
 *   type: 'offset'|'interval',
 *   offset_ms?,
 *   interval_ms?,
 *   data,
 *   options: { raw, submit, enter_style, simulate_typing, typing_delay_ms, notify },
 *   next_run_at,
 *   paused: boolean,
 *   timer: Timeout|null,
 *   created_by,
 *   created_at
 * }
 */
export class InputScheduler {
  constructor() {
    // Map<sessionId, { startTime: number, rules: Map<ruleId, RuleState> }>
    this.sessionRules = new Map();
  }

  /** Add a rule for a session. Accepts a session object or sessionId string. */
  addRule(sessionOrId, ruleSpec) {
    // Resolve session
    let session = sessionOrId;
    if (typeof sessionOrId === 'string') {
      session = global.sessionManager?.getSession(sessionOrId);
    }
    if (!session || typeof session.session_id !== 'string') {
      throw new Error('addRule: valid session required');
    }
    if (!session.is_active || session.interactive === false) {
      throw new Error('addRule: session must be active and interactive');
    }

    const sessionId = session.session_id;
    const t0 = Date.parse(session.created_at || new Date().toISOString());
    if (!Number.isFinite(t0)) {
      throw new Error('addRule: invalid session.created_at');
    }

    const type = ruleSpec?.type;
    if (type !== 'offset' && type !== 'interval') {
      throw new Error("addRule: type must be 'offset' or 'interval'");
    }

    const now = Date.now();
    const ruleId = ruleSpec?.id || uuidv4();
    const created_by = ruleSpec?.created_by || 'system';
    const created_at = new Date().toISOString();
    const options = {
      raw: !!ruleSpec?.options?.raw,
      submit: ruleSpec?.options?.submit === undefined ? true : !!ruleSpec?.options?.submit,
      enter_style: (typeof ruleSpec?.options?.enter_style === 'string') ? ruleSpec.options.enter_style.toLowerCase() : 'cr',
      simulate_typing: ruleSpec?.options?.simulate_typing === undefined ? !!config.API_STDIN_DEFAULT_SIMULATE_TYPING : !!ruleSpec?.options?.simulate_typing,
      typing_delay_ms: Number.isFinite(Number(ruleSpec?.options?.typing_delay_ms)) && Number(ruleSpec?.options?.typing_delay_ms) >= 0
        ? Math.floor(Number(ruleSpec?.options?.typing_delay_ms))
        : (Number.isFinite(Number(config.API_STDIN_DEFAULT_TYPING_DELAY_MS)) ? Math.floor(Number(config.API_STDIN_DEFAULT_TYPING_DELAY_MS)) : 0),
      notify: !!ruleSpec?.options?.notify,
      activity_policy: normalizeActivityPolicy(ruleSpec?.options?.activity_policy)
    };

    const data = (typeof ruleSpec?.data === 'string') ? ruleSpec.data : '';
    if (type === 'offset') {
      const offset = Math.max(0, Math.floor(Number(ruleSpec?.offset_ms || 0)));
      // Offset rules fire relative to the time the rule is created (not session start)
      const base = now;
      const next_run_at = base + offset;
      const rule = {
        id: ruleId,
        type,
        offset_ms: offset,
        data,
        options,
        next_run_at,
        base_time_ms: base,
        paused: false,
        timer: null,
        created_by,
        created_at
      };
      this._putRule(sessionId, t0, rule);
      this._schedule(sessionId, rule);
      try { logger.info(`[InputScheduler] Added offset rule ${rule.id} for session ${sessionId}; fires at ${new Date(rule.next_run_at).toISOString()}`); } catch (_) {}
      return this._publicRule(rule);
    } else {
      const interval = Math.max(1, Math.floor(Number(ruleSpec?.interval_ms || 0)));
      const stopAfterRaw = ruleSpec?.stop_after;
      const stopAfter = Number.isFinite(Number(stopAfterRaw)) && Number(stopAfterRaw) > 0
        ? Math.floor(Number(stopAfterRaw))
        : null; // null => unlimited
      // Interval rules fire relative to the time the rule is created
      const base = now;
      const next = base + interval;
      const rule = {
        id: ruleId,
        type,
        interval_ms: interval,
        data,
        options,
        next_run_at: next,
        base_time_ms: base,
        stop_after: stopAfter,
        times_fired: 0,
        paused: false,
        timer: null,
        created_by,
        created_at
      };
      this._putRule(sessionId, t0, rule);
      this._schedule(sessionId, rule);
      try { logger.info(`[InputScheduler] Added interval rule ${rule.id} for session ${sessionId}; next at ${new Date(rule.next_run_at).toISOString()} (interval=${interval}ms)`); } catch (_) {}
      return this._publicRule(rule);
    }
  }

  /** List rules for a session (public view). */
  listRules(sessionId) {
    const entry = this.sessionRules.get(sessionId);
    if (!entry) return [];
    return Array.from(entry.rules.values()).map(r => this._publicRule(r));
  }

  /** Remove a rule and cancel its timer. */
  removeRule(sessionId, ruleId) {
    const entry = this.sessionRules.get(sessionId);
    if (!entry) return false;
    const rule = entry.rules.get(ruleId);
    if (!rule) return false;
    try { if (rule.timer) { clearTimeout(rule.timer); rule.timer = null; } } catch (_) {}
    entry.rules.delete(ruleId);
    try { logger.info(`[InputScheduler] Removed rule ${ruleId} for session ${sessionId}`); } catch (_) {}
    return true;
  }

  /** Pause a rule; cancels current timer. */
  pauseRule(sessionId, ruleId) {
    const entry = this.sessionRules.get(sessionId);
    if (!entry) return false;
    const rule = entry.rules.get(ruleId);
    if (!rule) return false;
    try { if (rule.timer) { clearTimeout(rule.timer); rule.timer = null; } } catch (_) {}
    rule.paused = true;
    try { logger.info(`[InputScheduler] Paused rule ${ruleId} for session ${sessionId}`); } catch (_) {}
    return true;
  }

  /** Resume a paused rule; reschedules next occurrence based on alignment. */
  resumeRule(sessionId, ruleId) {
    const entry = this.sessionRules.get(sessionId);
    if (!entry) return false;
    const rule = entry.rules.get(ruleId);
    if (!rule) return false;
    rule.paused = false;
    // Recompute next_run_at
    const now = Date.now();
    if (rule.type === 'interval') {
      const elapsed = now - entry.startTime;
      const k = Math.floor(elapsed / rule.interval_ms) + 1;
      let next = entry.startTime + k * rule.interval_ms;
      if (next <= now) next = entry.startTime + (k + 1) * rule.interval_ms;
      rule.next_run_at = next;
    } else {
      // Offset rule: resume relative to stored base_time_ms; if missing, use now
      const base = Number(rule.base_time_ms) || now;
      const at = base + rule.offset_ms;
      rule.next_run_at = at <= now ? now : at;
    }
    this._schedule(sessionId, rule);
    try { logger.info(`[InputScheduler] Resumed rule ${ruleId} for session ${sessionId}; next at ${new Date(rule.next_run_at).toISOString()}`); } catch (_) {}
    return true;
  }

  /** Clear all rules for a session. */
  clearRules(sessionId) {
    const entry = this.sessionRules.get(sessionId);
    if (!entry) return;
    for (const rule of entry.rules.values()) {
      try { if (rule.timer) { clearTimeout(rule.timer); rule.timer = null; } } catch (_) {}
    }
    entry.rules.clear();
    this.sessionRules.delete(sessionId);
    try { logger.info(`[InputScheduler] Cleared all rules for session ${sessionId}`); } catch (_) {}
  }

  /** Trigger a rule immediately (if present). */
  async triggerNow(sessionId, ruleId) {
    const entry = this.sessionRules.get(sessionId);
    if (!entry) return false;
    const rule = entry.rules.get(ruleId);
    if (!rule) return false;
    await this._fireRule(sessionId, rule);
    return true;
  }

  /** Handle session termination by clearing scheduled rules. */
  onSessionTerminated(sessionId) {
    this.clearRules(sessionId);
    try { clearDeferredInputForSession(sessionId); } catch (_) {}
  }

  // Internal: store rule entry and init container
  _putRule(sessionId, startTime, rule) {
    let entry = this.sessionRules.get(sessionId);
    if (!entry) {
      entry = { startTime, rules: new Map() };
      this.sessionRules.set(sessionId, entry);
    }
    entry.rules.set(rule.id, rule);
  }

  // Internal: schedule rule timer based on its next_run_at
  _schedule(sessionId, rule) {
    try { if (rule.timer) { clearTimeout(rule.timer); rule.timer = null; } } catch (_) {}
    if (rule.paused) return;
    const now = Date.now();
    const delay = Math.max(0, Math.floor(rule.next_run_at - now));
    rule.timer = setTimeout(() => {
      // Fire asynchronously; ignore errors
      this._fireRule(sessionId, rule).catch(() => {});
    }, delay);
  }

  // Internal: sanitize rule for public listing (omit timer handle)
  _publicRule(rule) {
    const { timer, ...rest } = rule;
    return { ...rest };
  }

  // Internal: fire a rule and reschedule if needed
  async _fireRule(sessionId, rule) {
    // Clear timer reference early to avoid duplicate calls
    try { if (rule.timer) { clearTimeout(rule.timer); rule.timer = null; } } catch (_) {}

    // Resolve session
    const session = global.sessionManager?.getSession(sessionId);
    if (!session || !session.is_active || session.interactive === false) {
      // Session no longer active/interactive; remove rule
      this.removeRule(sessionId, rule.id);
      return;
    }

    // Rely on shared session-input util to enforce scheduled input limits when available.

    // Activity policy handling when output is active
    const activityPolicy = normalizeActivityPolicy(rule?.options?.activity_policy);
    try {
      if (session?._outputActive === true) {
        if (activityPolicy === 'suppress') {
          if (rule.type === 'interval') {
            // Skip this tick, reschedule normally to next interval
            const now2 = Date.now();
            const base2 = Number(rule.base_time_ms) || now2;
            const elapsed2 = Math.max(0, now2 - base2);
            const k2 = Math.floor(elapsed2 / rule.interval_ms) + 1;
            let next2 = base2 + k2 * rule.interval_ms;
            if (next2 <= now2) next2 = base2 + (k2 + 1) * rule.interval_ms;
            rule.next_run_at = next2;
            this._schedule(sessionId, rule);
            try { logger.info(`[InputScheduler] Suppressed interval rule ${rule.id} (active output); next at ${new Date(rule.next_run_at).toISOString()}`); } catch (_) {}
            return;
          } else {
            // One-shot rule: drop if suppressed
            this.removeRule(sessionId, rule.id);
            try { logger.info(`[InputScheduler] Suppressed and removed offset rule ${rule.id} (active output)`); } catch (_) {}
            return;
          }
        } else if (activityPolicy === 'defer') {
          try {
            registerDeferredInput(sessionId, {
              key: `rule:${rule.id}`,
              source: 'scheduled',
              data: rule.data,
              options: {
                ...rule.options,
                activity_policy: activityPolicy,
                source: 'scheduled',
                by: 'scheduler',
                rule_id: rule.id
              }
            });
            try { logger.info(`[InputScheduler] Deferred rule ${rule.id} for session ${sessionId} due to active output`); } catch (_) {}
          } catch (_) {}
          // Continue to rescheduling logic below; do not inject now
          // (times_fired and stop_after semantics treat this as a firing)
        }
      }
    } catch (_) {}

    // If not deferred, inject immediately; deferred rules are delivered when the
    // session becomes inactive via the shared deferral manager.
    if (!(session?._outputActive === true && activityPolicy === 'defer')) {
      // Attempt to use shared util when available; otherwise fallback
      let usedShared = false;
      try {
        const mod = await import('../utils/session-input.js');
        if (mod && typeof mod.injectSessionInput === 'function') {
          await mod.injectSessionInput(session, {
            ...rule.options,
            data: rule.data,
            source: 'scheduled',
            rule_id: rule.id,
            by: 'scheduler'
          });
          usedShared = true;
        }
      } catch (_) {
        // ignore; will fallback
      }

      if (!usedShared) {
        await this._fallbackInject(session, rule);
      }
    }

    // Reschedule if interval; remove if offset
    const entry = this.sessionRules.get(sessionId);
    if (!entry) return; // cleared during execution

    if (rule.type === 'interval') {
      // Increment run counter and stop if limit reached
      try { rule.times_fired = (Number.isInteger(rule.times_fired) ? rule.times_fired : 0) + 1; } catch (_) { rule.times_fired = 1; }
      if (Number.isInteger(rule.stop_after) && rule.stop_after > 0 && rule.times_fired >= rule.stop_after) {
        this.removeRule(sessionId, rule.id);
        try { logger.info(`[InputScheduler] Fired and stopped interval rule ${rule.id} for session ${sessionId} after ${rule.times_fired} run(s) (stop_after=${rule.stop_after})`); } catch (_) {}
        return;
      }
      const now = Date.now();
      const base = Number(rule.base_time_ms) || now;
      const elapsed = Math.max(0, now - base);
      const k = Math.floor(elapsed / rule.interval_ms) + 1; // next tick after now
      let next = base + k * rule.interval_ms;
      if (next <= now) next = base + (k + 1) * rule.interval_ms;
      rule.next_run_at = next;
      this._schedule(sessionId, rule);
      try { logger.info(`[InputScheduler] Fired interval rule ${rule.id} for session ${sessionId}; times_fired=${rule.times_fired}; next at ${new Date(rule.next_run_at).toISOString()}`); } catch (_) {}
    } else {
      // one-shot
      this.removeRule(sessionId, rule.id);
      try { logger.info(`[InputScheduler] Fired and removed offset rule ${rule.id} for session ${sessionId}`); } catch (_) {}
    }
  }

  // Internal: minimal injection implementation mirroring HTTP API behavior
  async _fallbackInject(session, rule) {
    const { data, options } = rule;
    const sessionId = session.session_id;
    try { logger.info(`[InputScheduler] inject: session=${sessionId}, rule=${rule.id}, bytes=${typeof data === 'string' ? data.length : 0}, submit=${options.submit}, enter_style=${options.enter_style}, raw=${options.raw}, simulate_typing=${options.simulate_typing}, typing_delay_ms=${options.typing_delay_ms}`); } catch (_) {}

    // Enforce scheduled input per-session limit here as a fallback when not using shared util
    try {
      const maxPer = config.SCHEDULED_INPUT_MAX_MESSAGES_PER_SESSION;
      const current = Number.isInteger(session.scheduled_input_message_count)
        ? session.scheduled_input_message_count
        : 0;
      if (Number.isInteger(maxPer) && maxPer >= 0) {
        if (current >= maxPer) {
          try { logger.warning(`[InputScheduler] scheduled_limit_reached: session=${sessionId}, rule=${rule.id}, current=${current}, max=${maxPer}; removing rule`); } catch (_) {}
          this.removeRule(sessionId, rule.id);
          return;
        }
        session.scheduled_input_message_count = current + 1;
      }
    } catch (e) {
      try { logger.warning(`[InputScheduler] scheduled_limit_check_error: session=${sessionId}, rule=${rule.id}, err=${e?.message || e}`); } catch (_) {}
    }

    // Focus In if configured
    try { if (config.API_STDIN_SEND_FOCUS_IN) session.write("\x1b[I"); } catch (_) {}

    const writeEnter = () => {
      const style = options.enter_style || 'cr';
      if (style === 'crlf') session.write("\r\n");
      else if (style === 'lf') session.write("\n");
      else session.write("\r");
    };

    // Use shared injection utility for consistent behavior (typing, delays, WS emit)
    try {
      const { injectSessionInput } = await import('../utils/session-input.js');
      await injectSessionInput(session, {
        data,
        raw: !!options.raw,
        submit: !!options.submit,
        enter_style: options.enter_style || 'cr',
        activity_policy: 'immediate',
        simulate_typing: !!options.simulate_typing,
        typing_delay_ms: Number.isFinite(Number(options.typing_delay_ms)) ? Number(options.typing_delay_ms) : undefined,
        // Always emit WS; clients decide toast visibility based on preferences
        notify: (options.notify === undefined ? true : !!options.notify),
        by: 'scheduler',
        source: 'scheduled',
        rule_id: rule.id
      });
    } catch (_) {
      // Fallback to legacy synchronous path if import fails
      try { session.write(typeof data === 'string' ? data : ''); } catch (_) {}
      if (!!options.submit && !options.raw) {
        try { await new Promise(r => setTimeout(r, 200)); } catch (_) {}
        try { writeEnter(); } catch (_) {}
      }
    }
  }

  /**
   * Update a rule with a patch. Supports:
   * - paused: boolean (applies pause/resume)
   * - data: string
   * - options: object (raw, submit, enter_style, simulate_typing, typing_delay_ms, notify)
   * - offset_ms (for offset rules): recompute next_run_at
   * - interval_ms (for interval rules): recompute next_run_at
   */
  updateRule(sessionId, ruleId, patch = {}) {
    const entry = this.sessionRules.get(sessionId);
    if (!entry) {
      const err = new Error('Rule not found');
      err.code = 'RULE_NOT_FOUND';
      throw err;
    }
    const rule = entry.rules.get(ruleId);
    if (!rule) {
      const err = new Error('Rule not found');
      err.code = 'RULE_NOT_FOUND';
      throw err;
    }

    // Apply pause/resume first when explicitly provided
    if (patch.paused === true) {
      this.pauseRule(sessionId, ruleId);
    } else if (patch.paused === false) {
      // Defer resume until after recomputing next_run_at
      rule.paused = false;
    }

    // Update data
    if (typeof patch.data === 'string') {
      rule.data = patch.data;
    }

    // Update options (shallow merge with normalization)
    if (patch.options && typeof patch.options === 'object' && !Array.isArray(patch.options)) {
      const o = patch.options;
      if (o.raw !== undefined) rule.options.raw = !!o.raw;
      if (o.submit !== undefined) rule.options.submit = !!o.submit;
      if (typeof o.enter_style === 'string' && o.enter_style.trim()) rule.options.enter_style = o.enter_style.toLowerCase();
      if (o.simulate_typing !== undefined) rule.options.simulate_typing = !!o.simulate_typing;
      if (o.typing_delay_ms !== undefined) {
        const n = Number(o.typing_delay_ms);
        rule.options.typing_delay_ms = (Number.isFinite(n) && n >= 0) ? Math.floor(n) : rule.options.typing_delay_ms;
      }
      if (o.notify !== undefined) rule.options.notify = !!o.notify;
      if (typeof o.activity_policy === 'string') {
        rule.options.activity_policy = normalizeActivityPolicy(o.activity_policy);
      }
    }

    const now = Date.now();
    let rescheduled = false;
    if (rule.type === 'interval' && patch.interval_ms !== undefined) {
      const n = Math.max(1, Math.floor(Number(patch.interval_ms)));
      rule.interval_ms = n;
      // Rebase to now: next fire is interval after update, then every interval from this base
      rule.base_time_ms = now;
      rule.next_run_at = now + n;
      rescheduled = true;
    }
    if (rule.type === 'offset' && patch.offset_ms !== undefined) {
      const off = Math.max(0, Math.floor(Number(patch.offset_ms)));
      rule.offset_ms = off;
      // Changing offset should be relative to the time of change
      rule.base_time_ms = now;
      rule.next_run_at = now + off;
      rescheduled = true;
    }

    // If previously paused and patch.paused===false, or we recomputed schedule and rule isn't paused, schedule now
    if (!rule.paused) {
      if (rescheduled) {
        this._schedule(sessionId, rule);
      } else if (patch.paused === false) {
        // No timing change but resume requested
        this._schedule(sessionId, rule);
      }
    }

    try { logger.info(`[InputScheduler] Updated rule ${rule.id} for session ${sessionId}; paused=${rule.paused}, next=${new Date(rule.next_run_at).toISOString()}`); } catch (_) {}
    return this._publicRule(rule);
  }

  /** Trigger rule wrapper that throws when missing. */
  async triggerRule(sessionId, ruleId) {
    const entry = this.sessionRules.get(sessionId);
    if (!entry || !entry.rules.has(ruleId)) {
      const err = new Error('Rule not found');
      err.code = 'RULE_NOT_FOUND';
      throw err;
    }
    await this.triggerNow(sessionId, ruleId);
    return true;
  }
}
