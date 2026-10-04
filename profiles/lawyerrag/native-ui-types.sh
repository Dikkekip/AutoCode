#!/bin/sh
set -eu
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
/opt/openclaw/checks/setup-ui-dependencies
exec /opt/ui-node_modules/.bin/tsc --project tsconfig.build.json --noEmit
