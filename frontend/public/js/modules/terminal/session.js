/**
 * Clean Terminal Session Module
 * Simple xterm.js integration with direct streaming (no buffering/history)
 */

import { apiService } from '../../services/api.service.js';
import { showLoadingOverlay } from '../../utils/loading-overlay.js';
import { errorHandler } from '../../utils/error-handler.js';
import { TerminalAutoCopy } from '../../utils/terminal-auto-copy.js';
import { MobileTerminalTouchHandler } from './mobile-touch-handler.js';
import { appStore } from '../../core/store.js';
import { getContext } from '../../core/context.js';
import { mobileDetection } from '../../utils/mobile-detection.js';
import { fontDetector } from '../../utils/font-detector.js';
import { getEffectiveTheme, getXtermTheme } from '../../utils/theme-utils.js';
import { AnsiDebug } from '../../utils/ansi-debug.js';
import { applyAnsiFilters } from '../../utils/ansi-filters.js';
import { streamHistoryToTerminal } from '../../utils/history-streamer.js';
import { isAnyModalOpen } from '../ui/modal.js';

export class TerminalSession {
    constructor(sessionId, container, wsClient, eventBus, sessionData = null, preloadedHistoryData = null) {
        this.sessionId = sessionId;
        this.container = container;
        this.wsClient = wsClient;
        this.eventBus = eventBus;
        this.sessionData = sessionData;
        this.preloadedHistoryData = preloadedHistoryData;
        
        this.terminal = null;
        this.fitAddon = null;
        this.webLinksAddon = null;
        this.isAttached = false;
        this.isInitialized = false;
        
        // Mobile scrolling state
        this.isMobile = this.detectMobile();
        this.mobileTouch = null;
        
        // Auto-copy cleanup function
        this.autoCopyCleanup = null;

        // Output queue to prevent race conditions during history loading
        this.outputQueue = [];
        this.isLoadingHistory = false;
        this.historyMarker = null; // Server-provided marker for history sync
        this.historyByteOffset = null; // Server-provided byte offset for history filtering
        this.historyFetchPromise = null; // Track in-progress history fetch
        this.historySyncTimer = null; // Timeout for waiting on attach ack
        this.historySyncComplete = false; // Tracks lifecycle of history sync handshake
        // Abort controller for streamed history requests
        this._historyAbort = null;

        // Gate WebSocket stdout until history sync decision is made to avoid duplicates
        this._wsOutputGated = false; // true => drop/buffer live stdout until sync completes/decides
        this._wsOutputBuffer = [];   // buffer early stdout when we end up skipping history
        this._wsOutputBufferBytes = 0;
        this._wsOutputBufferMaxBytes = 512 * 1024; // cap to 512KB

        // Fit/observer helpers (no polling)
        this._io = null; // IntersectionObserver
        this._ro = null; // ResizeObserver
        this._deferredFitTimer = null; // legacy guard; not used for loops
        this._fontsReadyHooked = false;

        // Activity markers and navigation state
        this.activityMarkers = [];
        this._transitionOffsetsCRLF = [];
        this._markerNavIndex = -1; // index into activityMarkers for prev/next navigation
        this._markerNavCoalescedIndex = -1; // index into coalesced navigation list
        // Client-captured markers (timestamp + line) for seeking
        this._clientMarkers = []; // Array<{ t: number, line: number }>
        this._clientMarkerNavIndex = -1;
        // No synthetic start marker is used
        // Guard against duplicate registrations (e.g., double WS handlers)
        this._lastClientMarkerTs = null;

        // Debug markers overlay removed; no visual bars (purged)

        // Debug: replay-seek support (history only, optional)
        this._markersReplayEnabled = false;

        // Live marker gating (frontend side) keyed off session_activity 'active'
        this._livePendingActive = false;
        this._liveActiveBytes = 0;
        this._minActiveMarkerBytes = 32; // frontend default; backend also gates recording

        // Cleanup hooks for global listeners
        this._docPasteCleanup = null;

        // Guard to suppress xterm's onData immediately after we handle a paste ourselves
        // Use a short-lived timestamp window to avoid suppressing unrelated keypresses (e.g., Enter)
        //  - value is a number: epoch ms until which to ignore the next onData (one-time)
        //  - 0 or falsy: no suppression
        this._ignoreNextOnData = 0;
        // Track current ws-attached event handler to avoid races during refresh
        this._wsAttachHandler = null;

        // Track alt-screen mode inferred from live output
        this._altScreen = false;

        // Client-only ordinal counter for markers (start at 1 to avoid special-case zero)
        this._nextClientOrdinal = 1;
    }
    
    computeInteractive() {
        try {
            const mgr = getContext()?.app?.modules?.terminal;
            const sd = (mgr?.sessionList?.getSessionData?.(this.sessionId)) || this.sessionData || {};
            if (mgr && typeof mgr.isSessionInteractive === 'function') {
                return mgr.isSessionInteractive(sd);
            }
            if (sd.interactive === false) return false;
            return true;
        } catch (_) {
            return true;
        }
    }

    refreshInteractive() {
        try {
            const interactive = this.computeInteractive();
            if (this.terminal) {
                if (typeof this.terminal.setOption === 'function') {
                    this.terminal.setOption('disableStdin', !interactive);
                } else if (this.terminal.options) {
                    this.terminal.options.disableStdin = !interactive;
                }
            }
        } catch (_) {}
    }

    init() {
        if (this.isInitialized) {
            console.log(`[TerminalSession] Already initialized for session ${this.sessionId}, skipping`);
            return;
        }
        
        
        // Initial interactive state (can change at runtime when visibility updates)
        const isInteractive = this.computeInteractive();
        
        // Get font settings from store preferences
        const state = appStore.getState();
        const fontSize = state.preferences?.terminal?.fontSize ?? 14;
        const fontFamily = state.preferences?.terminal?.fontFamily ?? fontDetector.getDefaultFont();
        try {
            console.log('[TerminalSession] init', {
                sessionId: this.sessionId,
                isInteractive,
                metadataSize: this.sessionData?.terminal_size ?? null,
                containerSize: this.container ? {
                    width: this.container.clientWidth || null,
                    height: this.container.clientHeight || null
                } : null
            });
        } catch (_) {}

        // Create fresh terminal instance
        this.terminal = new Terminal({
            cursorBlink: isInteractive,
            fontSize: fontSize,
            fontFamily: fontFamily,
            theme: getXtermTheme(getEffectiveTheme(), { interactive: isInteractive }),
            // Enable scrollback buffer for proper scroll behavior
            scrollback: 10000,
            // Configure scroll behavior
            scrollSensitivity: 3,
            fastScrollSensitivity: 5,
            // Alt+wheel should not send to shell
            altClickMovesCursor: false,
            // Disable input for non-interactive sessions
            disableStdin: !isInteractive
        });
        
        // Override xterm.js focus method to prevent mobile keyboard
        const originalXtermFocus = this.terminal.focus;
        this.terminal.focus = () => {
            if (window._mobileKeyboardInputActive) {
                return;
            }
            originalXtermFocus.call(this.terminal);
        };
        
        // Create and load fit addon
        this.fitAddon = new FitAddon.FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        
        // Setup hyperlink support for http/https URLs
        this.setupHyperlinks();
        
        // Clear container and open terminal
        this.container.innerHTML = '';
        this.terminal.open(this.container);

        // Setup event handlers
        this.setupEventHandlers();


        // Install visibility/size observers for fit without polling
        this.setupFitObservers();

        // Ensure a fit after fonts load to avoid zero cell size
        this.setupFontsReadyHook();
        
        // Seed client markers from server first
        try {
            const rm = Array.isArray(this.sessionData?.render_markers) ? this.sessionData.render_markers : [];
            if (rm && rm.length) {
                const seenTs = [];
                for (const m of rm) {
                    const t = Number.isFinite(Number(m?.t)) ? Math.floor(Number(m.t)) : null;
                    const line = Number.isFinite(Number(m?.line)) ? Math.max(0, Math.floor(Number(m.line))) : null;
                    if (t == null || line == null) continue;
                    // Coalesce duplicates by timestamp within ~750ms, regardless of line
                    if (seenTs.some((pt) => Math.abs(pt - t) <= 750)) continue;
                    seenTs.push(t);
                    this._clientMarkers.push({ t, line });
                }
                this._clientMarkerNavIndex = this._clientMarkers.length - 1;
                console.log('[ClientMarker][seed]', { sessionId: this.sessionId, count: this._clientMarkers.length });
            }
        } catch (_) {}
        // Do not add a synthetic start marker; dropdown remains empty until first input

        // Setup mobile scrolling if on mobile device
        if (this.isMobile) {
            this.mobileTouch = new MobileTerminalTouchHandler(this.terminal, this.sessionId, this.eventBus, this.wsClient);
            this.mobileTouch.setup();
        }
        
        // Auto-resize will handle sizing automatically
        
        this.isInitialized = true;
    }
    
    // Check if auto-focus should be prevented
    // Prevent when: mobile keyboard constraints OR any modal overlay is visible
    shouldPreventAutoFocus() {
        // Existing mobile guard
        const mobileGuard = mobileDetection.shouldPreventAutoFocus();

        // Detect any visible modal overlays (new session, settings, auth, confirms, floating text input)
        const modalGuard = isAnyModalOpen();

        const shouldPrevent = mobileGuard || modalGuard;
        try {
            console.log('[TerminalSession] shouldPreventAutoFocus:', shouldPrevent, {
                mobileGuard,
                modalGuard,
                isMobile: mobileDetection.isMobile,
                isTouch: mobileDetection.isTouch,
                userAgent: navigator.userAgent,
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight
            });
        } catch (_) {}
        return shouldPrevent;
    }
    
