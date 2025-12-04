/**
 * Input Deferral Manager
 *
 * Shared infrastructure for deferring stdin injections while a session
 * is actively producing output. Supports:
 *   - Scheduled rules with activity_policy: 'defer'
 *   - Direct /input API calls with activity_policy: 'defer'
 *   - Stop inputs injection when sessions become inactive
 *
 * All state is in-memory and scoped to the backend process.
 */

import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { injectSessionInput } from './session-input.js';
import { logger } from './logger.js';
import { config } from '../config-loader.js';
import { templateLoader } from '../template-loader.js';
import { processText } from './template-text.js';
import { broadcastSessionUpdate } from './broadcast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Map<sessionId, { items: Map<pendingId, PendingEntry> }>
const state = new Map();

function getSessionBucket(sessionId, create = false) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  let bucket = state.get(sid);
  if (!bucket && create) {
    bucket = { items: new Map() };
    state.set(sid, bucket);
  }
  return bucket || null;
}

function hashContent(data, options = {}) {
  try {
    const h = crypto.createHash('sha256');
    h.update(typeof data === 'string' ? data : String(data ?? ''));
    const submit = options.submit === undefined ? true : !!options.submit;
    const raw = !!options.raw;
    const enterStyle = typeof options.enter_style === 'string' ? String(options.enter_style).toLowerCase() : 'cr';
    h.update(`|submit=${submit}|raw=${raw}|enter=${enterStyle}`);
    return h.digest('hex');
  } catch (_) {
    return '';
  }
}

function broadcastDeferredUpdate(sessionId, action, payload = {}) {
  try {
    const sid = String(sessionId || '').trim();
    if (!sid || !global.connectionManager) return;
    const count = (() => {
      try {
        const bucket = getSessionBucket(sid, false);
        return bucket && bucket.items ? bucket.items.size : 0;
      } catch (_) {
        return 0;
      }
    })();
    global.connectionManager.broadcast({
      type: 'deferred_input_updated',
      session_id: sid,
      action,
      count,
      ...payload
    });
  } catch (_) {
    // best-effort only
  }
}

/**
 * Register a deferred injection for a session.
 *
 * @param {string} sessionId
 * @param {object} spec
 *   - key {string} logical key (e.g., rule id, 'api-input', 'stop-inputs')
 *   - source {'scheduled'|'api'|'stop-inputs'}
 *   - data {string}
 *   - options {object} injection options (raw, submit, enter_style, simulate_typing, typing_delay_ms, notify, by, rule_id, activity_policy)
 *
 * Dedupe semantics:
 *   - Within a session, for the same key and content hash, keep the first entry
 *     and discard subsequent identical ones.
 */
export function registerDeferredInput(sessionId, spec = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const key = typeof spec.key === 'string' && spec.key ? String(spec.key) : '';
  if (!key) return null;

  const data = typeof spec.data === 'string' ? spec.data : '';
  const options = spec.options && typeof spec.options === 'object' ? { ...spec.options } : {};
  const sourceRaw = typeof spec.source === 'string' ? spec.source.toLowerCase() : '';
  const source = (sourceRaw === 'scheduled' || sourceRaw === 'api' || sourceRaw === 'stop-inputs')
    ? sourceRaw
    : 'api';

  const contentHash = hashContent(data, options);
  const bucket = getSessionBucket(sid, true);

  // Dedupe: keep first entry for (key, hash), discard new duplicates
  for (const existing of bucket.items.values()) {
    if (existing.key === key && existing.contentHash && existing.contentHash === contentHash) {
      try {
        logger.info?.(`[InputDeferral] Skipping duplicate deferred input for session=${sid}, key=${key}`);
      } catch (_) {}
      return null;
    }
  }

  const pendingId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const entry = {
    id: pendingId,
    session_id: sid,
    key,
    source,
    data,
    options,
    contentHash,
    created_at: createdAt
  };
  bucket.items.set(pendingId, entry);

  try {
    logger.info?.(`[InputDeferral] Registered deferred input id=${pendingId} session=${sid} key=${key} source=${source} bytes=${typeof data === 'string' ? data.length : 0}`);
  } catch (_) {}

  broadcastDeferredUpdate(sid, 'added', {
    pending: {
      id: pendingId,
      session_id: sid,
      key,
      source,
      created_at: createdAt,
      bytes: typeof data === 'string' ? data.length : 0,
      data_preview: typeof data === 'string' ? (data.length > 120 ? data.slice(0, 120) + '…' : data) : ''
    }
  });

  return entry;
}

