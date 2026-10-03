#!/bin/sh
# Retain the critical suite and exercise feature tests it does not select.
set -eu
case "${0##*/}" in
  legacy-009) suite=src/features/bundles/detail/components/BundleExportsPanel.test.tsx ;;
  legacy-014) suite=src/features/ingestion/components/IngestionBatchRecoveryPanel.test.tsx ;;
  *) echo "Unknown critical feature verification rule" >&2; exit 64 ;;
esac
export UV_NO_SYNC=1 UV_OFFLINE=1 UV_PROJECT_ENVIRONMENT=/opt/backend-venv
export PYTHONPATH=/work/apps/backend:/work/libs/common/src:/work/libs/ingestion/src
export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
cd /work
if [ -d apps/backend ]; then ln -s /opt/backend-venv apps/backend/.venv; fi
/opt/openclaw/checks/setup-ui-dependencies
/opt/openclaw/checks/install-critical-fixture-oracles
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
npm run test:critical
exec /opt/ui-node_modules/.bin/vitest run "$suite" --maxWorkers=1
