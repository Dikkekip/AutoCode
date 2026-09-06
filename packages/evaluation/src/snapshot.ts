import { EvaluationRunner } from "./runner.js"
import type { EvaluationStorage } from "./storage.js"
import type {
  EvaluationBenchmark,
  EvaluationMetric,
  EvaluationMetricResult,
  EvaluationSolution,
  PromptSnapshotExecutor,
  PromptSnapshotSuite,
  RenderedPromptSnapshotCase,
  SnapshotAssertion,
  SnapshotAssertionContext,
  SnapshotVariableValue
} from "./types.js"

function toOutputString(output: string): string {
  return output
}

function assertionMetricId<Vars extends Record<string, SnapshotVariableValue>>(
  snapshotCase: RenderedPromptSnapshotCase<Vars>,
  assertion: SnapshotAssertion<Vars>,
  index: number
): string {
  return assertion.metricId ?? `${snapshotCase.id}.assertion_${index + 1}`
}

function containsValue(haystack: string, needle: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return haystack.includes(needle)
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function buildAssertionDescription<Vars extends Record<string, SnapshotVariableValue>>(
  assertion: SnapshotAssertion<Vars>
): string {
  switch (assertion.type) {
    case "contains":
      return `Output contains "${assertion.value}"`
    case "not_contains":
      return `Output does not contain "${assertion.value}"`
    case "regex":
      return `Output matches /${assertion.pattern}/${assertion.flags ?? ""}`
    case "predicate":
      return assertion.description ?? assertion.metricId
  }
}

async function evaluateSnapshotAssertion<Vars extends Record<string, SnapshotVariableValue>>(
  assertion: SnapshotAssertion<Vars>,
  context: SnapshotAssertionContext<Vars>
): Promise<{ passed: boolean; message: string }> {
  switch (assertion.type) {
    case "contains": {
      const passed = containsValue(context.output, assertion.value, assertion.caseSensitive ?? true)
      return {
        passed,
        message: passed ? `Found "${assertion.value}"` : `Missing "${assertion.value}"`
      }
    }
    case "not_contains": {
      const passed = !containsValue(context.output, assertion.value, assertion.caseSensitive ?? true)
      return {
        passed,
        message: passed ? `Did not find "${assertion.value}"` : `Unexpectedly found "${assertion.value}"`
      }
    }
    case "regex": {
      const passed = new RegExp(assertion.pattern, assertion.flags).test(context.output)
      return {
        passed,
        message: passed ? `Matched /${assertion.pattern}/` : `Did not match /${assertion.pattern}/`
      }
    }
    case "predicate": {
      const passed = await assertion.evaluate(context)
      return {
        passed,
        message: passed ? `${assertion.metricId} passed` : `${assertion.metricId} failed`
      }
    }
  }
}

function renderPrompt(template: string, vars: Record<string, SnapshotVariableValue>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key]
    return value === null || value === undefined ? "" : String(value)
  })
}

export function materializePromptSnapshotSuite<Vars extends Record<string, SnapshotVariableValue>>(
  suite: PromptSnapshotSuite<Vars>
): Array<RenderedPromptSnapshotCase<Vars>> {
  return suite.cases.map((item) => {
    const vars = { ...suite.defaultVars, ...(item.vars ?? {}) } as Vars
    return {
      id: item.id,
      prompt: item.prompt ?? renderPrompt(suite.promptTemplate, vars),
      vars,
      assertions: item.assertions,
      tags: { suite: suite.id, ...(item.tags ?? {}) },
      metadata: item.metadata ?? {},
      ...(item.description ? { description: item.description } : {})
    }
  })
}

function createAssertionMetric<Vars extends Record<string, SnapshotVariableValue>>(
  snapshotCase: RenderedPromptSnapshotCase<Vars>,
  assertion: SnapshotAssertion<Vars>,
  index: number
): EvaluationMetric<RenderedPromptSnapshotCase<Vars>, undefined, string> {
  const metricId = assertionMetricId(snapshotCase, assertion, index)
  return {
    id: metricId,
    kind: "boolean",
    description: buildAssertionDescription(assertion),
    async evaluate({ solution }): Promise<EvaluationMetricResult> {
      const output = toOutputString(solution.output)
      const evaluation = await evaluateSnapshotAssertion(assertion, {
        output,
        prompt: snapshotCase.prompt,
        vars: snapshotCase.vars,
        solution
      })

      return {
        metricId,
        kind: "boolean",
        value: evaluation.passed,
        passed: evaluation.passed,
        message: evaluation.message,
        createdAt: new Date().toISOString()
      }
    }
  }
}

export function createPromptSnapshotBenchmark<Vars extends Record<string, SnapshotVariableValue>>(
  suite: PromptSnapshotSuite<Vars>
): EvaluationBenchmark<RenderedPromptSnapshotCase<Vars>> {
  return {
    id: suite.id,
    name: suite.name,
    description: suite.description,
    tasks: materializePromptSnapshotSuite(suite).map((snapshotCase) => ({
      id: snapshotCase.id,
      input: snapshotCase,
      metrics: snapshotCase.assertions.map((assertion, index) => createAssertionMetric(snapshotCase, assertion, index)),
      tags: snapshotCase.tags,
      metadata: snapshotCase.metadata
    }))
  }
}

function normalizeSnapshotSolution(result: string | EvaluationSolution<string>): EvaluationSolution<string> {
  if (typeof result === "string") {
    return {
      success: true,
      output: result,
      trajectory: [{ type: "text", text: result }]
    }
  }
  return result
}

export async function runPromptSnapshotSuite<Vars extends Record<string, SnapshotVariableValue>>(input: {
  suite: PromptSnapshotSuite<Vars>
  storage: EvaluationStorage
  repeatCount?: number
  evaluationId?: string
  executor: PromptSnapshotExecutor<Vars>
}) {
  const benchmark = createPromptSnapshotBenchmark(input.suite)
  const runner = new EvaluationRunner({
    benchmark,
    storage: input.storage,
    repeatCount: input.repeatCount ?? 1,
    ...(input.evaluationId ? { evaluationId: input.evaluationId } : {})
  })

  return runner.run(async (task, context) =>
    normalizeSnapshotSolution(await input.executor(task.input as RenderedPromptSnapshotCase<Vars>, context as never))
  )
}
