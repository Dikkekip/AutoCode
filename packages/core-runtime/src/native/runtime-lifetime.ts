import { randomUUID } from "node:crypto"
import type { NativeAutonomyRuntime } from "./runtime.js"

interface Lifetime {
  generation: string
  idle: Set<() => void>
  active: number
  refreshing: boolean
  retired: boolean
}
const key = Symbol.for("autocode.native.runtime-lifetimes.v1")
const registry = globalThis as typeof globalThis & { [key]?: WeakMap<NativeAutonomyRuntime, Lifetime> }
registry[key] ??= new WeakMap<NativeAutonomyRuntime, Lifetime>()
function lifetime(runtime: NativeAutonomyRuntime): Lifetime {
  let value = registry[key]!.get(runtime)
  if (!value) {
    value = { generation: randomUUID(), idle: new Set(), active: 0, refreshing: false, retired: false }
    registry[key]!.set(runtime, value)
  }
  return value
}
export const nativeRuntimeGeneration = (runtime: NativeAutonomyRuntime) => lifetime(runtime).generation
function settled(state: Lifetime) {
  if (!state.active && !state.refreshing) {
    for (const resolve of state.idle) resolve()
    state.idle.clear()
  }
}
export function stopNativeRuntimeCalls(runtime: NativeAutonomyRuntime): Promise<void> {
  const state = lifetime(runtime)
  state.retired = true
  if (!state.active && !state.refreshing) return Promise.resolve()
  return new Promise((resolve) => state.idle.add(resolve))
}
/** Shared across repeated plugin catalog registrations in the same process. */
export async function withNativeRuntimeCall<T>(
  runtime: NativeAutonomyRuntime,
  current: () => boolean,
  action: () => Promise<T>
): Promise<T> {
  const state = lifetime(runtime)
  if (state.retired || state.refreshing || !current())
    throw new Error("Native runtime generation unavailable during policy refresh")
  state.active++
  try {
    return await action()
  } finally {
    state.active--
    settled(state)
  }
}
/** Reject rather than cancel or await accepted work. New calls fail while the proof is collected. */
export async function withNativeRuntimeRefresh<T>(
  runtime: NativeAutonomyRuntime,
  current: () => boolean,
  action: (retire: () => void, assertCurrent: () => void) => Promise<T>
): Promise<T> {
  const state = lifetime(runtime)
  if (state.retired || state.refreshing || state.active || !current())
    throw new Error("Native policy refresh requires an idle current runtime")
  state.refreshing = true
  const assertCurrent = () => {
    if (state.retired || !current() || state.active) throw new Error("Native runtime changed during policy refresh")
  }
  try {
    return await action(() => {
      assertCurrent()
      state.retired = true
    }, assertCurrent)
  } finally {
    state.refreshing = false
    settled(state)
  }
}
