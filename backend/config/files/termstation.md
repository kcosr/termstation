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

