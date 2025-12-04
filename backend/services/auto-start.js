/**
 * Auto-start templates on backend startup
 *
 * When a template config includes `auto_start`, the backend will create a
 * session for it during startup. The `auto_start` field can be either:
 *  - boolean true: run with parameter defaults
 *  - object: { parameters?, title?, workspace?, visibility?, isolation_mode?, username? }
 */

import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config-loader.js';
import { templateLoader } from '../template-loader.js';
import { buildSessionWorkspace } from '../services/session-workspace-builder.js';
import { processText } from '../utils/template-text.js';
import { broadcastSessionUpdate } from '../utils/broadcast.js';
import { createAccessToken as createTunnelToken } from '../utils/session-access-token.js';
import { workspaceManager } from '../managers/workspace-manager.js';
import { isWorkspaceServiceEnabledForSession, computeWorkspaceServicePort } from '../utils/workspace-service-flags.js';

function normalizeRuleForBroadcast(rule) {
  try {
    if (!rule || typeof rule !== 'object') return rule;
    const r = { ...rule };
    if (!('data_preview' in r)) {
      if (typeof r.data === 'string') {
        const s = r.data;
        r.data_preview = s.length > 100 ? (s.slice(0, 100) + '…') : s;
      }
    }
    if ('data' in r) delete r.data;
    return r;
  } catch (_) { return rule; }
}

const WORKSPACE_MACRO_PLACEHOLDER = '<<<WORKSPACE_PLACEHOLDER>>>';

function replaceWorkspacePlaceholder(value, resolvedWorkspaceDir) {
  if (typeof value !== 'string') return value;
  if (!value.includes(WORKSPACE_MACRO_PLACEHOLDER)) return value;
  return resolvedWorkspaceDir
    ? value.split(WORKSPACE_MACRO_PLACEHOLDER).join(resolvedWorkspaceDir)
    : value.split(WORKSPACE_MACRO_PLACEHOLDER).join('');
}

function resolveWithDefaults(tpl, provided) {
  try {
    const out = { ...(provided || {}) };
    const paramsArr = Array.isArray(tpl.parameters) ? tpl.parameters : [];
    for (const p of paramsArr) {
      const name = p && p.name;
      if (!name) continue;
      const hasKey = Object.prototype.hasOwnProperty.call(out, name);
      const rawVal = hasKey ? out[name] : undefined;
      const isBlank = rawVal === undefined || rawVal === null || (typeof rawVal === 'string' && rawVal.trim() === '');
      if (isBlank && Object.prototype.hasOwnProperty.call(p, 'default')) {
        out[name] = String(p.default);
      } else if (hasKey) {
        out[name] = String(rawVal);
      }
    }
    return out;
  } catch (_) {
    return { ...(provided || {}) };
  }
}

