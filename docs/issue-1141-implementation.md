## Implementation Details

### Summary
Introduce a shared, watcher-backed JSON config cache for templates/users/groups/links and an admin-only reload API, with a Settings UI control to trigger reloads, reducing per-request JSON parsing and centralizing config reload behavior.

### Files Created/Modified
- `backend/utils/json-config-cache.js` - New shared `JsonConfigCache` helper with fs.watch + debounced reload, mtime-based safety checks, and exported caches for `templates.json`, `users.json`, `groups.json`, and `links.json`.
- `backend/template-loader.js` - Refactored to read templates via `templatesConfigCache` instead of direct fs/watch logic; added cache-version tracking, lazy refresh on access, and updated user-parameter options to use cached users/groups.
- `backend/middleware/auth.js` - Centralized user/group loading through `usersConfigCache`/`groupsConfigCache` for token, cookie, and basic auth; kept startup logging via `loadUsers()`; wired `reloadUsers()` to refresh caches; updated `appUserExists` to use the cache.
- `backend/utils/template-access.js` - Updated template RBAC resolution to use cached users/groups, preserving existing allow/deny semantics.
- `backend/routes/sessions.js` - Updated per-user and per-group session limit enforcement to use cached users/groups instead of re-reading JSON on each request.
- `backend/server.js` - Updated WebSocket permission resolution helper to use cached users/groups.
- `backend/links-loader.js` - Switched to `linksConfigCache` for loading `links.json` while preserving the existing `{ groups: [...] }` response shape.
- `backend/routes/system.js` - Added `POST /api/system/reload-config` endpoint gated by feature flag `config_reload_enabled`, calling `templateLoader.reloadTemplates()` and `reloadNow()` on users/groups/links caches, returning a summary payload and logging outcomes.
- `backend/constants/access-keys.js` - Added feature flag key `config_reload_enabled` to `FEATURE_DEFAULTS`.
- `frontend/public/js/services/api.service.js` - Added `reloadServerConfig()` method mirroring `resetSessionToken()` behavior with friendly handling of `403`/feature-disabled responses.
- `frontend/public/js/modules/settings/settings-manager.js` - Wired a new admin control for reloading server config, including DOM refs, click handler, notifications, and feature-gated visibility via `features.config_reload_enabled`.
- `frontend/public/index.html` - Added an "Reload Server Config" button and form group in the Admin section alongside "Reset Session Token".
- `doc/backend-api.md` - Documented the new `POST /api/system/reload-config` endpoint in the System API section.
- `backend/README.md` - Documented the new `config_reload_enabled` feature flag behavior.
- `shared/version.js` - Bumped `TS_VERSION` to `1141` for this issue.

### Implementation Features
- Shared JSON config cache:
  - Resolves config paths via `resolveConfigPath(name)` and maintains in-memory `value`, `lastMtime`, `lastReloadTime`, and a monotonically increasing `version`.
  - Uses `fs.watch` with a debounce window plus mtime-based fallbacks to catch editor/overlay changes without hammering disk.
  - Preserves last-known-good values on read/parse errors and logs failures without clearing caches.
- Template loader integration:
  - Rebuilds internal template maps from cached `templates.json` when the cache version changes, instead of managing its own watcher.
  - Keeps inheritance, overlay, and reserved parameter-name validation logic unchanged.
  - Retains prior "keep last good templates on error" semantics.
- Users/groups/links integration:
  - All major call sites (auth middleware, template RBAC, session limit logic, WebSocket permission resolution, user-driven parameter options, and links API) now use the shared caches instead of per-request `loadJson(...)` calls.
  - `reloadUsers()` now forces a cache reload for users/groups before rebuilding the auth module's in-memory arrays.
- Admin reload API + UI:
  - New endpoint `POST /api/system/reload-config` requires `features.config_reload_enabled === true` on the authenticated user; otherwise returns `403 { error: 'FEATURE_DISABLED', ... }`.
  - On success, triggers template/user/group/link reloads, aggregates counts and any reload errors, logs the attempt and outcome, and returns a structured summary `{ ok, templates, users, groups, links, errors }`.
  - A new Settings > Admin control uses `apiService.reloadServerConfig()` with a confirmation dialog and success/error notifications mirroring the Reset Session Token UX.

### Testing Completed
- [x] `npm install` in `backend` (installs `yaml` and other dependencies)
- [x] `npm install` in `frontend` (no additional dependencies required)
- [x] Attempted `npm test` in `backend` — fails due to missing `backend/config.json` (configuration file not present in this environment); failure occurs in `config-loader` before reaching code changed in this issue.
- [x] Attempted `npm test` in `frontend` — fails with "Missing script: test" since no test script is defined in `frontend/package.json`.
- [x] Manual reasoning / static inspection of affected modules for integration points (auth paths, template RBAC, session limits, links API, and Settings UI wiring), ensuring cache usage is consistent and feature gating is applied only to the reload endpoint/UI.

### Status
✅ Implementation complete and ready for code review
