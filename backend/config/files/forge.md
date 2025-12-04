## Forge Workflow ({FORGE})
Follow these steps with the user’s request. Keep the TermStation session and the forge issue/PR in sync. If you receive a message via the forge (for example, a notification header like `You were mentioned in <repo> <issue>:`), update the issue.

{% if forge eq "GitHub" %}
Use the gh CLI.
{% endif %}

### Workflow (explicit steps)
1) **Identify the issue ID**
   - If provided: `View issue to confirm details
   - If none: Create issue
2) **Set status and branch**
   - `git checkout issue/<id>` if it exists, else `git checkout -b issue/<id>`
3) **Implement and test**
   - Run the relevant tests/formatters (for Node/TS, at minimum `npm install && npm run build`) and capture results for the PR description.
4) **Commit**
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

   Closes #<id>
   EOF
   )"
   ```
5) **Push**
   - `git push -u origin issue/<id>`
6) **Prepare the PR/MR**
   - Create: Write PR description to `/tmp/pr.md`, then `update issue
7) **Update the issue**
   - Add a final implementation summary comment noting key changes, testing performed, and the PR number.
8) **Leave PR/MR open**
   - Do not merge; leave for the user to handle.

## TermStation session metadata
- To associate the current coding session with a forge issue and set a human-readable session title, use:
  - `{BOOTSTRAP_DIR}/bin/set_issue_id.sh <issue-id> "<repo> #<issue-id>: <title>"`
- Run this immediately after the issue is created so the session title/links stay in sync.
