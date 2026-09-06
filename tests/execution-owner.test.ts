/** Two-store and real legacy-tick cutover fixtures use disposable control roots. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { DispatcherStore } from "../packages/db/src/store.js"
import { DispatcherExecutor } from "../packages/executor/src/runner.js"
import {
  assertExecutionOwnership,
  ExecutionOwnerStore,
  withExecutionOwner
} from "../packages/os-adapters/src/execution-owner.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "execution-owner-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const control = join(root, "control"),
    repo = join(root, "repo")
  mkdirSync(repo)
  const previous = process.env.OPENCLAW_CONTROL_ROOT
  process.env.OPENCLAW_CONTROL_ROOT = control
  cleanups.push(() => {
    if (previous === undefined) delete process.env.OPENCLAW_CONTROL_ROOT
    else process.env.OPENCLAW_CONTROL_ROOT = previous
  })
  let now = 1000
  const a = new ExecutionOwnerStore(control, () => now),
    b = new ExecutionOwnerStore(control, () => now)
  cleanups.push(
    () => a.close(),
    () => b.close()
  )
  return {
    root,
    repo,
    a,
    b,
    advance: (ms: number) => {
      now += ms
    }
  }
}
const digest = "a".repeat(64)
it("atomically chooses one owner and refuses cutover while its execution lease is live", () => {
  const s = fixture(),
    lease = s.a.acquire(s.repo, "legacy", 100)
  expect(() => s.b.acquire(s.repo, "native", 100)).toThrow(/belongs to legacy/)
  expect(() => s.b.transfer(s.repo, 1, "paused", digest, "reviewed cutover")).toThrow(/live work/)
  s.a.release(lease.id)
  expect(s.b.transfer(s.repo, 1, "paused", digest, "reviewed cutover").generation).toBe(2)
  expect(() => s.a.acquire(s.repo, "legacy")).toThrow(/paused/)
  const native = s.b.transfer(s.repo, 2, "native", digest, "import complete")
  expect(native.generation).toBe(3)
  expect(s.b.transfer(s.repo, 2, "native", digest, "lost response retry")).toEqual(native)
  expect(() => s.a.acquire(s.repo, "legacy")).toThrow(/native/)
})
it("rejects stale generation, edited plans and expired former owners after takeover", () => {
  const s = fixture(),
    old = s.a.acquire(s.repo, "legacy", 100)
  s.advance(100)
  s.b.transfer(s.repo, 1, "paused", digest, "expired owner")
  expect(() => s.b.transfer(s.repo, 2, "native", "b".repeat(64), "edited plan")).toThrow(/plan changed/)
  s.b.transfer(s.repo, 2, "native", digest, "reviewed plan")
  expect(() => s.a.assert(old)).toThrow(/revoked/)
  expect(() => s.a.transfer(s.repo, 1, "paused", digest, "stale")).toThrow(/stale/)
})
it("keeps a cooperative runtime lease alive for the whole awaited action", async () => {
  const s = fixture()
  await withExecutionOwner(s.repo, "native", async () => {
    assertExecutionOwnership()
    // Wrapper uses wall clock, so inspect via a store using the same wall clock.
    const reader = new ExecutionOwnerStore(process.env.OPENCLAW_CONTROL_ROOT)
    try {
      expect(() => reader.transfer(s.repo, 1, "paused", digest, "cutover during execution")).toThrow(/live work/)
    } finally {
      reader.close()
    }
  })
})
it("rejects a candidate-owned control root", () => {
  const s = fixture(),
    invalid = new ExecutionOwnerStore(join(s.repo, "control"))
  try {
    expect(() => invalid.acquire(s.repo, "native")).toThrow(/outside/)
  } finally {
    invalid.close()
  }
})
it("a real restarted legacy executor tick refuses a native-owned project before scheduling work", async () => {
  const s = fixture(),
    db = new DispatcherStore(join(s.root, "legacy.db"))
  cleanups.push(() => db.close())
  db.migrate()
  const company = db.createCompany({ name: "owner fixture" })
  db.createProject({ companyRef: company.id, name: "project", repoPath: s.repo })
  s.a.claim(s.repo, "legacy")
  s.a.transfer(s.repo, 1, "paused", digest, "reviewed paused plan")
  s.a.transfer(s.repo, 2, "native", digest, "native owner")
  const executor = new DispatcherExecutor(db, {})
  await expect(executor.tick(company.id)).rejects.toThrow(/belongs to native/)
  await expect(new DispatcherExecutor(db, {}).tick(company.id)).rejects.toThrow(/belongs to native/)
  expect(db.listRuns()).toHaveLength(0)
})
