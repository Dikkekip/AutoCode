// Required CI authorization regression fixtures; no GitHub credentials or network used.
import { describe, expect, it } from "vitest"
import { assertNativeRequiredCi } from "../packages/core-runtime/src/native/required-ci.js"
import type { NativeAutonomyPolicy } from "../packages/domain/src/native-autonomy.js"

const now = Date.parse("2026-09-06T12:00:00Z"),
  sha = "a".repeat(40)
const policy = {
  baseBranch: "main",
  requiredCi: { checks: [{ name: "verify", appId: 42 }], maxAgeSeconds: 3600 }
} as NativeAutonomyPolicy
const run = {
  name: "verify",
  app: { id: 42 },
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  started_at: "2026-09-06T11:58:00Z",
  completed_at: "2026-09-06T11:59:00Z"
}
const github =
  (runs: unknown[], protection: unknown = { checks: [{ context: "verify", app_id: 42 }], contexts: ["verify"] }) =>
  async (_cwd: string, args: string[]) =>
    JSON.stringify(args.some((arg) => arg.includes("check-runs")) ? [{ check_runs: runs }] : protection)
describe("required CI authorization", () => {
  it("accepts exact successful checks and ignores unrelated optional skips", async () => {
    await expect(
      assertNativeRequiredCi(
        policy,
        "/tmp",
        sha,
        github([run, { ...run, name: "optional", conclusion: "skipped" }]),
        now
      )
    ).resolves.toBeUndefined()
  })
  it.each([
    [],
    [{ ...run, head_sha: "b".repeat(40) }],
    [{ ...run, conclusion: "skipped" }],
    [{ ...run, conclusion: "neutral" }],
    [{ ...run, status: "in_progress" }],
    [{ ...run, app: { id: 99 } }],
    [run, run],
    [{ ...run, completed_at: "2026-09-05T00:00:00Z" }],
    [{ ...run, completed_at: "invalid" }]
  ])("rejects missing, stale, skipped, ambiguous and wrong-identity evidence %#", async (...entries) => {
    await expect(assertNativeRequiredCi(policy, "/tmp", sha, github(entries), now)).rejects.toThrow()
  })
  it("fails closed when protected requirements differ or are unavailable", async () => {
    await expect(
      assertNativeRequiredCi(
        policy,
        "/tmp",
        sha,
        github([run], { checks: [{ context: "security", app_id: 1 }], contexts: [] }),
        now
      )
    ).rejects.toThrow("branch protection")
    await expect(
      assertNativeRequiredCi(
        policy,
        "/tmp",
        sha,
        async () => {
          throw new Error("403 unavailable")
        },
        now
      )
    ).rejects.toThrow("403")
  })
})

it("checks later REST pages without relying on CLI slurp support", async () => {
  let count = 0
  await assertNativeRequiredCi(
    policy,
    "/tmp",
    sha,
    async (_cwd, args) => {
      expect(args).not.toContain("--slurp")
      if (args.at(-1)?.includes("protection")) return JSON.stringify({ checks: [], contexts: [] })
      count++
      expect(args.at(-1)).toContain(`page=${count}`)
      return JSON.stringify({
        check_runs: count === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...run, name: `optional-${i}` })) : [run]
      })
    },
    now
  )
  expect(count).toBe(2)
})
