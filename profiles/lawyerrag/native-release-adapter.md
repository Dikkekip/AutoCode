# LawyerRAG native release adapter

The adapter takes `--config /absolute/private/config.json` and an operation:
`bootstrap`, `stage-current`, `prepare`, `check`, `deploy`, or `rollback`.
The runtime supplies exact `AUTOCODE_SHA`, `AUTOCODE_ARTIFACT_SHA256` and
`AUTOCODE_TARGET_ID` values for release operations.

Configuration keys:

- `stateDirectory`: private manifest, staging evidence and log directory.
- `sourceRepository`: the clean deployment checkout used by the existing adapter.
- `legacyAdapter`: the established, administrator-reviewed K3s deployment adapter.
- `targetId`: exact production target identity.
- `releaseLock`: the existing K3s release lock shared by all production deployers.
- `stagingCompose`: private Compose JSON with an internal-only network, separate
  database and credentials, API, worker, their Dapr sidecars, placement, scheduler,
  Redis and frontend. API and worker must select the shared `taskregistry` store.
- `alembicPath`: Alembic configuration inside the application image.
- `stagingObservationSeconds`: positive sustained readiness window (60 seconds).
- `minimumBuildFreeGiB`: existing build headroom requirement (30 GiB).

No production documents or model credentials are copied into staging. Staging
runs real database migrations and the application's synthetic durable workflow
probe, then requires authenticated API requests, settled durable readiness and
exact API, worker and frontend image identities through the observation window.
The workflow probe uses only its own synthetic registry state. External model
behavior and private evidence content are outside this canary's coverage.

The initial manifest is recorded only after current production navigation,
rollouts, image identities and Dapr sidecar readiness pass. Subsequent manifests
are created after a successful build. Existing manifests and image identities
are checked on every reuse. Production publication occurs only after staging.
Unknown target identity never becomes a negative-health rollback authorization.
A settled, exact-identity application regression produces a negative receipt so
the runtime can invoke its independently verified known-good rollback.

Validate with:

```sh
python3 profiles/lawyerrag/test_native_release_adapter.py
```
