import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { backup, DatabaseSync } from "node:sqlite"
import type { NativeAutonomyPolicy } from "@openclaw/domain"
import { ExecutionOwnerStore, readExecutionOwnership } from "@openclaw/os-adapters"
import { type NativeGateway, nativeCard } from "./gateway.js"
import type { NativeEvidenceStore } from "./store.js"

export interface NativeMigrationPlan {
  version: 1
  ownership: { generation: number; owner: "legacy" | "native" | "paused" }
  source: string
  projectId: string
  boardId: string
  paused: boolean
  running: string[]
  blockers: string[]
  tasks: Array<{ id: string; title: string; status: string; dependencies: string[]; notes: string }>
  fingerprint: string
}
export function planNativeMigration(source: string, policy: NativeAutonomyPolicy): NativeMigrationPlan {
  const db = new DatabaseSync(resolve(source), { readOnly: true })
  try {
    const project = db.prepare("SELECT id FROM projects WHERE repo_path=?").get(policy.repository)
    if (!project) throw new Error("No legacy project matches the native repository")
    const projectId = String(project.id)
    const automations = db.prepare("SELECT status FROM automations WHERE project_id=?").all(projectId)
    const paused = automations.every((a) => a.status !== "active")
    const running = db
      .prepare("SELECT id FROM runs WHERE project_id=? AND status='running'")
      .all(projectId)
      .map((r) => String(r.id))
    const rows = db.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at,id").all(projectId)
    const done = new Set(rows.filter((r) => r.status === "done").map((r) => String(r.id)))
    const unfinished = rows.filter((r) => !["done", "failed", "cancelled"].includes(String(r.status)))
    const ids = new Set(unfinished.map((r) => String(r.id)))
    const blockers: string[] = []
    const tasks = unfinished.map((r) => {
      const dependencies = (JSON.parse(String(r.depends_on_task_ids_json || "[]")) as string[]).filter(
        (id) => !done.has(id)
      )
      for (const id of dependencies) if (!ids.has(id)) blockers.push(`${r.id}: unresolved dependency ${id}`)
      const runs = db
        .prepare(
          "SELECT id,status,head_sha,branch_name,worktree_path,review_verdict,verification_summary FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 5"
        )
        .all(String(r.id))
      return {
        id: String(r.id),
        title: String(r.title),
        status: String(r.status),
        dependencies,
        notes: JSON.stringify(
          {
            legacyTaskId: r.id,
            legacyStatus: r.status,
            allowedPaths: JSON.parse(String(r.allowed_paths_json || "[]")),
            personaId: r.persona_id,
            description: r.description,
            package: JSON.parse(String(r.task_package_json || "null")),
            blockedReason: r.blocked_reason,
            lastError: r.last_error,
            evidence: runs
          },
          null,
          2
        )
      }
    })
    const visiting = new Set<string>(),
      visited = new Set<string>()
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Legacy dependency cycle at ${id}`)
      if (visited.has(id)) return
      visiting.add(id)
      for (const dep of tasks.find((t) => t.id === id)?.dependencies ?? []) visit(dep)
      visiting.delete(id)
      visited.add(id)
    }
    for (const task of tasks) visit(task.id)
    const body = {
      version: 1 as const,
      ownership: (() => {
        const current = readExecutionOwnership(policy.repository)
        return { generation: current?.generation ?? 0, owner: current?.owner ?? ("legacy" as const) }
      })(),
      source: resolve(source),
      projectId,
      boardId: policy.boardId,
      paused,
      running,
      blockers,
      tasks
    }
    return { ...body, fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex") }
  } finally {
    db.close()
  }
}
export async function applyNativeMigration(input: {
  plan: NativeMigrationPlan
  policy: NativeAutonomyPolicy
  gateway: NativeGateway
  store: NativeEvidenceStore
  backupPath: string
}): Promise<{ imported: number; paused: true; fingerprint: string }> {
  const { plan, policy, gateway, store } = input
  if (!store.holdsLease("migration")) {
    const lease = store.acquire("migration", 120_000)
    if (!lease) throw new Error("Migration already running")
    return store.withLease(lease, 120_000, () => applyNativeMigration(input))
  }
  const { fingerprint: suppliedFingerprint, ...suppliedBody } = plan
  if (createHash("sha256").update(JSON.stringify(suppliedBody)).digest("hex") !== suppliedFingerprint)
    throw new Error("Migration preview was modified; regenerate it")
  const fresh = planNativeMigration(plan.source, policy)
  const { fingerprint: _freshFingerprint, ...freshBody } = fresh
  if (
    createHash("sha256")
      .update(JSON.stringify({ ...freshBody, ownership: plan.ownership }))
      .digest("hex") !== plan.fingerprint
  )
    throw new Error("Migration preview is stale; regenerate it")
  if (!plan.paused || plan.running.length || plan.blockers.length)
    throw new Error("Migration requires paused legacy ownership, no running work, and resolved dependencies")
  if (policy.enabled) throw new Error("Import requires paused native policy")
  const ownerStore = new ExecutionOwnerStore()
  try {
    const currentOwner = ownerStore.read(policy.repository)
    const handoff =
      currentOwner?.planDigest === plan.fingerprint && ["paused", "native"].includes(currentOwner.owner)
        ? { generation: currentOwner.owner === "native" ? currentOwner.generation - 1 : currentOwner.generation }
        : ownerStore.transfer(
            policy.repository,
            plan.ownership.generation,
            "paused",
            plan.fingerprint,
            "Reviewed migration: previous owner paused and drained"
          )
    // Both cooperating owners refuse new execution throughout import. Failed imports remain paused.
    mkdirSync(dirname(input.backupPath), { recursive: true })
    const source = new DatabaseSync(plan.source, { readOnly: true })
    try {
      await backup(source, input.backupPath)
    } finally {
      source.close()
    }
    const snapshot = new DatabaseSync(input.backupPath, { readOnly: true })
    try {
      if (snapshot.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
        throw new Error("Migration backup validation failed")
    } finally {
      snapshot.close()
    }
    const boardIntent = `migration:${plan.fingerprint}:board`
    store.put("effect-intent", boardIntent, { state: "pending", boardId: policy.boardId })
    await gateway.request("workboard.boards.upsert", {
      id: policy.boardId,
      name: policy.boardId,
      description: "Persona-driven coding; imported work is paused pending evidence reconciliation."
    })
    store.put("effect-intent", boardIntent, { state: "confirmed", boardId: policy.boardId })
    const mapping = new Map<string, string>()
    const importedCards = new Map<string, Awaited<ReturnType<typeof nativeCard>>>()
    for (const task of plan.tasks) {
      const evidencePath = resolve(
        policy.repository,
        ".openclaw/native-artifacts/migration",
        `${createHash("sha256").update(task.id).digest("hex")}.json`
      )
      mkdirSync(dirname(evidencePath), { recursive: true })
      writeFileSync(evidencePath, task.notes, { mode: 0o600 })
      const intentId = `migration:${plan.fingerprint}:card:${task.id}`
      store.put("effect-intent", intentId, { state: "pending", correlationKey: `legacy:${plan.projectId}:${task.id}` })
      const card = await nativeCard(gateway, {
        boardId: policy.boardId,
        title: task.title,
        status: "scheduled",
        idempotencyKey: `legacy:${plan.projectId}:${task.id}`,
        labels: ["autocode:legacy", `legacy:${task.status}`],
        notes: `Paused legacy import. Original status: ${task.status}. Full preserved evidence: ${evidencePath}. Adopt this task through native migration before dispatching it.`,
        agentId: policy.coderAgentId,
        maxRetries: 2,
        workspace: { kind: "worktree", sourcePath: policy.repository, sourceBranch: `origin/${policy.baseBranch}` }
      })
      if (!["scheduled", "blocked"].includes(card.status))
        throw new Error(`Imported card ${card.id} has been activated; refusing to change it`)
      mapping.set(task.id, card.id)
      importedCards.set(task.id, card)
      store.commit(
        [
          { kind: "migration-task", id: `${plan.projectId}:${task.id}`, value: { ...task, cardId: card.id } },
          {
            kind: "migration-map",
            id: `${plan.projectId}:${task.id}`,
            value: { cardId: card.id, legacyStatus: task.status }
          },
          {
            kind: "effect-intent",
            id: intentId,
            value: { state: "confirmed", cardId: card.id, correlationKey: `legacy:${plan.projectId}:${task.id}` }
          }
        ],
        { kind: "migration.card-imported", subject: task.id, value: { fingerprint: plan.fingerprint, cardId: card.id } }
      )
    }
    for (const task of plan.tasks) {
      const card = importedCards.get(task.id)!
      for (const dependency of task.dependencies) {
        const parentId = mapping.get(dependency)!
        if (card.metadata?.links?.some((link) => link.type === "parent" && link.targetCardId === parentId)) continue
        if (card.status === "blocked")
          await gateway.request("workboard.cards.move", { id: card.id, status: "scheduled" })
        const dependencyIntent = `migration:${plan.fingerprint}:dependency:${dependency}:${task.id}`
        store.put("effect-intent", dependencyIntent, { state: "pending", parentId, childId: card.id })
        await gateway.request("workboard.cards.linkDependency", { parentId, childId: card.id })
        store.put("effect-intent", dependencyIntent, { state: "confirmed", parentId, childId: card.id })
      }
      await gateway.request("workboard.cards.move", { id: card.id, status: "blocked" })
    }
    const owner = ownerStore.transfer(
      policy.repository,
      handoff.generation,
      "native",
      plan.fingerprint,
      "Reviewed import completed; native policy remains paused"
    )
    store.commit(
      [
        {
          kind: "migration",
          id: policy.boardId,
          value: {
            fingerprint: plan.fingerprint,
            backupPath: input.backupPath,
            imported: mapping.size,
            paused: true,
            ownershipGeneration: owner.generation
          }
        }
      ],
      {
        kind: "migration.applied",
        subject: policy.boardId,
        value: { fingerprint: plan.fingerprint, imported: mapping.size, ownershipGeneration: owner.generation }
      }
    )
    return { imported: mapping.size, paused: true, fingerprint: plan.fingerprint }
  } finally {
    ownerStore.close()
  }
}
