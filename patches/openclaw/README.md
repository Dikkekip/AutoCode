# Bounded complete Workboard responses

The installed Workboard `workboard.cards.list` accepts only `boardId` and returns
all cards, board summaries and statuses. It has no pagination or status filter.
The installed public `callGatewayFromCli` and `GatewayClient` have no supported
receive-limit option. A 26,219,791-byte success response exceeds the client's
26,214,400-byte WebSocket message limit; restarting the Gateway cannot fix it.

`bounded-gateway-response.patch` is an unapplied OpenClaw **source** change based
on core commit `5e7165a9992aa3501596f34b5d08193f6232d678`. Source hashes are in
`bounded-gateway-response-source.json`. It adds a generic opt-in
`maxPayloadBytes` argument, validated as an integer from 1 through 67,108,864.
The default remains 26,214,400. The public SDK export
`callGatewayFromCliWithResponseLimit` validates before connection and forwards
through the existing lazy RPC facade, call owner and client to WebSocket's
complete, decompressed message limit. Authentication, target selection, scopes,
timeouts and request failure handling remain with their existing owners.

AutoCode requires this explicit SDK export for `workboard.cards.list` and opts
into 64 MiB. Other RPCs use the original public call. Old SDKs fail with an
activation-prerequisite error before polling the board; unknown options are never
silently passed to an old SDK. No retries, card/status/evidence filtering,
truncation, DB access, trusted-plugin impersonation or installed-code edits are
introduced. Responses over 64 MiB still fail; further growth needs supported
server pagination, not repeated limit increases. 64 MiB bounds the wire message,
not total process RSS; concurrent reads and parsed-object overhead still need
parent resource admission.

## Verification and activation

From the framework checkout, run the synthetic one-worker suite:

```
rtk proxy pnpm exec vitest run tests/native-board-payload.test.ts tests/native-gateway-sdk.test.ts tests/native-gateway-contract.test.ts --maxWorkers=1 --fileParallelism=false
```

To test the exact hash-bound core source without editing or duplicating its Git
checkout, the following runner overlays only patched modules in Vite memory and
writes its synthetic test/config/receipt to an external proof directory:

```
rtk proxy node scripts/check-native-board-payload-source.mjs CORE_SOURCE PROOF_DIRECTORY
```

It verifies the source commit/hashes and `git apply --check`, exercises the real
patched GatewayClient against a loopback synthetic Gateway with a >25 MiB
response, and tests the actual SDK facade/runtime forwarding. Core call-owner
forwarding is source-reviewed; the runner mocks that boundary to avoid loading
host authentication/configuration. The framework wire suite also tests the hard
64 MiB ceiling, exact byte completeness, all currently accepted card statuses,
legacy capability rejection and failure propagation.

These checks do not substitute for integrating the core patch, canonical SDK
API/export regeneration, core typecheck/build/owner checks and authenticated
integration against the resulting published SDK. Parent must own that source
integration/publication and fresh activation/idle/ownership/resource gates, then
activate the framework candidate and perform one bounded status/Doctor read.
This framework commit alone cannot repair the installed client. No runtime or
verifier operation is authorized by these source receipts.
