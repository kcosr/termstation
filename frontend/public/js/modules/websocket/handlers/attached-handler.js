/**
 * Attached Message Handler
 * Handles session attachment confirmation messages with history sync support
 */

export class AttachedHandler {
    handle(message, context) {
        console.log('[AttachedHandler] Received attached message:', message);

        if (!message.session_id) {
            console.warn('[AttachedHandler] Message missing session_id:', message);
            return;
        }

        // Emit event for session attachment with history sync info
        if (context.eventBus) {
            const eventData = {
                type: 'attached',
                detail: {
                    session_id: message.session_id,
                    history_marker: message.history_marker,
                    history_byte_offset: message.history_byte_offset,
                    should_load_history: message.should_load_history
                }
            };
            console.log('[AttachedHandler] Emitting ws-attached event:', eventData);
            context.eventBus.emit('ws-attached', eventData);
        } else {
            console.error('[AttachedHandler] No eventBus available in context!');
        }

        // Log for debugging
        console.log(`[AttachedHandler] Session ${message.session_id} attached with history_marker: ${message.history_marker}`);
    }
}

export const attachedHandler = new AttachedHandler();