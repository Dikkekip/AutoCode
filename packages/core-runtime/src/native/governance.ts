// New: service-only governance inputs. Never construct these from model tool arguments.
import { createHash } from "node:crypto"
export interface NativeHumanAuthority {
  operatorId: string
  rationale: string
}
export function requireNativeHuman(authority: NativeHumanAuthority, agentIds: readonly string[]) {
  if (!authority?.operatorId?.trim() || agentIds.includes(authority.operatorId) || !authority.rationale?.trim())
    throw new Error("Independent authenticated operator decision required")
}
export const nativeGovernanceDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
