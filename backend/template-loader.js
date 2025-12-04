/**
 * Template Loader for termstation Node.js Backend
 * Handles loading and processing of command templates from configuration
 */

import { readFileSync, statSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { homedir, userInfo } from 'os';
import { execSync } from 'child_process';
import { workspaceManager } from './managers/workspace-manager.js';
import { config } from './config-loader.js';
import { processText } from './utils/template-text.js';
import { buildRunCommand } from './utils/runtime.js';
import { resolveSystemUsername } from './utils/username-alias.js';
import { templatesConfigCache, usersConfigCache, groupsConfigCache } from './utils/json-config-cache.js';
import { logger } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_IS_DEBUG = String(config?.LOG_LEVEL || '').toUpperCase() === 'DEBUG';
const isWin = process.platform === 'win32';

// Normalize repository input using an optional forge-specific regex pattern.
function normalizeRepo(repoInput, forgeConfig) {
  try {
    const raw = typeof repoInput === 'string' ? repoInput : (repoInput == null ? '' : String(repoInput));
    if (!raw) return '';
    const pattern = forgeConfig && typeof forgeConfig.repo_pattern === 'string'
      ? forgeConfig.repo_pattern
      : '';
    if (pattern) {
      try {
        const re = new RegExp(pattern);
        const m = raw.match(re);
        if (m && m[1]) {
          return String(m[1]);
        }
      } catch (_) {
        // Invalid regex; fall through to raw value.
      }
    }
    return raw;
  } catch (_) {
    return String(repoInput || '');
  }
}


class CommandTemplate {
  constructor(templateData) {
    this.id = templateData.id;
    this.name = templateData.name;
    this.description = templateData.description || '';
    this.command = templateData.command;
    this.working_directory = templateData.working_directory || '~';
    this.interactive = templateData.interactive !== false; // default true
    this.load_history = templateData.load_history !== false; // default true
    this.save_session_history = templateData.save_session_history !== false; // default true
    // Whether backend should capture activity transitions for sessions using this template (default false)
    this.capture_activity_transitions = templateData.capture_activity_transitions === true;
    // Optional stop inputs configured at template level.
    this.stop_inputs = Array.isArray(templateData.stop_inputs) ? templateData.stop_inputs : null;
    // Whether stop inputs are enabled for sessions using this template (default true).
    this.stop_inputs_enabled = templateData.stop_inputs_enabled === false ? false : true;
    // Debug logging on reload: surface stop_inputs count instead of activity transitions
    try {
      if (LOG_IS_DEBUG) {
        const count = Array.isArray(this.stop_inputs) ? this.stop_inputs.length : 0;
        console.log(`[TemplateLoader] Template ${this.id} stop_inputs_count=${count}`);
      }
    } catch (_) {}
    this.group = templateData.group || 'Other';
    this.color = templateData.color || '#007acc';
    this.display = templateData.display !== false; // default true
    // When true or object, backend should auto-start a session on startup
    // Accepts boolean or object with overrides (parameters, title, workspace, visibility, isolation_mode)
    this.auto_start = (templateData.auto_start !== undefined) ? templateData.auto_start : false;
    // When true, this template should be preselected in the new session modal
    this.default = templateData.default === true;
    this.links = templateData.links || [];
    // Optional URL-safe session alias for API addressing
    this.session_alias = typeof templateData.session_alias === 'string' ? templateData.session_alias : '';
    // Optional command tabs: [{ name, command, show_active?, show_inactive?, skip_if_unresolved? }]
    this.command_tabs = Array.isArray(templateData.command_tabs) ? templateData.command_tabs : [];
    this.parameters = templateData.parameters || [];
    // Optional search shortcut token, e.g., "ctr" for quick filtering
    this.shortcut = typeof templateData.shortcut === 'string' ? templateData.shortcut : '';
    // Optional alternate badge label for UI (e.g., show "Codex" while name is verbose)
    this.badge_label = typeof templateData.badge_label === 'string' ? templateData.badge_label : '';
    // Optional per-template forwarding flag for container service proxy
    this.forward_services = templateData.forward_services === true;
    this.workspace_service_enabled = templateData.workspace_service_enabled === true;
    // Optional default workspace for sessions created from this template
    const dw = typeof templateData.default_workspace === 'string' ? templateData.default_workspace.trim() : '';
    this.default_workspace = dw && dw.toLowerCase() !== 'default' ? dw : (dw ? 'Default' : null);
    // Optional user to run the command as (will use sudo -u)
    this.user = templateData.user || null;
    // Isolation mode for execution: 'none' | 'directory' | 'container'
    // Prefer explicit isolation; fallback to legacy sandbox boolean when present.
    this.isolation = (function resolveIsolation(td) {
      const val = td && td.isolation;
      if (val === 'none' || val === 'directory' || val === 'container') return val;
      if (td && td.sandbox === true) return 'container';
      return 'none';
    })(templateData);
    // Optional allowed isolation modes constraint at template level
    this.isolation_modes = (function resolveIsolationModes(td) {
      try {
        const raw = td && td.isolation_modes;
        if (!raw) return null; // omitted => all modes allowed
        const arr = Array.isArray(raw) ? raw : [];
        const norm = Array.from(new Set(arr.map(v => String(v || '').toLowerCase()).filter(v => ['none','directory','container'].includes(v))));
        return norm.length > 0 ? norm : null; // empty => treat as all allowed
      } catch (_) { return null; }
    })(templateData);
    // Legacy sandbox flag (derived) retained for UI/template listings during transition
    this.sandbox = this.isolation === 'container';
    // Container runtime options (used when sandbox === true)
    this.container_image = templateData.container_image || 'rocky-dev';
    this.container_working_dir = templateData.container_working_dir || '/workspace';
    this.container_memory = templateData.container_memory || '4g';
    this.container_cpus = templateData.container_cpus !== undefined ? String(templateData.container_cpus) : '2';
    this.container_network = templateData.container_network || null;
    // Optional Linux capabilities to add to the container (e.g., ["NET_ADMIN"]) when sandboxed
    this.container_cap_add = Array.isArray(templateData.container_cap_add) ? templateData.container_cap_add : null;
    // User inside the container (separate from host sudo user)
    this.container_user = templateData.container_user || null;
    // Optional shared directory to mount into the container (per-session)
    // Controlled solely by:
    // - host_mounts_dir: absolute host path base (or null)
    // - mount_host: boolean flag (default false) to enable mounting
    this.host_mounts_dir = templateData.host_mounts_dir || null;
    this.mount_host = templateData.mount_host === true; // default false
    // Optional environment variable definitions (supports macros and literals)
    this.env_vars = templateData.env_vars || null;
    // Optional inline command hooks (executed inside container before/after main command)
    this.pre_commands = Array.isArray(templateData.pre_commands) ? templateData.pre_commands : null;
    this.post_commands = Array.isArray(templateData.post_commands) ? templateData.post_commands : null;
    // Optional fork-specific command overrides (used when forking from an existing session)
    this.fork_pre_commands = Array.isArray(templateData.fork_pre_commands) ? templateData.fork_pre_commands : null;
    this.fork_post_commands = Array.isArray(templateData.fork_post_commands) ? templateData.fork_post_commands : null;
    this.fork_command = (typeof templateData.fork_command === 'string') ? templateData.fork_command : null;
    // Optional per-template control over mapping backend UID/GID into the container
    // When true, apply -u UID:GID and (for podman) --userns=keep-id --group-add keep-groups
    // When false, do not pass any user mapping flags
    // When undefined, fallback to global config.CONTAINER_MAP_USER (default true)
    if (Object.prototype.hasOwnProperty.call(templateData, 'container_map_user')) {
      this.container_map_user = !!templateData.container_map_user;
    } else {
      this.container_map_user = undefined;
    }
    // Optional file writes to perform before main command (sandbox/container/directory modes)
    // Example: [{ source: "AGENTS.md", target: "${HOME}/.codex/AGENTS.md" }]
    this.write_files = Array.isArray(templateData.write_files) ? templateData.write_files : null;
    // Optional in-place include expansion for files in the workspace/container.
    // Example: ["repo/README.md", "repo/.codex/AGENTS.md"]
    this.expand_file_includes = Array.isArray(templateData.expand_file_includes) ? templateData.expand_file_includes : null;
    // Optional tmpfs mounts inside container: ["/path"] or [{ path: "/path", options: "size=64m" }]
    this.tmpfs_mounts = Array.isArray(templateData.tmpfs_mounts) ? templateData.tmpfs_mounts : null;
    // Optional bind mounts: [{ host_path, container_path, readonly }]
    this.bind_mounts = Array.isArray(templateData.bind_mounts) ? templateData.bind_mounts : null;
    // (bootstrap_logging removed)
    // Optional: persist per-session workspace directory to host on session end/shutdown
    this.save_workspace_dir = templateData.save_workspace_dir === true;
    // Optional scheduled input rules to be applied on session creation
    // Accept either an array `scheduled_input_rules` or an object `scheduled_inputs` with a `rules` array
    const sr = Array.isArray(templateData.scheduled_input_rules)
      ? templateData.scheduled_input_rules
      : (templateData.scheduled_inputs && Array.isArray(templateData.scheduled_inputs.rules)
          ? templateData.scheduled_inputs.rules
          : null);
    this.scheduled_input_rules = Array.isArray(sr) ? sr : null;
  }

  toDict() {
    // Mark parameters with dynamic options when a command is present,
    // or when this is a sandbox template's image selection field.
    let processedParameters = this.parameters.map(param => {
      const processedParam = { ...param };
      if (param.command) {
        processedParam.has_dynamic_options = true;
        // Derive dependencies from placeholders in command if not provided
        try {
          if (!processedParam.depends_on) {
            const detect = (s) => {
              const set = new Set();
              const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g; // identifiers only
              let m;
              while ((m = re.exec(String(s || ''))) !== null) set.add(m[1]);
              return Array.from(set);
            };
            const placeholders = detect(param.command);
            if (placeholders && placeholders.length) {
              processedParam.depends_on = placeholders;
            }
          }
        } catch (_) {}
      }
      // Mark user- and command-sourced selects as having dynamic options.
      try {
        const srcRaw = param && param.options_source;
        const src = (typeof srcRaw === 'string' && srcRaw.trim()) ? srcRaw.trim().toLowerCase() : '';
        if (src === 'user' || src === 'command' || src === 'forges' || src === 'forge') {
          processedParam.has_dynamic_options = true;
        }
      } catch (_) {}
      // Built-in: container_image under sandbox should expose dynamic options
      try {
        const n = String(param?.name || '');
        if (this.sandbox === true && n === 'container_image') {
          processedParam.has_dynamic_options = true;
        }
      } catch (_) {}
      return processedParam;
    });

    // Inject synthetic container_image parameter for container isolation when not defined in config
    try {
      if (this.isolation === 'container') {
        const hasImageParam = processedParameters.some(p => p && p.name === 'container_image');
        if (!hasImageParam) {
          const def = (typeof this.container_image === 'string' && !/{\w+}/.test(this.container_image))
            ? this.container_image
            : 'rocky-dev';
          processedParameters = processedParameters.concat([{
            name: 'container_image',
            label: 'Container Image',
            type: 'string',
            required: true,
            default: def,
            has_dynamic_options: true,
            description: 'Select or enter a container image'
          }]);
        }
      }
    } catch (_) {}

    // No native auto-provisioning of image suggestions; rely on user-defined parameters.
    
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      shortcut: this.shortcut,
      badge_label: this.badge_label,
      command: this.command,
      working_directory: this.working_directory,
      interactive: this.interactive,
      load_history: this.load_history,
      save_session_history: this.save_session_history,
      capture_activity_transitions: this.capture_activity_transitions === true,
      stop_inputs: Array.isArray(this.stop_inputs) ? this.stop_inputs : null,
      stop_inputs_enabled: this.stop_inputs_enabled !== false,
      group: this.group,
      color: this.color,
      display: this.display,
      auto_start: this.auto_start,
      default: this.default,
      default_workspace: this.default_workspace,
      links: this.links,
      session_alias: this.session_alias,
      parameters: processedParameters,
      forward_services: this.forward_services,
      workspace_service_enabled: this.workspace_service_enabled === true,
      user: this.user,
      isolation: this.isolation,
      isolation_modes: Array.isArray(this.isolation_modes) ? [...this.isolation_modes] : null
    };
  }

  // Process template variables in command and other fields
  processTemplate(variables = {}) {
    let processedCommand = this.command;
    let processedWorkingDir = this.working_directory;
    let processedLinks = JSON.parse(JSON.stringify(this.links)); // deep copy

    // $HOME-only: no automatic expansion of '~' here; working_directory is resolved later for host sessions


    // Find all placeholders in the template
    const placeholders = new Set();
    const placeholderRegex = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
    
    // Find placeholders in command
    let match;
    while ((match = placeholderRegex.exec(this.command)) !== null) {
      placeholders.add(match[1]);
    }
    
    // Find placeholders in working directory
    placeholderRegex.lastIndex = 0;
    while ((match = placeholderRegex.exec(this.working_directory)) !== null) {
      placeholders.add(match[1]);
    }
    
    // Find placeholders in links
    for (const link of this.links) {
      placeholderRegex.lastIndex = 0;
      while ((match = placeholderRegex.exec(link.url)) !== null) {
        placeholders.add(match[1]);
      }
      placeholderRegex.lastIndex = 0;
      while ((match = placeholderRegex.exec(link.name)) !== null) {
        placeholders.add(match[1]);
      }
    }

    // Also detect placeholders in optional pre/post commands so missing
    // variables default to empty and do not execute with literal tokens
    if (Array.isArray(this.pre_commands)) {
      for (const line of this.pre_commands) {
        placeholderRegex.lastIndex = 0;
        while ((match = placeholderRegex.exec(String(line))) !== null) {
          placeholders.add(match[1]);
        }
      }
    }
    if (Array.isArray(this.post_commands)) {
      for (const line of this.post_commands) {
        placeholderRegex.lastIndex = 0;
        while ((match = placeholderRegex.exec(String(line))) !== null) {
          placeholders.add(match[1]);
        }
      }
    }

    if (LOG_IS_DEBUG) {
      console.log(`Template ${this.id} placeholders found: ${Array.from(placeholders).join(', ')}`);
      console.log(`Template ${this.id} variables provided: ${Object.keys(variables).join(', ')}`);
    }

    // Check for missing/blank required variables and apply defaults where configured
    const missingVars = [];
    for (const placeholder of placeholders) {
      // Look up parameter definition (if any)
      const param = this.parameters.find(p => p.name === placeholder);

      // Determine if a value was provided, and whether it's effectively blank
      const hasKey = Object.prototype.hasOwnProperty.call(variables, placeholder);
      const provided = hasKey ? variables[placeholder] : undefined;
      const isBlank = provided === undefined || provided === null || (typeof provided === 'string' && provided.trim() === '');

      if (!hasKey || isBlank) {
        // If missing/blank and a default is configured for this parameter, use the default
        const hasExplicitDefault = param && Object.prototype.hasOwnProperty.call(param, 'default');
        if (hasExplicitDefault) {
          variables[placeholder] = param.default;
          console.log(`Template ${this.id}: Using default value for ${placeholder}: "${variables[placeholder]}"`);
          continue;
        }

        // No default configured; enforce required parameters
        if (param && param.required) {
          missingVars.push(placeholder);
        } else {
          // For non-required parameters without defaults, use empty string
          variables[placeholder] = '';
          console.log(`Template ${this.id}: Using default value for ${placeholder}: "${variables[placeholder]}"`);
        }
      }
    }

    if (missingVars.length > 0) {
      throw new Error(`Missing required template parameters: ${missingVars.join(', ')}`);
    }

    // Merge provided variables with config.TEMPLATE_VARS for text processing
    const mergedVars = { ...(config?.TEMPLATE_VARS || {}), ...(variables || {}) };

    // Resolve forge configuration and inject FORGE_* variables when configured.
    try {
      const forges = config && (config.FORGES || {});
      const defaultForge = config && (config.DEFAULT_FORGE || '');
      const forgeNameRaw = variables && typeof variables.forge === 'string' ? variables.forge : '';
      const forgeName = (forgeNameRaw && forgeNameRaw.trim()) || defaultForge || '';
      const forgeConfig = forgeName ? forges[forgeName] : null;
      if (forgeConfig && typeof forgeConfig === 'object') {
        const normalizedRepo = normalizeRepo(variables.repo, forgeConfig);
        variables.repo = normalizedRepo;
        mergedVars.repo = normalizedRepo;

        const protoRaw = (variables && typeof variables.clone_protocol === 'string')
          ? variables.clone_protocol.trim().toLowerCase()
          : '';
        const defaultProtoRaw = typeof forgeConfig.default_protocol === 'string'
          ? forgeConfig.default_protocol.trim().toLowerCase()
          : '';
        const effectiveProtocol = protoRaw === 'ssh' || protoRaw === 'https'
          ? protoRaw
          : (defaultProtoRaw === 'ssh' ? 'ssh' : 'https');
        const cloneUrlTemplate = effectiveProtocol === 'ssh'
          ? forgeConfig.ssh_url
          : forgeConfig.https_url;
        const repoToken = normalizedRepo || '';
        const forgeCloneUrl = (cloneUrlTemplate && repoToken)
          ? String(cloneUrlTemplate).replace('{repo}', repoToken)
          : '';

        // Inject into both variables (for container pre_commands) and mergedVars (for host processing).
        variables.FORGE = forgeName;
        variables.FORGE_TYPE = forgeConfig.type || '';
        variables.FORGE_HOST = forgeConfig.host || '';
        variables.FORGE_CLONE_URL = forgeCloneUrl;
        const repoUrlTmpl = forgeConfig.repo_url || '';
        const repoUrl = repoUrlTmpl && repoToken
          ? String(repoUrlTmpl).replace('{repo}', repoToken)
          : '';
        variables.FORGE_REPO_URL = repoUrl;
        const issueUrlTmpl = forgeConfig.issue_url || '';
        const issueId = (variables && typeof variables.issue_id === 'string')
          ? variables.issue_id.trim()
          : '';
        const issueUrl = (issueUrlTmpl && repoToken && issueId)
          ? String(issueUrlTmpl)
              .replace('{repo}', repoToken)
              .replace('{issue_id}', issueId)
          : '';
        variables.FORGE_ISSUE_URL = issueUrl;

        mergedVars.FORGE = forgeName;
        mergedVars.FORGE_TYPE = forgeConfig.type || '';
        mergedVars.FORGE_HOST = forgeConfig.host || '';
        mergedVars.FORGE_CLONE_URL = forgeCloneUrl;
        mergedVars.FORGE_REPO_URL = repoUrl;
        mergedVars.FORGE_ISSUE_URL = issueUrl;
      }
      // Always expose DEFAULT_FORGE macro, even when no forge is selected.
      mergedVars.DEFAULT_FORGE = (config && (config.DEFAULT_FORGE || '')) || '';
    } catch (e) {
      // Forge configuration is optional; log best-effort diagnostics and continue.
      try {
        console.warn(`[TemplateLoader] Forge variable injection failed for template ${this.id}: ${e?.message || e}`);
      } catch (_) {}
    }

    // Process environment variable definitions through shared processor
    const templateEnvVars = [];
    if (this.env_vars) {
      if (LOG_IS_DEBUG) {
        console.log(`Template ${this.id}: Processing environment variables`);
        console.log(`Template ${this.id}: env_vars config: ${JSON.stringify(this.env_vars)}`);
        console.log(`Template ${this.id}: available template variables: ${JSON.stringify(Object.keys(mergedVars))}`);
      }
      for (const [envName, envValue] of Object.entries(this.env_vars)) {
        const processedValue = processText(String(envValue ?? ''), mergedVars, {
          baseDirs: [__dirname],
          maxIncludeDepth: 5,
          maxConditionalDepth: 20
        });
        if (LOG_IS_DEBUG) console.log(`Template ${this.id}: env var '${envName}' = '${envValue}' -> '${processedValue}'`);
        if (processedValue) {
          const envVar = `${envName}="${processedValue}"`;
          templateEnvVars.push(envVar);
          if (LOG_IS_DEBUG) console.log(`Template ${this.id}: added env var: ${envVar}`);
        }
      }
    }
    
    // Apply shared text processor across command, working directory, and links
    processedCommand = processText(String(this.command || ''), mergedVars, { baseDirs: [__dirname] });
    processedWorkingDir = processText(String(processedWorkingDir || ''), mergedVars, { baseDirs: [__dirname] });
    // Process links with optional skip-on-unresolved behavior
    // When a link declares `skip_if_unresolved: true`, we will detect
    // any `{var}` placeholders in its url/name that do not have a
    // non-empty value in the current variables and omit that link.

    const linkList = [];
    for (const l of processedLinks) {
      if (!l) continue;
      const shouldSkipIfUnresolved = l.skip_if_unresolved === true;
      if (shouldSkipIfUnresolved) {
        try {
          const detectPlaceholders = (s) => {
            try {
              const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
              const out = new Set();
              let m;
              re.lastIndex = 0;
              while ((m = re.exec(String(s || ''))) !== null) out.add(m[1]);
              return Array.from(out);
            } catch (_) { return []; }
          };
          const varsToCheck = new Set([
            ...detectPlaceholders(l.url),
            ...detectPlaceholders(l.name)
          ]);
          let unresolved = false;
          for (const key of varsToCheck) {
            // Only consider unresolved when the effective value is blank
            const has = Object.prototype.hasOwnProperty.call(mergedVars, key);
            const val = has ? mergedVars[key] : undefined;
            const blank = (function(v) {
              if (v === undefined || v === null) return true;
              const t = typeof v;
              if (t === 'string') return v.trim() === '';
              if (t === 'number') return Number.isNaN(v);
              // Treat all non-string/number types (booleans, objects, arrays) as blank for link resolution
              return true;
            })(val);
            if (blank) { unresolved = true; break; }
          }
          if (unresolved) {
            if (LOG_IS_DEBUG) console.log(`Template ${this.id}: skipping link due to unresolved macros: ${JSON.stringify(l)}`);
            continue; // omit this link entirely
          }
        } catch (_) { /* non-fatal */ }
      }

      // Interpolate url/name via shared processor
      const processed = {
        ...l,
        url: processText(String(l?.url || ''), mergedVars, { baseDirs: [__dirname] }),
        name: processText(String(l?.name || ''), mergedVars, { baseDirs: [__dirname] })
      };

      // Optional pre-view pipeline command: keep raw template text so it can
      // be processed later (at generation time) with additional variables
      // such as theme colors. Mark the link as template-defined so runtime
      // logic can distinguish it from user-added links.
      try {
        const rawPre = typeof l.pre_view_command === 'string' ? l.pre_view_command : '';
        if (rawPre && rawPre.trim()) {
          processed._pre_view_command = rawPre;
        }
        // Normalize a template-only marker; this is not exposed to clients.
        processed._template_link = true;
        // Do not carry the raw config key forward into session state.
        if (Object.prototype.hasOwnProperty.call(processed, 'pre_view_command')) {
          delete processed.pre_view_command;
        }
      } catch (_) { /* best-effort only */ }

      // Optional output filename supports templating at creation time.
      try {
        if (Object.prototype.hasOwnProperty.call(l, 'output_filename')) {
          const rawOut = l.output_filename;
          if (typeof rawOut === 'string' && rawOut.trim()) {
            processed.output_filename = processText(String(rawOut), mergedVars, { baseDirs: [__dirname] });
          }
        }
      } catch (_) { /* non-fatal */ }

      linkList.push(processed);
    }
    processedLinks = linkList;

    // Process command_tabs similarly to links (interpolate name/command; optional skip on unresolved)
    let processedCommandTabs = [];
    try {
      const tabs = Array.isArray(this.command_tabs) ? this.command_tabs : [];
      const out = [];
      for (const t of tabs) {
        if (!t) continue;
        const shouldSkipIfUnresolved = t.skip_if_unresolved === true;
        if (shouldSkipIfUnresolved) {
          try {
            const detectPlaceholders = (s) => {
              try {
                const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
                const out2 = new Set();
                let m;
                re.lastIndex = 0;
                while ((m = re.exec(String(s || ''))) !== null) out2.add(m[1]);
                return Array.from(out2);
              } catch (_) { return []; }
            };
            const varsToCheck = new Set([
              ...detectPlaceholders(t.name),
              ...detectPlaceholders(t.command)
            ]);
            let unresolved = false;
            for (const key of varsToCheck) {
              const has = Object.prototype.hasOwnProperty.call(mergedVars, key);
              const val = has ? mergedVars[key] : undefined;
              const blank = (function(v) {
                if (v === undefined || v === null) return true;
                const ty = typeof v;
                if (ty === 'string') return v.trim() === '';
                if (ty === 'number') return Number.isNaN(v);
                return true;
              })(val);
              if (blank) { unresolved = true; break; }
            }
            if (unresolved) {
              if (LOG_IS_DEBUG) console.log(`Template ${this.id}: skipping command_tab due to unresolved macros: ${JSON.stringify(t)}`);
              continue;
            }
          } catch (_) { /* ignore */ }
        }
        const processed = {
          ...t,
          name: processText(String(t?.name || ''), mergedVars, { baseDirs: [__dirname] }),
          command: processText(String(t?.command || ''), mergedVars, { baseDirs: [__dirname] })
        };
        out.push(processed);
      }
      processedCommandTabs = out;
    } catch (_) { processedCommandTabs = []; }
    
    // Ensure SESSION_ID is available as an environment variable for ALL non-sandbox templates.
    // Also provide TERMSTATION_USER to expose the effective login user.
    // This is important when commands are wrapped with sudo -u, which resets the environment.
    // We will inject env vars and run the command via `bash -lc` to support shell builtins like `source`.
    if (!this.sandbox) {
      try {
        const sid = String((variables && variables.session_id) || '').trim();
        if (sid) {
          // Only add if not already provided explicitly via env_vars
          const alreadyHasSessionId = templateEnvVars.some(v => /^SESSION_ID=/.test(v));
          if (!alreadyHasSessionId) {
            templateEnvVars.push(`SESSION_ID="${sid}"`);
          }
        }
        // Inject TERMSTATION_USER from variables when available
        const loginUser = String((variables && (variables._login_user || variables._default_username)) || '').trim();
        if (loginUser) {
          const alreadyHasUser = templateEnvVars.some(v => /^TERMSTATION_USER=/.test(v));
          if (!alreadyHasUser) {
            templateEnvVars.push(`TERMSTATION_USER="${loginUser}"`);
          }
        }
      } catch (_) {}
    }

    // For non-container isolation, execute pre && main && post on the host as a composite command
    if (this.isolation !== 'container') {
      try {
        const preList = Array.isArray(this.pre_commands)
          ? this.pre_commands.map(c => processText(String(c || ''), mergedVars, { baseDirs: [__dirname] })).filter(Boolean)
          : [];
        const postList = Array.isArray(this.post_commands)
          ? this.post_commands.map(c => processText(String(c || ''), mergedVars, { baseDirs: [__dirname] })).filter(Boolean)
          : [];
        const chain = [];
        if (preList.length) chain.push(...preList);
        if (processedCommand) chain.push(processedCommand);
        if (postList.length) chain.push(...postList);
        processedCommand = chain.join(' && ');
      } catch (e) {
        console.warn(`Template ${this.id}: failed to construct host pre/main/post chain: ${e?.message || e}`);
      }
    }

    // Build inline env export chain for host execution (used below)
    // Always include PATH export to append backend/bootstrap/bin for direct host sessions,
    // so helper tools are resolvable even without per-session bootstrap.
    let _hostEnvExportChain = '';
    if (this.isolation !== 'container') {
      try {
        const exportsArr = [];
        // Append backend-managed tools directory to PATH when present
        try {
          const bootstrapDir = join(__dirname, 'bootstrap');
          const toolsDir = join(bootstrapDir, 'bin');
          try {
            const st = statSync(toolsDir);
            if (st && st.isDirectory()) {
              exportsArr.push(`export BOOTSTRAP_DIR=\"${bootstrapDir}\"`);
              exportsArr.push(`export PATH=\"$PATH:${toolsDir}\"`);
            }
          } catch (_) {}
        } catch (_) {}
        // Include template-declared env vars
        if (templateEnvVars.length > 0) {
          for (const kv of templateEnvVars) exportsArr.push(`export ${kv}`);
        }
        _hostEnvExportChain = exportsArr.join(' && ');
      } catch (_) { _hostEnvExportChain = ''; }
    }

    // If isolation=container, transform the command into a native container invocation
    if (this.isolation === 'container') {
      try {
        processedCommand = this._buildSandboxCommand(processedCommand, processedWorkingDir, variables, this.env_vars || {});
      } catch (e) {
        console.warn(`Template ${this.id}: failed to build sandbox command: ${e?.message || e}`);
      }
    }

    // Wrap final command with sudo -u if requested (applies to podman when sandbox=true),
    // but only if the current OS user differs from the requested user. When wrapping with sudo,
    // always execute via `bash -lc` so that the entire command chain (including env exports)
    // runs as the target user, not just the first token.
    const currentOsUser = (() => { try { return userInfo().username; } catch (_) { return ''; } })();
    if (this.user) {
      let resolvedUser = this.user;
      
      // Handle special user values
      if (this.user === 'daemon_user') {
        resolvedUser = currentOsUser;
      } else if (this.user === 'login_user') {
        // Get login user from variables context if provided, otherwise fall back to config default
        resolvedUser = variables._login_user || variables._default_username || currentOsUser;
      }
      
      const systemUser = resolveSystemUsername(resolvedUser);
      console.log(`Template ${this.id}: user='${this.user}' resolved to '${resolvedUser}' (system='${systemUser}', current='${currentOsUser}')`);
      
      if (systemUser !== currentOsUser) {
        console.log(`Template ${this.id}: Wrapping command with sudo -n -u ${systemUser} via bash -lc`);
        // Build full host command with env exports (if any)
        const hostCmd = _hostEnvExportChain
          ? `${_hostEnvExportChain} && ${processedCommand}`
          : processedCommand;
        // Escape single quotes for safe embedding in a single-quoted string
        const escSingle = (s) => String(s || '').replace(/'/g, `'\''`);
        processedCommand = `sudo -n -u ${systemUser} bash -lc '${escSingle(hostCmd)}'`;
      } else {
        console.log(`Template ${this.id}: Running as current user, no sudo needed`);
        // Not using sudo; if we have env exports, prefix them inline
        if (_hostEnvExportChain) {
          processedCommand = `${_hostEnvExportChain} && ${processedCommand}`;
          if (LOG_IS_DEBUG) console.log(`Template ${this.id}: prefixed command with inline env exports`);
        }
      }
    }
    else {
      // No explicit user wrapper; if we have env exports, prefix them inline
      if (_hostEnvExportChain) {
        processedCommand = `${_hostEnvExportChain} && ${processedCommand}`;
        if (LOG_IS_DEBUG) console.log(`Template ${this.id}: prefixed command with inline env exports`);
      }
    }

    return {
      ...this.toDict(),
      command: processedCommand,
      working_directory: processedWorkingDir,
      links: processedLinks,
      command_tabs: processedCommandTabs
    };
  }

  // Build native container command without -e flags; env exported in-container; pre/post via host-mounted scripts.
  _buildSandboxCommand(innerCommand, workingDir, variables, envVarsConfig) {
    // Use the template-provided session_id (route generates one before creation)
    const sid = variables?.session_id || '';
    const name = sid ? `sandbox-${sid}` : 'sandbox-unknown';

    // Build inner command script
    const escapeForDoubleQuotes = (s) => String(s || '').replace(/"/g, '\\"');

    // Env assignments from template env_vars (processed via shared text processor)
    const envAssignments = [];
    if (envVarsConfig && typeof envVarsConfig === 'object') {
      const mergedVars = { ...(config?.TEMPLATE_VARS || {}), ...(variables || {}) };
      for (const [envName, envValue] of Object.entries(envVarsConfig)) {
        const processedValue = processText(String(envValue ?? ''), mergedVars, { baseDirs: [__dirname] });
        if (processedValue !== undefined && processedValue !== null && String(processedValue).length > 0) {
          envAssignments.push(`${envName}="${escapeForDoubleQuotes(processedValue)}"`);
        }
      }
    }

    // Ensure SESSION_ID is available inside sandbox containers
    if (variables.session_id) {
      envAssignments.push(`SESSION_ID="${escapeForDoubleQuotes(variables.session_id)}"`);
    }
    // Ensure TERMSTATION_USER is available inside sandbox containers
    try {
      const loginUser = variables._login_user || variables._default_username;
      if (loginUser) {
        envAssignments.push(`TERMSTATION_USER="${escapeForDoubleQuotes(loginUser)}"`);
      }
    } catch (_) {}
    // Ensure SESSIONS_BASE_URL is available inside sandbox containers
    try {
      if (config && config.SESSIONS_BASE_URL) {
        envAssignments.push(`SESSIONS_BASE_URL="${escapeForDoubleQuotes(config.SESSIONS_BASE_URL)}"`);
      }
    } catch (_) {}
    // Ensure SESSIONS_API_BASE_URL is available inside sandbox containers (distinct from SESSIONS_BASE_URL)
    try {
      if (config && config.SESSIONS_API_BASE_URL) {
        envAssignments.push(`SESSIONS_API_BASE_URL="${escapeForDoubleQuotes(config.SESSIONS_API_BASE_URL)}"`);
      }
    } catch (_) {}
    // Ensure SESSION_TUNNEL_TOKEN is available inside sandbox containers (if provided)
    try {
      const t = variables && variables.session_tunnel_token ? String(variables.session_tunnel_token) : '';
      if (t) {
        envAssignments.push(`SESSION_TUNNEL_TOKEN="${escapeForDoubleQuotes(t)}"`);
      }
    } catch (_) {}

    // Also export unified SESSION_TOK (and legacy names) when provided as session_token
    try {
      const t2 = variables && variables.session_token ? String(variables.session_token) : '';
      if (t2) {
        envAssignments.push(`SESSION_TOK="${escapeForDoubleQuotes(t2)}"`);
        // Ensure legacy names are set to the same value for compatibility
        envAssignments.push(`SESSION_TUNNEL_TOKEN="${escapeForDoubleQuotes(t2)}"`);
        envAssignments.push(`SESSION_FILES_TOKEN="${escapeForDoubleQuotes(t2)}"`);
      }
    } catch (_) {}

    // Ensure SESSION_FILES_TOKEN is available inside sandbox containers (if provided)
    try {
      const ft = variables && (variables.session_files_token || variables.session_token)
        ? String(variables.session_files_token || variables.session_token)
        : '';
      if (ft) {
        envAssignments.push(`SESSION_FILES_TOKEN="${escapeForDoubleQuotes(ft)}"`);
      }
    } catch (_) {}

    // Process optional pre/post commands through shared processor
    const mergedTextVars = { ...(config?.TEMPLATE_VARS || {}), ...(variables || {}) };
    let pre = Array.isArray(this.pre_commands)
      ? this.pre_commands.map(line => processText(String(line || ''), mergedTextVars, { baseDirs: [__dirname] })).filter(Boolean)
      : [];
    let post = Array.isArray(this.post_commands)
      ? this.post_commands.map(line => processText(String(line || ''), mergedTextVars, { baseDirs: [__dirname] })).filter(Boolean)
      : [];

    // Helper start moved into zip orchestrator (scripts/run.sh)

    // Legacy inline write_files via base64 has been removed in favor of the bootstrap zip

    // Minimal inline bootstrap: run orchestrator from mounted /workspace
    try {
      const parts = [];
      parts.push('mkdir -p /workspace');
      parts.push('export HOME="/workspace"');
      parts.push('[ -f /workspace/.bootstrap/scripts/run.sh ] || exit 1');
      parts.push('bash /workspace/.bootstrap/scripts/run.sh');
      const minimal = parts.join(' && ');
      pre = [ minimal ];
      post = [];
      innerCommand = ':';
    } catch (_) {}

    const parts = [];
    parts.push('set -e');
    // Orchestrator script handles env export; skip exporting here to keep command minimal
    // Run inline pre-commands (chained with &&, executed in-container)
    if (pre.length) {
      for (const line of pre) {
        const trimmed = String(line).trim();
        if (trimmed) parts.push(`${escapeForDoubleQuotes(trimmed)}`);
      }
    }
    // Run the main inner command (env already exported above)
    parts.push(`${escapeForDoubleQuotes(innerCommand)}`);
    // Run inline post-commands (chained with &&, executed in-container)
    if (post.length) {
      for (const line of post) {
        const trimmed = String(line).trim();
        if (trimmed) parts.push(`${escapeForDoubleQuotes(trimmed)}`);
      }
    }
    // Orchestrator handles post.sh; no additional post stub here
    
    // Host mount: bind the per-session workspace directory to /workspace (read-write)
    let fileMounts = [];
    try {
      const sid = String(variables && variables.session_id ? variables.session_id : '');
      const base = (function() {
      const raw = String(config && config.SESSIONS_DIR ? config.SESSIONS_DIR : 'sessions');
        return isAbsolute(raw) ? raw : join(process.cwd(), raw);
      })();
      const workspaceHostPath = join(base, sid, 'workspace');
      fileMounts = [{ hostPath: workspaceHostPath, containerPath: '/workspace' }];
      // When container_use_socket_adapter is enabled and a Unix socket is configured,
      // bind-mount the socket into the container for the socat adapter.
      try {
        if (config.CONTAINER_USE_SOCKET_ADAPTER) {
          const socketPath = String(config.LOCAL_UNIX_SOCKET_PATH || '').trim();
          if (socketPath && !isWin && isAbsolute(socketPath)) {
            fileMounts.push({
              hostPath: socketPath,
              containerPath: '/workspace/.bootstrap/api.sock',
              // Use shared SELinux label (:z) instead of private (:Z) since the
              // socket is accessed by multiple containers and the host process.
              selinuxShared: true
            });
          }
        }
      } catch (_) {
        // Best-effort only; containers will still function without the socket mount.
      }
    } catch (_) { fileMounts = []; }

    // Include template-declared bind mounts
    try {
      const list = Array.isArray(this.bind_mounts) ? this.bind_mounts : [];
      // Helper to expand $HOME in paths (shell expansion may not work in all environments)
      const expandHomePath = (p) => {
        if (!p || typeof p !== 'string') return p;
        if (p === '$HOME') return homedir();
        if (p.startsWith('$HOME/')) return join(homedir(), p.slice(6));
        return p;
      };
      for (const m of list) {
        if (!m) continue;
        const hostRaw = String(m.host_path || m.hostPath || '').trim();
        const host = expandHomePath(hostRaw);
        const cont = String(m.container_path || m.containerPath || '').trim();
        const ro = m.readonly === true;
        if (!host || !cont) continue;

        let exists = true;
        try {
          const st = statSync(host);
          exists = !!(st && (st.isFile() || st.isDirectory() || (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink())));
        } catch (e) {
          exists = false;
        }

        if (!exists) {
          try {
            logger.warning(`[TemplateLoader] Template ${this.id}: skipping bind_mount host_path '${host}' -> '${cont}' because it does not exist`);
          } catch (_) {}
          continue;
        }

        try {
          if (LOG_IS_DEBUG && logger.debug) {
            const roTag = ro ? ' (readonly)' : '';
            logger.debug(`[TemplateLoader] Template ${this.id}: adding bind_mount host_path '${host}' -> '${cont}'${roTag}`);
          }
        } catch (_) {}

        fileMounts.push({ hostPath: host, containerPath: cont, readonly: ro });
      }
    } catch (_) { /* ignore */ }

    // Resolve the container image: allow override via parameter 'container_image',
    // otherwise process the template attribute (supports placeholders as needed).
    let effectiveImage = '';
    try {
      const mergedTextVars = { ...(config?.TEMPLATE_VARS || {}), ...(variables || {}) };
      const fromVars = (variables && variables.container_image)
        ? String(variables.container_image)
        : '';
      const fromAttr = this.container_image ? processText(String(this.container_image), mergedTextVars, { baseDirs: [__dirname] }) : '';
      effectiveImage = (fromVars && fromVars.trim()) ? fromVars.trim() : (fromAttr && fromAttr.trim()) ? fromAttr.trim() : (this.container_image || '');
    } catch (_) {
      effectiveImage = this.container_image || '';
    }

    const built = buildRunCommand({
      name,
      sessionId: sid,
      image: effectiveImage,
      workingDir: this.container_working_dir,
      memory: this.container_memory,
      cpus: this.container_cpus,
      network: this.container_network,
      capAdd: (function resolveCapAdd(self) {
        try {
          const arr = Array.isArray(self.container_cap_add) ? self.container_cap_add : [];
          return arr.map(x => String(x || '').trim()).filter(Boolean);
        } catch (_) { return []; }
      })(this),
      mountHostPath: null,
      fileMounts,
      mapUser: (function resolveMapUser(self) {
        try {
          if (self.container_map_user === undefined) return config.CONTAINER_MAP_USER !== false;
          return !!self.container_map_user;
        } catch (_) { return true; }
      })(this),
      tmpfsMounts: (function normalizeTmpfs(list) {
        try {
          const arr = Array.isArray(this.tmpfs_mounts) ? this.tmpfs_mounts : [];
          const out = [];
          for (const m of arr) {
            if (!m) continue;
            if (typeof m === 'string') { out.push({ path: m }); continue; }
            const p = String(m.path || m.container_path || m.containerPath || '').trim();
            const opt = m.options ? String(m.options) : '';
            if (p) out.push({ path: p, options: opt });
          }
          return out;
        } catch (_) { return []; }
      }).call(this),
      envAssignments,
      pre,
      post,
      innerCommand
    });
    if (LOG_IS_DEBUG) console.log(`Template ${this.id}: Built native container command`);

    return built;
  }
}

class TemplateLoader {
  constructor() {
    this.configDir = join(__dirname, 'config');
    this.templates = new Map();
    this.templatesBaseNoOverlay = new Map();
    this.templatesOverlay = new Map();
    // Keep raw data for inheritance resolution
    this.rawTemplates = new Map();
    this.lastModified = null;
    this.lastReloadTime = 0;
    this.cacheVersion = 0;
    this.loadTemplates();
  }

  loadTemplates() {
    try {
      const data = templatesConfigCache.get() || {};
      const meta = templatesConfigCache.getMeta();
      this.lastModified = meta.mtime || null;
      this.lastReloadTime = Date.now();
      this.cacheVersion = meta.version || 0;

      this.templates.clear();
      this.templatesBaseNoOverlay.clear();
      this.templatesOverlay.clear();
      this.rawTemplates.clear();

      // Stage 1: collect raw templates by id for inheritance lookup
      for (const t of data.templates || []) {
        if (!t.id) {
          console.error('Template missing id, skipping');
          continue;
        }
        this.rawTemplates.set(t.id, t);
      }

      // Helper: deep merge with special handling for arrays like parameters/links
      const mergeBy = (arr, key = 'name') => {
        const map = new Map();
        for (const item of arr || []) {
          const k = item && item[key];
          if (k !== undefined) map.set(k, { ...item });
        }
        return map;
      };

      const arrayMerge = (baseArr = [], childArr = [], key = 'name') => {
        if (!Array.isArray(childArr) || childArr.length === 0) return [...baseArr];
        const baseMap = mergeBy(baseArr, key);
        for (const item of childArr) {
          const k = item && item[key];
          if (k === undefined) continue;
          // Support removal via { name: 'x', remove: true } or __remove flag
          if (item.remove === true || item.__remove === true) {
            baseMap.delete(k);
            continue;
          }
          const existing = baseMap.get(k) || {};
          baseMap.set(k, { ...existing, ...item });
        }
        return Array.from(baseMap.values());
      };

      const deepMerge = (base, child) => {
        const out = { ...base };
        for (const [k, v] of Object.entries(child || {})) {
          if (k === 'id' || k === 'extends') continue; // child id is kept externally
          if (v === null || v === undefined) {
            out[k] = v; // explicit null clears; undefined handled by spread
            continue;
          }
          if (Array.isArray(v)) {
            // Special-case arrays we want to merge by key
            if (k === 'parameters') {
              out[k] = arrayMerge(base?.parameters || [], v, 'name');
              continue;
            } else if (k === 'links') {
              // Merge links keyed by 'name' (stable label). If duplicates by name are possible, consider 'url'.
              out[k] = arrayMerge(base?.links || [], v, 'name');
              continue;
            } else if (k === 'command_tabs') {
              out[k] = arrayMerge(base?.command_tabs || [], v, 'name');
              continue;
            }
            // Merge flags from child (override node)
            const mergePre = Object.prototype.hasOwnProperty.call(child || {}, 'merge_pre_commands') ? !!child.merge_pre_commands : true;
            const mergePost = Object.prototype.hasOwnProperty.call(child || {}, 'merge_post_commands') ? !!child.merge_post_commands : true;
            const mergeForkPre = Object.prototype.hasOwnProperty.call(child || {}, 'merge_fork_pre_commands') ? !!child.merge_fork_pre_commands : false;
            const mergeForkPost = Object.prototype.hasOwnProperty.call(child || {}, 'merge_fork_post_commands') ? !!child.merge_fork_post_commands : false;
            const mergeExpandIncludes = (function () {
              if (Object.prototype.hasOwnProperty.call(child || {}, 'merge_expand_file_includes')) {
                return !!child.merge_expand_file_includes;
              }
              if (Object.prototype.hasOwnProperty.call(child || {}, 'merge_expand_include_files')) {
                return !!child.merge_expand_include_files;
              }
              return false;
            })();
            const mergeBindMounts = Object.prototype.hasOwnProperty.call(child || {}, 'merge_bind_mounts')
              ? !!child.merge_bind_mounts
              : true;
            const isEmptyArray = v.length === 0;

            if (k === 'pre_commands') {
              out[k] = isEmptyArray ? [] : (mergePre ? [...(base?.[k] || []), ...v] : [...v]);
              continue;
            }
            if (k === 'post_commands') {
              out[k] = isEmptyArray ? [] : (mergePost ? [...(base?.[k] || []), ...v] : [...v]);
              continue;
            }
            if (k === 'fork_pre_commands') {
              out[k] = isEmptyArray ? [] : (mergeForkPre ? [...(base?.[k] || []), ...v] : [...v]);
              continue;
            }
            if (k === 'fork_post_commands') {
              out[k] = isEmptyArray ? [] : (mergeForkPost ? [...(base?.[k] || []), ...v] : [...v]);
              continue;
            }
            if (k === 'write_files') {
              // merge_write_files (default false): when true, concatenate; when false, replace
              const mergeWrite = Object.prototype.hasOwnProperty.call(child || {}, 'merge_write_files') ? !!child.merge_write_files : false;
              out[k] = isEmptyArray ? [] : (mergeWrite ? [...(base?.[k] || []), ...v] : [...v]);
              continue;
            }
            if (k === 'expand_file_includes') {
              // merge_expand_file_includes (default false): when true, concatenate; when false, replace
              out[k] = isEmptyArray ? [] : (mergeExpandIncludes ? [...(base?.[k] || []), ...v] : [...v]);
              continue;
            }
            if (k === 'bind_mounts') {
              // merge_bind_mounts (default false): when true, concatenate; when false, replace
              out[k] = isEmptyArray ? [] : (mergeBindMounts ? [...(base?.[k] || []), ...v] : [...v]);
              continue;
            }
            // Default: replace array
            out[k] = [...v];
          } else if (typeof v === 'object') {
            out[k] = deepMerge(base?.[k] || {}, v);
          } else {
            out[k] = v;
          }
        }
        return out;
      };

      // Resolve inheritance recursively (supports single parent or multiple parents)
      const resolving = new Set();
      const resolved = new Map();
      const resolve = (id) => {
        if (resolved.has(id)) return resolved.get(id);
        const node = this.rawTemplates.get(id);
        if (!node) throw new Error(`Template '${id}' not found for inheritance`);
        if (resolving.has(id)) throw new Error(`Cyclic template inheritance detected at '${id}'`);
        resolving.add(id);
        let merged = { ...node };
        if (node.extends) {
          // Normalize extends to an array of parent IDs
          const parents = Array.isArray(node.extends) ? node.extends : [node.extends];
          // Merge bases left-to-right; later parents override earlier ones
          let basesMerged = {};
          for (const p of parents) {
            const baseResolved = resolve(p);
            basesMerged = deepMerge(basesMerged, baseResolved);
          }
          merged = deepMerge(basesMerged, { ...node });
        }
        resolving.delete(id);
        resolved.set(id, merged);
        return merged;
      };

      // Resolve overrides across the same inheritance chain
      const overlayResolving = new Set();
      const overlayResolved = new Map();
      const resolveOverlay = (id) => {
        if (overlayResolved.has(id)) return overlayResolved.get(id);
        const node = this.rawTemplates.get(id);
        if (!node) throw new Error(`Template '${id}' not found for overlay inheritance`);
        if (overlayResolving.has(id)) throw new Error(`Cyclic template inheritance detected at '${id}' (overlay)`);
        overlayResolving.add(id);

        // Start with empty overlay; merge parents left->right, then node overrides last
        let mergedOverlay = {};
        if (node.extends) {
          const parents = Array.isArray(node.extends) ? node.extends : [node.extends];
          for (const p of parents) {
            const parentOverlay = resolveOverlay(p);
            mergedOverlay = deepMerge(mergedOverlay, parentOverlay || {});
          }
        }
        // Support both legacy sandbox_overrides and new isolation_overrides
        try {
          if (node && typeof node.sandbox_overrides === 'object' && node.sandbox_overrides) {
            mergedOverlay = deepMerge(mergedOverlay, node.sandbox_overrides);
          }
        } catch (_) {}
        try {
          if (node && typeof node.isolation_overrides === 'object' && node.isolation_overrides) {
            // If isolation_overrides is namespaced by mode, flatten by merging all modes.
            // This makes overrides apply to both directory and container by default.
            const io = node.isolation_overrides;
            const modes = ['none','directory','container'];
            let flattened = {};
            if (Array.isArray(io)) {
              // Not expected; ignore
            } else if (io && (io.none || io.directory || io.container)) {
              for (const m of modes) {
                if (io[m] && typeof io[m] === 'object') {
                  flattened = deepMerge(flattened, io[m]);
                }
              }
              mergedOverlay = deepMerge(mergedOverlay, flattened);
            } else {
              mergedOverlay = deepMerge(mergedOverlay, io);
            }
          }
        } catch (_) {}

        overlayResolving.delete(id);
        overlayResolved.set(id, mergedOverlay);
        return mergedOverlay;
      };

      for (const id of this.rawTemplates.keys()) {
        try {
          const dataMerged = resolve(id);
          const baseNoOverlay = { ...dataMerged, id };
          this.templatesBaseNoOverlay.set(id, baseNoOverlay);

          const overlay = resolveOverlay(id) || {};
          this.templatesOverlay.set(id, overlay);

          let finalData = { ...baseNoOverlay }; // ensure child id wins

          // Apply overrides when isolation is not 'none' (applies to both directory and container)
          try {
            const overlayHasKeys = overlay && Object.keys(overlay).length > 0;
            if (overlayHasKeys) {
              const iso = (function() {
                if (typeof finalData.isolation === 'string') return finalData.isolation;
                if (finalData.sandbox === true) return 'container';
                return 'none';
              })();
              if (iso !== 'none') {
                finalData = deepMerge(finalData, overlay);
              }
            }
          } catch (e) {
            console.error(`Error applying isolation overrides for ${id}: ${e?.message || e}`);
          }
          // Validate that template parameter names do not conflict with reserved config-provided template vars
          try {
            const reserved = new Set(Object.keys((config && config.TEMPLATE_VARS) || {}));
            const params = Array.isArray(finalData.parameters) ? finalData.parameters : [];
            const conflicts = params
              .map(p => p && p.name)
              .filter(n => typeof n === 'string' && reserved.has(n));
            if (conflicts.length > 0) {
              throw new Error(`Template uses reserved variable name(s): ${conflicts.join(', ')}`);
            }
          } catch (e) {
            throw e;
          }

          const template = new CommandTemplate(finalData);
          this.templates.set(template.id, template);
        } catch (error) {
          console.error(`Error creating template ${id}: ${error.message}`);
        }
      }
      
      // Per-user workspaces: no global ensure is performed here.
      console.log(`[INFO] Loaded ${this.templates.size} command templates at ${new Date().toISOString()}`);
    } catch (error) {
      console.error(`Error loading templates: ${error.message}`);
      // Don't clear templates on error - keep the last good configuration
      if (this.templates.size === 0) {
        this.templates.clear();
      }
    }
  }

  _ensureFreshTemplates() {
    try {
      // Use shared cache metadata to detect changes.
      // Call get() to benefit from mtime fallback inside the cache.
      templatesConfigCache.get();
      const meta = templatesConfigCache.getMeta();
      const version = meta.version || 0;
      if (!this.cacheVersion || version !== this.cacheVersion) {
        console.log('[INFO] Templates config cache changed, rebuilding templates...');
        this.loadTemplates();
      }
    } catch (error) {
      console.error(`Error ensuring fresh templates: ${error.message}`);
    }
  }

  getAllTemplates() {
    this._ensureFreshTemplates();
    
    return Array.from(this.templates.values())
      .filter(template => template.display)
      .map(template => template.toDict());
  }

  getTemplate(templateId) {
    this._ensureFreshTemplates();
    return this.templates.get(templateId);
  }

  getTemplateWithIsolation(templateId, mode) {
    this._ensureFreshTemplates();
    const base = this.templatesBaseNoOverlay.get(templateId);
    if (!base) return this.getTemplate(templateId);
    try {
      const overlay = this.templatesOverlay.get(templateId) || {};
      const hasOverlay = overlay && Object.keys(overlay).length > 0;
      let data = { ...base };
      if (mode === 'container' && hasOverlay) {
        data = deepMerge(data, overlay);
      }
      data.isolation = mode;
      // Derive legacy boolean for UI while migrating
      data.sandbox = (mode === 'container');
      return new CommandTemplate(data);
    } catch (_) {
      return this.getTemplate(templateId);
    }
  }

  reloadTemplates() {
    console.log(`[INFO] Manual template reload requested`);
    const result = templatesConfigCache.reloadNow();
    this.loadTemplates();
    return {
      success: !!result.ok,
      templatesCount: this.templates.size,
      lastModified: this.lastModified,
      reloadTime: new Date().toISOString()
    };
  }

  cleanup() {
    try {
      templatesConfigCache.cleanup();
    } catch (_) {}
  }

  // Resolve per-user parameter values from users.json and groups.json.
  // Returns an ordered, de-duplicated array of strings for the given key.
  resolveUserParameterValues(userProfile, key) {
    try {
      const paramKey = String(key || '').trim();
      if (!paramKey) return [];

      const username = String(userProfile?.username || '').trim();
      const usersRaw = usersConfigCache.get();
      const groupsRaw = groupsConfigCache.get();
      const users = Array.isArray(usersRaw) ? usersRaw : [];
      const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
      const userDef = users.find((u) => u && String(u.username) === username) || null;

      const reqGroups = Array.isArray(userProfile?.groups) ? userProfile.groups.filter(Boolean) : [];
      const userGroupsOrder = (reqGroups && reqGroups.length > 0)
        ? reqGroups
        : (Array.isArray(userDef?.groups) ? userDef.groups : []);

      const seen = new Set();
      const out = [];
      const pushValues = (vals) => {
        if (!Array.isArray(vals)) return;
        for (const v of vals) {
          const s = String(v ?? '').trim();
          if (!s || seen.has(s)) continue;
          seen.add(s);
          out.push(s);
        }
      };

      for (const gname of (userGroupsOrder || [])) {
        const g = (groups || []).find((gg) => gg && String(gg.name) === String(gname));
        if (!g || !g.parameter_values) continue;
        pushValues(g.parameter_values[paramKey]);
      }

      if (userDef && userDef.parameter_values) {
        pushValues(userDef.parameter_values[paramKey]);
      }

      return out;
    } catch (_) {
      return [];
    }
  }

  // Get dynamic options for template parameters
  getParameterOptions(templateId, parameterName, variables = {}, userProfile = null) {
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }

    // Built-in synthetic parameter: container_image for sandbox templates.
    // If not explicitly defined on the template, we still support dynamic
    // suggestions by listing local images and allow freeform entry.
    const provideImageOptions = () => {
      try {
        const bin = config.CONTAINER_RUNTIME_BIN || 'podman';
        const name = String(config.CONTAINER_RUNTIME || 'podman');
        const options = [];
        const hasExplicitTagOrDigest = (s) => {
          if (!s) return false;
          const str = String(s);
          if (str.includes('@')) return true; // digest present
          const lastSlash = str.lastIndexOf('/');
          const lastColon = str.lastIndexOf(':');
          return lastColon > lastSlash; // tag when colon after last slash
        };
        const normalizeRef = (obj) => {
          try {
            const namesRef = Array.isArray(obj.Names) && obj.Names[0] ? String(obj.Names[0]) : '';
            if (namesRef) return namesRef;
          } catch (_) {}
          let repo = obj.Repository || '';
          let tag = obj.Tag || '';
          if (!repo && obj.ImageName) repo = obj.ImageName;
          if (!repo) return '';
          if (hasExplicitTagOrDigest(repo)) return repo;
          const t = tag && tag !== '<none>' ? tag : 'latest';
          return `${repo}:${t}`;
        };
        if (name === 'podman') {
          try {
            const out = execSync(`${bin} images --format json`, { encoding: 'utf8', timeout: 8000, maxBuffer: 10 * 1024 * 1024 });
            const arr = JSON.parse(out || '[]');
            const list = Array.isArray(arr) ? arr : [];
            for (const c of list) {
              const ref = normalizeRef(c);
              if (!ref) continue;
              options.push({ value: ref, label: ref });
            }
          } catch (e) {
            console.warn(`[TemplateLoader] podman images failed: ${e?.message || e}`);
          }
        } else {
          try {
            const out = execSync(`${bin} images --format '{{json .}}'`, { encoding: 'utf8', timeout: 8000, maxBuffer: 10 * 1024 * 1024 });
            const lines = String(out || '').split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const obj = JSON.parse(line);
                const repo = obj.Repository || '';
                const tag = obj.Tag || '';
                let ref = '';
                if (repo) {
                  const hasTag = hasExplicitTagOrDigest(repo);
                  if (hasTag) {
                    ref = repo;
                  } else {
                    const t = tag && tag !== '<none>' ? tag : 'latest';
                    ref = `${repo}:${t}`;
                  }
                }
                if (!ref) continue;
                options.push({ value: ref, label: ref });
              } catch (_) { /* skip */ }
            }
          } catch (e) {
            console.warn(`[TemplateLoader] docker images failed: ${e?.message || e}`);
          }
        }
        const seen = new Set();
        const unique = [];
        for (const o of options) {
          const v = String(o?.value || '').trim();
          if (!v || seen.has(v)) continue;
          seen.add(v);
          unique.push(o);
        }
        return { options: unique };
      } catch (e) {
        console.warn(`[TemplateLoader] Failed to provide container image options: ${e?.message || e}`);
        return { options: [] };
      }
    };

    const parameter = template.parameters.find(p => p.name === parameterName);
    if (!parameter) {
      if (template.sandbox === true && parameterName === 'container_image') {
        return provideImageOptions();
      }
      throw new Error(`Parameter ${parameterName} not found in template ${templateId}`);
    }

    // Determine options source: static (default), command, user, or forge-based.
    const sourceRaw = parameter.options_source;
    const source = (typeof sourceRaw === 'string' && sourceRaw.trim())
      ? sourceRaw.trim().toLowerCase()
      : 'static';

    // If this is the sandbox image parameter and no command is provided, use built-in provider
    try {
      if (template.sandbox === true && parameterName === 'container_image') {
        const hasCmd = !!(parameter.command || parameter.command_file);
        if (!hasCmd) {
          return provideImageOptions();
        }
      }
    } catch (_) { /* ignore */ }

    // User-sourced options: derive from users.json/groups.json only.
    if (source === 'user') {
      const key = parameter.options_user_key || parameter.name || parameterName;
      const values = this.resolveUserParameterValues(userProfile || {}, key);
      const options = values.map((v) => ({ value: v, label: v }));
      return { options };
    }

    // Merge provided variables with template parameter defaults so hidden params are available to commands
    const mergedVars = { ...(config?.TEMPLATE_VARS || {}), ...(variables || {}) };
    try {
      for (const p of (template.parameters || [])) {
        const name = p && p.name;
        if (!name) continue;
        if (mergedVars[name] === undefined && p.default !== undefined && p.default !== null) {
          mergedVars[name] = p.default;
        }
      }
    } catch (_) {}

    // Forge configuration-backed options: list configured forge names.
    if (source === 'forges') {
      try {
        const forges = config && (config.FORGES || {});
        const names = Object.keys(forges || {});
        const options = names.map((name) => ({ value: name, label: name }));
        return { options };
      } catch (_) {
        return { options: [] };
      }
    }

    // Forge configuration-backed options: run a command from the selected forge.
    if (source === 'forge') {
      let forgeName = '';
      try {
        const forges = config && (config.FORGES || {});
        const defaultForge = config && (config.DEFAULT_FORGE || '');
        const forgeNameRaw = mergedVars && typeof mergedVars.forge === 'string' ? mergedVars.forge : '';
        forgeName = (forgeNameRaw && forgeNameRaw.trim()) || defaultForge || '';
        const forgeConfig = forgeName ? forges[forgeName] : null;
        const key = parameter.options_forge_key || 'list_repos';
        const cmdTemplate = forgeConfig && forgeConfig[key];
        if (!cmdTemplate) {
          return { options: [] };
        }

        let command = String(cmdTemplate);
        for (const [k, v] of Object.entries(mergedVars || {})) {
          const placeholder = `{${k}}`;
          const regex = new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g');
          command = command.replace(regex, String(v ?? ''));
        }

        let workingDir = template.working_directory;
        if (workingDir === '~' || workingDir === '$HOME') {
          workingDir = homedir();
        }

        try {
          console.log(`[INFO] Executing forge options for ${templateId}.${parameterName} (forge=${forgeName || 'unknown'}): ${command} (cwd=${workingDir})`);
        } catch (_) {}

        const env = { ...process.env };
        for (const [k, v] of Object.entries(mergedVars || {})) {
          env[k] = String(v ?? '');
          env[k.toUpperCase()] = String(v ?? '');
        }

        // When a forge declares an ssh_identity_file, expose it to the command
        // so daemon-run repo operations (list_repos, list_branches, etc.) can
        // authenticate over SSH without relying on global user state.
        try {
          const identityRaw = forgeConfig && typeof forgeConfig.ssh_identity_file === 'string'
            ? forgeConfig.ssh_identity_file.trim()
            : '';
          if (identityRaw) {
            if (!env.SSH_IDENTITY_FILE) {
              env.SSH_IDENTITY_FILE = identityRaw;
            }
            if (!env.GIT_SSH_COMMAND) {
              env.GIT_SSH_COMMAND = `ssh -o StrictHostKeyChecking=accept-new -i ${identityRaw}`;
            }
          }
        } catch (_) {}

        const output = execSync(command, {
          cwd: workingDir,
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 10 * 1024 * 1024,
          env
        });
        const lines = String(output || '').split('\n').filter(line => line.trim() !== '');
        const options = lines.map(line => ({ value: line.trim(), label: line.trim() }));
        return { options };
      } catch (e) {
        console.error(`[TemplateLoader] forge options command failed for ${templateId}.${parameterName} (forge=${forgeName || 'unknown'}): ${e?.message || e}`);
        return { options: [] };
      }
    }

    // When options_source is static, ignore command/command_file and return static options.
    if (source === 'static') {
      return {
        options: parameter.options || []
      };
    }

    // If parameter has a command_file, execute that script with variables as env
    if (parameter.command_file) {
      try {
        let workingDir = template.working_directory;
        if (workingDir === '~' || workingDir === '$HOME') workingDir = homedir();

        const scriptPath = isAbsolute(parameter.command_file)
          ? parameter.command_file
          : join(this.configDir, parameter.command_file);

        // Provide variables as environment vars (both lower and upper case)
        const env = { ...process.env };
        for (const [k, v] of Object.entries(mergedVars || {})) {
          env[k] = String(v ?? '');
          env[k.toUpperCase()] = String(v ?? '');
        }

        const output = execSync(`bash ${scriptPath}`, {
          cwd: workingDir,
          encoding: 'utf8',
          timeout: 8000,
          maxBuffer: 10 * 1024 * 1024,
          env
        });

        const lines = String(output || '').split('\n').filter(line => line.trim() !== '');
        const options = lines.map(line => ({ value: line.trim(), label: line.trim() }));
        console.log(`[INFO] Found ${options.length} dynamic options for ${templateId}.${parameterName}`);
        return { options };
      } catch (error) {
        console.error(`Error executing command_file for ${templateId}.${parameterName}: ${error.message}`);
        return { options: parameter.options || [] };
      }
    }

    // If parameter has a command, execute it to get dynamic options
    if (parameter.command) {
      try {
        // Execute the command with the working directory from the template
        let workingDir = template.working_directory;
        if (workingDir === '~' || workingDir === '$HOME') {
          workingDir = homedir();
        }

        // If the command begins with KEY=VAL assignments followed by a script path relative to config,
        // resolve the script and execute with args, merging env assignments and template variables.
        const cmdRaw = String(parameter.command || '').trim();
        const scriptLike = (p) => p.endsWith('.sh') || p.startsWith('./') || p.startsWith('scripts/');
        (function tryScriptExec() {
          try {
            let rest = cmdRaw;
            const extraEnv = {};
            // Capture leading env assignments
            let m;
            // eslint-disable-next-line no-cond-assign
            while ((m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=([^ \t]+)\s*/))) {
              extraEnv[m[1]] = m[2];
              rest = rest.slice(m[0].length);
            }
            const firstToken = (rest.split(/\s+/)[0] || '').trim();
            if (!firstToken || !scriptLike(firstToken)) return; // not a script-style command
            let scriptPath = firstToken;
            if (!isAbsolute(scriptPath)) scriptPath = join(this.configDir, scriptPath);
            try { statSync(scriptPath); } catch (_) { return; }

            const env = { ...process.env };
            // Template variable env
            for (const [k, v] of Object.entries(mergedVars || {})) {
              env[k] = String(v ?? '');
              env[k.toUpperCase()] = String(v ?? '');
            }
            // Inline assignment env
            for (const [k, v] of Object.entries(extraEnv)) {
              env[k] = String(v ?? '');
            }

            const args = rest.slice(firstToken.length).trim();
            const output = execSync(`bash ${scriptPath}${args ? ' ' + args : ''}`, {
              cwd: workingDir,
              encoding: 'utf8',
              timeout: 15000,
              maxBuffer: 10 * 1024 * 1024,
              env
            });
            const lines = String(output || '').split('\n').filter(line => line.trim() !== '');
            const options = lines.map(line => ({ value: line.trim(), label: line.trim() }));
            console.log(`[INFO] Found ${options.length} dynamic options for ${templateId}.${parameterName}`);
            // eslint-disable-next-line no-throw-literal
            throw { __earlyReturn: true, value: { options } };
          } catch (e) {
            if (e && e.__earlyReturn) throw e; // bubble early return
            // fallthrough to generic command execution
          }
        })();

        // Interpolate provided variables into the command
        let command = String(parameter.command);
        // Interpolate provided variables (if any {var} placeholders are present)
        for (const [k, v] of Object.entries(mergedVars)) {
          const placeholder = `{${k}}`;
          const regex = new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g');
          const escapedValue = String(v || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          command = command.replace(regex, escapedValue);
        }

        if (LOG_IS_DEBUG) console.log(`[INFO] Executing command for ${templateId}.${parameterName}: ${command}`);

        // Always pass variables as environment (lower/upper case)
        const env = { ...process.env };
        for (const [k, v] of Object.entries(mergedVars || {})) {
          env[k] = String(v ?? '');
          env[k.toUpperCase()] = String(v ?? '');
        }

        const output = execSync(command, {
          cwd: workingDir,
          encoding: 'utf8',
          timeout: 15000, // allow up to 15s for initial fetch/clone
          maxBuffer: 10 * 1024 * 1024,
          env
        });
        
        // Split output by newlines and filter empty lines
        const lines = output.split('\n').filter(line => line.trim() !== '');
        
        // Convert lines to options format
        const options = lines.map(line => ({
          value: line.trim(),
          label: line.trim()
        }));
        
        console.log(`[INFO] Found ${options.length} dynamic options for ${templateId}.${parameterName}`);
        
        return { options };
      } catch (error) {
        if (error && error.__earlyReturn) {
          return error.value;
        }
        console.error(`Error executing command for ${templateId}.${parameterName}: ${error.message}`);
        // Fall back to static options if command fails
        return {
          options: parameter.options || []
        };
      }
    }

    // No native image listing; rely on parameter.command when configured

    // Return static options if no command is specified
    return {
      options: parameter.options || []
    };
  }

}

// Export singleton instance
export const templateLoader = new TemplateLoader();
