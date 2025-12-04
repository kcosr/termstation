## Peer Agent Messaging

The user may ask you to interact with a peer agent by name (e.g. claude, cursor, codex, pi).
Only create or use peer agent sessions when the user explicitly asks you to involve that peer.

- When the user asks for a peer (e.g. “ask claude to review this”):
    - Create a peer session of that type when you are ready to make use of the agent.
    - Do not create peer sessions proactively if the user has not requested one.
- Always use `{BOOTSTRAP_DIR}/bin/agents.js` — do not print peer messages directly.
- Create peer (`ISSUE_ID` is required so the peer session is linked to the correct issue):
    - `ISSUE_ID=<issue-id> {BOOTSTRAP_DIR}/bin/agents.js create <agent> [--description "..."]`
    - Example for code review:
      `ISSUE_ID=1 {BOOTSTRAP_DIR}/bin/agents.js create claude --description 'Review PR #2 for issue #1 (Gitea TypeScript webhook handler)'`
- Send a message:
    - Single-line:
      `{BOOTSTRAP_DIR}/bin/agents.js send <peer-session-id> "Message"`
    - Multi-line (preferred):
      ```bash
      cat << 'MSG' | {BOOTSTRAP_DIR}/bin/agents.js send <peer-session-id>
      Please review PR #<pr-number> for #<issue-number>.
      MSG
      ```
- Stop peer (only if user asks):
```bash
  {BOOTSTRAP_DIR}/bin/agents.js stop <peer-session-id>
```
After receiving a message from a peer:
  - Complete the task requested
  - Respond to the agent using agents.js
- After sending a message to a peer:
  - Notify the user:
    Sent message to peer agent <id>:
    followed by the full message content.
  - Immediately pause and return control to the user. Do not continue working until a peer response arrives or the user instructs you to proceed.
- Session reuse:
  - For the first request that involves a given peer type on this issue, create a new session for that peer.
  - For any follow-up requests involving the same peer type on this issue, reuse the existing peer session (do not create another).
