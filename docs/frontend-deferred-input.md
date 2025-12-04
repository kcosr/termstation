# Frontend Reference: Activity Policy, Deferred Input, and Stop Inputs (WIP)

This document summarizes the backend APIs and WebSocket messages relevant to:

- Activity policy (`activity_policy`) for stdin injections.
- Deferred input queue management.
- Stop inputs that inject when sessions become inactive.

It is intended as a temporary reference for implementing the frontend behavior in a follow-up change.

## HTTP APIs

### Inject input with activity policy

`POST /api/sessions/:sessionId/input`

- Permissions:
  - Requires `inject_session_input`.
  - Session must exist, be active, and be interactive.
- Request body (subset):
  ```json
  {
    "data": "string",
    "submit": true,
    "enter_style": "cr" | "lf" | "crlf",
    "raw": false,
    "delay_ms": 1000,
    "simulate_typing": false,
    "typing_delay_ms": 0,
    "activity_policy": "defer" | "immediate" | "suppress",
    "notify": true
  }
  ```
- Behavior:
  - `activity_policy: "defer"` (default when omitted):
    - If `output_active` is true, request is queued and reported as deferred (see below).
    - If the session is inactive, behaves like `"immediate"` and injects right away.
  - `activity_policy: "immediate"`:
    - Inject immediately, regardless of `output_active`.
  - `activity_policy: "suppress"`:
    - If `output_active` is true, request is accepted but suppressed; server returns `{ ok: true, suppressed: true, reason: "active", activity_policy: "suppress" }`.
  - `activity_policy: "defer"` (explicit):
    - Same behavior as default when omitted.
    - Server responds with:
      ```json
      { "ok": true, "deferred": true, "activity_policy": "defer", "pending_id": "<PENDING_ID>", "bytes": 42 }
      ```
      or, if deduped (identical pending entry already in queue):
      ```json
      { "ok": true, "deferred": true, "deduped": true, "activity_policy": "defer" }
      ```
    - When the session later becomes inactive, the queued payload is injected and a normal `stdin_injected` WS event is emitted.

### Deferred input queue

#### List queued items

`GET /api/sessions/:sessionId/deferred-input`

- Auth:
  - Same visibility rules as `GET /api/sessions/:sessionId`.
- Response:
  ```json
  {
    "session_id": "<SESSION_ID>",
    "items": [
      {
        "id": "<PENDING_ID>",
        "session_id": "<SESSION_ID>",
        "key": "api-input" | "rule:<RULE_ID>",
        "source": "api" | "scheduled" | "stop-inputs",
        "created_at": "2025-11-22T02:39:21.860Z",
        "bytes": 42,
        "activity_policy": "defer",
        "data_preview": "first 200 bytes…"
      }
    ]
  }
  ```

#### Delete one entry

`DELETE /api/sessions/:sessionId/deferred-input/:pendingId`

- Auth:
  - Session must be active and interactive.
  - Requires `inject_session_input` and ownership or `manage_all_sessions`.
- Responses:
  - `204` on success.
  - `404` if `pendingId` is not found for that session.

#### Clear all entries

`DELETE /api/sessions/:sessionId/deferred-input`

- Auth: same as delete-one.
- Response:
  ```json
  { "cleared": 3 }
  ```

### Stop inputs

Stop inputs are prompts injected when a session becomes inactive. They are derived from templates but can be edited per session via the API. A per-session rearm counter controls how many additional injections are allowed before `stop_inputs_enabled` is automatically disabled.

Stop inputs can be configured:
- **At session creation**: Include `stop_inputs`, `stop_inputs_enabled`, and/or `stop_inputs_rearm_remaining` in the `POST /api/sessions` request body to override template defaults (see backend-api.md for details)
- **After creation**: Use the endpoints below to modify stop inputs for an existing session

#### Get configuration

`GET /api/sessions/:sessionId/stop-inputs`

- Auth:
  - Same visibility as `GET /api/sessions/:sessionId`.
- Response:
  ```json
  {
    "session_id": "<SESSION_ID>",
    "stop_inputs_enabled": true,
    "stop_inputs_rearm_remaining": 0,
    "stop_inputs_rearm_max": 10,
    "stop_inputs": [
      {
        "id": "<UUID>",
        "prompt": "Remember to check the logs",
        "armed": true,
        "source": "template" | "user"
      }
    ]
  }
  ```

#### Replace prompts

`PUT /api/sessions/:sessionId/stop-inputs`

- Auth:
  - Active session.
  - Owner or `manage_all_sessions`.
- Request body:
  ```json
  {
    "stop_inputs": [
      { "id": "<optional>", "prompt": "string", "armed": true, "source": "template" | "user" }
    ],
    "stop_inputs_rearm_remaining": 0
  }
  ```
