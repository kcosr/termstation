/**
 * Send stdin text followed by an Enter key after a short delay,
 * to ensure the PTY receives separate writes (avoids coalescing).
 *
 * @param {object} wsClient - WebSocketService instance with send(type, data)
 * @param {string} sessionId - Target session id
 * @param {string} text - Text to send before submit
 * @param {object} [options]
 * @param {number} [options.delayMs=120] - Delay before sending Enter
 * @param {string} [options.enterStyle='cr'] - 'cr' | 'lf' | 'crlf'
 * @param {boolean} [options.normalizeCRLF=true] - Normalize '\r\n' to '\n'
 * @param {boolean} [options.stripFinalNewline=true] - Remove a single trailing '\n' before submit
 * @returns {Promise<boolean>} success
 */
export async function sendStdinWithDelayedSubmit(wsClient, sessionId, text, options = {}) {
    try {
        if (!wsClient || typeof wsClient.send !== 'function') return false;
        if (!sessionId) return false;

        const {
            delayMs = 120,
            enterStyle = 'cr',
            normalizeCRLF = true,
            stripFinalNewline = true
        } = options;

        let payload = String(text ?? '');
        if (normalizeCRLF) payload = payload.replace(/\r\n/g, '\n');
        const dataToSend = stripFinalNewline ? payload.replace(/\n$/, '') : payload;

        if (dataToSend) {
            const CHUNK = 2048;
            if (dataToSend.length > CHUNK) {
                for (let i = 0; i < dataToSend.length; i += CHUNK) {
                    const part = dataToSend.slice(i, i + CHUNK);
                    wsClient.send('stdin', { session_id: sessionId, data: part });
                }
            } else {
                wsClient.send('stdin', { session_id: sessionId, data: dataToSend });
            }
        }

        const delay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 0;
        if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
        }

        let enterSeq = '\r';
        const style = String(enterStyle || 'cr').toLowerCase();
        if (style === 'lf') enterSeq = '\n';
        else if (style === 'crlf') enterSeq = '\r\n';

        wsClient.send('stdin', { session_id: sessionId, data: enterSeq });
        return true;
    } catch (_) {
        return false;
    }
}
