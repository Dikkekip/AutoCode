import { describe, expect, it } from "vitest"
import { normalizeOpenClawStateBackend, openClawStatePath, planOpenClawStateSync } from "./state-backends.js"

describe("OpenCLAW state backends", () => {
  it("defaults to workspace-local runtime state", () => {
    const backend = normalizeOpenClawStateBackend()

    expect(backend).toEqual({
      mode: "workspace",
      rootDir: ".openclaw/state",
      runtimeDir: "current",
      bootstrapDir: "bootstrap",
      branch: null,
      remote: null,
      syncHooks: false
    })
  })

  it("maps legacy distributed backend names to OpenCLAW-native modes", () => {
    expect(normalizeOpenClawStateBackend({ mode: "git-orphan" }).mode).toBe("detached-git")
    expect(normalizeOpenClawStateBackend({ mode: "git-notes" }).mode).toBe("two-layer")
    expect(normalizeOpenClawStateBackend({ mode: "worktree" }).mode).toBe("workspace")
  })

  it("falls back from unsafe git command tokens", () => {
    const backend = normalizeOpenClawStateBackend({
      mode: "detached-git",
      branch: "state/openclaw; rm -rf .",
      remote: "origin && bad"
    })

    expect(backend.branch).toBe("openclaw/state")
    expect(backend.remote).toBe("origin")
  })

  it("derives stable runtime and bootstrap paths", () => {
    const backend = normalizeOpenClawStateBackend({ mode: "two-layer", rootDir: "/.openclaw/state/" })

    expect(openClawStatePath(backend, "/queue.json")).toEqual({
      key: "queue.json",
      kind: "runtime",
      path: ".openclaw/state/current/queue.json",
      persistent: true
    })
    expect(openClawStatePath(backend, "manager_state.json", "bootstrap").path).toBe(
      ".openclaw/state/bootstrap/manager_state.json"
    )
  })

  it("plans detached git sync commands only when a distributed backend is selected", () => {
    expect(planOpenClawStateSync({ mode: "workspace" }).operatorCommands).toEqual([])

    const plan = planOpenClawStateSync({
      mode: "orphan",
      branch: "state/openclaw",
      remote: "upstream",
      syncHooks: true
    })

    expect(plan.backend.mode).toBe("detached-git")
    expect(plan.operatorCommands).toEqual([
      "git fetch upstream state/openclaw && git read-tree --prefix=.openclaw/state/ upstream/state/openclaw",
      "git subtree split --prefix=.openclaw/state -b state/openclaw && git push upstream state/openclaw"
    ])
    expect(plan.hookCommands.preCommit).toHaveLength(1)
    expect(plan.hookCommands.postMerge).toHaveLength(1)
  })
})
