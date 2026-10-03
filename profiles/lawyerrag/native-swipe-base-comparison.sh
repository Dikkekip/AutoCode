#!/bin/sh
# Run the candidate cancellation regressions against pinned base and candidate
# production source. The same committed test file is used in both runs.
set -eu
cd /work/apps/reports-ui
cmp package-lock.json /opt/openclaw/reports-ui.package-lock.json
/opt/openclaw/checks/setup-ui-dependencies
source=src/components/ui/SwipeActionRow.tsx
base=/opt/openclaw/baselines/SwipeActionRow.tsx
saved=$(mktemp)
base_result=$(mktemp)
candidate_result=$(mktemp)
cp "$source" "$saved"
trap 'cp "$saved" "$source"; rm -f "$saved" "$base_result" "$candidate_result"' EXIT
printf '%s  %s\n' d83f62e285a976f1f2a7e4495f6e55f75595d50741ac2e44e26621f42d45e924 "$base" | sha256sum -c -
cp "$base" "$source"
set +e
/opt/ui-node_modules/.bin/vitest run src/components/ui/SwipeActionRow.test.tsx \
  -t 'aborts a cancelled qualifying' --maxWorkers=1 --reporter=json --outputFile="$base_result"
base_exit=$?
set -e
if [ "$base_exit" -eq 0 ]; then
  echo 'Pinned base unexpectedly passed the cancellation regressions' >&2
  exit 1
fi
node -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const selected = report.testResults.flatMap(file => file.assertionResults ?? [])
  .filter(test => test.fullName.includes("aborts a cancelled qualifying"))
if (selected.length !== 2 || selected.some(test => test.status !== "failed") ||
    ![60, 120].every(distance => selected.some(test => test.fullName.includes(`${distance} px`)))) {
  throw new Error("Pinned base did not fail both expected cancellation cases")
}
console.log("Pinned base failed both 60 px and 120 px cancellation regressions")
' "$base_result"
cp "$saved" "$source"
/opt/ui-node_modules/.bin/vitest run src/components/ui/SwipeActionRow.test.tsx \
  -t 'aborts a cancelled qualifying' --maxWorkers=1 --reporter=json --outputFile="$candidate_result"
node -e '
const fs = require("node:fs")
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const selected = report.testResults.flatMap(file => file.assertionResults ?? [])
  .filter(test => test.fullName.includes("aborts a cancelled qualifying"))
if (selected.length !== 2 || selected.some(test => test.status !== "passed")) {
  throw new Error("Candidate did not pass both cancellation regressions")
}
console.log("Candidate passed both 60 px and 120 px cancellation regressions")
' "$candidate_result"