- Response: same shape as `GET /stop-inputs`.
- Side effects: emits `session_updated` with updated session object.

#### Toggle global enabled flag

`POST /api/sessions/:sessionId/stop-inputs/enabled`

- Auth: owner or `manage_all_sessions`.
- Request body:
  - Optional: `{ "enabled": boolean, "stop_inputs_rearm_remaining": 0 }` — when `enabled` is omitted, the flag is toggled.
- Response:
  ```json
  {
    "session_id": "<SESSION_ID>",
    "stop_inputs_enabled": true,
    "stop_inputs_rearm_remaining": 0,
    "stop_inputs_rearm_max": 10
  }
  ```
- Side effects: emits `session_updated`.

#### Toggle a single prompt

`POST /api/sessions/:sessionId/stop-inputs/:promptId/toggle`

- Auth: owner or `manage_all_sessions`.
- Request body:
  - Optional: `{ "armed": boolean }` — when omitted, `armed` is toggled.
- Response:
  ```json
  {
    "session_id": "<SESSION_ID>",
    "stop_inputs_enabled": true,
    "stop_inputs": [ /* updated prompts */ ],
    "stop_inputs_rearm_remaining": 0,
    "stop_inputs_rearm_max": 10
  }
  ```
- Side effects: emits `session_updated`.

## WebSocket Messages

### `stdin_injected`

- Emitted whenever input is injected (direct, scheduled, deferred delivery, or stop inputs).
- Shape:
  ```json
  {
    "type": "stdin_injected",
    "session_id": "<SESSION_ID>",
    "by": "username-or-server",
    "bytes": 42,
    "submit": true,
    "enter_style": "cr",
    "raw": false,
    "notify": true,
    "source": "api" | "scheduled" | "stop-inputs",
    "rule_id": "<RULE_ID or null>",
    "activity_policy": "immediate" | "suppress" | "defer"
  }
  ```
- Notes:
  - For deferred deliveries, `activity_policy` reflects the original policy (`"defer"`), even though the actual send happens when the session is inactive.
  - `source` values:
    - `"api"`: direct `/input`.
    - `"scheduled"`: scheduled rules.
    - `"stop-inputs"`: concatenated stop inputs injection.

### `deferred_input_updated`

- Emitted whenever the deferred input queue for a session changes.
- Common fields:
  ```json
  {
    "type": "deferred_input_updated",
    "session_id": "<SESSION_ID>",
    "action": "added" | "removed" | "cleared",
    "count": 3
  }
  ```
- `action: "added"`:
  ```json
  {
    "type": "deferred_input_updated",
    "session_id": "<SESSION_ID>",
    "action": "added",
    "count": 3,
    "pending": {
      "id": "<PENDING_ID>",
      "session_id": "<SESSION_ID>",
      "key": "api-input" | "rule:<RULE_ID>",
      "source": "api" | "scheduled" | "stop-inputs",
      "created_at": "2025-11-22T02:39:21.860Z",
      "bytes": 42,
      "data_preview": "first 120 bytes…"
    }
  }
  ```
- `action: "removed"`:
  ```json
  {
    "type": "deferred_input_updated",
    "session_id": "<SESSION_ID>",
    "action": "removed",
    "count": 2,
    "pending_id": "<PENDING_ID>",
    "key": "api-input" | "rule:<RULE_ID>",
    "source": "api" | "scheduled" | "stop-inputs"
  }
  ```
- `action: "cleared"`:
  ```json
  {
    "type": "deferred_input_updated",
    "session_id": "<SESSION_ID>",
    "action": "cleared",
    "count": 0
  }
  ```

### `session_activity`

- Existing event, relevant for understanding when deferred items will be delivered server-side.
- Shape:
  ```json
  {
    "type": "session_activity",
    "session_id": "<SESSION_ID>",
    "activity_state": "active" | "inactive",
    "last_output_at": "2025-11-22T02:39:42.590Z"
  }
  ```
- Notes:
  - Deferred injections are delivered when `activity_state` transitions to `"inactive"` on the server.
  - The frontend does not need to trigger delivery; this event is mainly useful for UI affordances (e.g., indicating that queued items are about to be flushed).

### `session_updated`

- Existing event; stop inputs changes surface via the session object.
- Shape (abbreviated):
  ```json
  {
    "type": "session_updated",
    "update_type": "updated",
    "session_data": {
      "session_id": "<SESSION_ID>",
      "...": "...",
      "stop_inputs_enabled": true,
      "stop_inputs": [
        { "id": "<UUID>", "prompt": "text", "armed": true, "source": "template" | "user" }
      ]
    }
  }
  ```
- The frontend should use `stop_inputs_enabled` and `stop_inputs` from `session_data` to keep any future UI in sync with API changes.
