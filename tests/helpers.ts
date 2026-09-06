import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function createTempWorkspace(prefix: string): {
  root: string
  repoPath: string
  dbPath: string
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const repoPath = join(root, "repo")
  mkdirSync(repoPath, { recursive: true })
  writeFileSync(join(repoPath, "README.md"), "# temp repo\n", "utf8")

  return {
    root,
    repoPath,
    dbPath: join(root, "dispatcher.db"),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

export function createFakeCodexScript(root: string): string {
  const scriptPath = join(root, "fake-acpx-codex.py")
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env python3",
      "import json, sys",
      "argv = sys.argv[1:]",
      "if 'sessions' in argv and 'ensure' in argv:",
      "    print(json.dumps({'action': 'session_ensured', 'created': True, 'acpxSessionId': 'codex-session-1'}))",
      "    raise SystemExit(0)",
      "if 'sessions' in argv and 'close' in argv:",
      "    print(json.dumps({'action': 'session_closed'}))",
      "    raise SystemExit(0)",
      "if 'set-mode' in argv:",
      "    print(json.dumps({'action': 'mode_set', 'mode': 'full-access'}))",
      "    raise SystemExit(0)",
      "if 'prompt' in argv:",
      "    print(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': 'codex-session-1', 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'codex completed'}}}}))",
      "    raise SystemExit(0)",
      "print(json.dumps({'action': 'noop'}))"
    ].join("\n"),
    { mode: 0o755 }
  )
  return scriptPath
}

export function createFakeGeminiScript(root: string): string {
  const scriptPath = join(root, "fake-acpx-gemini.py")
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env python3",
      "import json, sys",
      "argv = sys.argv[1:]",
      "prompt = sys.stdin.read()",
      "response = 'gemini completed' if prompt.strip() else 'noop'",
      "print(json.dumps({'session_id': 'gemini-session-1', 'response': response, 'stats': {'totalTokenCount': 7}}))"
    ].join("\n"),
    { mode: 0o755 }
  )
  return scriptPath
}

