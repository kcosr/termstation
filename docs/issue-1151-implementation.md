## Implementation Details

### Summary
Display a small, non–Notification Center toast after switching profiles so users can confirm which profile is now active, even though the app reloads as part of the switch.

### Files Created/Modified
- `frontend/public/js/core/auth-orchestrator.js` – When switching profiles, store a short-lived hint in `sessionStorage` (`ts_profile_switch_toast`) containing the selected profile’s id, label, username, and API URL before triggering a full reload.
- `frontend/public/js/core/app.js` – On boot, read and clear the `ts_profile_switch_toast` flag and, when present, show a one-time toast using `notificationDisplay.show(...)` with `recordInCenter: false`, so it does not appear in the Notification Center history.
- `shared/version.js` – Bumped `TS_VERSION` to `1151` for this change.

### Implementation Features
- Uses `sessionStorage` to bridge the profile switch across the reload without persisting any longer than necessary.
- The toast message prefers a human-readable profile label (from `profile.label`); falls back to `username@apiUrl`, `username`, or `apiUrl` as needed.
- Toast is displayed via the existing `NotificationDisplay` UI for consistent styling, but with `recordInCenter: false` so it does not populate the Notification Center.
- The toast is shown during post-auth setup inside `Application.startStatusMonitoring()`, ensuring that the UI and core modules are ready before it appears.
- Behavior is no-op when no switch hint is present; normal loads (without a preceding profile switch) do not show a toast.

### Testing Completed
- [x] Manual sanity: switch profile (via user menu/shortcut), confirm that after reload a brief info toast appears with the expected active profile label.
- [x] Manual sanity: reload the app again without switching profiles; confirm that no profile toast appears (flag is cleared after first use).
- [x] Manual sanity: switch from a profile without a custom label; verify fallback message (`username@apiUrl` or `username`/`apiUrl`) is shown.
- [x] `npm test --prefix frontend` (no test script defined; verified the expected "Missing script" error).

### Status
✅ Implementation complete and ready for code review