    setupEventHandlers() {
        const isInteractive = this.computeInteractive();
        
        // Handle terminal input - gate dynamically based on latest visibility
        this.terminal.onData((data) => {
            // Any local typing/interaction clears the sidebar activity indicator
            try {
                const ctx = getContext();
                const list = ctx?.app?.modules?.terminal?.sessionList;
                if (list && typeof list.clearActivityIndicator === 'function') {
                    list.clearActivityIndicator(this.sessionId);
                }
            } catch (_) {}
            // Suppress terminal-generated responses during history replay (Issue #600)
            // Some historical output may contain terminal queries (e.g., OSC/CSI).
            // While replaying history, xterm.js can emit responses via onData.
            // Forwarding these to the backend can inject stray control sequences
            // into the live PTY. Drop any outbound data until history sync completes.
            if (this.isLoadingHistory) return;

            // If we've just handled a paste event ourselves, ignore the next onData
            // Only suppress within a very short window to avoid eating the user's next key (e.g., Enter)
            try {
                const now = Date.now();
                const until = Number(this._ignoreNextOnData) || 0;
                if (Number.isFinite(until) && until > 0) {
                    if (now <= until) {
                        try { console.log('[TerminalSession] onData suppressed due to handled paste', { sessionId: this.sessionId }); } catch (_) {}
                        this._ignoreNextOnData = 0; // one-time suppression
                        return;
                    }
                    // Expire stale guard proactively without extra logging
                    this._ignoreNextOnData = 0;
                }
            } catch (_) {}
            try {
                if (!this.isAttached) return;
                const mgr = getContext()?.app?.modules?.terminal;
                const sd = mgr?.sessionList?.getSessionData(this.sessionId) || this.sessionData || {};
                const allowed = mgr?.isSessionInteractive ? mgr.isSessionInteractive(sd) : (sd.interactive !== false);
                if (!allowed) return;
                const text = String(data ?? '');
                const CHUNK = 2048;
                if (text.length > CHUNK) {
                    for (let i = 0; i < text.length; i += CHUNK) {
                        const part = text.slice(i, i + CHUNK);
                        this.wsClient.send('stdin', { session_id: this.sessionId, data: part });
                    }
                } else {
                    this.wsClient.send('stdin', { session_id: this.sessionId, data: text });
                }
            } catch (_) { /* ignore */ }
        });
        
        // Handle terminal resize
        this.terminal.onResize((size) => {
            try {
                this.logFitDimensions('onResize', { reported: { cols: size?.cols, rows: size?.rows } });
            } catch (_) {}
            if (this.isAttached) {
                const minCols = 40;
                const minRows = 10;
                const cols = Math.max(minCols, Math.floor(Number(size?.cols) || 80));
                const rows = Math.max(minRows, Math.floor(Number(size?.rows) || 24));
                this.wsClient.send('resize', { session_id: this.sessionId, cols, rows });
            }
        });

        // Auto-copy selection when deselecting (Issue #118)
        // Add refocus callback (Issue #161)
        const refocusCallback = () => {
            // Small delay to ensure copy operation completes before refocusing
            setTimeout(() => {
                this.focus();
            }, 100);
        };
        this.autoCopyCleanup = TerminalAutoCopy.setup(this.terminal, this.sessionId, refocusCallback, {
            onShiftSend: (text) => {
                try {
                    const mgr = getContext()?.app?.modules?.terminal;
                    if (!mgr || typeof mgr.showTextInputModalWithIncluded !== 'function') return;
                    // If this session is a container child, target its parent for send; otherwise default
                    let targetOverride = null;
                    try {
                        if (typeof mgr.isChildSession === 'function' && mgr.isChildSession(this.sessionId)) {
                            const sd = typeof mgr.getAnySessionData === 'function' ? mgr.getAnySessionData(this.sessionId) : null;
                            const pid = sd && sd.parent_session_id ? String(sd.parent_session_id) : '';
                            if (pid) targetOverride = pid;
                        }
                    } catch (_) { /* ignore */ }
                    const opts = targetOverride ? { targetSessionId: targetOverride, sourceSessionId: this.sessionId } : { sourceSessionId: this.sessionId };
                    mgr.showTextInputModalWithIncluded(text, opts);
                } catch (_) { /* ignore */ }
            }
        });
        
        // Clear indicator on terminal focus (e.g., mouse click focus)
        try {
            this.terminal.onFocus(() => {
                try {
                    const ctx = getContext();
                    const list = ctx?.app?.modules?.terminal?.sessionList;
                    if (list && typeof list.clearActivityIndicator === 'function') {
                        list.clearActivityIndicator(this.sessionId);
                    }
                } catch (_) {}
            });
        } catch (_) {}

        // Also clear when container is clicked (fallback when focus event isn’t emitted)
        try {
            const el = this.container;
            if (el && typeof el.addEventListener === 'function') {
                el.addEventListener('click', () => {
                    try {
                        const ctx = getContext();
                        const list = ctx?.app?.modules?.terminal?.sessionList;
                        if (list && typeof list.clearActivityIndicator === 'function') {
                            list.clearActivityIndicator(this.sessionId);
                        }
                    } catch (_) {}
                });
            }
        } catch (_) {}

        // Handle drag-and-drop of image files into container-isolated terminals
        try {
            const el = this.container;
            if (el && typeof el.addEventListener === 'function') {
                const dragOver = (e) => {
                    try {
                        if (e && typeof e.preventDefault === 'function') e.preventDefault();
                        if (e && e.dataTransfer) {
                            e.dataTransfer.dropEffect = 'copy';
                        }
                    } catch (_) {}
                };
                const dropHandler = async (e) => {
                    try {
                        if (e && typeof e.preventDefault === 'function') e.preventDefault();
                    } catch (_) {}
                    try {
                        const mgr = getContext()?.app?.modules?.terminal;
                        const sd = mgr?.sessionList?.getSessionData?.(this.sessionId) || this.sessionData || {};
                        const isoMode = sd && sd.isolation_mode;
                        const supportsUpload = isoMode === 'container' || isoMode === 'directory' || isoMode === 'none';
                        if (!supportsUpload) { return; }
                        const dt = e?.dataTransfer;
                        const files = dt && dt.files ? Array.from(dt.files) : [];
                        if (!files || files.length === 0) { return; }
                        // Pick first image file
                        let file = null;
                        for (const f of files) {
                            if (!f) continue;
                            const mt = String(f.type || '').toLowerCase();
                            const name = String(f.name || '').toLowerCase();
                            const isImg = (mt.startsWith('image/')) || /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/.test(name);
                            if (isImg) { file = f; break; }
                        }
                        if (!file) { return; }

                        // Feature gate (frontend no-op): respect user's configured feature flags
                        try {
                            const features = (appStore.getState()?.auth?.features) || {};
                            if (features.image_uploads_enabled !== true) {
                                return; // silently ignore when disabled
                            }
                        } catch (_) {}

                        // Read as base64
                        const base64 = await new Promise((resolve, reject) => {
                            try {
                                const reader = new FileReader();
                                reader.onerror = () => reject(new Error('Failed to read file'));
                                reader.onload = () => resolve(String(reader.result || ''));
                                reader.readAsDataURL(file);
                            } catch (err) { reject(err); }
                        });

                        // Show a lightweight overlay
                        try { showLoadingOverlay(true, 'Uploading image...'); } catch (_) {}
                        let resp;
                        try {
                            resp = await apiService.uploadSessionImage(this.sessionId, {
                                filename: file.name,
                                base64,
                                mimeType: file.type || undefined
                            });
                        } finally {
                            try { showLoadingOverlay(false); } catch (_) {}
                        }

                        const resultPath = resp && (resp.container_path || resp.path);
                        if (resultPath) {
                            // Type the path into the terminal input without submitting
                            const text = String(resultPath);
                            if (this.wsClient && typeof this.wsClient.send === 'function') {
                                this.wsClient.send('stdin', { session_id: this.sessionId, data: text });
                            }
                        }
                    } catch (err) {
                        try { errorHandler.showError('Image upload failed', err); } catch (_) { console.error(err); }
                    }
                };
                el.addEventListener('dragover', dragOver);
                el.addEventListener('drop', dropHandler);
            }
        } catch (_) {}

        // Handle paste of image content from clipboard (container sessions only)
        try {
            const el = this.container;
            if (el && typeof el.addEventListener === 'function') {
                const pasteHandler = async (e) => {
                    // Ensure a given paste event is only handled once
                    try {
                        const src = (e && e._tsPasteSource) || 'unknown';
                        if (e && e._tsPasteHandled === true) {
                            try { console.log('[TerminalSession] pasteHandler: duplicate event ignored', { sessionId: this.sessionId, source: src }); } catch (_) {}
                            try { e.preventDefault(); } catch (_) {}
                            try { e.stopPropagation(); } catch (_) {}
                            return;
                        }
                        try { e._tsPasteHandled = true; } catch (_) {}
                    } catch (_) {}
                    try {
                        // Ensure we only handle a given paste event once.
                        // This handler is registered on both the container (bubble)
                        // and the document (capture) to catch all cases. Without a
                        // guard, both listeners may process the same event and
                        // cause duplicate stdin sends for plain-text pastes.
                        if (e && e.__tsPasteHandled) {
                            return; // already handled by the other phase/listener
                        }
                        const mgr = getContext()?.app?.modules?.terminal;
                        const sd = mgr?.sessionList?.getSessionData?.(this.sessionId) || this.sessionData || {};
                        const interactive = mgr?.isSessionInteractive ? mgr.isSessionInteractive(sd) : (sd.interactive !== false);
                        if (!interactive) { return; }

                        const hasClipboard = !!(e && e.clipboardData);
                        const items = hasClipboard && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
                        // Detect if clipboard contains an image file
                        let imageFile = null;
                        for (const it of items) {
                            if (!it) continue;
                            const isImg = it.kind === 'file' && typeof it.type === 'string' && it.type.toLowerCase().startsWith('image/');
                            if (isImg) { imageFile = it.getAsFile(); break; }
                        }

                        // Prefer handling text-only pastes to avoid WS message bursts
                        if (hasClipboard && !imageFile) {
                            let text = '';
                            try { text = e.clipboardData.getData('text/plain') || e.clipboardData.getData('text') || ''; } catch (_) { text = ''; }
                            if (text && this.wsClient && typeof this.wsClient.send === 'function' && this.isAttached) {
                                // Prevent default and stop propagation so xterm's internal paste won't emit onData
                                try { e.preventDefault(); } catch (_) {}
                                try { e.stopPropagation(); } catch (_) {}
                                // Suppress any immediate onData emitted by xterm for this paste (very short window)
                                this._ignoreNextOnData = Date.now() + 80; // ms
                                try { console.log('[TerminalSession] pasteHandler: sending text to stdin', { sessionId: this.sessionId, length: String(text).length }); } catch (_) {}
                                this.wsClient.send('stdin', { session_id: this.sessionId, data: String(text) });
                                return; // handled
                            }
                        }

                        // If we have an image file and container session, upload and paste returned path
                        const isoMode = sd && sd.isolation_mode;
                        const supportsUpload = !!imageFile && (isoMode === 'container' || isoMode === 'directory' || isoMode === 'none');
                        if (!supportsUpload) { return; }

                        // Feature gate (frontend no-op): if uploads disabled, do not intercept paste
                        try {
                            const features = (appStore.getState()?.auth?.features) || {};
                            if (features.image_uploads_enabled !== true) {
                                return; // allow default paste behavior
                            }
                        } catch (_) {}

                        // Prevent default paste into terminal only when we will upload
                        try { e.__tsPasteHandled = true; } catch (_) {}
                        try { e.preventDefault(); } catch (_) {}
                        try { e.stopPropagation(); } catch (_) {}
                        // Suppress any immediate onData emitted by xterm for this paste (very short window)
                        this._ignoreNextOnData = Date.now() + 80; // ms
                        const base64 = await new Promise((resolve, reject) => {
                            try {
                                const reader = new FileReader();
                                reader.onerror = () => reject(new Error('Failed to read clipboard image'));
                                reader.onload = () => resolve(String(reader.result || ''));
                                reader.readAsDataURL(imageFile);
                            } catch (err) { reject(err); }
                        });
                        try { showLoadingOverlay(true, 'Uploading pasted image to container...'); } catch (_) {}
                        let resp;
                        try {
                            const name = imageFile.name || `pasted_${Date.now()}.png`;
                            resp = await apiService.uploadSessionImage(this.sessionId, {
                                filename: name,
                                base64,
                                mimeType: imageFile.type || 'image/png'
                            });
                        } finally {
                            try { showLoadingOverlay(false); } catch (_) {}
                        }
                        const containerPath = resp && (resp.container_path || resp.path);
                        if (containerPath) {
                            const text = String(containerPath);
                            if (this.wsClient && typeof this.wsClient.send === 'function') {
                                try { console.log('[TerminalSession] pasteHandler: uploaded image path sent to stdin', { sessionId: this.sessionId, pathLength: text.length }); } catch (_) {}
                                this.wsClient.send('stdin', { session_id: this.sessionId, data: text });
                            }
                        }
                    } catch (err) {
                        try { errorHandler.showError('Paste handling failed', err); } catch (_) { console.error(err); }
                    }
                };
                // Listen on the terminal container for bubbling paste
                // Wrap to annotate source for logging and guarding
                const elBubbleHandler = (evt) => {
                    try { evt._tsPasteSource = 'el-bubble'; } catch (_) {}
                    pasteHandler(evt);
                };
                el.addEventListener('paste', elBubbleHandler);
                // Also attach a capturing listener at the document level so we catch paste even if xterm intercepts
                const docHandler = (evt) => {
                    // Only handle when the activeElement is within this terminal container
                    try {
                        const ae = document.activeElement;
                        if (!ae || !el || !(el.contains(ae) || ae === el)) return;
                    } catch (_) {}
                    try { evt._tsPasteSource = 'doc-capture'; } catch (_) {}
                    pasteHandler(evt);
                };
                document.addEventListener('paste', docHandler, true);
                this._docPasteCleanup = () => { try { document.removeEventListener('paste', docHandler, true); } catch (_) {} };
            }
        } catch (_) {}

        // Handle keyboard shortcuts for scrolling (Issue #224)
        this.terminal.attachCustomKeyEventHandler((event) => {
            // Don't let terminal handle our app shortcuts (Shift+Cmd/Alt combinations)
            // Return false to prevent terminal from processing these
            // but the DOM event will still bubble up to our app handlers
            if (event.shiftKey && (event.metaKey || event.altKey)) {
                return false;
            }
            
            // Handle Home key - scroll to top
            if (event.key === 'Home' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                this.terminal.scrollToTop();
                return false; // Prevent default terminal handling
            }
            
            // Handle End key - scroll to bottom
            if (event.key === 'End' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                this.terminal.scrollToBottom();
                return false; // Prevent default terminal handling
            }
            
            // Allow other keys to be handled normally
            return true;
        });
    }
    
