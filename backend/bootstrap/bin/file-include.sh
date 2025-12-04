#!/usr/bin/env bash
# file-include.sh: Expand {file:...} include markers in-place within a file.
#
# Usage:
#   file-include.sh <file>
#   file-include.sh --help
# 
# Behavior:
#   - Treats the given path as both source and target.
#   - Scans the file for `{file:relative/path}` markers.
#   - Replaces each marker with the contents of the referenced file.
#   - Relative include paths are resolved relative to the directory of <file>.
#   - Writes the result back to the same file via a temporary file + mv.
#
# This is a minimal helper intended to run inside a session workspace/container.
# It is copied into the workspace .bootstrap/bin directory by the backend
# session workspace builder.

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: file-include.sh <file>" >&2
  echo "Expands {file:relative/path} markers in-place within <file>." >&2
  exit 0
fi

if [ "$#" -ne 1 ]; then
  echo "Usage: file-include.sh <file>" >&2
  exit 1
fi

TARGET="$1"

if [ ! -f "$TARGET" ]; then
  echo "[file-include] Target file not found: $TARGET" >&2
  exit 1
fi

TARGET_DIR="$(dirname -- "$TARGET")"
TMP="${TARGET}.tmp.$$"

# Use awk to expand {file:...} markers line-by-line.
# Pass a canonical target path for basic self-include detection.
TARGET_BASENAME="$(basename -- "$TARGET")"
CANON_TARGET="${TARGET_DIR}/${TARGET_BASENAME}"

awk -v base_dir="$TARGET_DIR" -v target_path="$CANON_TARGET" '
function trim(s) {
  sub(/^[ \t\r\n]+/, "", s);
  sub(/[ \t\r\n]+$/, "", s);
  return s;
}

function expand_env(path,    out, i, ch, j, name, len) {
  out = "";
  len = length(path);
  i = 1;
  while (i <= len) {
    ch = substr(path, i, 1);
    if (ch != "$") {
      out = out ch;
      i++;
      continue;
    }
    # Handle ${VAR} form
    if (i + 1 <= len && substr(path, i + 1, 1) == "{") {
      j = i + 2;
      while (j <= len && substr(path, j, 1) != "}") j++;
      if (j > len) {
        # Unclosed brace; treat as literal dollar sign
        out = out "$";
        i++;
        continue;
      }
      name = substr(path, i + 2, j - (i + 2));
      if (name in ENVIRON) {
        out = out ENVIRON[name];
      }
      i = j + 1;
      continue;
    }
    # Handle $VAR form
    j = i + 1;
    while (j <= len && substr(path, j, 1) ~ /[A-Za-z0-9_]/) j++;
    if (j == i + 1) {
      # Bare dollar sign
      out = out "$";
      i++;
      continue;
    }
    name = substr(path, i + 1, j - (i + 1));
    if (name in ENVIRON) {
      out = out ENVIRON[name];
    }
    i = j;
  }
  return out;
}

function expand(s,    out, pos, fullLen, startRel, startAbs, i, depth, ch, nextch, spec, fname, line2, firstRead, rc) {
  out = "";
  pos = 1;
  fullLen = length(s);
  while (pos <= fullLen) {
    startRel = index(substr(s, pos), "{file:");
    if (startRel == 0) {
      out = out substr(s, pos);
      break;
    }
    startAbs = pos + startRel - 1;
    # Text before marker
    out = out substr(s, pos, startRel - 1);

    # Find closing } for this {file:...} marker, allowing ${VAR} inside
    i = startAbs + 6; # first character after colon
    depth = 0;
    while (i <= fullLen) {
      ch = substr(s, i, 1);
      nextch = (i + 1 <= fullLen) ? substr(s, i + 1, 1) : "";
      if (ch == "$" && nextch == "{") {
        depth++;
        i += 2;
        continue;
      }
      if (ch == "}") {
        if (depth > 0) {
          depth--;
          i++;
          continue;
        }
        # depth == 0 => closing brace for {file:...}
        break;
      }
      i++;
    }

    if (i > fullLen) {
      # Unbalanced; treat rest as literal
      out = out substr(s, startAbs);
      break;
    }

    # Extract and normalize include spec inside {file:...}
    spec = substr(s, startAbs + 6, i - (startAbs + 6));
    spec = trim(spec);
    spec = expand_env(spec);
    if (length(spec) == 0) {
      printf("[file-include] Include path is empty after env expansion (marker: %s)\n", substr(s, startAbs, i - startAbs + 1)) > "/dev/stderr";
      exit 1;
    }
    fname = spec;
    if (substr(fname, 1, 1) != "/") {
      fname = base_dir "/" fname;
    }

    if (fname == target_path) {
      printf("[file-include] Include file resolves to target file itself: %s\n", fname) > "/dev/stderr";
      exit 1;
    }

    # Read included file
    firstRead = 1;
    rc = getline line2 < fname;
    if (rc < 0) {
      printf("[file-include] Failed to read include file: %s\n", fname) > "/dev/stderr";
      exit 1;
    }
    if (rc == 1) {
      out = out line2 "\n";
      while ((getline line2 < fname) > 0) {
        out = out line2 "\n";
      }
    }
    close(fname);

    pos = i + 1;
  }
  return out;
}

{
  print expand($0);
}
' "$TARGET" > "$TMP"

# If the expanded content is identical to the original, do not modify the file.
if cmp -s -- "$TARGET" "$TMP"; then
  rm -f -- "$TMP"
  echo "[file-include] No {file:...} markers found in '$TARGET'; no changes applied"
  exit 0
fi

mv -- "$TMP" "$TARGET"

echo "[file-include] Expanded includes in '$TARGET'"
