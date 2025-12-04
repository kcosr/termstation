const { contextBridge, ipcRenderer } = require('electron');

try {
  const nodeCrypto = (() => { try { return require('crypto'); } catch (_) { return null; } })();
  const nodePath = (() => { try { return require('path'); } catch (_) { return null; } })();

  const sanitizeBaseUrl = (value) => {
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    return String(value);
  };

  const invokeCookieChannel = (channel, baseUrl) => {
    try {
      return ipcRenderer.invoke(channel, sanitizeBaseUrl(baseUrl)).catch(() => ({ ok: false, error: 'ipc-failed' }));
    } catch (_) {
      return Promise.resolve({ ok: false, error: 'ipc-failed' });
    }
  };

  // Basic validation helpers for the local PTY bridge
  const clampInt = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    if (i < min || i > max) return fallback;
    return i;
  };

  const sanitizeString = (v, maxLen = 2048) => {
    if (v == null) return '';
    const s = String(v).trim();
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  };

  // Preserve whitespace/control characters (needed for Space/Enter etc.)
  const sanitizeData = (v, maxLen = 4096) => {
    if (v == null) return '';
    let s = String(v);
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  };

  const sanitizeEnv = (env) => {
    const out = {};
    if (!env || typeof env !== 'object') return out;
    let count = 0;
    for (const [k, v] of Object.entries(env)) {
      if (count >= 64) break; // cap number of env vars
      const key = sanitizeString(k, 128);
      if (!key) continue;
      out[key] = sanitizeString(v, 2048);
      count++;
    }
    return out;
  };

  // Sliding window limiter with cleanup to prevent memory growth
  const createSessionRateLimiter = (rate = 100, windowMs = 1000, options = {}) => {
    const buckets = new Map(); // key -> { start:number, count:number, last:number }
    const staleMs = typeof options.staleMs === 'number' ? Math.max(windowMs, options.staleMs) : Math.max(windowMs, 5000);
    const maxKeys = typeof options.maxKeys === 'number' ? options.maxKeys : 5000;
    const timerInterval = typeof options.cleanupIntervalMs === 'number' ? options.cleanupIntervalMs : Math.min(staleMs, 2000);
    let cleanupTimer = null;

    const sweep = () => {
      const now = Date.now();
      for (const [k, v] of buckets) {
        if (now - v.last > staleMs) buckets.delete(k);
      }
      // Bound the map size by evicting oldest if necessary
      if (buckets.size > maxKeys) {
        const entries = Array.from(buckets.entries()).sort((a, b) => a[1].last - b[1].last);
        for (let i = 0; i < entries.length && buckets.size > maxKeys; i++) {
          buckets.delete(entries[i][0]);
        }
      }
    };

    const ensureTimer = () => {
      if (cleanupTimer) return;
      try { cleanupTimer = setInterval(sweep, timerInterval); } catch (_) { cleanupTimer = null; }
    };

    const allow = (key) => {
      const now = Date.now();
      const k = sanitizeString(key || 'global', 128) || 'global';
      let b = buckets.get(k);
      if (!b) { b = { start: now, count: 0, last: now }; buckets.set(k, b); }
      if (now - b.start >= windowMs) {
        b.start = now;
        b.count = 0;
      }
      b.last = now;
      ensureTimer();
      if (b.count < rate) {
        b.count++;
        return true;
      }
      return false;
    };
    const clear = () => { try { if (cleanupTimer) clearInterval(cleanupTimer); } catch (_) {} cleanupTimer = null; buckets.clear(); };
    return { allow, clear };
  };

  // Default local terminals to enabled, but also require node-pty to be included
  const isLocalEnabled = (() => {
    const parse = (v, dflt) => {
      try {
        const raw = String(v ?? '').trim().toLowerCase();
        if (!raw) return dflt;
        return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
      } catch (_) { return dflt; }
    };
    const localFlag = parse(process?.env?.ENABLE_LOCAL_TERMINALS, true);
    const includeNodePty = parse(process?.env?.INCLUDE_NODE_PTY, true);
    return localFlag && includeNodePty;
  })();

  const buildLocalPtyApi = () => {
    const sessionLimiter = createSessionRateLimiter(100, 1000); // per-session for stdin/resize/terminate
    const globalLimiter = createSessionRateLimiter(300, 1000); // global safety net across ops
    const createLimiter = createSessionRateLimiter(10, 1000);   // limit terminal spawns

    const invokeSafe = (channel, payload, fallback = { ok: false, error: 'ipc-failed' }) => {
      try { return ipcRenderer.invoke(channel, payload).catch(() => fallback); } catch (_) { return Promise.resolve(fallback); }
    };

    const validateSessionId = (sessionId) => {
      const sid = sanitizeString(sessionId, 128);
      return sid || '';
    };

    const api = {
      // attach({ sessionId }) -> request ownership in main process (dedicated window handoff)
      attach: ({ sessionId } = {}) => {
        try {
          const sid = validateSessionId(sessionId);
          if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
          if (!sessionLimiter.allow(sid) || !globalLimiter.allow('attach')) return Promise.resolve({ ok: false, error: 'rate-limited' });
          return invokeSafe('desktop:localpty-transfer-owner', { sessionId: sid });
        } catch (_) { return Promise.resolve({ ok: false, error: 'ipc-failed' }); }
      },
      // create({ command?, cwd?, cols, rows, env? })
      create: (opts = {}) => {
        try {
          if (!opts || typeof opts !== 'object') return Promise.resolve({ ok: false, error: 'invalid-args' });
          if (!globalLimiter.allow('create') || !createLimiter.allow('create')) return Promise.resolve({ ok: false, error: 'rate-limited' });
          const cols = clampInt(opts.cols, 1, 500, 80);
          const rows = clampInt(opts.rows, 1, 500, 24);
          const command = opts.command != null ? sanitizeString(opts.command, 512) : undefined;
          let cwd = opts.cwd != null ? sanitizeString(opts.cwd, 1024) : undefined;
          if (cwd && nodePath) {
            const norm = nodePath.normalize(cwd);
            const isAbs = nodePath.isAbsolute(norm);
            const hasTraversal = /(^|[\\/])\.\.(?:[\\/]|$)/.test(norm);
            if (!isAbs || hasTraversal) return Promise.resolve({ ok: false, error: 'invalid-cwd' });
            cwd = norm;
          }
          const env = opts.env ? sanitizeEnv(opts.env) : undefined;
          const payload = { command, cwd, cols, rows, env };
          return invokeSafe('desktop:localpty-create', payload);
        } catch (_) { return Promise.resolve({ ok: false, error: 'ipc-failed' }); }
      },
      // stdin({ sessionId, data })
      stdin: ({ sessionId, data } = {}) => {
        try {
          const sid = validateSessionId(sessionId);
          if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
          if (!sessionLimiter.allow(sid) || !globalLimiter.allow('stdin')) return Promise.resolve({ ok: false, error: 'rate-limited' });
          const chunk = sanitizeData(data, 4096);
          // Allow whitespace-only and control characters as valid stdin
          return invokeSafe('desktop:localpty-stdin', { sessionId: sid, data: chunk });
        } catch (_) { return Promise.resolve({ ok: false, error: 'ipc-failed' }); }
      },
      // resize({ sessionId, cols, rows })
      resize: ({ sessionId, cols, rows } = {}) => {
        try {
          const sid = validateSessionId(sessionId);
          if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
          if (!sessionLimiter.allow(sid) || !globalLimiter.allow('resize')) return Promise.resolve({ ok: false, error: 'rate-limited' });
          const c = clampInt(cols, 1, 500, 80);
          const r = clampInt(rows, 1, 500, 24);
          return invokeSafe('desktop:localpty-resize', { sessionId: sid, cols: c, rows: r });
        } catch (_) { return Promise.resolve({ ok: false, error: 'ipc-failed' }); }
      },
      // terminate({ sessionId })
      terminate: ({ sessionId } = {}) => {
        try {
          const sid = validateSessionId(sessionId);
          if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
          if (!sessionLimiter.allow(sid) || !globalLimiter.allow('terminate')) return Promise.resolve({ ok: false, error: 'rate-limited' });
          return invokeSafe('desktop:localpty-terminate', { sessionId: sid });
        } catch (_) { return Promise.resolve({ ok: false, error: 'ipc-failed' }); }
      },
      // list()
      list: () => invokeSafe('desktop:localpty-list', undefined, { ok: false, sessions: [] }),
    };

    // Event subscription helpers with single IPC listener per channel
    const handlerSets = {
      data: new Set(),
      exit: new Set(),
      error: new Set(),
      updated: new Set()
    };
    const channels = {
      data: 'desktop:localpty-data',
      exit: 'desktop:localpty-exit',
      error: 'desktop:localpty-error',
      updated: 'desktop:localpty-updated'
    };
    const ipcHandlers = {};

    const makeOn = (type) => (handler) => {
      try {
        if (typeof handler !== 'function') return () => {};
        const set = handlerSets[type];
        const channel = channels[type];
        set.add(handler);
        if (!ipcHandlers[type]) {
          const internal = (_evt, payload) => {
            for (const fn of Array.from(set)) {
              try { fn(payload); } catch (_) {}
            }
          };
          ipcHandlers[type] = internal;
          ipcRenderer.on(channel, internal);
        }
        return () => {
          try {
            set.delete(handler);
            if (set.size === 0 && ipcHandlers[type]) {
              ipcRenderer.removeListener(channel, ipcHandlers[type]);
              ipcHandlers[type] = null;
            }
          } catch (_) {}
        };
      } catch (_) { return () => {}; }
    };

    api.onData = makeOn('data');
    api.onExit = makeOn('exit');
    api.onError = makeOn('error');
    api.onUpdated = makeOn('updated');

    // Cleanup on window unload
    try {
      window.addEventListener('unload', () => {
        try {
          for (const [type, channel] of Object.entries(channels)) {
            const h = ipcHandlers[type];
            if (h) ipcRenderer.removeListener(channel, h);
            ipcHandlers[type] = null;
            handlerSets[type].clear();
          }
          sessionLimiter.clear();
          globalLimiter.clear();
          createLimiter.clear();
        } catch (_) {}
      });
    } catch (_) {}

    return api;
  };

  const buildLocalPtyStub = () => {
    const rejector = () => Promise.reject(new Error('local-terminals-disabled'));
    const noops = () => () => {};
    return {
      create: rejector,
      stdin: rejector,
      resize: rejector,
      terminate: rejector,
      list: rejector,
      onData: noops(),
      onExit: noops(),
      onError: noops(),
      onUpdated: noops()
    };
  };

  // Resolve application version from main process synchronously so it's available early
  let appVersion = '';
  try { appVersion = ipcRenderer.sendSync('desktop:get-app-version-sync') || ''; } catch (_) { appVersion = ''; }

  contextBridge.exposeInMainWorld('desktop', {
    isElectron: true,
    appVersion,
    // Signal from renderer that UI is ready to be shown (main process will show window)
    uiReady: () => { try { ipcRenderer.send('desktop:ui-ready'); return true; } catch (_) { return false; } },
    openDevTools: () => ipcRenderer.invoke('desktop:open-devtools').catch(() => false),
    openExternal: (url) => ipcRenderer.invoke('desktop:open-external', String(url)).catch(() => false),
    openPath: (targetPath) => {
      try {
        if (typeof targetPath !== 'string' || !targetPath.trim()) {
          return Promise.resolve({ ok: false, error: 'invalid-path' });
        }
        return ipcRenderer.invoke('desktop:open-path', targetPath.trim())
          .catch(() => ({ ok: false, error: 'ipc-failed' }));
      } catch (_) {
        return Promise.resolve({ ok: false, error: 'ipc-failed' });
      }
    },
    getAllowInvalidCerts: () => ipcRenderer.invoke('desktop:get-allow-insecure-certs').catch(() => false),
    setAllowInvalidCerts: (enable) => ipcRenderer.invoke('desktop:set-allow-insecure-certs', !!enable).catch(() => false),
    // Save a blob/ArrayBuffer to disk via native save dialog
    // Note: accepts base64 string since Blob doesn't serialize across context bridge
    saveBlob: async (base64Data, filename) => {
      try {
        if (typeof base64Data !== 'string') {
          return { ok: false, error: 'invalid-data' };
        }
        const name = sanitizeString(String(filename || 'download'), 256);
        return ipcRenderer.invoke('desktop:save-blob-file', { filename: name, data: base64Data })
          .catch(() => ({ ok: false, error: 'ipc-failed' }));
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
    // Download to temp and open with default app
    downloadAndOpen: async (base64Data, filename) => {
      try {
        if (typeof base64Data !== 'string') {
          return { ok: false, error: 'invalid-data' };
        }
        const name = sanitizeString(String(filename || 'download'), 256);
        return ipcRenderer.invoke('desktop:download-and-open', { filename: name, data: base64Data })
          .catch(() => ({ ok: false, error: 'ipc-failed' }));
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
    // Desktop window visual effects (opacity only)
    getWindowEffects: () => ipcRenderer.invoke('desktop:get-window-effects').catch(() => ({ opacity: 1 })),
    setWindowEffects: (effects) => ipcRenderer.invoke('desktop:set-window-effects', { opacity: effects?.opacity }).catch(() => false),
    // Apply terminal font settings across all open windows
    applyFontSettingsAll: (fontSize, fontFamily) => {
      try {
        const size = parseInt(fontSize) || 14;
        const fam = sanitizeString(fontFamily || '', 256);
        return ipcRenderer.invoke('desktop:apply-font-settings-all', { fontSize: size, fontFamily: fam }).catch(() => false);
      } catch (_) { return Promise.resolve(false); }
    },
    // Settings persistence to disk
    settings: {
      load: () => ipcRenderer.invoke('desktop:settings-load').catch(() => ({ ok: false, error: 'ipc-failed' })),
      loadSync: () => {
        try { return ipcRenderer.sendSync('desktop:settings-load-sync'); } catch (_) { return { ok: false, error: 'ipc-failed' }; }
      },
      save: (data) => ipcRenderer.invoke('desktop:settings-save', data).catch(() => ({ ok: false, error: 'ipc-failed' })),
      path: () => ipcRenderer.invoke('desktop:settings-path').catch(() => null),
      export: (data) => ipcRenderer.invoke('desktop:settings-export', data).catch(() => ({ ok: false, error: 'ipc-failed' })),
      import: () => ipcRenderer.invoke('desktop:settings-import').catch(() => ({ ok: false, error: 'ipc-failed' }))
    }
    ,
    state: {
      load: () => ipcRenderer.invoke('desktop:state-load').catch(() => ({ ok: false, error: 'ipc-failed' })),
      loadSync: () => { try { return ipcRenderer.sendSync('desktop:state-load-sync'); } catch (_) { return { ok: false, error: 'ipc-failed' }; } },
      save: (data) => ipcRenderer.invoke('desktop:state-save', data).catch(() => ({ ok: false, error: 'ipc-failed' })),
      path: () => ipcRenderer.invoke('desktop:state-path').catch(() => null),
      export: (data) => ipcRenderer.invoke('desktop:state-export', data).catch(() => ({ ok: false, error: 'ipc-failed' })),
      import: () => ipcRenderer.invoke('desktop:state-import').catch(() => ({ ok: false, error: 'ipc-failed' }))
    },
    reloadWindow: () => ipcRenderer.invoke('desktop:reload-window').catch(() => false),
    // Fullscreen controls for current window
    getFullScreen: () => ipcRenderer.invoke('desktop:get-fullscreen').then(r => !!(r && r.fullscreen)).catch(() => false),
    setFullScreen: (enable) => ipcRenderer.invoke('desktop:set-fullscreen', !!enable).then(r => !!(r && r.ok)).catch(() => false),
    toggleFullScreen: () => ipcRenderer.invoke('desktop:toggle-fullscreen').then(r => !!(r && r.ok)).catch(() => false),
    // Open a specific session in a new desktop window
    openSessionWindow: (sessionId, title = '') => {
      try {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        const t = typeof title === 'string' ? title.trim() : '';
        if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
        return ipcRenderer.invoke('desktop:open-session-window', { sessionId: sid, title: t })
          .catch(() => ({ ok: false, error: 'ipc-failed' }));
      } catch (_) {
        return Promise.resolve({ ok: false, error: 'ipc-failed' });
      }
    },
    // Dedicated session window helpers
    getSessionWindow: (sessionId) => {
      try {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
        return ipcRenderer.invoke('desktop:get-session-window', { sessionId: sid })
          .catch(() => ({ ok: false, error: 'ipc-failed' }));
      } catch (_) {
        return Promise.resolve({ ok: false, error: 'ipc-failed' });
      }
    },
    focusSessionWindow: (sessionId) => {
      try {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
        return ipcRenderer.invoke('desktop:focus-session-window', { sessionId: sid })
          .catch(() => ({ ok: false, error: 'ipc-failed' }));
      } catch (_) {
        return Promise.resolve({ ok: false, error: 'ipc-failed' });
      }
    },
    closeSessionWindow: (sessionId) => {
      try {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
        return ipcRenderer.invoke('desktop:close-session-window', { sessionId: sid })
          .catch(() => ({ ok: false, error: 'ipc-failed' }));
      } catch (_) {
        return Promise.resolve({ ok: false, error: 'ipc-failed' });
      }
    },
    setWindowSession: (sessionId) => {
      try {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
        return ipcRenderer.invoke('desktop:set-window-session', { sessionId: sid })
          .catch(() => ({ ok: false, error: 'ipc-failed' }));
      } catch (_) {
        return Promise.resolve({ ok: false, error: 'ipc-failed' });
      }
    },
    focusMainWindow: () => {
      try { return ipcRenderer.invoke('desktop:focus-main-window').catch(() => ({ ok: false })); } catch (_) { return Promise.resolve({ ok: false }); }
    },
    onSessionWindowChanged: (handler) => {
      try {
        if (typeof handler !== 'function') return false;
        ipcRenderer.on('desktop:session-window-changed', (_evt, payload) => {
          try { handler(payload); } catch (_) {}
        });
        return true;
      } catch (_) { return false; }
    },
    // Local session manual title updates (cross-window broadcast)
    onLocalTitleUpdated: (handler) => {
      try {
        if (typeof handler !== 'function') return false;
        ipcRenderer.on('desktop:local-title-updated', (_evt, payload) => {
          try { handler(payload); } catch (_) {}
        });
        return true;
      } catch (_) { return false; }
    },
    notifyLocalTitleUpdated: ({ sessionId, title } = {}) => {
      try {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        const t = typeof title === 'string' ? title : '';
        if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
        return ipcRenderer.invoke('desktop:local-title-updated', { sessionId: sid, title: t })
          .catch(() => ({ ok: false, error: 'ipc-failed' }));
      } catch (_) {
        return Promise.resolve({ ok: false, error: 'ipc-failed' });
      }
    },
    drag: {
      startSession: (sessionId, clientId = '') => {
        try {
          const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
          const cid = typeof clientId === 'string' ? clientId.trim() : '';
          if (!sid) return Promise.resolve({ ok: false, error: 'invalid-session-id' });
          return ipcRenderer.invoke('desktop:drag-start-session', { sessionId: sid, clientId: cid }).catch(() => ({ ok: false }));
        } catch (_) { return Promise.resolve({ ok: false }); }
      },
      endSession: () => {
        try { return ipcRenderer.invoke('desktop:drag-end-session').catch(() => ({ ok: false })); } catch (_) { return Promise.resolve({ ok: false }); }
      },
      getSession: () => {
        try { return ipcRenderer.invoke('desktop:drag-get-session').catch(() => ({ ok: false, drag: null })); } catch (_) { return Promise.resolve({ ok: false, drag: null }); }
      }
    },
    cookies: {
      save: (baseUrl) => invokeCookieChannel('desktop:cookies-save', baseUrl),
      restore: (baseUrl) => invokeCookieChannel('desktop:cookies-restore', baseUrl),
      clear: (baseUrl) => invokeCookieChannel('desktop:cookies-clear', baseUrl)
    },
    // Fonts enumeration (desktop only)
    fonts: {
      list: () => {
        try { return ipcRenderer.invoke('desktop:list-fonts').catch(() => ({ ok: false, fonts: [] })); }
        catch (_) { return Promise.resolve({ ok: false, fonts: [] }); }
      }
    },
    crypto: {
      generatePasswordHash: (password, iterations = 150000, saltlen = 16, digest = 'sha256') => {
        try {
          if (!nodeCrypto) return { ok: false, error: 'no-crypto' };
          const salt = nodeCrypto.randomBytes(Math.max(8, saltlen|0));
          const derived = nodeCrypto.pbkdf2Sync(String(password), salt, iterations|0, 32, String(digest));
          const toHex = (buf) => Buffer.from(buf).toString('hex');
          const line = `pbkdf2$${iterations}$${toHex(salt)}$${toHex(derived)}`;
          return { ok: true, hash: line };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      }
    }
    ,
    // HTTP bridge over Unix domain socket / named pipe
    http: {
      request: (opts = {}) => {
        try { return ipcRenderer.invoke('desktop:http-request', opts).catch(() => ({ ok: false, error: 'ipc-failed' })); }
        catch (_) { return Promise.resolve({ ok: false, error: 'ipc-failed' }); }
      }
    },
    // WebSocket bridge over UDS
    ws: {
      connect: async (opts = {}) => {
        try {
          const res = await ipcRenderer.invoke('desktop:ws-open', opts).catch(() => ({ ok: false }));
          if (!res || !res.ok || !res.id) return { ok: false, error: 'open-failed' };
          const id = res.id;
          const handlers = { open: new Set(), message: new Set(), error: new Set(), close: new Set() };
          const listener = (_evt, payload) => {
            try {
              if (!payload || payload.id !== id) return;
              const set = handlers[payload.type];
              if (!set) return;
              for (const fn of Array.from(set)) { try { fn(payload.payload); } catch (_) {} }
            } catch (_) {}
          };
          ipcRenderer.on('desktop:ws-event', listener);
          const api = {
            onOpen: (fn) => { if (typeof fn === 'function') handlers.open.add(fn); return () => handlers.open.delete(fn); },
            onMessage: (fn) => { if (typeof fn === 'function') handlers.message.add(fn); return () => handlers.message.delete(fn); },
            onError: (fn) => { if (typeof fn === 'function') handlers.error.add(fn); return () => handlers.error.delete(fn); },
            onClose: (fn) => { if (typeof fn === 'function') handlers.close.add(fn); return () => handlers.close.delete(fn); },
            send: (data) => { try { return ipcRenderer.invoke('desktop:ws-send', { id, data }).then(r => !!(r && r.ok)).catch(() => false); } catch (_) { return Promise.resolve(false); } },
            close: (code = 1000, reason = '') => { try { return ipcRenderer.invoke('desktop:ws-close', { id, code, reason }).then(r => !!(r && r.ok)).catch(() => false); } catch (_) { return Promise.resolve(false); } },
            dispose: () => { try { ipcRenderer.removeListener('desktop:ws-event', listener); } catch (_) {} }
          };
          return { ok: true, id, socket: api };
        } catch (_) {
          return { ok: false, error: 'ipc-failed' };
        }
      }
    },
    apiProxy: {
      setTarget: (url) => {
        try {
          const safe = sanitizeString(url || '', 2048);
          return ipcRenderer.invoke('desktop:set-api-proxy-target', { url: safe })
            .catch(() => ({ ok: false, error: 'ipc-failed' }));
        } catch (_) {
          return Promise.resolve({ ok: false, error: 'ipc-failed' });
        }
      }
    },
    // Local PTY bridge (feature-flagged)
    // Usage example:
    //   if (window.desktop?.localpty) {
    //     const unsub = window.desktop.localpty.onData(({ sessionId, data }) => {
    //       console.log('PTY data', sessionId, data);
    //     });
    //     const res = await window.desktop.localpty.create({ cols: 80, rows: 24 });
    //     unsub();
    //   }
    localpty: isLocalEnabled ? buildLocalPtyApi() : buildLocalPtyStub()
  });
} catch (e) {
  // Fallback: do nothing if contextIsolation disabled or preload fails
  try { console.warn('[Preload] Failed to expose desktop API', e && (e.message || e)); } catch (_) {}
}
