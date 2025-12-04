/**
 * WebSocket Service - Centralized WebSocket management
 * Handles WebSocket connections, reconnection logic, and message routing
 */
import { appStore } from '../core/store.js';

export class WebSocketService {
    constructor(options = {}) {
        // Import config to get unified settings
        import('../core/config.js').then(({ config }) => {
            this.config = config;
        });
        
        this.options = {
            reconnect: true,
            reconnectDelay: options.reconnectDelay || 1000,
            maxReconnectDelay: options.maxReconnectDelay || 30000,
            reconnectDecay: options.reconnectDecay || 1.5,
            pingInterval: options.pingInterval || 30000,
            pongTimeout: options.pongTimeout || 5000,
            useMessageRegistry: options.useMessageRegistry !== false, // Default to true
            ...options
        };

        this.url = null;
        this.ws = null;
        this.connectOptions = null;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.isAuthenticated = false;
        this.authenticationRequired = false;
        this.pingTimer = null;
        this.pongTimer = null;
        this.messageHandlers = new Map();
        this.eventHandlers = new Map();
        this.messageQueue = [];
        this.isConnecting = false;
        this.isClosing = false;
        this.lastPongTime = Date.now();
        this.messageRegistry = null;
        // Optional async URL resolver used to refresh URLs on reconnect (e.g., fetch new ws_token)
        this.urlResolver = null;
        // Pending connection resolution when auth is required
        this._pendingAuthResolve = null;
        this._pendingAuthReject = null;
        this._authTimer = null;
        
        // Initialize message registry synchronously if enabled
        this.registryInitialized = false;
        if (this.options.useMessageRegistry) {
            this.initializeMessageRegistry();
        } else {
            this.registryInitialized = true;
        }
    }

    /**
     * Initialize the message registry
     * @private
     */
    async initializeMessageRegistry() {
        try {
            const { MessageHandlerRegistry } = await import('../modules/websocket/message-handler-registry.js');
            this.messageRegistry = new MessageHandlerRegistry();
            this.registryInitialized = true;
            console.log('[WebSocketService] Message registry initialized');
        } catch (error) {
            console.error('[WebSocketService] Failed to initialize message registry:', error);
            this.options.useMessageRegistry = false;
            this.registryInitialized = true;
        }
    }

