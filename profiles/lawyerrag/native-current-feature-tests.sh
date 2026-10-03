#!/bin/sh
# Protected focused suites for current WhatsApp and ingestion candidates.
set -eu
case "${0##*/}" in
  whatsapp-search-keyboard) suite=src/features/whatsapp/browser/components/SearchPanel.test.tsx; compare_base=1 ;;
  ingestion-task-status-recovery) suite=src/features/ingestion/components/TaskMonitor.test.tsx ;;
  *) echo "Unknown focused feature verification rule" >&2; exit 64 ;;
esac
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
/opt/openclaw/checks/setup-ui-dependencies
test -f "$suite"
if [ "${compare_base:-0}" -eq 1 ]; then
  # The isolated verification snapshot is disposable. Restore its candidate
  # source even when the base comparison fails or the command is interrupted.
  source=src/features/whatsapp/browser/components/SearchPanel.tsx
  candidate=$(mktemp /tmp/SearchPanel-candidate.XXXXXX)
  baseline_result=$(mktemp /tmp/SearchPanel-base-result.XXXXXX)
  cp "$source" "$candidate"
  trap 'cp "$candidate" "$source"; rm -f "$candidate" "$baseline_result"' 0
  cp /opt/openclaw/baselines/SearchPanel.base-3b806029.tsx "$source"
  if /opt/ui-node_modules/.bin/vitest run "$suite" \
    --testNamePattern='submits once from Enter in the input, without browser navigation' \
    --reporter=json --outputFile="$baseline_result" --maxWorkers=1 >/dev/null 2>&1; then
    echo "WhatsApp keyboard regression unexpectedly passes at reviewed base" >&2
    exit 1
  fi
  node -e '
    const fs = require("fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const cases = report.testResults.flatMap((file) => file.assertionResults || []);
    const target = cases.find((test) => test.fullName.includes("submits once from Enter in the input, without browser navigation"));
    if (!target || target.status !== "failed") process.exit(1);
  ' "$baseline_result" || {
    echo "Reviewed base did not fail the named keyboard regression" >&2
    exit 1
  }
  echo "Reviewed base failed the named keyboard regression; running candidate suite"
  cp "$candidate" "$source"
  rm -f "$candidate" "$baseline_result"
  trap - 0
fi
exec /opt/ui-node_modules/.bin/vitest run "$suite" --maxWorkers=1
