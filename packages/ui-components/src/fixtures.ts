import { normalizePaperclipTranscript } from "./normalize-paperclip.js"
import { normalizeSquadState } from "./normalize-squad.js"
import type {
  AutonomousCompanyDashboardData,
  NormalizeSquadStateInput,
  PaperclipTranscriptEntryLike,
  PaperclipTranscriptMeta
} from "./types.js"

export const paperclipTranscriptFixtureMeta: PaperclipTranscriptMeta = {
  agentId: "codexcoder-fixture",
  agentName: "CodexCoder",
  role: "Implementation Agent",
  model: "codex",
  issueLabel: "PAP-473",
  status: "running",
  startedAt: "2026-03-11T15:21:05.948Z"
}

export const paperclipTranscriptFixtureEntries: PaperclipTranscriptEntryLike[] = [
  {
    kind: "assistant",
    ts: "2026-03-11T15:21:18.851Z",
    text: "I am starting with the Paperclip heartbeat procedure and the repo-required docs so I can see what task is actually assigned and then work only on that scope."
  },
  {
    kind: "tool_call",
    ts: "2026-03-11T15:21:19.026Z",
    name: "command_execution",
    toolUseId: "item_1",
    input: {
      command: "sed -n '1,220p' doc/GOAL.md",
      cwd: "/workspace/paperclip"
    }
  },
  {
    kind: "tool_result",
    ts: "2026-03-11T15:21:19.034Z",
    toolUseId: "item_1",
    content: "command: sed -n '1,220p' doc/GOAL.md\nstatus: completed\nexit_code: 0",
    isError: false
  },
  {
    kind: "thinking",
    ts: "2026-03-11T15:22:12.044Z",
    text: "The current transcript UX duplicates parsing logic in multiple surfaces. A shared presentation layer will make the detail page and live surfaces behave the same way while keeping raw fallback available."
  },
  {
    kind: "assistant",
    ts: "2026-03-11T15:24:08.490Z",
    text: "The new parser metadata changed a few adapter test snapshots exactly where expected, and the remaining red tests are outside this change set."
  },
  {
    kind: "result",
    ts: "2026-03-11T15:25:05.440Z",
    text: "Transcript rollout complete with shared nice/raw rendering and compact live variants."
  }
]

export const paperclipConsoleFixture = {
  agents: [normalizePaperclipTranscript(paperclipTranscriptFixtureEntries, paperclipTranscriptFixtureMeta)],
  transitions: []
}

export const squadConsoleFixtureInput: NormalizeSquadStateInput = {
  sessions: [
    {
      name: "Fenster",
      role: "Frontend",
      status: "streaming",
      startedAt: "2026-04-12T09:00:00.000Z",
      activityHint: "polishing chat surface",
      model: "gpt-5.5"
    },
    {
      name: "McManus",
      role: "Backend",
      status: "working",
      startedAt: "2026-04-12T09:01:00.000Z",
      activityHint: "mapping event payloads",
      model: "gpt-5.3-codex-spark"
    }
  ],
  messages: [
    {
      role: "user",
      content: "Team, extract the shared dashboard UI.",
      timestamp: "2026-04-12T09:00:00.000Z"
    },
    {
      role: "agent",
      agentName: "Fenster",
      content: "I am lifting the live multi-agent chat surface into a reusable React package.",
      timestamp: "2026-04-12T09:01:10.000Z"
    },
    {
      role: "agent",
      agentName: "McManus",
      content: "I am normalizing lifecycle events so state transitions are chartable in the new library.",
      timestamp: "2026-04-12T09:01:24.000Z"
    }
  ],
  reasoning: [
    {
      agentName: "Fenster",
      content: "Need a generic event model so Next.js dashboards do not depend on the source repos.",
      timestamp: "2026-04-12T09:01:18.000Z"
    }
  ],
  events: [
    {
      type: "session:created",
      agentName: "Fenster",
      timestamp: "2026-04-12T09:00:02.000Z",
      payload: { agentName: "Fenster", priority: "high" }
    },
    {
      type: "coordinator:routing",
      timestamp: "2026-04-12T09:00:03.000Z",
      payload: { phase: "spawning", strategy: "multi", agentCount: 2 }
    },
    {
      type: "session:tool_call",
      agentName: "McManus",
      timestamp: "2026-04-12T09:01:32.000Z",
      payload: { toolName: "read_repo", resultType: "success" }
    },
    {
      type: "session:idle",
      agentName: "McManus",
      timestamp: "2026-04-12T09:06:10.000Z",
      payload: { agentName: "McManus" }
    }
  ]
}

