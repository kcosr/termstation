/**
 * Session Manager
 * Handles creation, tracking, and lifecycle management of terminal sessions
 */

import * as fs from 'fs';
import * as path from 'path';
import { TerminalSession } from '../models/terminal-session.js';
import { config } from '../config-loader.js';
import { logger } from '../utils/logger.js';
import { broadcastSessionUpdate } from '../utils/broadcast.js';

// Terminated sessions storage (for history)
const terminatedSessions = new Map();

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.onSessionTerminated = null;
    // Alias registry: alias -> sessionId and sessionId -> alias
    this._aliasToId = new Map();
    this._idToAlias = new Map();
    // Buffered stdout per session to apply backpressure and batching
    // Rationale:
    // - Limit per-tick flush to ~64KB to prevent starving the event loop
    // - Cap in-memory backlog at ~1MB per session to avoid unbounded growth
    // These thresholds trade peak throughput for UI responsiveness and stability.
    this._stdoutBuffers = new Map(); // Map<sessionId, {chunks: string[], totalBytes: number, scheduled: boolean}>
    // No global activity monitor; per-session timers handle transitions
  }

  async createSession(options) {
    logger.info(`SessionManager: Creating new session with options: ${JSON.stringify({
      command: options.command,
      working_directory: options.working_directory,
      template_id: options.template_id,
      template_name: options.template_name,
      interactive: options.interactive,
      created_by: options.created_by
    }, null, 2)}`);

    const session = new TerminalSession(options);
    
    logger.info(`SessionManager: TerminalSession instance created with id: ${session.session_id}`);
    
    // Set termination callback
    session.onTerminated = (sessionId) => {
      logger.info(`SessionManager: Session ${sessionId} terminated, invoking callback`);
      if (this.onSessionTerminated) {
        this.onSessionTerminated(sessionId);
      }
    };

    logger.info(`SessionManager: About to create PTY process for session ${session.session_id}`);
    await session.createPtyProcess();
    
    this.sessions.set(session.session_id, session);

    // Register alias when provided and valid (safe slug)
    try {
      const aliasRaw = options && typeof options.session_alias === 'string' ? options.session_alias.trim() : '';
      if (aliasRaw) {
        this.registerAlias(aliasRaw, session.session_id);
        session.session_alias = aliasRaw;
      }
    } catch (_) { /* non-fatal */ }
    logger.info(`SessionManager: Session ${session.session_id} added to sessions map. Total sessions: ${this.sessions.size}`);
    // Seed transient activity flag based on current computed state
    try {
      const now = Date.now();
      const last = Date.parse(session.last_output_at || session.created_at || new Date().toISOString());
      const delta = now - last;
      const thresh = Number.isFinite(Number(config.SESSION_ACTIVITY_INACTIVE_AFTER_MS))
        ? Number(config.SESSION_ACTIVITY_INACTIVE_AFTER_MS)
        : 10000;
      session._outputActive = delta <= thresh;
    } catch (_) { session._outputActive = false; }

    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  async getSessionIncludingTerminated(sessionId, options = {}) {
    const { loadFromDisk = true } = options || {};

    const activeSession = this.sessions.get(sessionId);
    if (activeSession) {
      return activeSession;
    }

    const terminatedSession = terminatedSessions.get(sessionId);
    if (terminatedSession) {
      return terminatedSession;
    }

    if (loadFromDisk) {
      await this.loadTerminatedSessionsFromDisk();
      return terminatedSessions.get(sessionId) || null;
    }

    return null;
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  getActiveSessions() {
    return Array.from(this.sessions.values()).filter(session => session.is_active);
  }

  // Generate HTML history for a terminated session using an external pty-to-html helper.
  // Always respects the configured timeout and never deletes the .log file on failure.
  async generateHtmlHistoryForSession(session, helperPath) {
    if (!session || !helperPath) return;
    try {
      const logsDir = session.script_logs_dir;
      const logFile = session.script_log_file
        ? path.join(logsDir, session.script_log_file)
        : null;
      if (!logFile) {
        try { logger.warning(`[SessionManager] HTML history: missing log file path for session ${session.session_id}`); } catch (_) {}
        return;
      }

      const htmlFile = path.join(logsDir, `${session.session_id}.html`);
      const tmpFile = `${htmlFile}.tmp`;

      const cols = (session.terminal_size && Number.isFinite(Number(session.terminal_size.cols)))
        ? Math.max(1, Math.floor(Number(session.terminal_size.cols)))
        : (Number.isFinite(Number(config.DEFAULT_COLS)) ? Math.floor(Number(config.DEFAULT_COLS)) : 80);
      const rows = (session.terminal_size && Number.isFinite(Number(session.terminal_size.rows)))
        ? Math.max(1, Math.floor(Number(session.terminal_size.rows)))
        : (Number.isFinite(Number(config.DEFAULT_ROWS)) ? Math.floor(Number(config.DEFAULT_ROWS)) : 24);

      const { spawn } = await import('child_process');
      const args = ['--full', '-c', String(cols), '-r', String(rows), '-o', tmpFile, logFile];
      let stderr = '';

      await new Promise((resolve, reject) => {
        let finished = false;
        const child = spawn(helperPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        const timeoutMs = 10_000;
        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          try { child.kill('SIGKILL'); } catch (_) {}
          reject(new Error(`pty-to-html timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stderr && child.stderr.on('data', (chunk) => {
          try { stderr += String(chunk || ''); } catch (_) {}
        });

        child.on('error', (err) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          reject(err);
        });

        child.on('exit', (code, signal) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`pty-to-html exited with code ${code} signal ${signal || ''} stderr=${stderr}`));
          }
        });
      });

      // Atomically move tmp file into place
      await fs.promises.rename(tmpFile, htmlFile);

      session.history_view_mode = 'html';
      session.has_html_history = true;
      session.history_html_file = path.basename(htmlFile);

      // Optionally delete .log after successful conversion
      if (config.HISTORY_HTML_KEEP_LOG === false && session.script_log_file) {
        try {
          await fs.promises.unlink(logFile);
        } catch (e) {
          try { logger.warning(`[SessionManager] Failed to delete log file after HTML generation for ${session.session_id}: ${e?.message || e}`); } catch (_) {}
        }
      }
    } catch (e) {
      // Do not delete the .log file on failure; just record that HTML is unavailable
      try {
        logger.warning(`[SessionManager] HTML history generation failed for session ${session?.session_id}: ${e?.message || e}`);
      } catch (_) {}
      try {
        if (session) {
          session.history_view_mode = 'html';
          session.has_html_history = false;
          session.history_html_file = null;
        }
      } catch (_) {}
    }
  }

  async terminateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Before terminating the parent, locate and terminate any active child sessions
      try {
        const childIds = [];
        for (const [sid, s] of this.sessions) {
          try {
            if (s && s.parent_session_id && String(s.parent_session_id) === String(sessionId)) {
              childIds.push(sid);
            }
          } catch (_) { /* ignore */ }
        }
        if (childIds.length > 0) {
          try { logger.info(`Terminating ${childIds.length} child session(s) for parent ${sessionId}: ${childIds.join(', ')}`); } catch (_) {}
          for (const cid of childIds) {
            try {
              await this.terminateSession(cid);
            } catch (e) {
              try { logger.warning(`Failed to terminate child session ${cid} for parent ${sessionId}: ${e?.message || e}`); } catch (_) {}
            }
          }
        }
      } catch (_) { /* best-effort child cleanup */ }
      // Ensure alias is unregistered for this session
      try { this.unregisterAliasesForSession(sessionId); } catch (_) {}
      // Check if already being terminated; allow cleanup even after PTY exit
      if (session._isTerminating) {
        logger.debug(`Session ${sessionId} is already terminating`);
        return false;
      }
      
      // Mark as terminating to prevent duplicate termination and cleanup
      session._isTerminating = true;
      
      // Terminate and wait briefly for history to flush
      session.terminate();
      try {
        await session.finalizeHistory(1000);
      } catch (_) {}

      // Best-effort cleanup of ephemeral bind-mounted host files for this session.
      try {
        const mounts = Array.isArray(session.ephemeral_bind_mounts) ? session.ephemeral_bind_mounts : [];
        if (mounts.length > 0 && String(session.container_runtime || '').toLowerCase() === 'podman') {
          try { logger.debug && logger.debug(`Cleaning ${mounts.length} ephemeral bind-mounted file(s) for session ${sessionId}`); } catch (_) {}
          const unique = Array.from(new Set(mounts.filter(p => typeof p === 'string' && p.trim())));
          for (const p of unique) {
            try {
              const trimmed = String(p).trim();
              if (!trimmed) continue;
              // Best-effort existence check; ignore result
              await fs.promises.access(trimmed).catch(() => null);
              const { execFile } = await import('child_process');
              const { promisify } = await import('util');
              const execFileAsyncLocal = promisify(execFile);
              try {
                // Use podman unshare to remove files/directories created via rootless user namespace mappings.
                await execFileAsyncLocal('podman', ['unshare', 'rm', '-rf', '--', trimmed], { timeout: 10_000 });
                try { logger.debug && logger.debug(`Ephemeral bind-mounted file removed for session ${sessionId}: ${trimmed}`); } catch (_) {}
              } catch (e) {
                try { logger.warning(`Failed to clean ephemeral bind-mounted file for session ${sessionId}: ${trimmed} (${e?.message || e})`); } catch (_) {}
              }
            } catch (_) { /* ignore per-file errors */ }
          }
        }
      } catch (_) { /* best-effort bind mount cleanup */ }

      // Best-effort cleanup of ephemeral .env.custom files containing sensitive template env vars.
      // The run.sh script deletes these on startup, but if the session fails to start or
      // crashes before run.sh executes, they may persist on disk.
      // Note: .env files are now persistent (contain system vars for login sessions).
      try {
        const sessionsBase = path.isAbsolute(config.SESSIONS_DIR)
          ? config.SESSIONS_DIR
          : path.join(process.cwd(), config.SESSIONS_DIR);
        const envPaths = [
          path.join(sessionsBase, sessionId, 'workspace', '.bootstrap', 'scripts', '.env.custom'),
          path.join(sessionsBase, sessionId, 'bootstrap', 'scripts', '.env.custom')
        ];
        for (const envPath of envPaths) {
          try {
            await fs.promises.unlink(envPath);
            try { logger.debug && logger.debug(`Removed ephemeral .env.custom file for session ${sessionId}: ${envPath}`); } catch (_) {}
          } catch (e) {
            // Ignore ENOENT (already deleted by run.sh or never created)
            if (e?.code !== 'ENOENT') {
              try { logger.debug && logger.debug(`Could not remove .env.custom for session ${sessionId}: ${e?.message || e}`); } catch (_) {}
            }
          }
        }
      } catch (_) { /* best-effort .env.custom cleanup */ }

      // Save terminated session for history access (initial metadata write)
      if (session.save_session_history && !terminatedSessions.has(sessionId)) {
        terminatedSessions.set(sessionId, session);
        // Always overwrite metadata on termination to ensure correctness
        await this.saveTerminatedSessionMetadata(session, { force: true });
      }

      // Optional HTML history generation for terminated sessions
      try {
        const mode = String(config.TERMINATED_HISTORY_VIEW_MODE || 'text').trim().toLowerCase();
        if (session.save_session_history && mode === 'html') {
          session.history_view_mode = 'html';
          session.has_html_history = false;
          session.history_html_file = null;

          const helperPath = (config.PTY_TO_HTML_PATH || '').trim();
          if (!helperPath) {
            try {
              logger.warning(`[SessionManager] TERMINATED_HISTORY_VIEW_MODE=html but PTY_TO_HTML_PATH is not configured; HTML history unavailable for session ${sessionId}`);
            } catch (_) {}
          } else {
            await this.generateHtmlHistoryForSession(session, helperPath);
          }
          // Persist updated HTML history metadata (whether success or failure)
          await this.saveTerminatedSessionMetadata(session, { force: true });
        } else if (session.save_session_history) {
          // Explicitly record text mode for new metadata
          session.history_view_mode = 'text';
          session.has_html_history = false;
          session.history_html_file = null;
          await this.saveTerminatedSessionMetadata(session, { force: true });
        }
      } catch (e) {
        try {
          logger.warning(`[SessionManager] HTML history flow failed for session ${sessionId}: ${e?.message || e}`);
        } catch (_) {}
      }

      // Cleanup per-session artifacts directory unless retention is requested
      try {
        const sessionArtifactsDir = path.join(session.script_logs_dir, sessionId);
        if (session.save_workspace_dir === true || session.save_bootstrap_dir === true) {
          try { logger.info(`Retaining session artifacts directory for ${sessionId} as requested`); } catch (_) {}
        } else {
          await fs.promises.rm(sessionArtifactsDir, { recursive: true, force: true });
        }
      } catch (_) { /* ignore */ }
      
      // Remove from active sessions
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  async saveTerminatedSessionMetadata(session, opts = {}) {
    const { force = false } = opts || {};
    try {
      const metadataPath = path.join(session.script_logs_dir, `${session.session_id}.json`);
      
      // Check if metadata file already exists
      if (!force) {
        try {
          await fs.promises.access(metadataPath);
          logger.debug(`Metadata file already exists for session ${session.session_id}, skipping write`);
          return;
        } catch (err) {
          // File doesn't exist, proceed with writing
        }
      }
      
      const metadata = {
        session_id: session.session_id,
        session_alias: session.session_alias || null,
        command: session.command,
        command_preview: session.command_preview,
        working_directory: session.working_directory,
        created_at: session.created_at,
        last_output_at: session.last_output_at,
        created_by: session.created_by,
        ended_at: session.ended_at,
        exit_code: session.exit_code,
        terminal_size: session.terminal_size,
        script_log_file: session.script_log_file,
        title: session.title,
        dynamic_title: session.dynamic_title,
        visibility: session.visibility || 'private',
        interactive: session.interactive,
        load_history: session.load_history,
        save_session_history: session.save_session_history,
        links: session.links,
        template_id: session.template_id,
        template_name: session.template_name,
        template_badge_label: session.template_badge_label || null,
        isolation_mode: session.isolation_mode || 'none',
        container_name: session.container_name || null,
        container_runtime: session.container_runtime || null,
        parent_session_id: session.parent_session_id || null,
        template_parameters: session.template_parameters,
        workspace: session.workspace,
        workspace_order: session.workspace_order,
        workspace_service_enabled_for_session: session.workspace_service_enabled_for_session === true,
        workspace_service_port: (function normalizePort() {
          const n = Number(session.workspace_service_port);
          return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
        })(),
        is_fork: session.is_fork === true,
        forked_from_session_id: session.forked_from_session_id || null,
        stop_inputs_enabled: session.stop_inputs_enabled !== false,
        stop_inputs: Array.isArray(session.stop_inputs) ? session.stop_inputs : [],
        stop_inputs_rearm_remaining: (() => {
          const n = Number(session.stop_inputs_rearm_remaining);
          return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
        })(),
        note: typeof session.note === 'string' ? session.note : '',
        note_version: Number.isInteger(session.note_version) ? session.note_version : 0,
        note_updated_at: session.note_updated_at || null,
        note_updated_by: session.note_updated_by || null,
        ephemeral_bind_mounts: Array.isArray(session.ephemeral_bind_mounts) ? session.ephemeral_bind_mounts : [],
        // Deprecated: do not persist activity transitions; client renders markers from in-band inputs
        activity_transitions: [],
        capture_activity_transitions: false,
        // Persist ordinal input markers
        input_markers: Array.isArray(session.inputMarkers) ? session.inputMarkers : [],
        // Persist client render markers
        render_markers: Array.isArray(session.renderMarkers) ? session.renderMarkers : [],
        // HTML history metadata for terminated sessions
        history_view_mode: session.history_view_mode === 'html' ? 'html' : 'text',
        has_html_history: session.has_html_history === true,
        history_html_file: session.history_html_file || null
      };
      
      // Write to a temporary file first, then rename atomically
      const tempPath = `${metadataPath}.tmp`;
      await fs.promises.writeFile(tempPath, JSON.stringify(metadata, null, 2), { flag: 'w' });
      await fs.promises.rename(tempPath, metadataPath);
      
      logger.debug(`Saved metadata for terminated session ${session.session_id}${force ? ' (force)' : ''}`);
    } catch (error) {
      logger.error(`Failed to save metadata for terminated session ${session.session_id}: ${error.message}`);
    }
  }

  async getAllSessionsIncludingTerminated() {
    // Load terminated sessions from disk first so the initial call already contains them.
    await this.loadTerminatedSessionsFromDisk();

    const allSessions = [...this.getAllSessions()];

    // Add terminated sessions from memory (now populated with any newly loaded sessions).
    for (const session of terminatedSessions.values()) {
      allSessions.push(session);
    }

    // Sort by created_at descending (newest first)
    allSessions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return allSessions;
  }

  // No global monitor; transitions handled per-session
  _checkSessionActivity() { /* removed */ }

  // Cleanup timers on shutdown
  destroy() { /* no-op */ }

  async loadTerminatedSessionsFromDisk() {
    try {
      const scripLogsDir = path.isAbsolute(config.SESSIONS_DIR) 
        ? config.SESSIONS_DIR 
        : path.join(process.cwd(), config.SESSIONS_DIR);

      await fs.promises.mkdir(scripLogsDir, { recursive: true });
      const files = await fs.promises.readdir(scripLogsDir);
      const metadataFiles = files.filter(file => file.endsWith('.json'));
      
      for (const file of metadataFiles) {
        const sessionId = path.basename(file, '.json');
        
        // Skip if already in memory
        if (terminatedSessions.has(sessionId) || this.sessions.has(sessionId)) {
          continue;
        }
        
        try {
          const metadataPath = path.join(scripLogsDir, file);
          const metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
          
          // Create terminated session object
          const session = new TerminalSession({
            session_id: metadata.session_id,
            session_alias: metadata.session_alias || null,
            command: metadata.command,
            working_directory: metadata.working_directory,
            created_by: metadata.created_by,
            // Default to 'private' when legacy metadata lacks explicit visibility
            visibility: (typeof metadata.visibility === 'string' && metadata.visibility) || (metadata.is_private === true ? 'private' : 'private'),
            title: metadata.title,
            dynamic_title: metadata.dynamic_title,
            interactive: metadata.interactive,
            load_history: metadata.load_history,
            save_session_history: metadata.save_session_history,
            links: metadata.links || [],
            template_id: metadata.template_id,
            template_name: metadata.template_name,
            isolation_mode: metadata.isolation_mode || 'none',
            container_name: metadata.container_name || null,
            container_runtime: metadata.container_runtime || null,
            parent_session_id: metadata.parent_session_id || null,
            template_parameters: metadata.template_parameters || {},
            workspace: metadata.workspace || 'Default',
            workspace_order: typeof metadata.workspace_order === 'number' ? metadata.workspace_order : null,
            workspace_service_enabled_for_session: metadata.workspace_service_enabled_for_session === true,
            workspace_service_port: (function normalizePort() {
              const n = Number(metadata.workspace_service_port);
              return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
            })(),
            note: typeof metadata.note === 'string' ? metadata.note : '',
            note_version: Number.isInteger(metadata.note_version) ? metadata.note_version : 0,
            note_updated_at: metadata.note_updated_at || null,
            note_updated_by: metadata.note_updated_by || null,
            ephemeral_bind_mounts: Array.isArray(metadata.ephemeral_bind_mounts) ? metadata.ephemeral_bind_mounts : [],
            stop_inputs_enabled: metadata.stop_inputs_enabled === false ? false : true,
            stop_inputs: Array.isArray(metadata.stop_inputs) ? metadata.stop_inputs : [],
            stop_inputs_rearm_remaining: (() => {
              const n = Number(metadata.stop_inputs_rearm_remaining);
              return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
            })(),
            history_view_mode: metadata.history_view_mode === 'html' ? 'html' : 'text',
            has_html_history: metadata.has_html_history === true,
            history_html_file: (typeof metadata.history_html_file === 'string' && metadata.history_html_file.trim())
              ? metadata.history_html_file.trim()
              : null
          });
          
          session.created_at = metadata.created_at;
          session.last_output_at = metadata.last_output_at || metadata.created_at;
          session.ended_at = metadata.ended_at;
          session.exit_code = metadata.exit_code;
          session.terminal_size = metadata.terminal_size || { cols: 80, rows: 24 };
          session.is_active = false;
          session.script_log_file = metadata.script_log_file || `${sessionId}.log`;
          session.history_view_mode = metadata.history_view_mode === 'html' ? 'html' : 'text';
          session.has_html_history = metadata.has_html_history === true;
          session.history_html_file = (typeof metadata.history_html_file === 'string' && metadata.history_html_file.trim())
            ? metadata.history_html_file.trim()
            : null;
          // Do not register alias for terminated sessions; mapping is runtime-only
          
          // Deprecated: ignore persisted activity transitions; timeline uses in-band markers
          try {
            session.activityTransitions = [];
            session.capture_activity_transitions = false;
            // Restore input markers if present
            if (Array.isArray(metadata.input_markers)) {
              session.inputMarkers = metadata.input_markers;
              session._nextInputMarkerIdx = session.inputMarkers.length;
            } else {
              session.inputMarkers = [];
              session._nextInputMarkerIdx = 0;
            }
          } catch (_) {}
          terminatedSessions.set(sessionId, session);
        } catch (error) {
          logger.warning(`Failed to load terminated session metadata from ${file}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`Failed to load terminated sessions from disk: ${error.message}`);
    }
  }

  // Alias helpers
  registerAlias(alias, sessionId) {
    try {
      const a = String(alias || '').trim();
      const id = String(sessionId || '').trim();
      if (!a || !id) return false;
      // Enforce safe slug
      const ok = /^[A-Za-z0-9._-]+$/.test(a);
      if (!ok) return false;
      // Remove old mapping for this alias if any
      const prevId = this._aliasToId.get(a);
      if (prevId && prevId !== id) {
        this._aliasToId.delete(a);
        const prevAlias = this._idToAlias.get(prevId);
        if (prevAlias === a) this._idToAlias.delete(prevId);
      }
      // Only one alias per session: remove existing alias for this id
      const existingForId = this._idToAlias.get(id);
      if (existingForId && existingForId !== a) {
        this._aliasToId.delete(existingForId);
      }
      this._aliasToId.set(a, id);
      this._idToAlias.set(id, a);
      return true;
    } catch (_) { return false; }
  }

  unregisterAliasesForSession(sessionId) {
    try {
      const id = String(sessionId || '').trim();
      const alias = this._idToAlias.get(id);
      if (alias) {
        this._aliasToId.delete(alias);
        this._idToAlias.delete(id);
      }
    } catch (_) {}
  }

  resolveIdFromAliasOrId(idOrAlias) {
    try {
      const key = String(idOrAlias || '').trim();
      if (!key) return key;
      // If a session with this id exists (active or terminated in memory), return as-is
      if (this.sessions.has(key)) return key;
      // No lookup for terminated sessions by alias; aliases are runtime-only
      const mapped = this._aliasToId.get(key);
      return mapped || key;
    } catch (_) { return idOrAlias; }
  }

  async getSessionHistory(sessionId) {
    // Check active sessions first
    const activeSession = this.sessions.get(sessionId);
    if (activeSession) {
      return activeSession.getHistory();
    }
    
    // Check terminated sessions in memory
    const terminatedSession = terminatedSessions.get(sessionId);
    if (terminatedSession) {
      // Read output history from file if available
      if (terminatedSession.script_log_file) {
        try {
          const logPath = path.join(terminatedSession.script_logs_dir, terminatedSession.script_log_file);
          const outputHistory = await fs.promises.readFile(logPath, 'utf8');
          terminatedSession.outputHistory = outputHistory;
        } catch (error) {
          logger.warning(`Could not read log file for session ${sessionId}: ${error.message}`);
        }
      }
      return terminatedSession.getHistory();
    }
    
    // Try to load from disk
    await this.loadTerminatedSessionsFromDisk();
    const diskSession = terminatedSessions.get(sessionId);
    if (diskSession) {
      // Read output history from file
      if (diskSession.script_log_file) {
        try {
          const logPath = path.join(diskSession.script_logs_dir, diskSession.script_log_file);
          const outputHistory = await fs.promises.readFile(logPath, 'utf8');
          diskSession.outputHistory = outputHistory;
        } catch (error) {
          logger.warning(`Could not read log file for session ${sessionId}: ${error.message}`);
        }
      }
      return diskSession.getHistory();
    }
    
    return null;
  }

  async deleteSessionHistory(sessionId) {
    // Check if session exists in active sessions first
    const activeSession = this.sessions.get(sessionId);
    if (activeSession) {
      try {
        // Clear in-memory output history
        activeSession.outputHistory = '';
        // Reset sequence so future history sync starts from a clean slate
        activeSession.outputSequenceNumber = 0;
        logger.info(`Cleared in-memory history for active session ${sessionId}`);
        
        // Clear the log file if it exists and history saving is enabled
        if (activeSession.historyStream && activeSession.save_session_history) {
          try {
            // Close the current stream
            activeSession.historyStream.end();
            
            // Truncate the log file by reopening it
            const logPath = path.join(activeSession.script_logs_dir, activeSession.script_log_file);
            activeSession.historyStream = fs.createWriteStream(logPath, { flags: 'w' }); // 'w' flag truncates the file
            logger.info(`Cleared log file for active session ${sessionId}: ${logPath}`);
            // Reset markers and write a new start marker after clear
            try {
              activeSession.inputMarkers = [];
              activeSession._nextInputMarkerIdx = 0;
              activeSession.renderMarkers = [];
            } catch (_) {}
          } catch (error) {
            logger.warning(`Could not clear log file for active session ${sessionId}: ${error.message}`);
          }
        }
        
        // Reset activity transitions and render markers as well
        try { activeSession.activityTransitions = []; activeSession.renderMarkers = []; } catch (_) {}
        // Notify clients so UIs can reflect the cleared history immediately
        try {
          broadcastSessionUpdate(activeSession, 'updated');
        } catch (_) {}
        
        return true;
      } catch (error) {
        logger.error(`Error clearing history for active session ${sessionId}: ${error.message}`);
        return false;
      }
    }
    
    // Check if session exists in terminated sessions
    const terminatedSession = terminatedSessions.get(sessionId);
    if (terminatedSession) {
      try {
        // Delete log file
        if (terminatedSession.script_log_file) {
          const logPath = path.join(terminatedSession.script_logs_dir, terminatedSession.script_log_file);
          await fs.promises.unlink(logPath);
          logger.info(`Deleted log file: ${logPath}`);
        }
        
        // Delete metadata file
        const metadataPath = path.join(terminatedSession.script_logs_dir, `${sessionId}.json`);
        await fs.promises.unlink(metadataPath);
        logger.info(`Deleted metadata file: ${metadataPath}`);

        // Delete artifacts directory (bootstrap, home, etc.)
        try {
          const artifactsDir = path.join(terminatedSession.script_logs_dir, String(sessionId));
          await fs.promises.rm(artifactsDir, { recursive: true, force: true });
          logger.info(`Deleted artifacts directory: ${artifactsDir}`);
        } catch (e) {
          logger.warning(`Failed to delete artifacts directory for ${sessionId}: ${e?.message || e}`);
        }
        
        // Remove from memory
        terminatedSessions.delete(sessionId);
        return true;
      } catch (error) {
        logger.error(`Error deleting session history for ${sessionId}: ${error.message}`);
        return false;
      }
    }
    
    return false;
  }

  attachClientToSession(sessionId, clientId, shouldLoadHistory = false, historyMarker = null) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.attachClient(clientId);

      // Set up history synchronization if needed
      if (shouldLoadHistory && historyMarker !== null) {
        session.markClientLoadingHistory(clientId, historyMarker);
      }

      // If there is buffered output and no scheduled flush (because there were no clients yet),
      // schedule a flush now so the newly attached client receives pending data immediately.
      try {
        const state = this._stdoutBuffers.get(sessionId);
        if (state && !state.scheduled && state.totalBytes > 0) {
          state.scheduled = true;
          setImmediate(() => this._flushStdoutTick(sessionId));
        }
      } catch (_) { /* best-effort */ }

      return true;
    }
    return false;
  }

  detachClientFromSession(sessionId, clientId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.detachClient(clientId);
      return true;
    }
    return false;
  }

  cleanupClientSessions(clientId) {
    const affectedSessionIds = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.connected_clients.has(clientId)) {
        session.detachClient(clientId);
        affectedSessionIds.push(sessionId);
      }
    }
    return affectedSessionIds;
  }

  setSessionTerminatedCallback(callback) {
    this.onSessionTerminated = callback;
  }

  setOutputBroadcaster(broadcaster) {
    this.outputBroadcaster = broadcaster;
  }

  broadcastSessionOutput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Optional verbose logging of PTY stdout over WebSocket
    try {
      if (config.DEBUG_WS_STDOUT) {
        const raw = (typeof data === 'string') ? data : String(data ?? '');
        const preview = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
        logger.debug(`[WS STDOUT] enqueue session ${sessionId} (${raw.length} chars); clients=${session.connected_clients.size}: ${JSON.stringify(preview)}`);
      }
    } catch (_) { /* best-effort only */ }

    // Enqueue into per-session buffer and schedule a flush tick
    const state = this._stdoutBuffers.get(sessionId) || { chunks: [], totalBytes: 0, scheduled: false };
    const str = (typeof data === 'string') ? data : String(data ?? '');
    const bytes = Buffer.byteLength(str, 'utf8');
    state.chunks.push(str);
    state.totalBytes += bytes;

    // Memory ceiling: drop oldest data if backlog exceeds ~1MB
    const MAX_BACKLOG_BYTES = 1024 * 1024; // 1MB per session
    if (state.totalBytes > MAX_BACKLOG_BYTES) {
      // Trim from the head until under cap
      let trimmed = 0;
      while (state.totalBytes > MAX_BACKLOG_BYTES && state.chunks.length > 0) {
        const first = state.chunks[0];
        const firstBytes = Buffer.byteLength(first, 'utf8');
        state.chunks.shift();
        state.totalBytes -= firstBytes;
        trimmed += firstBytes;
      }
      try { logger.warning(`[SessionManager] Backlog cap reached for ${sessionId}; dropped ~${trimmed} bytes`); } catch (_) {}
      try {
        // Notify currently attached clients about dropped bytes so UIs can surface it
        for (const clientId of session.connected_clients) {
          if (global.connectionManager) {
            global.connectionManager.sendToClient(clientId, {
              type: 'stdout_dropped',
              session_id: sessionId,
              dropped_bytes: trimmed,
              backlog_bytes: state.totalBytes
            });
          }
        }
      } catch (_) { /* best-effort */ }
    }

    this._stdoutBuffers.set(sessionId, state);
    const hasClients = session.connected_clients && session.connected_clients.size > 0;
    if (hasClients) {
      if (!state.scheduled) {
        state.scheduled = true;
        // Flush on next tick to coalesce bursts
        setImmediate(() => this._flushStdoutTick(sessionId));
      }
    } else {
      // No clients yet: keep backlog buffered and wait for first attach to trigger a flush.
      state.scheduled = false;
    }
  }

  _flushStdoutTick(sessionId) {
    const session = this.sessions.get(sessionId);
    const state = this._stdoutBuffers.get(sessionId);
    if (!session || !state) return;

    const MAX_FLUSH_BYTES = 64 * 1024; // 64KB per tick to avoid starving event loop

    // Build a chunk up to MAX_FLUSH_BYTES
    const parts = [];
    let used = 0;
    while (state.chunks.length > 0 && used < MAX_FLUSH_BYTES) {
      const s = state.chunks[0];
      const bl = Buffer.byteLength(s, 'utf8');
      const remaining = MAX_FLUSH_BYTES - used;
      if (bl <= remaining) {
        parts.push(s);
        used += bl;
        state.chunks.shift();
        state.totalBytes -= bl;
      } else {
        // Split string to fit remaining bytes (binary search on char count)
        let low = 0;
        let high = Math.min(s.length, remaining);
        while (low < high) {
          const mid = (low + high + 1) >> 1;
          const size = Buffer.byteLength(s.slice(0, mid), 'utf8');
          if (size <= remaining) low = mid; else high = mid - 1;
        }
        const take = s.slice(0, low);
        if (take) {
          parts.push(take);
          const takenBytes = Buffer.byteLength(take, 'utf8');
          used += takenBytes;
          state.chunks[0] = s.slice(low);
          state.totalBytes -= takenBytes;
        } else {
          // Fallback: avoid infinite loop if we cannot slice (should not happen)
          parts.push(s);
          state.chunks.shift();
          state.totalBytes -= bl;
          used += bl;
        }
        break;
      }
    }

    const payload = parts.join('');
    if (payload) {
      const currentSequenceNumber = session.outputSequenceNumber;
      for (const clientId of session.connected_clients) {
        if (session.shouldQueueOutputForClient(clientId, currentSequenceNumber)) {
          session.queueOutputForClient(clientId, payload);
          logger.debug(`[SessionManager] Queued batched output for client ${clientId} (seq: ${currentSequenceNumber}, bytes=${used})`);
        } else if (global.connectionManager) {
          global.connectionManager.sendToClient(clientId, {
            type: 'stdout',
            session_id: sessionId,
            data: payload
          });
        }
      }
    }

    // Schedule another tick if backlog remains; otherwise clear scheduled flag
    if (state.chunks.length > 0 && state.totalBytes > 0) {
      setImmediate(() => this._flushStdoutTick(sessionId));
    } else {
      state.scheduled = false;
      // Clean up empty state to prevent leaks
      if (state.chunks.length === 0 && state.totalBytes <= 0) {
        this._stdoutBuffers.delete(sessionId);
      }
    }
  }
}
