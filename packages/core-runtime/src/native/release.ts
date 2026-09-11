import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { assertNativeReleaseGate, validateNativeAssessment } from "@openclaw/domain"
import { assertExecutionOwnership } from "@openclaw/os-adapters"
import { reconcileNativeDeployment } from "./deployment.js"
import { assertNativeDeploymentPolicy } from "./deployment-health.js"
import { assertNativeMode, assertNativePromotion } from "./promotion-mode.js"
import { assertNativeProvenance, nativeContentDigest, nativeVerificationDigest } from "./provenance.js"
import { assertNativeRequiredCi, NativeCiPending } from "./required-ci.js"
import type { NativeAutonomyRuntime, NativeWorkflow } from "./runtime.js"
import { nativePolicyTraceDigest, withNativeStageTrace } from "./telemetry.js"
import {
  assertNativeVerificationAuthority,
  assertNativeVerificationEvidence,
  nativeGit,
  runNativeDeploymentCommand
} from "./verification.js"

export class NativeReleasePending extends Error {}
const exec = promisify(execFile)
async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    return (await exec("gh", args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
  } catch (error) {
    const failure = error as { killed?: boolean; message?: string; stderr?: string }
    if (
      failure.killed ||
      /timeout|connection|network|TLS|ECONN|temporar/i.test(`${failure.message} ${failure.stderr}`)
    ) {
      throw new NativeReleasePending("GitHub transport interrupted; reconcile remote state before retrying any effect")
    }
    throw error
  }
}
/** Unknown external outcomes remain durable and block replay until positively reconciled. */
export interface NativeReleaseIO {
  now?: () => number
  git: typeof nativeGit
  github: typeof gh
  command: (
    command: import("@openclaw/domain").NativeCommand,
    root: string,
    artifact: string,
    env: Record<string, string>
  ) => ReturnType<typeof runNativeDeploymentCommand>
}
export async function releaseNativeWorkflow(
  runtime: NativeAutonomyRuntime,
  id: string,
  w: NativeWorkflow,
  io: NativeReleaseIO = {
    git: nativeGit,
    github: gh,
    command: (command, root, artifact, env) =>
      runNativeDeploymentCommand(
        command,
        root,
        artifact,
        env,
        runtime.policy.deployment ?? {},
        command === runtime.policy.deployment?.check ? undefined : runtime.control.signal
      )
  }
): Promise<void> {
  if (!runtime.hasOwnership) return runtime.withOwnership(() => releaseNativeWorkflow(runtime, id, w, io))
  if (!runtime.control.active) return runtime.control.run(() => releaseNativeWorkflow(runtime, id, w, io))
  const { policy, store, gateway } = runtime
  if (!store.activeLease) {
    const lease = store.acquire("reconcile", 120_000)
    if (!lease) throw new NativeReleasePending("Reconciliation already running")
    return store.withLease(lease, 120_000, () => releaseNativeWorkflow(runtime, id, w, io))
  }
  const source = io
  const externalEffect = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action()
    } catch (error) {
      // A failed response does not prove the external service rejected the request.
      // The started journal entry survives and the next pass must observe truth.
      throw new NativeReleasePending(`External operation outcome unresolved: ${String(error)}`)
    }
  }
  io = {
    ...(source.now ? { now: source.now } : {}),
    git: (...args) => {
      assertExecutionOwnership()
      store.authorizeEffect()
      if (args[1] === "push") {
        assertNativePromotion(policy)
        runtime.control.assert()
        return externalEffect(() => source.git(...args))
      }
      return source.git(...args)
    },
    github: (...args) => {
      assertExecutionOwnership()
      store.authorizeEffect()
      if (["create", "merge"].includes(args[1][1] ?? "")) {
        assertNativePromotion(policy)
        runtime.control.assert()
        return externalEffect(() =>
          withNativeStageTrace(
            store,
            {
              boardId: policy.boardId,
              workflowId: id,
              attemptId: w.lifecycle?.attemptId ?? `${id}:legacy`,
              stage: "merge",
              policyDigest: nativePolicyTraceDigest(policy)
            },
            () => source.github(...args)
          )
        )
      }
      return source.github(...args)
    },
    command: (...args) => {
      assertExecutionOwnership()
      store.authorizeEffect()
      if (args[0] !== policy.deployment?.check) {
        assertNativeMode(policy, args[0] === policy.deployment?.rollback ? "rollback" : "deploy")
        assertNativePromotion(policy)
        runtime.control.assert()
        return externalEffect(() =>
          withNativeStageTrace(
            store,
            {
              boardId: policy.boardId,
              workflowId: id,
              attemptId: w.lifecycle?.attemptId ?? `${id}:legacy`,
              stage: args[0] === policy.deployment?.rollback ? "rollback" : "deployment",
              policyDigest: nativePolicyTraceDigest(policy)
            },
            () => source.command(...args)
          )
        )
      }
      return source.command(...args)
    }
  }
  if (policy.repositoryKind !== "application") throw new Error("Framework release requires human review")
  if (!policy.deployment) throw new Error("Application deployment and revision-check commands are not configured")
  if (policy.deployment.authorized !== true) throw new Error("Privileged deployment execution is not authorized")
  if (w.proposal.quality) {
    validateNativeAssessment(w.review?.assessment, w.proposal.acceptance, true)
  }
  assertNativeDeploymentPolicy(policy)
  if (
    w.candidate!.files.some((path) => /(^|\/)(migrations?|schema)(\/|\.)/.test(path)) &&
    !policy.deployment.forwardOnly
  )
    throw new Error("Schema or migration release requires human-reviewed forward-only compatibility policy")
  const candidate = w.candidate!
  assertNativeReleaseGate({
    headSha: candidate.headSha,
    authorAgentId: w.submission?.agentId ?? policy.coderAgentId,
    reviewerAgentId: policy.reviewerAgentId,
    verification: w.verification ?? null,
    review: w.review ?? null
  })
  const attemptId = w.lifecycle?.attemptId
  if (!attemptId) throw new Error("Release requires versioned attempt identity")
  assertNativeProvenance(policy, w.verification!, {
    workflowId: id,
    attemptId,
    skillDigest: w.proposal.quality?.skillHash ?? nativeContentDigest(w.proposal.implementationPrompt)
  })
  if (
    w.review?.receiptVersion !== 1 ||
    w.review.attemptId !== attemptId ||
    w.review.verificationDigest !== nativeVerificationDigest(w.verification!)
  )
    throw new Error("Review belongs to another verification attempt")
  assertNativeVerificationEvidence(policy, candidate, w.verification!, w.proposal.acceptance)
  await assertNativeVerificationAuthority(policy, candidate, io.git)
  if (
    (await io.git(candidate.cwd, "rev-parse", "HEAD")) !== candidate.headSha ||
    (await io.git(candidate.cwd, "status", "--porcelain", "--untracked-files=no"))
  )
    throw new Error("Reviewed candidate changed")
  await runtime.quality.classifyCandidate(id, w, candidate, "release", io.git)
  if (!(await runtime.quality.ensureDesign(id, w)))
    throw new NativeReleasePending(
      "High-risk release requires approved design review for current design, scope and policy"
    )
  const currentDiff = await io.git(
    candidate.cwd,
    "diff",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "-z",
    candidate.baseSha,
    candidate.headSha
  )
  if (nativeContentDigest(currentDiff) !== w.verification!.provenance!.diffDigest)
    throw new Error("Verified diff provenance changed")
  if (!w.mergedSha && !w.deployedSha) runtime.transitionWorkflow(id, w, "release")
  await io.git(candidate.cwd, "fetch", "origin", policy.baseBranch)
  if (!candidate.branch || candidate.branch === policy.baseBranch)
    throw new Error("Promotion requires a dedicated candidate branch")
  if (!w.prNumber) {
    const pushKey = `${id}:push`
    const previousPush = store.get<{ headSha: string }>("operation", pushKey)
    if (previousPush) {
      const remote = await io.git(candidate.cwd, "ls-remote", "origin", `refs/heads/${candidate.branch}`)
      if (previousPush.headSha !== candidate.headSha || remote.split(/\s+/)[0] !== candidate.headSha)
        throw new NativeReleasePending("Push outcome unresolved; inspect remote branch before retry")
    } else {
      runtime.control.assert()
      runtime.reserveBudget(id, w.lifecycle!.attemptId, "release", pushKey)
      store.put("operation", pushKey, { state: "started", headSha: candidate.headSha })
      await io.git(candidate.cwd, "push", "origin", `${candidate.headSha}:refs/heads/${candidate.branch}`)
    }
    store.put("operation", pushKey, { state: "confirmed", headSha: candidate.headSha })
    const prs = JSON.parse(
      await io.github(candidate.cwd, [
        "pr",
        "list",
        "--head",
        candidate.branch,
        "--state",
        "all",
        "--json",
        "number,headRefOid"
      ])
    ) as Array<{ number: number; headRefOid: string }>
    let pr = prs.find((p) => p.headRefOid === candidate.headSha)
    if (!pr) {
      const key = `${id}:pr`
      if (store.get("operation", key))
        throw new NativeReleasePending("PR creation outcome unresolved; inspect GitHub before retry")
      runtime.control.assert()
      runtime.reserveBudget(id, w.lifecycle!.attemptId, "release", key)
      store.put("operation", key, { state: "started", headSha: candidate.headSha })
      await io.github(candidate.cwd, [
        "pr",
        "create",
        "--base",
        policy.baseBranch,
        "--head",
        candidate.branch,
        "--title",
        w.proposal.title,
        "--body",
        `Implements ${w.proposal.goal}. Independent verification and review passed for ${candidate.headSha}. Native workflow: ${id}.`
      ])
      const result = JSON.parse(
        await io.github(candidate.cwd, ["pr", "view", candidate.branch, "--json", "number,headRefOid"])
      )
      if (result.headRefOid !== candidate.headSha || !Number.isInteger(result.number))
        throw new NativeReleasePending("PR creation outcome unresolved; returned revision does not match")
      pr = result
    }
    if (!pr) throw new Error("PR not found after creation")
    store.put("operation", `${id}:pr`, { state: "confirmed", number: pr.number, headSha: candidate.headSha })
    w.prNumber = pr.number
    store.put("workflow", id, w)
  }
  const pr = JSON.parse(
    await io.github(candidate.cwd, [
      "pr",
      "view",
      String(w.prNumber),
      "--json",
      "headRefOid,state,mergeCommit,statusCheckRollup"
    ])
  )
  if (pr.headRefOid !== candidate.headSha) throw new Error("PR head changed after verification")
  const mergeCard = await runtime.stage(
    id,
    w,
    "Merge",
    "blocked",
    `PR ${w.prNumber}; verified head ${candidate.headSha}`
  )
  if (pr.state === "MERGED") {
    w.mergedSha = pr.mergeCommit?.oid
  } else {
    if ((await io.git(candidate.cwd, "rev-parse", `origin/${policy.baseBranch}`)) !== candidate.baseSha)
      throw new Error("Base advanced; rebase and reverify before promotion")
    const key = `${id}:merge`
    if (store.get("operation", key)) throw new NativeReleasePending("Merge outcome unresolved; do not replay")
    try {
      await assertNativeRequiredCi(policy, candidate.cwd, candidate.headSha, io.github)
    } catch (error) {
      if (error instanceof NativeCiPending) throw new NativeReleasePending(error.message)
      throw error
    }
    runtime.control.assert()
    runtime.reserveBudget(id, w.lifecycle!.attemptId, "release", key)
    store.put("operation", key, { state: "started", headSha: candidate.headSha, prNumber: w.prNumber })
    await io.github(candidate.cwd, [
      "pr",
      "merge",
      String(w.prNumber),
      "--squash",
      "--match-head-commit",
      candidate.headSha
    ])
    const merged = JSON.parse(
      await io.github(candidate.cwd, ["pr", "view", String(w.prNumber), "--json", "state,mergeCommit"])
    )
    if (merged.state !== "MERGED") throw new NativeReleasePending("Merge outcome unresolved; merge was not confirmed")
    w.mergedSha = merged.mergeCommit?.oid
  }
  if (!w.mergedSha || !/^[a-f0-9]{40,64}$/.test(w.mergedSha)) throw new Error("Merged revision missing")
  store.put("operation", `${id}:merge`, { state: "confirmed", mergedSha: w.mergedSha })
  if (!w.deployedSha) runtime.transitionWorkflow(id, w, "deployment")
  await gateway.request("workboard.cards.move", { id: mergeCard, status: "done" })
  const deploymentCard = await runtime.stage(
    id,
    w,
    "Deploy",
    "blocked",
    `Deploy and verify merged revision ${w.mergedSha}`
  )
  await reconcileNativeDeployment(runtime, id, w, io)
  w.deployedSha = w.mergedSha
  runtime.transitionWorkflow(id, w, "completed")
  await gateway.request("workboard.cards.move", { id: deploymentCard, status: "done" })
  await gateway.request("workboard.cards.move", { id: w.rootCardId, status: "done" })
  store.event("workflow.deployed", id, {
    deployedSha: w.deployedSha,
    personaId: w.proposal.personaId,
    goal: w.proposal.goal
  })
}
