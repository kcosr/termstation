## Summary

Introduce a shared, watcher-backed config cache for JSON configuration files (`templates.json`, `users.json`, `groups.json`, `links.json`) and an administrator-only reload API, with a corresponding control in the frontend Settings UI similar to the existing "Reset Session Token" feature.

## Motivation

Today configuration is reloaded via a mix of mechanisms:

- `templates.json` is handled by `TemplateLoader`, which uses `fs.watch` plus `checkAndReloadIfNeeded()` to reload templates when the file changes.
- `links.json` is read on-demand in `LinksLoader.getLinks()` for each `/api/links` call.
- `users.json` and `groups.json` are read in multiple places: authentication middleware, template parameter `options_source: "user"`, template access RBAC (`resolveAllowedTemplatesForUser`), session routes, and server-level permission helpers. Some of these paths now re-read the files on each request for correctness.

This ensures config changes are picked up, but it:

- Spreads JSON loading logic across multiple modules.
- Adds per-request overhead where `loadJson(...)` is called frequently.
- Provides no unified mechanism to manually force a reload if watchers miss events (e.g., editor rename patterns, container overlays).
- Leads to inconsistent patterns for users/groups handling across auth, WebSocket permission resolution, and template RBAC.

## Goals / Requirements

1. **Centralize config file loading for JSON configs**
   - Introduce a shared helper for `templates.json`, `users.json`, `groups.json`, and `links.json` that:
     - Tracks the resolved file path via `resolveConfigPath(name)`.
     - Maintains an in-memory cache of the parsed value and last-known mtime.
     - Uses `fs.watch` to detect changes and debounced reload (similar to the existing `TemplateLoader` behavior).
     - Keeps the last-known-good parsed value if reload fails (syntax error, transient read error), logging failures without wiping the cache.

2. **Reduce per-request overhead while keeping runtime-dynamic behavior**
   - Callers (auth middleware, template parameter options, template access RBAC, links API, WebSocket permission resolution, etc.) should use cached values instead of re-parsing JSON on each request.
   - Config changes to `users.json`, `groups.json`, `links.json`, and `templates.json` should still be visible to new requests shortly after edit via watcher-driven reload, with a minimal mtime fallback as a safety net.

3. **Admin-only reload API**
   - Add a backend endpoint (e.g. `POST /api/system/reload-config`) that:
     - Is only accessible to administrators or explicitly authorized users.
     - Triggers a manual reload of all relevant caches:
       - Templates: `templateLoader.reloadTemplates()`.
       - Users/groups: force re-read of `users.json` and `groups.json` into their shared cache.
       - Links: force re-read of `links.json` into its cache.
     - Returns a JSON payload summarizing what was reloaded and any errors (e.g., counts of templates/users/groups/link groups, or error details if a file reload failed but last-known-good was preserved).

4. **Frontend Settings UI integration**
   - Add a new admin-facing control in the Settings UI, modeled on the existing **Reset Session Token** feature:
     - **Backend**
       - Gate access via a feature or permission flag (e.g. `config_reload_enabled`) so only administrators or explicitly authorized users see and can invoke it.
       - Define the flag in `backend/constants/access-keys.js` similarly to `cookie_token_reset_enabled` / existing permission keys.
     - **Frontend**
       - Add a new `apiService` method (e.g. `reloadServerConfig()`) that POSTs to `/api/system/reload-config` and handles `403` / feature-disabled responses in a user-friendly way.
       - Extend `settings-manager.js` to:
         - Declare references to the new button/group elements (mirroring `reset-session-token-btn` / `reset-session-token-group`).
         - Wire a click handler that confirms with the user (e.g., "Reload server templates/users/groups/links from disk?"), calls `apiService.reloadServerConfig()`, and surfaces success/failure via `notificationDisplay`.
         - Update `refreshFeatureFlags` / `updateFeatureGatedControls` to show/hide the group based on the new feature flag.
       - Update `frontend/public/index.html` to add the form group next to the existing Reset Session Token control.

5. **Security and safety**
   - Ensure the reload endpoint requires authentication and a strong permission/feature check:
     - Only users with a specific `permissions` key or `features.config_reload_enabled === true` may invoke it.
   - Log all reload attempts and outcomes with enough context (username, which files were reloaded, errors) to audit changes.
   - Preserve last-known-good config on parse failures, and clearly log when new config is rejected so operators are not surprised.

6. **Compatibility and migration**
   - Keep the public API shapes unchanged:
     - `GET /api/links` continues to return `{ groups: [...] }`.
     - Template parameter options endpoints continue to return `{ options: [...] }`.
     - Auth behavior and permissions resolution semantics remain the same; only the loading mechanism is centralized.
   - Make sure existing watchers (for `templates.json`) are either:
     - Reimplemented using the new helper, or
     - Cleanly integrated with it (no double-watching or conflicting reload logic).

7. **Refactors from MR !853 review**
   - Extract the current auth-specific `loadUsersAndGroups` logic in `backend/middleware/auth.js` into a shared utility that can be reused by:
     - Auth middleware (all paths).
     - WebSocket permission resolution helper in `backend/server.js`.
     - Template-access helpers and any other `users.json` / `groups.json` consumers that we migrate to the shared cache.
   - Refactor the `AUTH_DISABLED` path in auth middleware to reuse `resolveUserProfile()` (or an equivalent helper) instead of duplicating group/feature/permission merge logic inline.
   - Unify the WebSocket permission resolution pattern in `backend/server.js` so it uses the same shared users/groups loader and permission resolution flow as the main auth middleware.

## Proposed Design

