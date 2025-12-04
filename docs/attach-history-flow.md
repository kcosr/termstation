# Attach and History Fetch Flow - Client Side Order of Operations

This document describes the order of operations when attaching to a terminal session and fetching history on the client side.

## Overview

When a terminal session is attached, the client needs to:
1. Attach to the session via WebSocket
2. Receive a history marker from the server
3. Optionally fetch and display historical output
4. Resume receiving live stdout without duplicating content

## Detailed Flow

### 1. `attach()` is called (`session.js:626`)

```javascript
async attach(forceLoadHistory = false)
```

**Operations:**
- Clears terminal: `this.terminal.clear()`
- **Gates stdout immediately**: `this._gateWsStdout()` - prevents any stdout from being written to terminal
- **Registers history sync handler BEFORE sending attach**: `this.handleHistoryLoading(forceLoadHistory)`
  - This is critical to avoid race conditions where server responds before handler is registered
- Sends attach message: `this.wsClient.send('attach', { session_id: this.sessionId })`
- **Marks as attached immediately**: `this.isAttached = true`
  - This allows stdout messages to start arriving, but they're gated

### 2. `handleHistoryLoading()` sets up event listener (`session.js:904`)

**Operations:**
- Clears any existing history sync timer
- Removes any existing `ws-attached` handler to avoid duplicates
- Sets up new handler for `ws-attached` event:
  ```javascript
  const handler = async (event) => {
    // Waits for attach response with history_marker
  }
  ```
- Registers handler: `this.eventBus.on('ws-attached', handler)`
- Sets 5-second timeout fallback in case server doesn't respond

**State at this point:**
- `_wsOutputGated = true` (stdout is buffered, not written)
- `isAttached = true` (session can receive messages)
- Handler is listening for `ws-attached` event

### 3. Server responds with `ws-attached` event

**Backend flow:**
- Server receives `attach` message
- Server sends `attached` message via WebSocket with:
  - `session_id`
  - `history_marker` (byte offset marker for history sync)
  - `should_load_history` flag

**Client receives via `AttachedHandler` (`attached-handler.js:7`):**
- Emits `ws-attached` event on eventBus with:
  - `session_id`
  - `history_marker`
  - `should_load_history`

### 4. Handler receives `ws-attached` event (`session.js:916`)

**Operations:**
- Extracts `history_marker` from event
- Removes event listener (one-time handler)
- **Decision point**: Should history be loaded?

**If history should be loaded** (`session.js:925`):
- Sets `isLoadingHistory = true` (prevents terminal input during replay)
- **Clears buffered stdout**: `this._clearWsStdoutBuffer()` - drops any early stdout
- Calls `loadExistingOutput(forceLoadHistory)`
- After history loads, sends `history_loaded` message to server
- Opens stdout gate: `this._openWsStdoutGate()` (no flush, buffer was cleared)
- Focuses terminal after history load

**If history should NOT be loaded** (`session.js:949`):
- Opens stdout gate and flushes buffered output: `this._openWsStdoutGate(true)`
- Focuses terminal immediately

### 5. `loadExistingOutput()` fetches history (`session.js:1091`)

**Operations:**
- Shows loading overlay (unless history is preloaded)
- Determines if history should be skipped based on:
  - Session state (terminated sessions always load)
  - `load_history` flag in session data
  - `forceLoadHistory` parameter
- If loading, calls `_streamHistoryIntoTerminal()`

### 6. `_streamHistoryIntoTerminal()` streams history (`session.js:1225`)

**Operations:**
- Creates AbortController for cancellation
- Calls `streamHistoryToTerminal()` utility (`history-streamer.js:25`)
- Streams history from `/api/sessions/{id}/history/raw` endpoint
- Writes chunks to terminal incrementally
- Places activity markers at appropriate offsets
- Updates progress overlay

### 7. History streaming completes (`session.js:1264`)

**Operations:**
- Clears overlay after terminal renders
- Emits `terminal-ready` event
- AbortController is cleared

