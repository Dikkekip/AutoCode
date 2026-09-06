import {
  applyOpenClawTaskRecipe,
  buildContextHintBundle,
  completionRuleForRoleResult,
  createDiagnosticsManifest,
  diagnosticsSensitivePaths,
  evaluateBudgetPressure,
  extractAutomationVariableNames,
  findWorkspaceCommandDefinition,
  formatPullRequestFeedback,
  inferOpenAiCompatibleBiller,
  listWorkspaceCommandDefinitions,
  parseContextFileNames,
  renderOpenClawTaskRecipe,
  resolveWorkflowTransition,
  reviewFeedbackRequiresExistingBranch,
  selectWorkerRoleTier,
  successfulWorkflowTaskStatus,
  syncAutomationVariablesWithTemplate,
  type TaskPackage
} from "@openclaw/domain"
import { describe, expect, it } from "vitest"

const baseTaskPackage: TaskPackage = {
  version: 1,
  generatedAt: "2026-04-28T00:00:00.000Z",
  repoProfile: "minimal-repo",
  likelyOwnershipLane: "app-core",
  laneReason: "test",
  inferenceSignals: [],
  requiredReading: ["README.md"],
  verificationChecklist: ["pnpm test"],
  contractUpdateReminders: [],
  repoNotes: []
}

