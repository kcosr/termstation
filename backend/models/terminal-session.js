/**
 * Terminal Session Model
 * Represents a single terminal session with PTY process management
 */

import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { parse as parseShellCommand, quote as quoteShellCommand } from 'shell-quote';
import { config } from '../config-loader.js';
import { parseOscTitles } from '../../shared/terminal/osc-parser.js';
import { detectControlOnlySequences } from '../../shared/terminal/control-sequence-detector.js';
import { logger } from '../utils/logger.js';
import { resolveSessionWorkspaceHostPath } from '../services/session-workspace-builder.js';
import { onSessionInactive as handleSessionInactive } from '../utils/input-deferral.js';
import { normalizeLinkForResponse } from '../utils/session-links.js';

export class TerminalSession {
  constructor(options = {}) {
    this.session_id = options.session_id || uuidv4();
    this.command = options.command || config.DEFAULT_SHELL;
    this.working_directory = options.working_directory || config.DEFAULT_WORKING_DIR;
    this.created_at = new Date().toISOString();
    this.last_activity = new Date().toISOString();
    // Tracks timestamp of last PTY output, used for activity detection
    this.last_output_at = this.created_at;
    this.is_active = false;
    this.connected_clients = new Set();
    this.title = options.title || '';
    this.interactive = options.interactive !== false; // default true
    this.load_history = options.load_history !== false; // default true
    this.save_session_history = options.save_session_history !== false; // default true
    this.links = options.links || [];
    this.command_tabs = Array.isArray(options.command_tabs) ? options.command_tabs : [];
    this.note = typeof options.note === 'string' ? options.note : '';
    this.note_version = Number.isInteger(options.note_version) && options.note_version >= 0
      ? options.note_version
      : 0;
    this.note_updated_at = options.note_updated_at || null;
    this.note_updated_by = options.note_updated_by || null;
    this.template_id = options.template_id || null;
    this.template_name = options.template_name || null;
    this.template_badge_label = options.template_badge_label || null;
    // Optional URL-safe alias for this session (registered separately by SessionManager)
    this.session_alias = (typeof options.session_alias === 'string' && options.session_alias.trim()) ? options.session_alias.trim() : null;
    this.isolation_mode = options.isolation_mode || 'none';
    // Whether to persist per-session workspace directory on end/shutdown
    this.save_workspace_dir = options.save_workspace_dir === true || options.save_bootstrap_dir === true;
    // Legacy flag retained for compatibility with existing template configs
    this.save_bootstrap_dir = options.save_bootstrap_dir === true;
    // Ephemeral bind-mounted host paths (per-session, non-persisted)
    this.ephemeral_bind_mounts = Array.isArray(options.ephemeral_bind_mounts)
      ? options.ephemeral_bind_mounts.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
      : [];
    // Container association (for sandbox or attached containers)
    this.container_name = options.container_name || null;
    this.container_runtime = options.container_runtime || null; // e.g., 'podman'
    this.parent_session_id = options.parent_session_id || null;
    // Category for child sessions (e.g., 'command') and sidebar visibility
    this.child_tab_type = options.child_tab_type || null;
    this.show_in_sidebar = options.show_in_sidebar !== false; // default true unless explicitly false
    this.template_parameters = options.template_parameters || {};
    this.workspace = options.workspace || 'Default';
    this.workspace_order = typeof options.workspace_order === 'number' ? options.workspace_order : null;
    this.workspace_service_enabled_for_session = options.workspace_service_enabled_for_session === true;
    this.workspace_service_port = Number.isFinite(Number(options.workspace_service_port))
      ? Math.floor(Number(options.workspace_service_port))
      : null;
    // Fork metadata
    this.is_fork = options.is_fork === true;
    this.forked_from_session_id = options.forked_from_session_id || null;
    // Whether to capture activity transitions for this session (per-template flag; default false)
    this.capture_activity_transitions = options.capture_activity_transitions === true;
    try {
      logger.info(`Session ${this.session_id}: capture_activity_transitions=${this.capture_activity_transitions}, load_history=${this.load_history}`);
    } catch (_) {}
    // Visibility controls
    // Support legacy boolean is_private and new visibility enum: 'private' | 'public' | 'shared_readonly'
    const providedVisibility = options.visibility;
    const legacyIsPrivate = options.is_private === true;
    // Default to 'private' per new requirements
    this.visibility = (typeof providedVisibility === 'string' && providedVisibility)
      ? providedVisibility
      : (legacyIsPrivate ? 'private' : 'private');
    
    // Dynamic title parsed from OSC sequences (server-derived; does not override user title)
    this.dynamic_title = typeof options.dynamic_title === 'string' ? options.dynamic_title : '';
    this._oscBuffer = '';
    
    // Terminal configuration
    this.terminal_size = {
      cols: options.cols || config.DEFAULT_COLS,
      rows: options.rows || config.DEFAULT_ROWS
    };
    
    // PTY process and output management
    this.ptyProcess = null;
    this.exit_code = null;
    this.created_by = options.created_by || config.DEFAULT_USERNAME;
    this.outputBroadcaster = null; // Reference to broadcast function
    this.ended_at = null;
    this._isTerminating = false; // Flag to prevent duplicate termination
    this.outputHistory = ''; // In-memory output history
    this.historyStream = null; // File write stream for logging
    // Carry buffer for control-sequence detection across chunk boundaries
    this._controlSeqCarry = '';
    // Ordinal input markers (idx, t, kind)
    this.inputMarkers = Array.isArray(options.input_markers) ? options.input_markers : [];
    this._nextInputMarkerIdx = Number.isInteger(options._nextInputMarkerIdx) ? options._nextInputMarkerIdx : (this.inputMarkers.length || 0);
    // Timestamp of last PTY resize for resize-induced output suppression
    this._lastResizeAt = 0;
    this._inactivityTimer = null; // Timer to flip to inactive after quiet period

    // Synchronization for history loading
    this.outputSequenceNumber = 0; // Incremental counter for output chunks
    this.clientHistorySync = new Map(); // Track which clients are loading history

    // Stop inputs configuration.
    this.stop_inputs_enabled = options.stop_inputs_enabled === false ? false : true;
    const resolveRearmMax = () => {
      try {
        const n = Number(config.STOP_INPUTS_REARM_MAX);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
      } catch (_) {
        return 10;
      }
    };
    const clampRearm = (value) => {
      const max = resolveRearmMax();
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return 0;
      const v = Math.floor(n);
      return v > max ? max : v;
    };
    this.stop_inputs = (function resolveStopInputs(opts) {
      const raw = Array.isArray(opts.stop_inputs) ? opts.stop_inputs : [];
      return raw.map((p) => {
        try {
          if (!p) return null;
          const prompt = typeof p.prompt === 'string' ? p.prompt : '';
          if (!prompt) return null;
          const id = (typeof p.id === 'string' && p.id.trim()) ? p.id.trim() : uuidv4();
          const armed = p.armed === false ? false : true;
          const source = p.source === 'template' || p.source === 'user' ? p.source : 'template';
          return { id, prompt, armed, source };
        } catch (_) {
          return null;
        }
      }).filter(Boolean);
    })(options);
    this.stop_inputs_rearm_remaining = clampRearm(
      Object.prototype.hasOwnProperty.call(options, 'stop_inputs_rearm_remaining')
        ? options.stop_inputs_rearm_remaining
        : (Object.prototype.hasOwnProperty.call(options, 'stop_inputs_rearm')
          ? options.stop_inputs_rearm
          : 0)
    );
    try {
      logger.info(`Session ${this.session_id}: initialized stop_inputs=${JSON.stringify(this.stop_inputs || [])}`);
    } catch (_) {}

    // Timestamp of last user-initiated input (used to gate stop_inputs injection after recent activity)
    this.last_user_input_at = 0;

    // API input accounting (counts messages received via HTTP input API)
    this.api_stdin_message_count = 0;
    // Scheduled input accounting (counts messages delivered via scheduler rules)
    this.scheduled_input_message_count = 0;
    // Server-side transient flag for activity transitions (not serialized)
    this._outputActive = false;
    // Activity transition tracking (active-only). Each entry marks when output becomes active again.
    // Format: { t: epochMs, state: 'active', char_offset: number, seq: number }
    this.activityTransitions = [];
    this._maxTransitions = Number.isInteger(Number(config.MAX_ACTIVITY_TRANSITIONS))
      ? Number(config.MAX_ACTIVITY_TRANSITIONS)
      : 10000;
    // Pending active transition gating
    this._pendingActiveTransition = null; // { offset, t, seqAtStart, bytes }
    this._activeBurstBytes = 0;

    // Client-reported render markers (timestamp + line)
    this.renderMarkers = Array.isArray(options.render_markers) ? options.render_markers : [];
    
    // Script logging
    this.script_logs_dir = path.isAbsolute(config.SESSIONS_DIR) 
      ? config.SESSIONS_DIR 
      : path.join(process.cwd(), config.SESSIONS_DIR);
    this.script_log_file = `${this.session_id}.log`;

    // History view mode / HTML history metadata
    this.history_view_mode = (options.history_view_mode === 'html') ? 'html' : 'text';
    this.has_html_history = options.has_html_history === true;
    this.history_html_file = (typeof options.history_html_file === 'string' && options.history_html_file.trim())
      ? options.history_html_file.trim()
      : null;
    
    // Ensure script logs directory exists
    if (!fs.existsSync(this.script_logs_dir)) {
      fs.mkdirSync(this.script_logs_dir, { recursive: true });
    }

    // Ensure template-defined links have stable backend-assigned IDs.
    this._ensureTemplateLinkIds();
  }