    /**
     * Connect to WebSocket server
     * @param {string} url - WebSocket URL
     * @param {Object} options - Connection options including auth
     * @returns {Promise<void>}
     */
    connect(url, options = {}) {
        return new Promise((resolve, reject) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }

            if (this.isConnecting) {
                // Wait for existing connection attempt
                this.once('open', resolve);
                this.once('error', reject);
                return;
            }

            // Store connection options and optional URL resolver for reconnection
            this.connectOptions = options;
            if (typeof options.urlResolver === 'function') {
                this.urlResolver = options.urlResolver;
            }
            
            this.url = url;
            this.isConnecting = true;
            this.isClosing = false;

            // Update connection state in store
            try { appStore.setPath('connection.websocket', 'connecting'); } catch (_) {}

            try {
                const isSocketScheme = (() => { try { const u = new URL(url); return (u.protocol === 'socket:' || u.protocol === 'unix:' || u.protocol === 'pipe:'); } catch (_) { return false; } })();
                if (isSocketScheme && window.desktop?.ws?.connect) {
                    // Build UDS path and WS path from URL
                    let u = null; try { u = new URL(url); } catch (_) {}
                    let socketPath = u ? (u.pathname || '') : '';
                    let wsPath = u ? ((u.pathname || '') + (u.search || '')) : '';
                    // Split at first '/ws/' segment to separate socket path from ws endpoint
                    const idx = wsPath.indexOf('/ws/');
                    if (idx > 0) {
                        socketPath = wsPath.slice(0, idx);
                        wsPath = wsPath.slice(idx) + (u && u.hash ? u.hash : '');
                    }
                    const connectRes = window.desktop.ws.connect({ socketPath, path: wsPath, headers: { Host: 'local' } });
                    Promise.resolve(connectRes).then((res) => {
                        if (!res || !res.ok || !res.socket) throw new Error('UDS WS connect failed');
                        const bridge = res.socket;
                        const OPEN = 1, CONNECTING = 0, CLOSING = 2, CLOSED = 3;
                        const shim = {
                            readyState: CONNECTING,
                            send: (data) => bridge.send(typeof data === 'string' ? data : String(data)),
                            close: (code, reason) => { shim.readyState = CLOSING; bridge.close(code, reason); },
                            _handlers: { open: new Set(), message: new Set(), error: new Set(), close: new Set() },
                            addEventListener: (type, fn) => { if (shim._handlers[type]) shim._handlers[type].add(fn); },
                            removeEventListener: (type, fn) => { if (shim._handlers[type]) shim._handlers[type].delete(fn); }
                        };
                        const emit = (type, ev) => { const set = shim._handlers[type]; if (!set) return; for (const fn of Array.from(set)) { try { fn(ev); } catch (_) {} } };
                        bridge.onOpen(() => { shim.readyState = OPEN; emit('open');
                            // Mirror the open handler path from native below
                            this.isConnecting = false;
                            this.reconnectAttempts = 0;
                            if (options.requireAuth === true && options.auth && options.auth.username && options.auth.password) {
                                this.authenticationRequired = options.requireAuth === true;
                                this.isAuthenticated = false;
                                this._pendingAuthResolve = resolve;
                                this._pendingAuthReject = reject;
                                let usingRegistry = false;
                                try {
                                    if (this.options.useMessageRegistry) {
                                        this.waitForMessageRegistry().then(() => {
                                            if (this.messageRegistry) {
                                                const authSuccessHandler = () => {
                                                    try { this.messageRegistry.unregister('auth_success'); } catch (_) {}
                                                    this.finalizeAuthSuccess();
                                                };
                                                this.messageRegistry.register('auth_success', authSuccessHandler);
                                                usingRegistry = true;
                                            }
                                        }).catch(() => {});
                                    }
                                } catch (_) {}
                                if (!usingRegistry) {
                                    const onGeneric = (msg) => { if (msg && msg.type === 'auth_success') { try { this.off('message', onGeneric); } catch (_) {} this.finalizeAuthSuccess(); } };
                                    this.on('message', onGeneric);
                                }
                                if (this._authTimer) { clearTimeout(this._authTimer); }
                                this._authTimer = setTimeout(() => { if (!this.isAuthenticated) { try { shim.close(1008, 'Authentication timeout'); } catch (_) {} if (this._pendingAuthReject) this._pendingAuthReject(new Error('Authentication timeout')); } }, 6000);
                            } else if (options.requireAuth === true) {
                                this.authenticationRequired = true;
                                this.isAuthenticated = false;
                                this._pendingAuthResolve = resolve;
                                this._pendingAuthReject = reject;
                                let registered = false;
                                try {
                                    if (this.options.useMessageRegistry) {
                                        this.waitForMessageRegistry().then(() => {
                                            if (this.messageRegistry) {
                                                const authSuccessHandler = () => { try { this.messageRegistry.unregister('auth_success'); } catch (_) {} this.finalizeAuthSuccess(); };
                                                this.messageRegistry.register('auth_success', authSuccessHandler);
                                                registered = true;
                                            }
                                        }).catch(() => {});
                                    }
                                } catch (_) {}
                                if (!registered) {
                                    const onGeneric = (msg) => { if (msg && msg.type === 'auth_success') { try { this.off('message', onGeneric); } catch (_) {} this.finalizeAuthSuccess(); } };
                                    this.on('message', onGeneric);
                                }
                                if (this._authTimer) { clearTimeout(this._authTimer); }
                                this._authTimer = setTimeout(() => { if (!this.isAuthenticated) { try { shim.close(1008, 'Authentication timeout'); } catch (_) {} if (this._pendingAuthReject) { this._pendingAuthReject(new Error('Authentication timeout')); this._pendingAuthReject = null; this._pendingAuthResolve = null; } } }, 6000);
                            } else {
                                this.authenticationRequired = false;
                                this.isAuthenticated = true;
                                this.startPing();
                                this.flushMessageQueue();
                                this.emit('open');
                                try { appStore.setPath('connection.websocket', 'connected'); } catch (_) {}
                                resolve();
                            }
                        });
                        bridge.onMessage((text) => { const event = { data: text }; this.handleMessage(event); });
                        bridge.onError((err) => { emit('error', { message: String(err||'error') }); this.isConnecting = false; this.emit('error', err); try { appStore.setPath('connection.websocket', 'error'); } catch (_) {} if (this.reconnectAttempts === 0) reject(err); });
                        bridge.onClose(({ code, reason }) => { shim.readyState = CLOSED; this.handleClose({ code, reason }); });
                        this.ws = shim;
                        this.setupEventHandlers();
                    }).catch((e) => { throw e; });
                } else {
                    this.ws = new WebSocket(url);
                    this.setupEventHandlers();
                }

                this.ws.addEventListener('open', async () => {
                    this.isConnecting = false;
                    this.reconnectAttempts = 0;
                    
                    // Send authentication message only if server requires it
                    if (options.requireAuth === true && options.auth && options.auth.username && options.auth.password) {
                        // Mark that authentication is required and not yet complete
                        this.authenticationRequired = options.requireAuth === true;
                        this.isAuthenticated = false;
                        // Store resolve/reject so we can complete connection when auth succeeds
                        this._pendingAuthResolve = resolve;
                        this._pendingAuthReject = reject;
                        // If using registry, ensure it's ready before registering handler
                        let usingRegistry = false;
                        try {
                            if (this.options.useMessageRegistry) {
                                await this.waitForMessageRegistry();
                                if (this.messageRegistry) {
                                    usingRegistry = true;
                                    const authSuccessHandler = (message) => {
                                        try { this.messageRegistry.unregister('auth_success'); } catch (_) {}
                                        this.finalizeAuthSuccess();
                                    };
                                    this.messageRegistry.register('auth_success', authSuccessHandler);
                                }
                            }
                        } catch (_) { /* fall through to fallback */ }
                        
                        // Send auth message immediately and synchronously, bypassing queue
                        const authMessage = {
                            type: 'auth',
                            username: options.auth.username,
                            password: options.auth.password
                        };
                        
                        try {
                            this.ws.send(JSON.stringify(authMessage));
                        } catch (error) {
                            console.error('[WebSocketService] Failed to send auth message:', error);
                            if (this._pendingAuthReject) this._pendingAuthReject(error);
                            return;
                        }
                        // Optional client-side timeout (server also enforces timeout)
                        if (this._authTimer) { clearTimeout(this._authTimer); }
                        this._authTimer = setTimeout(() => {
                            if (!this.isAuthenticated) {
                                console.error('[WebSocketService] Authentication timeout (client)');
                                try { this.ws.close(1008, 'Authentication timeout'); } catch (_) {}
                                if (this._pendingAuthReject) this._pendingAuthReject(new Error('Authentication timeout'));
                            }
                        }, 6000);
                    } else if (options.requireAuth === true) {
                        // Auth required but no credentials provided: rely on server cookie/token auth.
                        this.authenticationRequired = true;
                        this.isAuthenticated = false;
                        // Store resolve/reject so we can complete connection when auth succeeds
                        this._pendingAuthResolve = resolve;
                        this._pendingAuthReject = reject;
                        // Register for auth_success via message registry if available
                        let registered = false;
                        try {
                            if (this.options.useMessageRegistry) {
                                await this.waitForMessageRegistry();
                                if (this.messageRegistry) {
                                    const authSuccessHandler = () => {
                                        try { this.messageRegistry.unregister('auth_success'); } catch (_) {}
                                        this.finalizeAuthSuccess();
                                    };
                                    this.messageRegistry.register('auth_success', authSuccessHandler);
                                    registered = true;
                                }
                            }
                        } catch (_) {}
                        if (!registered) {
                            // Fallback: listen on generic message event
                            const onGeneric = (msg) => {
                                if (msg && msg.type === 'auth_success') {
                                    try { this.off('message', onGeneric); } catch (_) {}
                                    this.finalizeAuthSuccess();
                                }
                            };
                            this.on('message', onGeneric);
                        }
                        // Timeout similar to explicit auth
                        if (this._authTimer) { clearTimeout(this._authTimer); }
                        this._authTimer = setTimeout(() => {
                            if (!this.isAuthenticated) {
                                console.error('[WebSocketService] Authentication timeout (cookie)');
                                try { this.ws.close(1008, 'Authentication timeout'); } catch (_) {}
                                if (this._pendingAuthReject) { this._pendingAuthReject(new Error('Authentication timeout')); this._pendingAuthReject = null; this._pendingAuthResolve = null; }
                            }
                        }, 6000);
                    } else {
                        // No authentication required, proceed normally
                        this.authenticationRequired = false;
                        this.isAuthenticated = true; // Consider as "authenticated" if no auth needed
                        this.startPing();
                        this.flushMessageQueue();
                        this.emit('open');
                        try { appStore.setPath('connection.websocket', 'connected'); } catch (_) {}
                        resolve();
                    }
                });

                this.ws.addEventListener('error', (error) => {
                    this.isConnecting = false;
                    this.emit('error', error);
                    try { appStore.setPath('connection.websocket', 'error'); } catch (_) {}
                    if (this.reconnectAttempts === 0) {
                        reject(error);
                    }
                });
            } catch (error) {
                this.isConnecting = false;
                reject(error);
            }
        });
    }

    /**
     * Finalize successful authentication in a single place
     * Ensures idempotence and resolves pending connect() if applicable
     */
    finalizeAuthSuccess() {
        if (this.isAuthenticated) {
            // Already finalized
            if (this._authTimer) { clearTimeout(this._authTimer); this._authTimer = null; }
            if (this._pendingAuthResolve) { this._pendingAuthResolve(); this._pendingAuthResolve = null; this._pendingAuthReject = null; }
            return;
        }
        this.authenticationRequired = false;
        this.isAuthenticated = true;
        if (this._authTimer) { clearTimeout(this._authTimer); this._authTimer = null; }
        this.startPing();
        this.flushMessageQueue();
        this.emit('open');
        try { appStore.setPath('connection.websocket', 'connected'); } catch (_) {}
        if (this._pendingAuthResolve) {
            this._pendingAuthResolve();
            this._pendingAuthResolve = null;
            this._pendingAuthReject = null;
        }
    }

    /**
     * Disconnect from WebSocket server
     * @param {number} code - Close code
     * @param {string} reason - Close reason
     */
    disconnect(code = 1000, reason = '') {
        this.isClosing = true;
        this.stopReconnect();
        this.stopPing();
        
        // Reset authentication state
        this.isAuthenticated = false;
        this.authenticationRequired = false;

        if (this.ws) {
            this.ws.close(code, reason);
            this.ws = null;
        }

        this.messageQueue = [];
        this.emit('disconnect');
    }

    /**
     * Send a message through WebSocket
     * @param {string} type - Message type
     * @param {Object} data - Message data
     * @returns {boolean} Whether message was sent immediately
     */
    send(type, data = {}) {
        const message = { type, ...data };
        
        // Always allow auth messages to be sent immediately
        if (type === 'auth') {
            if (this.isReady()) {
                try {
                    this.ws.send(JSON.stringify(message));
                    return true;
                } catch (error) {
                    console.error('Failed to send auth message:', error);
                    return false;
                }
            } else {
                console.error('Cannot send auth message: WebSocket not ready');
                return false;
            }
        }
        
        // For non-auth messages, check authentication state
        if (this.authenticationRequired && !this.isAuthenticated) {
            this.queueMessage(message);
            return false;
        }
        
        if (this.isReady()) {
            try {
                this.ws.send(JSON.stringify(message));
                return true;
            } catch (error) {
                console.error('Failed to send message:', error);
                this.queueMessage(message);
                return false;
            }
        } else {
            this.queueMessage(message);
            return false;
        }
    }

    /**
     * Send raw data through WebSocket
     * @param {string|ArrayBuffer|Blob} data - Raw data to send
     * @returns {boolean} Whether data was sent immediately
     */
    sendRaw(data) {
        if (this.isReady()) {
            try {
                this.ws.send(data);
                return true;
            } catch (error) {
                console.error('Failed to send raw data:', error);
                return false;
            }
        }
        return false;
    }

    /**
     * Register a message handler for a specific message type
     * @param {string} type - Message type
     * @param {Function} handler - Handler function
     */
    onMessage(type, handler) {
        if (!this.messageHandlers.has(type)) {
            this.messageHandlers.set(type, new Set());
        }
        this.messageHandlers.get(type).add(handler);
    }

    /**
     * Unregister a message handler
     * @param {string} type - Message type
     * @param {Function} handler - Handler function
     */
    offMessage(type, handler) {
        const handlers = this.messageHandlers.get(type);
        if (handlers) {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.messageHandlers.delete(type);
            }
        }
    }

    /**
     * Register an event handler
     * @param {string} event - Event name
     * @param {Function} handler - Handler function
     */
    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, new Set());
        }
        this.eventHandlers.get(event).add(handler);
    }

    /**
     * Register a one-time event handler
     * @param {string} event - Event name
     * @param {Function} handler - Handler function
     */
    once(event, handler) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            handler(...args);
        };
        this.on(event, wrapper);
    }

    /**
     * Unregister an event handler
     * @param {string} event - Event name
     * @param {Function} handler - Handler function
     */
    off(event, handler) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.eventHandlers.delete(event);
            }
        }
    }

    /**
     * Check if WebSocket is ready to send messages
     * @returns {boolean}
     */
    isReady() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Get current connection state
     * @returns {string}
     */
    getState() {
        if (!this.ws) return 'disconnected';
        switch (this.ws.readyState) {
            case WebSocket.CONNECTING:
                return 'connecting';
            case WebSocket.OPEN:
                return 'connected';
            case WebSocket.CLOSING:
                return 'closing';
            case WebSocket.CLOSED:
                return 'disconnected';
            default:
                return 'unknown';
        }
    }

    /**
     * Setup WebSocket event handlers
     * @private
     */
    setupEventHandlers() {
        if (!this.ws) return;

        this.ws.addEventListener('message', (event) => {
            this.handleMessage(event);
        });

        this.ws.addEventListener('close', (event) => {
            this.handleClose(event);
        });

        this.ws.addEventListener('error', (event) => {
            console.error('WebSocket error:', event);
        });
    }

    /**
     * Handle incoming WebSocket message
     * @private
     */
    async handleMessage(event) {
        // Try to parse JSON messages
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (e) {
            // Not JSON, emit as raw message
            console.log('[WebSocketService] Received raw message:', event.data);
            this.emit('rawMessage', event.data);
            return;
        }

        // Optional debug logging
        const debug = appStore.getState('preferences.debug.websocketLogs') === true;
        if (debug && message.type !== 'stdout') {
            console.log('[WebSocketService] Received message:', message.type, message);
        }

        // Handle auth success independently of registry to avoid race conditions
        if (message && message.type === 'auth_success') {
            // Clean up any registry handler if registered
            try { this.messageRegistry?.unregister?.('auth_success'); } catch (_) {}
            this.finalizeAuthSuccess();
            return;
        }

        // Handle pong messages for keepalive
        if (message.type === 'pong') {
            this.handlePong();
            return;
        }

        // Process through message registry
        if (this.messageRegistry && this.options.useMessageRegistry) {
            // Process through registry with context
            // Context is set during handler registration in TerminalManager.setupWebSocketHandlers()
            if (debug && message.type !== 'stdout') {
                console.log(`[WebSocketService] Processing message type '${message.type}' through registry`);
            }
            try {
                await this.messageRegistry.handle(message);
                if (debug && message.type !== 'stdout') {
                    console.log(`[WebSocketService] Successfully processed message type '${message.type}'`);
                }
            } catch (error) {
                console.error(`Error in message registry handler for type '${message.type}':`, error);
                // Fall back to emitting the message event if registry fails
                this.emit('message', message);
            }
        } else {
            // Registry not available, emit generic message event as fallback
            if (debug) {
                console.warn('[WebSocketService] Message registry not available, falling back to event emission');
            }
            this.emit('message', message);
        }
    }

    /**
     * Handle WebSocket close event
     * @private
     */
    handleClose(event) {
        this.stopPing();
        
        // Reset authentication state on close
        this.isAuthenticated = false;
        this.authenticationRequired = false;
        // Clear any pending auth resolution/rejection
        if (this._authTimer) { clearTimeout(this._authTimer); this._authTimer = null; }
        this._pendingAuthResolve = null;
        this._pendingAuthReject = null;
        
        const wasClean = event.wasClean;
        const code = event.code;
        const reason = event.reason;

        this.emit('close', { wasClean, code, reason });
        try { appStore.setPath('connection.websocket', 'disconnected'); } catch (_) {}

        // Don't reconnect on authentication failures (code 1008)
        if (code === 1008) {
            console.error('[WebSocketService] Authentication failed - not reconnecting:', reason);
            this.emit('auth_failed', { code, reason });
            return;
        }

        // Attempt reconnection if not intentionally closing
        if (!this.isClosing && this.options.reconnect) {
            this.scheduleReconnect();
        }

        this.ws = null;
    }

    /**
     * Schedule reconnection attempt
     * @private
     */
    scheduleReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        const delay = Math.min(
            this.options.reconnectDelay * Math.pow(this.options.reconnectDecay, this.reconnectAttempts),
            this.options.maxReconnectDelay
        );

        this.reconnectAttempts++;
        this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

        this.reconnectTimer = setTimeout(() => {
            (async () => {
                if (this.isClosing) return;
                try {
                    // Refresh URL via resolver if available (e.g., to fetch a new token)
                    if (typeof this.urlResolver === 'function') {
                        try {
                            const freshUrl = await this.urlResolver(this.url, this.connectOptions || {});
                            if (freshUrl && typeof freshUrl === 'string') {
                                this.url = freshUrl;
                            }
                        } catch (e) {
                            console.warn('[WebSocketService] urlResolver failed, falling back to previous URL:', e);
                        }
                    }
                    if (this.url) {
                        await this.connect(this.url, this.connectOptions || {});
                    }
                } catch (error) {
                    console.error('Reconnection failed:', error);
                }
            })();
        }, delay);
    }

    /**
     * Stop reconnection attempts
     * @private
     */
    stopReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
    }

    /**
     * Start ping interval for keepalive
     * @private
     */
    startPing() {
        if (!this.options.pingInterval) return;

        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (this.isReady()) {
                this.sendPing();
            }
        }, this.options.pingInterval);
    }

    /**
     * Stop ping interval
     * @private
     */
    stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
        }
    }

    /**
     * Send ping message
     * @private
     */
    sendPing() {
        if (this.isReady()) {
            this.send('ping', { timestamp: Date.now() });
            
            // Set timeout for pong response
            if (this.options.pongTimeout) {
                this.pongTimer = setTimeout(() => {
                    console.warn('Pong timeout - connection may be dead');
                    this.emit('pongTimeout');
                    // Force reconnection
                    this.ws.close();
                }, this.options.pongTimeout);
            }
        }
    }

    /**
     * Handle pong response
     * @private
     */
    handlePong() {
        this.lastPongTime = Date.now();
        if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
        }
        this.emit('pong');
    }

    /**
     * Queue a message for sending when connection is restored
     * @private
     */
    queueMessage(message) {
        this.messageQueue.push(message);
        // Limit queue size to prevent memory issues
        if (this.messageQueue.length > 100) {
            this.messageQueue.shift();
        }
    }

    /**
     * Flush queued messages
     * @private
     */
    flushMessageQueue() {
        while (this.messageQueue.length > 0 && this.isReady()) {
            const message = this.messageQueue.shift();
            try {
                this.ws.send(JSON.stringify(message));
            } catch (error) {
                console.error('Failed to send queued message:', error);
                break;
            }
        }
    }

    /**
     * Get the message registry instance
     * @returns {MessageHandlerRegistry|null} The message registry or null if not enabled
     */
    getMessageRegistry() {
        return this.messageRegistry;
    }

    /**
     * Wait for message registry to be initialized
     * @returns {Promise<MessageHandlerRegistry|null>} The message registry or null if not enabled
     */
    async waitForMessageRegistry() {
        return new Promise((resolve) => {
            const checkRegistry = () => {
                if (this.registryInitialized) {
                    resolve(this.messageRegistry);
                } else {
                    setTimeout(checkRegistry, 10);
                }
            };
            checkRegistry();
        });
    }

    /**
     * Emit an event to registered handlers
     * @private
     */
    emit(event, data) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    console.error(`Error in event handler for '${event}':`, error);
                }
            });
        }
    }

    /**
     * Get connection statistics
     * @returns {Object}
     */
    getStats() {
        return {
            state: this.getState(),
            reconnectAttempts: this.reconnectAttempts,
            queuedMessages: this.messageQueue.length,
            lastPongTime: this.lastPongTime,
            url: this.url
        };
    }
}

// Export singleton instance with default configuration
export const websocketService = new WebSocketService();
