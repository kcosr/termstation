# Notifications API & WebSocket Protocol

This document summarizes the backend APIs and WebSocket messages used for simple and interactive notifications.

It complements the high-level reference in `docs/backend-api.md` (see the **Notifications** section there for endpoint placement and common fields).

## HTTP: `/api/notifications`

Base path: `/api/notifications`

### GET `/`

List persisted notifications for the authenticated user:

- Response:
  ```jsonc
  {
    "notifications": [
      {
        "id": "n_...",
        "title": "API Key Request",
        "message": "Please approve or deny...",
        "notification_type": "info",
        "timestamp": "2025-01-01T12:00:00.000Z",
        "session_id": "abc123",
        "is_active": true,
        "read": false,

        // Interactive metadata (optional)
        "actions": [
          { "key": "approve", "label": "Approve", "style": "primary", "requires_inputs": ["api_key"] },
          { "key": "deny", "label": "Deny", "style": "secondary" }
        ],
        "inputs": [
          { "id": "api_key", "label": "API Key", "type": "secret", "required": true }
        ],

        // Optional response summary for already-resolved notifications
        "response": {
          "at": "2025-01-01T12:05:00.000Z",
          "user": "alice",
          "action_key": "approve",
          "action_label": "Approve",
          "inputs": {
            // Only non-secret inputs appear here
            "comment": "Looks good"
          },
          "masked_input_ids": ["api_key"]
        }
      }
    ]
  }
  ```

- Notes:
  - The persisted object always includes the basic notification fields plus optional interactive metadata.
  - Callback metadata (`callback_url`, `callback_method`, `callback_headers`) is **not** exposed via this API.
  - `response.inputs` never contains values for masked/secret inputs; those are tracked only by `masked_input_ids`.

### POST `/`

Create a simple or interactive notification. See `docs/backend-api.md` for full request validation details.

- Simple notifications:
  - Required: `title`, `message`.
  - Optional: `type`, `sound`, `session_id`.
  - Behavior:
    - Without `session_id`, the notification is created only for the caller.
    - With `session_id`, requires `broadcast` permission and delivers to the session owner and currently attached users.

- Interactive notifications:
  - Extend the simple body with:
    - `callback_url` (required when interactive fields are present; `http|https` only).
    - `callback_method` (`POST|PUT|PATCH`, default `POST`).
    - `callback_headers` (object; used only for the backend-to-backend callback).
    - `inputs`: array of `{ id, label, type, required, placeholder?, max_length? }`.
    - `actions`: array of `{ key, label, style?, requires_inputs? }`.
  - A notification is considered interactive when:
    - `callback_url` is provided **and**
    - at least one of `actions` or `inputs` is a non-empty array.
  - Validation:
    - `actions` and `inputs` (when present) must be non-empty arrays of well-formed objects.
    - `inputs[].type` must be `"string"` or `"secret"`.
    - `inputs[].max_length` (when present) must be a positive integer; values are clamped to a safe maximum.
    - Every id in `actions[].requires_inputs` must refer to an existing `inputs[].id`.

- Responses:
  - User-scoped:
    ```jsonc
    {
      "saved": {
        "id": "n_...",
        "title": "...",
        "message": "...",
        "notification_type": "info",
        "timestamp": "...",
        "session_id": null,
        "is_active": true,
        "read": false,
        "actions": [ /* if interactive */ ],
        "inputs": [ /* if interactive */ ],
        "response": null
      }
    }
    ```
  - Broadcast:
    ```jsonc
    {
      "recipients": ["alice", "bob"],
      "saved": [
        { "id": "n_...", "title": "...", "actions": [/* ... */], "inputs": [/* ... */], "response": null },
        { "id": "n_...", "title": "...", "actions": [/* ... */], "inputs": [/* ... */], "response": null }
      ]
    }
    ```
  - Callback metadata (`callback_url`, `callback_method`, `callback_headers`) is not included in the JSON response.

### PATCH `/mark-all-read`, PATCH `/:id`, DELETE endpoints

These endpoints continue to work as before; interactive metadata and `response` are treated as regular fields on the notification objects:

- `PATCH /mark-all-read` — marks all notifications as read for the current user.
- `PATCH /:id` — marks a single notification as read.
- `DELETE /` — clears all notifications for the current user.
- `DELETE /:id` — deletes a single notification.

Interactive notifications keep their `response` summaries even after being marked as read.

## WebSocket Messages

Notifications are delivered and resolved over the existing WebSocket connection (see `docs/backend-api.md` for connection details).

### Server → client: `notification`

Each persisted notification may be delivered over WebSocket:

```jsonc
{
  "type": "notification",
  "user": "alice",

  "title": "API Key Request",
  "message": "Please approve or deny...",
  "notification_type": "info",
  "session_id": "abc123",
  "server_id": "n_...",        // persistent notification id
  "is_active": true,
  "timestamp": "2025-01-01T12:00:00.000Z",
  "sound": true,

  // Interactive metadata (safe subset)
  "actions": [
    { "key": "approve", "label": "Approve", "style": "primary", "requires_inputs": ["api_key"] },
    { "key": "deny", "label": "Deny", "style": "secondary" }
  ],
  "inputs": [
    { "id": "api_key", "label": "API Key", "type": "secret", "required": true }
  ],

  // Optional response summary for already-resolved notifications
  "response": {
    "at": "2025-01-01T12:05:00.000Z",
    "user": "alice",
    "action_key": "approve",
    "action_label": "Approve",
    "inputs": {},
    "masked_input_ids": ["api_key"]
  }
}
```

Backend-only fields (`callback_url`, `callback_method`, `callback_headers`) are not present in WS messages.

