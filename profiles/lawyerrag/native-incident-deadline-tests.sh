#!/bin/sh
# Protected verifier command for the incident deadline handoff contract.
set -eu
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
/opt/openclaw/checks/setup-ui-dependencies
exec /opt/ui-node_modules/.bin/vitest run src/features/incidents/IncidentDeadlineActionQueue.test.tsx --maxWorkers=1
