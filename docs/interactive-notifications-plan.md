# Interactive Notifications & Callback Workflow Plan

## Overview

This document describes a plan to extend the existing notification system with **interactive notifications** that:

- Allow the backend to request user input (e.g., _Approve / Deny_ and an API key).
- Surface actions and inputs as buttons/fields on the toast UI.
- Send the user’s choice and inputs back to the backend over WebSocket.
- Let the backend invoke a **callback URL** with the collected parameters.
- Persist a **safe, non‑secret** history entry in the Notification Center.

The plan preserves existing behavior for simple notifications and reuses the current persistence / WebSocket infrastructure wherever possible.


## Current Behavior (Baseline)

### Backend

- **Persistence**
  - `NotificationManager` (`backend/managers/notification-manager.js`) stores notifications per user in `${DATA_DIR}/notifications.json`.
  - Stored fields:
    - `id`, `title`, `message`, `notification_type`, `timestamp`, `session_id`, `is_active`, `read`.
  - Retention:
    - Max 30 days per item.
    - Max 500 items per user (newest first).

- **Public HTTP API**
  - `POST /api/notifications` in `backend/routes/notifications.js`:
    - Body (today): `{ type?, title, message, sound?, session_id? }`.
    - When `session_id` is present, requires `broadcast` permission and delivers to session owner + attached users.
    - Persists via `NotificationManager.add()` and broadcasts a WebSocket message:
      ```jsonc
      {
        "type": "notification",
        "user": "<username>",
        "title": "...",
        "message": "...",
        "notification_type": "info|warning|error|success",
        "session_id": "... or null",
        "server_id": "<notification-id>",
        "is_active": false,
        "timestamp": "...",
        "sound": true|false
      }
      ```
  - Notifications CRUD API under `/api/notifications` (`backend/routes/notifications.js`):
    - `GET /api/notifications` – list persisted notifications.
    - `PATCH /api/notifications/mark-all-read` – mark all as read.
    - `PATCH /api/notifications/:id` – mark as read.
    - `DELETE /api/notifications` – clear all.
    - `DELETE /api/notifications/:id` – delete one.

- **WebSocket**
  - All WS connections are tracked in `ConnectionManager`.
  - Server sends `type: 'notification'` messages through `ConnectionManager.broadcast(...)` with `message.user` set to the username so only that user’s clients receive it.
  - No WebSocket message exists today for “notification action” from client → server.


### Frontend

- **Toast display**
  - `NotificationDisplay` (`frontend/public/js/utils/notification-display.js`) is responsible for:
    - Rendering a toast for each notification.
    - Automatically recording notifications into the Notification Center.
    - Auto‑dismissing toasts after a duration determined by type.
  - `handleNotification(notification)`:
    - Normalizes type, calls `show(notification, { duration: getDurationForType(type), recordInCenter: true })`.
  - `show(notification, options)`:
    - Records notification into the Notification Center via `notificationCenter.addNotification(...)`.
    - Applies user preferences from `preferences.notifications` (global enabled + per‑level `show`).
    - Creates DOM structure with:
      - Title, message, session link/badge, timestamp.
      - A “Server / Local” source badge based on `server_id`.
    - Auto‑dismisses after `config.duration > 0`.

- **Notification Center**
  - Implemented in `frontend/public/js/modules/notification-center/notification-center.js`.
  - `addNotification(notification)` stores:
    - `id` (client‑side), `title`, `message`, `type`, `timestamp`, `sessionId`, `isActive`, `read`, `serverId`, `origin`.
  - Handles mark‑read / delete via `apiService` endpoints on `/api/notifications`.
  - Currently unaware of any “actions” or “inputs” – notifications are informational history only.

- **WebSocket handling**
  - WS messages are dispatched via `WebSocketService` + MessageHandlerRegistry.
  - `notification` messages:
    - `NotificationHandler` (`frontend/public/js/modules/websocket/handlers/notification-handler.js`) delegates to the Terminal Manager.
    - `TerminalManager.handleNotification(...)`:
      - Delegates to `notificationDisplay.handleNotification(notification)`.
      - Plays sounds when `notification.sound` is true and user preferences allow.