### 8. Stdout handling during attach (`session.js:727`)

**While stdout is gated** (`_wsOutputGated = true`):
- All stdout messages arrive via `StdoutHandler` → `session.handleOutput()`
- Output is buffered in `_wsOutputBuffer` array
- Buffer is capped at 512KB (`_wsOutputBufferMaxBytes`)
- **Nothing is written to terminal**

**After gate is opened** (`_wsOutputGated = false`):
- Stdout messages are written directly to terminal
- If `flushBuffered = true`, buffered output is flushed first
- If `flushBuffered = false`, buffer is cleared (history was loaded, so buffer is stale)

## Race Condition Protection Mechanisms

### 1. Output Gating (`_gateWsStdout()` / `_openWsStdoutGate()`)
- **Purpose**: Prevent stdout from being written while history decision is pending
- **When gated**: From `attach()` call until history decision is made
- **Buffer management**: 
  - If history loads: buffer is cleared (history contains the data)
  - If history skipped: buffer is flushed (preserve early output)

### 2. Handler Registration Timing
- History handler is registered **BEFORE** sending attach message
- Prevents race where server responds before handler is ready
- Comment in code: "Register history sync handler BEFORE sending attach to avoid race"

### 3. Timeout Fallback
- 5-second timeout if server doesn't respond with `ws-attached`
- Prevents indefinite blocking
- Opens gate and flushes buffer if timeout expires

### 4. Loading Flag (`isLoadingHistory`)
- Prevents terminal input during history replay
- Prevents terminal queries from history from being sent to backend

## Potential Race Condition Points

1. **Server sends stdout before `ws-attached` event**
   - Protected by: Output gating (stdout is buffered)
   - Risk: If buffer fills up (>512KB), early output is dropped

2. **Server sends stdout during history fetch**
   - Protected by: Output gating remains active until history completes
   - Risk: If history fetch is slow, buffer may fill up

3. **Multiple attach calls**
   - Protected by: Handler cleanup in `handleHistoryLoading()`
   - Risk: If attach is called multiple times rapidly, handlers might conflict

4. **History fetch completes but stdout arrives before gate opens**
   - Protected by: Gate is opened synchronously after history completes
   - Risk: Very small window where stdout could arrive between completion and gate opening

## Key State Variables

- `isAttached`: Session is attached and can receive messages
- `isLoadingHistory`: History is currently being loaded (prevents input)
- `_wsOutputGated`: Stdout is buffered, not written to terminal
- `_wsOutputBuffer`: Array of buffered stdout chunks
- `historyMarker`: Server-provided byte offset marker for sync
- `historySyncComplete`: History sync handshake is complete
- `_wsAttachHandler`: Reference to current attach event handler

## Sequence Diagram

```
Client                    Server                    EventBus
  |                         |                          |
  |-- attach() ------------>|                          |
  |   (gate stdout)         |                          |
  |   (register handler)    |                          |
  |   (send attach)          |                          |
  |                         |                          |
  |                         |<-- attach message        |
  |                         |                          |
  |                         |-- attached message ----->|
  |                         |   (with history_marker)   |
  |                         |                          |
  |<-- ws-attached event ---|                          |
  |   (via EventBus)        |                          |
  |                         |                          |
  |-- loadExistingOutput()  |                          |
  |   (gate still closed)   |                          |
  |                         |                          |
  |-- GET /history/raw ---->|                          |
  |                         |                          |
  |<-- stream chunks -------|                          |
  |   (write to terminal)   |                          |
  |                         |                          |
  |-- history_loaded ------>|                          |
  |   (open gate)           |                          |
  |                         |                          |
  |<-- stdout messages -----|                          |
  |   (now written)         |                          |
```

## Notes

- The `from_queue` flag in stdout messages indicates if output was queued server-side during history sync
- History marker is a byte offset that helps server know where to resume sending stdout
- Terminal is cleared at the start of attach to avoid showing stale content
- Focus is deferred until after history loads to prevent focus events from corrupting output stream
