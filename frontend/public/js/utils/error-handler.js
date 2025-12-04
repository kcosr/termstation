/**
 * Error Handler - Centralized error management and user notification
 * Provides consistent error handling, logging, and user feedback
 */
import { iconUtils } from './icon-utils.js';
import { notificationDisplay } from './notification-display.js';
import { appStore } from '../core/store.js';

export class ErrorHandler {
    constructor(options = {}) {
        this.options = {
            logToConsole: true,
            showUserMessages: true,
            reportToMonitoring: false,
            monitoringEndpoint: null,
            defaultMessage: 'An unexpected error occurred. Please try again.',
            ...options
        };

        this.errorQueue = [];
        this.maxQueueSize = 50;
        this.errorListeners = new Set();
        this.notificationElement = null;
        this.setupNotificationContainer();
    }

    /**
     * Main error handling method
     * @param {Error|Object|string} error - Error to handle
     * @param {Object} context - Additional context information
     * @returns {Object} Processed error information
     */
    handle(error, context = {}) {
        const errorInfo = this.processError(error, context);
        
        // Log to console if enabled
        if (this.options.logToConsole) {
            this.logError(errorInfo);
        }

        // Add to error queue
        this.addToQueue(errorInfo);

        // Show user message if enabled
        if (this.options.showUserMessages) {
            this.showUserMessage(errorInfo);
        }

        // Report to monitoring if configured
        if (this.options.reportToMonitoring && this.options.monitoringEndpoint) {
            this.reportError(errorInfo);
        }

        // Notify listeners
        this.notifyListeners(errorInfo);

        return errorInfo;
    }

    /**
     * Handle async errors from promises
     * @param {Promise} promise - Promise to handle
     * @param {Object} context - Additional context
     * @returns {Promise} Promise with error handling
     */
    async handleAsync(promise, context = {}) {
        try {
            return await promise;
        } catch (error) {
            this.handle(error, context);
            throw error;
        }
    }

    /**
     * Create error handler wrapper for functions
     * @param {Function} fn - Function to wrap
     * @param {Object} context - Additional context
     * @returns {Function} Wrapped function
     */
    wrap(fn, context = {}) {
        return (...args) => {
            try {
                const result = fn(...args);
                
                // Handle async functions
                if (result && typeof result.catch === 'function') {
                    return result.catch(error => {
                        this.handle(error, { ...context, args });
                        throw error;
                    });
                }
                
                return result;
            } catch (error) {
                this.handle(error, { ...context, args });
                throw error;
            }
        };
    }

    /**
     * Process error into structured format
     * @private
     */
    processError(error, context) {
        const errorInfo = {
            timestamp: Date.now(),
            context: context || {},
            handled: true
        };

        if (typeof error === 'string') {
            errorInfo.message = error;
            errorInfo.type = 'string';
            errorInfo.code = 'GENERIC_ERROR';
        } else if (error instanceof Error) {
            errorInfo.message = error.message;
            errorInfo.type = error.constructor.name;
            errorInfo.code = error.code || this.getErrorCode(error);
            errorInfo.stack = error.stack;
            
            // Copy additional properties
            Object.keys(error).forEach(key => {
                if (!['message', 'stack', 'name'].includes(key)) {
                    errorInfo[key] = error[key];
                }
            });
        } else if (typeof error === 'object' && error !== null) {
            errorInfo.message = error.message || error.detail || this.options.defaultMessage;
            errorInfo.type = error.type || 'object';
            errorInfo.code = error.code || error.error_code || 'UNKNOWN_ERROR';
            
            // Copy all properties
            Object.assign(errorInfo, error);
        } else {
            errorInfo.message = this.options.defaultMessage;
            errorInfo.type = 'unknown';
            errorInfo.code = 'UNKNOWN_ERROR';
            errorInfo.raw = error;
        }

        // Get user-friendly message
        errorInfo.userMessage = this.getUserMessage(errorInfo);
        
        // Categorize severity
        errorInfo.severity = this.getSeverity(errorInfo);

        return errorInfo;
    }