    async attach(forceLoadHistory = false) {
        console.log(`[TerminalSession] attach() called for session ${this.sessionId}, forceLoadHistory=${forceLoadHistory}`);

        if (!this.isAttached && this.terminal) {
            // Clear terminal before attaching to avoid showing old content
            this.terminal.clear();
            // Gate stdout immediately to prevent duplicates while resolving history
            this._gateWsStdout();
            // Register history sync handler BEFORE sending attach to avoid race
            // where a fast server response emits ws-attached before we listen.
            // This ensures we never hit the 5000ms fallback when the backend is fast.
            this.handleHistoryLoading(forceLoadHistory);

            console.log(`[TerminalSession] Sending attach message for session ${this.sessionId}`);
            // Send attach message to get history marker
            this.wsClient.send('attach', {
                session_id: this.sessionId
            });

            // Mark as attached immediately to start receiving output
            this.isAttached = true;
            console.log(`[TerminalSession] Marked as attached, history sync armed for session ${this.sessionId}`);
            
            // Ensure proper sizing after DOM has settled
            // Use requestAnimationFrame to ensure layout is complete
            requestAnimationFrame(() => {
                this.fit();
                this.logFitDimensions('attach-fit');

                // Note: Focus is now handled after history loading completes
                // to prevent focus events from corrupting the output stream

                // Emit ready event
                this.eventBus.emit('terminal-ready', { sessionId: this.sessionId });
            });
        } else {
            console.log(`[TerminalSession] Skipping attach - already attached or no terminal`);
        }
    }
    
    detach(dispose = false) {
        if (this.isAttached) {
            this.wsClient.send('detach', {
                session_id: this.sessionId
            });
            this.isAttached = false;
        }

        // Clear any pending output queue on detach
        this.outputQueue = [];
        // Drop any buffered early stdout and open the gate
        this._clearWsStdoutBuffer();
        this._openWsStdoutGate();
        this.resetHistorySyncState();
        // Remove pending ws-attached handler to avoid races after detach
        try { if (this._wsAttachHandler) { this.eventBus.off('ws-attached', this._wsAttachHandler); } } catch (_) {}
        this._wsAttachHandler = null;
        // Abort in-flight streamed history
        try { if (this._historyAbort) { this._historyAbort.abort(); this._historyAbort = null; } } catch (_) {}

        // Disconnect observers and timers
        try { if (this._io) { this._io.disconnect(); this._io = null; } } catch (_) {}
        try { if (this._ro) { this._ro.disconnect(); this._ro = null; } } catch (_) {}
        try { if (this._deferredFitTimer) { clearTimeout(this._deferredFitTimer); this._deferredFitTimer = null; } } catch (_) {}

        // Only clean up resources if disposing completely
        if (dispose) {
            // Clean up mobile touch handler
            if (this.mobileTouch) {
                this.mobileTouch.teardown();
                this.mobileTouch = null;
            }
            
            // Clean up auto-copy event listeners
            if (this.autoCopyCleanup) {
                this.autoCopyCleanup();
                this.autoCopyCleanup = null;
            }
            
            // Clean up web links addon
            if (this.webLinksAddon) {
                this.webLinksAddon = null;
            }
            
            // Dispose terminal to prevent memory leaks
            if (this.terminal) {
                this.terminal.dispose();
                this.terminal = null;
                this.fitAddon = null;
                this.isInitialized = false;
            }
        }
    }

