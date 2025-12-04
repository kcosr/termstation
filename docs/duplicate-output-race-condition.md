# Duplicate Output Race Condition Analysis

## Problem

Client receives duplicate output: both from the raw history fetch AND via websocket stdout messages.

## Root Cause

The race condition occurs because of a mismatch between:
1. **What the server queues** (output with `sequenceNumber > historyMarker`)
2. **What the history endpoint returns** (ALL output, not filtered by sequence number)
3. **What the server sends immediately** (output with `sequenceNumber <= historyMarker`)

## Detailed Flow

### Server Side (`backend/managers/session-manager.js:535`)

When `attach()` is called:
```javascript
const historyMarker = session.outputSequenceNumber; // e.g., 100
session.markClientLoadingHistory(clientId, historyMarker);
```

### Server Queuing Logic (`backend/models/terminal-session.js:890`)

```javascript
shouldQueueOutputForClient(clientId, sequenceNumber) {
  const syncState = this.clientHistorySync.get(clientId);
  if (syncState && syncState.loading) {
    // Only queue output that comes AFTER the history snapshot
    return sequenceNumber > syncState.marker;  // ⚠️ PROBLEM: Only queues if > marker
  }
  return false;
}
```

**This means:**
- Output with `sequenceNumber = 100` → **Sent immediately** (not queued)
- Output with `sequenceNumber = 101` → **Queued** (waiting for history_loaded)

### History Endpoint (`/api/sessions/{id}/history/raw`)

The history endpoint returns **ALL output** from the session, including:
- Output with `sequenceNumber <= 100` (the marker)
- Output with `sequenceNumber > 100` (new output)

**The endpoint does NOT filter by sequence number.**

### Client Side Flow

1. Client receives `attached` with `history_marker: 100`
2. Client gates stdout (buffers websocket messages)
3. Client fetches `/api/sessions/{id}/history/raw` → Gets **ALL output**
4. Client writes history to terminal
5. **Meanwhile**, server sends stdout with `sequenceNumber <= 100` → These arrive via websocket
6. Client opens gate after history completes
7. **Result**: Duplicate output (from history + from websocket)

## The Race Window

```
Time →
│
├─ Server: attach() called, historyMarker = 100
├─ Server: markClientLoadingHistory(clientId, 100)
├─ Server: Send 'attached' message
├─ Server: Schedule stdout flush (_flushStdoutTick)
│
├─ Client: Receive 'attached', gate stdout
├─ Client: Start fetching /history/raw
│
├─ Server: Output arrives with seq=100 → Sent immediately (not queued!)
├─ Client: Receive stdout via websocket → Buffered (gated)
│
├─ Client: History fetch completes → Writes ALL output (including seq=100)
├─ Client: Send 'history_loaded'
│
├─ Client: Open gate → Flushes buffered stdout (including seq=100)
│
└─ Result: seq=100 appears TWICE (once from history, once from websocket)
```

## Why This Happens

1. **Server only queues output AFTER the marker**: `sequenceNumber > historyMarker`
2. **History endpoint returns everything**: No sequence number filtering
3. **Output AT the marker is sent immediately**: Not queued, arrives via websocket
4. **Client receives both**: History fetch + websocket messages overlap

## Potential Solutions

### Option 1: Queue ALL Output Until history_loaded
Change server to queue output with `sequenceNumber >= historyMarker`:
```javascript
shouldQueueOutputForClient(clientId, sequenceNumber) {
  const syncState = this.clientHistorySync.get(clientId);
  if (syncState && syncState.loading) {
    return sequenceNumber >= syncState.marker;  // Changed: >= instead of >
  }
  return false;
}
```

**Pros**: Simple, ensures no duplicates
**Cons**: May delay output unnecessarily if history marker is stale

### Option 2: Filter History Endpoint by Sequence Number
Add query parameter to history endpoint to only return data up to marker:
```javascript
GET /api/sessions/{id}/history/raw?maxSequence={historyMarker}
```

**Pros**: More precise, avoids sending duplicate data
**Cons**: Requires backend changes, more complex

### Option 3: Client-Side Deduplication
Track sequence numbers in client and skip duplicates:
- More complex, requires sequence number tracking in websocket messages

### Option 4: Use Timestamp-Based Filtering
Instead of sequence numbers, use timestamps:
- History endpoint returns data up to attach timestamp
- Server queues output after attach timestamp
- More robust but requires timestamp tracking

## Recommended Fix

**Option 1** is the simplest and most reliable:
- Change `sequenceNumber > syncState.marker` to `sequenceNumber >= syncState.marker`
- This ensures ALL output (including at the marker) is queued until history_loaded
- Minimal code change, maximum safety

## Additional Notes

- The `history_marker` represents a snapshot of `outputSequenceNumber` at attach time
- Output sequence numbers increment for each chunk written
- The marker is meant to be the "cutoff point" between history and live output
- Currently, output AT the marker is ambiguous (sent both ways)