export function createFakeGhScript(
  root: string,
  mode: "merge" | "feedback" | "pending_approval" | "dirty" | "draft" | "merged"
): string {
  const scriptPath = join(root, "gh")
  const graphqlPayload =
    mode === "feedback"
      ? '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"PRRT_feedback","isResolved":false,"isOutdated":false,"path":"src/app.ts","line":12,"comments":{"nodes":[{"id":"PRRC_feedback","body":"Please tighten this logic.","author":{"login":"reviewer"}}]}}]}}}}}'
      : '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
  const reviewDecision = mode === "pending_approval" ? "REVIEW_REQUIRED" : "APPROVED"
  const mergeStateStatus = mode === "dirty" ? "DIRTY" : "CLEAN"
  const isDraft = mode === "draft"
  const prState = mode === "merged" ? "MERGED" : "OPEN"
  const mergedFields =
    mode === "merged"
      ? '"mergedAt":"2026-05-08T20:00:00Z","mergeCommit":{"oid":"feedface"}'
      : '"mergedAt":null,"mergeCommit":null'
  const prViewPayload = `{"number":17,"url":"https://example.test/pr/17","state":"${prState}",${mergedFields},"headRefOid":"deadbeef","isDraft":${isDraft},"reviewDecision":"${reviewDecision}","mergeStateStatus":"${mergeStateStatus}","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}`

  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      'log_file="$OPENCLAW_FAKE_GH_LOG"',
      'if [ -n "$log_file" ]; then',
      '  printf \'%s\\n\' "$*" >> "$log_file"',
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
      "  printf 'https://example.test/pr/17\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      `  printf '%s' '${prViewPayload}'`,
      "  exit 0",
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then',
      "  printf 'edited\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then',
      "  printf 'ready\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "label" ] && [ "$2" = "create" ]; then',
      "  printf 'label ok\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "release" ] && [ "$2" = "list" ]; then',
      '  if [ -n "$OPENCLAW_FAKE_GH_RELEASE_LIST" ]; then',
      "    printf '%s' \"$OPENCLAW_FAKE_GH_RELEASE_LIST\"",
      "    exit 0",
      "  fi",
      '  printf \'[{"tagName":"v1.2.3","name":"Release v1.2.3","isDraft":false,"isPrerelease":false,"publishedAt":"2026-05-08T00:00:00Z","createdAt":"2026-05-08T00:00:00Z"},{"tagName":"draft-release","name":"Draft release","isDraft":true,"isPrerelease":false,"publishedAt":"2026-05-08T00:00:00Z","createdAt":"2026-05-08T00:00:00Z"}]\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "release" ] && [ "$2" = "create" ]; then',
      "  printf 'https://example.test/release/%s\\n' \"$3\"",
      "  exit 0",
      "fi",
      'if [ "$1" = "api" ] && printf "%s" "$2" | grep -Eq "^/repos/.+/releases"; then',
      '  printf \'%s\' \'[{"tag_name":"v2.9.7.2","name":"v2.9.7.2","draft":false,"prerelease":false,"published_at":"2026-05-12T10:00:00Z","body":"Automated OpenClaw release for Improve court-prep evidence flow.\\n\\n- Persona: lawyer-legal-strategy\\n- Portfolio bucket: legal_domain\\n- Task source: persona_ideation"},{"tag_name":"v2.9.7.1","name":"v2.9.7.1","draft":false,"prerelease":false,"published_at":"2026-05-12T09:00:00Z","body":"Automated OpenClaw release for Add regression test."}]\'',
      "  exit 0",
      "fi",
      'if [ "$1" = "api" ] && printf "%s" "$2" | grep -Eq "^repos/.+/pulls$"; then',
      '  if [ "$4" = "GET" ]; then',
      "    printf '[]'",
      "    exit 0",
      "  fi",
      '  if [ "$4" = "POST" ]; then',
      '    printf \'{"number":17,"html_url":"https://example.test/pr/17","head":{"sha":"abc123"}}\'',
      "    exit 0",
      "  fi",
      "fi",
      'if [ "$1" = "api" ] && printf "%s" "$2" | grep -Eq "^repos/.+/issues/[0-9]+/labels$"; then',
      "  printf '[]'",
      "  exit 0",
      "fi",
      'if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then',
      `  printf '%s' '${graphqlPayload}'`,
      "  exit 0",
      "fi",
      'if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then',
      "  printf 'merged\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then',
      '  printf \'{"nameWithOwner":"acme/repo"}\'',
      "  exit 0",
      "fi",
      "printf 'unsupported gh call: %s\\n' \"$*\" >&2",
      "exit 1"
    ].join("\n"),
    { mode: 0o755 }
  )
  return scriptPath
}

export function copyRepoFixture(name: string, destinationPath: string): void {
  cpSync(join(process.cwd(), "tests", "fixtures", "installer", name), destinationPath, { recursive: true })
}

