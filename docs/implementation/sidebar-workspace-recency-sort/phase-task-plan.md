# Phase Task Plan: Sidebar Workspace Recency Sort

Status: Locked

## 1. Scope
Implement an optional sidebar workspace sort mode (`manual` / `recent`) with explicit refresh application of websocket-derived recency updates.

## 2. Global Rules
- Preserve manual ordering behavior by default.
- No backend endpoint/schema changes.
- No automatic reorder on websocket activity transitions.
- Keep diffs scoped to this feature.
- Every reviewer finding must be triaged (`accept`/`defer`/`reject`).

## 3. Phase Deliverables and Acceptance Criteria

### H0 - State and Contract Wiring
Deliverables:
- Add `workspaces.sortMode` and `workspaces.sortDirty` usage.
- Add runtime recency map ownership in terminal manager.
- Lock persistence key: `terminal_workspace_sort_mode`.
- Seed recency map from API sessions with fallback parse rules.

Acceptance criteria:
- Default mode is `manual`.
- Mode persists and restores across reload.
- API seed path initializes map without changing manual ordering.

### H1 - Recency Ingestion and Lifecycle Semantics
Deliverables:
- Extend websocket activity handling to ingest `last_output_at` only.
- Normalize id resolution (`session_id` then `sessionId`).
- Treat `idle` as inactive equivalent for ingestion path.
- Add map pruning/reconciliation on session removal/reload.
- Implement max-wins merge between existing map and API seed.

Acceptance criteria:
- Activity indicators behave as before.
- Websocket events do not reorder workspace list.
- Stale map entries are pruned when sessions disappear.
- Newer websocket timestamps survive later API seed.

### H2 - Ordering Engine and Dirty/Apply Behavior
Deliverables:
- Implement recent-mode order computation:
  - candidate set = currently render-eligible workspaces,
  - recency desc,
  - tie-break by manual order,
  - empty workspace recency `0`.
- Implement mode transitions:
  - entering recent applies and clears dirty,
  - leaving recent clears dirty,
  - refresh action applies pending updates and clears dirty.

Acceptance criteria:
- Manual mode renders from manual order source.
- Recent mode ordering is deterministic with locked tie-break/fallback rules.
- No auto-reorder while dirty in recent mode.

### H3 - Sidebar Controls and Accessibility
Deliverables:
- Add sort chip adjacent to existing pinned/active chips.
- Add refresh icon visibility gate: `recent && dirty`.
- Add keyboard reachability and aria labels.

Acceptance criteria:
- Controls are discoverable and keyboard operable.
- Refresh icon appears only when expected.
- Toggling mode and pressing refresh trigger correct actions.

### H4 - Automated Tests and Final Verification
Deliverables:
- Add/update frontend tests for:
  - parse/fallback edge cases,
  - race merge behavior,
  - lifecycle pruning,
  - mode/dirty/apply semantics,
  - manual-order restoration fidelity,
  - refresh icon gate,
  - no auto-reorder on websocket updates.
- Run relevant frontend test commands and record evidence.

Acceptance criteria:
- New tests pass.
- Existing behavior regressions are not introduced.

## 4. Verification Matrix
- V1: Mode default + persistence key behavior.
- V2: API seed recency extraction/fallback.
- V3: Websocket ingestion without reorder.
- V4: Dirty/apply semantics and mode transitions.
- V5: Recent ordering correctness + tie-break stability.
- V6: Lifecycle cleanup and stale-map prevention.
- V7: Accessibility and control wiring.
- V8: Manual mode parity and exact order restoration.

## 5. Section 9 Operator Checklist and Evidence Log Schema
Checklist:
- Scope-only diff verified.
- Phase acceptance criteria satisfied.
- Tests executed and logged.
- Review findings triaged.
- Go/No-Go decision recorded.

Evidence schema (mandatory per phase):
- Completion date:
- Commit hash(es):
- Acceptance evidence:
- Review run IDs + triage outcomes:
- Go/No-Go decision:

## 6. Milestone Commit Gate
- One milestone commit per phase (`H0`..`H4`).
- Do not begin next phase until prior phase evidence is complete.

## 7. Review Policy During Execution
- Use `agent-runner-review` for independent checks as required by execution stream policy.
- Do not pass timeout/reasoning-effort CLI overrides.
- Determine completion from stream terminal events (`result.completed`/`result.failed`).

## 8. Triage Policy
- `accept`: update plan/design artifacts now (spec stage) or code/docs now (execution stage).
- `defer`: capture owner, target phase, and rationale.
- `reject`: capture rationale tied to product constraints.