describe("imported framework ideas", () => {
  it("selects DevClaw-style worker role tiers without hardcoding model ids", () => {
    expect(
      selectWorkerRoleTier({
        projectId: "OpenClaw",
        kind: "implement",
        title: "Fix CSS typo",
        labels: ["css"],
        changedFiles: ["apps/web/button.css"],
        laneId: "frontend"
      })
    ).toMatchObject({
      role: "developer",
      tier: "junior",
      sessionKey: "openclaw:developer:junior:frontend"
    })

    expect(
      selectWorkerRoleTier({
        projectId: "OpenClaw",
        kind: "implement",
        title: "Migrate authentication schema across runtime packages",
        labels: ["security", "migration"],
        changedFiles: Array.from({ length: 9 }, (_, index) => `packages/runtime/file-${index}.ts`),
        laneId: "backend"
      })
    ).toMatchObject({
      role: "developer",
      tier: "senior"
    })
  })

  it("renders Goose-style composable task recipes and subrecipes", () => {
    const rendered = renderOpenClawTaskRecipe(
      {
        id: "review-pipeline",
        title: "Review Pipeline",
        description: "Run focused review passes",
        instructions: "Review {{ area }} before implementation.",
        parameters: [{ key: "area", required: true }],
        subRecipes: [
          {
            name: "security_scan",
            values: { depth: "strict" },
            recipe: {
              id: "security",
              title: "Security Scan",
              description: "Find security regressions",
              instructions: "Use {{ depth }} security review for {{ area }}.",
              parameters: [
                { key: "area", required: true },
                { key: "depth", default: "normal" }
              ],
              prompt: "Report risks in {{ area }}."
            }
          }
        ]
      },
      { area: "auth" }
    )

    expect(rendered.instructions).toEqual(["Review auth before implementation."])
    expect(rendered.subRecipes[0]?.instructions).toEqual(["Use strict security review for auth."])
    expect(rendered.subRecipes[0]?.prompt).toBe("Report risks in auth.")
  })

  it("applies recipes to task packages with deduped instructions and verification", () => {
    const taskPackage = applyOpenClawTaskRecipe({
      taskPackage: baseTaskPackage,
      recipe: {
        id: "backend-contract",
        title: "Backend Contract Change",
        description: "Keep contract checks explicit",
        lane: "backend",
        requiredReading: ["README.md", "contracts/openapi.yaml"],
        verificationCommands: ["pnpm test", "pnpm contract:test"],
        extraInstructions: ["Update callers before changing the API."]
      }
    })

    expect(taskPackage.likelyOwnershipLane).toBe("backend")
    expect(taskPackage.requiredReading).toEqual(["README.md", "contracts/openapi.yaml"])
    expect(taskPackage.verificationChecklist).toEqual(["pnpm test", "pnpm contract:test"])
    expect(taskPackage.inferenceSignals).toContain("recipe:backend-contract")
    expect(taskPackage.extraInstructions).toContain("Update callers before changing the API.")
  })

  it("normalizes Paperclip-style workspace command/service/job config", () => {
    const commands = listWorkspaceCommandDefinitions({
      commands: [
        { name: "Check", command: "pnpm check" },
        { id: "check", name: "Duplicate Check", command: "pnpm lint" }
      ],
      services: [{ name: "Preview", command: "pnpm dev", lifecycle: "ephemeral", cwd: "apps/web" }],
      jobs: [{ title: "Nightly Eval", command: "pnpm eval" }]
    })

    expect(commands.map((command) => [command.id, command.kind, command.command])).toEqual([
      ["command:check", "command", "pnpm check"],
      ["check", "command", "pnpm lint"],
      ["service:preview", "service", "pnpm dev"],
      ["job:nightly-eval", "job", "pnpm eval"]
    ])
    const previewService = findWorkspaceCommandDefinition(
      { services: [{ name: "Preview", command: "pnpm dev" }] },
      "service:preview"
    )
    expect(previewService?.lifecycle).toBe("shared")
  })

  it("builds Goose-style diagnostics manifests with explicit sensitive sections", () => {
    const manifest = createDiagnosticsManifest({
      generatedAt: "2026-04-28T12:00:00.000Z",
      sessionId: "codex/session 42",
      projectId: "p1",
      projectName: "OpenClaw",
      taskId: "t1",
      runId: "r1",
      extraPaths: [".openclaw/artifacts/r1"]
    })

    expect(manifest.bundleName).toBe("diagnostics_codex-session-42_2026-04-28.zip")
    expect(manifest.sections.map((section) => section.kind)).toEqual(["system", "session", "config", "logs", "state"])
    expect(diagnosticsSensitivePaths(manifest)).toContain(".openclaw/logs")
    expect(manifest.privacyNotice).toContain("Review diagnostics before sharing")
  })

  it("formats DevClaw-style PR feedback with branch-safe conflict instructions", () => {
    const feedback = {
      url: "https://github.com/acme/repo/pull/7",
      branchName: "feature/auth",
      reason: "merge_conflict" as const,
      comments: [
        { id: 1, author: "reviewer", body: "Resolve the auth conflict.", state: "open", path: "auth.ts", line: 12 }
      ]
    }
    const formatted = formatPullRequestFeedback({ feedback, baseBranch: "main" })

    expect(formatted).toContain("Merge conflicts detected")
    expect(formatted).toContain("Branch: feature/auth")
    expect(formatted).toContain("Push back to feature/auth with force-with-lease")
    expect(reviewFeedbackRequiresExistingBranch(feedback)).toBe(true)
  })

  it("evaluates Paperclip-style budget pressure and OpenAI-compatible biller routing", () => {
    expect(evaluateBudgetPressure({ limit: 100, usage: 85, window: "daily" })).toMatchObject({
      pressure: "warning",
      remaining: 15,
      blocked: false
    })
    expect(evaluateBudgetPressure({ limit: 100, usage: 100, window: "monthly" })).toMatchObject({
      pressure: "blocked",
      blocked: true
    })
    expect(inferOpenAiCompatibleBiller({ OPENAI_BASE_URL: "https://openrouter.ai/api/v1" })).toBe("openrouter")
  })

  it("builds Goose-style hierarchical context hint bundles", () => {
    expect(parseContextFileNames('["CLAUDE.md",".goosehints"]')).toEqual(["CLAUDE.md", ".goosehints"])
    const bundle = buildContextHintBundle([
      { source: "local", path: "frontend/.goosehints", content: "Use design system. @docs/components.md" },
      { source: "global", path: ".goosehints", content: "Run tests. docs/contributing.md" },
      { source: "local", path: ".goosehints", content: "Root rules. @README.md" }
    ])

    expect(bundle.entries.map((entry) => entry.path)).toEqual([".goosehints", ".goosehints", "frontend/.goosehints"])
    expect(bundle.immediateReferencePaths).toEqual(["README.md", "docs/components.md"])
    expect(bundle.optionalReferencePaths).toEqual(["docs/contributing.md"])
    expect(bundle.systemPrompt).toContain("# Context Hints: frontend/.goosehints")
  })

  it("syncs Paperclip-style automation variables from templates", () => {
    expect(extractAutomationVariableNames(["Daily {{date}}", "Review {{repo}} for {{priority}} in {{repo}}"])).toEqual([
      "date",
      "repo",
      "priority"
    ])

    expect(
      syncAutomationVariablesWithTemplate("Review {{repo}} and {{priority}} on {{date}}", [
        {
          name: "repo",
          label: "Repository",
          type: "text",
          defaultValue: "openclaw",
          required: true,
          options: []
        }
      ])
    ).toEqual([
      {
        name: "repo",
        label: "Repository",
        type: "text",
        defaultValue: "openclaw",
        required: true,
        options: []
      },
      {
        name: "priority",
        label: null,
        type: "text",
        defaultValue: null,
        required: true,
        options: []
      }
    ])
  })

  it("resolves DevClaw-style deterministic workflow transitions", () => {
    expect(resolveWorkflowTransition("doing", "COMPLETE")).toEqual({
      target: "toReview",
      actions: ["detect_pr"]
    })
    expect(completionRuleForRoleResult("tester", "fail")).toEqual({
      from: "testing",
      to: "toImprove",
      actions: ["reopen_issue"]
    })
    expect(completionRuleForRoleResult("architect", "done")).toEqual({
      from: "researching",
      to: "done",
      actions: ["close_issue"]
    })
    expect(
      successfulWorkflowTaskStatus({
        kind: "implement",
        stage: "coder",
        title: "Implement API change",
        labels: [],
        reviewRequired: true
      } as never)
    ).toBe("review_needed")
    expect(
      successfulWorkflowTaskStatus({
        kind: "implement",
        stage: "coder",
        title: "Add timeline empty state regression test",
        labels: [],
        reviewRequired: true
      } as never)
    ).toBe("review_needed")
  })
})
