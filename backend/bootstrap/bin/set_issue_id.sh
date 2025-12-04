#!/bin/bash

# Script to set the issue_id parameter on a session and add a Gitea/GitLab issue link

show_usage() {
    cat << EOF
Usage: $0 <issue_id> <session_title>

Sets the session's template parameter issue_id, adds a link to the issue, and sets the session title (required).

Arguments:
  issue_id        The issue number (e.g., 123)
  session_title   Title to set for the session (required)

Environment variables (required):
  SESSION_ID  Current session ID to update
  GITEA_URL or GITLAB_URL  Base URL for the issue tracker (e.g., https://gitea or https://gitlab)

Environment variables (optional):
  REPO        Repo path (e.g., devtools/terminals). If not set, attempts
              to read from the session's existing template_parameters.repo

Examples:
  SESSION_ID=abc-123 $0 456 "devtools/terminals #456: Issue title"
  SESSION_ID=abc-123 REPO=devtools/terminals $0 456 "devtools/terminals #456: Issue title"
EOF
}

if [ -z "$1" ]; then
    echo "Error: issue_id argument is required"
    show_usage
    exit 1
fi
if [ -z "$2" ]; then
    echo "Error: session_title argument is required"
    show_usage
    exit 1
fi

ISSUE_ID="$1"
# Capture title (all args after the first)
TITLE="${*:2}"
MY_SESSION_ID="$SESSION_ID"

if [ -z "$MY_SESSION_ID" ]; then
    echo "Error: SESSION_ID environment variable is required"
    show_usage
    exit 1
fi

API_BASE="$SESSIONS_API_BASE_URL"
if [ -z "$API_BASE" ]; then
  echo "Error: SESSIONS_API_BASE_URL is required but not set" 1>&2
  exit 1
fi
API_BASE="${API_BASE%/}/"

# Update template parameters: issue_id (if endpoint exists)
PARAMS_PAYLOAD=$(jq -n --arg issue "$ISSUE_ID" '{"template_parameters": {"issue_id": $issue}}')

TMP_PARAMS_RESP=$(mktemp)
HTTP_CODE=$(curl -sk -u webhooks:webhooks \
    -H 'Content-Type: application/json' \
    -d "$PARAMS_PAYLOAD" \
    -X PUT \
    -w '%{http_code}' \
    -o "$TMP_PARAMS_RESP" \
    "${API_BASE}sessions/$MY_SESSION_ID/parameters")

if [ "$HTTP_CODE" != "200" ]; then
    echo "Warning: parameters endpoint returned HTTP $HTTP_CODE; skipping template parameter update."
else
    # Confirm no error field
    ERR=$(jq -r '.error // empty' "$TMP_PARAMS_RESP" 2>/dev/null || true)
    if [ -n "$ERR" ]; then
        echo "Warning: server reported error updating parameters: $ERR"
    else
        echo "Updated template_parameters.issue_id to $ISSUE_ID"
    fi
fi
rm -f "$TMP_PARAMS_RESP"

# Determine REPO: use env if provided; otherwise fetch from session
REPO_VALUE="$REPO"
if [ -z "$REPO_VALUE" ]; then
    SESSION_JSON=$(curl -sk -u webhooks:webhooks "${API_BASE}sessions/$MY_SESSION_ID")
    REPO_VALUE=$(echo "$SESSION_JSON" | jq -r '.template_parameters.repo // empty')
fi

if [ -z "$REPO_VALUE" ]; then
    echo "Warning: REPO not set and not found on session; skipping link creation."
    exit 0
fi

# Build the issue link - check for GITEA_URL first, then GITLAB_URL
if [ -n "$GITEA_URL" ]; then
    # Gitea format: no "/-/" in the path
    ISSUE_URL="${GITEA_URL%/}/$REPO_VALUE/issues/$ISSUE_ID"
elif [ -n "$GITLAB_URL" ]; then
    # GitLab format: includes "/-/" in the path
    ISSUE_URL="${GITLAB_URL%/}/$REPO_VALUE/-/issues/$ISSUE_ID"
else
    echo "Error: Either GITEA_URL or GITLAB_URL environment variable must be set"
    exit 1
fi
LINK_NAME="#${ISSUE_ID}"

LINKS_PAYLOAD=$(jq -n \
  --arg url "$ISSUE_URL" \
  --arg name "$LINK_NAME" \
  '{"links": [{"url": $url, "name": $name, "show_active": true, "show_inactive": true}]}')

LINK_RESP=$(curl -sk -u webhooks:webhooks \
  -H 'Content-Type: application/json' \
  -d "$LINKS_PAYLOAD" \
  -X POST \
  "${API_BASE}sessions/$MY_SESSION_ID/links")

LINK_ERR=$(echo "$LINK_RESP" | jq -r '.error // empty')
if [ -n "$LINK_ERR" ]; then
  echo "Error adding link: $LINK_ERR"
  echo "$LINK_RESP"
  exit 1
fi

echo "Updated session $MY_SESSION_ID with issue_id=$ISSUE_ID and added link $ISSUE_URL"

# Update the session title (required)
TITLE_PAYLOAD=$(jq -n --arg t "$TITLE" '{"title": $t}')
TITLE_RESP=$(curl -sk -u webhooks:webhooks \
  -H 'Content-Type: application/json' \
  -d "$TITLE_PAYLOAD" \
  -X PUT \
  "${API_BASE}sessions/$MY_SESSION_ID/title")
TITLE_ERR=$(echo "$TITLE_RESP" | jq -r '.error // empty' 2>/dev/null)
if [ -n "$TITLE_ERR" ]; then
  echo "Warning: failed to update title: $TITLE_ERR"
else
  echo "Updated session title to: $TITLE"
fi
