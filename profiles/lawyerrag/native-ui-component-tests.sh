#!/bin/sh
# Installed in the immutable verifier image; candidate source cannot replace it.
set -eu
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
/opt/openclaw/checks/setup-ui-dependencies
exec /opt/ui-node_modules/.bin/vitest run src/components/ui
