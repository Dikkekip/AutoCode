// New native budget evidence ledger, not an execution scheduler.
import { createHash } from "node:crypto"
import {
  type NativeBudgetAmount,
  type NativeBudgetPolicy,
  type NativeBudgetUnit,
  validateNativeBudgetAmount,
  validateNativeBudgetPolicy
} from "@openclaw/domain"

export type { NativeBudgetAmount, NativeBudgetPolicy, NativeBudgetUnit } from "@openclaw/domain"

import type { NativeEvidenceStore } from "./store.js"

interface BudgetWindow {
  reserved: NativeBudgetAmount
  consumed: NativeBudgetAmount
}
export interface NativeBudgetReservation {
  version: 1
  id: string
  projectId: string
  workflowId: string
  attemptId: string
  purpose: string
  policyDigest: string
  windows: string[]
  amount: NativeBudgetAmount
  state: "reserved" | "settled" | "unknown"
  actual?: NativeBudgetAmount
  safety: boolean
  createdAt: number
}
const units: NativeBudgetUnit[] = ["timeMs", "tokens", "currency", "actions"]
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export class NativeBudgetLedger {
  readonly policy: NativeBudgetPolicy
  constructor(
    readonly store: NativeEvidenceStore,
    policy: NativeBudgetPolicy,
    private readonly clock: () => number = Date.now
  ) {
    this.policy = validateNativeBudgetPolicy(policy)
  }
  reserve(input: {
    id: string
    projectId: string
    workflowId: string
    attemptId: string
    purpose: string
    amount: NativeBudgetAmount
    safety?: boolean
  }): NativeBudgetReservation {
    for (const key of ["id", "projectId", "workflowId", "attemptId", "purpose"] as const)
      if (!input[key] || input[key].length > 512) throw new Error("Budget reservation identity required")
    validateNativeBudgetAmount(input.amount)
    if (
      !input.safety &&
      this.policy.unknownUsage === "deny" &&
      this.store
        .list<NativeBudgetReservation>("budget-reservation")
        .some((row) => row.value.projectId === input.projectId && row.value.state === "unknown")
    )
      throw new Error("Unknown prior usage blocks optional native work")
    const policyDigest = digest(this.policy),
      now = this.clock()
    const prior = this.store.get<NativeBudgetReservation>("budget-reservation", input.id)
    if (prior) {
      if (
        prior.policyDigest !== policyDigest ||
        prior.projectId !== input.projectId ||
        prior.workflowId !== input.workflowId ||
        prior.attemptId !== input.attemptId ||
        digest(prior.amount) !== digest(input.amount) ||
        prior.purpose !== input.purpose ||
        prior.safety !== Boolean(input.safety)
      )
        throw new Error("Budget reservation identity reused with changed context")
      return prior
    }
    const prefix = digest(input.projectId)
    const keys = {
      project: `${prefix}:project`,
      day: `${prefix}:day:${new Date(now).toISOString().slice(0, 10)}`,
      workflow: `${prefix}:workflow:${digest(input.workflowId)}`,
      attempt: `${prefix}:attempt:${digest([input.workflowId, input.attemptId])}`
    }
    const writes = []
    for (const scope of ["project", "day", "workflow", "attempt"] as const) {
      const id = keys[scope],
        window = this.store.get<BudgetWindow>("budget-window", id) ?? { reserved: {}, consumed: {} }
      for (const unit of units) {
        const limit = this.policy.limits[scope][unit],
          requested = input.amount[unit]
        if (limit !== undefined && requested === undefined)
          throw new Error(`Unknown ${unit} estimate cannot reserve capped ${scope} budget`)
        if (requested === undefined) continue
        const available =
          limit === undefined
            ? Infinity
            : Math.max(0, limit - (input.safety ? 0 : (this.policy.safetyReserve[unit] ?? 0)))
        if ((window.reserved[unit] ?? 0) + (window.consumed[unit] ?? 0) + requested > available)
          throw new Error(`Native ${scope} ${unit} budget exhausted`)
        window.reserved[unit] = (window.reserved[unit] ?? 0) + requested
      }
      writes.push({
        kind: "budget-window",
        id,
        value: window,
        expectedVersion: this.store.version("budget-window", id)
      })
    }
    const reservation: NativeBudgetReservation = {
      version: 1,
      ...input,
      policyDigest,
      windows: Object.values(keys),
      state: "reserved",
      safety: Boolean(input.safety),
      createdAt: now
    }
    this.store.commit(
      [...writes, { kind: "budget-reservation", id: input.id, value: reservation, expectedVersion: 0 }],
      {
        kind: "budget.reserved",
        subject: input.workflowId,
        value: {
          reservationId: input.id,
          attemptId: input.attemptId,
          purpose: input.purpose,
          amount: input.amount,
          policyDigest
        }
      }
    )
    return reservation
  }
  settle(id: string, actual: NativeBudgetAmount | null) {
    const reservation = this.store.get<NativeBudgetReservation>("budget-reservation", id)
    if (!reservation) throw new Error("Unknown native budget reservation")
    if (reservation.state === "settled") {
      if (digest(reservation.actual) !== digest(actual)) throw new Error("Settled budget usage cannot change")
      return reservation
    }
    if (actual === null) {
      reservation.state = "unknown"
      this.store.put("budget-reservation", id, reservation)
      return reservation
    }
    validateNativeBudgetAmount(actual)
    if (units.some((unit) => reservation.amount[unit] !== undefined && actual[unit] === undefined))
      throw new Error("Partial usage cannot release unknown reservations")
    const writes = []
    let exceeded = false
    for (const windowId of reservation.windows) {
      const window = this.store.get<BudgetWindow>("budget-window", windowId)!
      for (const unit of units) {
        if (actual[unit] === undefined) continue
        window.reserved[unit] = Math.max(0, (window.reserved[unit] ?? 0) - (reservation.amount[unit] ?? 0))
        window.consumed[unit] = (window.consumed[unit] ?? 0) + actual[unit]!
        if (actual[unit]! > (reservation.amount[unit] ?? 0)) exceeded = true
      }
      writes.push({
        kind: "budget-window",
        id: windowId,
        value: window,
        expectedVersion: this.store.version("budget-window", windowId)
      })
    }
    reservation.state = "settled"
    reservation.actual = actual
    this.store.commit(
      [
        ...writes,
        {
          kind: "budget-reservation",
          id,
          value: reservation,
          expectedVersion: this.store.version("budget-reservation", id)
        }
      ],
      {
        kind: exceeded ? "budget.overrun" : "budget.settled",
        subject: reservation.workflowId,
        value: { reservationId: id, actual, exceeded }
      }
    )
    return reservation
  }
  explain(projectId: string) {
    const prefix = digest(projectId)
    return {
      version: 1,
      policyDigest: digest(this.policy),
      windows: this.store.list<BudgetWindow>("budget-window").filter((row) => row.id.startsWith(prefix)),
      unknown: this.store
        .list<NativeBudgetReservation>("budget-reservation")
        .filter((row) => row.value.projectId === projectId && row.value.state === "unknown").length
    }
  }
}