### Client → server: HTTP `POST /api/notifications/:id/action`

New clients submit interactive notification actions over HTTP:

```http
POST /api/notifications/n_.../action
Content-Type: application/json

{
  "action_key": "approve",
  "inputs": {
    "api_key": "sk-...",        // may include masked & non-masked values
    "comment": "Looks good"
  }
}
```

Semantics:

- The backend infers the user from the HTTP auth context (`req.user.username`).
- It loads the notification from `NotificationManager` for that user and id.
- Validates:
  - Notification exists and is interactive.
  - No prior `response` has been recorded (single-use semantics).
  - `action_key` exists.
  - All required inputs (global `required` or action-specific `requires_inputs`) are present and non-empty.
  - Value lengths respect configured `max_length` constraints (long values are truncated to safe limits).
- Constructs a callback payload and invokes the configured callback URL.

Callback HTTP payload:

```jsonc
{
  "notification_id": "n_...",
  "user": "alice",
  "action": "approve",
  "action_label": "Approve",
  "inputs": {
    "api_key": "sk-...",        // includes masked & unmasked values
    "comment": "Looks good"
  },
  "session_id": "abc123",
  "title": "API Key Request",
  "message": "Please approve or deny...",
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

- Method: `callback_method` (default `POST`).
- Headers:
  - Always includes `Content-Type: application/json; charset=utf-8`.
  - Includes any configured `callback_headers` entries.
- Outcome:
  - 2xx status codes → treated as success.
  - Non-2xx or network errors → treated as failure; logged with notification id, user, action, and callback URL.

After the callback attempt, the backend persists a `response` summary in `NotificationManager`:

- `inputs`: only non-masked values.
- `masked_input_ids`: ids of any secret-type inputs that had values.
- `is_active` on the notification is set to `false`.

Response body from HTTP endpoint:

```jsonc
{
  "ok": true,
  "status": "callback_succeeded",
  "response": {
    "at": "2025-01-01T12:05:00.000Z",
    "user": "alice",
    "action_key": "approve",
    "action_label": "Approve",
    "inputs": {
      "comment": "Looks good"
    },
    "masked_input_ids": ["api_key"]
  }
}
```

On error, `ok` is `false`, `status` is one of `notification_not_found`, `invalid_payload`, `invalid_action`, `missing_required_inputs`, `not_interactive`, `already_responded`, `callback_failed`, and `error` carries a machine-readable code such as `HTTP_403`, `NETWORK_ERROR`, or `TIMEOUT`.

### Legacy client → server: `notification_action` (WebSocket)

For backwards compatibility, the backend still accepts a WebSocket message of the form:

```jsonc
{
  "type": "notification_action",
  "notification_id": "n_...",
  "action_key": "approve",
  "inputs": { "api_key": "sk-...", "comment": "Looks good" }
}
```

New clients should prefer the HTTP endpoint; the WS entry point exists primarily for older frontends.

### Server → client: `notification_action_result`

The backend acknowledges every `notification_action` with a result message:

```jsonc
{
  "type": "notification_action_result",
  "notification_id": "n_...",
  "action_key": "approve",
  "ok": true,
  "error": null,
  "status": "callback_succeeded",
  "http_status": 200
}
```

Common `status` values:

- `"callback_succeeded"` — callback returned a 2xx status.
- `"callback_failed"` — callback returned a non-2xx status or network error.
- `"already_responded"` — the notification already has a recorded response (single-use).
- `"not_interactive"` — the referenced notification is not interactive.
- `"notification_not_found"` — the notification id is unknown for this user.
- `"missing_required_inputs"` — one or more required inputs were missing or empty.
- `"invalid_action"` / `"invalid_payload"` — payload validation errors.
- Additional error codes in the `error` field may include:
  - `"HTTP_<status>"` — callback completed with a non-2xx HTTP status (e.g., `HTTP_500`).
  - `"NETWORK_ERROR"` — network failure reaching the callback URL.
  - `"TIMEOUT"` — callback did not respond within the backend timeout window.

The optional `http_status` field:

- When present, reflects the numeric HTTP status code returned by the callback.
- It is `null` when the request did not produce a response (e.g., network error or timeout).

Frontends can use these result messages to:

- Disable action buttons after a successful response.
- Show inline error messages or follow-up toasts when callbacks fail.
- Update the Notification Center view to reflect the chosen action and non-secret inputs.

### Server → client: `notification_updated`

When an interactive notification is canceled (or otherwise updated in a way that changes its interactivity or response metadata), the backend broadcasts a lightweight update message:

```jsonc
{
  "type": "notification_updated",
  "notification_id": "n_...",
  "is_active": false,
  "response": {
    "at": "...",
    "user": "system",
    "action_key": null,
    "action_label": "Canceled",
    "status": "canceled",
    "inputs": {}
  }
}
```

Notes:

- `notification_id` matches the backend notification id and the `server_id` field in the original `notification` message.
- `is_active` reflects whether the notification is still actionable; cancellations set this to `false`.
- `response` mirrors the persisted summary stored by `NotificationManager` and may include:
  - `at`, `user`, `action_key`, `action_label`, `status`, `inputs`, `masked_input_ids`.

Frontends are expected to:

- Locate any active toast whose `server_id === notification_id` and, when `is_active === false` or `response.status === "canceled"`:
  - Mark the interactive state as resolved.
  - Clear any pending action state.
  - Disable action buttons and optionally auto-dismiss the toast.
- In the Notification Center:
  - Update the stored `response` and set the entry as non-interactive.
  - Render a summary such as `Responded — Canceled — <time>` using the existing response summary UI.
