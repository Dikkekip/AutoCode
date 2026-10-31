#!/usr/local/bin/node
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// This acceptance harness lives in the immutable image, outside candidate-controlled /work.
assert.deepEqual(JSON.parse(readFileSync("/work/value.json", "utf8")), { value: 2 })
assert.equal(process.getuid() === 0, false, "Verifier must run as a nonroot user")
console.log("Protected fixture acceptance passed")
