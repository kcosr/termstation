export function isDynamicTitleOnlySessionUpdate(sessionData, updateType = 'updated') {
    if (!sessionData || typeof sessionData !== 'object') return false;
    if (updateType !== 'updated') return false;

    const keys = Object.keys(sessionData);
    if (keys.length !== 2) return false;
    if (!Object.prototype.hasOwnProperty.call(sessionData, 'session_id')) return false;
    if (!Object.prototype.hasOwnProperty.call(sessionData, 'dynamic_title')) return false;

    const sessionId = typeof sessionData.session_id === 'string' ? sessionData.session_id.trim() : '';
    return sessionId.length > 0;
}