  async createPtyProcess() {
    try {
      logger.info(`Creating PTY process for session ${this.session_id}:`);
      logger.info(`  Command: ${this.command}`);
      logger.info(`  Working Directory: ${this.working_directory}`);
      logger.info(`  Interactive: ${this.interactive}`);
      logger.info(`  Terminal Size: ${this.terminal_size.cols}x${this.terminal_size.rows}`);

      // Set up environment
      const env = {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        COLUMNS: this.terminal_size.cols.toString(),
        LINES: this.terminal_size.rows.toString(),
        SESSION_ID: this.session_id,
        TERMSTATION_USER: this.created_by,
        SESSIONS_BASE_URL: config.SESSIONS_BASE_URL
      };

      // For host sessions (non-container) without a per-session bootstrap, make
      // backend-managed bootstrap tools available by appending backend/bootstrap/bin
      // to PATH. This helps direct host shells resolve helper scripts.
      try {
        if (String(this.isolation_mode || 'none') !== 'container') {
          const bootstrapDir = path.join(__dirname, '..', 'bootstrap');
          const toolsDir = path.join(bootstrapDir, 'bin');
          try {
            const st = fs.statSync(toolsDir);
            if (st && st.isDirectory()) {
              const currentPath = String(env.PATH || process.env.PATH || '');
              env.PATH = currentPath ? `${currentPath}:${toolsDir}` : toolsDir;
              // Expose BOOTSTRAP_DIR (base) for host sessions
              env.BOOTSTRAP_DIR = bootstrapDir;
            }
          } catch (_) { /* optional */ }
        }
      } catch (_) { /* optional */ }

      // Resolve/validate working directory for PTY spawn (host-side)
      let effectiveCwd = this.working_directory;
      try {
        const expandHome = (p) => {
          if (!p || typeof p !== 'string') return p;
          if (p === '$HOME') return os.homedir();
          if (p.startsWith('$HOME/')) return path.join(os.homedir(), p.slice(6));
          return p;
        };
        effectiveCwd = expandHome(String(effectiveCwd || '')) || '';
        // For directory isolation, ensure the workspace path exists; do not relocate
        if (String(this.isolation_mode || 'none') === 'directory') {
          try { if (effectiveCwd) fs.mkdirSync(effectiveCwd, { recursive: true }); } catch (_) {}
        }
        // If the final path does not exist (and we are not creating it), reject
        if (!effectiveCwd || !fs.existsSync(effectiveCwd)) {
          const msg = `Working directory does not exist: '${this.working_directory}' (resolved: '${effectiveCwd || ''}')`;
          logger.warning(`Session ${this.session_id}: ${msg}`);
          throw new Error(msg);
        }
      } catch (e) {
        // Propagate a clear error so the route returns an error to the client
        throw e;
      }

      // Parse command using shell-quote for proper argument handling
      let shell, args;
      if (this.command === config.DEFAULT_SHELL) {
        shell = config.DEFAULT_SHELL;
        args = [];
        logger.info(`  Using default shell: ${shell} (no args)`);
      } else {
        // Parse the command using shell-quote to handle complex arguments properly
        const parsedArgs = parseShellCommand(this.command);
        logger.info(`  Parsed command args: [${parsedArgs.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : `"${arg}"`).join(', ')}]`);
        
        // For complex commands or commands with multiple arguments, use shell wrapper
        // This ensures proper environment variable expansion, pipes, redirections, etc.
        if (parsedArgs.length > 1 || this.command.includes('|') || this.command.includes('>') || 
            this.command.includes('<') || this.command.includes('$') || this.command.includes('&')) {
          shell = config.DEFAULT_SHELL;
          if (os.platform() === 'win32') {
            args = ['/c', this.command];
          } else {
            // Check if parsedArgs contains objects (like shell operators)
            // If so, use the original command string instead of trying to quote parsed args
            const hasObjects = parsedArgs.some(arg => typeof arg === 'object');
            if (hasObjects) {
              // Use original command string directly when shell-quote parsed objects
              args = ['-c', this.command];
              logger.info(`  Using original command string due to shell operators: ${shell} -c "${this.command}"`);
            } else {
              // Use shell-quote to properly escape the command for shell execution
              // This prevents quote conflicts when passing complex commands to bash -c
              const quotedCommand = quoteShellCommand(parsedArgs);
              args = ['-c', quotedCommand];
              logger.info(`  Using shell wrapper for complex command: ${shell} -c ${args[1]}`);
            }
          }
        } else {
          // Simple single command - execute directly for better argument preservation
          shell = parsedArgs[0];
          args = parsedArgs.slice(1);
          logger.info(`  Direct execution: ${shell} [${args.join(', ')}]`);
        }
      }

      // Create PTY process
      logger.info(`  Spawning PTY: shell=${shell}, args=[${args.join(', ')}], cwd=${this.working_directory}`);
      
      this.ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: this.terminal_size.cols,
        rows: this.terminal_size.rows,
        cwd: effectiveCwd,
        env: env,
        handleFlowControl: true
      });