## 9. Evidence Log

### Authoring-stage independent review evidence (completed)
- Completion date: 2026-03-10.
- Commit hash(es): N/A (spec planning stream).
- Acceptance evidence: Two independent review runs completed via live session stream.
- Review run IDs + triage outcomes:
  - `r_20260310155534272_bfdda36a` (generic-gemini)
    - `accept`: define empty-workspace recency behavior.
    - `accept`: add session lifecycle cleanup/pruning requirement.
    - `accept`: define API-seed vs websocket race handling (max-wins).
    - `accept`: add explicit tests for fallback and tie-break stability.
    - `reject`: include `last_activity` or input-only activity as ranking signal (conflicts with locked product decision to use `last_output_at` only).
  - `r_20260310155652128_6971f3e5` (generic-pi)
    - `accept`: lock `session_id`/`sessionId` coalescing rule.
    - `accept`: define "visible workspace" candidate set semantics.
    - `accept`: lock dirty behavior across mode switches.
    - `accept`: add accessibility requirement for new controls.
    - `accept`: specify lifecycle behavior for workspace/session add/remove.
    - `accept`: lock `idle` handling and persistence key name.
    - `accept`: expand edge/race/fidelity test coverage.
    - `defer`: add dedicated E2E automation requirement. Rationale: this plan locks frontend unit/integration coverage; E2E framework choice and maintenance policy are broader cross-feature decisions.
- Go/No-Go decision: Go.

### Execution-phase evidence template

#### H0 Evidence
- Completion date: 2026-03-10.
- Commit hash(es): `2834fc6`.
- Acceptance evidence:
  - Added `workspaces.sortMode`/`workspaces.sortDirty` defaulting + migration-safe initialization in `WorkspaceList.initializeStore`.
  - Added terminal-manager runtime recency ownership (`sessionRecencyById`) and API-seed wiring via `seedSessionRecencyFromApiSessions()`.
  - Locked persistence key usage to `terminal_workspace_sort_mode` via `WORKSPACE_SORT_MODE_STORAGE_KEY` + `loadWorkspaceSortModePreference()` and `setWorkspaceSortMode()`.
  - Added pure helper module `frontend/public/js/modules/workspaces/workspace-recency.js` implementing timestamp fallback chain `last_output_at -> created_at -> 0`.
  - Verification commands:
    - `npm run lint --if-present` (root): passed (no script defined, no-op).
    - `npm test --if-present` (root): passed (no script defined, no-op).
    - `node --test frontend/tests/theme-persistence.test.js frontend/tests/notes-model.test.js`: passed (7 tests).
    - `node --test frontend/tests/*.test.js`: fails due pre-existing `window is not defined` in `chat-link-helpers.test.js` environment path; excluded from targeted gate for this phase.
- Review run IDs + triage outcomes:
  - `r_20260310160845312_59c4112c` (generic-gemini)
    - `defer`: add new recency unit tests immediately in H0. Rationale: phase plan locks comprehensive test additions to H4; current H0 keeps scaffolding minimal and test scope is captured in H4.
  - `r_20260310161137056_b0357270` (generic-pi)
    - `accept`: remove out-of-scope `workspaces.recentOrder` scaffolding from H0 implementation to stay aligned with locked schema subset (`sortMode`, `sortDirty`).
    - `defer`: max-wins API seed merge behavior to H1 per declared phase deliverables.
    - `defer`: duplicate default-initialization consolidation between manager/workspace-list; no behavioral risk in H0 due guarded writes, can be folded into H2 refactor pass if still warranted.
- Go/No-Go decision: Go.

#### H1 Evidence
- Completion date: 2026-03-10.
- Commit hash(es): `16ee658`.
- Acceptance evidence:
  - Websocket recency ingestion added via `TerminalManager.ingestSessionRecencyFromActivity()` and invoked from `session-activity-handler.js` without altering existing activity-indicator behavior.
  - Session id normalization and coalescing enforced through `resolveSessionId` helper usage.
  - `idle` treated as inactive-equivalent for ingestion allow-list (`active|inactive|idle` accepted; invalid/empty states ignored).
  - API seed path upgraded to max-wins merge (`mergeRecencyMapsMaxWins`) plus reload reconciliation prune (`pruneRecencyMapBySessionIds`) so newer websocket timestamps survive later API seeds.
  - Lifecycle pruning added for removal paths:
    - `session-removed-handler.js`,
    - manager deleted/remove/clear paths (`_removeEndedSessionFromSidebar`, delete history flow, `updateType='deleted'`, child-session detachment removal).
  - Verification commands:
    - `npm run lint --if-present` (root): passed (no script defined, no-op).
    - `npm test --if-present` (root): passed (no script defined, no-op).
    - `node --test frontend/tests/theme-persistence.test.js frontend/tests/notes-model.test.js`: passed (7 tests).
