import type {
  AdapterDefinition,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterFailureCategory,
  AdapterHealthcheckResult,
  AdapterResultMetadata,
  Agent,
  SessionState
} from "@openclaw/domain"

const DEFAULT_MODEL = "Kimi-K2.6"
const DEFAULT_MODELS = ["gpt-5.4", "Kimi-K2.6", "gpt-5.4-mini", "text-embedding-3-small"]

const AZURE_FOUNDRY_CAPABILITIES = {
  supportsSessionResume: false,
  supportsCompaction: true,
  compactionStrategy: "summarize",
  preferredPlanningContextWindow: 256000,
  planningPriority: 85,
  planningCostClass: "medium",
  nativeContextManagement: "none",
  heartbeatIdentityMode: "prompt_and_env",
  defaultSessionCompaction: {
    enabled: false,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0
  }
} as const

type EndpointInput =
  | string
  | {
      name?: string
      baseUrl?: string
      endpoint?: string
      projectUrl?: string
      apiKey?: string
      apiKeyEnv?: string | string[]
      models?: string[]
    }

type FoundryEndpoint = {
  name: string
  baseUrl: string
  apiKeyEnv: string[]
  apiKey?: string
  models: string[]
}

type ResolvedEndpoint = FoundryEndpoint & {
  apiKey: string
  apiKeySource: string
}

type ChatCompletionResponse = {
  id?: string
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
    text?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    input_tokens?: number
    output_tokens?: number
  }
}

// Endpoints belong to the operator; never route credentials to built-in resources.
const DEFAULT_ENDPOINTS: FoundryEndpoint[] = []

function runtimeIdentityEnv(context: AdapterExecutionContext): NodeJS.ProcessEnv {
  return {
    OPENCLAW_RUNTIME_IDENTITY_JSON: JSON.stringify(context.runtimeIdentity),
    OPENCLAW_RUNTIME_KEY: context.runtimeIdentity.runtimeKey,
    OPENCLAW_EXECUTION_KEY: context.runtimeIdentity.executionKey,
    OPENCLAW_WAKE_REASON: context.runtimeIdentity.wake.reason,
    OPENCLAW_SESSION_KEY: context.runtimeIdentity.continuation.sessionKey
  }
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value)
  const path = url.pathname.replace(/\/+$/, "")

  if (path.endsWith("/chat/completions")) {
    url.pathname = `${path.slice(0, -"/chat/completions".length)}/`
    url.search = ""
    return url.toString()
  }

  const openAiV1Index = path.indexOf("/openai/v1")
  if (openAiV1Index >= 0) {
    url.pathname = `${path.slice(0, openAiV1Index + "/openai/v1".length)}/`
    url.search = ""
    return url.toString()
  }

  if (path === "/models" || path.startsWith("/models/")) {
    url.pathname = "/models/"
    url.search = ""
    return url.toString()
  }

  url.pathname = "/openai/v1/"
  url.search = ""
  return url.toString()
}

function projectUrlToOpenAiBase(value: string): string {
  return normalizedBaseUrl(value)
}

function endpointNameFromUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.hostname.split(".")[0] || "azure-foundry"
  } catch {
    return "azure-foundry"
  }
}

function parseStringList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function modelAliases(model: string): string[] {
  if (model === "Kimi-2.6") return ["Kimi-2.6", "Kimi-K2.6"]
  if (model === "Kimi-K2.6") return ["Kimi-2.6", "Kimi-K2.6"]
  return [model]
}

function endpointSupportsModel(endpoint: FoundryEndpoint, model: string): boolean {
  if (endpoint.models.length === 0) return true
  const aliases = modelAliases(model)
  return aliases.some((candidate) => endpoint.models.includes(candidate))
}

function parseEndpointInput(input: EndpointInput, index: number): FoundryEndpoint {
  if (typeof input === "string") {
    return {
      name: endpointNameFromUrl(input) || `foundry-${index + 1}`,
      baseUrl: normalizedBaseUrl(input),
      apiKeyEnv: [
        "OPENCLAW_AZURE_FOUNDRY_API_KEY",
        "AZURE_AI_API_KEY",
        "AZURE_OPENAI_API_KEY",
        "AZURE_AI_FOUNDRY_API_KEY"
      ],
      models: DEFAULT_MODELS
    }
  }

  const rawUrl = input.baseUrl ?? input.endpoint ?? input.projectUrl
  if (!rawUrl) {
    throw new Error(`Foundry endpoint ${index + 1} is missing baseUrl, endpoint, or projectUrl.`)
  }

  const apiKeyEnv = Array.isArray(input.apiKeyEnv)
    ? input.apiKeyEnv
    : input.apiKeyEnv
      ? [input.apiKeyEnv]
      : ["OPENCLAW_AZURE_FOUNDRY_API_KEY", "AZURE_AI_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_AI_FOUNDRY_API_KEY"]

  const endpoint: FoundryEndpoint = {
    name: input.name ?? endpointNameFromUrl(rawUrl) ?? `foundry-${index + 1}`,
    baseUrl: normalizedBaseUrl(rawUrl),
    apiKeyEnv,
    models: input.models?.filter(Boolean) ?? DEFAULT_MODELS
  }
  if (input.apiKey) {
    endpoint.apiKey = input.apiKey
  }
  return endpoint
}

