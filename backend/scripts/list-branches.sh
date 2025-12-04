#!/usr/bin/env bash
set -euo pipefail

# Inputs: repo path via $repo (lowercase) or $REPO (uppercase)
repo="${repo:-${REPO:-}}"
if [[ -z "$repo" ]]; then
  # Nothing to do; print nothing so UI remains empty
  exit 0
fi

# Base directory for cached clones; configurable via template vars env
# Prefer lowercase 'branch_cache_dir', then uppercase 'BRANCH_CACHE_DIR', else default
BASE_DIR="${branch_cache_dir:-${BRANCH_CACHE_DIR:-/srv/devtools/.cache/termstation/repos}}"
REPO_DIR="$BASE_DIR/$repo"

# Ensure parent directories exist
mkdir -p "$REPO_DIR"

# Use SSH with relaxed host key checking for first-time hosts.
# When SSH_IDENTITY_FILE is provided (e.g., from forge config), prefer it for
# daemon-run git operations. Respect an existing GIT_SSH_COMMAND if already set.
if [[ -z "${GIT_SSH_COMMAND:-}" ]]; then
  GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"
  if [[ -n "${SSH_IDENTITY_FILE:-}" ]]; then
    GIT_SSH_COMMAND="$GIT_SSH_COMMAND -i ${SSH_IDENTITY_FILE}"
  fi
  export GIT_SSH_COMMAND
fi

host="${GITLAB_HOST:-gitlab}"
REMOTE_URL="git@${host}:${repo}.git"

if [[ -d "$REPO_DIR/.git" ]]; then
  # Existing clone: ensure remote is correct and fetch latest
  git -C "$REPO_DIR" remote set-url origin "$REMOTE_URL" >/dev/null 2>&1 || true
  git -C "$REPO_DIR" fetch origin --prune --tags >/dev/null 2>&1 || true
else
  # Fresh clone (shallow is fine for listing refs)
  git clone --no-checkout --filter=blob:none "$REMOTE_URL" "$REPO_DIR" >/dev/null 2>&1 || true
  # Fallback without filters if minimal clone failed
  if [[ ! -d "$REPO_DIR/.git" ]]; then
    rm -rf "$REPO_DIR" && mkdir -p "$REPO_DIR"
    git clone "$REMOTE_URL" "$REPO_DIR" >/dev/null 2>&1 || true
  fi
  # Fetch remote refs explicitly to populate refs/remotes
  git -C "$REPO_DIR" fetch origin --prune --tags >/dev/null 2>&1 || true
fi

# If still no git repo, nothing to output
if [[ ! -d "$REPO_DIR/.git" ]]; then
  exit 0
fi

# Parse arguments
limit=25
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)
      shift
      limit="${1:-25}"
      ;;
    --limit=*)
      limit="${1#*=}"
      ;;
    -n)
      shift
      limit="${1:-25}"
      ;;
    *)
      ;;
  esac
  shift || true
done

if [[ ! "$limit" =~ ^[0-9]+$ ]]; then limit=25; fi

# Match deploy command ordering: most recently updated branches first
git -C "$REPO_DIR" for-each-ref \
  --sort=-committerdate \
  --count="$limit" \
  --exclude='refs/remotes/*/HEAD' \
  --format='%(refname:lstrip=3)' \
  refs/remotes || true
