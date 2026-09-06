import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { NativeEvidenceStore } from "./store.js"

export class NativeControlRevoked extends Error {}
interface Authorization {
  revision: string
  enabled: boolean
  controller: AbortController
}

/** Revocable call-chain authority; freeze also cancels owned commands without asserting remote cancellation. */
export class NativeControl {
  private readonly authorization = new AsyncLocalStorage<Authorization>()
  constructor(
    private readonly store: NativeEvidenceStore,
    private readonly policyEnabled: () => boolean
  ) {}
  private readonly controllers = new Set<AbortController>()
  get state() {
    const saved = this.store.get<{ paused: boolean; revision?: string; frozen?: boolean; freezeRevision?: string }>(
      "control",
      "pause"
    )
    return {
      paused: !this.policyEnabled() || saved?.paused === true,
      revision: saved?.revision ?? "legacy",
      frozen: saved?.frozen === true,
      freezeRevision: saved?.freezeRevision ?? "legacy"
    }
  }
  run<T>(action: () => Promise<T>): Promise<T> {
    if (this.authorization.getStore()) return action()
    const state = this.state
    const controller = new AbortController()
    this.controllers.add(controller)
    if (state.frozen) controller.abort(new NativeControlRevoked("Emergency freeze"))
    const poll = setInterval(() => {
      try {
        if (this.state.freezeRevision !== state.freezeRevision)
          controller.abort(new NativeControlRevoked("Emergency freeze observed"))
      } catch {
        controller.abort(new NativeControlRevoked("Control state unavailable"))
      }
    }, 100)
    poll.unref()
    return this.authorization.run({ revision: state.revision, enabled: !state.paused, controller }, async () => {
      try {
        return await action()
      } finally {
        clearInterval(poll)
        this.controllers.delete(controller)
      }
    })
  }
  get signal(): AbortSignal | undefined {
    return this.authorization.getStore()?.controller.signal
  }
  freeze() {
    const state = this.change(true, undefined, true)
    for (const controller of this.controllers) controller.abort(new NativeControlRevoked("Emergency freeze"))
    return state
  }
  get active(): boolean {
    return this.authorization.getStore() !== undefined
  }
  assert(): void {
    const state = this.state
    const authorization = this.authorization.getStore()
    if (state.paused || (authorization && (!authorization.enabled || authorization.revision !== state.revision)))
      throw new NativeControlRevoked(
        "Native autonomy is paused or authorization was revoked; explicitly resume and reconcile"
      )
  }
  change(paused: boolean, expectedRevision?: string, emergencyFreeze = false) {
    this.store.db.exec("BEGIN IMMEDIATE")
    try {
      if (!paused && !this.policyEnabled())
        throw new Error("Policy is disabled; enable the reviewed native policy before resuming")
      if (expectedRevision !== undefined && this.state.revision !== expectedRevision)
        throw new NativeControlRevoked("Control changed during resume readiness checks; resume again explicitly")
      const previous = this.state
      const state = {
        paused,
        revision: randomUUID(),
        at: new Date().toISOString(),
        frozen: paused && (emergencyFreeze || previous.frozen),
        freezeRevision: emergencyFreeze ? randomUUID() : previous.freezeRevision
      }
      // Administrative control must remain writable independently of a worker lease.
      this.store.db
        .prepare(`INSERT INTO native_records VALUES ('control','pause',?,?)
        ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
        .run(JSON.stringify(state), Date.now())
      this.store.db
        .prepare("INSERT INTO native_events(kind,subject,data,created_at) VALUES (?,'pause',?,?)")
        .run(
          emergencyFreeze ? "control.frozen" : paused ? "control.paused" : "control.resumed",
          JSON.stringify(state),
          Date.now()
        )
      this.store.db
        .prepare(
          "INSERT INTO native_versions VALUES ('control','pause',1) ON CONFLICT(kind,id) DO UPDATE SET version=version+1"
        )
        .run()
      this.store.db.exec("COMMIT")
      return state
    } catch (error) {
      this.store.db.exec("ROLLBACK")
      throw error
    }
  }
}
