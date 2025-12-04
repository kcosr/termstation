/**
 * Error Message Handler
 * Handles WebSocket error messages
 */
export class ErrorHandler {
    handle(message, context) {
        console.error('[WebSocket] ERROR received:', message.message || message.error);
        
        // Emit error event if event bus is available
        if (context.eventBus) {
            context.eventBus.emit('ws:error', {
                message: message.message || message.error,
                details: message.details,
                timestamp: Date.now()
            });
        }
        
        // Show notification if notification center is available
        if (context.notificationCenter) {
            context.notificationCenter.show({
                type: 'error',
                title: 'WebSocket Error',
                message: message.message || message.error || 'An unknown error occurred',
                duration: 5000
            });
        }
    }
}

export const errorHandler = new ErrorHandler();