    /**
     * Get error code from error type
     * @private
     */
    getErrorCode(error) {
        const errorMap = {
            'TypeError': 'TYPE_ERROR',
            'ReferenceError': 'REFERENCE_ERROR',
            'SyntaxError': 'SYNTAX_ERROR',
            'NetworkError': 'NETWORK_ERROR',
            'TimeoutError': 'TIMEOUT_ERROR',
            'ValidationError': 'VALIDATION_ERROR',
            'PermissionError': 'PERMISSION_ERROR',
            'SessionNotFoundError': 'SESSION_NOT_FOUND',
            'PTYCreationError': 'PTY_CREATION_FAILED',
            'SessionLimitExceededError': 'SESSION_LIMIT_EXCEEDED'
        };

        return errorMap[error.constructor.name] || 'GENERIC_ERROR';
    }

    /**
     * Get user-friendly error message
     * @private
     */
    getUserMessage(errorInfo) {
        const messages = {
            // Network errors
            'NETWORK_ERROR': 'Network connection failed. Please check your connection.',
            'TIMEOUT_ERROR': 'Request timed out. Please try again.',
            'FETCH_ERROR': 'Failed to fetch data. Please try again.',
            
            // Session errors
            'SESSION_NOT_FOUND': 'Session not found. It may have been terminated.',
            'PTY_CREATION_FAILED': 'Failed to create terminal. Please try again.',
            'SESSION_LIMIT_EXCEEDED': 'Maximum number of sessions reached. Please close some sessions.',
            
            // Permission errors
            'PERMISSION_ERROR': 'You do not have permission to perform this action.',
            'UNAUTHORIZED': 'Authentication required. Please log in.',
            'FORBIDDEN': 'Access denied. You do not have the necessary permissions.',
            
            // Validation errors
            'VALIDATION_ERROR': 'Invalid input. Please check your data and try again.',
            'INVALID_PARAMS': 'Invalid parameters provided.',
            
            // WebSocket errors
            'WEBSOCKET_CONNECTION_FAILED': 'Failed to establish WebSocket connection.',
            'WEBSOCKET_CLOSED': 'WebSocket connection was closed unexpectedly.',
            
            // HTTP status codes
            '400': 'Bad request. Please check your input.',
            '401': 'Authentication required. Please log in.',
            '403': 'Access forbidden. You do not have permission.',
            '404': 'Resource not found.',
            '409': 'Conflict. The resource already exists.',
            '422': 'Unprocessable entity. Please check your input.',
            '429': 'Too many requests. Please slow down.',
            '500': 'Server error. Please try again later.',
            '502': 'Bad gateway. The server is temporarily unavailable.',
            '503': 'Service unavailable. Please try again later.',
            
            // Default
            'default': this.options.defaultMessage
        };

        // Prefer backend-provided message when it looks user-friendly
        let message = null;
        if (errorInfo.message && !this.isTechnicalMessage(errorInfo.message)) {
            message = errorInfo.message;
        }
        // Otherwise, map by error code
        if (!message) {
            message = messages[errorInfo.code];
        }
        // Then by HTTP status code
        if (!message && errorInfo.status) {
            message = messages[errorInfo.status.toString()];
        }
        // Finally, if detail exists and is readable, use it
        if (!message && errorInfo.detail && !this.isTechnicalMessage(errorInfo.detail)) {
            message = errorInfo.detail;
        }
        
        return message || messages.default;
    }

