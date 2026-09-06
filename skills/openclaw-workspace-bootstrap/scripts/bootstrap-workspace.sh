#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Bootstrap a clean OpenClaw workspace baseline.

Usage:
  bootstrap-workspace.sh --path <workspace> [--force] [--with-bootstrap] [--with-memory] [--with-workspace-state]

Options:
  --path <workspace>        Target workspace directory
  --force                   Overwrite existing files
  --with-bootstrap          Include BOOTSTRAP.md
  --with-memory             Include a blank MEMORY.md
  --with-workspace-state    Generate local .openclaw/workspace-state.json
  -h, --help                Show this help
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="${SCRIPT_DIR%/scripts}/assets/templates"
TARGET_PATH=""
FORCE=0
WITH_BOOTSTRAP=0
WITH_MEMORY=0
WITH_WORKSPACE_STATE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path)
      TARGET_PATH="${2:-}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --with-bootstrap)
      WITH_BOOTSTRAP=1
      shift
      ;;
    --with-memory)
      WITH_MEMORY=1
      shift
      ;;
    --with-workspace-state)
      WITH_WORKSPACE_STATE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET_PATH" ]]; then
  echo "Missing required --path" >&2
  usage >&2
  exit 1
fi

TARGET_PATH="$(mkdir -p "$TARGET_PATH" && cd "$TARGET_PATH" && pwd)"
mkdir -p "$TARGET_PATH"/memory "$TARGET_PATH"/skills "$TARGET_PATH"/apps

copy_template() {
  local src="$1"
  local dest="$2"

  mkdir -p "$(dirname "$dest")"

  if [[ -e "$dest" && "$FORCE" -ne 1 ]]; then
    echo "skip  $dest"
    return 0
  fi

  cp "$src" "$dest"
  echo "write $dest"
}

copy_template "$ASSETS_DIR/AGENTS.md" "$TARGET_PATH/AGENTS.md"
copy_template "$ASSETS_DIR/SOUL.md" "$TARGET_PATH/SOUL.md"
copy_template "$ASSETS_DIR/TOOLS.md" "$TARGET_PATH/TOOLS.md"
copy_template "$ASSETS_DIR/USER.md" "$TARGET_PATH/USER.md"
copy_template "$ASSETS_DIR/IDENTITY.md" "$TARGET_PATH/IDENTITY.md"
copy_template "$ASSETS_DIR/HEARTBEAT.md" "$TARGET_PATH/HEARTBEAT.md"
copy_template "$ASSETS_DIR/.gitignore" "$TARGET_PATH/.gitignore"

if [[ "$WITH_BOOTSTRAP" -eq 1 ]]; then
  copy_template "$ASSETS_DIR/BOOTSTRAP.md" "$TARGET_PATH/BOOTSTRAP.md"
fi

if [[ "$WITH_MEMORY" -eq 1 ]]; then
  copy_template "$ASSETS_DIR/MEMORY.md" "$TARGET_PATH/MEMORY.md"
fi

if [[ "$WITH_WORKSPACE_STATE" -eq 1 ]]; then
  mkdir -p "$TARGET_PATH/.openclaw"
  STATE_FILE="$TARGET_PATH/.openclaw/workspace-state.json"
  if [[ -e "$STATE_FILE" && "$FORCE" -ne 1 ]]; then
    echo "skip  $STATE_FILE"
  else
    python3 - <<'PY' "$STATE_FILE"
import datetime
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps({
    "version": 1,
    "bootstrapSeededAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
}, indent=2) + "\n", encoding="utf-8")
PY
    echo "write $STATE_FILE"
  fi
fi

echo "Done: $TARGET_PATH"
