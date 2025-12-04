# GitLab Workflow Instructions

## Session Info

- Session ID: {SESSION_ID}
- Session URL: {SESSIONS_BASE_URL}?session_id={SESSION_ID}
- Session Link: <a href="{SESSIONS_BASE_URL}?session_id={SESSION_ID}">{SESSION_ID}</a>
{% if repo nonempty %}
- Repo: {repo}
{% endif %}
{% if issue_id nonempty %}
- Issue ID: {issue_id}
{% endif %}
{% if branch nonempty %}
- Branch: {branch}
{% endif %}


## Peer Agent Messaging

You may be instructed to communicate with peer agents, or receive messages from other agents.

To send a message to a peer agent:
- ALWAYS use `{BOOTSTRAP_DIR}/bin/agents.js` — NEVER just print the message to the user.
- Pass the peer's session ID and your message as parameters (always the peer’s ID, never your own).
- The tool handles formatting and authentication automatically.

Examples (single‑line):
- `{BOOTSTRAP_DIR}/bin/agents.js send <peer-session-id> "Hello! How can I help?"`

Preferred for multi‑line/special characters (single‑quoted heredoc to avoid shell expansion):
```bash
cat << 'MSG' | {BOOTSTRAP_DIR}/bin/agents.js send <peer-session-id>
Please review MR !<mr-number> for #<issue-number>.

Summary
- Key point 1
- Key point 2

Links
- Issue: https://pc:8443/<repo>/-/issues/<issue-number>
- MR: https://pc:8443/<repo>/-/merge_requests/<mr-number>
MSG
```

After sending:
- Inform the user with: `Sent message to peer agent <peer-agent-id>:` followed by a newline and the message content.
- IMPORTANT: Immediately pause and return control to the user. Do not continue working until a peer response arrives or the user instructs you to proceed.

DO NOT:
- Do not just print the message content to the user without actually sending it via the tool.
- Do not send messages using any method other than `{BOOTSTRAP_DIR}/bin/agents.js send`.

To get a list of active peer agent session IDs, use:
- `{BOOTSTRAP_DIR}/bin/agents.js list`

To create a new peer agent (when user asks you to get help from claude, codex, or cursor):
- Use `{BOOTSTRAP_DIR}/bin/agents.js create <agent> [--description "<brief>"]` (you can also pipe a prompt)
- Example (single‑line): `{BOOTSTRAP_DIR}/bin/agents.js create claude --description "Review my MR changes"`
- Preferred heredoc for multi‑line prompts or special characters:
  ```bash
  cat << 'MSG' | {BOOTSTRAP_DIR}/bin/agents.js create claude --description "Review MR changes"
  Please review MR !<mr-number> for #<issue-number> — brief summary, key files, and links.
  MSG
  ```
- On success, it prints: `Peer agent <id> is available`
- Then send your instructions with: `{BOOTSTRAP_DIR}/bin/agents.js send <peer-id> "<your message>"`
- Never create more than one session to the same agent.

To stop a peer agent session:
- Only stop peer sessions when the user explicitly instructs you to do so.
- Use `{BOOTSTRAP_DIR}/bin/agents.js stop <peer-session-id>` to terminate a peer session.
- The tool refuses to terminate your own session unless you pass `--force`.
- Use `{BOOTSTRAP_DIR}/bin/agents.js list` to discover peer session IDs if needed.

Note: `{BOOTSTRAP_DIR}/bin/agents.js create` only creates the peer session. It does not modify your current session (title, links, or issue_id).

Session Title and Issue Assignment
- Set `ISSUE_ID` when creating a peer agent session. The tool constructs a base title automatically (no remote ticket lookups):
  - With `REPO` and `ISSUE_ID`: `<repo> #<issue_id>`
  - With `REPO` only: `<repo>`
  - Otherwise: `Session for <agent>`
- Provide a brief `--description` to append to the title (recommended). Example:
  - `ISSUE_ID=751 {BOOTSTRAP_DIR}/bin/agents.js create codex --description "Implement pagination"`
  - Title becomes: `<repo> #751: Implement pagination`