- **Notification preferences / settings**
  - UI in `frontend/public/index.html`:
    - `Show notifications` (`#notifications-enabled`).
    - `Play notification sounds` (`#notifications-sound`).
    - `Show scheduled/remote input toasts` (`#notifications-scheduled-input-show`).
    - Per‑level Show/Sound for `info|success|warning|error`.
  - Managed by `SettingsManager` (`frontend/public/js/modules/settings/settings-manager.js`):
    - Stored as `preferences.notifications` in `appStore`.
    - Additional `preferences.notifications.showScheduledInput` is used specifically by the `stdin_injected` handler.


## Goals & Non‑Goals

### Goals

- Allow API clients to create **interactive notifications** via `POST /api/notifications` that:
  - Define a small set of actions (e.g., `request` / `deny`).
  - Define optional input fields (e.g., API key text field, with mask semantics).
  - Provide a callback URL for the backend to call after the user responds.
- Implement a WebSocket round‑trip so the **user response flows back** to the backend:
  - Client → server WS message with `notification_id`, `action_key`, and input values.
  - Server → external callback HTTP request with a clear JSON contract.
- Ensure **single‑use semantics**:
  - Each interactive notification can only be responded to once.
  - Subsequent action attempts are rejected and reflected in the UI.
- Update the Notification Center so interactive notifications:
  - Are visible as history entries with the **selected action** and any **non‑secret** inputs.
  - Masked inputs are never stored or displayed in history.
- Add a UI preference to **persist interactive notifications**:
  - When enabled, interactive toasts stay on screen until dismissed or completed.

### Non‑Goals

- No general form builder / multi‑step wizard: we limit to a small number of actions plus simple text inputs.
- No direct callback invocation from the browser; callbacks are always invoked from the backend.
- No change to the existing `/api/notifications` listing or mark‑read/delete semantics beyond optional extra fields and response summaries.
- No changes to ntfy.sh integration other than including interactive notifications in the same pipeline (ntfy.sh will still only receive title/message).


## Data Model & Schemas

### 1. HTTP Request: `POST /api/notifications`

We extend the existing request body with optional interactive fields while keeping the current shape valid.

#### Existing fields

- `type` (string, optional)
  - `info` | `warning` | `error` | `success` (default `info`).
- `title` (string, required)
- `message` (string, required)
- `session_id` (string, optional)
  - When present, requires `broadcast` permission; notification is delivered to session owner + currently attached users.
- `sound` (boolean, optional)
  - When true, frontend may play a notification sound subject to user preferences.

#### New interactive fields

All interactive fields are **optional**. A notification becomes “interactive” when at least one of `actions` or `inputs` is present and `callback_url` is provided.

- `callback_url` (string, optional)
  - HTTPS/HTTP URL that the backend will `POST`/`PUT` to when the user responds.
  - Required if `actions` or `inputs` are provided.
  - Backend validates:
    - Scheme is `http` or `https`.
    - Non‑empty and reasonably sized.

- `callback_method` (string, optional)
  - One of: `POST` (default), `PUT`, possibly `PATCH`.
  - Case‑insensitive; normalized server‑side.

- `callback_headers` (object, optional)
  - Map of header name → header value (both strings).
  - Used only for the callback HTTP request.
  - Not exposed to the frontend.

- `inputs` (array, optional)
  - Each input field has:
    ```jsonc
    {
      "id": "api_key",           // required, unique per notification
      "label": "API Key",        // required
      "type": "string",          // "string" | "password"
      "required": true,          // default false
      "placeholder": "sk-...",   // optional
      "max_length": 4096         // optional, server-side validation cap
    }
    ```
  - `type: "password"` indicates:
    - The UI must render a masked input field.
    - The backend must **not persist the value** in NotificationManager or Notification Center history.
    - The value may be forwarded in the callback HTTP request payload only.

