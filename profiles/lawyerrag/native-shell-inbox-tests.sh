#!/bin/sh
# Protected verifier command for recoverable outcome inbox controls.
set -eu
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
/opt/openclaw/checks/setup-ui-dependencies
test -f src/features/shell/ShellNotificationInbox.test.tsx
test -f src/features/shell/ShellWorkActivityCenter.test.tsx
exec /opt/ui-node_modules/.bin/vitest run \
  src/features/shell/ShellNotificationInbox.test.tsx \
  src/features/shell/ShellWorkActivityCenter.test.tsx \
  --maxWorkers=1
