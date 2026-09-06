#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required to build the dispatcher installer." >&2
  exit 1
fi

TARGET_PATH="${1:-.}"
if [[ $# -gt 0 ]]; then
  shift
fi

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  pnpm --dir "${ROOT_DIR}" install
fi

pnpm --dir "${ROOT_DIR}" build >/dev/null
node "${ROOT_DIR}/apps/dispatcher-cli/dist/index.js" install "${TARGET_PATH}" "$@"
