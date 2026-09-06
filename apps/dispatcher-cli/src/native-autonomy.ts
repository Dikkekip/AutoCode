import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  applyNativeMigration,
  loadNativePolicy,
  NativeCliGateway,
  NativeEvidenceStore,
  type NativeMigrationPlan,
  nativeDoctor,
  nativePolicyFromProfile,
  planNativeMigration
} from "@openclaw/core-runtime"
import { validateProjectProfile } from "@openclaw/project-profiles"
import type { Command } from "commander"

export function registerNativeAutonomyCommands(program: Command, io: { stdout: (message: string) => void }): void {
  const root = program
    .command("native")
    .description("Native Workboard autonomy and migration")
    .option("--policy <file>", "Native policy or project profile", ".openclaw/native.json")
    .option("--openclaw <command>", "OpenClaw executable", "openclaw")
  const settings = () => ({
    policy: loadNativePolicy(resolve(root.opts().policy)),
    gateway: new NativeCliGateway(root.opts().openclaw)
  })
  const output = (value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`)
  root
    .command("prepare")
    .requiredOption("--profile <file>", "Existing project profile")
    .requiredOption("--repository <path>", "Application source repository")
    .requiredOption("--base <branch>", "Base branch")
    .requiredOption("--out <file>", "New paused native policy")
    .action((options) => {
      if (existsSync(options.out)) throw new Error("Output exists; preserve existing native policy")
      const policy = nativePolicyFromProfile(
        validateProjectProfile(JSON.parse(readFileSync(options.profile, "utf8"))),
        resolve(options.repository),
        options.base
      )
      mkdirSync(dirname(resolve(options.out)), { recursive: true })
      writeFileSync(options.out, JSON.stringify(policy, null, 2), { mode: 0o600 })
      output({
        policy: resolve(options.out),
        personas: policy.personas.length,
        enabled: false,
        note: "Persona missions and lane checks preserved. Configure deployment and revision check before activation."
      })
    })
  root
    .command("doctor")
    .option("--json", "JSON output", true)
    .action(async () => {
      const { policy, gateway } = settings()
      const report = await nativeDoctor(policy, gateway)
      output(report)
      if (!report.ok) process.exitCode = 1
    })
  for (const name of ["status", "discover", "reconcile", "pause", "resume", "freeze"] as const)
    root
      .command(name)
      .option("--json", "JSON output", true)
      .action(async () => {
        const { policy, gateway } = settings()
        output(await gateway.request(`autocode.${name}`, { boardId: policy.boardId }))
      })
  root
    .command("quality")
    .description("Explain native investigation and review outcomes")
    .option("--json", "JSON output", false)
    .action(async (options) => {
      const { policy, gateway } = settings()
      const report = await gateway.request("autocode.quality", { boardId: policy.boardId })
      if (options.json) output(report)
      else
        io.stdout(
          [
            `Board: ${report.boardId}`,
            `Quality contract: ${report.qualityEnabled ? "enabled" : "legacy"}`,
            `Investigations: ${report.investigations.length}; reviewed: ${report.reviewedWorkflows}; first-pass approvals: ${report.firstPassReviews}`,
            `Repairs: ${report.repairs}; verified deployments: ${report.verifiedDeployments}`,
            ...report.investigations.map((r: any) => `${r.personaId}: ${r.state}${r.reason ? ` — ${r.reason}` : ""}`),
            ...report.decisions.map((d: any) => `${d.id}: ${d.value.outcome} — ${d.value.reason ?? d.value.rationale}`)
          ].join("\n") + "\n"
        )
    })
  const workflow = root.command("workflow").description("Read-only explanations and exact operator recovery plans")
  workflow
    .command("explain")
    .requiredOption("--id <workflowId>", "Workflow identity")
    .action(async (options) => {
      const { policy, gateway } = settings()
      output(await gateway.request("autocode.workflow.explain", { boardId: policy.boardId, workflowId: options.id }))
    })
  workflow
    .command("recover")
    .option("--id <workflowId>", "Workflow identity for planning")
    .option("--plan", "Prepare a read-only recovery plan")
    .option("--action <action>", "retry, cancel, supersede, abandon or archive", "retry")
    .option("--reason <reason>", "Operator recovery rationale")
    .option("--successor <workflowId>", "Existing successor for supersession")
    .option("--out <file>", "Save the exact plan to a new file")
    .option("--apply <file>", "Explicitly apply an unchanged saved recovery plan")
    .action(async (options) => {
      const { policy, gateway } = settings()
      if (options.apply) {
        if (options.plan || options.out || options.id || options.reason || options.successor)
          throw new Error("Apply accepts only an exact saved plan")
        const plan = JSON.parse(readFileSync(resolve(options.apply), "utf8"))
        output(await gateway.request("autocode.workflow.recover.apply", { boardId: policy.boardId, plan }))
      } else {
        if (!options.plan || !options.id || !options.reason)
          throw new Error("Recovery requires --plan --id and --reason, or --apply <file>")
        const plan = await gateway.request("autocode.workflow.recover.plan", {
          boardId: policy.boardId,
          workflowId: options.id,
          action: options.action,
          reason: options.reason,
          ...(options.successor ? { successorId: options.successor } : {})
        })
        if (options.out) writeFileSync(resolve(options.out), JSON.stringify(plan, null, 2), { mode: 0o600, flag: "wx" })
        output(plan)
      }
    })
  const migration = root.command("migration").description("Preview and import paused legacy tasks")
  migration
    .command("plan")
    .requiredOption("--source <db>", "Legacy database")
    .option("--out <file>", "Write exact preview for apply")
    .action((options) => {
      const { policy } = settings()
      const plan = planNativeMigration(options.source, policy)
      if (options.out) {
        mkdirSync(dirname(resolve(options.out)), { recursive: true })
        writeFileSync(resolve(options.out), JSON.stringify(plan, null, 2), { mode: 0o600 })
      }
      output(
        options.out
          ? {
              path: resolve(options.out),
              fingerprint: plan.fingerprint,
              paused: plan.paused,
              running: plan.running,
              blockers: plan.blockers,
              tasks: plan.tasks.length
            }
          : plan
      )
    })
  migration
    .command("adopt")
    .requiredOption("--legacy-key <key>", "Imported projectId:taskId")
    .action(async (options) => {
      const { policy, gateway } = settings()
      output(await gateway.request("autocode.adopt", { boardId: policy.boardId, legacyKey: options.legacyKey }))
    })
  migration
    .command("apply")
    .requiredOption("--plan <file>", "Reviewed migration preview")
    .requiredOption("--backup <file>", "New SQLite snapshot path")
    .action(async (options) => {
      const { policy, gateway } = settings()
      if (existsSync(options.backup)) throw new Error("Backup path already exists; choose a new snapshot path")
      const plan = JSON.parse(readFileSync(options.plan, "utf8")) as NativeMigrationPlan
      const store = new NativeEvidenceStore(resolve(policy.repository, ".openclaw/native-evidence.db"))
      try {
        output(await applyNativeMigration({ plan, policy, gateway, store, backupPath: resolve(options.backup) }))
      } finally {
        store.close()
      }
    })
  root
    .command("install-automations")
    .description("Create disabled native discovery and reconciliation automations")
    .requiredOption("--cli <file>", "Absolute built dispatcher CLI entrypoint")
    .requiredOption("--node <file>", "Absolute compatible Node executable")
    .action(async (options) => {
      const { policy, gateway } = settings()
      const store = new NativeEvidenceStore(resolve(policy.repository, ".openclaw/native-evidence.db"))
      try {
        const jobs: any[] = []
        let offset = 0
        while (true) {
          const page = await gateway.request("cron.list", { includeDisabled: true, offset })
          if (!Array.isArray(page.jobs)) throw new Error("Native cron.list contract unavailable")
          jobs.push(...page.jobs)
          if (!page.hasMore) break
          if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset)
            throw new Error("Invalid native automation pagination")
          offset = page.nextOffset
        }
        const ids: Record<string, string> = {}
        for (const kind of ["discover", "reconcile"]) {
          const declarationKey = `autocode:${policy.boardId}:${kind}`
          const previous = jobs.find((j: any) => j.declarationKey === declarationKey)
          if (previous) {
            if (kind === "discover" && policy.quality && previous.schedule?.expr !== "0 * * * *")
              await gateway.request("cron.update", {
                id: previous.id,
                patch: { schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" } }
              })
            ids[kind] = previous.id
            continue
          }
          const job = await gateway.request("cron.add", {
            name: declarationKey,
            declarationKey,
            enabled: false,
            schedule: {
              kind: "cron",
              expr: kind === "discover" ? (policy.quality ? "0 * * * *" : "0 */2 * * *") : "*/5 * * * *",
              tz: "UTC"
            },
            sessionTarget: "isolated",
            wakeMode: "now",
            delivery: { mode: "none" },
            payload: {
              kind: "command",
              argv: [
                resolve(options.node),
                resolve(options.cli),
                "native",
                "--policy",
                resolve(root.opts().policy),
                "--openclaw",
                root.opts().openclaw,
                kind
              ],
              cwd: policy.repository,
              timeoutSeconds: 7200
            }
          })
          const jobId = job.id ?? job.job?.id
          if (typeof jobId !== "string" || !jobId)
            throw new Error("Native cron.add did not return a durable job identity")
          ids[kind] = jobId
        }
        store.put("automation", policy.boardId, { discoveryJobId: ids.discover, reconcileJobId: ids.reconcile })
        output({ jobs: ids, note: "New jobs are disabled. Existing jobs retain operator state." })
      } finally {
        store.close()
      }
    })
}
