# Schema Proposal: Sidebar Workspace Recency Sort

Status: Locked

## 1. Goal
Lock client-consumed payload semantics and frontend-only state contracts required for workspace recency sorting, without backend API changes.

## 2. Example Request / Response Payloads

### Existing API payload consumed (`GET /api/sessions`)
```json
[
  {
    "session_id": "abc123",
    "workspace": "Project A",
    "created_at": "2026-03-10T15:00:00.000Z",
    "last_output_at": "2026-03-10T15:11:22.000Z",
    "is_active": true
  }
]
```

### Existing websocket payload consumed (`session_activity`)
```json
{
  "type": "session_activity",
  "session_id": "abc123",
  "activity_state": "inactive",
  "last_output_at": "2026-03-10T15:12:05.000Z"
}
```

## 3. JSON Schema Skeleton

### API session object subset
```json
{
  "type": "object",
  "required": ["session_id", "created_at"],
  "properties": {
    "session_id": { "type": "string", "minLength": 1 },
    "workspace": { "type": "string" },
    "created_at": { "type": "string", "format": "date-time" },
    "last_output_at": { "type": ["string", "null"], "format": "date-time" }
  },
  "additionalProperties": true
}
```

### Websocket activity subset
```json
{
  "type": "object",
  "required": ["type", "activity_state"],
  "properties": {
    "type": { "const": "session_activity" },
    "session_id": { "type": "string" },
    "sessionId": { "type": "string" },
    "activity_state": { "type": "string", "enum": ["active", "inactive", "idle"] },
    "last_output_at": { "type": ["string", "null"], "format": "date-time" }
  },
  "additionalProperties": true
}
```

### Frontend state subset
```json
{
  "type": "object",
  "properties": {
    "workspaces": {
      "type": "object",
      "properties": {
        "sortMode": { "type": "string", "enum": ["manual", "recent"] },
        "sortDirty": { "type": "boolean" }
      },
      "additionalProperties": true
    }
  },
  "additionalProperties": true
}
```

## 4. Endpoint / Contract Lock
- No endpoint additions/removals.
- No backend response changes required.
- Contract reliance is limited to existing fields listed above.

## 5. Deterministic Reject / Status Lock
- Session id coalescing rule: use `session_id`; fallback to `sessionId`.
- Timestamp ranking source: `last_output_at` only.
- Fallback chain: `last_output_at` -> `created_at` -> `0`.
- `idle` is treated the same as `inactive` for recency ingestion flow.
- Unknown sessions or invalid timestamps are no-op (ignored update).
- API-seed merge into existing recency map uses max-wins timestamp semantics.

## 6. Notes
- `sessionRecencyById` runtime map is not persisted.
- Persisted mode key lock: `terminal_workspace_sort_mode`.
- `sortDirty` is transient UI state and not persisted.

## 7. Status
Locked
