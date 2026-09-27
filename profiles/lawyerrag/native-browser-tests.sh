#!/bin/sh
# Keep browser concurrency within the verifier's two CPU / four GiB allocation.
# Docker CPU quotas do not reduce Playwright's detected host CPU count.
set -eu
export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
/opt/openclaw/checks/setup-ui-dependencies
case "${0##*/}" in
  legacy-004) exec npm run ui:audit -- --workers=1 ;;
  legacy-005) exec /opt/ui-node_modules/.bin/playwright test --project=chromium e2e/navigation.spec.ts e2e/shell-visual.spec.ts --workers=1 ;;
  *) echo "Unknown browser verification rule" >&2; exit 64 ;;
esac
