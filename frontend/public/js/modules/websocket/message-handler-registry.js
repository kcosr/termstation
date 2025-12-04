/**
 * Message Handler Registry
 * Provides a centralized registry for WebSocket message handlers with
 * middleware support, validation, and error handling
 */
import { appStore } from '../../core/store.js';

export class MessageHandlerRegistry {
    constructor() {
        this.handlers = new Map();
        this.middleware = [];
        this.errorHandler = null;
        this.validationRules = new Map();
    }

    /**
     * Register a handler for a specific message type
     * @param {string} messageType - The message type to handle
     * @param {Function|Object} handler - Handler function or object with handle method
     * @param {Object} options - Handler options
     */
    register(messageType, handler, options = {}) {
        if (!messageType) {
            throw new Error('Message type is required');
        }

        const handlerFn = typeof handler === 'function' 
            ? handler 
            : handler.handle.bind(handler);

        if (typeof handlerFn !== 'function') {
            throw new Error('Handler must be a function or object with handle method');
        }

        this.handlers.set(messageType, {
            handler: handlerFn,
            options
        });

        // Register validation rules if provided
        if (options.validation) {
            this.validationRules.set(messageType, options.validation);
        }

        return this;
    }

    /**
     * Unregister a handler for a message type
     * @param {string} messageType - The message type to unregister
     */
    unregister(messageType) {
        this.handlers.delete(messageType);
        this.validationRules.delete(messageType);
        return this;
    }

    /**
     * Add middleware function to be executed before handlers
     * @param {Function} middlewareFn - Middleware function
     */
    use(middlewareFn) {
        if (typeof middlewareFn !== 'function') {
            throw new Error('Middleware must be a function');
        }
        this.middleware.push(middlewareFn);
        return this;
    }

    /**
     * Set error handler for handling errors in message processing
     * @param {Function} errorHandlerFn - Error handler function
     */
    setErrorHandler(errorHandlerFn) {
        if (typeof errorHandlerFn !== 'function') {
            throw new Error('Error handler must be a function');
        }
        this.errorHandler = errorHandlerFn;
        return this;
    }

    /**
     * Validate a message against registered rules
     * @param {Object} message - Message to validate
     * @returns {Object} Validation result
     */
    validate(message) {
        if (!message || typeof message !== 'object') {
            return {
                valid: false,
                error: 'Message must be an object'
            };
        }

        if (!message.type) {
            return {
                valid: false,
                error: 'Message must have a type property'
            };
        }

        const rules = this.validationRules.get(message.type);
        if (!rules) {
            return { valid: true };
        }

        // Check required fields
        if (rules.required) {
            for (const field of rules.required) {
                if (!(field in message)) {
                    return {
                        valid: false,
                        error: `Missing required field: ${field}`
                    };
                }
            }
        }

        // Check field types
        if (rules.types) {
            for (const [field, expectedType] of Object.entries(rules.types)) {
                if (field in message) {
                    const actualType = typeof message[field];
                    if (actualType !== expectedType) {
                        return {
                            valid: false,
                            error: `Field ${field} must be of type ${expectedType}, got ${actualType}`
                        };
                    }
                }
            }
        }

        // Run custom validation function if provided
        if (rules.custom && typeof rules.custom === 'function') {
            const customResult = rules.custom(message);
            if (!customResult.valid) {
                return customResult;
            }
        }

        return { valid: true };
    }

    /**
     * Process middleware chain
     * @param {Object} message - Message to process
     * @param {Object} context - Context object
     * @returns {Promise<Object>} Processed message
     */
    async processMiddleware(message, context) {
        let processedMessage = message;

        for (const middleware of this.middleware) {
            try {
                const result = await middleware(processedMessage, context);
                // Middleware can return modified message or undefined to continue with current message
                if (result !== undefined) {
                    processedMessage = result;
                }
                // If middleware returns false, stop processing
                if (result === false) {
                    return null;
                }
            } catch (error) {
                console.error('Middleware error:', error);
                if (this.errorHandler) {
                    await this.errorHandler(error, message, context);
                }
                return null;
            }
        }

        return processedMessage;
    }

    /**
     * Handle an incoming WebSocket message
     * @param {Object} message - The message to handle
     * @param {Object} context - Context object (e.g., terminal manager instance)
     * @returns {Promise<any>} Handler result
     */
    async handle(message, context = {}) {
        try {
            const debug = appStore.getState('preferences.debug.registryLogs') === true;
            if (debug && message.type !== 'stdout') {
                console.log(`[MessageHandlerRegistry] Handling message type: ${message.type}`, message);
            }
            
            // Validate message
            const validation = this.validate(message);
            if (!validation.valid) {
                console.error(`[MessageHandlerRegistry] Validation failed for ${message.type}:`, validation.error);
                const error = new Error(`Validation failed: ${validation.error}`);
                if (this.errorHandler) {
                    return await this.errorHandler(error, message, context);
                }
                throw error;
            }
            if (debug && message.type !== 'stdout') {
                console.log(`[MessageHandlerRegistry] Message validation passed for type: ${message.type}`);
            }

            // Process middleware
            const processedMessage = await this.processMiddleware(message, context);
            if (!processedMessage) {
                if (debug && message.type !== 'stdout') {
                    console.log(`[MessageHandlerRegistry] Middleware stopped processing for type: ${message.type}`);
                }
                return; // Middleware stopped processing
            }

            // Get handler for message type
            const handlerInfo = this.handlers.get(processedMessage.type);
            if (!handlerInfo) {
                // No handler registered for this message type
                if (debug) {
                    console.warn(`[MessageHandlerRegistry] No handler registered for message type: ${processedMessage.type}`);
                    console.log(`[MessageHandlerRegistry] Available handlers:`, Array.from(this.handlers.keys()));
                }
                if (context.defaultHandler) {
                    return await context.defaultHandler(processedMessage);
                }
                return;
            }

            if (debug && processedMessage.type !== 'stdout') {
                console.log(`[MessageHandlerRegistry] Found handler for type: ${processedMessage.type}, executing...`);
            }
            // Execute handler
            const result = await handlerInfo.handler(processedMessage, context);
            if (debug && processedMessage.type !== 'stdout') {
                console.log(`[MessageHandlerRegistry] Handler completed successfully for type: ${processedMessage.type}`);
            }
            return result;

        } catch (error) {
            console.error(`[MessageHandlerRegistry] Error handling message of type ${message.type}:`, error);
            if (this.errorHandler) {
                return await this.errorHandler(error, message, context);
            }
            throw error;
        }
    }

    /**
     * Check if a handler is registered for a message type
     * @param {string} messageType - The message type to check
     * @returns {boolean} True if handler is registered
     */
    hasHandler(messageType) {
        return this.handlers.has(messageType);
    }

    /**
     * Get list of registered message types
     * @returns {Array<string>} List of message types
     */
    getRegisteredTypes() {
        return Array.from(this.handlers.keys());
    }

    /**
     * Clear all handlers and middleware
     */
    clear() {
        this.handlers.clear();
        this.validationRules.clear();
        this.middleware = [];
        this.errorHandler = null;
    }
}

// Export singleton instance for global use
export const messageHandlerRegistry = new MessageHandlerRegistry();