export function listDeferredInput(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return [];
  const bucket = getSessionBucket(sid, false);
  if (!bucket) return [];
  const out = [];
  for (const entry of bucket.items.values()) {
    const data = typeof entry.data === 'string' ? entry.data : '';
    out.push({
      id: entry.id,
      session_id: entry.session_id,
      key: entry.key,
      source: entry.source,
      created_at: entry.created_at,
      bytes: data.length,
      activity_policy: typeof entry.options?.activity_policy === 'string' ? entry.options.activity_policy : 'defer',
      data_preview: data.length > 200 ? data.slice(0, 200) + '…' : data
    });
  }
  // Sort by created_at ascending for stable presentation
  out.sort((a, b) => {
    if (!a.created_at && !b.created_at) return 0;
    if (!a.created_at) return -1;
    if (!b.created_at) return 1;
    return a.created_at.localeCompare(b.created_at);
  });
  return out;
}

export function deleteDeferredInput(sessionId, pendingId) {
  const sid = String(sessionId || '').trim();
  const pid = String(pendingId || '').trim();
  if (!sid || !pid) return false;
  const bucket = getSessionBucket(sid, false);
  if (!bucket || !bucket.items.has(pid)) return false;
  const entry = bucket.items.get(pid);
  bucket.items.delete(pid);
  broadcastDeferredUpdate(sid, 'removed', {
    pending_id: pid,
    key: entry?.key,
    source: entry?.source
  });
  return true;
}

export function clearDeferredInputForSession(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return 0;
  const bucket = getSessionBucket(sid, false);
  if (!bucket) return 0;
  const count = bucket.items.size;
  bucket.items.clear();
  broadcastDeferredUpdate(sid, 'cleared', {});
  return count;
}

/**
 * Called when a session's output transitions to inactive.
 * Delivers any pending deferred injections and, if configured, stop inputs.
 */
export async function onSessionInactive(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  const session = global.sessionManager?.getSession?.(sid);
  if (!session || !session.is_active || session.interactive === false) {
    // Clear any stale deferred items for non-active/non-interactive sessions
    clearDeferredInputForSession(sid);
    return;
  }

  const bucket = getSessionBucket(sid, false);
  let hadDeferred = false;
  if (bucket && bucket.items.size > 0) {
    hadDeferred = true;
    const entries = Array.from(bucket.items.values()).sort((a, b) => {
      if (!a.created_at && !b.created_at) return 0;
      if (!a.created_at) return -1;
      if (!b.created_at) return 1;
      return a.created_at.localeCompare(b.created_at);
    });
    bucket.items.clear();
    broadcastDeferredUpdate(sid, 'cleared', {});

    // Concatenate all deferred inputs with newlines to ensure proper separation
    const lines = [];
    for (const entry of entries) {
      const data = typeof entry.data === 'string' ? entry.data : '';
      if (data) lines.push(data);
    }

    if (lines.length > 0) {
      try {
        const combined = lines.join('\n');
        // Use options from first entry as baseline, but combine all data
        const firstEntry = entries[0];
        const opts = {
          ...firstEntry.options,
          data: combined,
          source: firstEntry.source === 'scheduled' ? 'scheduled' : (firstEntry.source === 'stop-inputs' ? 'stop-inputs' : 'api'),
          // Preserve activity policy metadata but do not re-defer
          activity_policy: typeof firstEntry.options?.activity_policy === 'string' ? firstEntry.options.activity_policy : 'defer'
        };
        await injectSessionInput(session, opts);
      } catch (e) {
        try {
          logger.warning?.(`[InputDeferral] Failed to deliver deferred inputs session=${sid}: ${e?.message || e}`);
        } catch (_) {}
      }
    }
  }

  if (!hadDeferred) {
    await maybeInjectStopInputs(session);
  }
}