    dispose() {
        // Complete disposal - detach and clean up everything
        this.detach(true);
        try { if (this._docPasteCleanup) { this._docPasteCleanup(); this._docPasteCleanup = null; } } catch (_) {}
        try { if (this.wsClient && typeof this.wsClient.teardown === 'function') this.wsClient.teardown(); } catch (_) {}
    }
    
    handleOutput(data, fromQueue = false) {
        // During attach, gate stdout to prevent duplicates with streamed history
        if (this._wsOutputGated) {
            // Buffer early stdout; if we end up loading history, the buffer will be dropped.
            try {
                const s = typeof data === 'string' ? data : String(data ?? '');
                if (this._wsOutputBufferBytes + s.length > this._wsOutputBufferMaxBytes) {
                    while (this._wsOutputBuffer.length && this._wsOutputBufferBytes + s.length > this._wsOutputBufferMaxBytes) {
                        const first = this._wsOutputBuffer.shift();
                        this._wsOutputBufferBytes -= (first ? first.length : 0);
                    }
                }
                this._wsOutputBuffer.push(s);
                this._wsOutputBufferBytes += s.length;
            } catch (_) { /* ignore */ }
            return; // do not write to terminal while gated
        }
        // Write output directly to terminal - server handles dynamic title updates
        if (this.terminal && this.isAttached) {
            // Live transition markers disabled; only input-based markers are used
            // Optional debug: inspect chunks that contain 'rgb:' or any ESC bytes
            try {
                if (AnsiDebug.enabled) {
                    const s = (typeof data === 'string') ? data : '';
                    if (s && (s.indexOf('rgb:') !== -1 || s.indexOf('\u001b') !== -1 || s.indexOf('\x1b') !== -1)) {
                        AnsiDebug.log('live-chunk', s.slice(0, 4096));
                    }
                }
            } catch (_) {}
            // Update alt-screen state before filters to ensure detection of private modes
            try {
                const raw = (typeof data === 'string') ? data : String(data ?? '');
                this._updateAltScreenFromText(raw);
            } catch (_) {}
            let text = data;
            try {
                const state = appStore.getState();
                const tPrefs = state?.preferences?.terminal || {};
                const filterOsc = tPrefs.filterOscColors !== false; // default true
                const collapseRgb = tPrefs.collapseNakedRgbRuns !== false; // default true
                if (typeof text === 'string' && (filterOsc || collapseRgb)) {
                    text = applyAnsiFilters(text, { filterOscColors: filterOsc, collapseRgbRuns: collapseRgb });
                }
            } catch (_) {}
            this.terminal.write(text);
        }
    }

