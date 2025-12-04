import { logger } from '../utils/logger.js';

// Simple multiplexed stream manager over a single WS per session.
// Binary frames: [type:1][streamId:4 big-endian][payload...]
//  - type 0x01: data
//  - type 0x02: end

import { Duplex } from 'stream';

function writeFrame(ws, type, id, payload) {
  const dataLen = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(1 + 4 + dataLen);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(id >>> 0, 1);
  if (dataLen > 0) payload.copy(buf, 5);
  try { ws.send(buf, { binary: true }); } catch (e) { /* ignore */ }
}

class StreamDuplex extends Duplex {
  constructor(sessionId, id, ws, onClose) {
    super({ allowHalfOpen: false });
    this._sessionId = sessionId;
    this._id = id;
    this._ws = ws;
    this._onClose = onClose;
    this._ended = false;
  }
  _read() { /* pushed by manager on inbound frames */ }
  _write(chunk, enc, cb) {
    try {
      if (!this._ws || this._ws.readyState !== 1 /* OPEN */) return cb(new Error('tunnel closed'));
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
      writeFrame(this._ws, 0x01, this._id, data);
      cb();
    } catch (e) {
      cb(e);
    }
  }
  _final(cb) {
    try { if (this._ws && this._ws.readyState === 1) writeFrame(this._ws, 0x02, this._id, Buffer.alloc(0)); } catch (_) {}
    cb();
  }
  _destroy(err, cb) {
    try { if (this._ws && this._ws.readyState === 1) writeFrame(this._ws, 0x02, this._id, Buffer.alloc(0)); } catch (_) {}
    try { if (typeof this._onClose === 'function') this._onClose(this._id); } catch (_) {}
    cb(err);
  }
}

class Tunnel {
  constructor(sessionId, ws) {
    this.sessionId = sessionId;
    this.ws = ws;
    this.streams = new Map(); // id -> StreamDuplex
    this.nextId = 1;
    this._boundOnMessage = (data) => this.onMessage(data);
    this._boundOnClose = () => this.onClose();
    ws.on('message', this._boundOnMessage);
    ws.on('close', this._boundOnClose);
    ws.on('error', this._boundOnClose);
  }
  allocateId() { return (this.nextId++ & 0x7fffffff) || (this.nextId++ & 0x7fffffff); }
  onMessage(data) {
    try {
      if (typeof data === 'string') {
        // control JSON
        try {
          const msg = JSON.parse(data);
          if (msg && msg.type === 'err' && Number.isInteger(msg.id)) {
            const s = this.streams.get(msg.id);
            if (s) s.destroy(new Error(msg.message || 'tunnel stream error'));
          }
          // ignore other control for now (hello, etc.)
        } catch (_) {}
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 5) return;
      const type = buf.readUInt8(0);
      const id = buf.readUInt32BE(1);
      const payload = buf.subarray(5);
      const stream = this.streams.get(id);
      if (!stream) return;
      if (type === 0x01) {
        stream.push(payload);
      } else if (type === 0x02) {
        stream.push(null);
        this.streams.delete(id);
      }
    } catch (e) {
      try { logger.warning(`[Tunnel ${this.sessionId}] onMessage error: ${e.message}`); } catch (_) {}
    }
  }
  onClose() {
    try { logger.info(`[Tunnel ${this.sessionId}] disconnected`); } catch (_) {}
    for (const [id, s] of this.streams.entries()) {
      try { s.destroy(new Error('tunnel closed')); } catch (_) {}
    }
    this.streams.clear();
  }
  openStream({ host = '127.0.0.1', port }) {
    const id = this.allocateId();
    const s = new StreamDuplex(this.sessionId, id, this.ws, (sid) => this.streams.delete(sid));
    this.streams.set(id, s);
    // Send control open frame as JSON text
    try { this.ws.send(JSON.stringify({ type: 'open', id, host, port })); } catch (_) {}
    return s;
  }
}

export class TunnelManager {
  constructor() {
    this._tunnels = new Map(); // sessionId -> Tunnel
  }
  register(sessionId, ws) {
    try {
      if (this._tunnels.has(sessionId)) {
        try { this._tunnels.get(sessionId)?.ws?.close(1012, 'replaced'); } catch (_) {}
      }
      const t = new Tunnel(sessionId, ws);
      this._tunnels.set(sessionId, t);
      logger.info(`[Tunnel] Registered for session ${sessionId}`);
      return t;
    } catch (e) {
      logger.error(`[Tunnel] Failed to register for ${sessionId}: ${e.message}`);
      return null;
    }
  }
  unregister(sessionId) {
    const t = this._tunnels.get(sessionId);
    if (!t) return;
    try { t.onClose(); } catch (_) {}
    this._tunnels.delete(sessionId);
  }
  hasTunnel(sessionId) { return this._tunnels.has(sessionId); }
  openStream(sessionId, opts) {
    const t = this._tunnels.get(sessionId);
    if (!t) throw new Error('No tunnel for session');
    // Enforce loopback only
    const host = '127.0.0.1';
    const port = Number(opts?.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid port');
    try { logger.info(`[Tunnel] openStream session=${sessionId} host=${host} port=${port}`); } catch (_) {}
    return t.openStream({ host, port });
  }
}

export const tunnelManager = new TunnelManager();
