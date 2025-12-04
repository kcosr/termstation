# Versioning

This document describes how versioning works in TermStation.

## Overview

TermStation uses a two-component versioning system:

| Component | Example | Source | Purpose |
|-----------|---------|--------|---------|
| **Version** | `1.0.0` | `VERSION` file | Semantic version for releases |
| **Build** | `124` | Git commit count | Unique build identifier |

## Files

### Source of Truth

- **`VERSION`** - Contains the semantic version (e.g., `1.0.0`). Updated manually when releasing.

### Generated Files (Do Not Edit)

- **`shared/build-info.generated.mjs`** - ESM module with version, build, commit
- **`shared/build-info.generated.cjs`** - CommonJS module (same content)
- **`frontend/public/version.js`** - Browser version file

## How It Works

### Build Number

The build number is computed automatically from the git commit count:

```bash
git rev-list --count HEAD  # e.g., 124
```

- Increases with every commit
- No file to maintain
- Deterministic: same commit = same build number

### Build Number Fallback

For CI or non-git environments, set an environment variable:

```bash
TS_BUILD_NUMBER=500 node scripts/gen-build-info.mjs
# or
BUILD_NUMBER=500 node scripts/gen-build-info.mjs
```

Resolution order:
1. `TS_BUILD_NUMBER` env var
2. `BUILD_NUMBER` env var
3. `git rev-list --count HEAD`
4. Default to `0` with warning

## Usage

### Check Current Version

```bash
node scripts/bump-version.js
# Output: Current version: 1.0.0
```

### Generate Build Info

```bash
node scripts/gen-build-info.mjs
# Output: Generating build info: v1.0.0 (build 124, abc1234)
```

### Bump Version (for releases)

```bash
# Patch release (bug fixes): 1.0.0 → 1.0.1
node scripts/bump-version.js patch

# Minor release (new features): 1.0.1 → 1.1.0
node scripts/bump-version.js minor

# Major release (breaking changes): 1.1.0 → 2.0.0
node scripts/bump-version.js major

# Set specific version
node scripts/bump-version.js 2.0.0
```

### Desktop Build

Desktop builds automatically regenerate build info:

```bash
cd desktop
npm run build  # Runs update-version.js which calls gen-build-info.mjs
```

## Where Versions Appear

### Backend API

`GET /api/info` returns:

```json
{
  "version": "1.0.0",
  "build": 124,
  "commit": "abc1234",
  ...
}
```

### Frontend UI

The profile menu shows `v1.0.0` with a tooltip: `Build 124 (abc1234)`

### Desktop App

- Window title / About dialog shows version from `package.json`
- Internal version from Electron's `app.getVersion()`

### App Stores

| Platform | Version | Build Code |
|----------|---------|------------|
| Google Play | `versionName: "1.0.0"` | `versionCode: 124` |
| Apple App Store | `CFBundleShortVersionString: "1.0.0"` | `CFBundleVersion: 124` |

## Release Workflow

### Day-to-Day Development

No manual steps needed. Build number increments automatically with each commit.

### Creating a Release

1. **Update VERSION** (only when releasing):
   ```bash
   node scripts/bump-version.js minor  # or patch/major
   ```

2. **Commit and tag**:
   ```bash
   git add VERSION
   git commit -m "Release v1.1.0"
   git tag v1.1.0
   git push && git push --tags
   ```

3. **Build for distribution**:
   ```bash
   cd desktop && npm run build
   cd ../mobile && npm run android:build:release
   ```

## Policies

### Required for App Store Releases

- **All store builds must be from `main` branch** - Ensures monotonically increasing build numbers
- **No history rewrites on `main`** - Force-push would break build number sequence
- **Hotfixes merge forward** - Fix on branch, merge to main, build from main

### Why These Policies?

App stores require build numbers to always increase. If you force-push `main` and reduce the commit count, your next build would have a lower build number than a previously submitted build, which app stores reject.

If you need to override the build number (e.g., after an accidental force-push):

```bash
TS_BUILD_NUMBER=500 npm run build
```

## Development Notes

### Dev-Time Build Numbers

If you run the backend without first generating build info, `/api/info` will report `build: 0` and `commit: null`. This is expected behavior for development.

To get accurate build metadata in development:
```bash
node scripts/gen-build-info.mjs
```

Or add it to your workflow (e.g., in a prestart script).

### Backend Without Desktop Build

The backend reads from `shared/build-info.generated.cjs` if available, otherwise falls back to reading `VERSION` directly with `build=0`. For production deployments without the desktop build process, run `gen-build-info.mjs` as part of your deployment.

## Verification

Check if VERSION matches the current git tag (useful in CI):

```bash
node scripts/gen-build-info.mjs --check
# Exit code 0 if tag matches, 1 if mismatch
```
