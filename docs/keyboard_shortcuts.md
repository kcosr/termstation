# termstation - Keyboard Shortcuts

This document provides a comprehensive guide to all keyboard shortcuts available in the termstation application.

## Shortcut Architecture

All global shortcuts are now registered through a central registry implemented in `frontend/public/js/modules/shortcuts/keyboard-shortcuts.js`. Feature modules (terminal manager, session tabs, tab manager, notes controllers, etc.) subscribe by calling `keyboardShortcuts.registerShortcut(...)` and provide their key combinations, enable/disable predicates, and scope requirements. The registry attaches a single capturing `keydown` listener, prevents conflicts by ordering shortcuts by priority, and applies shared guardrails (modal detection, focused-input filtering) so individual modules no longer reach into `document.addEventListener('keydown', …)` directly.

When adding a new shortcut:

- Register it through the keyboard-shortcuts module with a unique `id`.
- Supply a `when` predicate that enforces contextual enablement (active tab, modal visibility, etc.).
- Prefer `code:` descriptors (for example `Shift+Meta+code:KeyT`) so the shortcut works across layouts.
- Keep the documentation below in sync with any new or changed combinations.

## Global Shortcuts

Most global shortcuts use **Command + Shift** (Mac) or **Alt + Shift** (Windows/Linux). Some navigation shortcuts use **Command/Alt** without Shift as noted below.

### Session Management

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + Shift + T` | Create new session | Opens the new session modal |
| `Cmd/Alt + Shift + C` | Copy workspace path | Copies the workspace path for the active session when available (container/directory isolation) |
| `Cmd/Alt + Shift + R` | Rename active session | Temporarily disabled (rename modal intentionally offline) |
| `Cmd/Alt + Shift + K` | Terminate active session | Terminates the currently selected active session |
| `Cmd/Alt + Shift + P` | Switch to previous profile | Switches to the previously active profile when available |
| `Cmd/Alt + Shift + X` | Remove session completely | Detach if attached, terminate if active, then close the terminated session (no confirmation) |
| `Cmd/Alt + Shift + Z` | Clear ended sessions | Removes all terminated sessions from the sidebar/UI (without deleting server history), matching the “Clear ended sessions” header button |
| `Cmd/Alt + Shift + W` | Move session to workspace | Opens a modal to move the active session; supports adding a new workspace |
| `Cmd/Alt + Shift + O` | Login to container | Logs into the container for the active session (container isolation only; requires `sandbox_login` permission) |

### Session Navigation (With Shift)

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + Shift + ←` | Navigate to previous session | Moves to the previous session in the current tab |
| `Cmd/Alt + Shift + →` | Navigate to next session | Moves to the next session in the current tab |
| `Cmd/Alt + Shift + ↑` | Navigate to previous workspace | Moves to the previous workspace in the list |
| `Cmd/Alt + Shift + ↓` | Navigate to next workspace | Moves to the next workspace in the list |
| `Cmd/Alt + Shift + {` | Navigate to previous workspace | Alternative shortcut using bracket keys |
| `Cmd/Alt + Shift + }` | Navigate to next workspace | Alternative shortcut using bracket keys |
| `Cmd/Alt + Shift + B` | Back to latest session | Switches to the most recently created session, including workspace switch if needed |
| `Cmd/Alt + Shift + 9` | Switch to Active sessions tab | Shows only active/running sessions |
| `Cmd/Alt + Shift + 0` | Switch to Inactive sessions tab | Shows only inactive/terminated sessions |

### Tab Navigation (Without Shift)

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + ←` | Navigate to previous tab | Switches between Terminal and URL tabs |
| `Cmd/Alt + →` | Navigate to next tab | Switches between Terminal and URL tabs |

### Session Navigation (Without Shift)

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + ↑` | Navigate to previous session | Moves to the previous session within the current workspace |
| `Cmd/Alt + ↓` | Navigate to next session | Moves to the next session within the current workspace |

