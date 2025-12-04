#!/usr/bin/env node

/**
 * update-version.js
 *
 * Synchronizes version information for desktop builds:
 * 1. Runs gen-build-info.mjs to generate build info from VERSION + git
 * 2. Updates desktop/package.json with semver version
 * 3. Updates embedded values in shared/version.js for browser builds
 * 4. Syncs frontend/public/version.js for browser-only deployments
 * 5. Prepares the frontend staging directory for Electron builds
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Paths
const rootDir = path.join(__dirname, '..');
const versionFilePath = path.join(rootDir, 'VERSION');
const sharedVersionPath = path.join(rootDir, 'shared', 'version.js');
const buildInfoPath = path.join(rootDir, 'shared', 'build-info.generated.cjs');
const packageJsonPath = path.join(__dirname, 'package.json');
const frontendRoot = path.join(rootDir, 'frontend');
const frontendPublicVersionPath = path.join(frontendRoot, 'public', 'version.js');
const stageRoot = path.join(__dirname, '.frontend-stage');

function parseBoolEnv(name, defaultVal = true) {
  try {
    const raw = String(process.env[name] ?? '').trim().toLowerCase();
    if (!raw) return defaultVal;
    return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
  } catch (_) {
    return defaultVal;
  }
}

try {
  // 1. Run gen-build-info.mjs to generate/update build info
  console.log('Generating build info...');
  try {
    execSync('node scripts/gen-build-info.mjs', {
      cwd: rootDir,
      stdio: 'inherit'
    });
  } catch (e) {
    console.warn(`Warning: Could not run gen-build-info.mjs: ${e.message}`);
  }

  // 2. Read build info (generated or fallback)
  let version, build, commit;
  try {
    // Clear require cache to get fresh values
    delete require.cache[require.resolve(buildInfoPath)];
    const buildInfo = require(buildInfoPath);
    version = buildInfo.version;
    build = buildInfo.build;
    commit = buildInfo.commit;
    console.log(`Build info: v${version} (build ${build}${commit ? `, ${commit}` : ''})`);
  } catch (e) {
    // Fallback: read VERSION file directly
    console.warn(`Warning: Could not read build info, falling back to VERSION file`);
    version = fs.readFileSync(versionFilePath, 'utf8').trim();
    build = 0;
    commit = null;
  }

  // 3. Update desktop/package.json version
  // Electron/npm requires semver; ensure version is valid semver
  let semverVersion = version;
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    // If not semver, convert (e.g., "1" -> "0.0.1")
    semverVersion = `0.0.${version}`;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  packageJson.version = semverVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  console.log(`Updated desktop/package.json version to ${semverVersion}`);

  // 4. Update embedded values in shared/version.js for browser builds
  try {
    let sharedContent = fs.readFileSync(sharedVersionPath, 'utf8');
    let updated = sharedContent;

    // Update EMBEDDED_VERSION
    updated = updated.replace(
      /var EMBEDDED_VERSION = '[^']*';/,
      `var EMBEDDED_VERSION = '${version}';`
    );

    // Update EMBEDDED_BUILD
    updated = updated.replace(
      /var EMBEDDED_BUILD = \d+;/,
      `var EMBEDDED_BUILD = ${build};`
    );

    // Update EMBEDDED_COMMIT
    updated = updated.replace(
      /var EMBEDDED_COMMIT = (?:'[^']*'|null);/,
      `var EMBEDDED_COMMIT = ${commit ? `'${commit}'` : 'null'};`
    );

    if (updated !== sharedContent) {
      fs.writeFileSync(sharedVersionPath, updated, 'utf8');
      console.log(`Updated embedded values in shared/version.js`);
    }
  } catch (e) {
    console.warn(`Warning: Could not update shared/version.js: ${e.message}`);
  }

  // 5. Sync frontend/public/version.js
  // Create a browser-only version file for pure web deployments
  const browserVersionContent = `// AUTO-GENERATED FILE - DO NOT EDIT
// Synced from VERSION and git by desktop/update-version.js
// Source: VERSION (${version}), Build ${build}${commit ? `, Commit ${commit}` : ''}
(function(root) {
  'use strict';
  var TS_VERSION = '${version}';
  var TS_BUILD = ${build};
  var TS_COMMIT = ${commit ? `'${commit}'` : 'null'};
  try {
    root.TS_FRONTEND_VERSION = TS_VERSION;
    root.TS_FRONTEND_BUILD = TS_BUILD;
    root.TS_FRONTEND_COMMIT = TS_COMMIT;
  } catch (_) {}
  // CommonJS export for compatibility
  if (typeof module !== 'undefined') {
    try { module.exports = { version: TS_VERSION, build: TS_BUILD, commit: TS_COMMIT }; } catch (_) {}
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
`;

  try {
    const lifecycle = String(process.env.npm_lifecycle_event || '').toLowerCase();
    const targetsEnv = String(process.env.ELECTRON_BUILDER_TARGETS || '').toLowerCase();
    const wantWindowsTarget = lifecycle.includes(':win') || lifecycle.endsWith(':all') || targetsEnv.includes('win');

    // On Windows builds, ensure it's a regular file (not symlink)
    if (wantWindowsTarget) {
      try {
        const st = fs.lstatSync(frontendPublicVersionPath);
        if (st && st.isSymbolicLink && st.isSymbolicLink()) {
          try { fs.unlinkSync(frontendPublicVersionPath); } catch (_) {}
        }
      } catch (e) {
        try { fs.unlinkSync(frontendPublicVersionPath); } catch (_) {}
      }
    }

    fs.mkdirSync(path.dirname(frontendPublicVersionPath), { recursive: true });
    fs.writeFileSync(frontendPublicVersionPath, browserVersionContent, 'utf8');
    console.log(`Synced frontend/public/version.js`);
  } catch (e) {
    console.warn(`Warning: Could not sync frontend/public/version.js: ${e.message}`);
  }

  // 6. Optionally prune optional dependencies
  const includeNodePty = parseBoolEnv('INCLUDE_NODE_PTY', true);
  if (!includeNodePty) {
    try {
      console.log('INCLUDE_NODE_PTY=0 detected — pruning optional dependencies...');
      execSync('npm prune --omit=optional', { stdio: 'inherit', cwd: __dirname });
      console.log('Optional dependencies pruned successfully.');
    } catch (e) {
      console.warn('Warning: Failed to prune optional dependencies:', e?.message || e);
    }
  }
} catch (error) {
  console.error('Error updating version:', error.message);
  process.exit(1);
}

// 7. Create sanitized staging copy of frontend for Electron packaging
try {
  // Clean stage directory
  try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(stageRoot, { recursive: true });

  const skipRelative = new Set([
    // Skip version.js symlink - we'll write a real file
    path.posix.join('public', 'version.js'),
  ]);

  const isDotOrNodeModules = (name) => name === 'node_modules' || name.startsWith('.');

  const toPosixRel = (abs) => {
    const rel = path.relative(frontendRoot, abs);
    return rel.split(path.sep).join('/');
  };

  function copyDir(srcDir, dstDir) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const ent of entries) {
      if (isDotOrNodeModules(ent.name)) continue;
      const srcPath = path.join(srcDir, ent.name);
      const dstPath = path.join(dstDir, ent.name);
      const relPosix = toPosixRel(srcPath);
      if (skipRelative.has(relPosix)) {
        continue;
      }
      let st;
      try {
        st = fs.lstatSync(srcPath);
      } catch (e) {
        console.warn(`Warning: skipping ${relPosix}: ${e?.message || e}`);
        continue;
      }
      if (st.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        copyDir(srcPath, dstPath);
      } else if (st.isSymbolicLink()) {
        try {
          const target = fs.readlinkSync(srcPath);
          const resolved = path.resolve(path.dirname(srcPath), target);
          try {
            const st2 = fs.statSync(resolved);
            if (st2.isDirectory()) {
              fs.mkdirSync(dstPath, { recursive: true });
              copyDir(resolved, dstPath);
            } else {
              fs.mkdirSync(path.dirname(dstPath), { recursive: true });
              fs.copyFileSync(resolved, dstPath);
            }
          } catch (e2) {
            console.warn(`Warning: skipping symlink ${relPosix} -> ${target}: ${e2?.message || e2}`);
          }
        } catch (e1) {
          console.warn(`Warning: skipping unreadable symlink ${relPosix}: ${e1?.message || e1}`);
        }
      } else if (st.isFile()) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }

  copyDir(frontendRoot, stageRoot);

  // Read current build info for staged version.js
  let version, build, commit;
  try {
    delete require.cache[require.resolve(buildInfoPath)];
    const buildInfo = require(buildInfoPath);
    version = buildInfo.version;
    build = buildInfo.build;
    commit = buildInfo.commit;
  } catch (e) {
    version = fs.readFileSync(versionFilePath, 'utf8').trim();
    build = 0;
    commit = null;
  }

  // Write version.js into the staged public directory
  const stagedVersionPath = path.join(stageRoot, 'public', 'version.js');
  const stagedVersionContent = `// AUTO-GENERATED FILE - DO NOT EDIT
// Source: VERSION (${version}), Build ${build}${commit ? `, Commit ${commit}` : ''}
(function(root) {
  'use strict';
  var TS_VERSION = '${version}';
  var TS_BUILD = ${build};
  var TS_COMMIT = ${commit ? `'${commit}'` : 'null'};
  try {
    root.TS_FRONTEND_VERSION = TS_VERSION;
    root.TS_FRONTEND_BUILD = TS_BUILD;
    root.TS_FRONTEND_COMMIT = TS_COMMIT;
  } catch (_) {}
  if (typeof module !== 'undefined') {
    try { module.exports = { version: TS_VERSION, build: TS_BUILD, commit: TS_COMMIT }; } catch (_) {}
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
`;
  fs.mkdirSync(path.dirname(stagedVersionPath), { recursive: true });
  fs.writeFileSync(stagedVersionPath, stagedVersionContent, 'utf8');

  console.log(`Prepared sanitized frontend staging directory: ${path.relative(__dirname, stageRoot)}`);
} catch (stageErr) {
  console.warn('Warning: Failed to prepare frontend staging directory:', stageErr?.message || stageErr);
}