    _updateAltScreenFromText(text) {
        try {
            const s = (typeof text === 'string') ? text : String(text ?? '');
            const re = /\x1b\[\?(?:1049|1047|47)([hl])/g;
            let m;
            while ((m = re.exec(s)) !== null) {
                const op = m[1];
                if (op === 'h') this._altScreen = true; else if (op === 'l') this._altScreen = false;
            }
        } catch (_) { /* ignore */ }
    }

    isAltScreen() { return !!this._altScreen; }

    insertVisibleMarkerLine(opts = {}) {
        try {
            if (!this.terminal) return;
            // Compose a dim timestamp line; ord optional for debugging
            const tms = Number.isFinite(Number(opts.t)) ? Math.floor(Number(opts.t)) : Date.now();
            const d = new Date(tms);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const ss = String(d.getSeconds()).padStart(2, '0');
            const ord = (opts.ord !== undefined && opts.ord !== null) ? ` #${opts.ord}` : '';
            const label = (typeof opts.text === 'string' && opts.text) ? opts.text : 'submitted';
            const line = `\r\n\x1b[2m[${hh}:${mm}:${ss}] ${label}${ord}\x1b[0m\r\n`;
            // Insert regardless of alt-screen per request
            this.terminal.write(line);
        } catch (_) { /* best-effort */ }
    }

    registerClientOrdinalMarker(t = Date.now(), ord = null) {
        try {
            if (!this.terminal) return false;
            const mk = this.terminal.registerMarker(0);
            if (!mk) return false;
            // Determine next local ordinal when not provided
            let nextOrd = null;
            if (Number.isFinite(Number(ord))) {
                nextOrd = Number(ord);
            } else {
                // Prefer monotonic client counter; if missing, derive from existing client markers
                if (Number.isInteger(this._nextClientOrdinal) && this._nextClientOrdinal > 0) {
                    nextOrd = this._nextClientOrdinal;
                    this._nextClientOrdinal = nextOrd + 1;
                } else {
                    let maxOrd = 0;
                    try {
                        for (const e of (this.activityMarkers || [])) {
                            if (e?.meta?.client === true) {
                                const o = Number(e?.meta?.ord);
                                if (Number.isFinite(o)) maxOrd = Math.max(maxOrd, o);
                            }
                        }
                    } catch (_) {}
                    nextOrd = maxOrd + 1; // first marker becomes 1
                    this._nextClientOrdinal = nextOrd + 1;
                }
            }
            // Capture the line at the time of registration and the buffer bottom for diagnostics
            let capturedLine = null;
            let bufferBottom = null;
            try {
                capturedLine = (typeof mk.line === 'number') ? mk.line : null;
                const buf = this.terminal?.buffer?.active;
                bufferBottom = (buf && typeof buf.length === 'number') ? (buf.length - 1) : null;
            } catch (_) {}
            // Normalize timestamp and compute line
            const tNorm = Number.isFinite(Number(t)) ? Math.floor(Number(t)) : Date.now();
            const lineNorm = Number.isFinite(Number(capturedLine)) ? capturedLine : (Number.isFinite(Number(bufferBottom)) ? bufferBottom : 0);

            // De-duplicate: if the most recent client marker has effectively the same timestamp
            // (within 750ms) and same line, skip adding a duplicate entry. This guards against
            // accidental double handler registration or duplicate notifications.
            try {
                const prev = this._clientMarkers.length ? this._clientMarkers[this._clientMarkers.length - 1] : null;
                if (prev) {
                    const dt = Math.abs((Number(prev?.t) || 0) - tNorm);
                    const sameLine = Number(prev?.line) === Number(lineNorm);
                    if (dt <= 750 && sameLine) {
                        // Still persist once if not already persisted in this window
                        this._lastClientMarkerTs = tNorm;
                        return true;
                    }
                }
            } catch (_) { /* best-effort */ }

            // Record client marker entry
            const entry = { t: tNorm, line: lineNorm };
            this._clientMarkers.push(entry);
            this._clientMarkerNavIndex = this._clientMarkers.length - 1;
            // Persist to server (best-effort)
            try { if (typeof apiService?.addSessionMarker === 'function') apiService.addSessionMarker(this.sessionId, entry).catch(() => {}); } catch (_) {}
            try {
                console.log('[ClientMarker]', {
                    sessionId: this.sessionId,
                    ord: nextOrd,
                    line_at_capture: capturedLine,
                    buffer_bottom_at_capture: bufferBottom
                });
            } catch (_) {}
            return true;
        } catch (_) { return false; }
    }

    getClientMarkers() {
        try { return Array.isArray(this._clientMarkers) ? this._clientMarkers.slice() : []; } catch (_) { return []; }
    }

    seekToClientMarker(index) {
        try {
            const list = Array.isArray(this._clientMarkers) ? this._clientMarkers : [];
            if (index < 0 || index >= list.length) return false;
            const line = Number(list[index]?.line);
            if (Number.isFinite(line) && line >= 0) {
                try { this.terminal.scrollToLine(line); } catch (_) {}
                this._clientMarkerNavIndex = index;
                return true;
            }
        } catch (_) {}
        return false;
    }

    // Convenience: scroll terminal viewport to bottom
    scrollToBottom() {
        try { this.terminal?.scrollToBottom?.(); } catch (_) {}
    }

    // Handle history loading asynchronously
    async handleHistoryLoading(forceLoadHistory = false) {
        console.log(`[TerminalSession] handleHistoryLoading() called for session ${this.sessionId}`);
        console.log(`[TerminalSession] Session data load_history flag: ${this.sessionData?.load_history}`);

        this.clearHistorySyncTimer();
        this.historySyncComplete = false;
        this.historyMarker = null;
        this.historyByteOffset = null;
        // Remove any existing handler to avoid duplicate listeners across refreshes
        try { if (this._wsAttachHandler) { this.eventBus.off('ws-attached', this._wsAttachHandler); } } catch (_) {}
        this._wsAttachHandler = null;

        // Set up handler for attach response with history marker
        const handler = async (event) => {
            console.log(`[TerminalSession] Received ws-attached event:`, event);
            if (event.type === 'attached' && event.detail.session_id === this.sessionId) {
                this.historyMarker = event.detail.history_marker;
                this.historyByteOffset = event.detail.history_byte_offset != null ? Number(event.detail.history_byte_offset) : null;
                this.eventBus.off('ws-attached', handler);
                if (this._wsAttachHandler === handler) this._wsAttachHandler = null;
                console.log(`[TerminalSession] Got history marker ${this.historyMarker}, byte offset ${this.historyByteOffset} for session ${this.sessionId}`);

                // Only load history if we have a marker and should load. Honor forceLoadHistory override.
                if (this.historyMarker !== null && (forceLoadHistory || this.sessionData.load_history !== false)) {
                    console.log(`[TerminalSession] Loading history for session ${this.sessionId}`);
                    // Set loading flag to queue any incoming output during history load
                    this.isLoadingHistory = true;
                    // We are going to load history — drop any early buffered stdout to avoid duplicates
                    this._clearWsStdoutBuffer();

                    // Load existing session output to fill the buffer
                    await this.loadExistingOutput(forceLoadHistory);

                    console.log(`[TerminalSession] Sending history_loaded message for session ${this.sessionId}`);
                    // Notify server that history loading is complete
                    this.wsClient.send('history_loaded', {
                        session_id: this.sessionId
                    });

                    console.log(`[TerminalSession] History loading complete for session ${this.sessionId}`);
                    // Server will send any queued output after receiving history_loaded message

                    // Clear marker now that sync is done and focus the terminal post-load
                    this.finishHistorySync();
                    // Open gate now that history is merged; do not flush (buffer was cleared)
                    this._openWsStdoutGate();
                    this.focusAfterHistoryLoad();
                } else {
                    console.log(`[TerminalSession] Skipping history load: marker=${this.historyMarker}, load_history=${this.sessionData?.load_history}`);
                    // If not loading history, safe to focus immediately
                    this.finishHistorySync();
                    // Open gate and flush any buffered early stdout (we skipped history)
                    this._openWsStdoutGate(true);
                    this.focusAfterHistoryLoad();
                }
            }
        };
        this.eventBus.on('ws-attached', handler);
        this._wsAttachHandler = handler;
        console.log(`[TerminalSession] Registered ws-attached handler for session ${this.sessionId}`);

        // Clean up handler after timeout (5 seconds to allow for network delays)
        this.historySyncTimer = setTimeout(() => {
            try { this.eventBus.off('ws-attached', handler); } catch (_) {}
            if (this._wsAttachHandler === handler) this._wsAttachHandler = null;
            // If we still haven't loaded history, proceed without it
            if (!this.historySyncComplete && (forceLoadHistory || this.sessionData?.load_history !== false)) {
                console.log(`[TerminalSession] No attach response received after 5000ms for session ${this.sessionId}, proceeding without history`);
                this.finishHistorySync();
                // Safe to focus since we're not loading history
                // Open gate and flush any buffered output to avoid data loss
                this._openWsStdoutGate(true);
                this.focusAfterHistoryLoad();
            }
            this.historySyncTimer = null;
        }, 5000);
    }

    // Output queue no longer needed with asynchronous history loading
    // Server handles output queuing during history synchronization
    
    clear() {
        if (this.terminal) {
            this.terminal.clear();
        }
    }
    
    fit() {
        if (this.fitAddon && this.terminal) {
            try {
                const termPageActive = !!document.getElementById('terminal-page')?.classList.contains('active');
                const el = this.container;
                const isVisible = !!(el && el.offsetParent !== null);
                const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
                const bigEnough = rect ? (rect.width >= 100 && rect.height >= 50) : false;

                const proposed = this.fitAddon.proposeDimensions();
                const saneProposed = proposed && proposed.cols >= 40 && proposed.rows >= 10;

                if (!(termPageActive && isVisible && bigEnough && saneProposed)) {
                    // Ensure observers are installed so we'll re-fit on visibility/size changes
                    this.setupFitObservers();
                    this.logFitDimensions('manual-fit-skipped', { termPageActive, isVisible, bigEnough, proposed });
                    return;
                }

                this.fitAddon.fit();
                this.logFitDimensions('manual-fit', { proposed });
            } catch (error) {
                console.error('Error fitting terminal:', error);
            }
        } else {
            console.log(`[TerminalSession] fit() called but fitAddon or terminal not available`);
        }
    }
    
    resize(cols, rows) {
        if (this.terminal) {
            this.terminal.resize(cols, rows);
        }
    }
    
    focus() {
        // Prevent focus if mobile keyboard input is active to avoid triggering mobile keyboard
        try {
            if (typeof window !== 'undefined') {
                if (window._mobileKeyboardInputActive) {
                    return;
                }
            }
        } catch (_) {
            // Ignore guard errors and fall through to best-effort focus.
        }

        // Do not steal focus from the sidebar "Search sessions..." input.
        // When the user is actively typing in the session search box, any
        // auto-focus behavior from terminal lifecycle events should be suppressed.
        try {
            const active = document.activeElement;
            if (active) {
                if (active.id === 'session-search' || active.classList?.contains('search-input')) {
                    return;
                }
                if (typeof active.closest === 'function') {
                    // Avoid stealing focus from interactive notification toasts or the notification center.
                    const inNotification = active.closest('.notification');
                    const inNotificationCenter = active.closest('#notification-center-panel');
                    if (inNotification || inNotificationCenter) {
                        return;
                    }
                }
            }
        } catch (_) {
            // Ignore focus guard errors and fall through to best-effort focus.
        }

        if (this.terminal) {
            this.terminal.focus();
        }
    }

    // Focus terminal after history loading is complete to prevent focus events during replay
    focusAfterHistoryLoad() {
        // Only focus terminal if not on mobile to prevent keyboard popup
        const preventFocus = this.shouldPreventAutoFocus();
        console.log('[TerminalSession] Post-history focus decision:', { preventFocus, willFocus: !preventFocus });
        if (!preventFocus) {
            console.log('[TerminalSession] Focusing terminal after history load');
            // Small delay to ensure all history output has been processed
            setTimeout(() => {
                if (this.isAttached) {
                    this.focus();
                }
            }, 50);
        } else {
            console.log('[TerminalSession] Skipping focus on mobile to prevent keyboard popup');
        }
    }
    
    updateFontSettings(fontSize, fontFamily) {
        if (this.terminal) {
            // Update terminal options
            this.terminal.options.fontSize = fontSize;
            this.terminal.options.fontFamily = fontFamily;
            
            // Force a refresh to apply the new settings
            if (this.fitAddon) {
                // Trigger a guarded fit to recalculate dimensions with new font
                this.fit();
                this.logFitDimensions('font-update-fit', { fontSize, fontFamily });
            }
        }
    }

    /**
     * Update terminal theme dynamically
     * @param {('dark'|'light')} theme
     */
    updateTheme(theme) {
        if (!this.terminal) return;
        const interactive = this.sessionData ? (this.sessionData.interactive !== false) : true;
        const newTheme = getXtermTheme(theme, { interactive });
        try {
            // Use the official API so renderer state (incl. selection) updates reliably
            if (typeof this.terminal.setOption === 'function') {
                this.terminal.setOption('theme', newTheme);
            } else {
                // Fallback for older xterm builds
                this.terminal.options.theme = newTheme;
            }
            const rows = this.terminal.rows || 24;
            this.terminal.refresh(0, rows - 1);
        } catch (e) {
            // non-fatal
        }
    }

    async loadExistingOutput(forceLoadHistory = false) {
        console.log(`[TerminalSession] loadExistingOutput() called for session ${this.sessionId}, forceLoadHistory=${forceLoadHistory}`);

        // Only show overlay if history data isn't already preloaded or being fetched
        let overlayCtrl = null;
        const showOverlay = !this.preloadedHistoryData && !this.historyFetchPromise;
        console.log(`[TerminalSession] Show overlay: ${showOverlay}, preloaded: ${!!this.preloadedHistoryData}, fetchPromise: ${!!this.historyFetchPromise}`);

        try {
            if (this.container && showOverlay) {
                try {
                    overlayCtrl = showLoadingOverlay(this.container, 'Fetching session history...');
                } catch (_) {}
            }
        } catch (_) {}

        try {
            // Load history logic:
            // - Always load for terminated sessions
            // - For active sessions: only if load_history !== false, unless forceLoadHistory=true
            const isActiveSession = this.sessionData && this.sessionData.is_active !== false;
            let shouldSkipHistory;
            
            if (!isActiveSession) {
                // Terminated session - always load history
                shouldSkipHistory = false;
            } else {
                // Active session (both manual and auto attach) - check load_history flag
                // Skip only if load_history is explicitly false
                shouldSkipHistory = this.sessionData.load_history === false;
                if (forceLoadHistory === true) {
                    // Override skip behavior when a forced refresh is requested
                    shouldSkipHistory = false;
                }
            }
            
            if (shouldSkipHistory) {
                console.log(`[TerminalSession] Skipping history for session ${this.sessionId} (load_history=${this.sessionData?.load_history})`);
                // Signal ready immediately when skipping history
                try { overlayCtrl?.remove(); } catch (_) {}
                this.eventBus.emit('terminal-ready', { sessionId: this.sessionId });
                return;
            }

            console.log(`[TerminalSession] Will load history for session ${this.sessionId}`);

            // Stream raw history to terminal incrementally
            try { overlayCtrl?.setText('Loading session history... 0%'); } catch (_) {}
            await this._streamHistoryIntoTerminal({ overlayCtrl });
        } catch (error) {
            // Include session creation time in context so the error handler
            // can suppress very-early 404s during startup races
            const createdAt = this.sessionData && this.sessionData.created_at ? this.sessionData.created_at : null;
            errorHandler.handle(error, {
                context: 'load_existing_output',
                sessionId: this.sessionId,
                sessionCreatedAt: createdAt
            });
            // Signal ready even on error to prevent stuck loading
            try { overlayCtrl?.remove(); } catch (_) {}
            this.eventBus.emit('terminal-ready', { sessionId: this.sessionId });
        }
    }

    /**
     * Initialize terminal and stream history via raw endpoint
     */
    async initializeForHistoryStream(options = {}) {
        if (this.isInitialized) return;
        // Terminal options for read-only history
        const state = appStore.getState();
        const fontSize = state.preferences?.terminal?.fontSize ?? 14;
        const fontFamily = state.preferences?.terminal?.fontFamily ?? fontDetector.getDefaultFont();
        const terminalOptions = {
            fontSize,
            fontFamily,
            cursorBlink: false,
            disableStdin: true,
            rows: 24,
            cols: 80,
            theme: getXtermTheme(getEffectiveTheme(), { interactive: false }),
            scrollback: 10000
        };
        this.terminal = new Terminal(terminalOptions);
        this.fitAddon = new FitAddon.FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.setupHyperlinks();
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'terminal-container history-terminal-container';
            this.container.style.flex = '1';
            this.container.style.overflow = 'hidden';
        }
        this.terminal.open(this.container);
        this.fitAddon.fit();
        this.logFitDimensions('history-stream-init');
        this.setupFitObservers();
        this.setupFontsReadyHook();

        // Seed client markers from server first
        try {
            const rm = Array.isArray(this.sessionData?.render_markers) ? this.sessionData.render_markers : [];
            if (rm && rm.length) {
                const seenTs = [];
                for (const m of rm) {
                    const t = Number.isFinite(Number(m?.t)) ? Math.floor(Number(m.t)) : null;
                    const line = Number.isFinite(Number(m?.line)) ? Math.max(0, Math.floor(Number(m.line))) : null;
                    if (t == null || line == null) continue;
                    // Coalesce duplicates by timestamp within ~750ms, regardless of line
                    if (seenTs.some((pt) => Math.abs(pt - t) <= 750)) continue;
                    seenTs.push(t);
                    this._clientMarkers.push({ t, line });
                }
                this._clientMarkerNavIndex = this._clientMarkers.length - 1;
                console.log('[ClientMarker][seed]', { sessionId: this.sessionId, count: this._clientMarkers.length });
            }
        } catch (_) {}
        // Do not add a synthetic start marker in history view either

        // Enable replay-seek debugging if requested (history views only)
        this.initMarkersReplayIfEnabled();
        await this._streamHistoryIntoTerminal(options);
        // Mobile handling
        if (this.isMobile) {
            try { this.mobileTouch?.teardown(); } catch (_) {}
            this.mobileTouch = new MobileTerminalTouchHandler(this.terminal, this.sessionId, this.eventBus, null);
            this.mobileTouch.setup();
        }
        this.isInitialized = true;
    }