### Numbered Session Switching (Without Shift)

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + 1..9` | Switch to the Nth visible session in the sidebar | 1 selects the first visible session, 2 the second, etc. Works across workspaces using the exact sidebar order. Allowed even while typing in inputs (including the Notes editor). Note: Some browsers reserve `Cmd + 1..9` for browser tab switching; use `Alt + 1..9` in those cases or adjust browser settings. |

### Workspace Sidebar Actions

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + Shift + |` | Toggle workspace expansion | Collapses all when expanded; expands all when collapsed |
| `Cmd/Alt + Shift + E` | Toggle current workspace | Expands/collapses the currently selected workspace in the sidebar |
| `Cmd/Alt + Shift + A` | Toggle Active Workspaces filter | Toggles the sidebar filter to show only workspaces with active sessions |

### Interface

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + Shift + /` | Toggle sidebar | Shows/hides the session sidebar on desktop |
| `Cmd/Alt + Shift + J` | Toggle Activity Timeline | Opens/closes the activity transitions menu (when available) |

### Activity Timeline

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + Shift + <` | Previous transition | Jumps to previous activity marker (ring navigation) |
| `Cmd/Alt + Shift + >` | Next transition | Jumps to next activity marker (ring navigation) |
| `Cmd/Alt + Shift + F` | Toggle terminal/sidebar search | If terminal search is focused, clears and switches focus to sidebar search; if sidebar search is focused, clears and switches focus to terminal search. Otherwise opens terminal search and focuses input |
| `Cmd/Alt + Shift + M` | Open Quick Template Search | Opens the quick template search overlay. `Shift+Enter` on a selected result creates a session immediately |
| `Cmd/Alt + Shift + G` | Focus session search | Focuses the "Search sessions..." input (selects existing text if present) |
| `Cmd/Alt + Shift + +` | Increase terminal font size | Updates terminal font size immediately and saves the preference |
| `Cmd/Alt + Shift + -` | Decrease terminal font size | Updates terminal font size immediately and saves the preference |
| `Cmd/Alt + Shift + S` | Toggle deferred/stop inputs dropdown | Opens/closes the prompts dropdown for the active session (shows deferred inputs queue and stop inputs configuration) |

### Deferred and Stop Inputs

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + S` | Toggle stop inputs enabled | Toggles the global "Stop inputs enabled" flag for the active session, preserving the current rearm counter |

### Links Menu

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + Shift + L` | Open/close global links menu | Opens from anywhere; also works when a note editor has focus |

When the links menu is open, the search input supports:

- `ArrowDown`: Moves focus to the first visible result.
- `Enter`:
  - If exactly one result is visible, opens it immediately.
  - If multiple results are visible and the "Match group names" preference is enabled, toggles between including group-name matches and direct-only matches. This is a one-time toggle that resets on any edit to the search input or when the menu is closed. Toggling to direct-only happens only if there will be at least one direct-only result.
- `Escape`:
  - If the search has text, clears the text and keeps focus in the input (does not close).
  - If the search is empty, closes the links menu.

## Notes Tab

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + ArrowDown` | Focus notes editor | Works in Plain or Split view when the notes tab is active |
| `Cmd/Alt + ArrowUp` | Blur notes editor | Removes focus from the notes editor in Plain or Split view |
| `Cmd/Alt + F` | Open search/replace | Opens the inline search/replace panel in Plain/Split |

### Notes Search/Replace Panel (when open)

- In the Find input
  - `Enter`: Go to next match
  - `Shift + Enter`: Go to previous match
  - `Escape`: If text present, clears input; if empty, closes panel
- In the Replace input
  - `Enter`: Replace current match
  - `Cmd/Alt + Enter`: Replace all matches

> Workspace notes follow the same ArrowUp/ArrowDown shortcuts when the workspace notes tab is active.

### Page Navigation

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Cmd/Alt + Shift + S` | Show sessions page | Navigates to the terminal sessions page |

## Modal Shortcuts

