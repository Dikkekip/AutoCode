import type { AdapterType, TaskLane, TaskPackage } from "./types.js"

export interface OpenClawRecipeParameter {
  key: string
  required?: boolean | undefined
  default?: string | number | boolean | null | undefined
  description?: string | undefined
}

export interface OpenClawSubRecipe {
  name: string
  values?: Record<string, string | number | boolean | null> | undefined
  recipe: Omit<OpenClawTaskRecipe, "subRecipes">
}

export interface OpenClawTaskRecipe {
  id: string
  title: string
  description: string
  instructions?: string | undefined
  prompt?: string | undefined
  parameters?: OpenClawRecipeParameter[] | undefined
  requiredReading?: string[] | undefined
  verificationCommands?: string[] | undefined
  extraInstructions?: string[] | undefined
  lane?: TaskLane | undefined
  adapterPreference?: AdapterType | null | undefined
  subRecipes?: OpenClawSubRecipe[] | undefined
}

export interface RenderedOpenClawRecipe {
  id: string
  title: string
  description: string
  instructions: string[]
  prompt: string | null
  missingParameters: string[]
  subRecipes: Array<{
    name: string
    title: string
    instructions: string[]
    prompt: string | null
  }>
}

const PARAMETER_MATCHER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g

function valueToString(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function parameterValues(
  recipe: Pick<OpenClawTaskRecipe, "parameters">,
  values: Record<string, unknown> | null | undefined
): { values: Record<string, unknown>; missing: string[] } {
  const resolved = { ...(values ?? {}) }
  const missing: string[] = []

  for (const parameter of recipe.parameters ?? []) {
    if (resolved[parameter.key] == null && parameter.default !== undefined) {
      resolved[parameter.key] = parameter.default
    }
    if (parameter.required && resolved[parameter.key] == null) {
      missing.push(parameter.key)
    }
  }

  return { values: resolved, missing }
}

function interpolate(template: string | undefined, values: Record<string, unknown>): string | null {
  if (!template) return null
  return template.replace(PARAMETER_MATCHER, (match, rawName: string) =>
    Object.hasOwn(values, rawName) ? valueToString(values[rawName]) : match
  )
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function renderOpenClawTaskRecipe(
  recipe: OpenClawTaskRecipe,
  values?: Record<string, unknown>
): RenderedOpenClawRecipe {
  const renderedValues = parameterValues(recipe, values)
  const subRecipes = (recipe.subRecipes ?? []).map((subRecipe) => {
    const subValues = parameterValues(subRecipe.recipe, {
      ...renderedValues.values,
      ...(subRecipe.values ?? {})
    })

    return {
      name: subRecipe.name,
      title: subRecipe.recipe.title,
      instructions: compactStrings([
        interpolate(subRecipe.recipe.instructions, subValues.values),
        ...(subRecipe.recipe.extraInstructions ?? []).map((entry) => interpolate(entry, subValues.values))
      ]),
      prompt: interpolate(subRecipe.recipe.prompt, subValues.values)
    }
  })

  return {
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    instructions: compactStrings([
      interpolate(recipe.instructions, renderedValues.values),
      ...(recipe.extraInstructions ?? []).map((entry) => interpolate(entry, renderedValues.values))
    ]),
    prompt: interpolate(recipe.prompt, renderedValues.values),
    missingParameters: renderedValues.missing,
    subRecipes
  }
}

export function applyOpenClawTaskRecipe(input: {
  taskPackage: TaskPackage
  recipe: OpenClawTaskRecipe
  values?: Record<string, unknown> | undefined
  generatedAt?: string | undefined
}): TaskPackage {
  const rendered = renderOpenClawTaskRecipe(input.recipe, input.values)
  const subRecipeInstructions = rendered.subRecipes.flatMap((subRecipe) =>
    compactStrings([
      `Subrecipe ${subRecipe.name}: ${subRecipe.title}`,
      ...subRecipe.instructions,
      subRecipe.prompt ? `Prompt: ${subRecipe.prompt}` : null
    ])
  )

  return {
    ...input.taskPackage,
    generatedAt: input.generatedAt ?? input.taskPackage.generatedAt,
    likelyOwnershipLane: input.recipe.lane ?? input.taskPackage.likelyOwnershipLane,
    adapterPreference: input.recipe.adapterPreference ?? input.taskPackage.adapterPreference,
    requiredReading: compactStrings([...input.taskPackage.requiredReading, ...(input.recipe.requiredReading ?? [])]),
    verificationChecklist: compactStrings([
      ...input.taskPackage.verificationChecklist,
      ...(input.recipe.verificationCommands ?? [])
    ]),
    inferenceSignals: compactStrings([...input.taskPackage.inferenceSignals, `recipe:${input.recipe.id}`]),
    repoNotes: compactStrings([
      ...input.taskPackage.repoNotes,
      `Recipe ${rendered.id}: ${rendered.title}`,
      rendered.description,
      rendered.missingParameters.length > 0
        ? `Missing recipe parameters: ${rendered.missingParameters.join(", ")}`
        : null
    ]),
    extraInstructions: compactStrings([
      ...(input.taskPackage.extraInstructions ?? []),
      ...rendered.instructions,
      rendered.prompt ? `Recipe prompt: ${rendered.prompt}` : null,
      ...subRecipeInstructions
    ])
  }
}
