import crypto from 'crypto';
import { getSessionSecret } from './session-cookie.js';

function base64urlEncode(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return b.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signHmac(data) {
  const secret = getSessionSecret();
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function createAccessToken({ sessionId, ttlSeconds = 0 }) {
  const now = Math.floor(Date.now() / 1000);
  // Keep payload type 'tunnel' for backward compatibility with existing validators
  // If ttlSeconds is 0, omit exp field entirely (token valid as long as session is active)
  const payload = {
    type: 'tunnel',
    session_id: String(sessionId || ''),
    iat: now,
    ...(ttlSeconds > 0 ? { exp: now + Math.floor(ttlSeconds) } : {})
  };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = signHmac(payloadB64);
  return `v1.${payloadB64}.${sig}`;
}

export function verifyAccessToken(token, expectedSessionId = null) {
  try {
    if (typeof token !== 'string' || !token.startsWith('v1.')) return { ok: false, error: 'invalid' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, error: 'invalid' };
    const payloadB64 = parts[1];
    const sig = parts[2];
    const expected = signHmac(payloadB64);
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'bad-sig' };
    const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    // Accept legacy 'tunnel' type and tolerate 'session' if present in future
    if (!payload || !payload.session_id || (payload.type !== 'tunnel' && payload.type !== 'session')) return { ok: false, error: 'invalid' };
    const now = Math.floor(Date.now() / 1000);
    // Only check expiration if exp field exists (TTL > 0). If exp is missing (TTL = 0), skip expiration check.
    if (payload.exp && now >= payload.exp) return { ok: false, error: 'expired' };
    if (expectedSessionId && String(payload.session_id) !== String(expectedSessionId)) return { ok: false, error: 'wrong-session' };
    return { ok: true, payload };
  } catch (_) {
    return { ok: false, error: 'invalid' };
  }
}

export function getAccessWebSocketUrl(apiBaseUrl, sessionId, token) {
  const base = String(apiBaseUrl || '').replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  const url = new URL(base);
  let prefix = url.pathname || '';
  if (!prefix.endsWith('/')) prefix += '/';
  const full = `${url.origin}${prefix}sessions/${sessionId}/tunnel?token=${encodeURIComponent(token)}`;
  return full;
}

// Legacy aliases
export const createTunnelToken = createAccessToken;
export const verifyTunnelToken = verifyAccessToken;
export const getTunnelWebSocketUrl = getAccessWebSocketUrl;

