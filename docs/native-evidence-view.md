# Native evidence view (new)

`NativeEvidenceView` is an embeddable, read-only React view from `@openclaw/ui-components`. The reviewed OpenClaw installation has no verified UI-extension contract here, so this does not claim to install a new operator application. Workboard remains the execution owner.

An authenticated operator host can request `autocode.dashboard` for one board and pass its validated result as the snapshot. Transport and operator authentication stay in that host. Never put a Gateway token into a public browser bundle. The same versioned workflow explanation backs CLI and UI.

```tsx
import { decodeNativeEvidence, NativeEvidenceView } from "@openclaw/ui-components"

// payload comes from the host's authenticated read-only connection.
const snapshot = decodeNativeEvidence(payload)
return <NativeEvidenceView state="ready" snapshot={snapshot} />
```

Pass `state="loading"` while waiting and `state="offline"` when unavailable. Empty evidence is an empty state, never a fixture fallback. `source="demo"` produces a visible demonstration label; live snapshots require `source="live"` and an observation timestamp. The view marks snapshots stale after 60 seconds by default. Unknown cost stays unknown. Metrics come from immutable native outcome cohorts, not counts of completed cards.

The view reuses the existing `MetricGrid`, provides a caption and column/row table headers, and exposes loading/offline updates through a status region. It has no buttons or effects that create tasks, retry work, or deploy. Recovery requires a separate explicit CLI plan/apply action; workflow next-action text is supplied by the same server explanation. Content is rendered as React text, never executable HTML.

Validation uses synthetic schema/adapter/component fixtures. Installed UI integration and a real screen-reader session remain operator checks; unit tests are not claims of a deployed dashboard.
