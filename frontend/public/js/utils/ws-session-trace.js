import { appStore } from '../core/store.js';

const MAX_TRACE_ENTRIES = 500;
const STDOUT_TRACE_INTERVAL_MS = 1500;
const MAX_STRING_LEN = 320;

class WsSessionTrace {
    constructor() {
        this.entries = [];
        this.sequence = 0;
        this.stdoutStats = new Map();
    }

    isEnabled() {
        try {
            return appStore.getState('preferences.debug.wsSessionTrace') !== false;
        } catch (_) {
            return true;
        }
    }

    sanitizeValue(value) {
        if (typeof value === 'string') {
            if (value.length > MAX_STRING_LEN) {
                return `${value.slice(0, MAX_STRING_LEN)}...`;
            }
            return value;
        }
        return value;
    }

    push(event, details = {}) {
        if (!this.isEnabled()) return;
        if (!event || typeof event !== 'string') return;

        const payload = {};
        try {
            Object.entries(details || {}).forEach(([key, value]) => {
                if (value !== undefined) payload[key] = this.sanitizeValue(value);
            });
        } catch (_) {}

        const entry = {
            seq: ++this.sequence,
            ts: new Date().toISOString(),
            event,
            ...payload
        };

        this.entries.push(entry);
        if (this.entries.length > MAX_TRACE_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_TRACE_ENTRIES);
        }
    }

    pushStdout(sessionId, bytes = 0) {
        if (!this.isEnabled()) return;

        const sid = String(sessionId || 'unknown');
        const now = Date.now();
        const current = this.stdoutStats.get(sid) || {
            lastAt: 0,
            suppressed: 0,
            bytes: 0
        };

        const chunkBytes = Number.isFinite(Number(bytes)) ? Math.max(0, Number(bytes)) : 0;
        current.bytes += chunkBytes;

        if ((now - current.lastAt) < STDOUT_TRACE_INTERVAL_MS) {
            current.suppressed += 1;
            this.stdoutStats.set(sid, current);
            return;
        }

        this.push('session.stdout', {
            session_id: sid,
            bytes: current.bytes,
            suppressed: current.suppressed
        });

        current.lastAt = now;
        current.suppressed = 0;
        current.bytes = 0;
        this.stdoutStats.set(sid, current);
    }

    clear() {
        this.entries = [];
        this.stdoutStats.clear();
    }

    getEntries() {
        return this.entries.slice();
    }

    toPrettyText() {
        const entries = this.getEntries();
        if (!entries.length) return 'No trace events captured yet.';
        return entries.map((entry) => JSON.stringify(entry)).join('\n');
    }
}

export const wsSessionTrace = new WsSessionTrace();

