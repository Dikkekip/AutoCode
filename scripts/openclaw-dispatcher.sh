#!/bin/sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DB_PATH="$REPO_ROOT/.openclaw/dispatcher.db"

if [ "${1:-}" = "doctor" ]; then
  export OPENCLAW_DOCTOR_WRAPPER_REPO="$REPO_ROOT"
  export OPENCLAW_DOCTOR_WRAPPER_DB="$DB_PATH"
  export OPENCLAW_DOCTOR_WRAPPER_FRAMEWORK="${OPENCLAW_DISPATCHER_FRAMEWORK_DIR:-embedded default}"
fi

exec "$REPO_ROOT/.openclaw/bin/dispatcher" --db "$DB_PATH" "$@"
