/**
 * Shared Session Input Injection Utility
 * Provides a single entry point to inject input into a terminal session
 * with consistent behavior, accounting, and optional WebSocket notification.
 */

import { config } from '../config-loader.js';
import { logger } from './logger.js';

/**
 * Inject input into a session.
 *
 * @param {object} session - TerminalSession instance
 * @param {object} opts - Options for injection
 *   - data {string}
 *   - raw {boolean} default false
 *   - submit {boolean} default true (ignored when raw=true)
 *   - enter_style {'cr'|'lf'|'crlf'} default 'cr'
 *   - delay_ms {number} optional extra delay before second Enter
 *   - simulate_typing {boolean} optional
 *   - typing_delay_ms {number} per-char delay when simulate_typing
 *   - notify {boolean} whether to broadcast WS notification
 *   - by {string} who performed the injection (username/display)
 *   - source {string} origin identifier, e.g., 'api' | 'rule' | 'server'
 *   - rule_id {string|number} optional automation/rule source id
 *
 * @returns {Promise<object>} summary of the injection request
 */
export async function injectSessionInput(session, opts = {}) {
  // Basic validation and session state checks
  if (!session) {
    const err = new Error('Session not found');
    err.status = 404;
    throw err;
  }
  if (!session.is_active) {
    const err = new Error('Session not active');
    err.status = 409;
    throw err;
  }
  if (!session.interactive) {
    const err = new Error('Session is not interactive');
    err.status = 400;
    throw err;
  }

  const data = (typeof opts.data === 'string') ? opts.data : '';
  const raw = opts.raw === true;
  const submit = (opts.submit === undefined) ? true : (opts.submit === true);
  const enterStyle = (typeof opts.enter_style === 'string')
    ? String(opts.enter_style).toLowerCase()
    : 'cr';
  const baseEnterDelayMs = 200; // fixed short delay before first Enter

  // Additional Enter delay determination
  const requestedDelay = Number(opts.delay_ms);
  const requestedDelayGiven = (opts.delay_ms !== undefined && opts.delay_ms !== null && Number.isFinite(requestedDelay) && requestedDelay >= 0);
  const extraEnterDelayMs = requestedDelayGiven
    ? requestedDelay
    : (Number.isFinite(Number(config.API_STDIN_DEFAULT_DELAY_MS)) ? Number(config.API_STDIN_DEFAULT_DELAY_MS) : 1000);

  // Simulate typing selection (support legacy typing_mode for parity)
  let simulateTyping;
  if (opts.simulate_typing === true) simulateTyping = true;
  else if (opts.simulate_typing === false) simulateTyping = false;
  else if (typeof opts.typing_mode === 'string') {
    const mode = String(opts.typing_mode).trim().toLowerCase();
    simulateTyping = (mode === 'char' || mode === 'character' || mode === 'chars');
  } else {
    simulateTyping = !!config.API_STDIN_DEFAULT_SIMULATE_TYPING;
  }

  const hasTypingDelay = (opts.typing_delay_ms !== undefined && opts.typing_delay_ms !== null && Number.isFinite(Number(opts.typing_delay_ms)) && Number(opts.typing_delay_ms) >= 0);
  const typingDelayMs = hasTypingDelay
    ? Math.floor(Number(opts.typing_delay_ms))
    : (Number.isFinite(Number(config.API_STDIN_DEFAULT_TYPING_DELAY_MS)) ? Number(config.API_STDIN_DEFAULT_TYPING_DELAY_MS) : 0);

  const effectiveSubmit = raw ? false : submit;
  const debugStdin = !!config.DEBUG_WS_STDIN;
  const source = (typeof opts.source === 'string' && opts.source) ? String(opts.source) : 'api';
  const who = (typeof opts.by === 'string' && opts.by) ? String(opts.by) : 'server';

  // Activity policy handling (immediate | suppress | defer)
  const activityPolicyRaw = typeof opts.activity_policy === 'string' ? opts.activity_policy.toLowerCase() : '';
  const activityPolicy = (activityPolicyRaw === 'suppress' || activityPolicyRaw === 'defer')
    ? activityPolicyRaw
    : 'immediate';

  // Suppress when session is currently producing output (active burst) for 'suppress'
  try {
    if (activityPolicy === 'suppress') {
      const outputActive = !!session._outputActive;
      if (outputActive) {
        if (debugStdin) logger.info(`[${source === 'api' ? 'API STDIN' : source}] suppressed due to active output: session=${session.session_id}`);
        return { ok: true, suppressed: true, reason: 'active', activity_policy: activityPolicy };
      }
    }
  } catch (_) { /* ignore */ }

  // Per-session message accounting
  try {
    const scope = source === 'api' ? 'API STDIN' : (source === 'scheduled' ? 'SCHEDULED STDIN' : 'STDIN INJECT');
    if (source === 'api') {
      const maxPerSession = config.API_STDIN_MAX_MESSAGES_PER_SESSION;
      const currentCount = Number.isInteger(session.api_stdin_message_count)
        ? session.api_stdin_message_count
        : 0;
      logger.info(`[${scope}] limit_check: session=${session.session_id}, by=${who}, current=${currentCount}, max=${maxPerSession === null ? 'unlimited' : maxPerSession}`);
      if (Number.isInteger(maxPerSession) && maxPerSession >= 0) {
        if (currentCount >= maxPerSession) {
          logger.warning(`[${scope}] limit_reached: session=${session.session_id}, by=${who}, current=${currentCount}, max=${maxPerSession}`);
          const err = new Error('Input limit reached');
          err.status = 429;
          err.details = `Session has reached the maximum number of input messages (${maxPerSession}) via the API`;
          throw err;
        }
        session.api_stdin_message_count = currentCount + 1;
        logger.info(`[${scope}] limit_accept: session=${session.session_id}, by=${who}, new_count=${session.api_stdin_message_count}, max=${maxPerSession}`);
      }
    } else if (source === 'scheduled') {
      const maxPerSession = config.SCHEDULED_INPUT_MAX_MESSAGES_PER_SESSION;
      const currentCount = Number.isInteger(session.scheduled_input_message_count)
        ? session.scheduled_input_message_count
        : 0;
      logger.info(`[${scope}] limit_check: session=${session.session_id}, by=${who}, current=${currentCount}, max=${maxPerSession === null ? 'unlimited' : maxPerSession}`);
      if (Number.isInteger(maxPerSession) && maxPerSession >= 0) {
        if (currentCount >= maxPerSession) {
          logger.warning(`[${scope}] limit_reached: session=${session.session_id}, by=${who}, current=${currentCount}, max=${maxPerSession}`);
          const err = new Error('Scheduled input limit reached');
          err.status = 429;
          err.details = `Session has reached the maximum number of scheduled input messages (${maxPerSession})`;
          throw err;
        }
        session.scheduled_input_message_count = currentCount + 1;
        logger.info(`[${scope}] limit_accept: session=${session.session_id}, by=${who}, new_count=${session.scheduled_input_message_count}, max=${maxPerSession}`);
      }
    } else {
      // For other sources, do not enforce a per-session message limit here
      logger.info(`[${scope}] no limit enforcement for source='${source}'`);
    }
  } catch (e) {
    if (!e || e.status === undefined) {
      logger.warning(`[STDIN INJECT] limit_check_error: session=${session.session_id}, err=${e?.message || e}`);
    } else {
      throw e;
    }
  }

  const writeEnter = () => {
    let seq = '\r';
    if (enterStyle === 'lf') seq = '\n';
    else if (enterStyle === 'crlf') seq = '\r\n';
    session.write(seq);
  };

  if (debugStdin) {
    try {
      const preview = typeof data === 'string' ? (data.length > 200 ? data.slice(0, 200) + '…' : data) : '';
      const scope = source === 'api' ? 'API STDIN' : 'STDIN INJECT';
      logger.info(`[${scope}] inject request: session=${session.session_id}, by=${who}, bytes=${typeof data === 'string' ? data.length : 0}, submit=${effectiveSubmit}, enter_style=${enterStyle}, raw=${raw}, simulate_typing=${simulateTyping}, base_delay_ms=${baseEnterDelayMs}, extra_enter_delay_ms=${extraEnterDelayMs}, typing_delay_ms=${typingDelayMs}, preview=${JSON.stringify(preview)}`);
    } catch (_) {}
  }

  // Do not persist input markers server-side. Clients capture a render marker with
  // precise line information and POST it via /api/sessions/:id/markers.
  // We only emit a WS event so clients can time-stamp and record locally.

  const run = async () => {
    try {
      // Optional: send Focus In before data to emulate terminal focus
      if (config.API_STDIN_SEND_FOCUS_IN) {
        if (debugStdin) logger.debug(`[STDIN INJECT] sending Focus In: session=${session.session_id}`);
        session.write("\x1b[I");
      }
      if (raw) {
        if (debugStdin) logger.debug(`[STDIN INJECT] raw write: session=${session.session_id}, bytes=${typeof data === 'string' ? data.length : 0}`);
        session.write(data);
      } else if (simulateTyping && data) {
        if (debugStdin) logger.debug(`[STDIN INJECT] simulate_typing start: session=${session.session_id}, chars=${data.length}`);
        for (const ch of data) {
          session.write(ch);
          if (typingDelayMs > 0) await new Promise((r) => setTimeout(r, typingDelayMs));
        }
        if (debugStdin) logger.debug(`[STDIN INJECT] simulate_typing done: session=${session.session_id}`);
      } else {
        if (data) session.write(data);
      }
      if (effectiveSubmit) {
        // Always wait a short, fixed time before the first Enter to ensure separate frame/write
        // Always wait a short, fixed time before the first Enter to ensure separate frame/write
        const firstDelay = Math.max(0, baseEnterDelayMs);
        if (firstDelay > 0) {
          await new Promise((r) => setTimeout(r, firstDelay));
        }
        if (debugStdin) logger.debug(`[STDIN INJECT] sending Enter (first): session=${session.session_id}, style=${enterStyle}`);
        writeEnter();
        // Optionally send a second Enter after the configured/requested delay
        const extraDelay = Math.max(0, extraEnterDelayMs);
        if (extraDelay > 0) {
          if (debugStdin) logger.debug(`[STDIN INJECT] scheduling additional Enter in ${extraDelay}ms: session=${session.session_id}, style=${enterStyle}`);
          setTimeout(() => {
            try {
              if (debugStdin) logger.debug(`[STDIN INJECT] sending Enter (additional): session=${session.session_id}, style=${enterStyle}`);
              writeEnter();
            } catch (_) {}
          }, extraDelay);
        }
      }
      // Optional: send Focus Out after data/submit
      if (config.API_STDIN_SEND_FOCUS_OUT) {
        if (debugStdin) logger.debug(`[STDIN INJECT] sending Focus Out: session=${session.session_id}`);
        session.write("\x1b[O");
      }
      if (debugStdin) logger.info(`[STDIN INJECT] inject completed: session=${session.session_id}, by=${who}`);
    } catch (_) {
      // best-effort delivery
    }
  };
  // Run asynchronously to avoid coupling to caller lifecycle
  try { setTimeout(run, 0); } catch (_) { Promise.resolve().then(run); }

  // Always broadcast stdin_injected so clients can register local markers,
  // regardless of the notify flag. UI toast visibility remains a client concern.
  {
    try {
      const bytes = typeof data === 'string' ? data.length : 0;
      const payload = {
        type: 'stdin_injected',
        session_id: session.session_id,
        by: who,
        bytes,
        submit: effectiveSubmit,
        enter_style: enterStyle,
        raw,
        // Surface original notify intent for clients that wish to gate toasts locally
        notify: (opts.notify === undefined ? true : !!opts.notify),
        source: source,
        rule_id: (opts.rule_id === undefined || opts.rule_id === null) ? null : opts.rule_id,
        activity_policy: activityPolicy
      };
      const attached = Array.from(session.connected_clients || []);
      // Send to attached clients for this session (watchers + owner if attached)
      for (const clientId of attached) {
        try { global.connectionManager.sendToClient(clientId, payload); } catch (_) {}
      }
      // If no clients are attached, also broadcast to the session owner across their other windows
      if (attached.length === 0 && session.created_by && global.connectionManager) {
        try { global.connectionManager.broadcast({ ...payload, user: String(session.created_by) }); } catch (_) {}
      }
    } catch (_) {}
  }

  // Record last user input timestamp for gating stop_inputs injection.
  try {
    const now = Date.now();
    const isUser =
      who !== 'server' &&
      source !== 'stop-inputs' &&
      source !== 'scheduled';
    if (isUser) {
      session.last_user_input_at = now;
    }
  } catch (_) { /* best-effort only */ }

  return {
    ok: true,
    bytes: (typeof data === 'string' ? data.length : 0),
    submit: effectiveSubmit,
    enter_style: enterStyle,
    raw,
    simulate_typing: simulateTyping,
    typing_delay_ms: typingDelayMs
  };
}
