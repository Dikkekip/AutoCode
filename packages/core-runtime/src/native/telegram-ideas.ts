import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { formatNativeIdea, type NativeIdeaDecision } from "./human-input.js"
import type { NativeAutonomyRuntime } from "./runtime.js"

const exec = promisify(execFile)
export async function sendNativeIdea(command: string, runtime: NativeAutonomyRuntime, message: string) {
  const config = runtime.humanInput!.config
  const args = [
    "message",
    "send",
    "--channel",
    "telegram",
    "--target",
    config.telegramTarget,
    "--message",
    message,
    "--json",
    ...(config.accountId ? ["--account", config.accountId] : [])
  ]
  await exec(command, args, { timeout: 30_000, maxBuffer: 64 * 1024 })
}
/** A lost delivery response is uncertain: do not repeatedly message the owner. /ideas remains available. */
export async function deliverNativeIdeas(runtime: NativeAutonomyRuntime, send: (message: string) => Promise<void>) {
  const input = runtime.humanInput
  if (!input) return
  const lease = runtime.store.acquire("idea-delivery", 60_000)
  if (!lease) return
  await runtime.store.withLease(lease, 60_000, async () => {
    for (const idea of input
      .list()
      .filter((item) => item.required && item.state === "pending" && !item.delivery)
      .slice(0, 2)) {
      runtime.store.put("idea-decision", idea.id, { ...idea, delivery: "sending" })
      try {
        await send(formatNativeIdea(idea))
        const latest = runtime.store.get<NativeIdeaDecision>("idea-decision", idea.id)!
        runtime.store.put("idea-decision", idea.id, { ...latest, delivery: "sent" })
        runtime.store.event("idea.delivered", idea.id, { channel: "telegram" })
      } catch {
        const latest = runtime.store.get<NativeIdeaDecision>("idea-decision", idea.id)!
        runtime.store.put("idea-decision", idea.id, { ...latest, delivery: "uncertain" })
        runtime.store.event("idea.delivery-uncertain", idea.id, { channel: "telegram" })
      }
    }
  })
}
/** Uses only host-authenticated command context; a model tool can never supply this identity. */
export async function handleNativeIdeaCommand(
  runtimes: NativeAutonomyRuntime[],
  ctx: any,
  decide: boolean,
  invoke: <T>(runtime: NativeAutonomyRuntime, action: () => Promise<T>) => Promise<T>
): Promise<{ text: string }> {
  const sender = String(ctx.senderId ?? "").replace(/^telegram:/, "")
  const direct = String(ctx.from ?? "").replace(/^telegram:/, "")
  const matches = runtimes.filter(
    (r) =>
      r.humanInput?.config.ownerIds.includes(sender) &&
      r.humanInput.config.telegramTarget === direct &&
      (!r.humanInput.config.accountId || r.humanInput.config.accountId === ctx.accountId)
  )
  const authorize = () => {
    if (
      (ctx.channelId ?? ctx.channel) !== "telegram" ||
      ctx.isAuthorizedSender !== true ||
      !/^[1-9][0-9]+$/.test(sender) ||
      matches.length !== 1
    )
      throw new Error("Use the configured private Telegram owner chat")
    ctx.assertOwnerCurrent?.()
  }
  try {
    authorize()
    const runtime = matches[0]!,
      input = runtime.humanInput!
    return await invoke(runtime, () =>
      runtime.withOwnership(async () => {
        authorize()
        if (!decide) {
          const pending = input
            .list()
            .filter((item) => item.state === "pending")
            .slice(0, 4)
          return {
            text: pending.length
              ? pending.map(formatNativeIdea).join("\n\n")
              : "No high-impact ideas await your decision. Routine work continues automatically; technical checks still apply."
          }
        }
        const parts = String(ctx.args ?? "")
          .trim()
          .split(/\s+/)
        if (parts.length !== 2 || !["approve", "skip"].includes(parts[0]!) || !/^[a-f0-9]{16}$/.test(parts[1]!))
          return { text: "Use /ideas, then /idea approve ID or /idea skip ID." }
        const idea = input.decide(parts[1]!, parts[0] as "approve" | "skip", sender, authorize)
        return {
          text:
            idea.state === "approved"
              ? `Approved direction: ${idea.title}. The planner will recheck current scope and evidence. Tests and agent review remain required.`
              : `Skipped: ${idea.title}. Routine work continues.`
        }
      })
    )
  } catch (error) {
    return { text: error instanceof Error ? error.message : "Decision unavailable; try /ideas." }
  }
}