### General Modal Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Escape` | Close modal | Works in all modals (new session, terminate confirmation, delete confirmation) |
| `Enter` | Confirm action | Works in confirmation modals (terminate, delete) |

### Text Input Modal

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Ctrl + Enter` | Send text | Sends the text in the text input modal to the terminal |

### Session Title Modal

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Enter` | Save title | Saves the new title for the session |
| `Escape` | Cancel | Closes the modal without saving |

## Mobile Interface

### Sidebar Control

| Shortcut | Action | Notes |
|----------|--------|-------|
| `Escape` | Close mobile sidebar | Closes the mobile sidebar when it's open |

## Requirements and Behavior

### Session Context Requirements

Many shortcuts require an active session to be selected:

- **Session Management shortcuts** (`Cmd/Alt + Shift + R/K`) only work when a session is currently selected
- **Session Navigation shortcuts** work within the currently visible session list
- **Tab Navigation shortcuts** work globally regardless of session selection

### Session State Restrictions

- **Terminate Session** (`Cmd/Alt + Shift + K`) only works on active (running) sessions
- **Rename** (`Cmd/Alt + Shift + R`) works on both active and inactive sessions
- **Switch to previous profile** (`Cmd/Alt + Shift + P`) is available when at least two profiles exist and a previous profile is known; no action when unavailable

### Modal Behavior

- When any modal is open, global keyboard shortcuts are disabled to prevent conflicts
- The text input modal is an overlay and does not block most global shortcuts
- Modal shortcuts have priority over global shortcuts when modals are active

### Input Focus Behavior

- When a text field is focused (input, textarea, or contenteditable), Cmd/Alt + Arrow combinations (with or without Shift) are ignored so normal text editing works.
- The hidden xterm.js helper textarea is excluded from this rule so terminal shortcuts continue to function.
- Exception: Numbered session switching (`Cmd/Alt + 1..9`) is allowed even when typing, including in the Notes editor.

### Error Handling

The application provides console warnings when shortcuts are used inappropriately:

- Attempting to use session-specific shortcuts without a selected session
- Attempting to terminate an inactive session
- Attempting to move sessions beyond list boundaries

## Platform Notes

### Mac vs Windows/Linux

- Mac: Use `Command + Shift` for all shortcuts
- Windows/Linux: Use `Alt + Shift` for all shortcuts

### Browser Compatibility

- All shortcuts are designed to work in modern browsers
- Some browser-specific shortcuts may override application shortcuts
- Use the application's keyboard shortcuts only when the terminal application has focus
- Common browser reservation: `Cmd + 1..9` often switches browser tabs. Use `Alt + 1..9` as an alternative if the browser intercepts the command.

## Implementation Details

### Keyboard Event Handling

- All global shortcuts use the `keydown` event
- Shortcuts check for both `shiftKey` and `metaKey` (Mac) or `altKey` (Windows/Linux)
- Each shortcut calls `preventDefault()` to prevent browser default behavior

### Session Selection

- Session shortcuts operate on `this.currentSessionId` in the termstation
- Session selection is maintained separately for Active and Inactive tabs
- Session selection persists when switching between tabs

### UI Updates

- All shortcuts automatically update the UI through the existing reactive state system
- Sidebar toggle includes smooth CSS transitions
- Session movements integrate with the existing drag-and-drop functionality

## Troubleshooting

### Shortcuts Not Working

1. **Check Focus**: Ensure the terminal application has browser focus
2. **Check Modals**: Close any open modals that might be blocking shortcuts
3. **Check Session Selection**: Ensure a session is selected for session-specific shortcuts
4. **Check Browser**: Some browsers may intercept certain key combinations

### Conflicts with Browser Shortcuts

Some shortcuts may conflict with browser or system shortcuts:

- `Cmd/Alt + Shift + T` (new session) - Application shortcut takes priority when focused
- `Cmd/Alt + Shift + R` (rename session) - Application shortcut takes priority when focused

### Performance

- Keyboard shortcuts are highly optimized and should not impact application performance
- All shortcuts include proper error handling to prevent application crashes
