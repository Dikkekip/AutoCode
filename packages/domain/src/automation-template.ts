const AUTOMATION_VARIABLE_MATCHER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g

export const BUILTIN_AUTOMATION_VARIABLE_NAMES = new Set(["date", "weekday"])

export interface AutomationTemplateVariable {
  name: string
  label: string | null
  type: "text" | "number" | "boolean" | "select"
  defaultValue: string | number | boolean | null
  required: boolean
  options: string[]
}

type AutomationTemplateInput = string | null | undefined | Array<string | null | undefined>

export function getBuiltinAutomationVariableValues(now = new Date()): Record<string, string> {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long"
  }).format(now)

  return {
    date: now.toISOString().slice(0, 10),
    weekday
  }
}

export function interpolateAutomationTemplate(
  template: string | null | undefined,
  values: Record<string, unknown> | null | undefined
): string | null {
  if (template == null) return null
  if (!values || Object.keys(values).length === 0) return template

  return template.replace(AUTOMATION_VARIABLE_MATCHER, (match, rawName: string) => {
    if (!(rawName in values)) return match
    const value = values[rawName]
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (value == null) return ""
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  })
}

function normalizeAutomationTemplateInput(input: AutomationTemplateInput): string[] {
  const templates = Array.isArray(input) ? input : [input]
  return templates.filter((template): template is string => typeof template === "string" && template.length > 0)
}

export function isBuiltinAutomationVariable(name: string): boolean {
  return BUILTIN_AUTOMATION_VARIABLE_NAMES.has(name)
}

export function isValidAutomationVariableName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name)
}

export function extractAutomationVariableNames(input: AutomationTemplateInput): string[] {
  const found = new Set<string>()
  for (const template of normalizeAutomationTemplateInput(input)) {
    for (const match of template.matchAll(AUTOMATION_VARIABLE_MATCHER)) {
      const name = match[1]
      if (name && !found.has(name)) found.add(name)
    }
  }
  return [...found]
}

function defaultAutomationVariable(name: string): AutomationTemplateVariable {
  return {
    name,
    label: null,
    type: "text",
    defaultValue: null,
    required: true,
    options: []
  }
}

export function syncAutomationVariablesWithTemplate(
  input: AutomationTemplateInput,
  existing: AutomationTemplateVariable[] | null | undefined
): AutomationTemplateVariable[] {
  const names = extractAutomationVariableNames(input).filter((name) => !isBuiltinAutomationVariable(name))
  const existingByName = new Map((existing ?? []).map((variable) => [variable.name, variable]))
  return names.map((name) => existingByName.get(name) ?? defaultAutomationVariable(name))
}
