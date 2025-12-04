import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { config } from '../config-loader.js';

const DEFAULT_SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL || '86400', 10); // 24h
// Single fixed cookie name per your request
export const SESSION_COOKIE_NAME = 'ts_session';

function normalizePathPrefix(v) {
  try {
    if (!v || typeof v !== 'string') return '/';
    let s = v.trim();
    if (!s) return '/';
    if (!s.startsWith('/')) s = '/' + s;
    // Drop any trailing slash except for root
    while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch (_) {
    return '/';
  }
}

// Keep cookie Path simple (root).
function computeCookiePath(req) { return '/'; }

// Persistent per-instance secret: survive restarts until reset via API.
// Store in configured DATA_DIR alongside other runtime data (e.g., notifications.json).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = config.DATA_DIR;
const SECRET_PATH = path.join(DATA_DIR, 'session-secret.key');

let SESSION_SECRET_VALUE = null;

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function isValidHexSecret(s) {
  try {
    return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s.trim()); // 32 bytes hex
  } catch (_) { return false; }
}

function writeSecretToDisk(hex) {
  try {
    // Write atomically where possible: write temp then rename
    const tmp = SECRET_PATH + '.tmp';
    fs.writeFileSync(tmp, hex + '\n', { mode: 0o600 });
    fs.renameSync(tmp, SECRET_PATH);
    try { fs.chmodSync(SECRET_PATH, 0o600); } catch (_) {}
  } catch (e) {
    try { logger.error(`Failed to persist session secret: ${e.message}`); } catch (_) {}
    // Best effort: still keep in-memory value
  }
}

function loadOrCreateSecret() {
  ensureDataDir();
  // Strictly use the configured DATA_DIR path
  try {
    const raw = fs.readFileSync(SECRET_PATH, 'utf8');
    const trimmed = String(raw || '').trim();
    if (isValidHexSecret(trimmed)) {
      SESSION_SECRET_VALUE = trimmed;
      return SESSION_SECRET_VALUE;
    }
  } catch (_) { /* fall through to create */ }

  // Create new secret and persist
  const hex = crypto.randomBytes(32).toString('hex');
  SESSION_SECRET_VALUE = hex;
  writeSecretToDisk(hex);
  return SESSION_SECRET_VALUE;
}

export function getSessionSecret() {
  if (!SESSION_SECRET_VALUE) loadOrCreateSecret();
  return SESSION_SECRET_VALUE;
}

export function rotateSessionSecret() {
  const hex = crypto.randomBytes(32).toString('hex');
  SESSION_SECRET_VALUE = hex;
  ensureDataDir();
  writeSecretToDisk(hex);
  return SESSION_SECRET_VALUE;
}

function base64urlEncode(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return b.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function base64urlDecode(input) {
  const s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  return Buffer.from(s + pad, 'base64');
}

function signHmac(data) {
  const secret = getSessionSecret();
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function createSessionToken(user, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { username: String(user?.username || ''), iat: now, exp: now + Math.max(60, ttlSeconds) };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = signHmac(payloadB64);
  return `v1.${payloadB64}.${sig}`;
}

export function verifySessionToken(token) {
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
    const payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!payload || !payload.username || !payload.exp || now >= payload.exp) {
      return { ok: false, error: 'expired' };
    }
    return { ok: true, payload };
  } catch (_) {
    return { ok: false, error: 'invalid' };
  }
}

export function parseCookies(req) {
  try {
    const header = req.headers && req.headers.cookie;
    if (!header) return {};
    const out = {};
    String(header).split(';').forEach(kv => {
      const idx = kv.indexOf('=');
      if (idx > -1) {
        const k = kv.slice(0, idx).trim();
        const v = kv.slice(idx + 1).trim();
        out[k] = decodeURIComponent(v);
      }
    });
    return out;
  } catch (_) { return {}; }
}

export function setSessionCookie(res, token, req) {
  try {
    const isSecure = (req && (req.secure || (req.headers && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https')));
    const cookiePath = computeCookiePath(req);
    const attrs = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      `Path=${cookiePath}`,
      'HttpOnly',
      // For Capacitor/Electron (cross-origin WebView), allow cookie on subrequests
      // Use SameSite=None when delivered over HTTPS, otherwise fall back to Lax for http dev
      isSecure ? 'SameSite=None' : 'SameSite=Lax'
    ];
    if (isSecure) attrs.push('Secure');
    const ver = verifySessionToken(token);
    if (ver.ok && ver.payload && ver.payload.exp) {
      const now = Math.floor(Date.now() / 1000);
      const maxAge = Math.max(0, ver.payload.exp - now);
      attrs.push(`Max-Age=${maxAge}`);
    }
    res.setHeader('Set-Cookie', attrs.join('; '));
  } catch (_) {}
}

export function clearSessionCookie(res, req) {
  try {
    const isSecure = (req && (req.secure || (req.headers && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https')));
    const cookiePath = computeCookiePath(req);
    const attrs = [
      `${SESSION_COOKIE_NAME}=`,
      `Path=${cookiePath}`,
      'HttpOnly',
      // Mirror the SameSite mode used for setting the cookie
      isSecure ? 'SameSite=None' : 'SameSite=Lax',
      'Max-Age=0'
    ];
    if (isSecure) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  } catch (_) {}
}

export function authenticateRequestByCookie(req) {
  try {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) return { ok: false };
    const ver = verifySessionToken(token);
    if (!ver.ok) return { ok: false };
    return { ok: true, username: ver.payload.username };
  } catch (_) {
    return { ok: false };
  }
}

export const sessionCookie = { DEFAULT_SESSION_TTL_SECONDS, SESSION_COOKIE_NAME };