export async function runAutoStartTemplates({ logger } = {}) {
  try {
    const all = Array.from(templateLoader.templates.values());
    const list = all.filter(t => t && t.auto_start);
    if (list.length === 0) return;

    for (const tpl of list) {
      try {
        const autoCfg = (typeof tpl.auto_start === 'object' && tpl.auto_start) ? tpl.auto_start : {};
        const paramsProvided = (autoCfg.parameters && typeof autoCfg.parameters === 'object') ? autoCfg.parameters : {};
        const title = typeof autoCfg.title === 'string' ? autoCfg.title : '';
        const workspace = typeof autoCfg.workspace === 'string' ? autoCfg.workspace : '';
        const visibility = ['public','private','shared_readonly'].includes(String(autoCfg.visibility)) ? String(autoCfg.visibility) : 'private';
        const isolationOverrideRaw = typeof autoCfg.isolation_mode === 'string' ? autoCfg.isolation_mode.toLowerCase() : '';
        // Determine allowed modes for this template; omitted => all allowed
        const allowedIsolationModes = (function resolveAllowed(tplObj){
          try {
            const arr = Array.isArray(tplObj?.isolation_modes) ? tplObj.isolation_modes.map(m => String(m).toLowerCase()) : null;
            return (arr && arr.length) ? Array.from(new Set(arr.filter(v => ['none','directory','container'].includes(v)))) : ['none','directory','container'];
          } catch (_) { return ['none','directory','container']; }
        })(tpl);
        const isAllowed = (m) => allowedIsolationModes.includes(String(m || '').toLowerCase());
        // Accept override only if allowed; otherwise ignore per requirements
        const isolationOverride = (['none','directory','container'].includes(isolationOverrideRaw) && isAllowed(isolationOverrideRaw)) ? isolationOverrideRaw : undefined;
        const usernameOverride = typeof autoCfg.username === 'string' && autoCfg.username.trim() ? autoCfg.username.trim() : null;

        // Determine effective template for run (respect optional isolation override)
        const tplForRun = isolationOverride
          ? (templateLoader.getTemplateWithIsolation(tpl.id, isolationOverride) || tpl)
          : tpl;

        const effectiveUsername = usernameOverride || config.DEFAULT_USERNAME;
        const paramValues = resolveWithDefaults(tplForRun, paramsProvided);

        // Generate a session id early for container naming and macro interpolation
        const initialSessionId = uuidv4();

        const workspaceBaseDir = path.isAbsolute(config.SESSIONS_DIR)
          ? config.SESSIONS_DIR
          : path.join(process.cwd(), config.SESSIONS_DIR);
        const sessionWorkspaceHostPath = path.join(workspaceBaseDir, String(initialSessionId), 'workspace');

        const effectiveIsolation = isolationOverride || (tplForRun && tplForRun.isolation) || 'none';
        // Skip auto-start if effective isolation is not allowed (invalid template/default)
        if (!isAllowed(effectiveIsolation)) {
          if (logger) try { logger.warning(`[AutoStart] Skipping '${tpl.id}': effective isolation '${effectiveIsolation}' not allowed (allowed: ${allowedIsolationModes.join(', ')})`); } catch (_) {}
          continue;
        }

        const workspaceServiceEnabledForSession = isWorkspaceServiceEnabledForSession({
          template: tplForRun,
          isolationMode: effectiveIsolation,
          globalConfig: config
        });

        let workspaceServicePort = null;
        try {
          if (workspaceServiceEnabledForSession && (effectiveIsolation === 'container' || effectiveIsolation === 'directory')) {
            workspaceServicePort = computeWorkspaceServicePort(initialSessionId);
          }
        } catch (_) {
          workspaceServicePort = null;
        }

        let sessionUnifiedToken = null;
        try {
          const ttl = Number.isInteger(Number(config.SESSION_TOKEN_TTL_SECONDS)) && config.SESSION_TOKEN_TTL_SECONDS >= 0
            ? Number(config.SESSION_TOKEN_TTL_SECONDS)
            : 0; // default: no expiration (0 = session-lifetime only)
          sessionUnifiedToken = createTunnelToken({ sessionId: initialSessionId, ttlSeconds: ttl });
        } catch (_) { sessionUnifiedToken = null; }

        const sessionWorkspaceVariable = (function resolveWorkspaceVariable() {
          if (effectiveIsolation === 'container') return '/workspace';
          if (effectiveIsolation === 'directory') return sessionWorkspaceHostPath;
          return WORKSPACE_MACRO_PLACEHOLDER;
        })();

        const bootstrapDirVariable = (function resolveBootstrapDir() {
          try {
            if (effectiveIsolation === 'container') return '/workspace/.bootstrap';
            if (effectiveIsolation === 'directory') return path.join(sessionWorkspaceHostPath, '.bootstrap');
            // isolation 'none': use backend-managed bootstrap directory
            return path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bootstrap');
          } catch (_) { return ''; }
        })();

        const firstPassParams = {
          ...(config.TEMPLATE_VARS || {}),
          ...paramValues,
          session_id: initialSessionId,
          session_token: sessionUnifiedToken || '',
          session_title: title || '',
          _login_user: effectiveUsername,
          _default_username: config.DEFAULT_USERNAME,
          session_workspace_dir: sessionWorkspaceVariable,
          bootstrap_dir: bootstrapDirVariable,
          workspace_service_port: workspaceServicePort,
          // Uppercase system macro variants
          SESSION_ID: initialSessionId,
          SESSION_TOK: sessionUnifiedToken || '',
          SESSION_TITLE: title || '',
          SESSION_WORKSPACE_DIR: sessionWorkspaceVariable,
          BOOTSTRAP_DIR: bootstrapDirVariable,
          WORKSPACE_SERVICE_PORT: workspaceServicePort
        };

        // Process template first so that forge-injected variables (FORGE_CLONE_URL, etc.)
        // are added to firstPassParams before buildSessionWorkspace uses them.
        const processedTemplate = tplForRun.processTemplate(firstPassParams);

        // Build per-session workspace when needed (after processTemplate so forge vars are available)
        try {
          if (effectiveIsolation === 'container' || effectiveIsolation === 'directory') {
            await buildSessionWorkspace({ sessionId: initialSessionId, template: tplForRun, variables: firstPassParams });
          }
        } catch (e) {
          if (logger) try { logger.warning(`[AutoStart] Failed to build session workspace for ${initialSessionId}: ${e?.message || e}`); } catch (_) {}
        }

        // Resolve workspace dir for host sessions
        const resolvedWorkspaceDir = (function resolveWorkspaceDir() {
          if (effectiveIsolation === 'container') return '/workspace';
          if (effectiveIsolation === 'directory') return sessionWorkspaceHostPath;
          const wd = processedTemplate?.working_directory;
          if (typeof wd === 'string' && wd.trim()) return wd;
          return '';
        })();

        // Optionally compute session alias from template (URL-safe slug)
        let computedAlias = '';
        try {
          const aliasTpl = typeof tplForRun?.session_alias === 'string' ? tplForRun.session_alias : '';
          if (aliasTpl && aliasTpl.trim()) {
            const raw = processText(aliasTpl, { ...(config?.TEMPLATE_VARS || {}), ...firstPassParams }, { baseDirs: [path.dirname(new URL(import.meta.url).pathname)] });
            const candidate = String(raw || '').trim();
            if (candidate && /^[A-Za-z0-9._-]+$/.test(candidate)) {
              computedAlias = candidate;
            }
          }
        } catch (_) { computedAlias = ''; }

        const sessionOptions = {
          session_id: initialSessionId,
          title,
          visibility,
          created_by: effectiveUsername,
          command: replaceWorkspacePlaceholder(processedTemplate.command, resolvedWorkspaceDir),
          working_directory: replaceWorkspacePlaceholder(processedTemplate.working_directory, resolvedWorkspaceDir),
          interactive: processedTemplate.interactive,
          load_history: processedTemplate.load_history,
          save_session_history: processedTemplate.save_session_history,
          capture_activity_transitions: tplForRun.capture_activity_transitions === true,
          save_workspace_dir: tplForRun.save_workspace_dir === true,
          template_id: tplForRun.id,
          template_name: tplForRun.name,
          template_badge_label: (typeof tplForRun.badge_label === 'string' && tplForRun.badge_label.trim()) ? tplForRun.badge_label.trim() : null,
          isolation_mode: effectiveIsolation,
          workspace_service_enabled_for_session: workspaceServiceEnabledForSession,
          workspace_service_port: workspaceServicePort,
          template_parameters: resolveWithDefaults(tplForRun, paramValues),
          // Pass alias to SessionManager so it registers the mapping
          ...(computedAlias ? { session_alias: computedAlias } : {})
        };

        // Directory isolation uses orchestrator runner
        try {
          if (sessionOptions.isolation_mode === 'directory') {
            const wsPath = sessionWorkspaceHostPath;
            sessionOptions.command = `bash -lc 'bash "${wsPath}/.bootstrap/scripts/run.sh"'`;
            sessionOptions.working_directory = wsPath;
          }
        } catch (_) {}

        // Apply workspace defaulting
        if (!workspace) {
          const fromTemplate = typeof tplForRun.default_workspace === 'string' ? tplForRun.default_workspace.trim() : '';
          sessionOptions.workspace = fromTemplate || 'Default';
        } else {
          sessionOptions.workspace = workspace;
        }

        // Create the session
        const session = await global.sessionManager.createSession(sessionOptions);

        // Set up the output broadcaster so terminal output is sent to attached clients
        session.outputBroadcaster = (sessionId, data) => {
          global.sessionManager.broadcastSessionOutput(sessionId, data);
        };

        // Re-process with the real session_id for links, tabs, and previews
        try {
          const vars = {
            ...(config?.TEMPLATE_VARS || {}),
            ...(session?.template_parameters || {}),
            session_id: session.session_id,
            session_title: (typeof session?.title === 'string') ? session.title : '',
            _login_user: effectiveUsername,
            _default_username: config.DEFAULT_USERNAME,
            session_workspace_dir: resolvedWorkspaceDir,
            // Uppercase system macro variants for second-pass processing
            SESSION_ID: session.session_id,
            SESSION_TITLE: (typeof session?.title === 'string') ? session.title : '',
            SESSION_WORKSPACE_DIR: resolvedWorkspaceDir
          };
          const processedWithId = tplForRun.processTemplate(vars);
          session.command = replaceWorkspacePlaceholder(processedWithId.command, resolvedWorkspaceDir);

          // Human-friendly preview for container pre/main/post
          try {
            const preList = Array.isArray(tplForRun.pre_commands)
              ? tplForRun.pre_commands.map(c => replaceWorkspacePlaceholder(processText(String(c || ''), vars, { baseDirs: [path.dirname(new URL(import.meta.url).pathname)] }), resolvedWorkspaceDir)).filter(Boolean)
              : [];
            const mainCmd = replaceWorkspacePlaceholder(processText(String(tplForRun.command || ''), vars, { baseDirs: [path.dirname(new URL(import.meta.url).pathname)] }), resolvedWorkspaceDir);
            const postList = Array.isArray(tplForRun.post_commands)
              ? tplForRun.post_commands.map(c => replaceWorkspacePlaceholder(processText(String(c || ''), vars, { baseDirs: [path.dirname(new URL(import.meta.url).pathname)] }), resolvedWorkspaceDir)).filter(Boolean)
              : [];
            const previewParts = [];
            if (preList.length) previewParts.push(...preList);
            if (mainCmd) previewParts.push(mainCmd);
            if (postList.length) previewParts.push(...postList);
            session.command_preview = previewParts.join(' && ');
          } catch (_) {}

          // Container association metadata
          try {
            if (sessionOptions.isolation_mode === 'container') {
              session.isolation_mode = 'container';
              session.container_name = `sandbox-${session.session_id}`;
              session.container_runtime = config.CONTAINER_RUNTIME;
            } else {
              session.isolation_mode = sessionOptions.isolation_mode || 'none';
            }
          } catch (_) {}

          // Add links
          try {
            const normalizedLinks = Array.isArray(processedWithId.links)
              ? processedWithId.links.map(link => ({
                  ...link,
                  url: replaceWorkspacePlaceholder(link?.url || '', resolvedWorkspaceDir),
                  name: replaceWorkspacePlaceholder(link?.name || link?.url || '', resolvedWorkspaceDir)
                }))
              : [];
            if (normalizedLinks.length > 0) session.addLinks(normalizedLinks, { allowTemplateFields: true });
          } catch (_) {}

          // Attach processed command tabs (frontend renders as tabs)
          try {
            const tabs = Array.isArray(processedWithId.command_tabs)
              ? processedWithId.command_tabs.map(t => ({
                  ...t,
                  name: replaceWorkspacePlaceholder(t?.name || '', resolvedWorkspaceDir),
                  command: replaceWorkspacePlaceholder(t?.command || '', resolvedWorkspaceDir)
                }))
              : [];
            if (tabs.length > 0) {
              session.command_tabs = tabs;
              if (logger) try { logger.info(`[AutoStart] Added ${tabs.length} command tabs to session ${session.session_id}`); } catch (_) {}
            }
          } catch (_) {}
        } catch (e) {
          if (logger) try { logger.warning(`[AutoStart] Post-create processing failed for ${session.session_id}: ${e?.message || e}`); } catch (_) {}
        }

        // Create scheduled input rules from template (if any)
        try {
          const scheduler = global.inputScheduler;
          const rules = Array.isArray(tplForRun.scheduled_input_rules) ? tplForRun.scheduled_input_rules : [];
          if (scheduler && rules.length > 0) {
            const MAX_SPAN = 7 * 24 * 60 * 60 * 1000; // 7 days
            const clamp = (v, min, max) => {
              const n = Math.floor(Number(v));
              if (!Number.isFinite(n)) return null;
              if (n < min) return min;
              if (n > max) return max;
              return n;
            };
            const mergedVars = {
              ...(config?.TEMPLATE_VARS || {}),
              ...(session?.template_parameters || {}),
              session_id: session.session_id,
              session_title: (typeof session?.title === 'string') ? session.title : '',
              _login_user: effectiveUsername,
              _default_username: config.DEFAULT_USERNAME
            };
            for (const item of rules) {
              try {
                if (!item || typeof item !== 'object') continue;
                const tRaw = String(item.type || '').toLowerCase();
                if (tRaw !== 'offset' && tRaw !== 'interval') continue;
                const type = tRaw;
                const rawData = typeof item.data === 'string' ? item.data : '';
                let data = rawData;
                try {
                  data = processText(String(rawData || ''), mergedVars, { baseDirs: [path.dirname(new URL(import.meta.url).pathname)] });
                } catch (_) { /* ignore */ }
                let offset_ms = undefined;
                let interval_ms = undefined;
                if (type === 'offset') {
                  const v = item.offset_ms ?? (Number(item.offset_s) * 1000);
                  const off = clamp(v, 0, MAX_SPAN);
                  if (off === null) continue;
                  offset_ms = off;
                } else {
                  const v = item.interval_ms ?? (Number(item.interval_s) * 1000);
                  const iv = clamp(v, 1000, MAX_SPAN);
                  if (iv === null) continue;
                  interval_ms = iv;
                }
                const flat = item || {};
                const opts = item.options && typeof item.options === 'object' ? item.options : {};
                const normalizedOptions = {
                  submit: flat.submit !== undefined ? !!flat.submit : (opts.submit === undefined ? true : !!opts.submit),
                  enter_style: (typeof flat.enter_style === 'string' && flat.enter_style) ? String(flat.enter_style) : (typeof opts.enter_style === 'string' ? String(opts.enter_style) : 'cr'),
                  raw: flat.raw !== undefined ? !!flat.raw : !!opts.raw,
                  activity_policy: (() => {
                    const v = (typeof flat.activity_policy === 'string' && flat.activity_policy)
                      ? flat.activity_policy
                      : (typeof opts.activity_policy === 'string' ? opts.activity_policy : 'immediate');
                    const low = String(v).toLowerCase();
                    return (low === 'suppress' || low === 'defer') ? low : 'immediate';
                  })(),
                  simulate_typing: flat.simulate_typing !== undefined ? !!flat.simulate_typing : !!opts.simulate_typing,
                  typing_delay_ms: (() => {
                    const n = Number(flat.typing_delay_ms ?? opts.typing_delay_ms);
                    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
                  })(),
                  notify: flat.notify !== undefined ? !!flat.notify : (opts.notify === undefined ? true : !!opts.notify)
                };
                const stop_after = (type === 'interval' && Number.isFinite(Number(item.stop_after)) && Number(item.stop_after) > 0)
                  ? Math.floor(Number(item.stop_after))
                  : undefined;
                const rule = await scheduler.addRule(session, {
                  type,
                  offset_ms,
                  interval_ms,
                  data,
                  options: normalizedOptions,
                  stop_after,
                  created_by: effectiveUsername
                });
                try {
                  const resp = normalizeRuleForBroadcast(rule);
                  global.connectionManager?.broadcast?.({
                    type: 'scheduled_input_rule_updated',
                    action: 'added',
                    session_id: session.session_id,
                    rule: resp,
                    rule_id: resp?.id || resp?.rule_id,
                    next_run_at: resp?.next_run_at,
                    paused: !!resp?.paused
                  });
                } catch (_) {}
              } catch (e) {
                if (logger) try { logger.warning(`[AutoStart] Failed to add scheduled rule: ${e?.message || e}`); } catch (_) {}
              }
            }
          }
        } catch (e) {
          if (logger) try { logger.warning(`[AutoStart] Scheduled input rules processing failed: ${e?.message || e}`); } catch (_) {}
        }

        // Broadcast creation
        try { broadcastSessionUpdate(session, 'created'); } catch (_) {}

        // Ensure workspace exists for the owner when non-Default
        try {
          const wsName = String(session.workspace || 'Default').trim();
          if (wsName && wsName.toLowerCase() !== 'default') {
            try {
              const created = workspaceManager.addForUser(session.created_by, wsName);
              if (global.connectionManager) {
                global.connectionManager.broadcast({
                  type: 'workspaces_updated',
                  workspaces: workspaceManager.getAllForUser(session.created_by),
                  action: 'created',
                  name: created,
                  user: session.created_by
                });
              }
            } catch (e) {
              // Ignore if already exists
            }
          }
        } catch (_) {}

        if (logger) try { logger.info(`[AutoStart] Started session ${session.session_id} for template '${tplForRun.id}'`); } catch (_) {}
      } catch (e) {
        if (logger) try { logger.warning(`[AutoStart] Failed to auto-start template '${tpl?.id}': ${e?.message || e}`); } catch (_) {}
      }
    }
  } catch (e) {
    // Swallow
  }
}
