## Implementation Details

### Summary
Improve profile switching so changing profiles no longer logs out or clears cookies for the previously active instance, enabling seamless switching across distinct hostnames that already have saved sessions.

### Files Created/Modified
- `frontend/public/js/core/auth-orchestrator.js` - Removed proactive logout and cookie clearing from `switchProfile` so switching profiles does not invalidate existing sessions; kept cookie restore and reload flow intact.
- `shared/version.js` - Bumped `TS_VERSION` to `1142` for this issue.

### Implementation Features
- Profile switching now preserves existing login state for other instances rather than calling `/api/auth/logout` and clearing Electron/browser cookies for the current origin.
- Still restores cookies for the selected profile and refreshes configuration/base URL before reloading the app, so instances with saved cookies should open without re‑auth prompts.
- Logout behavior for the explicit Logout action remains unchanged and still clears cookies and session state.

### Testing Completed
- [x] `npm install` in `frontend` and `backend` (no additional deps required for this change)
- [x] Attempted `npm test` in `frontend` (no test script defined)
- [x] Attempted `npm test` in `backend` (fails early due to missing `backend/config.json`, unrelated to this change)
- [x] Static code inspection of `switchProfile` and related auth flows (`login`, `logout`, `startInitialFlow`) to ensure no dangling references after reverting the proactive logout block.

### Status
✅ Implementation complete and ready for code review