export function createLawyerRagControlPlane(repoPath: string): void {
  mkdirSync(join(repoPath, ".openclaw", "agents"), { recursive: true })
  mkdirSync(join(repoPath, ".openclaw", "jobs"), { recursive: true })
  mkdirSync(join(repoPath, ".openclaw", "state", "bootstrap"), { recursive: true })
  mkdirSync(join(repoPath, ".openclaw", "state", "current"), { recursive: true })
  writeFileSync(join(repoPath, ".openclaw", "README.md"), "# Existing control plane\n", "utf8")

  writeFileSync(
    join(repoPath, ".openclaw", "control-plane.json"),
    JSON.stringify(
      {
        version: 1,
        company: {
          name: "Lawyer Labs"
        },
        project: {
          name: "LawyerRAG",
          verifyCommand: "pytest -q"
        },
        agents: [
          {
            id: "main",
            role: "Autonomous Director",
            preferredModel: "codex",
            budget: {
              limit: 4000,
              window: "monthly"
            },
            routingHints: {
              keywords: ["review", "promotion"],
              lanes: ["release-ops"]
            }
          },
          {
            id: "planner",
            role: "Task Planner",
            preferredModel: "codex",
            budget: {
              limit: 1200,
              window: "daily"
            },
            routingHints: {
              keywords: ["ux", "frontend"],
              categories: ["frontend"]
            }
          }
        ],
        routingHints: [
          {
            id: "citations-ui",
            preferredModel: "codex",
            priority: 88,
            patterns: ["citation explorer", "frontend", "react"]
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  )

  writeFileSync(
    join(repoPath, ".openclaw", "state", "current", "runtime.json"),
    JSON.stringify(
      {
        version: 1,
        project: "LawyerRAG",
        entry_agent: "main",
        roles: ["main", "planner", "reviewer", "promoter"]
      },
      null,
      2
    ),
    "utf8"
  )

  writeFileSync(
    join(repoPath, ".openclaw", "state", "bootstrap", "categories.json"),
    JSON.stringify(
      {
        version: 1,
        categories: [
          {
            id: "frontend",
            label: "Frontend / UX / Accessibility",
            preferredModel: "codex",
            lanes: ["frontend-shell", "frontend-workflows"],
            priorities: ["workflow clarity", "responsive behavior"]
          },
          {
            id: "architecture",
            label: "Architecture / Boundaries",
            preferredModel: "codex",
            lanes: ["api-contracts", "backend-services"],
            priorities: ["boundary repairs", "contract-safe refactors"]
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  )

  writeFileSync(
    join(repoPath, ".openclaw", "state", "current", "queue.json"),
    JSON.stringify(
      {
        version: 1,
        laneModelPreferences: {
          "frontend-shell": "codex",
          "backend-services": "codex"
        },
        items: [
          {
            id: "queue-item-1",
            title: "Improve citation explorer UX",
            lane: "frontend-shell",
            category: "frontend"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  )

  writeFileSync(
    join(repoPath, ".openclaw", "state", "bootstrap", "manager_state.json"),
    JSON.stringify(
      {
        version: 1,
        manager_personas: [
          {
            id: "manager-frontend",
            preferredModel: "codex",
            owned_lanes: ["frontend-shell", "frontend-workflows"]
          }
        ],
        projects: [
          {
            id: "lane-ownership-clarity",
            title: "Keep lane ownership explicit"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  )

  writeFileSync(
    join(repoPath, ".openclaw", "jobs", "execution-sweep.json"),
    JSON.stringify(
      {
        id: "execution-sweep",
        schedule: {
          cron: "*/10 * * * *",
          timezone: "UTC"
        },
        entry_agent: "main"
      },
      null,
      2
    ),
    "utf8"
  )

  writeFileSync(
    join(repoPath, ".openclaw", "jobs", "review-sweep.json"),
    JSON.stringify(
      {
        id: "review-sweep",
        schedule: {
          cron: "5-59/10 * * * *",
          timezone: "UTC"
        },
        entry_agent: "reviewer"
      },
      null,
      2
    ),
    "utf8"
  )

  writeFileSync(
    join(repoPath, ".openclaw", "jobs", "promotion-sweep.json"),
    JSON.stringify(
      {
        id: "promotion-sweep",
        schedule: {
          cron: "9-59/15 * * * *",
          timezone: "UTC"
        },
        entry_agent: "promoter"
      },
      null,
      2
    ),
    "utf8"
  )

  for (const name of ["main", "planner", "reviewer", "promoter"]) {
    writeFileSync(
      join(repoPath, ".openclaw", "agents", `${name}.md`),
      `# ${name[0]!.toUpperCase()}${name.slice(1)}\n\n${name} prompt\n`,
      "utf8"
    )
  }
}

export function seedLawyerRagRepo(repoPath: string): void {
  copyRepoFixture("lawyerrag-mixed", repoPath)
}
