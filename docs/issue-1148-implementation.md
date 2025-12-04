## Implementation Details

### Summary
Repurposed the Cmd/Alt + Shift + P keyboard shortcut to switch to the previously active profile and removed the pin/unpin keyboard binding. UI-based pin/unpin remains unchanged.

### Files Created/Modified
- `frontend/public/js/utils/profile-manager.js` - Tracked `previousId` when switching active profiles; added `getPreviousId()`.
- `frontend/public/js/modules/user/profile-shortcuts.js` - New module registering global shortcut for switching to the previous profile.
- `frontend/public/js/core/app.js` - Initialized profile shortcuts during app startup.
- `frontend/public/js/modules/terminal/manager.js` - Removed the `Cmd/Alt + Shift + P` pin toggle shortcut registration.
- `doc/keyboard_shortcuts.md` - Updated documentation to reflect the new behavior.
- `shared/version.js` (and symlinked `VERSION`) - Bumped `TS_VERSION` to `1148`.

### Implementation Features
- Persisted `authProfiles.previousId` on `setActive()` to enable rapid toggling between the last two used profiles. Persistence works across reloads in both browser and Electron.
- Registered a global shortcut via `keyboard-shortcuts` that triggers `authOrchestrator.switchProfile(previousId)` when a previous profile exists and differs from the current one.
- Shortcut uses `Shift+Meta+code:KeyP` (macOS) and `Shift+Alt+code:KeyP` (Windows/Linux), respects global modal suppression, and ignores text inputs.
- Removed the TerminalManager pin shortcut registration; click-based pin/unpin flows remain intact.

### Testing Completed
- [x] Verified `previousId` persistence logic in `profileManager.setActive()` and retrieval via `getPreviousId()`.
- [x] Confirmed global shortcut registration uses the shared registry and is suppressed when modals are open.
- [x] Ensured removal of the legacy pin shortcut registration from `TerminalManager`.
- [x] Reviewed documentation updates for consistency.

### Status
✅ Implementation complete and ready for code review

