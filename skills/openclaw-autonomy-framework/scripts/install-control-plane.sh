#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install a reusable OpenClaw autonomous control plane into a target repository.

Usage:
  install-control-plane.sh --path <repo> --project-name <name> [--repo-slug owner/repo] [--force]

Options:
  --path <repo>            Target repository directory
  --project-name <name>    Human-readable project name for templates
  --repo-slug <owner/repo> GitHub repo slug for promotion policy
  --force                  Overwrite existing files
  -h, --help               Show this help
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="${SCRIPT_DIR%/scripts}/assets/templates"
TARGET_PATH=""
PROJECT_NAME=""
REPO_SLUG="owner/repo"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path)
      TARGET_PATH="${2:-}"
      shift 2
      ;;
    --project-name)
      PROJECT_NAME="${2:-}"
      shift 2
      ;;
    --repo-slug)
      REPO_SLUG="${2:-}"
      shift 2
      ;;
    --force)
      FORCE=1
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

if [[ -z "$TARGET_PATH" || -z "$PROJECT_NAME" ]]; then
  echo "Missing required arguments" >&2
  usage >&2
  exit 1
fi

TARGET_PATH="$(mkdir -p "$TARGET_PATH" && cd "$TARGET_PATH" && pwd)"
REPO_ROOT="$TARGET_PATH"

copy_template() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"

  if [[ -e "$dest" && "$FORCE" -ne 1 ]]; then
    echo "skip  $dest"
    return 0
  fi

  python3 - "$src" "$dest" "$PROJECT_NAME" "$REPO_SLUG" "$REPO_ROOT" <<'PY'
import pathlib
import sys

src = pathlib.Path(sys.argv[1])
dest = pathlib.Path(sys.argv[2])
project_name = sys.argv[3]
repo_slug = sys.argv[4]
repo_root = sys.argv[5]
text = src.read_text(encoding='utf-8')
text = text.replace('__PROJECT_NAME__', project_name)
text = text.replace('__REPO_SLUG__', repo_slug)
text = text.replace('__REPO_ROOT__', repo_root)
dest.write_text(text, encoding='utf-8')
PY
  echo "write $dest"
}

while IFS= read -r -d '' src; do
  rel="${src#${TEMPLATE_DIR}/}"
  copy_template "$src" "$TARGET_PATH/$rel"
done < <(find "$TEMPLATE_DIR" -type f -print0 | sort -z)

GITIGNORE="$TARGET_PATH/.gitignore"
CURRENT_RULES=""
if [[ -f "$GITIGNORE" ]]; then
  CURRENT_RULES="$(cat "$GITIGNORE")"
fi

append_rule() {
  local rule="$1"
  if ! grep -Fqx "$rule" "$GITIGNORE" 2>/dev/null; then
    printf '%s\n' "$rule" >> "$GITIGNORE"
    echo "append $GITIGNORE :: $rule"
  fi
}

if [[ ! -f "$GITIGNORE" ]]; then
  : > "$GITIGNORE"
fi
append_rule ""
append_rule "# OpenClaw autonomous runtime state"
append_rule ".openclaw/state/current/"

echo "Done: $TARGET_PATH"