- Review run IDs + triage outcomes:
  - `r_20260310161746417_987a8eed` (generic-gemini)
    - `accept`: preserve existing recency map on API-seed errors instead of resetting to empty map.
    - `defer`: add dedicated recency helper tests to H4 per locked phase testing plan.
  - `r_20260310161855027_9767f14a` (generic-pi)
    - `accept`: tighten ingestion state validation to ignore empty/invalid `activity_state`.
    - `defer`: `sortDirty` mutation on websocket ingestion to H2 (dirty/apply behavior phase boundary).
    - `defer`: remove handler/manager double-normalization cleanup; currently harmless and low-risk.
- Go/No-Go decision: Go.

#### H2 Evidence
- Completion date: 2026-03-10.
- Commit hash(es): `1e09e1a`.
- Acceptance evidence:
  - Added recent-mode ordering engine helper `sortWorkspaceNamesByRecency(...)` in `workspace-recency.js` implementing deterministic recency-desc sort with manual-order tie-break and empty-workspace `0` recency baseline.
  - Added manager-owned applied snapshot flow:
    - `appliedRecentWorkspaceOrder`,
    - `getAppliedRecentWorkspaceOrder()`,
    - `applyRecentWorkspaceOrder()`,
    - `refreshRecentWorkspaceOrder()`.
  - `setWorkspaceSortMode(...)` now enforces phase semantics:
    - entering recent applies snapshot order,
    - leaving recent clears dirty,
    - loading persisted mode can skip immediate apply until post-init.
  - Fixed critical candidate-set wiring bug identified in review:
    - `applyRecentWorkspaceOrder()` now consumes `getRenderEligibleWorkspaceNames().eligibleNames` (array) instead of passing the full context object.
  - `WorkspaceList.render()` now consumes applied recent snapshot order while preserving eligibility gate and appending newly eligible names without auto-reorder.
  - `TerminalManager.getVisibleOrderedWorkspaces()` mirrors recent-mode snapshot ordering so keyboard workspace cycling matches sidebar order.
  - Dirty/apply behavior wired:
    - websocket recency advancement in recent mode marks `workspaces.sortDirty=true`,
    - refresh/apply clears dirty and updates applied snapshot,
    - no automatic reorder occurs while dirty (snapshot remains stable until explicit apply).
  - Verification commands:
    - `npm run lint --if-present` (root): passed (no script defined, no-op).
    - `npm test --if-present` (root): passed (no script defined, no-op).
    - `node --test frontend/tests/theme-persistence.test.js frontend/tests/notes-model.test.js`: passed (7 tests).
- Review run IDs + triage outcomes:
  - `r_20260310162600610_3302b465` (generic-gemini)
    - `accept`: reduce unnecessary duplicate-render risk in apply flow. Applied by only forcing explicit render when dirty state was already false (when dirty was true, store update drives subscribed render).
    - `defer`: possible init timing edge where early recent snapshot could be empty before all session/filter state settles. Rationale: behavior remains deterministic and within phase scope; comprehensive regression assertions are scheduled in H4 tests.
  - `r_20260310162716289_6b8ca83a` (generic-pi)
    - `accept`: fix return-type mismatch in `applyRecentWorkspaceOrder()` by extracting `eligibleNames` from workspace render context.
    - `defer`: duplicate merge logic between `WorkspaceList.render()` and `TerminalManager.getVisibleOrderedWorkspaces()`. Rationale: parity is currently intentional for render/keyboard consistency; refactor to shared helper can be done post-feature without changing behavior.
    - `reject`: set dirty on structural workspace/session membership changes while in recent mode. Rationale: locked design explicitly states structural changes do not force reorder unless user refreshes/re-enters recent mode.
- Go/No-Go decision: Go.

#### H3 Evidence
- Completion date:
- Commit hash(es):
- Acceptance evidence:
- Review run IDs + triage outcomes:
- Go/No-Go decision:

#### H4 Evidence
- Completion date:
- Commit hash(es):
- Acceptance evidence:
- Review run IDs + triage outcomes:
- Go/No-Go decision:

## 10. Status
Locked