- `actions` (array, optional)
  - Each action represents a button the user can click:
    ```jsonc
    {
      "key": "request",          // required, stable identifier
      "label": "Request",        // required, button text
      "style": "primary",        // optional, "primary" | "secondary" | "danger"
      "requires_inputs": ["api_key"] // optional array of input ids
    }
    ```
  - `key` must be unique within the notification.
  - `requires_inputs`:
    - List of input `id`s that must be provided before this action can be sent.
    - The frontend will disable the button until required fields are non‑empty.
    - The backend will also validate required inputs before invoking the callback.

#### Derived “interactive” flag

The backend does not need an explicit `interactive: true` flag. A notification is considered interactive when:

- `callback_url` is present **and**
- `actions` is a non‑empty array **or** `inputs` is a non‑empty array.


### 2. Backend Persistence (`NotificationManager`)

We extend the internal notification shape. Persisted notifications will include interactive metadata and a response summary, with secrets excluded.

#### Stored notification object (per user)

```js
{
  id: string,
  title: string,
  message: string,
  notification_type: string,   // "info" | "warning" | ...
  timestamp: string,           // ISO string
  session_id: string | null,
  is_active: boolean,
  read: boolean,

  // New interactive metadata (optional)
  callback_url: string | null,         // stored, but never exposed to clients
  callback_method: string | null,
  actions: Array<ActionDef> | null,
  inputs: Array<InputDef> | null,

  // New response record (optional)
  response: {
    at: string,                        // ISO timestamp
    user: string,                      // username who responded
    action_key: string,                // one of actions[].key
    action_label: string | null,       // convenience copy for display
    inputs: Record<string, string>,    // ONLY non-masked inputs
    masked_input_ids: string[]         // ids whose values were supplied but not stored
  } | null
}
```

Notes:

- `callback_url` is stored server‑side for auditability and potential retries; it is **never** sent to the client in WS messages or REST responses.
- `inputs` and `actions` definitions are stored so that:
  - Future UI improvements / history views can re‑render the interactive shape.
  - Notification Center can show which fields existed and which were required.
- `response.inputs` captures only unmasked (`type: "string"`) values.
  - For masked inputs, the server stores only the `masked_input_ids` list.


### 3. WebSocket Message Shapes

These are internal protocol details (not part of the public HTTP API doc) but are central to the plan.

#### Server → client: `notification`

Existing fields continue; we add optional interactive metadata, with sensitive fields removed:

```jsonc
{
  "type": "notification",
  "user": "alice",

  "title": "API Key Request",
  "message": "Please approve or deny and provide an API key.",
  "notification_type": "info",
  "session_id": "abc123",
  "server_id": "n_...",          // persistent notification id
  "is_active": true,
  "timestamp": "2025-01-01T12:00:00.000Z",
  "sound": true,

  // Interactive metadata (safe subset)
  "actions": [
    { "key": "approve", "label": "Approve", "style": "primary", "requires_inputs": ["api_key"] },
    { "key": "deny", "label": "Deny", "style": "secondary" }
  ],
  "inputs": [
    { "id": "api_key", "label": "API Key", "type": "password", "required": true }
  ],

  // Optional response summary for already-resolved notifications
  "response": {
    "action_key": "approve",
    "action_label": "Approve",
    "at": "2025-01-01T12:05:00.000Z",
    "inputs": {},                    // no non-masked inputs in this example
    "masked_input_ids": ["api_key"]
  }
}
```

The server **does not** send:

- `callback_url`
- `callback_method`
- `callback_headers`

#### Client → server: `notification_action`

When a user clicks an interactive action button on the toast:

```jsonc
{
  "type": "notification_action",
  "notification_id": "n_...",       // server_id from WS notification
  "action_key": "approve",
  "inputs": {
    "api_key": "sk-..."             // includes masked and non-masked values
  }
}
```

Server uses the WS connection to infer the `username` (from `ws.username`).

#### Server → client: `notification_action_result`

Acknowledgment or error after processing an action:

```jsonc
{
  "type": "notification_action_result",
  "notification_id": "n_...",
  "action_key": "approve",
  "ok": true,
  "error": null,
  "status": "callback_succeeded"     // or "callback_failed", "already_responded", etc.
}
```

The frontend can use this to:

- Disable buttons after a successful response.
- Optionally show a small follow‑up toast with the outcome.


### 4. Callback HTTP Request Payload

For each interactive notification, once the user selects an action and submits any inputs, the backend will invoke the callback URL.

Payload shape:

```jsonc
{
  "notification_id": "n_...",
  "user": "alice",
  "action": "approve",               // action_key
  "action_label": "Approve",
  "inputs": {
    "api_key": "sk-..."              // includes masked & unmasked values
  },
  "session_id": "abc123",            // when original notification had session_id
  "title": "API Key Request",        // original notification title
  "message": "Please approve or deny...", // original message
  "timestamp": "2025-01-01T12:00:00.000Z" // original notification timestamp
}
```

Behavior:

- Method: `callback_method` (default `POST`).
- Headers:
  - `Content-Type: application/json; charset=utf-8`
  - Any user‑supplied `callback_headers` (merged carefully to avoid overriding `Content-Type` unless explicitly requested).
- Failure handling:
  - On non‑2xx or network error:
    - Log an error including notification id, user, action, and callback URL (excluding secrets).
    - Send `notification_action_result` with `ok: false` and a human‑readable `status`.
    - Do **not** retry automatically for now (keep behavior predictable; retries can be added later).


## Backend Changes

### 1. Extend `NotificationManager`

- Update `_coerceList(payload)` to:
  - Accept older data with no interactive fields.
  - When `payload.notifications` items include interactive fields, normalize:
    - `actions` as an array of `{ key, label, style?, requires_inputs? }`.
    - `inputs` as an array of `{ id, label, type?, required?, placeholder?, max_length? }`.
    - `response` as described above, if present.

- Update `add(username, payload)` to:
  - Accept interactive fields in `payload`:
    - `callback_url`, `callback_method`, `callback_headers`, `actions`, `inputs`.
  - Normalize and persist them as part of the stored notification.
  - **Not** set a `response` initially.

- Consider adding helper methods for interactive notifications:
  - `getById(username, id)` – fetch the notification object for a user.
  - `setResponse(username, id, response)` – write the response object, set `is_active = false`, and schedule save.


### 2. Extend `POST /api/notifications` (system router)

- Validation:
  - `title` / `message` remain required.
  - `type` validation unchanged (`info|warning|error|success`).
  - If any interactive fields (`actions`, `inputs`, `callback_url`, `callback_method`, `callback_headers`) are present:
    - Require `callback_url`.
    - Validate `callback_url` scheme and length.
    - Validate `actions` array (if present):
      - Non‑empty array, each item has `key` and `label`.
      - Keys are unique.
    - Validate `inputs` array (if present):
      - Non‑empty array of objects with `id` and `label`.
      - Enforce `type` ∈ `{ "string", "password" }` (default `"string"`).
      - Enforce reasonable `max_length` caps.
    - Validate `requires_inputs` for each action:
      - All referenced ids exist in `inputs`.

- Persistence:
  - When constructing `saved` via `NotificationManager.add`:
    - Include interactive fields:
      ```js
      const saved = notificationManager.add(username, {
        title,
        message,
        notification_type: type,
        timestamp: now,
        session_id,
        is_active: true,
        callback_url,
        callback_method,
        callback_headers,
        actions,
        inputs
      });
      ```

- Broadcast:
  - Include `actions` and `inputs` in the WS message payload.
  - Exclude `callback_url`, `callback_method`, `callback_headers`.
  - For non‑interactive notifications, behavior is unchanged.

- Response:
  - For interactive notifications, return `saved` including `id` and interactive metadata (excluding callback headers).
  - For non‑interactive notifications, continue returning current `saved` / `recipients` shapes.


### 3. WebSocket handler: `notification_action`

Add a new handler in `backend/websocket/handlers.js`:

- Expected payload:
  - `notification_id` (string, required).
  - `action_key` (string, required).
  - `inputs` (object map, optional).