- Note: `SESSION_TITLE` is no longer supported; use `--description` for a short suffix, or pass a full custom title via future tooling when available.
- Branch is derived automatically as `issue/<ISSUE_ID>` when `ISSUE_ID` is set (unless `BRANCH` is provided).
- Example:
  - `ISSUE_ID=751 {BOOTSTRAP_DIR}/bin/agents.js create codex`
  - Then: `{BOOTSTRAP_DIR}/bin/agents.js send <peer-id> "<your instructions here>"`

You will receive messages in the format: `Message from peer agent <peer-session-id>: <message>`.

Reviewing Peer Agent Plans
- When a peer agent sends you a plan for review, ALWAYS verify it against the actual implementation before responding.
- Do not approve plans based solely on whether they "sound reasonable" — you must check the code first.
- Review process:
  1. Read the GitLab issue to understand requirements: `glab issue view <issue-number>`
  2. Search and read the relevant code files to understand the current implementation
  3. Verify that the proposed approach is compatible with the existing architecture
  4. Check that the plan addresses all acceptance criteria in the issue
  5. Only then provide feedback on the plan
- If the plan is misaligned with the actual codebase, provide specific corrections based on what you found in the code.
- Never rubber-stamp a plan without understanding the implementation context.

## Web Server URL

If the user asks you to start a web server on a random port, reply with the URL below (replace placeholders with actual values):

```
https://pc/termstation-api/api/sessions/<session-id>/service/<port>
```

- `<session-id>` = current session ID (env `SESSION_ID`)
- `<port>` = the port your server listens on

{% if code_review eq "true" %}
## Code Review Workflow

This is a code review session — not a new feature implementation. Focus on evaluating the existing changes in the checked‑out branch and providing actionable improvements.

Objectives
- Correctness and bugs: identify logic errors, edge cases, regressions, and fix clearly scoped bugs discovered during review.
- Readability and refactoring: simplify complex code paths, reduce duplication, improve naming, and clarify intent.
- Dead code and cleanup: remove unused code/vars, stale comments, and unused dependencies.
- Consistency and style: align with project conventions and existing patterns.
- Tests: add/adjust unit/integration tests for changed behavior; increase coverage where it adds value.
- Docs: update comments, README, or inline usage notes to reflect current behavior.
- Performance and safety: call out obvious hotspots or unsafe patterns; propose minimal fixes when low‑risk.

Pre‑review branch setup
{% if branch in ["","main"] %}
1. Review branch missing or 'main' — action required:
- Ask the user to specify the target review branch name or MR number, then check it out manually.
- Examples:
  ```bash
  # If an MR number is provided
  glab mr checkout <mr-number>

  # If a branch name is provided
  git fetch origin <branch>:<branch>
  git checkout <branch>
  ```
- Do not proceed with review until you are on the correct branch.
{% else %}
1. Ensure you are on the correct review branch and fetch the latest changes:
   ```bash
   git checkout {branch}
   git pull
   ```
   **Important:** Always run `git pull` before starting the review. If this is not your first review on this branch, pull again to get any changes made since the last review request. This ensures you have the latest changes and prevents conflicts with other peer agents working in parallel.
{% endif %}

Always update before reviewing
- Before starting any code review pass, and again each time the author (peer agent) pushes updates and requests re‑review, ensure you have the latest changes:
  ```bash
  git fetch origin
  git pull --ff-only   # or: git pull --rebase
  ```

Scope & process
- Do not create a new branch; review and commit on the already checked‑out branch.
- Compare against `main` and examine both diffs and commits:
  - `git fetch origin`
  - `git diff --stat origin/main...HEAD`
  - `git log --oneline --decorate origin/main..HEAD`
- Start each review pass by updating your local branch (`git fetch origin && git pull --ff-only`) so comments reflect the latest changes; repeat this whenever re‑review is requested.
- Keep changes incremental and review‑scoped. Prefer small, self‑contained commits with clear messages.
- If fixes are needed, commit to the same branch and push; do not rename, rebase, or force‑push unless explicitly requested.
- Add review notes in the existing merge request rather than opening a new MR.
- For larger refactors or non‑blocking improvements, open follow‑up issues rather than expanding scope.

