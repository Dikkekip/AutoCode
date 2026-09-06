import type { Agent } from "@openclaw/domain"
import { describe, expect, it } from "vitest"
import { azureFoundryAdapter, internalAzureFoundry } from "../packages/adapters/azure-foundry/src/index.js"

const baseAgent: Agent = {
  id: "agent-foundry",
  companyId: "company-1",
  name: "foundry-planner",
  role: "Planner",
  adapterType: "azure_foundry",
  status: "idle",
  model: "Kimi-K2.6",
  instructionsPath: null,
  command: null,
  env: {},
  heartbeatEnabled: true,
  heartbeatIntervalSec: 300,
  budgetLimit: null,
  budgetWindow: "monthly",
  lastHeartbeatAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}

describe("azureFoundryAdapter", () => {
  it("normalizes AI Foundry project URLs to OpenAI-compatible bases", () => {
    expect(
      internalAzureFoundry.normalizedBaseUrl(
        "https://example-resource.services.ai.azure.com/api/projects/proj-example-resource"
      )
    ).toBe("https://example-resource.services.ai.azure.com/openai/v1/")
    expect(
      internalAzureFoundry.normalizedBaseUrl("https://example-models.services.ai.azure.com/openai/v1/chat/completions")
    ).toBe("https://example-models.services.ai.azure.com/openai/v1/")
    expect(internalAzureFoundry.normalizedBaseUrl("https://example-models.services.ai.azure.com/models")).toBe(
      "https://example-models.services.ai.azure.com/models/"
    )
  })

  it("parses configured endpoint JSON", () => {
    const endpoints = internalAzureFoundry.parseConfiguredEndpoints({
      OPENCLAW_AZURE_FOUNDRY_ENDPOINTS: JSON.stringify([
        {
          name: "primary",
          projectUrl: "https://example-foundry.services.ai.azure.com/api/projects/AIFoundry",
          apiKeyEnv: "PRIMARY_KEY",
          models: ["Kimi-K2.6"]
        }
      ])
    })

    expect(endpoints).toEqual([
      {
        name: "primary",
        baseUrl: "https://example-foundry.services.ai.azure.com/openai/v1/",
        apiKeyEnv: ["PRIMARY_KEY"],
        models: ["Kimi-K2.6"]
      }
    ])
  })

  it("requires explicit endpoints even when a generic API key is present", () => {
    expect(internalAzureFoundry.DEFAULT_ENDPOINTS).toEqual([])
    expect(internalAzureFoundry.parseConfiguredEndpoints({ AZURE_AI_API_KEY: "test-key" })).toEqual([])
  })

  it("reports health when at least one configured endpoint has a key", async () => {
    const result = await azureFoundryAdapter.healthcheck({
      ...baseAgent,
      env: {
        OPENCLAW_AZURE_FOUNDRY_ENDPOINTS: JSON.stringify([
          {
            name: "primary",
            projectUrl: "https://example-foundry.services.ai.azure.com/api/projects/AIFoundry",
            apiKeyEnv: "PRIMARY_KEY"
          }
        ]),
        PRIMARY_KEY: "test-key"
      }
    })

    expect(result).toMatchObject({
      ok: true
    })
    expect(result.message).toContain("primary")
  })

  it("classifies mixed invalid-key and rate-limit endpoint failures as quota exhaustion", () => {
    expect(
      internalAzureFoundry.classifyFoundryFailures([
        "primary: HTTP 401 Access denied due to invalid subscription key. Make sure to provide a valid key.",
        "secondary: HTTP 429 RateLimitReached"
      ])
    ).toBe("quota")
  })

  it("classifies uniformly invalid endpoint keys as authentication failure", () => {
    expect(
      internalAzureFoundry.classifyFoundryFailures([
        "primary: HTTP 401 invalid subscription key",
        "secondary: HTTP 403 forbidden"
      ])
    ).toBe("auth")
  })
})
