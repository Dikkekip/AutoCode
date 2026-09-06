import { executeCommand } from "@openclaw/os-adapters"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { syncRepoAndWorktrees } from "../packages/executor/src/git-sync.js"

vi.mock("@openclaw/os-adapters", () => {
  return {
    executeCommand: vi.fn()
  }
})

describe("syncRepoAndWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("fetches, fast-forward pulls, and pushes ahead clean checkouts", async () => {
    const repo = "/tmp/project"
    const worktree = "/tmp/project.worktrees/feature-42-test"
    const mockResponses: Record<string, { stdout?: string; exitCode?: number; stderr?: string }> = {
      [`${repo}|branch --show-current`]: { stdout: "main\n" },
      [`${repo}|remote get-url origin`]: { stdout: "git@example.com:org/project.git\n" },
      [`${repo}|rev-parse --abbrev-ref --symbolic-full-name @{u}`]: { stdout: "origin/main\n" },
      [`${repo}|status --porcelain`]: { stdout: "" },
      [`${repo}|pull --ff-only`]: { exitCode: 0 },
      [`${repo}|rev-list --left-right --count @{u}...HEAD`]: { stdout: "0 1\n" },
      [`${repo}|push`]: { exitCode: 0 },
      [`${repo}|worktree prune`]: { exitCode: 0 },
      [`${repo}|worktree list --porcelain`]: {
        stdout: `worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD def\nbranch refs/heads/feature-42-test\n`
      },
      [`${worktree}|branch --show-current`]: { stdout: "feature-42-test\n" },
      [`${worktree}|remote get-url origin`]: { stdout: "git@example.com:org/project.git\n" },
      [`${worktree}|rev-parse --abbrev-ref --symbolic-full-name @{u}`]: { stdout: "origin/feature-42-test\n" },
      [`${worktree}|status --porcelain`]: { stdout: "" },
      [`${worktree}|pull --ff-only`]: { exitCode: 0 },
      [`${worktree}|rev-list --left-right --count @{u}...HEAD`]: { stdout: "0 0\n" }
    }

    vi.mocked(executeCommand).mockImplementation((_command, args, opts) => {
      const cwd = opts?.cwd
      const key = `${cwd}|${args.join(" ")}`
      const res = mockResponses[key] ?? { exitCode: 0, stdout: "", stderr: "" }
      return {
        ok: (res.exitCode ?? 0) === 0,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        exitCode: res.exitCode ?? 0
      } as any
    })

    const result = await syncRepoAndWorktrees({ repoPath: repo })

    expect(result.root.pulled).toBe(true)
    expect(result.root.pushed).toBe(true)
    expect(result.worktrees.length).toBe(1)
    expect(result.worktrees[0]!.pulled).toBe(true)

    const calls = vi.mocked(executeCommand).mock.calls
    expect(calls.some((c) => c[2]?.cwd === repo && c[1]?.join(" ") === "fetch --prune origin")).toBe(true)
    expect(calls.some((c) => c[2]?.cwd === repo && c[1]?.join(" ") === "push")).toBe(true)
    expect(calls.some((c) => c[2]?.cwd === worktree && c[1]?.join(" ") === "pull --ff-only")).toBe(true)
  })

  it("skips dirty worktrees without pulling them", async () => {
    const repo = "/tmp/project"
    const worktree = "/tmp/project.worktrees/feature-dirty"
    const mockResponses: Record<string, { stdout?: string; exitCode?: number; stderr?: string }> = {
      [`${repo}|branch --show-current`]: { stdout: "main\n" },
      [`${repo}|remote get-url origin`]: { stdout: "git@example.com:org/project.git\n" },
      [`${repo}|rev-parse --abbrev-ref --symbolic-full-name @{u}`]: { stdout: "origin/main\n" },
      [`${repo}|status --porcelain`]: { stdout: "" },
      [`${repo}|pull --ff-only`]: { exitCode: 0 },
      [`${repo}|rev-list --left-right --count @{u}...HEAD`]: { stdout: "0 0\n" },
      [`${repo}|worktree prune`]: { exitCode: 0 },
      [`${repo}|worktree list --porcelain`]: {
        stdout: `worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD def\nbranch refs/heads/feature-dirty\n`
      },
      [`${worktree}|branch --show-current`]: { stdout: "feature-dirty\n" },
      [`${worktree}|remote get-url origin`]: { stdout: "git@example.com:org/project.git\n" },
      [`${worktree}|rev-parse --abbrev-ref --symbolic-full-name @{u}`]: { stdout: "origin/feature-dirty\n" },
      [`${worktree}|status --porcelain`]: { stdout: " M file.ts\n" }
    }

    vi.mocked(executeCommand).mockImplementation((_command, args, opts) => {
      const cwd = opts?.cwd
      const key = `${cwd}|${args.join(" ")}`
      const res = mockResponses[key] ?? { exitCode: 0, stdout: "", stderr: "" }
      return {
        ok: (res.exitCode ?? 0) === 0,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        exitCode: res.exitCode ?? 0
      } as any
    })

    const result = await syncRepoAndWorktrees({ repoPath: repo })

    expect(result.worktrees[0]!.skipped).toBe("worktree has local changes")
    const calls = vi.mocked(executeCommand).mock.calls
    expect(calls.some((c) => c[2]?.cwd === worktree && c[1]?.join(" ") === "pull --ff-only")).toBe(false)
  })
})
