## Implementation Details

### Summary
Treat identity (users and groups) as runtime state by moving `users.json` and `groups.json` into the backend data directory, adding automatic migration from the config directory, and creating a safe default admin user/group when no files exist, while ensuring all watchers and password reset logic operate only on the state files.

### Files Created/Modified
- `backend/config-loader.js` - Exported `USERS_STATE_FILE` and `GROUPS_STATE_FILE` pointing at `config.DATA_DIR/users.json` and `config.DATA_DIR/groups.json` as the canonical identity state files.
- `backend/utils/json-config-cache.js` - Extended `JsonConfigCache` to accept an explicit `filePath`, added `ensureIdentityStateFile` to bootstrap/migrate identity state, and wired `usersConfigCache`/`groupsConfigCache` to watch the DATA_DIR state files instead of the config directory.
- `backend/middleware/auth.js` - Kept all user/group lookups routed through the shared caches and updated logging to reflect the new state-based users file.
- `backend/routes/users.js` - Updated the password reset route to persist changes to `USERS_STATE_FILE` (DATA_DIR/users.json) and reload the cache after writes.
- `backend/README.md` - Documented that users/groups are now read from runtime state files under the backend data directory rather than `backend/config/users.json` / `backend/config/groups.json`.
- `doc/authentication.md` - Updated the authentication docs to describe credentials living in the backend data `users.json` and Basic Auth verification against that runtime file.
- `doc/backend-api.md` - Clarified that `/api/user/reset-password` verifies and updates credentials in the backend data directory `users.json`.
- `desktop/INSTALL.md` / `desktop/README.md` - Updated desktop configuration docs so TERMSTATION_CONFIG_DIR only needs `config.json`, `templates.json`, and `links.json`, with users/groups described as runtime state in the backend data directory.
- `shared/version.js` (and symlinked `VERSION`) - Bumped `TS_VERSION` to `1145` for this issue.

### Implementation Features
- Identity state files in DATA_DIR:
  - Introduced `USERS_STATE_FILE` and `GROUPS_STATE_FILE` under `config.DATA_DIR` as the single source of truth for users and groups.
  - All identity reads/writes (via `usersConfigCache`/`groupsConfigCache` and the password reset route) now point only at these state files.
- One-time migration and safe bootstrapping:
  - Added `ensureIdentityStateFile(kind, stateFile, configFile)` in `backend/utils/json-config-cache.js` to run at module load before cache initialization.
  - Logic per file (users and groups):
    - If the state file exists and the config file also exists, the state file is used and a warning is logged that the config file is ignored.
    - If only the config file exists, it is copied once into the DATA_DIR location and an info log records the migration.
    - If neither exists, a default state file is created:
      - `groups.json`: a single `admins` group with `permissions: "*"`, `features: "*"`.
      - `users.json`: an `admin` user in the `admins` group with no `password_hash`, so login is impossible until an explicit hash is configured.
- Watcher and reload behavior:
  - Extended `JsonConfigCache` to accept an explicit `filePath` so `usersConfigCache` and `groupsConfigCache` can watch `USERS_STATE_FILE` / `GROUPS_STATE_FILE` directly.
  - `fs.watch` and mtime-based reloads now operate only on the DATA_DIR state files; config-directory users/groups files are not watched or re-read after bootstrap.
  - Existing templates/links caches continue to use `resolveConfigPath` as before.
- Password reset integration:
  - The `/api/user/reset-password` route still verifies credentials via `usersConfigCache`, but now persists the updated user record to `USERS_STATE_FILE` in DATA_DIR.
  - After writing, the route calls `usersConfigCache.reloadNow()` to ensure subsequent requests see the new password hash and cleared `prompt_for_reset` flag.
- Documentation alignment:
  - Backend, authentication, API, and desktop docs now consistently describe users/groups as runtime state in the backend data directory, and no longer treat `backend/config/users.json` / `backend/config/groups.json` as authoritative identity config.

### Testing Completed
- [x] `cd backend && npm test` (currently fails in this environment due to a missing `yaml` dependency pulled by `container-bootstrap-builder.js`; failure occurs before exercising the identity state logic).
- [x] Static inspection of auth, template-access, and session-related code paths using `usersConfigCache`/`groupsConfigCache` to confirm they all resolve through the DATA_DIR state files.
- [x] Verified migration scenarios by reasoning and grep:
  - State-only present → used as-is, watcher monitors state file.
  - Config-only present → copied once into DATA_DIR, then state becomes canonical.
  - Both present → state used, warning logged about ignoring config.
  - Neither present → default admin group/user created with no usable password hash.

### Status
✅ Implementation complete and ready for code review

