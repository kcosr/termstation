#!/usr/bin/env node

/**
 * bump-version.js
 *
 * Updates the VERSION file with a new semantic version.
 *
 * Usage:
 *   node scripts/bump-version.js patch     # 1.0.0 → 1.0.1
 *   node scripts/bump-version.js minor     # 1.0.1 → 1.1.0
 *   node scripts/bump-version.js major     # 1.1.0 → 2.0.0
 *   node scripts/bump-version.js 2.0.0     # Set to specific version
 *   node scripts/bump-version.js           # Show current version
 *
 * After updating VERSION, run `node scripts/gen-build-info.mjs` to regenerate
 * build info, or run a desktop build which does this automatically.
 */

const fs = require('fs');
const path = require('path');

const versionFilePath = path.join(__dirname, '..', 'VERSION');

function readVersion() {
  try {
    return fs.readFileSync(versionFilePath, 'utf8').trim();
  } catch (e) {
    return '0.0.0';
  }
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) {
    return null;
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    suffix: match[4] || ''
  };
}

function formatVersion(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}${parts.suffix}`;
}

const currentVersion = readVersion();
const arg = process.argv[2];

if (!arg) {
  // No argument: show current version
  console.log(`Current version: ${currentVersion}`);
  process.exit(0);
}

const parts = parseVersion(currentVersion);
if (!parts) {
  console.error(`Current VERSION "${currentVersion}" is not valid semver (X.Y.Z)`);
  process.exit(1);
}

let newVersion;

switch (arg.toLowerCase()) {
  case 'patch':
    parts.patch++;
    parts.suffix = '';
    newVersion = formatVersion(parts);
    break;

  case 'minor':
    parts.minor++;
    parts.patch = 0;
    parts.suffix = '';
    newVersion = formatVersion(parts);
    break;

  case 'major':
    parts.major++;
    parts.minor = 0;
    parts.patch = 0;
    parts.suffix = '';
    newVersion = formatVersion(parts);
    break;

  default:
    // Assume it's a specific version
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg)) {
      console.error(`Invalid version: "${arg}". Use patch, minor, major, or a semver like 1.2.3`);
      process.exit(1);
    }
    newVersion = arg;
}

// Write new version
fs.writeFileSync(versionFilePath, `${newVersion}\n`, 'utf8');
console.log(`Version updated: ${currentVersion} → ${newVersion}`);
console.log('\nTo regenerate build info and sync all files, run:');
console.log('  node scripts/gen-build-info.mjs');
console.log('  # or for desktop builds: cd desktop && npm run build');
