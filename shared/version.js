// Version module - uses generated build info (Node.js) or embedded values (browser).
// Run `node scripts/gen-build-info.mjs` to regenerate build info.
// The VERSION file in the repository root is the source of truth for version.
// Build number is computed from git commit count.

(function (root) {
  'use strict';

  var version = null;
  var build = null;
  var commit = null;

  // Node.js environment: use generated build info
  if (typeof require !== 'undefined' && typeof module !== 'undefined') {
    try {
      var buildInfo = require('./build-info.generated.cjs');
      version = buildInfo.version;
      build = buildInfo.build;
      commit = buildInfo.commit;
    } catch (e) {
      // Fallback: read VERSION file directly
      try {
        var fs = require('fs');
        var path = require('path');
        var versionPath = path.join(__dirname, '..', 'VERSION');
        version = fs.readFileSync(versionPath, 'utf8').trim();
        build = 0;
        commit = null;
      } catch (e2) {
        version = '0.0.0';
        build = 0;
        commit = null;
      }
    }
    module.exports = { version: version, build: build, commit: commit };
  }

  // Browser environment: use embedded values (synced by build process)
  if (typeof window !== 'undefined' || typeof globalThis !== 'undefined') {
    // These values are updated by desktop/update-version.js during builds
    var EMBEDDED_VERSION = '1.0.0';
    var EMBEDDED_BUILD = 124;
    var EMBEDDED_COMMIT = '5a17d2c';

    version = version || EMBEDDED_VERSION;
    build = build !== null ? build : EMBEDDED_BUILD;
    commit = commit || EMBEDDED_COMMIT;

    try {
      var target = root || window || globalThis;
      target.TS_FRONTEND_VERSION = version;
      target.TS_FRONTEND_BUILD = build;
      target.TS_FRONTEND_COMMIT = commit;
    } catch (_) {}
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
