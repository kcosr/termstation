/**
 * Scheduled Input Rule Updated Handler
 * Handles lifecycle messages for scheduled input rules
 */
import { debug } from '../../../utils/debug.js';

export class ScheduledInputRuleUpdatedHandler {
    handle(message /* { action, session_id, rule } */, context) {
        try {
            // For now, just log to console. Track D may update open modals.
            const action = message?.action || 'updated';
            const sessionId = message?.session_id || null;
            const ruleId = message?.rule?.id || message?.rule_id || null;
            console.log('[ScheduledInputRuleUpdatedHandler]', { action, sessionId, ruleId, message });
            debug.log('wsLogs', '[ScheduledInputRuleUpdatedHandler]', message);
            // No global state updates required at this time
        } catch (e) {
            console.warn('[ScheduledInputRuleUpdatedHandler] failed to handle message:', e);
        }
    }
}

export const scheduledInputRuleUpdatedHandler = new ScheduledInputRuleUpdatedHandler();