    // ensureClientStartMarker removed: we no longer generate a client start marker

    // Internal: stream history into terminal with progressive rendering and marker placement
    async _streamHistoryIntoTerminal({ overlayCtrl } = {}) {
        // Guard against races where terminal or sessionId might be missing
        if (!this.terminal || !this.sessionId) {
            try { overlayCtrl?.remove?.(); } catch (_) {}
            console.warn('[TerminalSession] History stream aborted: terminal/sessionId not available', { hasTerminal: !!this.terminal, sessionId: this.sessionId });
            return;
        }
        const controller = new AbortController();
        this._historyAbort = controller;

        const onProgress = ({ receivedBytes, contentLength, percent }) => {
            try {
                if (!overlayCtrl) return;
                if (contentLength && receivedBytes >= 0 && percent != null) {
                    overlayCtrl.setText(`Loading session history... ${percent}%`);
                } else {
                    const kb = Math.round((receivedBytes || 0) / 1024);
                    overlayCtrl.setText(`Streaming session history... ${kb} KB`);
                }
            } catch (_) {}
        };

        // Determine session createdAt for initial marker timestamp
        let createdAtMs = null;
        try {
            const ca = this.sessionData?.created_at || this.sessionData?.createdAt;
            const t = Date.parse(String(ca));
            if (Number.isFinite(t)) createdAtMs = t;
        } catch (_) {}

        // For history views (terminated sessions), always fetch full history without byte range limits.
        // The historyByteOffset is only relevant for active sessions syncing with live output.
        const useByteOffset = !this.isHistoryView && this.historyByteOffset != null;
        await streamHistoryToTerminal({
            terminal: this.terminal,
            sessionId: this.sessionId,
            createdAt: createdAtMs,
            signal: controller.signal,
            onProgress,
            // Use rangeEnd to limit history to only return data UP TO the byte offset at marker time
            // This ensures we don't get duplicates: history returns data up to marker, queued output has data after marker
            // If historyByteOffset is 0, history was empty at marker time, so return empty (rangeEnd = -1 means bytes=0--1 which is invalid, so we'll skip range)
            // If historyByteOffset > 0, rangeEnd = historyByteOffset - 1 means return up to (but not including) that offset
            rangeEnd: useByteOffset && this.historyByteOffset > 0 ? this.historyByteOffset - 1 : null,
            rangeStart: useByteOffset && this.historyByteOffset === 0 ? 0 : null,
            onMarker: (marker, meta) => {
                try { this.activityMarkers.push({ marker, meta }); this._markerNavIndex = this.activityMarkers.length - 1; } catch (_) {}
            }
        });

        // Done: clear overlay on next render
        let removed = false;
        const disposeAfter = this.terminal.onRender(() => {
            if (removed) return;
            removed = true;
            try { overlayCtrl?.remove(); } catch (_) {}
            this.eventBus.emit('terminal-ready', { sessionId: this.sessionId });
            try { disposeAfter?.dispose?.(); } catch (_) {}
        });
        try { this.terminal.refresh(0, (this.terminal.rows || 24) - 1); } catch (_) {}
        setTimeout(() => {
            if (!removed) {
                removed = true;
                try { overlayCtrl?.remove(); } catch (_) {}
                this.eventBus.emit('terminal-ready', { sessionId: this.sessionId });
                try { disposeAfter?.dispose?.(); } catch (_) {}
            }
        }, 50);
        try { this._historyAbort = null; } catch (_) {}
    }

    // Deprecated: client-side live markers are disabled; timeline markers are input-driven
    registerActiveMarkerNow() { return false; }
    markLiveActivePending() { this._livePendingActive = false; this._liveActiveBytes = 0; return false; }

    // Navigation helpers for active transition markers
    jumpToNextTransition() {
        try {
            const list = this.getClientMarkers();
            if (!list || !list.length) return false;
            if (!Number.isInteger(this._clientMarkerNavIndex) || this._clientMarkerNavIndex < 0) {
                this._clientMarkerNavIndex = 0;
            } else {
                this._clientMarkerNavIndex = (this._clientMarkerNavIndex + 1) % list.length;
            }
            return this.seekToClientMarker(this._clientMarkerNavIndex);
        } catch (_) { return false; }
    }

    jumpToPrevTransition() {
        try {
            const list = this.getClientMarkers();
            if (!list || !list.length) return false;
            if (!Number.isInteger(this._clientMarkerNavIndex) || this._clientMarkerNavIndex < 0) {
                this._clientMarkerNavIndex = 0;
            } else {
                this._clientMarkerNavIndex = (this._clientMarkerNavIndex - 1 + list.length) % list.length;
            }
            return this.seekToClientMarker(this._clientMarkerNavIndex);
        } catch (_) { return false; }
    }

    // Seek to a specific marker index (in activityMarkers array) with replay fallback
    _seekToMarkerIndex(index) {
        try {
            const entry = this.activityMarkers[index];
            if (!entry) return false;
            // Special-case the initial marker: jump to top of buffer
            try {
                const mr = (entry?.meta && Number.isFinite(Number(entry.meta.raw))) ? Math.floor(Number(entry.meta.raw)) : null;
                if (mr === 0) {
                    try { this.terminal.scrollToTop(); } catch (_) {}
                    this._markerNavIndex = index;
                    // ordinal tracking deprecated
                    return true;
                }
            } catch (_) {}
            const line = (entry?.marker && typeof entry.marker.line === 'number') ? entry.marker.line : -1;
            if (line >= 0) {
                try { this.terminal.scrollToLine(line); } catch (_) {}
                this._markerNavIndex = index;
                // ordinal tracking deprecated
                return true;
            }
            // Fallback: if we captured a line but xterm marker line is not available, scroll to captured line
            try {
                const cap = Number(entry?.meta?.line_at_capture);
                if (Number.isFinite(cap) && cap >= 0) {
                    this.terminal.scrollToLine(cap);
                    this._markerNavIndex = index;
                    return true;
                }
            } catch (_) {}
            // Replay fallback for history view
            if (typeof this.isReplaySeekEnabled === 'function' && this.isReplaySeekEnabled()) {
                return this.seekToMarkerByReplay(index);
            }
        } catch (_) {}
        return false;
    }