    /**
     * Check if message is too technical for users
     * @private
     */
    isTechnicalMessage(message) {
        const technicalPatterns = [
            /undefined|null/i,
            /stack|trace/i,
            /at\s+\w+\s+\(/,
            /:\d+:\d+/,
            /^Error:/i,
            /\w+Error:/,
            /cannot read property/i,
            /is not a function/i
        ];

        return technicalPatterns.some(pattern => pattern.test(message));
    }

    /**
     * Get error severity level
     * @private
     */
    getSeverity(errorInfo) {
        // Critical errors
        if (errorInfo.code === 'NETWORK_ERROR' || 
            errorInfo.code === 'WEBSOCKET_CONNECTION_FAILED' ||
            errorInfo.status >= 500) {
            return 'critical';
        }
        
        // Warnings
        if (errorInfo.code === 'VALIDATION_ERROR' ||
            errorInfo.code === 'SESSION_LIMIT_EXCEEDED' ||
            errorInfo.status === 429) {
            return 'warning';
        }
        
        // Info
        if (errorInfo.code === 'SESSION_NOT_FOUND' ||
            errorInfo.status === 404) {
            return 'info';
        }
        
        // Default to error
        return 'error';
    }

    /**
     * Log error to console
     * @private
     */
    logError(errorInfo) {
        const style = {
            critical: 'color: red; font-weight: bold;',
            error: 'color: red;',
            warning: 'color: orange;',
            info: 'color: blue;'
        };

        console.group(`%c[${errorInfo.severity.toUpperCase()}] ${errorInfo.code}`, style[errorInfo.severity]);
        console.error('Message:', errorInfo.message);
        console.log('Context:', errorInfo.context);
        
        if (errorInfo.stack) {
            console.log('Stack:', errorInfo.stack);
        }
        
        console.groupEnd();
    }

    /**
     * Add error to queue
     * @private
     */
    addToQueue(errorInfo) {
        this.errorQueue.push(errorInfo);
        
        // Limit queue size
        if (this.errorQueue.length > this.maxQueueSize) {
            this.errorQueue.shift();
        }
    }

    /**
     * Show user-friendly error message
     * @private
     */
    showUserMessage(errorInfo) {
        // Map ErrorHandler severities to notification types
        const severityToType = {
            critical: 'error',
            error: 'error',
            warning: 'warning',
            info: 'info'
        };

        // Suppress known-benign races: history 404s within 5s of session start
        try {
            if (errorInfo && errorInfo.status === 404) {
                const ctx = errorInfo.context || {};
                const tag = ctx.context || ctx.type || '';
                if (tag === 'load_existing_output') {
                    let createdAtMs = null;
                    try {
                        if (ctx.sessionCreatedAt) {
                            const t = Date.parse(String(ctx.sessionCreatedAt));
                            if (Number.isFinite(t)) createdAtMs = t;
                        }
                    } catch (_) {}
                    if (!createdAtMs) {
                        try {
                            const sid = ctx.sessionId || ctx.session_id;
                            if (sid) {
                                const st = appStore.getState();
                                const map = st?.sessionList?.sessions;
                                let data = null;
                                if (map && typeof map.get === 'function') {
                                    data = map.get(sid);
                                }
                                const ts = data && (data.created_at || data.createdAt);
                                if (ts) {
                                    const t = Date.parse(String(ts));
                                    if (Number.isFinite(t)) createdAtMs = t;
                                }
                            }
                        } catch (_) { /* best-effort */ }
                    }
                    if (createdAtMs) {
                        const ageMs = Date.now() - createdAtMs;
                        if (ageMs >= 0 && ageMs <= 5000) {
                            try { console.info('[ErrorHandler] Suppressed early 404 during history load (<5s from start)'); } catch (_) {}
                            return; // do not toast
                        }
                    }
                }
            }
        } catch (_) { /* non-fatal */ }

        const type = severityToType[errorInfo.severity] || 'info';
        try {
            notificationDisplay.show({
                notification_type: type,
                title: 'Error',
                message: errorInfo.userMessage || this.options.defaultMessage,
                timestamp: errorInfo.timestamp || Date.now()
            });
        } catch (_) {
            // Fallback to legacy inline UI if notificationDisplay unavailable
            if (!this.notificationElement) this.setupNotificationContainer();
            const notification = this.createNotification(errorInfo);
            this.notificationElement.appendChild(notification);
            const duration = errorInfo.severity === 'critical' ? 10000 : 5000;
            setTimeout(() => {
                notification.classList.add('fade-out');
                setTimeout(() => { if (notification.parentNode) notification.remove(); }, 300);
            }, duration);
        }
    }

    /**
     * Create notification element
     * @private
     */
    createNotification(errorInfo) {
        const notification = document.createElement('div');
        notification.className = `error-notification error-${errorInfo.severity}`;
        
        const icon = this.getIcon(errorInfo.severity);
        const message = document.createElement('span');
        message.textContent = errorInfo.userMessage;
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'error-notification-close';
        closeBtn.innerHTML = '×';
        closeBtn.onclick = () => notification.remove();

        notification.appendChild(icon);
        notification.appendChild(message);
        notification.appendChild(closeBtn);

        return notification;
    }

    /**
     * Get icon for severity level
     * @private
     */
    getIcon(severity) {
        const iconName = severity === 'critical' ? 'critical' : 
                        severity === 'error' ? 'error' : 
                        severity === 'warning' ? 'warning' : 'info';

        const icon = iconUtils.createIcon(iconName, {
            size: 16,
            className: 'error-notification-icon'
        });
        
        return icon;
    }

    /**
     * Setup notification container
     * @private
     */
    setupNotificationContainer() {
        if (!document.body) return;

        let container = document.getElementById('error-notifications');
        if (!container) {
            container = document.createElement('div');
            container.id = 'error-notifications';
            container.className = 'error-notifications-container';
            document.body.appendChild(container);

            // Add styles if not already present
            this.injectStyles();
        }
        
        this.notificationElement = container;
    }

    /**
     * Inject notification styles
     * @private
     */
    injectStyles() {
        if (document.getElementById('error-handler-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'error-handler-styles';
        styles.textContent = `
            .error-notifications-container {
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10000;
                display: flex;
                flex-direction: column;
                gap: 10px;
                max-width: 400px;
            }

            .error-notification {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 12px 16px;
                border-radius: 8px;
                background: white;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                animation: slideIn 0.3s ease-out;
                position: relative;
            }

            .error-notification.fade-out {
                animation: fadeOut 0.3s ease-out forwards;
            }

            .error-notification-icon {
                font-size: 20px;
                flex-shrink: 0;
            }

            .error-notification-close {
                position: absolute;
                top: 4px;
                right: 8px;
                background: none;
                border: none;
                font-size: 20px;
                cursor: pointer;
                opacity: 0.5;
                transition: opacity 0.2s;
            }

            .error-notification-close:hover {
                opacity: 1;
            }

            .error-critical {
                background: #fee;
                border-left: 4px solid #f44;
            }

            .error-error {
                background: #fee;
                border-left: 4px solid #e66;
            }

            .error-warning {
                background: #ffeaa7;
                border-left: 4px solid #fdcb6e;
            }

            .error-info {
                background: #e3f2fd;
                border-left: 4px solid #2196f3;
            }

            @keyframes slideIn {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }

            @keyframes fadeOut {
                from {
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    transform: translateX(100%);
                    opacity: 0;
                }
            }

            @media (max-width: 600px) {
                .error-notifications-container {
                    left: 10px;
                    right: 10px;
                    max-width: none;
                }
            }
        `;
        
        document.head.appendChild(styles);
    }

    /**
     * Report error to monitoring service
     * @private
     */
    async reportError(errorInfo) {
        if (!this.options.monitoringEndpoint) return;

        try {
            await fetch(this.options.monitoringEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    ...errorInfo,
                    userAgent: navigator.userAgent,
                    url: window.location.href,
                    timestamp: new Date(errorInfo.timestamp).toISOString()
                })
            });
        } catch (error) {
            console.error('Failed to report error to monitoring:', error);
        }
    }