### 1) Shared JSON config cache helper

Add a small utility module, e.g. `backend/utils/json-config-cache.js`:

- Responsibilities:
  - Construct with a logical name (e.g. `'users.json'`) and an optional default value factory.
  - Resolve path via `resolveConfigPath(name)` on initialization.
  - Load the file once at startup with `loadJsonAt` and store `value` and `lastMtime`.
  - Set up `fs.watch` on that file path with debouncing (e.g. 300–500 ms) to handle editors that write multiple times.
  - On change:
    - Re-stat to confirm mtime changed.
    - Attempt to re-parse JSON.
    - On success: update `value` and `lastMtime`, log summary.
    - On failure: log error and retain previous `value` and `lastMtime`.
- Public API:
  - `get()` → returns current cached value (never throws; returns default or empty on failure).
  - `reloadNow()` → performs a synchronous reload (used by the admin API), with the same success/failure semantics.
  - `cleanup()` → closes the watcher and clears any timers (used in tests/shutdown).

### 2) Apply cache helper to specific configs

**Templates (`templates.json`)**

- Refactor `TemplateLoader` to use the shared helper rather than hand-rolled watcher logic:
  - Either subscribe to a cache for `templates.json` and rebuild internal `Map`s when the cache reloads, or embed the helper internally so watcher/debounce behavior is shared.
- Preserve:
  - The `checkAndReloadIfNeeded()` behavior as a safety net (mtime check).
  - The "keep last good config on error" semantics.

**Users/Groups (`users.json`, `groups.json`)**

- Introduce caches for both files using the helper.
- Update call sites to use `get()` instead of `loadJson(...)`:
  - `backend/middleware/auth.js`:
    - Token-based auth (session owner resolution).
    - Cookie auth (session cookie verification path).
    - Basic auth credential checking.
    - Helper like `appUserExists`.
  - `backend/utils/template-access.js`:
    - `resolveAllowedTemplatesForUser` should use cached users and groups when computing allowed template IDs.
  - `backend/routes/sessions.js` and `backend/server.js` helper that resolves permissions from users/groups.
- Keep the startup `loadUsers()` logging path, but ensure future lookups go through the shared cache so they benefit from watcher-based reloads.

**Links (`links.json`)**

- Wrap `LinksLoader` around a `links.json` cache:
  - On `getLinks()`, read the cached JSON and then normalize/validate into the current `{ groups: [...] }` shape.
  - This removes per-request JSON parsing while still reacting to file changes.

### 3) Admin-only reload API

- Add a new route in `backend/routes/system.js`, e.g. `POST /api/system/reload-config`.
- Behavior:
  - Requires authentication (`req.user` present) and an admin-like flag:
    - Either a new permission key (e.g. `permissions.config_reload`) or a feature flag (e.g. `features.config_reload_enabled`).
    - Return 403 with a consistent error shape when not permitted (similar to `/api/auth/reset-token`).
  - On success:
    - Call `templateLoader.reloadTemplates()`.
    - Call `reloadNow()` on `users`, `groups`, and `links` caches.
    - Aggregate results into a response payload, e.g.:
      - `{ ok: true, templates: { count }, users: { count }, groups: { count }, links: { groups: n }, errors: [...] }`.
  - Log an info-level entry summarizing the caller and outcome, and error-level details when reload fails for any file.

### 4) Frontend Settings integration

**Backend feature/permission key**

- Extend `backend/constants/access-keys.js` to add a new key (e.g. `config_reload_enabled`) in the appropriate section (feature flag or permission), defaulting to `false`.
- Ensure it flows into the resolved `features` / `permissions` objects in auth so `GET /api/me` exposes it.

**`api.service.js`**

- Add `reloadServerConfig()` mirroring `resetSessionToken()`:
  - `POST /api/system/reload-config`.
  - On `403`, throw an error with `status: 403` / `code: 'FEATURE_DISABLED'` for clean UI handling.

**`settings-manager.js`**

- Extend `elements` to include:
  - `reloadConfigBtn: document.getElementById('reload-config-btn')`.
  - `reloadConfigGroup: document.getElementById('reload-config-group')`.
- In the initialization block:
  - Add a click handler with a confirmation dialog (e.g. "Reload server config from disk?"), then call `apiService.reloadServerConfig()` and show a success notification.
  - Handle errors by differentiating between feature-disabled vs generic failure.
- In `updateFeatureGatedControls(features)`, show/hide the group based on `features.config_reload_enabled`.

**`frontend/public/index.html`**

- Add a new form group in the Settings modal, visually grouped near the **Reset Session Token** control, with clear text (e.g. "Reload Server Config").

### 5) Testing considerations

**Backend**

- Unit/integration tests for the cache helper:
  - Initial load and error handling (missing file, invalid JSON).
  - Watcher-triggered reload and debouncing (may need to simulate writes).
  - `reloadNow()` behavior and return values.
- Tests for the admin reload API:
  - 401/403 when unauthenticated or missing the feature/permission.
  - Successful reload with a mocked `json-config-cache`.
- Regression tests to ensure template RBAC, auth, and template parameter options still behave correctly when config changes between calls.

**Frontend**

- Basic UI tests (manual or automated) to ensure:
  - The new control only appears when the feature flag is set.
  - Success and error notifications behave as expected.

## Out of Scope

- Changing the structure or schema of existing JSON config files.
- Adding new config files beyond `templates.json`, `users.json`, `groups.json`, and `links.json`.
- Introducing cross-node coordination for config reload in multi-instance deployments (this issue focuses on per-process caching and reload only).