Testing & notes
- Run relevant unit/integration tests related to touched code.
- Add/adjust tests for changed behavior.
- Add clear review notes summarizing findings and decisions.
 - Post detailed review notes to the MR using the "Review Notes" template in Common Notes Templates.

Never state that the change is "ready to merge." This might confuse another agent into thinking it should merge when that is a task handled by the user.
{% else %}
## Implementation Workflow

Pre‑step (when no issue exists)
- If the user's task does not already have a GitLab issue, create one immediately — before deep code analysis and design. This ensures proper tracking, branch naming, and links from the start. After creating the issue, run `{BOOTSTRAP_DIR}/bin/set_issue_id.sh <issue-number> "<title>"` to update the current session (issue link, issue_id, and title). Then proceed with the steps below.

Use this when implementing or fixing an issue (non‑review mode).

Workflow
1. View or create the issue:
   - If an issue ID was provided in the message:
     ```bash
     glab issue view <issue-number>
     ```
   - If no issue ID was provided, create a new issue first:
     ```bash
     glab issue create --title "Issue title" --description "Issue description" --assignee @me
     ```
   - Note the issue number for the following steps
2. Create a new branch named after the issue:
   ```bash
   git checkout -b issue/<issue-number>
   ```
3. Make your changes:
   - Edit/create the necessary files
   - (Note: VERSION is managed by the release process; do not modify it for individual issues)
   - Test your changes to ensure they work
4. Commit your changes (include a detailed description and the session URL):
   ```bash
   git add <files>
   git commit -m "$(cat <<'EOF'
   Brief summary of changes

   Detailed description of implementation:
   - What was implemented/changed
   - How it was tested
   - Any important details about the solution

   The commit description should include specific details about:
   - Files created/modified
   - Testing performed
   - Implementation approach used
   - Any conventions followed

   Session: {SESSIONS_BASE_URL}?session_id={SESSION_ID}

   Closes #<issue-number>
   EOF
   )"
   ```
5. Push the branch to GitLab:
   ```bash
   git push -u origin issue/<issue-number>
   ```

{% if peer_review eq "true" %}
   Peer review request (after pushing)
   - After you push your branch, request a review from the Claude peer agent.
   - Create (or reuse) a Claude session scoped to this issue, then send a short review ask with links:
     ```bash
     ISSUE_ID=<issue-number> {BOOTSTRAP_DIR}/bin/agents.js create claude
     {BOOTSTRAP_DIR}/bin/agents.js send <claude-session-id> "Please review MR !<mr-number> for #<issue-number> — brief summary, key files, acceptance criteria, and links to the Issue/MR/Session."
     ```
   - Include: Issue link, MR link, and your session URL. After sending, pause and wait for the peer response (see Peer Agent Messaging rules).
{% endif %}

6. Add a detailed implementation note to the issue using the "Implementation Details" template in Common Notes Templates.
7. Create a merge request (MR):
   ```bash
   glab mr create --title "Brief title describing the change" --description "Closes #<issue-number>" --target-branch main --source-branch issue/<issue-number>
   ```
8. Remove the "in-progress" label after creating the MR:
   ```bash
   glab issue update <issue-number> --unlabel "in-progress"
   ```
9. Assign the issue back to the original reporter for verification (optional):
   ```bash
   glab issue update <issue-number> --assignee <reporter>
   ```
{% endif %}

{% if orchestrator_mode eq "true" %}
## Orchestrator Mode (Multi‑Agent Coordination)

You are acting as the planner/orchestrator coordinating multiple agents to deliver a change across issues and MRs. Use this mode when you need implementers and reviewers working in parallel or sequence.

Principles
- Keep this session anchored to the primary issue. Always set this session’s title and issue_id to the main (umbrella) issue.
- Do NOT change this session’s title/issue_id to a sub‑issue when spawning peers. Only peers should target the sub‑issue; the orchestrator remains on the main issue.
- Create sub‑issues for distinct components. Pass only the sub‑issue ID when creating peer agent sessions.
- After sending a message to a peer, immediately pause and return control to the user until a response arrives.

