# Complete Workboard responses with local uncapped opt-in

`workboard.cards.list` accepts only `boardId` and returns the complete board. Its
26,219,791-byte reply exceeded the default 26,214,400-byte receive limit. No
pagination is currently supported. This source patch preserves the ordinary
25 MiB default and extends the existing `callGatewayFromCli` public SDK function with an explicit
`responseLimitVersion === 1` marker and `maxPayloadBytes: 0` for uncapped
complete responses. Positive limits remain bounded to 1..64 MiB; zero removes
the wire-message cap rather than moving the failure to 64 MiB.

AutoCode opts into zero only for `workboard.cards.list`. The actual core call
owner checks the final resolved target before dispatch: configured numeric
loopback, local mode, shared token/password authentication, no URL override or
SSH tunnel. Remote targets and missing shared auth fail closed. Authentication,
scopes, deadlines and failure propagation retain their existing owners. The
low-level GatewayClient also supports explicit zero; its ordinary default is
unchanged. No global client setting, retries, truncation, filtering or DB edits
are introduced.

Uncapped does not mean bounded memory: complete decompressed strings, parsing,
objects and concurrent reads can consume more than wire size. Parent resource
admission, bounded concurrency, deadlines and process limits remain necessary.
Supported server pagination is the preferred future growth mechanism.

The patch is based on core `192b49f9704639d248adf4a546a658a83ad0968d`; its per-file
before/after hashes are in `bounded-gateway-response-source.json`. The historical
mocked overlay template is retained only as prior evidence. The current runner
requires an integrated clean hash-matching candidate and executes its tracked
public SDK test through the real call owner, without mocks or source overlays:

```
rtk proxy node scripts/check-native-board-payload-source.mjs CORE_SOURCE PROOF_DIRECTORY
rtk proxy pnpm exec vitest run tests/native-board-payload.test.ts tests/native-gateway-sdk.test.ts tests/native-gateway-contract.test.ts --maxWorkers=1 --fileParallelism=false
```

These are synthetic source checks using ephemeral authentication and isolated
state/ports. They do not prove packaged capability or authorize installation,
restart, activation, live board calls or verifier operations. Canonical core
build/typecheck requires checkout-local dependencies. Frozen dependencies are
prepared in the same candidate checkout without modifying the live install. No public named export or budget increase is added. Build,
package, owner checks and exact-SHA review receipts remain required before the
parent uses its existing runtime activation gates.