    /**
     * Register error listener
     * @param {Function} listener - Listener function
     * @returns {Function} Unsubscribe function
     */
    onError(listener) {
        this.errorListeners.add(listener);
        return () => this.errorListeners.delete(listener);
    }

    /**
     * Notify error listeners
     * @private
     */
    notifyListeners(errorInfo) {
        this.errorListeners.forEach(listener => {
            try {
                listener(errorInfo);
            } catch (error) {
                console.error('Error in error listener:', error);
            }
        });
    }

    /**
     * Get error history
     * @param {Object} filter - Optional filter criteria
     * @returns {Array} Filtered error history
     */
    getHistory(filter = {}) {
        let errors = [...this.errorQueue];

        if (filter.severity) {
            errors = errors.filter(e => e.severity === filter.severity);
        }

        if (filter.code) {
            errors = errors.filter(e => e.code === filter.code);
        }

        if (filter.since) {
            const sinceTime = filter.since instanceof Date ? filter.since.getTime() : filter.since;
            errors = errors.filter(e => e.timestamp >= sinceTime);
        }

        return errors;
    }

    /**
     * Clear error history
     */
    clearHistory() {
        this.errorQueue = [];
    }

    /**
     * Setup global error handlers
     */
    setupGlobalHandlers() {
        // Handle unhandled promise rejections
        window.addEventListener('unhandledrejection', event => {
            this.handle(event.reason, {
                type: 'unhandledRejection',
                promise: event.promise
            });
            event.preventDefault();
        });

        // Handle global errors
        window.addEventListener('error', event => {
            this.handle(event.error || event.message, {
                type: 'globalError',
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno
            });
        });
    }
}

// Export singleton instance
export const errorHandler = new ErrorHandler();

// Setup global handlers automatically
if (typeof window !== 'undefined') {
    errorHandler.setupGlobalHandlers();
}
