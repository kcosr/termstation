/**
 * Stdin Injected Message Handler
 * Handles server messages indicating input was injected into a session
 */
import { debug } from '../../../utils/debug.js';
import { appStore } from '../../../core/store.js';
import { notificationDisplay } from '../../../utils/notification-display.js';
import { notificationCenter } from '../../notification-center/notification-center.js';

export class StdinInjectedHandler {
    handle(message, context) {
        try {
            const sessionId = message.session_id || '';
            const by = message.by || 'server';
            const bytes = (typeof message.bytes === 'number') ? message.bytes : null;
            const submit = message.submit === true;
            const enterStyle = message.enter_style || 'cr';
            const raw = message.raw === true;

            const source = message.source || 'scheduled';
            const ruleId = message.rule_id || null;

            const title = 'Input Injected';
            let msg = `Input was injected by ${by}`;
            if (bytes != null) msg += ` (${bytes} bytes)`;
            if (submit) msg += ` and submitted`;
            if (raw) msg += ` (raw)`;
            if (source) msg += ` [source: ${source}]`;
            if (ruleId != null) msg += ` [rule: ${ruleId}]`;

            // Append session reference for clarity
            const notification = {
                notification_type: 'info',
                title,
                message: msg,
                session_id: sessionId,
                timestamp: new Date().toISOString(),
                origin: 'server'
            };

            // Gate toast visibility: user preference takes precedence, then honor message.notify
            // - If preference is false: never show toast
            // - If preference is true: show toast only when message.notify !== false
            let allowToastsByPref = true;
            try {
                const prefs = appStore?.getState?.('preferences.notifications') || {};
                allowToastsByPref = prefs.showScheduledInput !== false; // default true
            } catch (_) { allowToastsByPref = true; }
            const allowByMessage = (message.notify === undefined || message.notify !== false);
            const showToast = !!allowToastsByPref && !!allowByMessage;

            try {
                if (showToast) {
                    if (context && context.terminalManager && typeof context.terminalManager.handleNotification === 'function') {
                        context.terminalManager.handleNotification(notification);
                    } else if (notificationDisplay && typeof notificationDisplay.handleNotification === 'function') {
                        notificationDisplay.handleNotification(notification);
                    }
                } else {
                    // Record in Notification Center without a toast for consistent read path
                    try { notificationCenter?.addNotification?.(notification); } catch (_) {}
                }
            } catch (e) {
                console.warn('[StdinInjectedHandler] notify failed:', e);
            }

            debug.log('wsLogs', '[StdinInjectedHandler]', message);

            // No visible composition; client captures markers at modal submit

            // Register a client-side ordinal marker so we can seek by on-screen line later
            try {
                const mgr = context?.terminalManager;
                const session = mgr?.sessions?.get?.(sessionId);
                const ord = (message.ordinal !== undefined) ? message.ordinal : (message.ord !== undefined ? message.ord : null);
                if (session && typeof session.registerClientOrdinalMarker === 'function') {
                    session.registerClientOrdinalMarker(Date.now(), ord);
                }
            } catch (_) { /* best-effort */ }
        } catch (e) {
            console.warn('[StdinInjectedHandler] failed to handle message:', e);
        }
    }
}

export const stdinInjectedHandler = new StdinInjectedHandler();
