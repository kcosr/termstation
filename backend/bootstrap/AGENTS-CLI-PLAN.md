# Agents CLI Consolidation Plan

## Scope

- Consolidate these scripts into a single Node.js CLI (Commander):
  - `create_session.sh`
  - `list_agents.sh`
  - `send_to_peer_agent.sh`
  - `stop_peer_agent.sh`
- Exclude (unchanged):
  - `ws-echo-demo.sh`
  - `set_issue_id.sh` (kept separate; will be rewritten later)

## CLI Commands

- `agents create <agent> [message]`
- `agents list`
- `agents send <peer_id> [message]`
- `agents stop <peer_id> [--force]`

Output is human‑readable only (no JSON). Add a `--debug` flag for diagnostics.

## Environment and Rules

- Node 18+ (use global `fetch`)
- Require for all commands: `SESSIONS_API_BASE_URL`, `SESSION_ID`
- Require for `create`: `TERMSTATION_USER`
- Use env‑driven values for `REPO`, `ISSUE_ID`, `BRANCH`; title shaping via CLI `--description`
- No git remote fallback; no `glab` integration
- Message prefix: `Message from peer agent <SESSION_ID>: <message>`

## Architecture

- Entry point: `backend/bootstrap/bin/agents.mjs` (Commander wiring)
- Modules:
  - `config.mjs` — read/validate env, normalize API base URL, compute defaults
  - `apiClient.mjs` — HTTP helpers using Basic auth `webhooks:webhooks`
  - `io.mjs` — stdin reading, CRLF normalization, message prefix formatting
  - `errors.mjs` — small typed error helpers with exit codes

## Command Behavior Details

- create
  - Inputs: `<agent>`, optional `[message]` or stdin
  - Title selection (manual; no glab):
    - If `REPO` and `ISSUE_ID`: `<repo> #<issue_id>`
    - Else if `REPO`: `<repo>`
    - Else: `Session for <agent>`
    - If `--description` provided: append `: <description>` to the computed title
  - `BRANCH`: if unset and `ISSUE_ID` set → `issue/<ISSUE_ID>`
  - Template parameters include present values among: `prompt`, `repo`, `branch`, `issue_id`
  - Output: `Peer agent <session_id> is available`

- list
  - Filters via env: `REPO`, `ISSUE_ID`
  - If no filters: `GET /sessions`, else: `GET /sessions/search?scope=active&ids_only=false&param.repo=&param.issue_id=`
  - Exclude own `SESSION_ID`, sort by `created_at` ascending
  - Output: IDs only, one per line

- send
  - Inputs: `<peer_id>`, optional `[message]` or stdin
  - Prefix full message; CRLF → LF normalization
  - POST `/:id/input` with `{ data }`
  - Output: `Sent message to peer agent <peer_id>:` then the message content

- stop
  - Inputs: `<peer_id>`, optional `--force`
  - Disallow stopping self unless `--force`
  - DELETE `/:id`; success on HTTP 200/202/204
  - Output: clear success/failure messages (include status on failure)

## Migration

- Add Node CLI and package `bin` mapping (`agents`)
- Replace the four shell scripts with thin wrappers calling the CLI:
  - `create_session.sh` → `exec agents create "$@"`
  - `list_agents.sh` → `exec agents list "$@"`
  - `send_to_peer_agent.sh` → `exec agents send "$@"`
  - `stop_peer_agent.sh` → `exec agents stop "$@"`
- Leave `set_issue_id.sh` and `ws-echo-demo.sh` unchanged
- Update docs in `backend/files/AGENTS.md` to reference the new `agents` CLI while noting wrappers remain available
- Remove `backend/files/AGENTS-intro.md`

## Dependencies and Files

- Add dependency: `commander@^11.0.0`
- Files:
  - `backend/bootstrap/bin/agents.mjs`
  - `backend/bootstrap/lib/config.mjs`
  - `backend/bootstrap/lib/apiClient.mjs`
  - `backend/bootstrap/lib/io.mjs`
  - `backend/bootstrap/lib/errors.mjs`
  - `backend/package.json` updates for bin + dependency

## Testing

- Env validation: missing `SESSION_ID`, `SESSIONS_API_BASE_URL`, and `TERMSTATION_USER` (create) yield clear errors
- `list` with/without filters; ensure own session excluded
- `send` via arg and stdin; multi‑line handling
- `create` with/without `--description`, `REPO`, `ISSUE_ID`
- `stop` self vs non‑self, with and without `--force`

## Step Plan

1. Scaffold CLI entry and env validation
2. Implement API client and IO helpers
3. Implement list and stop
4. Implement send (stdin and prefix)
5. Implement create (manual title + defaults)
6. Wire package bin and shell wrappers
7. Update docs and remove AGENTS-intro.md
8. Update VERSION, commit, push, and create MR