function parseConfiguredEndpoints(env: NodeJS.ProcessEnv): FoundryEndpoint[] {
  const jsonValue = env.OPENCLAW_AZURE_FOUNDRY_ENDPOINTS
  if (jsonValue?.trim()) {
    try {
      const parsed = JSON.parse(jsonValue) as EndpointInput | EndpointInput[]
      const entries = Array.isArray(parsed) ? parsed : [parsed]
      return entries.map(parseEndpointInput)
    } catch (error) {
      throw new Error(
        `Invalid OPENCLAW_AZURE_FOUNDRY_ENDPOINTS JSON: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const commaSeparated = parseStringList(
    env.OPENCLAW_AZURE_FOUNDRY_PROJECT_URLS ?? env.OPENCLAW_AZURE_FOUNDRY_BASE_URLS
  )
  if (commaSeparated.length > 0) {
    return commaSeparated.map(parseEndpointInput)
  }

  return DEFAULT_ENDPOINTS
}

function resolveApiKey(endpoint: FoundryEndpoint, env: NodeJS.ProcessEnv): { key: string; source: string } | null {
  if (endpoint.apiKey) {
    return { key: endpoint.apiKey, source: "inline" }
  }

  for (const keyName of endpoint.apiKeyEnv) {
    const value = env[keyName]
    if (value?.trim()) {
      return { key: value.trim(), source: keyName }
    }
  }

  return null
}

function classifyFoundryFailures(failures: string[]): AdapterFailureCategory {
  const combined = failures.join("\n")
  if (/\b(?:http\s+429|rate[\s-]?limit|ratelimitreached|quota|resource exhausted)\b/i.test(combined)) {
    return "quota"
  }
  if (
    failures.length > 0 &&
    failures.every((failure) =>
      /\b(?:http\s+(?:401|403)|unauthori[sz]ed|forbidden|invalid subscription key|invalid api key)\b/i.test(failure)
    )
  ) {
    return "auth"
  }
  if (
    failures.length > 0 &&
    failures.every((failure) =>
      /\b(?:model .*not listed|model .*not found|unknown model|unsupported model)\b/i.test(failure)
    )
  ) {
    return "model-not-found"
  }
  return "transport"
}

function configuredEndpoints(env: NodeJS.ProcessEnv): ResolvedEndpoint[] {
  return parseConfiguredEndpoints(env)
    .map((endpoint) => {
      const apiKey = resolveApiKey(endpoint, env)
      return apiKey ? { ...endpoint, apiKey: apiKey.key, apiKeySource: apiKey.source } : null
    })
    .filter((endpoint): endpoint is ResolvedEndpoint => endpoint !== null)
}

function buildMetadata(context: AdapterExecutionContext, endpoint: FoundryEndpoint | null): AdapterResultMetadata {
  return {
    adapterType: "azure_foundry",
    provider: endpoint ? `azure_foundry:${endpoint.name}` : "azure_foundry",
    model: context.agent.model ?? DEFAULT_MODEL,
    capabilities: AZURE_FOUNDRY_CAPABILITIES
  }
}

function extractMessageContent(parsed: ChatCompletionResponse): string {
  const choice = parsed.choices?.[0]
  const content = choice?.message?.content ?? choice?.text
  if (typeof content === "string") {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n")
  }

  return ""
}

function buildUrl(baseUrl: string, env: NodeJS.ProcessEnv): string {
  const url = new URL("chat/completions", baseUrl)
  const apiVersion = env.OPENCLAW_AZURE_FOUNDRY_API_VERSION?.trim()
  if (apiVersion) {
    url.searchParams.set("api-version", apiVersion)
  }
  return url.toString()
}

function buildSystemPrompt(context: AdapterExecutionContext): string {
  return [
    "You are running inside OpenClaw's autonomous dispatcher.",
    `Runtime identity JSON: ${JSON.stringify(context.runtimeIdentity)}`,
    "Return concise, actionable text for the dispatcher to store as the run response.",
    "Do not claim to edit files directly unless the prompt explicitly provides a patch or tool output proving the edit."
  ].join("\n")
}

function parseResult(stdout: string, stderr: string, fallbackResponse = ""): AdapterExecutionResult {
  try {
    const parsed = JSON.parse(stdout) as ChatCompletionResponse
    const result: AdapterExecutionResult = {
      ok: true,
      response: extractMessageContent(parsed) || fallbackResponse,
      metadata: {
        adapterType: "azure_foundry",
        provider: "azure_foundry",
        model: DEFAULT_MODEL,
        capabilities: AZURE_FOUNDRY_CAPABILITIES
      },
      continuation: null,
      stdout,
      stderr
    }
    if (parsed.usage) {
      const usage: NonNullable<AdapterExecutionResult["usage"]> = {}
      const inputTokens = parsed.usage.prompt_tokens ?? parsed.usage.input_tokens
      const outputTokens = parsed.usage.completion_tokens ?? parsed.usage.output_tokens
      if (inputTokens !== undefined) usage.inputTokens = inputTokens
      if (outputTokens !== undefined) usage.outputTokens = outputTokens
      if (parsed.usage.total_tokens !== undefined) usage.totalTokens = parsed.usage.total_tokens
      result.usage = usage
    }
    return result
  } catch {
    return {
      ok: true,
      response: fallbackResponse || stdout.trim(),
      metadata: {
        adapterType: "azure_foundry",
        provider: "azure_foundry",
        model: DEFAULT_MODEL,
        capabilities: AZURE_FOUNDRY_CAPABILITIES
      },
      continuation: null,
      stdout,
      stderr
    }
  }
}

async function prepare(context: AdapterExecutionContext): Promise<{
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
}> {
  const env = {
    ...process.env,
    ...context.agent.env,
    ...runtimeIdentityEnv(context)
  }
  const endpoints = parseConfiguredEndpoints(env)

  return {
    argv: [
      "azure-foundry",
      "--model",
      context.agent.model ?? DEFAULT_MODEL,
      "--endpoints",
      endpoints.map((endpoint) => endpoint.name).join(",")
    ],
    cwd: context.project.repoPath,
    env,
    stdin: context.prompt
  }
}

async function execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const prepared = await prepare(context)
  const endpoints = configuredEndpoints(prepared.env)
  const model = context.agent.model ?? DEFAULT_MODEL

  if (endpoints.length === 0) {
    return {
      ok: false,
      response: "",
      metadata: buildMetadata(context, null),
      continuation: null,
      runtimeIdentity: context.runtimeIdentity,
      error: "No Azure Foundry endpoints have an API key configured.",
      failureCategory: "auth"
    }
  }

  const failures: string[] = []
  for (const endpoint of endpoints) {
    if (!endpointSupportsModel(endpoint, model)) {
      failures.push(`${endpoint.name}: model ${model} not listed for endpoint`)
      continue
    }

    const url = buildUrl(endpoint.baseUrl, prepared.env)
    context.log("info", "Launching Azure Foundry chat completion", {
      endpoint: endpoint.name,
      model,
      apiKeySource: endpoint.apiKeySource
    })

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "api-key": endpoint.apiKey,
          authorization: `Bearer ${endpoint.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: buildSystemPrompt(context) },
            { role: "user", content: context.prompt }
          ],
          stream: false
        })
      })
      const text = await response.text()

      if (!response.ok) {
        failures.push(`${endpoint.name}: HTTP ${response.status} ${text.slice(0, 500)}`)
        continue
      }

      const parsed = parseResult(text, "", "")
      return {
        ...parsed,
        ok: true,
        metadata: buildMetadata(context, endpoint),
        continuation: null,
        runtimeIdentity: context.runtimeIdentity
      }
    } catch (error) {
      failures.push(`${endpoint.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    ok: false,
    response: "",
    metadata: buildMetadata(context, null),
    continuation: null,
    runtimeIdentity: context.runtimeIdentity,
    error: `All Azure Foundry endpoints failed. ${failures.join(" | ")}`,
    stderr: failures.join("\n"),
    failureCategory: classifyFoundryFailures(failures)
  }
}

async function resume(sessionState: SessionState | null): Promise<Record<string, unknown> | null> {
  return sessionState?.state ?? null
}

async function healthcheck(agent: Agent): Promise<AdapterHealthcheckResult> {
  const env = { ...process.env, ...agent.env }
  let endpoints: FoundryEndpoint[]
  try {
    endpoints = parseConfiguredEndpoints(env)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  const available = endpoints.filter((endpoint) => resolveApiKey(endpoint, env))
  if (available.length === 0) {
    return {
      ok: false,
      message: "No Azure Foundry API key configured for any endpoint."
    }
  }

  const missing = endpoints.filter((endpoint) => !resolveApiKey(endpoint, env)).map((endpoint) => endpoint.name)
  const requestedModel = agent.model ?? DEFAULT_MODEL
  const modelReady = available.filter((endpoint) => endpointSupportsModel(endpoint, requestedModel))
  if (modelReady.length === 0) {
    return {
      ok: false,
      message: `No keyed Azure Foundry endpoint lists model ${requestedModel}.`
    }
  }
  const suffix = missing.length > 0 ? ` (${missing.length} endpoint(s) missing keys: ${missing.join(", ")})` : ""
  return {
    ok: true,
    message: `azure_foundry configured with ${modelReady.length}/${endpoints.length} keyed endpoint(s) for ${requestedModel}: ${modelReady.map((endpoint) => endpoint.name).join(", ")}${suffix}`
  }
}

export const azureFoundryAdapter: AdapterDefinition = {
  type: "azure_foundry",
  label: "Azure Foundry",
  capabilities: AZURE_FOUNDRY_CAPABILITIES,
  prepare,
  execute,
  resume,
  parseResult,
  healthcheck
}

export const internalAzureFoundry = {
  DEFAULT_ENDPOINTS,
  DEFAULT_MODELS,
  normalizedBaseUrl,
  parseConfiguredEndpoints,
  configuredEndpoints,
  classifyFoundryFailures
}