    // Compute a reduced list of marker indices by coalescing duplicates near the same line/offset
    getCoalescedMarkerIndices(options = {}) {
        const minLineDelta = Number.isFinite(Number(options.minLineDelta)) ? Math.max(0, Math.floor(options.minLineDelta)) : 1;
        const minRawDelta = Number.isFinite(Number(options.minRawDelta)) ? Math.max(0, Math.floor(options.minRawDelta)) : 256;
        const timeWindowMs = Number.isFinite(Number(options.timeWindowMs)) ? Math.max(0, Math.floor(options.timeWindowMs)) : 5000;
        const out = [];
        const markers = Array.isArray(this.activityMarkers) ? this.activityMarkers : [];
        let lastLine = null, lastRaw = null, lastT = null;
        for (let i = 0; i < markers.length; i++) {
            const m = markers[i];
            const line = (m?.marker && typeof m.marker.line === 'number') ? m.marker.line : null;
            const raw = (m?.meta && Number.isFinite(Number(m.meta.raw))) ? Math.floor(Number(m.meta.raw)) : null;
            const t = (m?.meta && Number.isFinite(Number(m.meta.t))) ? Math.floor(Number(m.meta.t)) : null;
            // Include only input-based markers
            const isInput = (typeof m?.meta?.kind === 'string' && m.meta.kind === 'input');
            if (!isInput) continue;
            let keep = true;
            if (line != null && lastLine != null) {
                if (Math.abs(line - lastLine) <= minLineDelta) keep = false;
            } else if (raw != null && lastRaw != null) {
                if (Math.abs(raw - lastRaw) <= minRawDelta) keep = false;
            } else if (t != null && lastT != null) {
                if (Math.abs(t - lastT) <= timeWindowMs) keep = false;
            }
            if (keep) {
                out.push(i);
                if (line != null) lastLine = line;
                if (raw != null) lastRaw = raw;
                if (t != null) lastT = t;
            }
        }
        return out;
    }

    // Choose the coalesced index closest to the viewport top
    _computeClosestCoalescedIndex(list) {
        try {
            const term = this.terminal;
            const vpTop = (term && term.buffer && term.buffer.active && typeof term.buffer.active.viewportY === 'number')
                ? term.buffer.active.viewportY
                : 0;
            let best = 0;
            let bestDist = Number.POSITIVE_INFINITY;
            for (let k = 0; k < list.length; k++) {
                const idx = (Number.isFinite(Number(list[k])) && this.activityMarkers)
                    ? this.activityMarkers.findIndex(e => Number(e?.meta?.ord) === Number(list[k]))
                    : list[k];
                const line = (idx >= 0 && this.activityMarkers[idx]?.marker && typeof this.activityMarkers[idx].marker.line === 'number')
                    ? this.activityMarkers[idx].marker.line
                    : 0;
                const d = Math.abs(line - vpTop);
                if (d < bestDist) { bestDist = d; best = k; }
            }
            return best;
        } catch (_) {
            return 0;
        }
    }

    // getOrdinalList deprecated (client markers used instead)

    
    // seekToOrdinal deprecated (client markers used instead)
detectMobile() {
        // Check if we're on a mobile device - include Capacitor/native wrapper
        const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const isCapacitor = (() => { try { return !!window.Capacitor; } catch (_) { return false; } })();
        const widthMobile = (window.innerWidth <= 768);
        const landscapeTouch = ('ontouchstart' in window && window.innerWidth > window.innerHeight && window.innerWidth <= 1366);
        return uaMobile || widthMobile || landscapeTouch || isCapacitor;
    }

    clearHistorySyncTimer() {
        if (this.historySyncTimer) {
            clearTimeout(this.historySyncTimer);
            this.historySyncTimer = null;
        }
    }

    finishHistorySync() {
        this.isLoadingHistory = false;
        this.historySyncComplete = true;
        this.clearHistorySyncTimer();
        this.historyMarker = null;
        this.historyByteOffset = null;
    }

    resetHistorySyncState() {
        this.isLoadingHistory = false;
        this.historySyncComplete = false;
        this.historyMarker = null;
        this.historyByteOffset = null;
        this.clearHistorySyncTimer();
    }

    // Internal: gate stdout until history decision is made
    _gateWsStdout() {
        this._wsOutputGated = true;
        this._wsOutputBuffer = [];
        this._wsOutputBufferBytes = 0;
    }

    _openWsStdoutGate(flushBuffered = false) {
        this._wsOutputGated = false;
        if (flushBuffered && this._wsOutputBuffer && this._wsOutputBuffer.length && this.terminal && this.isAttached) {
            try {
                const joined = this._wsOutputBuffer.join('');
                this._wsOutputBuffer = [];
                this._wsOutputBufferBytes = 0;
                this.handleOutput(joined, true);
                return;
            } catch (_) { /* ignore */ }
        }
        this._clearWsStdoutBuffer();
    }

    _clearWsStdoutBuffer() {
        try { this._wsOutputBuffer = []; this._wsOutputBufferBytes = 0; } catch (_) {}
    }

    setupMobileScrolling() {
        // Mobile scrolling is now handled by the MobileTerminalTouchHandler
        // This method is kept for backward compatibility but functionality moved to the handler
        console.log('[TerminalSession] setupMobileScrolling called - functionality delegated to MobileTerminalTouchHandler');
    }


