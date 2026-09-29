import { setTimeout as sleep } from "node:timers/promises"

type DiscoveryResult = { created: string[]; reason?: string }

/** A scheduled native discovery tick should survive a short reconcile lease overlap. */
export async function retryContendedDiscovery<T extends DiscoveryResult>(
  discover: () => Promise<T>,
  wait: (milliseconds: number) => Promise<unknown> = sleep,
  maxAttempts = 15
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const result = await discover()
    if (result.reason !== "reconciliation already running" || attempt >= maxAttempts) return result
    await wait(7_000)
  }
}