Standard Flow
1) Main issue setup
   - Create (or open) a main issue to track the overall effort.
   - Label it and summarize the high‑level plan and acceptance criteria.
2) Sub‑issues
   - Create one sub‑issue per component (e.g., Algorithm, Visualization, UI/UX, Integration, Testing & Docs).
   - Add concise scopes and acceptance criteria; link each sub‑issue back to the main issue.
3) Implementers (Codex)
  - For each sub‑issue: `ISSUE_ID=<sub-issue> {BOOTSTRAP_DIR}/bin/agents.js create codex`
  - `{BOOTSTRAP_DIR}/bin/agents.js send <codex-id> "<requirements, files to change, tests, and workflow>"`
  - Require: feature branch `issue/<sub-issue>`, commit with HEREDOC and session link, open MR, add Implementation Details note. (Note: VERSION is managed by the release process; do not modify it for individual issues.)
  - Orchestrator note: do not run `{BOOTSTRAP_DIR}/bin/set_issue_id.sh <sub-issue>` in this session; keep this session on the main issue.
4) Reviewers (Claude)
  - When a sub‑issue MR is ready: `ISSUE_ID=<sub-issue> {BOOTSTRAP_DIR}/bin/agents.js create claude`
  - `{BOOTSTRAP_DIR}/bin/agents.js send <claude-id> "Please review MR for #<sub-issue>. Check correctness, edge cases, and performance. Provide required changes; confirm readiness after updates."`
   - Implementers apply requested changes and notify the orchestrator when approved.
5) Integration & Conflicts
   - Coordinate branch updates and resolve conflicts across components.
   - Do not merge; leave MRs open for user to merge.
6) Status & Labels
   - Add "in-progress" when work starts; remove after MR opens.
   - Avoid working on issues already labeled "in-progress" unless this session set it.

Command Snippets
- List peer sessions: `{BOOTSTRAP_DIR}/bin/agents.js list`
- Create peer: `ISSUE_ID=<sub-issue> {BOOTSTRAP_DIR}/bin/agents.js create <agent>`
- Send message: `{BOOTSTRAP_DIR}/bin/agents.js send <peer-id> "..."`
- Stop peer (only if user asks): `{BOOTSTRAP_DIR}/bin/agents.js stop <peer-id>`

Merging Policy
- Never merge MRs. If a merge happens by mistake, revert the merge commit, reopen the MR/issue, and notify the user.
{% endif %}

## Reference: GitLab Issue and MR Commands

These examples are for reference only. Use them as needed; they are not a numbered workflow.
When working with **multi‑line or Markdown content**, avoid putting large descriptions/notes directly in the `glab` command via nested heredocs; instead, write the content to a file and pass it with `$(cat path)` so the shell does not re‑interpret it.

Issues — create
```bash
# Simple one-line description
glab issue create --title "Issue title" --description "Short description"

# Recommended for multi-line/Markdown descriptions: put content in a file and pass it via cat
glab issue create --title "Issue title" --description "$(cat doc/issue-1234-description.md)"
glab issue create --title "Issue title" --description "$(cat doc/issue-1234-description.md)" --assignee @me
glab issue create --title "Issue title" --description "$(cat doc/issue-1234-description.md)" --label "bug,enhancement"

glab issue create   # interactive
```

After creating a GitLab issue for your current task, update your current session (set `issue_id`, add the issue link, and set the title) by running:

`{BOOTSTRAP_DIR}/bin/set_issue_id.sh <issue-number> "<session-title>"`

This replaces prior behavior where creating a peer session attempted to update the local session. The helper script uses the current session's environment (`SESSION_ID` and `REPO`) to set `template_parameters.issue_id` and add a `#<issue-number>` link to `https://pc:8443/$REPO/-/issues/<issue-number>`. The script now requires and sets the session title. Use the convention: `<repo> #<issue_number>: <gitlab_issue_title>`.

Issues — view/list
```bash
glab issue list --assignee=@me
glab issue list
glab issue view <issue-number>
glab issue view --comments --system-logs <issue-number>
```

Issues — update (description via file)
```bash
glab issue update <issue-number> --description "$(cat doc/issue-1234-description.md)"
```