- Steps:
  1. Identify username from `ws.username` for `clientId`.
  2. Look up the notification via `NotificationManager.getById(username, notification_id)`.
  3. Validate:
     - Notification exists and is interactive.
     - No prior `response` recorded (enforce single‑use).
     - `action_key` exists in `notification.actions`.
     - All `requires_inputs` for that action are present and non‑empty in `inputs`.
     - Respect `max_length` and type for each input; truncate/validate server‑side.
  4. Construct callback payload with all inputs (including masked).
  5. Invoke callback URL via `fetch`:
     - Apply `callback_method` and `callback_headers`.
  6. Determine outcome (`ok` / `error`, `status` string).
  7. Persist response:
     - Store `response` in the notification:
       - `inputs` only for non‑masked fields.
       - `masked_input_ids` for fields with `type: "password"` that were present.
       - Set `is_active = false`.
  8. Send `notification_action_result` to:
     - The requesting client.
     - Optionally broadcast to all of the user’s connected clients so other windows can update the toast / notification list.


### 4. Notifications CRUD API (history)

No changes to endpoints are required, but list responses will now include interactive fields and an optional `response` object:

- `GET /api/notifications`:
  - Each notification may include `actions`, `inputs`, `response`, etc.
  - Masked input values are not included; only `masked_input_ids` and non‑masked `response.inputs` are returned.

Mark‑read / delete behavior remains unchanged.


## Frontend Changes

### 1. Toast UI for Interactive Notifications

Extend `NotificationDisplay.createElement(id, notification)`:

- Detect interactive notifications:
  - `const hasActions = Array.isArray(notification.actions) && notification.actions.length > 0;`
  - `const hasInputs = Array.isArray(notification.inputs) && notification.inputs.length > 0;`
  - If neither is true, render current simple layout.

- Render inputs:
  - For each `notification.inputs` entry:
    - Render a label + input field.
    - `type: "string"` → `<input type="text">` (or `<textarea>` if we want multi‑line later).
    - `type: "password"` → `<input type="password">`.
    - Include `required` indicators in the UI (e.g., asterisk).
  - Track DOM nodes keyed by `input.id` for later value collection.

- Render actions:
  - For each `notification.actions` entry:
    - Render a button in the toast footer, styled by `style` (`primary`, `secondary`, `danger`).
  - Disable buttons when required inputs are missing or while a submission is in progress.

- Wire click handlers:
  - On button click:
    - Gather all input values into an object `inputs[id] = value`.
    - Perform **client‑side validation**:
      - For each `requires_inputs` id, ensure a non‑empty value is present.
    - Call `getContext().websocketService.send('notification_action', { notification_id: notification.server_id, action_key: action.key, inputs })`.
    - Mark the toast as “pending” (e.g., disable buttons, show small spinner or text).

- Handling `notification_action_result`:
  - Add a new WS handler that:
    - If `ok: true`:
      - Update the toast to show the chosen action (e.g., “Approved” / “Denied”).
      - Disable all action buttons.
      - If `persistInteractive` is off, auto‑dismiss after a short delay.
    - If `ok: false`:
      - Re‑enable buttons.
      - Optionally show an inline error message or a secondary toast with the `status`.


### 2. Persist Interactive Notifications Setting

- **Settings UI** (Notifications section in `frontend/public/index.html`):
  - Add a checkbox:
    - `id="notifications-persist-interactive"`.
    - Label: “Keep interactive notifications on screen”.
    - Help text: “When enabled, interactive notifications stay visible until you dismiss them or complete the action.”

- **SettingsManager**:
  - Add element reference:
    - `notificationsPersistInteractive: document.getElementById('notifications-persist-interactive')`.
  - Add change handler:
    - On change, store `preferences.notifications.persistInteractive` in `appStore`.
  - Include in `saveSettings()`:
    - Under `preferences.notifications`, add `persistInteractive: !!this.elements.notificationsPersistInteractive?.checked`.
  - Add default in `defaultSettings.preferences.notifications`:
    - `persistInteractive: false`.

- **Applying setting in NotificationDisplay**:
  - In `handleNotification(notification)` / `show()`:
    - Determine if the notification is interactive (`hasActions || hasInputs`).
    - Read `persistInteractive` from `preferences.notifications`.
    - When interactive and `persistInteractive === true`, override the duration:
      - `duration = 0` (no auto‑dismiss).
    - Otherwise, keep the existing type‑based duration.