async function maybeInjectStopInputs(session) {
  try {
    const sid = session.session_id;
    const enabled = session.stop_inputs_enabled === false ? false : true;
    // Grace period: suppress stop_inputs injection shortly after user input
    try {
      const graceMs = Number.isFinite(Number(config.STOP_INPUTS_GRACE_MS))
        ? Number(config.STOP_INPUTS_GRACE_MS)
        : 2000;
      if (graceMs > 0) {
        const lastUser = Number(session.last_user_input_at || 0);
        if (lastUser > 0) {
          const age = Date.now() - lastUser;
          if (age >= 0 && age < graceMs) {
            try {
              logger.debug?.(`[InputDeferral] Skipping stop inputs for session=${sid} due to recent user input age=${age}ms (< ${graceMs}ms)`);
            } catch (_) {}
            return;
          }
        }
      }
    } catch (_) { /* non-fatal */ }
    // Session start grace period: suppress stop_inputs injection shortly after session creation
    try {
      const sessionStartGraceMs = Number.isFinite(Number(config.STOP_INPUTS_SESSION_START_GRACE_MS))
        ? Number(config.STOP_INPUTS_SESSION_START_GRACE_MS)
        : 15000;
      if (sessionStartGraceMs > 0 && session.created_at) {
        const createdTime = new Date(session.created_at).getTime();
        if (Number.isFinite(createdTime)) {
          const sessionAge = Date.now() - createdTime;
          if (sessionAge >= 0 && sessionAge < sessionStartGraceMs) {
            try {
              logger.info?.(`[InputDeferral] Skipping stop inputs for session=${sid} due to recent session start age=${sessionAge}ms (< ${sessionStartGraceMs}ms)`);
            } catch (_) {}
            return;
          }
        }
      }
    } catch (_) { /* non-fatal */ }
    const inputsRaw = Array.isArray(session.stop_inputs) ? session.stop_inputs : [];
    const armed = inputsRaw.filter(p => p && p.armed !== false && typeof p.prompt === 'string' && p.prompt);
    if (!enabled || armed.length === 0) return;

    // Build merged variables for interpolation
    const mergedVars = {
      ...(config?.TEMPLATE_VARS || {}),
      ...(session?.template_parameters || {}),
      session_id: session.session_id,
      session_title: (typeof session?.title === 'string') ? session.title : '',
      _login_user: session.created_by || config.DEFAULT_USERNAME,
      _default_username: config.DEFAULT_USERNAME
    };
    // Uppercase variants for convenience
    if (!Object.prototype.hasOwnProperty.call(mergedVars, 'SESSION_ID')) mergedVars.SESSION_ID = mergedVars.session_id;
    if (!Object.prototype.hasOwnProperty.call(mergedVars, 'SESSION_TITLE')) mergedVars.SESSION_TITLE = mergedVars.session_title;

    const baseDirs = [path.join(__dirname, '..')];

    const lines = [];
    for (const p of armed) {
      const raw = String(p.prompt || '');
      let text = raw;
      try {
        text = processText(raw, mergedVars, { baseDirs });
      } catch (_) { /* non-fatal */ }
      if (text) lines.push(text);
    }
    if (lines.length === 0) return;

    const combined = lines.join('\n');

    try {
      logger.info?.(`[InputDeferral] Injecting stop inputs for session=${sid}, prompts=${armed.length}`);
    } catch (_) {}

    await injectSessionInput(session, {
      data: combined,
      raw: false,
      submit: true,
      enter_style: 'cr',
      notify: true,
      source: 'stop-inputs',
      by: 'server',
      activity_policy: 'immediate'
    });

    // After successful injection, apply rearm counter semantics:
    // - If rearm_remaining > 0: decrement and keep enabled.
    // - If rearm_remaining === 0: disable stop inputs.
    try {
      const max = Number.isFinite(Number(config.STOP_INPUTS_REARM_MAX)) && Number(config.STOP_INPUTS_REARM_MAX) >= 0
        ? Math.floor(Number(config.STOP_INPUTS_REARM_MAX))
        : 10;
      const rawRearm = Number(session.stop_inputs_rearm_remaining);
      const current = Number.isFinite(rawRearm) && rawRearm >= 0 ? Math.min(Math.floor(rawRearm), max) : 0;
      if (current > 0) {
        session.stop_inputs_rearm_remaining = current - 1;
      } else {
        session.stop_inputs_enabled = false;
        session.stop_inputs_rearm_remaining = 0;
      }
      broadcastSessionUpdate(session, 'updated');
    } catch (_) { /* best-effort */ }
  } catch (e) {
    try {
      logger.warning?.(`[InputDeferral] Failed to inject stop inputs: ${e?.message || e}`);
    } catch (_) {}
  }
}
