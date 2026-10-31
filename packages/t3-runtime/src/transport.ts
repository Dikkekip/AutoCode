/** T3's advertised MCP tool contract. Authentication and session scoping belong to the caller. */
export interface T3ToolTransport {
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>
}

export interface T3Capabilities {
  runtimeMode: string
  parentThreadId: string | null
  inheritedProviderInstanceId: string | null
  providers: Array<{
    providerInstanceId: string
    driverKind: string
    canRunChildTask: boolean
    canRunCrossProviderChildTask: boolean
    constraints: string[]
    models: Array<{ id: string; options: Array<{ id: string; values: Array<string | boolean> }> }>
  }>
  features: { appOwnedSubagents: boolean; cancellation: boolean; scheduledTasks: boolean }
}

export function t3Object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`)
  return value as Record<string, unknown>
}

/** Accept MCP CallToolResult or a decoded structured result, never a prose success claim. */
export function decodeT3ToolResult(value: unknown): Record<string, unknown> {
  const result = t3Object(value, "T3 tool result")
  if (result.isError === true) throw new Error("T3 tool reported an error; reconcile any mutation before retry")
  if (result.structuredContent !== undefined) return t3Object(result.structuredContent, "T3 structured result")
  if (Array.isArray(result.content)) {
    const texts = result.content.filter((item) => t3Object(item, "T3 content").type === "text")
    if (texts.length !== 1) throw new Error("T3 result has no unambiguous structured payload")
    const text = t3Object(texts[0], "T3 text content").text
    if (typeof text !== "string") throw new Error("T3 result text unavailable")
    return t3Object(JSON.parse(text), "T3 JSON result")
  }
  return result
}

export class T3Host {
  constructor(readonly transport: T3ToolTransport) {}

  async invoke(name: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
    return decodeT3ToolResult(await this.transport.callTool(name, arguments_))
  }

  async capabilities(): Promise<T3Capabilities> {
    const value = await this.invoke("orchestrator_capabilities", {})
    const features = t3Object(value.features, "T3 capabilities.features")
    if (typeof value.runtimeMode !== "string" || !Array.isArray(value.providers))
      throw new Error("T3 capability contract unavailable")
    for (const key of ["appOwnedSubagents", "cancellation", "scheduledTasks"])
      if (typeof features[key] !== "boolean") throw new Error(`T3 capability unavailable: ${key}`)
    const providers = value.providers.map((raw) => {
      const provider = t3Object(raw, "T3 provider")
      if (
        typeof provider.providerInstanceId !== "string" ||
        typeof provider.driverKind !== "string" ||
        typeof provider.canRunChildTask !== "boolean" ||
        typeof provider.canRunCrossProviderChildTask !== "boolean" ||
        !Array.isArray(provider.constraints) ||
        !provider.constraints.every((constraint) => typeof constraint === "string")
      )
        throw new Error("T3 provider contract unavailable")
      const models = Array.isArray(provider.models)
        ? provider.models.map((entry) => {
            const model = t3Object(entry, "T3 model")
            if (typeof model.id !== "string") throw new Error("Invalid T3 model")
            const options = Array.isArray(model.options)
              ? model.options.map((entry) => {
                  const option = t3Object(entry, "T3 model option")
                  if (
                    typeof option.id !== "string" ||
                    !Array.isArray(option.values) ||
                    option.values.some((v) => typeof v !== "string" && typeof v !== "boolean")
                  )
                    throw new Error("Invalid T3 model option")
                  return { id: option.id, values: option.values as Array<string | boolean> }
                })
              : []
            return { id: model.id, options }
          })
        : []
      return {
        providerInstanceId: provider.providerInstanceId,
        driverKind: provider.driverKind,
        canRunChildTask: provider.canRunChildTask,
        canRunCrossProviderChildTask: provider.canRunCrossProviderChildTask,
        constraints: provider.constraints as string[],
        models
      }
    })
    return {
      runtimeMode: value.runtimeMode,
      providers,
      features: features as unknown as T3Capabilities["features"],
      parentThreadId: typeof value.parentThreadId === "string" ? value.parentThreadId : null,
      inheritedProviderInstanceId:
        typeof value.inheritedProviderInstanceId === "string" ? value.inheritedProviderInstanceId : null
    }
  }
}

/** Inject the current authenticated T3 tool caller. No global token discovery or private RPC fallback. */
export class T3CallbackTransport implements T3ToolTransport {
  constructor(private readonly caller: T3ToolTransport["callTool"]) {}

  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    return this.caller(name, arguments_)
  }
}
