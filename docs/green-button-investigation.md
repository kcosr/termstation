# Green Button Investigation - Issue #116

## Summary
The "green button" mentioned in issue #116 refers to the green dot (●) status indicator that appears next to terminal sessions in the session list sidebar.

## Purpose of the Green Indicator

The green dot serves as a **session status indicator** with the following meanings:

### Status Indicators:
1. **Green dot (●)** - `status-connected` class
   - **When it appears**: Session is active AND has a client currently connected
   - **CSS**: Uses `--success-color: #4caf50` (green)
   - **Code location**: `frontend/public/js/modules/terminal/session-list.js:44`

2. **Hollow circle (○)** - `status-idle` class  
   - **When it appears**: Session is active but no client is connected
   - **CSS**: Uses `--text-dim` color (gray)
   - **Code location**: `frontend/public/js/modules/terminal/session-list.js:48`

3. **Black square (⬛)** - `status-terminated` class
   - **When it appears**: Session has been terminated/is inactive
   - **CSS**: Uses `--warning-color` color
   - **Code location**: `frontend/public/js/modules/terminal/session-list.js:40`

## When Green Indicator Appears vs Disappears

### Appears (Green Dot):
- A terminal session is running (active)
- AND a client/user is actively connected to that session
- This indicates the session is both available and in use

### Disappears (Changes to Hollow Circle):
- Session remains active but client disconnects
- Session is still running but not actively being used
- Code: `updateSessionStatus()` method handles this transition

### Disappears (Changes to Black Square):
- Session terminates/exits completely  
- Session is no longer active
- Code: `markSessionAsTerminated()` method handles this transition

## Implementation Details

- **Status determination**: Logic in `session-list.js` lines 36-50
- **CSS styling**: Defined in `style.css` lines 372-396 
- **Status updates**: Real-time via WebSocket connection status changes
- **Visual feedback**: Provides immediate indication of session connectivity status

## User Benefit

The green indicator helps users quickly identify:
- Which sessions are actively being used (green dot)
- Which sessions are running but idle (hollow circle)  
- Which sessions have terminated (black square)

This visual feedback improves session management efficiency in the terminal application.
