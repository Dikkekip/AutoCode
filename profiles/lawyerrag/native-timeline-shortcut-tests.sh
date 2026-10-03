#!/bin/sh
# Protected verifier command for focused timeline keyboard ownership.
set -eu
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
/opt/openclaw/checks/setup-ui-dependencies
test -f src/features/timeline/useTimelineNavigation.test.tsx
test -f src/features/timeline/__tests__/TimelineView.filters.contract.test.tsx
exec /opt/ui-node_modules/.bin/vitest run \
  src/features/timeline/useTimelineNavigation.test.tsx \
  src/features/timeline/__tests__/TimelineView.filters.contract.test.tsx \
  --maxWorkers=1
