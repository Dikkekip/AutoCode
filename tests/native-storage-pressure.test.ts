import { expect, it, vi } from "vitest"
import {
  inspectNativeStorage,
  NATIVE_STORAGE_RESERVE_BYTES
} from "../packages/core-runtime/src/native/storage-pressure.js"

vi.unmock("../packages/core-runtime/src/native/storage-pressure.js")
const GiB = 1024 ** 3
const sample = (bytes: number) =>
  (() => ({ bavail: bytes / 4096, bsize: 4096 })) as Parameters<typeof inspectNativeStorage>[2]

it("preserves the reserve after projected allocation, including the exact boundary", () => {
  expect(NATIVE_STORAGE_RESERVE_BYTES).toBe(10 * GiB)
  expect(inspectNativeStorage("/", GiB, sample(11 * GiB)).allowed).toBe(true)
  expect(inspectNativeStorage("/", GiB, sample(11 * GiB - 4096)).allowed).toBe(false)
  expect(inspectNativeStorage("/", 0, sample(10 * GiB - 4096)).allowed).toBe(false)
})
it("fails closed on unknown storage or invalid projected allocations", () => {
  expect(
    inspectNativeStorage("/", 0, () => {
      throw new Error("unavailable")
    }).allowed
  ).toBe(false)
  for (const value of [-1, NaN, Infinity]) {
    expect(inspectNativeStorage("/", value, sample(100 * GiB)).allowed).toBe(false)
    expect(inspectNativeStorage("/", 0, sample(value)).allowed).toBe(false)
  }
})
