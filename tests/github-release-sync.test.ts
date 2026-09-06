import { afterEach, describe, expect, it } from "vitest"
import { auditGitHubReleases, syncGitHubReleases } from "../apps/dispatcher-cli/src/github.js"
import { createFakeGhScript, createTempWorkspace } from "./helpers.js"
import { HAS_NODE_SQLITE } from "./node-sqlite.js"

let DispatcherStore: typeof import("@openclaw/db").DispatcherStore | null = null
if (HAS_NODE_SQLITE) {
  ;({ DispatcherStore } = await import("@openclaw/db"))
}

const describeDb = HAS_NODE_SQLITE ? describe : describe.skip

describeDb("GitHub release sync", () => {
  const cleanups: Array<() => void> = []
  const originalPath = process.env.PATH

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  it("imports published GitHub releases into the dispatcher release table once", () => {
    const workspace = createTempWorkspace("github-release-sync")
    cleanups.push(workspace.cleanup)
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath ?? ""}`

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Release Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })

    const first = syncGitHubReleases(store, { projectRef: project.id, repo: "acme/repo", limit: 10 })
    expect(first.imported).toBe(1)
    expect(first.skipped).toBe(1)
    expect(store.listReleases(project.id).map((release) => release.version)).toEqual(["v1.2.3"])
    expect(store.listReleases(project.id)[0]!.notes).toContain("https://github.com/acme/repo/releases/tag/v1.2.3")

    const second = syncGitHubReleases(store, { projectRef: project.id, repo: "acme/repo", limit: 10 })
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(2)
    expect(store.listReleases(project.id)).toHaveLength(1)

    store.close()
  })

  it("audits release metadata for persona and portfolio evidence", () => {
    const workspace = createTempWorkspace("github-release-audit")
    cleanups.push(workspace.cleanup)
    createFakeGhScript(workspace.root, "merge")
    process.env.PATH = `${workspace.root}:${originalPath ?? ""}`

    const store = new DispatcherStore!(workspace.dbPath)
    store.migrate()
    const company = store.createCompany({ name: "Release Co" })
    const project = store.createProject({
      companyRef: company.id,
      name: "repo",
      repoPath: workspace.repoPath
    })

    const audit = auditGitHubReleases(store, { projectRef: project.id, repo: "acme/repo", limit: 2 })

    expect(audit.inspected).toBe(2)
    expect(audit.personaTagged).toBe(1)
    expect(audit.byPersona["lawyer-legal-strategy"]).toBe(1)
    expect(audit.byBucket.legal_domain).toBe(1)
    expect(audit.regressionLike).toBe(1)

    store.close()
  })
})