      this.is_active = true;
      this.updateActivity();
      // Mark output as active and arm the inactivity timer even before the
      // first PTY output chunk so that deferred inputs and stop_inputs can
      // flush after the configured quiet period, even for sessions that
      // produce no initial output.
      this._outputActive = true;
      try {
        this.armInactivityTimer();
      } catch (_) {}

      logger.info(`Session ${this.session_id} process created successfully with PID: ${this.ptyProcess.pid}`);

      // Handle process exit
      this.ptyProcess.onExit(({ exitCode, signal }) => {
        logger.info(`Session ${this.session_id} process exited with code: ${exitCode}, signal: ${signal}`);
        if (exitCode !== 0) {
          logger.warning(`Session ${this.session_id} exited with non-zero code: ${exitCode}`);
        }
        this.exit_code = exitCode;
        this.is_active = false;
        
        // Notify session manager about termination
        if (this.onTerminated) {
          this.onTerminated(this.session_id);
        }
      });

      // Set up centralized output broadcasting - ONE handler per session
      this.ptyProcess.onData((data) => {
        // Capture offset BEFORE appending so active transition anchors to first byte of this burst
        let offsetBeforeOutput = 0;
        try { offsetBeforeOutput = this.outputHistory.length; } catch (_) { offsetBeforeOutput = 0; }
        // Log output to history with sequence tracking
        this.logOutput(data);
        // Run control sequence detector to decide if this chunk is control-only
        let controlOnly = false;
        try {
          const det = detectControlOnlySequences(data, this._controlSeqCarry || '');
          this._controlSeqCarry = det?.carry || '';
          controlOnly = !!det?.isControlOnly;
          
        } catch (_) { controlOnly = false; }
        // Suppress activity for a short window after a PTY resize (resize-induced redraw)
        let suppressForResize = false;
        try {
          const suppressMs = Number(config.SESSION_ACTIVITY_SUPPRESS_AFTER_RESIZE_MS) || 0;
          if (suppressMs > 0 && this._lastResizeAt) {
            const age = Date.now() - this._lastResizeAt;
            suppressForResize = age >= 0 && age <= suppressMs;
            if (suppressForResize) {
              try { logger.debug(`[ACTIVITY] Session ${this.session_id}: Suppressing output within ${suppressMs}ms of resize (age=${age}ms)`); } catch (_) {}
            }
          }
        } catch (_) { suppressForResize = false; }
        const suppress = controlOnly || suppressForResize;
        // Update last_output_at for activity tracking only if not suppressed
        if (!suppress) {
          try { this.last_output_at = new Date().toISOString(); } catch (_) {}
        }
        // Accumulate bytes for current active burst (approximate to UTF-8 length) if capturing enabled
        if (this.capture_activity_transitions && !suppress) {
          try {
            const chunkBytes = (typeof data === 'string') ? Buffer.byteLength(data, 'utf8') : Buffer.byteLength(String(data ?? ''), 'utf8');
            this._activeBurstBytes = (this._activeBurstBytes || 0) + (chunkBytes || 0);
          } catch (_) { /* ignore */ }
        }
        // Immediate transition to active if we were inactive
        try {
          if (!this._outputActive && !suppress) {
            this._outputActive = true;
            const chunkBytes = (typeof data === 'string') ? Buffer.byteLength(data, 'utf8') : Buffer.byteLength(String(data ?? ''), 'utf8');
            const dataPreview = (typeof data === 'string') ? (data.length > 50 ? data.slice(0, 50).replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '…' : data.replace(/\n/g, '\\n').replace(/\r/g, '\\r')) : String(data ?? '').slice(0, 50);
            // DEBUG: Log activity transition with byte count
            logger.debug(`[ACTIVITY] Session ${this.session_id}: Transitioning to ACTIVE - chunk bytes: ${chunkBytes}`);
            // Initialize a pending active transition; commit only if size threshold is reached
            if (this.capture_activity_transitions) {
              try {
                this._pendingActiveTransition = {
                  offset: offsetBeforeOutput,
                  t: Date.now(),
                  seqAtStart: this.outputSequenceNumber,
                  bytes: 0
                };
                // Include the first chunk bytes in the burst threshold accounting
                this._activeBurstBytes = (chunkBytes || 0);
              } catch (_) {}
            }
            try { global.connectionManager?.broadcast?.({
              type: 'session_activity',
              sessionId: this.session_id,
              session_id: this.session_id,
              activity_state: 'active',
              last_output_at: this.last_output_at
            }); } catch (_) {}
          }
        } catch (_) {}
        // If we have a pending active transition and we've crossed the size threshold, record it now
        if (this.capture_activity_transitions) {
          try {
            const minBytes = Number(config.SESSION_ACTIVITY_MIN_BYTES_FOR_ACTIVE_MARKER) || 0;
            if (this._pendingActiveTransition && (this._activeBurstBytes >= minBytes)) {
              // DEBUG: Log when transition is recorded after threshold reached
              logger.info(`[ACTIVITY] Session ${this.session_id}: Recording ACTIVE transition - accumulated bytes: ${this._activeBurstBytes}, min threshold: ${minBytes}`);
              this.recordActivityTransition('active', this._pendingActiveTransition.offset);
              this._pendingActiveTransition = null;
            } else if (this._pendingActiveTransition && this._activeBurstBytes > 0 && this._activeBurstBytes < minBytes) {
              // DEBUG: Log when threshold not yet reached
              logger.debug(`[ACTIVITY] Session ${this.session_id}: Pending ACTIVE transition - accumulated bytes: ${this._activeBurstBytes}, waiting for ${minBytes} (${minBytes - this._activeBurstBytes} more bytes)`);
            }
          } catch (_) {}
        }
        // Schedule inactivity flip after configured threshold
        try {
          this.armInactivityTimer();
        } catch (_) {}
        // (duplicate immediate-active broadcast removed)
        
        // Parse ANSI OSC title sequences (OSC 0/2) to update dynamic_title
        try {
          if (typeof data === 'string' && data) {
            const { title, carry } = parseOscTitles(data, this._oscBuffer || '');
            this._oscBuffer = carry || '';
            // If changed, update and broadcast session update
            if (title && title !== this.dynamic_title) {
              this.dynamic_title = title;
              try {
                if (global.connectionManager) {
                  global.connectionManager.broadcast({
                    type: 'session_updated',
                    update_type: 'updated',
                    session_data: this.toResponseObject()
                  });
                }
              } catch (e) {
                // Non-fatal; continue
              }
            }
          }
        } catch (e) {
          // Non-fatal: ignore parsing errors
        }
        
        // Auto-respond to cursor position queries when no clients are attached
        // Many TUIs send CSI 6 n ("DSR: Report Cursor Position") and expect
        // the terminal to reply with CSI row ; col R. When no web client is
        // attached, there is no terminal emulator to answer, so we synthesize
        // a safe default of 1;1.
        if (this.getConnectedClientCount() === 0 && typeof data === 'string') {
          try {
            // Match both 8-bit CSI (\x9B) and 7-bit ESC [ (\x1b[) forms
            const hasCprRequest = /(?:\x9B|\x1b\[)\??6n/.test(data);
            if (hasCprRequest && this.ptyProcess && this.is_active) {
              // Respond with "ESC [ 1 ; 1 R"
              logger.info(`Session ${this.session_id}: Detected cursor position request (CSI 6n) with no clients attached, responding with ESC[1;1R`);
              this.ptyProcess.write("\x1b[1;1R");
            }
          } catch (e) {
            // Non-fatal: ignore parsing errors
          }
        }

        // Broadcast to connected clients
        if (this.outputBroadcaster) {
          this.outputBroadcaster(this.session_id, data);
        }
      });

      // Initialize history logging if save_session_history is enabled
      if (this.save_session_history) {
        this.initializeHistoryLogging();
      }

      logger.info(`Session ${this.session_id} centralized output broadcaster configured`);

      return true;
    } catch (error) {
      logger.error(`Failed to create ptyprocess for session ${this.session_id}: ${error.message}`);
      logger.error(`Error details: ${error.stack}`);
      throw error;
    }
  }

  // Record an activity transition (active-only per requirements). Uses ring buffer to bound memory.
  recordActivityTransition(state, charOffset) {
    if (state !== 'active') return; // Only record active transitions
    const entry = {
      t: Date.now(),
      state: 'active',
      char_offset: Math.max(0, Number(charOffset) || 0),
      seq: this.outputSequenceNumber
    };
    this.activityTransitions.push(entry);
    if (this.activityTransitions.length > this._maxTransitions) {
      this.activityTransitions.shift();
    }
  }

  write(data) {
    if (this.ptyProcess && this.is_active) {
      try {
        if (config.DEBUG_WS_STDIN) {
          const raw = (typeof data === 'string') ? data : String(data ?? '');
          const preview = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
          logger.debug(`[PTY WRITE] session ${this.session_id} (${raw.length} chars): ${JSON.stringify(preview)}`);
        }
      } catch (_) {}
      this.ptyProcess.write(data);
      this.updateActivity();
      return true;
    }
    return false;
  }

  resize(cols, rows) {
    if (this.ptyProcess && this.is_active) {
      try {
        this.ptyProcess.resize(cols, rows);
        this.terminal_size = { cols, rows };
        // Record the timestamp for resize-induced output suppression
        try { this._lastResizeAt = Date.now(); } catch (_) { this._lastResizeAt = Date.now(); }
        this.updateActivity();
        return true;
      } catch (error) {
        logger.error(`Error resizing session ${this.session_id}: ${error.message}`);
        return false;
      }
    }
    return false;
  }

  terminate() {
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
        this.is_active = false;
        this.ended_at = new Date().toISOString();
        try { if (this._inactivityTimer) { clearTimeout(this._inactivityTimer); this._inactivityTimer = null; } } catch (_) {}
        
        // Close history logging stream
        if (this.historyStream) {
          // Request stream end; allow finalizeHistory() to await finish/close
          try { this.historyStream.end(); } catch (_) {}
          const hs = this.historyStream;
          // Null the reference once the stream actually finishes/closes
          try {
            hs.once('finish', () => { this.historyStream = null; });
            hs.once('close', () => { this.historyStream = null; });
          } catch (_) {
            this.historyStream = null;
          }
        }
      } catch (error) {
        logger.error(`Error terminating session ${this.session_id}: ${error.message}`);
      }
    }
  }

  // Ensure history is flushed to disk. Best-effort with a timeout.
  async finalizeHistory(timeoutMs = 1000) {
    if (!this.save_session_history) return; // Respect setting

    try {
      const logPath = path.join(this.script_logs_dir, this.script_log_file);
      try {
        // Ensure directory exists
        await fs.promises.mkdir(this.script_logs_dir, { recursive: true });
      } catch (_) {}

      if (this.historyStream) {
        const stream = this.historyStream;
        // If end() wasn't called yet, call it now
        try { stream.end(); } catch (_) {}
        await new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          try {
            stream.once('finish', finish);
            stream.once('close', finish);
          } catch (_) {
            // If stream listeners fail, resolve after timeout
          }
          setTimeout(finish, Math.max(0, Number(timeoutMs) || 0));
        });
        return;
      }

      // Fallback: if no stream exists (unexpected), ensure the file exists with in-memory buffer
      try {
        const st = await fs.promises.stat(logPath).catch(() => null);
        if (!st || st.size === 0) {
          await fs.promises.writeFile(logPath, this.outputHistory || '', { flag: 'w' });
        }
      } catch (e) {
        logger.warning(`Session ${this.session_id}: Failed fallback write for history: ${e.message}`);
      }
    } catch (e) {
      logger.warning(`Session ${this.session_id}: finalizeHistory encountered error: ${e.message}`);
    }
  }

  initializeHistoryLogging() {
    if (!this.save_session_history) return;
    
    try {
      const logFilePath = path.join(this.script_logs_dir, this.script_log_file);
      this.historyStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
      logger.debug(`History logging initialized for session ${this.session_id}: ${logFilePath}`);
      // Server-side markers disabled per request — do not append start marker to history or state
    } catch (error) {
      logger.error(`Failed to initialize history logging for session ${this.session_id}: ${error.message}`);
    }
  }

  logOutput(data) {
    // Store in memory for active sessions with sequence tracking
    this.outputHistory += data;
    this.outputSequenceNumber++;

    // Write to file if history logging is enabled
    if (this.historyStream && this.save_session_history) {
      try {
        this.historyStream.write(data);
      } catch (error) {
        logger.error(`Error writing to history log for session ${this.session_id}: ${error.message}`);
      }
    }
  }

  // Append a hidden history marker to the log and in-memory buffer without writing to the PTY.
  // These are encoded as OSC 133;ts: markers and are stripped by the frontend filters,
  // but the history streamer detects them to place timeline markers at the correct position.
  // kind: 'input' | 'start' | string
  appendHiddenHistoryMarker(kind = 'input', ts = Date.now()) {
    try {
      const K = String(kind || 'input');
      const T = Number.isFinite(Number(ts)) ? Math.floor(Number(ts)) : Date.now();
      const seq = `\x1b]133;ts:${K};t=${T}\x07`;
      // Append to in-memory buffer and increment sequence for consistent offsets
      this.outputHistory += seq;
      this.outputSequenceNumber++;
      // Write to file if stream exists
      if (this.historyStream && this.save_session_history) {
        try { this.historyStream.write(seq); } catch (_) {}
      }
      try { logger.debug(`[Markers] session=${this.session_id} hidden marker appended: kind=${K} t=${T} seqNo=${this.outputSequenceNumber}`); } catch (_) {}
    } catch (_) { /* best-effort */ }
  }

  // Append an ordinal input marker to session state and persist hidden marker in history
  appendInputMarker(kind = 'input', ts = Date.now()) {
    try {
      if (!Array.isArray(this.inputMarkers)) this.inputMarkers = [];
      const next = Number.isInteger(this._nextInputMarkerIdx) ? this._nextInputMarkerIdx : this.inputMarkers.length;
      const T = Number.isFinite(Number(ts)) ? Math.floor(Number(ts)) : Date.now();
      this.inputMarkers.push({ idx: next, t: T, kind: String(kind || 'input') });
      this._nextInputMarkerIdx = next + 1;
      try { logger.info(`[Markers] session=${this.session_id} input marker added: idx=${next} kind=${kind} t=${T} total=${this.inputMarkers.length}`); } catch (_) {}
      this.appendHiddenHistoryMarker(kind, T);
    } catch (e) {
      try { logger.warning(`[Markers] session=${this.session_id} appendInputMarker failed: ${e?.message || e}`); } catch (_) {}
    }
  }

  getHistory() {
    // Capture current sequence number for synchronization
    const snapshotMarker = this.outputSequenceNumber;

    return {
      session_id: this.session_id,
      command: this.command,
      working_directory: this.working_directory,
      created_at: this.created_at,
      created_by: this.created_by,
      ended_at: this.ended_at,
      exit_code: this.exit_code,
      terminal_size: this.terminal_size,
      output_history: this.outputHistory,
      output_sequence_marker: snapshotMarker, // Include marker for client sync
      // Ordinal input markers
      input_markers: Array.isArray(this.inputMarkers) ? this.inputMarkers : [],
      // Client-reported render markers
      render_markers: Array.isArray(this.renderMarkers) ? this.renderMarkers : [],
      activity_transitions: [],
      capture_activity_transitions: false,
      is_active: this.is_active,
      visibility: this.visibility,
      title: this.title,
      dynamic_title: this.dynamic_title,
      interactive: this.interactive,
      load_history: this.load_history,
      save_session_history: this.save_session_history,
      links: Array.isArray(this.links)
        ? this.links.map((l) => normalizeLinkForResponse(l)).filter(Boolean)
        : [],
      template_id: this.template_id,
      template_name: this.template_name,
      template_parameters: this.template_parameters,
      workspace: this.workspace,
      workspace_order: this.workspace_order,
      workspace_service_enabled_for_session: this.workspace_service_enabled_for_session === true,
      workspace_service_port: (() => {
        const n = Number(this.workspace_service_port);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
      })(),
      note: typeof this.note === 'string' ? this.note : '',
      note_version: Number.isInteger(this.note_version) ? this.note_version : 0,
      note_updated_at: this.note_updated_at || null,
      note_updated_by: this.note_updated_by || null,
      parent_session_id: this.parent_session_id,
      // Stop inputs configuration
      stop_inputs_enabled: this.stop_inputs_enabled !== false,
      stop_inputs: Array.isArray(this.stop_inputs) ? this.stop_inputs : [],
      stop_inputs_rearm_remaining: (() => {
        const max = Number.isFinite(Number(config.STOP_INPUTS_REARM_MAX)) && Number(config.STOP_INPUTS_REARM_MAX) >= 0
          ? Math.floor(Number(config.STOP_INPUTS_REARM_MAX))
          : 10;
        const n = Number(this.stop_inputs_rearm_remaining);
        if (!Number.isFinite(n) || n < 0) return 0;
        const v = Math.floor(n);
        return v > max ? max : v;
      })(),
      stop_inputs_rearm_max: (() => {
        const n = Number(config.STOP_INPUTS_REARM_MAX);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
      })(),
      history_view_mode: this.history_view_mode === 'html' ? 'html' : 'text',
      has_html_history: this.has_html_history === true,
      history_html_file: this.history_html_file || null
    };
  }

  updateActivity() {
    this.last_activity = new Date().toISOString();
  }

  attachClient(clientId) {
    this.connected_clients.add(clientId);
    this.updateActivity();
    logger.debug(`Client ${clientId} attached to session ${this.session_id}. Connected clients: ${this.connected_clients.size}`);
  }

  removeClient(clientId) {
    // Backward-compatible alias for detachClient
    this.detachClient(clientId);
  }

  detachClient(clientId) {
    this.connected_clients.delete(clientId);
    // Clean up any history sync state for this client
    this.clientHistorySync.delete(clientId);
    logger.debug(`Client ${clientId} detached from session ${this.session_id}. Connected clients: ${this.connected_clients.size}`);
  }

  getConnectedClientCount() {
    return this.connected_clients.size;
  }

  addLinks(links, options = {}) {
    try {
      const allowTemplateFields = options && options.allowTemplateFields === true;
      const existing = new Map();
      // Seed existing with current links by URL, preserving full metadata
      (this.links || []).forEach((l) => {
        if (l && l.url) {
          existing.set(l.url, { ...l });
        }
      });

      // Merge new links, de-duplicating by URL and updating fields when provided
      (links || []).forEach((l) => {
        if (!l || !l.url) return;
        const url = String(l.url);
        const isExisting = existing.has(url);
        const current = existing.get(url) || {};
        const merged = { ...current };

        const existingIsTemplate = current && current._template_link === true;
        const allowTemplateForThisLink = allowTemplateFields && (l._template_link === true || l.template_link === true);

        // Core identity
        merged.url = url;
        if (typeof l.name === 'string' && l.name.trim()) {
          merged.name = l.name;
        } else if (!merged.name) {
          merged.name = url;
        }

        const applyBool = (propName, defaultForNew) => {
          const has = Object.prototype.hasOwnProperty.call(l, propName);
          if (has) {
            const v = l[propName];
            if (propName === 'show_active' || propName === 'show_inactive' || propName === 'show_url_bar') {
              merged[propName] = v !== false;
            } else {
              merged[propName] = v === true;
            }
          } else if (!isExisting && !Object.prototype.hasOwnProperty.call(merged, propName)) {
            if (defaultForNew !== undefined) {
              merged[propName] = defaultForNew;
            }
          }
        };

        // Existing flags
        applyBool('refresh_on_view', false);
        applyBool('show_active', true);
        applyBool('show_inactive', true);
        // New chat link flags
        applyBool('show_url_bar', true);
        applyBool('pass_theme_colors', false);
        applyBool('refresh_on_view_active', false);
        applyBool('refresh_on_view_inactive', false);

        // Optional output filename (string or unset)
        if (Object.prototype.hasOwnProperty.call(l, 'output_filename')) {
          const raw = l.output_filename;
          if (typeof raw === 'string' && raw.trim()) {
            merged.output_filename = raw.trim();
          } else {
            delete merged.output_filename;
          }
        }

        // Internal/template-only metadata: allow templates to set, but do not
        // override unless explicitly provided on the new link object.
        if (allowTemplateForThisLink || existingIsTemplate) {
          let cmd = current && current._pre_view_command ? current._pre_view_command : '';
          if (allowTemplateForThisLink && typeof l._pre_view_command === 'string') {
            cmd = l._pre_view_command.trim();
          }
          if (cmd) {
            merged._pre_view_command = cmd;
          }
          if (allowTemplateForThisLink || existingIsTemplate) {
            merged._template_link = true;
          }
        } else {
          // Drop any attempt to set template-only metadata from non-template inputs
          if (!existingIsTemplate) {
            delete merged._pre_view_command;
            delete merged._template_link;
          }
        }

        existing.set(url, merged);
      });

      this.links = Array.from(existing.values());
    } catch (e) {
      // Fallback to simple append if anything unexpected occurs
      this.links = [...(this.links || []), ...(links || [])];
    }

    // After merging, ensure template-defined links have stable IDs.
    this._ensureTemplateLinkIds();
  }

  updateLink(url, updates) {
    const linkIndex = this.links.findIndex(link => link.url === url);
    if (linkIndex === -1) return false;
    // Backward compatibility: allow string name as second arg
    if (typeof updates === 'string') {
      this.links[linkIndex].name = updates;
      return true;
    }
    const u = updates && typeof updates === 'object' ? updates : {};
    if (Object.prototype.hasOwnProperty.call(u, 'name') && typeof u.name === 'string') {
      this.links[linkIndex].name = u.name;
    }
    if (Object.prototype.hasOwnProperty.call(u, 'refresh_on_view')) {
      this.links[linkIndex].refresh_on_view = !!u.refresh_on_view;
    }
    return true;
  }

  removeLink(url) {
    const initialLength = this.links.length;
    this.links = this.links.filter(link => link.url !== url);
    return this.links.length < initialLength;
  }

  _ensureTemplateLinkIds() {
    try {
      const list = Array.isArray(this.links) ? this.links : [];
      for (const link of list) {
        if (!link || typeof link !== 'object') continue;
        const isTemplate = link._template_link === true || link.template_link === true;
        if (!isTemplate) continue;
        const hasId = typeof link.link_id === 'string' && link.link_id.trim();
        if (!hasId) {
          link.link_id = `tpl-${this.session_id}-${uuidv4()}`;
        } else {
          link.link_id = String(link.link_id).trim();
        }
      }
      this.links = list;
    } catch (_) {
      // Best-effort only; absence of link_id falls back to index-based APIs.
    }
  }

  getNoteSnapshot() {
    return {
      content: typeof this.note === 'string' ? this.note : '',
      version: Number.isInteger(this.note_version) ? this.note_version : 0,
      updated_at: this.note_updated_at || null,
      updated_by: this.note_updated_by || null
    };
  }

  updateNote(content, options = {}) {
    const normalizedContent = typeof content === 'string' ? content : '';
    const expectedVersion = Number.isInteger(options.expectedVersion)
      ? options.expectedVersion
      : null;

    if (expectedVersion !== null && expectedVersion !== this.note_version) {
      const error = new Error('Session note version conflict');
      error.code = 'NOTE_VERSION_CONFLICT';
      error.context = { latest: this.getNoteSnapshot() };
      throw error;
    }

    this.note = normalizedContent;
    this.note_version = (Number.isInteger(this.note_version) ? this.note_version : 0) + 1;
    this.note_updated_at = new Date().toISOString();
    if (options.updatedBy) {
      this.note_updated_by = options.updatedBy;
    }

    return this.getNoteSnapshot();
  }

  toResponseObject() {
    const clientsInfo = Array.from(this.connected_clients).map((cid) => {
      try {
        const ws = global?.connectionManager?.connections?.get(cid);
        const username = ws && typeof ws.username === 'string' && ws.username
          ? ws.username
          : config.DEFAULT_USERNAME;
        return { client_id: cid, username };
      } catch (_) {
        return { client_id: cid, username: config.DEFAULT_USERNAME };
      }
    });
    try {
      logger.debug(`Session ${this.session_id} clients: ` + JSON.stringify(clientsInfo));
    } catch (_) {}

    // Compute output_active on the fly using configured inactivity threshold
    let outputActive = false;
    try {
      const now = Date.now();
      const last = Date.parse(this.last_output_at || this.created_at || new Date().toISOString());
      const delta = now - last;
      const thresh = Number.isFinite(Number(config.SESSION_ACTIVITY_INACTIVE_AFTER_MS))
        ? Number(config.SESSION_ACTIVITY_INACTIVE_AFTER_MS)
        : 10000;
      outputActive = delta <= thresh;
    } catch (_) { outputActive = false; }

    let workspaceHostPath = null;
    try {
      const mode = String(this.isolation_mode || 'none').toLowerCase();
      if (mode === 'container' || mode === 'directory') {
        workspaceHostPath = resolveSessionWorkspaceHostPath(this.session_id);
      }
    } catch (_) {
      workspaceHostPath = null;
    }

    return {
      session_id: this.session_id,
      session_alias: this.session_alias || null,
      command: this.command,
      working_directory: this.working_directory,
      created_at: this.created_at,
      last_activity: this.last_activity,
      last_output_at: this.last_output_at,
      output_active: outputActive,
      is_active: this.is_active,
      visibility: this.visibility,
      connected_client_count: this.getConnectedClientCount(),
      connected_client_ids: Array.from(this.connected_clients),
      // Extended client info (id + username) for richer UI
      connected_clients_info: clientsInfo,
      created_by: this.created_by,
      title: this.title,
      dynamic_title: this.dynamic_title,
      interactive: this.interactive,
      load_history: this.load_history,
      save_session_history: this.save_session_history,
      // Surface template-driven activity transitions capture so UIs can decide affordances
      capture_activity_transitions: false,
      input_markers: Array.isArray(this.inputMarkers) ? this.inputMarkers : [],
      render_markers: Array.isArray(this.renderMarkers) ? this.renderMarkers : [],
      links: Array.isArray(this.links)
        ? this.links.map((l) => normalizeLinkForResponse(l)).filter(Boolean)
        : [],
      command_tabs: this.command_tabs,
      template_id: this.template_id,
      template_name: this.template_name,
      isolation_mode: this.isolation_mode,
      container_name: this.container_name,
      container_runtime: this.container_runtime,
      parent_session_id: this.parent_session_id,
      child_tab_type: this.child_tab_type || null,
      show_in_sidebar: this.show_in_sidebar !== false,
      template_parameters: this.template_parameters,
      workspace: this.workspace,
      workspace_order: this.workspace_order,
      workspace_service_enabled_for_session: this.workspace_service_enabled_for_session === true,
      workspace_service_port: (() => {
        const n = Number(this.workspace_service_port);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
      })(),
      workspace_host_path: workspaceHostPath,
      is_fork: this.is_fork === true,
      forked_from_session_id: this.forked_from_session_id || null,
      note: typeof this.note === 'string' ? this.note : '',
      note_version: Number.isInteger(this.note_version) ? this.note_version : 0,
      note_updated_at: this.note_updated_at || null,
      note_updated_by: this.note_updated_by || null,
      ephemeral_bind_mounts: Array.isArray(this.ephemeral_bind_mounts) ? this.ephemeral_bind_mounts : [],
      // Stop inputs configuration
      stop_inputs_enabled: this.stop_inputs_enabled !== false,
      stop_inputs: Array.isArray(this.stop_inputs) ? this.stop_inputs : [],
      stop_inputs_rearm_remaining: (() => {
        const max = Number.isFinite(Number(config.STOP_INPUTS_REARM_MAX)) && Number(config.STOP_INPUTS_REARM_MAX) >= 0
          ? Math.floor(Number(config.STOP_INPUTS_REARM_MAX))
          : 10;
        const n = Number(this.stop_inputs_rearm_remaining);
        if (!Number.isFinite(n) || n < 0) return 0;
        const v = Math.floor(n);
        return v > max ? max : v;
      })(),
      stop_inputs_rearm_max: (() => {
        const n = Number(config.STOP_INPUTS_REARM_MAX);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10;
      })(),
      history_view_mode: this.history_view_mode === 'html' ? 'html' : 'text',
      has_html_history: this.has_html_history === true,
      history_html_file: this.history_html_file || null
    };
  }

  armInactivityTimer() {
    try {
      if (this._inactivityTimer) {
        clearTimeout(this._inactivityTimer);
        this._inactivityTimer = null;
      }
    } catch (_) {}
    try {
      const delay = Number.isFinite(Number(config.SESSION_ACTIVITY_INACTIVE_AFTER_MS))
        ? Number(config.SESSION_ACTIVITY_INACTIVE_AFTER_MS)
        : 1000;
      this._inactivityTimer = setTimeout(() => {
        try {
          const last = Date.parse(this.last_output_at || this.created_at || new Date().toISOString());
          const now = Date.now();
          if ((now - last) >= delay && this._outputActive) {
            this._outputActive = false;
            // Drop any pending active transition if threshold not reached
            try {
              this._pendingActiveTransition = null;
              this._activeBurstBytes = 0;
            } catch (_) {}
            try {
              global.connectionManager?.broadcast?.({
                type: 'session_activity',
                sessionId: this.session_id,
                session_id: this.session_id,
                activity_state: 'inactive',
                last_output_at: this.last_output_at
              });
            } catch (_) {}
            try {
              handleSessionInactive(this.session_id);
            } catch (_) { /* best-effort */ }
          }
        } catch (_) { /* ignore timer errors */ }
      }, Math.max(100, delay));
    } catch (_) {}
  }

  // Mark client as loading history to enable output queuing
  markClientLoadingHistory(clientId, sequenceMarker) {
    // Capture byte offset at marker time to filter history endpoint
    const byteOffset = typeof this.outputHistory === 'string' ? this.outputHistory.length : 0;
    this.clientHistorySync.set(clientId, {
      loading: true,
      marker: sequenceMarker,
      byteOffset: byteOffset, // Track byte offset for history filtering
      queuedOutput: []
    });
  }

  // Mark client as finished loading history and get queued output
  markClientHistoryLoaded(clientId) {
    const syncState = this.clientHistorySync.get(clientId);
    if (syncState) {
      const queuedOutput = syncState.queuedOutput || [];
      this.clientHistorySync.delete(clientId);
      return queuedOutput;
    }
    return [];
  }

  // Check if client should queue output (during history loading)
  shouldQueueOutputForClient(clientId, sequenceNumber) {
    const syncState = this.clientHistorySync.get(clientId);
    if (syncState && syncState.loading) {
      // Queue output that comes at or after the history snapshot marker
      // This prevents duplicates where output at the marker is sent via websocket
      // while also being included in the history fetch
      return sequenceNumber >= syncState.marker;
    }
    return false;
  }

  // Queue output for a client that's loading history
  queueOutputForClient(clientId, data) {
    const syncState = this.clientHistorySync.get(clientId);
    if (syncState && syncState.queuedOutput) {
      syncState.queuedOutput.push(data);
    }
  }
}