export const squadConsoleFixture = normalizeSquadState(squadConsoleFixtureInput)

export const autonomousCompanyDashboardFixture: AutonomousCompanyDashboardData = {
  overview: {
    companyName: "OpenClaw Autonomous Coding Company",
    operatingMode: "supervised autonomy",
    mission: "Keep repo work moving from planning to verified PRs while preserving review and promotion gates.",
    activeProjects: 4,
    activePersonas: 8,
    autonomyLevel: "approval-gated merge",
    lastDirectorPassAt: "2026-04-26T08:42:00.000Z",
    decisionPolicy: "Codex may plan, implement, review, and create PRs; promotion waits for approved review evidence.",
    metrics: [
      {
        id: "throughput",
        label: "24h task throughput",
        value: 18,
        detail: "12 done, 4 review, 2 blocked",
        tone: "success"
      },
      { id: "cycle", label: "median cycle time", value: "3h 18m", detail: "planning to PR creation", tone: "info" },
      { id: "quality", label: "review pass rate", value: "86%", detail: "last 14 autonomous reviews", tone: "success" },
      { id: "risk", label: "open high risks", value: 2, detail: "quota pressure and stale FK tests", tone: "warn" }
    ]
  },
  projectHealth: [
    {
      id: "core-runtime",
      name: "Core Runtime",
      repo: "autocode",
      ownerLane: "runtime",
      health: "watch",
      score: 78,
      summary: "Build passes, but integration tests still contain stale expectations around planner run linkage.",
      lastVerifiedAt: "2026-04-26T08:15:00.000Z",
      nextAction: "Assign backend engineer to update planner-run FK fixtures."
    },
    {
      id: "ui-components",
      name: "UI Components",
      repo: "autocode",
      ownerLane: "frontend",
      health: "healthy",
      score: 91,
      summary: "Reusable transcript and multi-agent console primitives are stable and framework-independent.",
      lastVerifiedAt: "2026-04-26T08:35:00.000Z",
      nextAction: "Add dashboard contracts and fixture-backed preview surface."
    },
    {
      id: "executor",
      name: "Executor",
      repo: "autocode",
      ownerLane: "execution",
      health: "degraded",
      score: 63,
      summary: "Quota cooldown routing improved, but adapter guard tests are still failing.",
      lastVerifiedAt: "2026-04-26T07:58:00.000Z",
      nextAction: "Run focused quota and workspace guard repair loop."
    }
  ],
  activeLoops: [
    {
      id: "loop-director",
      name: "Director pass",
      status: "running",
      ownerPersona: "Engineering Manager",
      currentStep: "balancing queue lanes",
      decision: "Defer non-critical docs work until quota state returns to green.",
      nextCheckpoint: "next queue refresh"
    },
    {
      id: "loop-review",
      name: "Review sweep",
      status: "queued",
      ownerPersona: "Reviewer",
      currentStep: "waiting for new handoffs",
      decision: "Only review tasks with completed verification evidence.",
      nextCheckpoint: "after active Codex jobs finish"
    },
    {
      id: "loop-promotion",
      name: "Promotion sweep",
      status: "paused",
      ownerPersona: "Promoter",
      currentStep: "blocked by pending review approval",
      decision: "No auto-merge until review verdict is approved.",
      nextCheckpoint: "review approval event"
    }
  ],
  queueStatus: [
    { id: "queued", status: "queued", count: 9, oldestAge: "5h 12m", policy: "admit by priority and lane capacity" },
    { id: "running", status: "running", count: 4, oldestAge: "41m", policy: "respect Codex quota and worktree locks" },
    {
      id: "review",
      status: "review_needed",
      count: 5,
      oldestAge: "2h 06m",
      policy: "reviewer must record verdict before promotion"
    },
    {
      id: "blocked",
      status: "blocked",
      count: 3,
      oldestAge: "19h",
      policy: "escalate when no progress after two passes"
    },
    {
      id: "promote",
      status: "promotion_pending",
      count: 2,
      oldestAge: "54m",
      policy: "merge only with approved review and passing checks"
    }
  ],
  runningCodexJobs: [
    {
      id: "job-184",
      taskId: "OC-184",
      title: "Repair planner-run FK setup",
      persona: "Backend Engineer",
      model: "gpt-5.3-codex-spark",
      status: "running",
      branch: "openclaw/oc-184-planner-fk",
      startedAt: "2026-04-26T08:18:00.000Z",
      decisionSummary: "Focused fix only; do not touch queue routing tests in the same pass."
    },
    {
      id: "job-185",
      taskId: "OC-185",
      title: "Dashboard contracts and fixture UI",
      persona: "Frontend Engineer",
      model: "gpt-5.5",
      status: "running",
      branch: "openclaw/oc-185-dashboard",
      startedAt: "2026-04-26T08:24:00.000Z",
      decisionSummary: "Build generic components in ui-components so future apps can render the same contract."
    }
  ],
  reviewNeededTasks: [
    {
      id: "review-172",
      title: "Rate-limit traffic-light admission",
      project: "Domain",
      ownerPersona: "Reviewer",
      priority: "high",
      reason: "New routing policy changes when autonomous execution may proceed.",
      nextAction: "Check focused tests and decision trace before approval."
    },
    {
      id: "review-176",
      title: "Execution workspace quarantine",
      project: "Executor",
      ownerPersona: "Security Reviewer",
      priority: "critical",
      reason: "Workspace guard touches filesystem safety boundaries.",
      nextAction: "Verify repo-bound guard behavior and failure messages."
    }
  ],
  blockedTasks: [
    {
      id: "blocked-091",
      title: "Adapter workspace guard test repair",
      project: "Executor",
      ownerPersona: "Backend Engineer",
      priority: "high",
      reason: "Regression suite cannot be trusted until guard expectations match current policy.",
      nextAction: "Compare current guard behavior with quarantine design note.",
      blocker: "Stale test assertions disagree with updated workspace policy.",
      escalationOwner: "CTO / System Architect"
    },
    {
      id: "blocked-104",
      title: "Promotion retry for stale PR",
      project: "Promotion",
      ownerPersona: "Promoter",
      priority: "medium",
      reason: "Merge is waiting on human review state.",
      nextAction: "Re-check PR approval and CI status on next promotion sweep.",
      blocker: "Approval state is pending.",
      escalationOwner: "Engineering Manager"
    }
  ],
  personaScorecards: [
    {
      id: "planner",
      persona: "Planner",
      role: "planning",
      status: "completed",
      score: 88,
      throughput: 14,
      reviewPassRate: 0.82,
      decisionQuality: 0.9,
      currentFocus: "Deduplicate automation-created tasks before queue admission."
    },
    {
      id: "frontend",
      persona: "Frontend Engineer",
      role: "frontend",
      status: "running",
      score: 92,
      throughput: 7,
      reviewPassRate: 0.91,
      decisionQuality: 0.94,
      currentFocus: "Create reusable dashboard contracts and preview fixtures."
    },
    {
      id: "reviewer",
      persona: "Reviewer",
      role: "quality",
      status: "queued",
      score: 84,
      throughput: 11,
      reviewPassRate: 0.88,
      decisionQuality: 0.86,
      currentFocus: "Prioritize high-risk runtime and filesystem changes."
    },
    {
      id: "promoter",
      persona: "Promoter",
      role: "release",
      status: "paused",
      score: 76,
      throughput: 5,
      reviewPassRate: 0.8,
      decisionQuality: 0.83,
      currentFocus: "Wait for explicit approval evidence before auto-merge."
    }
  ],
  adapterQuotas: [
    {
      id: "codex-local",
      adapter: "Codex Local",
      lane: "implementation",
      state: "amber",
      remaining: 42,
      limit: 180,
      resetAt: "2026-04-26T12:00:00.000Z",
      policy: "Admit priority 0 jobs; defer low-priority background work."
    },
    {
      id: "gemini-local",
      adapter: "Gemini Local",
      lane: "research",
      state: "green",
      remaining: 310,
      limit: 400,
      resetAt: "2026-04-27T00:00:00.000Z",
      policy: "Available for architecture research and summarization."
    },
    {
      id: "azure-foundry",
      adapter: "Azure Foundry",
      lane: "fallback",
      state: "unknown",
      remaining: null,
      limit: null,
      policy: "Proceed only when selected explicitly or local adapters fail."
    }
  ],
  recentDecisions: [
    {
      id: "decision-231",
      madeAt: "2026-04-26T08:42:00.000Z",
      actor: "Director",
      action: "dispatch_task",
      rationale: "Planner FK failures block trustworthy test results and have a narrow backend ownership boundary.",
      outcome: "Dispatched OC-184 to Backend Engineer.",
      evidence: ["test failures mention planner run FK setup", "backend owns db/store contracts"]
    },
    {
      id: "decision-232",
      madeAt: "2026-04-26T08:44:00.000Z",
      actor: "Director",
      action: "pause_due_to_risk",
      rationale: "Promotion queue has candidates, but approval evidence is not yet recorded.",
      outcome: "Promotion loop paused until review verdict changes.",
      evidence: ["promotion_pending=2", "review_needed=5"]
    },
    {
      id: "decision-233",
      madeAt: "2026-04-26T08:46:00.000Z",
      actor: "Frontend Engineer",
      action: "create_reusable_dashboard",
      rationale: "The control plane needs a backend-free dashboard preview and reusable host-agnostic UI.",
      outcome: "Use typed fixtures and generic package components.",
      evidence: ["ui-components has no router dependency", "fixtures already normalize agent console data"]
    }
  ],
  riskAlerts: [
    {
      id: "risk-quota",
      severity: "high",
      title: "Codex quota entering amber state",
      project: "Execution",
      signal: "Remaining calls are under the 25 percent admission threshold.",
      mitigation: "Run priority tasks only and shift research work to Gemini Local."
    },
    {
      id: "risk-tests",
      severity: "medium",
      title: "Regression suite has stale expectations",
      project: "Core Runtime",
      signal: "Known failures cluster around routing cooldowns and planner-run setup.",
      mitigation: "Repair expectations in focused lanes before broad feature work."
    }
  ],
  promotionCandidates: [
    {
      id: "promo-120",
      taskId: "OC-120",
      title: "Quota cache unknown-state fix",
      branch: "openclaw/oc-120-quota-cache",
      readiness: 91,
      checks: "passing",
      reviewState: "waiting",
      mergePolicy: "squash after approved review"
    },
    {
      id: "promo-121",
      taskId: "OC-121",
      title: "Runtime DB backup CLI",
      branch: "openclaw/oc-121-db-backup",
      readiness: 74,
      checks: "pending",
      reviewState: "waiting",
      mergePolicy: "hold until checks and review pass"
    }
  ],
  pullRequests: [
    {
      id: "pr-38",
      title: "Fix quota cooldown handling for unknown cache state",
      repo: "autocode",
      url: "https://example.test/openclaw/pull/38",
      authorPersona: "Backend Engineer",
      state: "ready_for_review",
      createdAt: "2026-04-26T06:55:00.000Z",
      decisionSummary: "Small policy patch; ready for focused runtime review."
    },
    {
      id: "pr-39",
      title: "Import Squad-inspired rate limit utilities",
      repo: "autocode",
      url: "https://example.test/openclaw/pull/39",
      authorPersona: "CTO / System Architect",
      state: "open",
      createdAt: "2026-04-26T07:20:00.000Z",
      decisionSummary: "Architecture utility addition; lint warnings are unrelated and pre-existing."
    }
  ],
  evaluationTrends: [
    { label: "Mon", passRate: 0.71, regressions: 8, coverage: 0.58 },
    { label: "Tue", passRate: 0.77, regressions: 6, coverage: 0.61 },
    { label: "Wed", passRate: 0.82, regressions: 4, coverage: 0.67 },
    { label: "Thu", passRate: 0.79, regressions: 5, coverage: 0.7 },
    { label: "Fri", passRate: 0.86, regressions: 3, coverage: 0.74 },
    { label: "Sat", passRate: 0.88, regressions: 2, coverage: 0.76 },
    { label: "Sun", passRate: 0.83, regressions: 5, coverage: 0.78 }
  ],
  auditTimeline: [
    {
      id: "audit-1",
      at: "2026-04-26T08:18:00.000Z",
      actor: "Backend Engineer",
      event: "codex_job_started",
      tone: "info",
      detail: "Started OC-184 on planner-run FK test repair."
    },
    {
      id: "audit-2",
      at: "2026-04-26T08:24:00.000Z",
      actor: "Frontend Engineer",
      event: "codex_job_started",
      tone: "info",
      detail: "Started OC-185 to add fixture-backed dashboard UI contracts."
    },
    {
      id: "audit-3",
      at: "2026-04-26T08:42:00.000Z",
      actor: "Director",
      event: "queue_decision_applied",
      tone: "success",
      detail: "Dispatched high-priority runtime repair and deferred low-priority docs work."
    },
    {
      id: "audit-4",
      at: "2026-04-26T08:44:00.000Z",
      actor: "Promoter",
      event: "promotion_paused",
      tone: "warn",
      detail: "Promotion stayed paused because approved review evidence was missing."
    }
  ]
}
