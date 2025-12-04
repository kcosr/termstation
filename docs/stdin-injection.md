# Stdin Injection (API)

This document describes the current HTTP API for injecting input into an active terminal session, and the scheduled input rules API for recurring/offset input.

## Endpoint

- POST `/api/sessions/:sessionId/input`

Requirements:
- The caller must have `inject_session_input` permission (returns 403 otherwise)
- The target session must exist (404), be active (409), and be interactive (400)

### Request Body

- `data` (string): Text to send to stdin
- `submit` (boolean, default true): If true, sends Enter after data
- `enter_style` (string, default `cr`): One of `cr`, `lf`, `crlf`
- `delay_ms` (number): Additional Enter delay (ms) after the first Enter when `submit` is true
- `simulate_typing` (boolean): Send characters one by one with a per‑character delay
- `typing_delay_ms` (number): Per‑character delay (ms) when `simulate_typing` is true
- `raw` (boolean, default false): When true, writes `data` exactly as provided and skips typing/submit behavior

### Behavior

- Enter behavior:
  - Always waits ~200ms before the first Enter to ensure a separate write frame
  - Optionally sends a second Enter after `delay_ms` (or default)
- Typing mode: When enabled (default via config), characters are written individually with the configured per‑character delay
- Focus emulation: When enabled by config, ESC [ I (Focus In) is sent before data and ESC [ O (Focus Out) after submit
- Limit: An optional per‑session cap rejects further requests with HTTP 429
- WebSocket notification: On success, connected clients receive `stdin_injected` with `{ session_id, by, bytes, submit, enter_style, raw, notify }`. Emission is always performed; clients decide whether to show a toast.
- Markers: The server does not persist input markers for this event. The frontend registers a local render marker (timestamp + line) on receipt of the WS event and POSTs it to `/api/sessions/:sessionId/markers` for durability.

### Example Requests

Basic submit:
```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"data":"echo hello","submit":true}' \
  http://localhost:6620/api/sessions/<SESSION_ID>/input
```

Raw (no submit):
```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"data":"\u001b[31mRED\u001b[0m","raw":true,"submit":false}' \
  http://localhost:6620/api/sessions/<SESSION_ID>/input
```

Simulated typing with extra Enter delay:
```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"data":"top","simulate_typing":true,"typing_delay_ms":25,"submit":true,"delay_ms":800}' \
  http://localhost:6620/api/sessions/<SESSION_ID>/input
```

## Relevant Configuration

Configure in `backend/config/<env>/config.json` under `stdin_injection`:

- `max_messages_per_session` (number|null): Per‑session cap for POST `/input` messages; when reached, API returns HTTP 429
- `default_delay_ms` (number): Additional Enter delay for the optional second Enter
- `default_simulate_typing` (boolean): Default typing mode when not specified by the caller
- `default_typing_delay_ms` (number): Per‑character delay used when typing mode is enabled
- `send_focus_in` (boolean): Send ESC [ I before data
- `send_focus_out` (boolean): Send ESC [ O after submit

Derived runtime keys exposed via `config`:

- `API_STDIN_MAX_MESSAGES_PER_SESSION`
- `API_STDIN_DEFAULT_DELAY_MS`
- `API_STDIN_DEFAULT_SIMULATE_TYPING`
- `API_STDIN_DEFAULT_TYPING_DELAY_MS`
- `API_STDIN_SEND_FOCUS_IN`
- `API_STDIN_SEND_FOCUS_OUT`

## WebSocket Event

- Type: `stdin_injected`
- Payload: `{ session_id, by, bytes, submit, enter_style, raw, notify, source, rule_id, activity_policy }`

Front‑end registry: The Terminal Manager registers a handler for `stdin_injected` that logs debug output (UI notifications can be wired as needed).

## Scheduled input

The backend supports per‑session scheduled input rules that fire once after an offset or repeatedly at an interval.

### Endpoints

- `GET /api/sessions/:id/input/rules` — List rules for an active, interactive session
- `POST /api/sessions/:id/input/rules` — Create a rule
- `PATCH /api/sessions/:id/input/rules/:ruleId` — Update a rule (pause/resume, timing, options)
- `DELETE /api/sessions/:id/input/rules/:ruleId` — Remove a rule
- `DELETE /api/sessions/:id/input/rules` — Clear all rules for the session
- `POST /api/sessions/:id/input/rules/:ruleId/trigger` — Fire a rule immediately

Permissions and state requirements match `/input`:
- Requires `inject_session_input` permission
- Session must exist (404), be active (409), and be interactive (400)
- Ownership or `manage_all_sessions` required for rule management

### Rule payload

Create body (`POST /input/rules`):
```
{
  "type": "offset" | "interval",
  // one of
  "offset_ms": number,            // for type=offset (ms)
  "interval_ms": number,          // for type=interval (ms)

  "data": "string to send",
  // options can be flat or nested under `options`
  "submit": true,
  "enter_style": "cr" | "lf" | "crlf",
  "raw": false,
  "activity_policy": "immediate" | "suppress" | "defer",
  "simulate_typing": false,
  "typing_delay_ms": 0,
  "notify": true,
  // interval only
  "stop_after": 3
}
```

Notes:
- For intervals, `stop_after` limits the number of firings (omit for unlimited).
- `activity_policy`:
  - `"immediate"` (default): inject on schedule regardless of current output activity.
  - `"suppress"`: when the session is producing output, interval rules skip the tick; offset rules are removed without firing.
  - `"defer"`: when the session is producing output, the injection is queued and delivered once the session becomes inactive.
- The list endpoint returns rules without the full `data`; a `data_preview` field is included for safety.

### Examples

Add an offset rule (fire once after 2 seconds):
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"type":"offset","offset_ms":2000,"data":"echo ready","submit":true}' \
  http://localhost:6620/api/sessions/<SESSION_ID>/input/rules
```

Add an interval rule (every 10s, stop after 3):
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"type":"interval","interval_ms":10000,"data":"ls","submit":true,"stop_after":3}' \
  http://localhost:6620/api/sessions/<SESSION_ID>/input/rules
```

Pause a rule:
```bash
curl -X PATCH -H 'Content-Type: application/json' \
  -d '{"paused":true}' \
  http://localhost:6620/api/sessions/<SESSION_ID>/input/rules/<RULE_ID>
```

Trigger a rule immediately:
```bash
curl -X POST http://localhost:6620/api/sessions/<SESSION_ID>/input/rules/<RULE_ID>/trigger
```

### WebSocket events

- Type: `scheduled_input_rule_updated`
- Actions: `added`, `updated`, `removed`, `cleared`, `fired`
- Example payload (added):
```
{
  "type": "scheduled_input_rule_updated",
  "action": "added",
  "session_id": "...",
  "rule": { "id": "...", "type": "interval", "interval_ms": 10000, "data_preview": "ls", ... },
  "rule_id": "...",
  "next_run_at": 1734320000000,
  "paused": false
}
```

### Limits and config

Environment variables:
- `SCHEDULED_INPUT_MAX_RULES_PER_SESSION` — Max rules per session (default 20)
- `SCHEDULED_INPUT_MAX_BYTES_PER_RULE` — Max bytes allowed in rule `data` (default 8192)

Config file (`backend/config/<env>/config.json` → `scheduled_input`):
- `max_messages_per_session` — Max scheduled messages a session may receive (default 50)

### Templates

Templates may embed rules to auto‑start on session creation via `scheduled_input_rules` (or `scheduled_inputs.rules`).
See README “Template Configuration” for field details and examples.

## Deferred input queue

When `activity_policy: "defer"` is used, the backend queues injections while a session is actively producing output and delivers them once the session becomes inactive.

### Sources

- Scheduled rules (`source: "scheduled"`):
  - When a rule fires and the session is active:
    - The rule’s payload is queued (per session, keyed by `rule:<rule_id>`).
    - Interval rules still advance `times_fired` and honor `stop_after`.
    - Offset rules are considered “fired” from the scheduler’s perspective; the actual write occurs when the session becomes inactive.
- Direct API calls (`source: "api"`):
  - When `POST /api/sessions/:id/input` is called with `activity_policy: "defer"` and the session is active:
    - The payload is queued under key `"api-input"`.
    - The API responds with `{ ok: true, deferred: true, activity_policy, pending_id, bytes }` (or `{ ok: true, deferred: true, deduped: true, activity_policy }` if an identical entry is already queued).

### Queue semantics

- Queue is per session and in-memory only.
- Deduplication:
  - Keyed by `(session_id, key, content_hash)` where `content_hash` is derived from `data + submit + raw + enter_style`.
  - When registering a deferred entry, if another entry with the same key and content hash already exists, the new one is discarded (first one wins).
- Delivery:
  - When the session’s output transitions to inactive (`output_active` flips to `false`), the backend:
    - Drains the queue in `created_at` order.
    - Calls `injectSessionInput` for each entry with its original `options` and `activity_policy` metadata (but does not re-defer).
  - If the session is no longer active or interactive, the queue is cleared without delivery.

### Deferred input management API

- `GET /api/sessions/:id/deferred-input`
  - Auth: same visibility rules as other session reads (`canAccessSession`).
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

- `DELETE /api/sessions/:id/deferred-input/:pendingId`
  - Auth: active/interactive session, `inject_session_input` permission, and ownership/`manage_all_sessions`.
  - Behavior: removes a single queued entry. Returns:
    - `204` on success.
    - `404` when `pendingId` is not found for that session.

- `DELETE /api/sessions/:id/deferred-input`
  - Auth: same as above.
  - Behavior: clears all queued entries for the session.
  - Response: `{ "cleared": <number-of-entries> }`.

### Deferred input WebSocket events

- Event: `deferred_input_updated`
  - Emitted whenever the deferred input queue changes for a session.
  - Common fields:
    ```json
    {
      "type": "deferred_input_updated",
      "session_id": "<SESSION_ID>",
      "action": "added" | "removed" | "cleared",
      "count": 3
    }
    ```

## Stop inputs grace window

To avoid firing stop inputs immediately after recent user interaction (e.g., small bursts of output caused by a resize or quick commands), the backend applies a grace window before injecting `stop_inputs` when a session becomes inactive.

- Config (backend `config.json`):
  ```json
  {
    "stop_inputs": {
      "grace_ms": 2000,
      "rearm_max": 10
    }
  }
  ```
- Mapping:
  - `stop_inputs.grace_ms` → `config.STOP_INPUTS_GRACE_MS` (milliseconds).
  - `stop_inputs.rearm_max` → `config.STOP_INPUTS_REARM_MAX` (maximum rearm counter value).
- Behavior:
  - Each session tracks `last_user_input_at` (timestamp of the most recent user-initiated input).
  - When the session transitions to inactive and `maybeInjectStopInputs` runs:
    - If `now - last_user_input_at < STOP_INPUTS_GRACE_MS`, stop inputs are skipped and `stop_inputs_enabled` remains unchanged.
    - Otherwise, armed `stop_inputs` are injected. After a successful injection:
      - If `stop_inputs_rearm_remaining > 0`, the backend decrements the counter and keeps `stop_inputs_enabled === true`.
      - If `stop_inputs_rearm_remaining === 0`, the backend sets `stop_inputs_enabled = false`.
    - A `session_updated` broadcast includes `stop_inputs_enabled`, `stop_inputs_rearm_remaining`, and `stop_inputs_rearm_max`.
  - `action: "added"`:
    - Includes a `pending` snapshot:
      ```json
      {
        "type": "deferred_input_updated",
        "session_id": "<SESSION_ID>",
        "action": "added",
        "count": 3,
        "pending": {
          "id": "<PENDING_ID>",
          "session_id": "<SESSION_ID>",
          "key": "api-input",
          "source": "api",
          "created_at": "2025-11-22T02:39:21.860Z",
          "bytes": 42,
          "data_preview": "first 120 bytes…"
        }
      }
      ```
  - `action: "removed"`:
    - Includes identifiers for the removed entry:
      ```json
      {
        "type": "deferred_input_updated",
        "session_id": "<SESSION_ID>",
        "action": "removed",
        "count": 2,
        "pending_id": "<PENDING_ID>",
        "key": "api-input",
        "source": "api"
      }
      ```
  - `action: "cleared"`:
    - Indicates the queue was emptied (e.g., after delivery or explicit clear).
      ```json
      {
        "type": "deferred_input_updated",
        "session_id": "<SESSION_ID>",
        "action": "cleared",
        "count": 0
      }
      ```