### 3. Notification Center History for Interactive Items

Update `NotificationCenter.addNotification(notification)` so that:

- It accepts extra fields:
  - `actions`, `inputs`, `response`.
  - It stores a **summary** / normalized shape in the internal `notifications` array, for example:
    ```js
    {
      id,
      title,
      message,
      type,
      timestamp,
      sessionId,
      isActive,
      read,
      serverId,
      origin,

      // new:
      interactive: !!(Array.isArray(notification.actions) && notification.actions.length),
      response: notification.response || null
    }
    ```

- Update the history item rendering to:
  - Show a small badge or icon when the notification is interactive.
  - If `response` exists:
    - Display the chosen action name (“Approved”, “Denied”) in a greyed‑out style.
    - List non‑masked inputs and their values in muted text (e.g., `comment: "Looks good"`).
    - For masked inputs:
      - Display only that a secret was provided (e.g., “API Key: ••• provided”), never the value itself.

No changes are required to mark‑read / delete UX.


### 4. Masked Inputs & Secret Handling

On the frontend:

- `type: "password"` inputs:
  - Use `<input type="password">`.
  - Do not log values to the console.
  - Treat them like other inputs for validation and enabling buttons.

On the backend:

- For masked fields:
  - Accept their values in `notification_action.inputs`.
  - Forward them in the callback payload.
  - Do **not** store them in NotificationManager or Notification Center.
  - Only record that a value was provided by adding the `id` to `response.masked_input_ids`.


## Security & Privacy Considerations

- All callbacks are invoked from the backend; the browser does not see `callback_url` or custom headers.
- Masked inputs are never stored in long‑term storage:
  - They are accepted transiently for the callback payload.
  - They are not written to `notifications.json`, not returned by `/api/notifications`, and not shown in the UI.
- Rate limiting:
  - Interactive notifications share the same WS connection and global limits as other messages.
  - We may consider adding a per‑notification action limit (e.g., ignore repeated actions after `response` is set).
- Validation:
  - We should reject callbacks with obviously malformed URLs or methods at API request time.
  - Input lengths should be clamped server‑side to avoid oversized callback payloads.


## Compatibility & Migration

- Existing notifications:
  - Remain valid; `_coerceList` will treat them as non‑interactive.
  - Existing `/api/notifications` clients can continue sending simple `title`/`message` bodies.
- Older frontends:
  - Will ignore unknown fields in `notification` WS messages and continue showing simple toasts.
  - Interactive metadata requires the updated frontend to be useful; backend logic should not depend on the response arriving.
- External API clients:
  - Can incrementally adopt interactive fields without breaking older deployments.


## Implementation Phases

1. **Schema & persistence**
   - Extend `NotificationManager` to support interactive metadata and `response`.
   - Update `_coerceList` and `add()` for the new fields.

2. **HTTP API enhancements**
   - Extend `POST /api/notifications` to accept interactive fields with full validation.
   - Update broadcast payloads to include actions/inputs (safe subset).
   - Keep non‑interactive behavior unchanged.

3. **WebSocket action handling**
   - Implement `notification_action` handler in `backend/websocket/handlers.js`.
   - Implement callback invocation with the specified payload.
   - Emit `notification_action_result` responses and update stored `response`.

4. **Frontend UI & settings**
   - Extend `NotificationDisplay` to render inputs and action buttons.
   - Wire WS send for `notification_action` and handler for `notification_action_result`.
   - Implement the “Persist interactive notifications” setting in the Notifications panel.
   - Update Notification Center to show resolved action + non‑secret inputs.

5. **Testing & documentation**
   - Add unit tests for:
     - `POST /api/notifications` validation and request shaping for interactive notifications.
     - `notification_action` handler behavior (happy path and failure cases).
   - Update `docs/backend-api.md` to document the extended `POST /api/notifications` body, focusing on the **public HTTP API**.
   - Optionally add a short “Interactive Notifications” subsection referencing this plan.
