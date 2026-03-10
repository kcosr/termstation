# Sidebar Workspace Recency Sort

Status: Locked

## 1. Purpose
Define an optional sidebar workspace ordering mode that sorts workspaces by most recent session output timestamp, without live jitter from frequent websocket activity events.

## 2. Problem Statement
Current workspace ordering is manual (`workspaces.order`). Users want an alternate "recent" mode. Reordering on every websocket activity transition would cause constant movement and poor usability.

## 3. Goals
- Add toggleable workspace sort mode: `manual` and `recent`.
- Keep `manual` as default and preserve existing behavior.
- Use session `last_output_at` as recency signal.
- Ingest websocket recency updates without immediate reorder.
- Add explicit refresh/apply affordance in recent mode.
- Seed recency from API payload on page load.
- Ensure new controls meet baseline accessibility (keyboard reachable, labels/aria).

## 4. Non-Goals
- No backend API schema changes.
- No automatic workspace reorder on each websocket event.
- No changes to session ordering within workspace cards.
- No persistence of computed recent order to backend `workspaces.order`.
- No use of `last_activity` in ranking.

## 5. Current Baseline
- Workspace order is sourced from frontend store `workspaces.order`.
- Backend includes `last_output_at` in `/api/sessions` (`toResponseObject()`).
- Websocket `session_activity` includes `session_id|sessionId`, `activity_state`, `last_output_at`.
- Frontend activity handler updates indicators but does not currently maintain recency sort data.

## 6. Key Decisions
1. Recency signal lock
- Rank by `last_output_at` only.
- Fallback: `created_at`, then `0`.
- Explicitly reject "input-only activity" as recency source for this feature.

2. Event field normalization lock
- Session id resolution: prefer `session_id`; fallback to `sessionId`.
- `activity_state` of `idle` is treated equivalent to `inactive` for ingestion behavior.

3. Ingestion vs apply separation
- Keep in-memory `sessionRecencyById: Map<string, number>`.
- Websocket updates mutate this map only; no immediate reorder.
- Recent-mode unapplied updates set `workspaces.sortDirty=true`.

4. Dirty/apply semantics
- Entering `recent` mode computes order immediately from latest map and clears dirty.
- While in `recent`, subsequent websocket recency updates set dirty.
- Refresh action applies pending order and clears dirty.
- Leaving `recent` (`manual` mode) clears dirty.

5. Structural-change semantics
- Workspace/session create/delete/move updates continue to render list membership immediately.
- While in `recent`, structural changes do not force reorder unless user applies refresh (or explicitly re-enters recent mode).

6. Ordering semantics
- Workspace recency = max session recency in that workspace.
- Empty workspace recency = `0`.
- Sort order (recent mode): recency desc, stable tie-break by current manual order index.

7. Lifecycle + race handling
- Prune recency map entries when sessions are removed and during full session reload reconciliation.
- API seed merge is max-wins with existing map to prevent older API data from overwriting fresher websocket updates.

8. Persistence lock
- Persist mode key as `terminal_workspace_sort_mode`.
- Do not persist dirty flag or recency map.

## 7. Contract / HTTP Semantics
No endpoint additions or payload contract changes.

Consumed fields:
- `GET /api/sessions`: `session_id`, `workspace`, `created_at`, `last_output_at`.
- Websocket `session_activity`: `session_id|sessionId`, `activity_state`, `last_output_at`.

Frontend-only state:
- `workspaces.sortMode: 'manual' | 'recent'`
- `workspaces.sortDirty: boolean`
- Runtime `sessionRecencyById` map (not persisted)

## 8. Service / Module Design
Primary modules:
- `frontend/public/js/modules/terminal/manager.js`
  - Own recency map.
  - Seed/merge recency on API load.
  - Ingest websocket timestamp updates.
  - Persist/load `terminal_workspace_sort_mode`.
  - Expose explicit apply method for recent order recompute.
- `frontend/public/js/modules/workspaces/workspace-list.js`
  - Add sort chip + refresh affordance.
  - Resolve ordering source by mode.
  - In recent mode, compute order over currently visible candidate workspaces.
- `frontend/public/js/modules/websocket/handlers/session-activity-handler.js`
  - Keep indicator behavior unchanged.
  - Forward recency timestamp to manager ingestion helper only.

"Visible workspace" lock:
- Candidate set for recent sorting is the same workspace set currently eligible for sidebar render after active filters (pinned filter, active-workspace filter, template/search/pinned-session filters).

Manual reordering while recent mode:
- Existing manual reorder operations remain available.
- They update `workspaces.order` (manual source of truth) and are used as tie-break input in recent mode and full order in manual mode.

## 9. Error Semantics
- Invalid timestamp parse: ignore that value for update; retain prior map value.
- Unknown session id in websocket update: ignore safely.
- Missing workspace resolution for a session: skip contribution.
- Persistence read/write failure for mode key: fallback to in-memory default (`manual`).

## 10. Migration Strategy
- Additive frontend-only state.
- Default remains `manual`; no behavioral change for existing users unless they toggle mode.
- No backend migration.

## 11. Test Strategy
Automated frontend coverage:
- Timestamp parsing and comparison:
  - valid ISO,
  - invalid/null/empty,
  - fallback to `created_at`, then `0`.
- Workspace recency aggregation:
  - empty workspace -> `0`,
  - tie recency -> manual-order tie-break stability.
- Ingestion behavior:
  - websocket updates map but do not auto-reorder,
  - `idle` treated as inactive path,
  - unknown session id ignored.
- Race behavior:
  - websocket newer than API seed remains (max-wins merge).
- Lifecycle cleanup:
  - session delete/move/remove prunes stale map contribution.
- Mode/dirty behavior:
  - enter recent applies + clears dirty,
  - websocket updates in recent set dirty,
  - refresh applies + clears dirty,
  - switch back to manual restores exact manual order.
- UI behavior:
  - sort chip placement near existing chips,
  - refresh icon only when `recent && dirty`,
  - keyboard and ARIA labels for chip/refresh controls.

Manual verification:
- Multi-workspace interleaved activity with no auto-jump until refresh.
- Toggle `manual <-> recent` and confirm deterministic restoration.

## 12. Acceptance Criteria
- Manual mode remains behaviorally unchanged.
- Recent mode sorts by `last_output_at` with defined fallbacks and tie-break.
- Websocket activity updates recency cache without immediate reorder.
- Refresh affordance appears only for unapplied recent updates and applies once per click.
- No backend API changes.
- Automated tests cover edge cases, race handling, lifecycle cleanup, and mode semantics.

## 13. Status
Locked
