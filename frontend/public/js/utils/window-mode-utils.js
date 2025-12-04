(function(){
  try {
    if (window.WindowModeUtils) return; // avoid redefining
  } catch (_) {}

  function getParams(loc) {
    try {
      var l = loc || window.location;
      return new URLSearchParams(l.search || '');
    } catch (_) { return new URLSearchParams(''); }
  }

  function toBool(x) { return String(x || '').toLowerCase() === '1' || String(x || '').toLowerCase() === 'true'; }

  function hasSessionId(loc) {
    try {
      var p = getParams(loc);
      return !!String(p.get('session_id') || '').trim();
    } catch (_) { return false; }
  }

  function shouldUseMinimalModeFromUrl(loc) {
    try {
      var p = getParams(loc);
      var ui = String(p.get('ui') || '').toLowerCase();
      return ui === 'minimal';
    } catch (_) { return false; }
  }

  function shouldUseWindowModeFromUrl(loc) {
    try {
      var p = getParams(loc);
      var ui = String(p.get('ui') || '').toLowerCase();
      var win = String(p.get('window') || '').trim();
      if (ui === 'window' || toBool(win)) return true;
      // default to window mode when a session_id is present and no explicit ui
      return hasSessionId(loc) && !ui;
    } catch (_) { return false; }
  }

  function buildWindowModeUrl(sessionId, base) {
    try {
      var sid = String(sessionId || '').trim();
      if (!sid) return null;
      var originPath = base || (window.location.origin + window.location.pathname);
      // Default window mode is applied when session_id is present; no extra params needed
      var u = originPath + '?session_id=' + encodeURIComponent(sid);
      return u;
    } catch (_) { return null; }
  }

  var api = {
    hasSessionId: hasSessionId,
    shouldUseMinimalModeFromUrl: shouldUseMinimalModeFromUrl,
    shouldUseWindowModeFromUrl: shouldUseWindowModeFromUrl,
    buildWindowModeUrl: buildWindowModeUrl
  };

  try { window.WindowModeUtils = api; } catch (_) {}
})();