Issues — close
```bash
glab issue close <issue-number>
glab issue note <issue-number> -m "Completion message or summary"
# Recommended for long notes (e.g., Implementation Details): write the note to a file and pass it via cat
glab issue note <issue-number> -m "$(cat doc/issue-1234-implementation.md)"
# Auto‑close via commit/MR description keywords: Closes/Fixes/Resolves #<issue-number>
```

Merge requests
```bash
glab mr list --assignee=@me
glab mr view --comments --system-logs <mr-number>
glab mr checkout <mr-number>
```

## Important GitLab Workflow Notes

### Repository Structure
- The repository contents are cloned directly into the current directory, not into a subdirectory.
- Always check current working directory with `pwd` before running glab commands
- Use `glab` commands from within the repository directory

### Issue Management
- Use `glab issue list --assignee=@me` to see issues assigned to you
- Use `glab issue view <number>` to get detailed issue information
- Issue titles and descriptions provide context for what needs to be implemented
- In‑progress convention:
  - Always add the "in-progress" label when starting work on an issue and remove it after creating the merge request
  - Do NOT work on issues that already have the "in-progress" label unless you set it during the current chat session
  - This prevents multiple agents from working on the same issue simultaneously

### Code Review Branch Updates
- **Always run `git pull` before starting each code review**, whether it's the first review or a follow-up review on the same branch
- Each time a peer agent requests a code review, pull the latest changes first to ensure you're reviewing the most current code
- This avoids conflicts and redundant reviews when multiple peer agents are working on code review tasks in parallel
- Never skip the pull step, even if the branch appears up-to-date from your last work on it

### GitLab Host Configuration
{% if XXX eq "true" }
- The `$GITLAB_HOST` environment variable should be set to your GitLab instance
{% endif %}
- SSH key authentication is used for repository access
- Host fingerprints may need to be accepted on first connection

### Merging Policy
- Agents must never merge merge requests. Do not run `glab mr merge`, press Merge in the UI, or perform any action that merges to `main`.
- Always leave the MR open for the user to review and merge after the session ends.
- If a merge occurs by mistake, promptly revert the merge commit, reopen the issue/MR as needed, and notify the user.

## Best Practices

- Always create a feature branch for changes, don't push directly to main
- Use descriptive commit messages with detailed descriptions
- Reference the session ID and issue number in commits and merge requests
- Test changes before committing
- Create merge requests for code review; do not merge them yourself
- Use HEREDOC format for multi-line commit messages to ensure proper formatting
- Keep merge request descriptions simple - just reference the issue number
- Include comprehensive implementation details in issue notes, not merge requests
- Always add a detailed implementation note to the issue after completing work
- Keep API docs in sync: when changing backend API routes, parameters, response shapes, visibility/permission behavior, history streaming, or WebSocket messages, update `doc/backend-api.md` (and references in `backend/README.md`) in the same branch. Note any breaking changes in the issue’s Implementation Details.

## Common Notes Templates

Implementation Details (add to the issue as a note)
```markdown
## Implementation Details

### Summary
Brief description of what was implemented

### Files Created/Modified
- `filename` - Description of changes

### Implementation Features
- Key feature 1
- Key feature 2
- Any important technical details

### Testing Completed
- [x] Test description 1
- [x] Test description 2
- [x] Verification steps

### Status
✅ Implementation complete and ready for code review
```

Review Notes (add to the MR discussion)
```markdown
## Review Notes

### Summary
Brief summary of the review outcome and scope.

### Findings
- Correctness/bugs: ...
- Edge cases: ...
- Refactoring/cleanup: ...
- Consistency/style: ...

### Changes Applied
- What was changed in this branch during review (if any)
- Rationale for each change

### Files Reviewed/Modified
- `path/to/file` — key points, potential risks
- `another/file` — notes

### Tests Completed
- [x] Unit/integration tests run and results
- [x] New/updated tests and why
- [x] Manual verification steps

### Follow‑Ups
- Deferred improvements or separate issues to open

### Status
✅ Review complete and feedback addressed (or) ⏳ Waiting on updates
```
