# @openclaw/ui-components

Reusable React components for multi-agent dashboards inspired by the transcript UX in Paperclip and the agent/session visual language in Squad.

The package exposes:

- normalized event and transcript types
- Paperclip transcript normalization helpers
- Squad shell/runtime normalization helpers
- dashboard components for parallel agent chat, internal monologues, state transitions, and autonomous company operations

The components avoid router, query-client, and Tailwind dependencies so they can be dropped into Next.js dashboards directly.

## Autonomous Company Dashboard

The package includes typed contracts, fixture data, reusable dashboard sections, and a fixture-backed preview component:

```tsx
import {
  AutonomousCompanyDashboard,
  AutonomousCompanyDashboardPreview,
  autonomousCompanyDashboardFixture
} from "@openclaw/ui-components"

export function DashboardPage() {
  return <AutonomousCompanyDashboard data={autonomousCompanyDashboardFixture} />
}

export function PreviewPage() {
  return <AutonomousCompanyDashboardPreview />
}
```

`AutonomousCompanyDashboardPreview` is the Storybook-equivalent preview surface for this package: it renders without a backend and can be mounted by any host app or visual test harness.