    setupHyperlinks() {
        if (!this.terminal) {
            return;
        }

        // Use WebLinksAddon with desktop-aware handler to open URLs externally
        if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
            // xterm-addon-web-links invokes handler as (event, uri)
            const handler = (event, uri) => {
                const href = typeof uri === 'string' ? uri : String(uri ?? '');
                try {
                    if (window.desktop && window.desktop.isElectron && typeof window.desktop.openExternal === 'function') {
                        window.desktop.openExternal(href);
                    } else {
                        window.open(href, '_blank');
                    }
                } catch (_) {
                    try { window.open(href, '_blank'); } catch (_) {}
                }
                try { event?.preventDefault?.(); } catch (_) {}
            };
            this.webLinksAddon = new window.WebLinksAddon.WebLinksAddon(handler);
            this.terminal.loadAddon(this.webLinksAddon);
        } else {
            console.warn('WebLinksAddon not available - hyperlinks will not be clickable');
        }
    }

    /**
     * Initialize terminal for displaying history data only (read-only)
     * @param {string} historyData - The terminal history content to display
     */
    async initializeForHistory(historyData, options = {}) {
        if (this.isInitialized) {
            return;
        }

        

        // Get font settings from store preferences
        const state = appStore.getState();
        const fontSize = state.preferences?.terminal?.fontSize ?? 14;
        const fontFamily = state.preferences?.terminal?.fontFamily ?? fontDetector.getDefaultFont();

        // Create read-only terminal options for history display
        const terminalOptions = {
            fontSize: fontSize,
            fontFamily: fontFamily,
            cursorBlink: false,
            disableStdin: true, // Make it read-only
            rows: 24,
            cols: 80,
            theme: getXtermTheme(getEffectiveTheme(), { interactive: false }),
            scrollback: 10000 // Allow scrolling through history
        };
        try {
            console.log('[TerminalSession] history init', {
                sessionId: this.sessionId,
                metadataSize: this.sessionData?.terminal_size ?? null,
                containerSize: this.container ? {
                    width: this.container.clientWidth || null,
                    height: this.container.clientHeight || null
                } : null
            });
        } catch (_) {}

        // Create the terminal
        this.terminal = new Terminal(terminalOptions);

        // Add fit addon for proper sizing
        this.fitAddon = new FitAddon.FitAddon();
        this.terminal.loadAddon(this.fitAddon);

        // Add hyperlink support
        this.setupHyperlinks();

        // Create container if not provided
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'terminal-container history-terminal-container';
            this.container.style.flex = '1';
            this.container.style.overflow = 'hidden';
        }

        // Open terminal in container
        this.terminal.open(this.container);
        
        // Fit the terminal to its container
        this.fitAddon.fit();
        this.logFitDimensions('history-initialize-fit');
        // Install observers for future resizes/visibility changes
        this.setupFitObservers();
        this.setupFontsReadyHook();

        // Debug markers overlay removed

        // Write the history content (asynchronously in chunks to avoid UI jank)
        if (historyData) {
            // Preserve raw history for offset mapping before filters
            const rawHistory = typeof historyData === 'string' ? historyData : String(historyData || '');
            let existingOutput = rawHistory;

            // Prepare transition marker offsets adjusted for filters and CRLF
            let markerOffsetsCRLF = [];
            try {
                const state = appStore.getState();
                const tPrefs = state?.preferences?.terminal || {};
                const filterOsc = tPrefs.filterOscColors !== false; // default true
                const collapseRgb = tPrefs.collapseNakedRgbRuns !== false; // default true
                const transitions = Array.isArray(this.sessionData?.activity_transitions) ? this.sessionData.activity_transitions : [];
                // Ensure a first transition at offset 0
                const hasZero = transitions.some(t => (Number(t?.char_offset) || 0) === 0);
                // Use session start time for initial marker when available
                let createdAtMs = null;
                try {
                    const ca = this.sessionData?.created_at || this.sessionData?.createdAt;
                    const tca = Date.parse(String(ca));
                    if (Number.isFinite(tca)) createdAtMs = tca;
                } catch (_) {}
                const baseTransitions = (!hasZero)
                    ? [{ char_offset: 0, state: 'active', t: (createdAtMs ?? Date.now()), seq: 0 }, ...transitions]
                    : transitions;
                const adjusted = [];
                for (const t of baseTransitions) {
                    const rawOffset = Math.max(0, Number(t?.char_offset) || 0);
                    let prefix = rawHistory.slice(0, rawOffset);
                    if (filterOsc || collapseRgb) {
                        prefix = applyAnsiFilters(prefix, { filterOscColors: filterOsc, collapseRgbRuns: collapseRgb });
                    }
                    const adjustedLen = prefix.length;
                    const nlCount = (prefix.match(/\n/g) || []).length;
            const offsetCRLF = adjustedLen + nlCount; // each \n becomes \r\n
                    adjusted.push({ offsetCRLF, meta: { state: 'active', t: t.t || Date.now(), seq: t.seq || 0, raw: rawOffset } });
                }
                adjusted.sort((a, b) => a.offsetCRLF - b.offsetCRLF);
                markerOffsetsCRLF = adjusted;
                this._transitionOffsetsCRLF = adjusted.map(x => x.offsetCRLF);
            } catch (_) {
                this._transitionOffsetsCRLF = [];
            }

            // Apply filters per settings before rendering
            try {
                const state = appStore.getState();
                const tPrefs = state?.preferences?.terminal || {};
                const filterOsc = tPrefs.filterOscColors !== false; // default true
                const collapseRgb = tPrefs.collapseNakedRgbRuns !== false; // default true
                if (filterOsc || collapseRgb) {
                    existingOutput = applyAnsiFilters(existingOutput, { filterOscColors: filterOsc, collapseRgbRuns: collapseRgb });
                }
            } catch (_) {}

            const fixedOutput = existingOutput.replace(/\n/g, '\r\n');
            const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            // If the first marker is at offset 0, place it BEFORE writing to ensure it anchors to the top
            let nextMarkerIdx = 0;
            try {
                if (markerOffsetsCRLF && markerOffsetsCRLF.length && (markerOffsetsCRLF[0]?.offsetCRLF === 0)) {
                    const m0 = this.terminal.registerMarker(0);
                    if (m0) {
                        this.activityMarkers.push({ marker: m0, meta: markerOffsetsCRLF[0].meta });
                        this._markerNavIndex = this.activityMarkers.length - 1;
                        this.requestMarkersOverlayUpdate();
                    }
                    nextMarkerIdx = 1;
                }
            } catch (_) {}
            await this.writeInChunks(this.terminal, fixedOutput, 32768, (info) => {
                if (info && info.progressPct !== undefined) {
                    try { if (typeof options.onProgress === 'function') options.onProgress(info.progressPct); } catch (_) {}
                }
                // Place markers as we cross planned offsets
                if (markerOffsetsCRLF && markerOffsetsCRLF.length && info && typeof info.written === 'number') {
                    while (nextMarkerIdx < markerOffsetsCRLF.length && info.written >= markerOffsetsCRLF[nextMarkerIdx].offsetCRLF) {
                        const m = this.terminal.registerMarker(0);
                        if (m) {
                            this.activityMarkers.push({ marker: m, meta: markerOffsetsCRLF[nextMarkerIdx].meta });
                            // Initialize nav index to last marker by default
                            this._markerNavIndex = this.activityMarkers.length - 1;
                        }
                        nextMarkerIdx++;
                    }
                }
            });
            const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            
        } else {
            this.terminal.write('No history data available for this session.\r\n');
        }

        // Set up mobile handling if needed
        if (this.isMobile) {
            try { this.mobileTouch?.teardown(); } catch (_) {}
            this.mobileTouch = new MobileTerminalTouchHandler(this.terminal, this.sessionId, this.eventBus, null);
            this.mobileTouch.setup();
        }

        const refocusCallback = () => {
            setTimeout(() => {
                try { this.focus(); } catch (_) {}
            }, 100);
        };
        try {
            this.autoCopyCleanup = TerminalAutoCopy.setup(this.terminal, `history-${this.sessionId}`, refocusCallback);
        } catch (error) {
            console.warn('[TerminalSession] Failed to enable history auto-copy', error);
        }

        // Mark as initialized
        this.isInitialized = true;
        
        // Emit ready event
        this.eventBus.emit('terminal-ready', { sessionId: this.sessionId });

        
    }

    // Debug markers overlay removed

    // Debug replay: enable via ?replayMarkers=1 or localStorage tm_debug_markers_replay=1
    initMarkersReplayIfEnabled() {
        try {
            const params = new URLSearchParams(window.location.search || '');
            const raw = params.get('replayMarkers');
            let enabled = null;
            if (raw != null) {
                const s = String(raw).toLowerCase();
                enabled = (s === '1' || s === 'true') ? true : (s === '0' || s === 'false') ? false : null;
            }
            if (enabled === null) {
                try {
                    const ls = window.localStorage?.getItem('tm_debug_markers_replay');
                    if (ls === '1') enabled = true; else if (ls === '0') enabled = false;
                } catch (_) {}
            }
            // Default to enabled for history views unless explicitly disabled
            this._markersReplayEnabled = (enabled === false) ? false : true;
        } catch (_) { this._markersReplayEnabled = true; }
    }

    isReplaySeekEnabled() {
        return !!this._markersReplayEnabled && !!this.isHistoryView;
    }

    async seekToMarkerByReplay(index) {
        if (!this.isReplaySeekEnabled() || !this.terminal) return false;
        try {
            const markers = Array.isArray(this.activityMarkers) ? this.activityMarkers : [];
            if (index < 0 || index >= markers.length) return false;
            let rawOffset = null;
            try {
                const meta = markers[index]?.meta;
                const v = meta && Number(meta.raw);
                if (Number.isFinite(v) && v >= 0) rawOffset = Math.floor(v);
            } catch (_) {}
            if (rawOffset == null) {
                const trans = Array.isArray(this.sessionData?.activity_transitions) ? this.sessionData.activity_transitions : [];
                if (trans[index] && Number.isFinite(Number(trans[index].char_offset))) {
                    rawOffset = Math.max(0, Math.floor(Number(trans[index].char_offset)));
                } else {
                    return false;
                }
            }
            try { this.terminal.reset(); } catch (_) {}
            try { this.activityMarkers = []; this._markerNavIndex = -1; } catch (_) {}
            const end = Math.max(0, rawOffset - 1);
            await streamHistoryToTerminal({
                terminal: this.terminal,
                sessionId: this.sessionId,
                transitions: (Array.isArray(this.sessionData?.activity_transitions)
                    ? this.sessionData.activity_transitions.filter(t => (Number(t?.char_offset) || 0) <= rawOffset)
                    : []),
                rangeEnd: end,
                onMarker: (marker, meta) => {
                    try { this.activityMarkers.push({ marker, meta }); this._markerNavIndex = this.activityMarkers.length - 1; } catch (_) {}
                }
            });
            return true;
        } catch (e) {
            console.warn('[TerminalSession] seekToMarkerByReplay failed', e);
            return false;
        }
    }

    logFitDimensions(reason, extra = {}) {
        try {
            const rect = (this.container && typeof this.container.getBoundingClientRect === 'function')
                ? this.container.getBoundingClientRect()
                : null;
            const metadataSize = this.sessionData && this.sessionData.terminal_size
                ? { ...this.sessionData.terminal_size }
                : null;
            console.log('[TerminalSession] size diagnostic', {
                reason,
                sessionId: this.sessionId,
                isHistoryView: !!this.isHistoryView,
                cols: this.terminal ? this.terminal.cols : null,
                rows: this.terminal ? this.terminal.rows : null,
                containerWidth: rect ? Math.round(rect.width) : null,
                containerHeight: rect ? Math.round(rect.height) : null,
                metadataSize,
                ...extra
            });
        } catch (error) {
            console.warn('[TerminalSession] Failed to log dimensions', error);
        }
    }

    setupFitObservers() {
        try {
            const el = this.container;
            if (!el || typeof window === 'undefined') return;

            // IntersectionObserver: refit when element becomes visible
            if (!this._io && 'IntersectionObserver' in window) {
                this._io = new IntersectionObserver((entries) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            try { this.fit(); } catch (_) {}
                        }
                    }
                }, { root: null, threshold: 0.01 });
                try { this._io.observe(el); } catch (_) { /* ignore */ }
            }

            // ResizeObserver: refit when container size changes
            if (!this._ro && 'ResizeObserver' in window) {
                this._ro = new ResizeObserver((entries) => {
                    for (const entry of entries) {
                        const cr = entry.contentRect || {};
                        if ((cr.width || 0) >= 100 && (cr.height || 0) >= 50) {
                            try { this.fit(); } catch (_) {}
                        }
                    }
                });
                try { this._ro.observe(el); } catch (_) { /* ignore */ }
            }
        } catch (_) { /* non-fatal */ }
    }

    setupFontsReadyHook() {
        try {
            if (this._fontsReadyHooked) return;
            const d = document;
            if (d && d.fonts && typeof d.fonts.ready?.then === 'function') {
                this._fontsReadyHooked = true;
                d.fonts.ready.then(() => {
                    try { this.fit(); } catch (_) {}
                }).catch(() => { /* ignore */ });
            }
        } catch (_) { /* ignore */ }
    }

    /**
     * Write large text to xterm in non-blocking chunks
     * @param {Terminal} terminal
     * @param {string} text
     * @param {number} [chunkSize]
     */
    async writeInChunks(terminal, text, chunkSize = 32768, onProgress = null) {
        let i = 0;
        const len = text.length;
        while (i < len) {
            const next = Math.min(i + chunkSize, len);
            terminal.write(text.slice(i, next));
            i = next;
            if (onProgress) {
                const pct = Math.min(100, Math.round((i / len) * 100));
                try { onProgress({ written: i, total: len, progressPct: pct }); } catch (_) {}
            }
            // Yield to the event loop to keep UI responsive
            await new Promise((r) => setTimeout(r, 0));
        }
    }

}
