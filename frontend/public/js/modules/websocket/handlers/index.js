/**
 * WebSocket Message Handlers Index
 * Exports all message handlers for easy import
 */

export { errorHandler } from './error-handler.js';
export { notificationHandler } from './notification-handler.js';
export { stdoutHandler } from './stdout-handler.js';
export { attachedHandler } from './attached-handler.js';
export { sessionUpdatedHandler } from './session-updated-handler.js';
export { sessionDetachedHandler } from './session-detached-handler.js';
export { linkUpdatedHandler } from './link-updated-handler.js';
export { linkRemovedHandler } from './link-removed-handler.js';
export { shutdownHandler } from './shutdown-handler.js';
export { workspacesUpdatedHandler } from './workspaces-updated-handler.js';
export { sessionsReorderedHandler } from './sessions-reordered-handler.js';
export { sessionRemovedHandler } from './session-removed-handler.js';
export { stdinInjectedHandler } from './stdin-injected-handler.js';
export { sessionActivityHandler } from './session-activity-handler.js';
export { scheduledInputRuleUpdatedHandler } from './scheduled-input-rule-updated-handler.js';
export { deferredInputUpdatedHandler } from './deferred-input-updated-handler.js';
export { notificationActionResultHandler } from './notification-action-result-handler.js';
export { notificationUpdatedHandler } from './notification-updated-handler.js';

// Export handler mapping for easy registration
export const handlers = {
    'error': () => import('./error-handler.js').then(m => m.errorHandler),
    'notification': () => import('./notification-handler.js').then(m => m.notificationHandler),
    'stdout': () => import('./stdout-handler.js').then(m => m.stdoutHandler),
    'attached': () => import('./attached-handler.js').then(m => m.attachedHandler),
    'session_updated': () => import('./session-updated-handler.js').then(m => m.sessionUpdatedHandler),
    'detached': () => import('./session-detached-handler.js').then(m => m.sessionDetachedHandler),
    'link-updated': () => import('./link-updated-handler.js').then(m => m.linkUpdatedHandler),
    'link-removed': () => import('./link-removed-handler.js').then(m => m.linkRemovedHandler),
    'shutdown': () => import('./shutdown-handler.js').then(m => m.shutdownHandler),
    'workspaces_updated': () => import('./workspaces-updated-handler.js').then(m => m.workspacesUpdatedHandler),
    'sessions_reordered': () => import('./sessions-reordered-handler.js').then(m => m.sessionsReorderedHandler),
    'session_removed': () => import('./session-removed-handler.js').then(m => m.sessionRemovedHandler),
    'stdin_injected': () => import('./stdin-injected-handler.js').then(m => m.stdinInjectedHandler),
    'session_activity': () => import('./session-activity-handler.js').then(m => m.sessionActivityHandler),
    'scheduled_input_rule_updated': () => import('./scheduled-input-rule-updated-handler.js').then(m => m.scheduledInputRuleUpdatedHandler),
    'deferred_input_updated': () => import('./deferred-input-updated-handler.js').then(m => m.deferredInputUpdatedHandler),
    'notification_action_result': () => import('./notification-action-result-handler.js').then(m => m.notificationActionResultHandler),
    'notification_updated': () => import('./notification-updated-handler.js').then(m => m.notificationUpdatedHandler)
};
