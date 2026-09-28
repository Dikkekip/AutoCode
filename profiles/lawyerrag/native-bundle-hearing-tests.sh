#!/bin/sh
# Protected verifier command for hearing run sheet controls and export order.
set -eu
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
/opt/openclaw/checks/setup-ui-dependencies
test -f src/features/bundles/detail/components/BundleHearingRunSheet.test.tsx
test -f src/features/bundles/detail/components/bundleHearingRunSheetExport.test.ts
exec /opt/ui-node_modules/.bin/vitest run \
  src/features/bundles/detail/components/BundleHearingRunSheet.test.tsx \
  src/features/bundles/detail/components/bundleHearingRunSheetExport.test.ts \
  --maxWorkers=1
