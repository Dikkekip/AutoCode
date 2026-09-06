export interface SourceLocationRange {
  pageStart?: number | null
  pageEnd?: number | null
  lineStart?: number | null
  lineEnd?: number | null
  charStart?: number | null
  charEnd?: number | null
  timestampStart?: string | null
  timestampEnd?: string | null
  section?: string | null
  label?: string | null
}

export interface SummarySourceInput {
  ref?: string | null
  title?: string | null
  excerpt: string
  docId?: string | null
  chunkId?: string | null
  uri?: string | null
  path?: string | null
  sourceType?: string | null
  location?: SourceLocationRange | null
  metadata?: Record<string, unknown> | undefined
}

export interface PreparedSummarySource extends SummarySourceInput {
  sourceRef: string
  title: string | null
  sourceIndex: number
  location: SourceLocationRange | null
  locationKey: string
  locationLabel: string
  locationTag: string
}

export interface SourceCitationMatch {
  rawTag: string
  tag: string
  sourceIndex: number
  locationKey: string
  sourceRef: string
}

export interface SummaryCitationValidation {
  status: "ok" | "failed" | "skipped"
  reason: "valid" | "no_sources" | "missing_tags" | "unknown_source" | "location_mismatch"
  message: string
  citationsRequired: boolean
  invalidTags: string[]
  missingSourceIndices: number[]
  citedSourceIndices: number[]
  uncitedSourceIndices: number[]
}

export interface SummaryCitationProvenanceSource {
  sourceIndex: number
  sourceRef: string
  title: string | null
  locationTag: string
  locationKey: string
  locationLabel: string
  excerpt: string
  docId?: string | null
  chunkId?: string | null
  uri?: string | null
  path?: string | null
  sourceType?: string | null
  metadata?: Record<string, unknown> | undefined
}

export interface SummaryCitationProvenance {
  generatedAt: string
  strict: boolean
  citationsRequired: boolean
  sources: SummaryCitationProvenanceSource[]
  citations: SourceCitationMatch[]
  citedSourceIndices: number[]
  uncitedSourceIndices: number[]
}

export interface SummaryCitationResult {
  content: string
  normalizedContent: string
  validation: SummaryCitationValidation
  provenance: SummaryCitationProvenance
}

export interface PreparedSummaryInput {
  prompt: string
  composedPrompt: string
  citationInstructions: string
  sourceCatalog: string
  sources: PreparedSummarySource[]
}

export interface SourceCitationMiddlewareOptions {
  strict?: boolean
  citationsRequiredWhenSourcesPresent?: boolean
  tagPrefix?: string
}

export interface RunSummaryWithCitationsParams {
  prompt: string
  sources: SummarySourceInput[]
  generate: (input: PreparedSummaryInput) => Promise<string>
}

export interface SummaryCitationMiddleware {
  prepareSummaryInput(input: { prompt: string; sources: SummarySourceInput[] }): PreparedSummaryInput
  finalizeSummary(input: { content: string; preparedSources: PreparedSummarySource[] }): SummaryCitationResult
  run(input: RunSummaryWithCitationsParams): Promise<SummaryCitationResult>
}

const ALT_BRACKET_NORMALIZERS: Array<[RegExp, string]> = [
  [/【\s*(\d+)\s*】/g, "[$1]"],
  [/［\s*(\d+)\s*］/g, "[$1]"],
  [/\[\s*(\d+)\s*\]/g, "[$1]"]
]
const SPACED_SOURCE_TAG_RE = /\[\s*S\s*(\d+)\s*@\s*([^[\]]+?)\s*\]/gi
const SOURCE_INDEX_ONLY_TAG_RE = /\[\s*S\s*(\d+)\s*\]/gi
const CANONICAL_SOURCE_TAG_RE = /\[(S\d+@([A-Za-z0-9._:-]+))\]/g
const LEGACY_SOURCE_TAG_RE = /\[(\d+)\]/g

function sanitizeText(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function sanitizeLocationKey(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "full"
  )
}

function shortenOpaqueId(value: string | null | undefined): string | null {
  const trimmed = sanitizeText(value)
  if (!trimmed) return null
  return trimmed.length > 18 ? trimmed.slice(0, 12) : trimmed
}

function canonicalSourceRef(source: SummarySourceInput, index: number): string {
  return (
    sanitizeText(source.ref) ??
    sanitizeText(source.docId) ??
    sanitizeText(source.uri) ??
    sanitizeText(source.path) ??
    sanitizeText(source.chunkId) ??
    sanitizeText(source.title) ??
    `source:${index + 1}`
  )
}

function formatRange(prefix: "p" | "l" | "c", start: number, end?: number | null): { key: string; label: string } {
  const noun = prefix === "p" ? "page" : prefix === "l" ? "line" : "char"
  if (end && end !== start) {
    return {
      key: `${prefix}${start}-${end}`,
      label: `${noun}s ${start}-${end}`
    }
  }
  return { key: `${prefix}${start}`, label: `${noun} ${start}` }
}

function normalizeTimestamp(value: string): string {
  return value
    .trim()
    .replace(/[^0-9]+/g, ":")
    .replace(/^:|:$/g, "")
}

function resolveLocation(
  location: SourceLocationRange | null | undefined,
  chunkId?: string | null
): { location: SourceLocationRange | null; key: string; label: string } {
  const normalized = location ?? null
  const label = sanitizeText(normalized?.label)
  if (label) {
    return { location: normalized, key: sanitizeLocationKey(label), label }
  }

  const pageStart = normalized?.pageStart ?? null
  const pageEnd = normalized?.pageEnd ?? null
  if (typeof pageStart === "number") {
    const range = formatRange("p", pageStart, pageEnd)
    return { location: normalized, key: range.key, label: range.label }
  }

  const lineStart = normalized?.lineStart ?? null
  const lineEnd = normalized?.lineEnd ?? null
  if (typeof lineStart === "number") {
    const range = formatRange("l", lineStart, lineEnd)
    return { location: normalized, key: range.key, label: range.label }
  }

  const charStart = normalized?.charStart ?? null
  const charEnd = normalized?.charEnd ?? null
  if (typeof charStart === "number") {
    const range = formatRange("c", charStart, charEnd)
    return { location: normalized, key: range.key, label: range.label }
  }

  const timestampStart = sanitizeText(normalized?.timestampStart)
  if (timestampStart) {
    const normalizedStart = normalizeTimestamp(timestampStart)
    const rawEnd = sanitizeText(normalized?.timestampEnd)
    const normalizedEnd = rawEnd ? normalizeTimestamp(rawEnd) : null
    return {
      location: normalized,
      key: normalizedEnd ? `t${normalizedStart}-${normalizedEnd}` : `t${normalizedStart}`,
      label: rawEnd ? `timestamps ${timestampStart}-${rawEnd}` : `timestamp ${timestampStart}`
    }
  }

  const section = sanitizeText(normalized?.section)
  if (section) {
    return {
      location: normalized,
      key: `sec-${sanitizeLocationKey(section)}`,
      label: `section ${section}`
    }
  }

  const shortenedChunkId = shortenOpaqueId(chunkId)
  if (shortenedChunkId) {
    return {
      location: normalized,
      key: `chunk-${sanitizeLocationKey(shortenedChunkId)}`,
      label: `chunk ${shortenedChunkId}`
    }
  }

  return { location: normalized, key: "full", label: "full source" }
}

function buildLocationTag(sourceIndex: number, locationKey: string, tagPrefix: string): string {
  return `[${tagPrefix}${sourceIndex}@${locationKey}]`
}

function mergeSource(existing: PreparedSummarySource, incoming: SummarySourceInput): PreparedSummarySource {
  const mergedLocation = existing.location ?? incoming.location ?? null
  return {
    ...existing,
    title: existing.title ?? sanitizeText(incoming.title),
    excerpt: incoming.excerpt.length > existing.excerpt.length ? incoming.excerpt : existing.excerpt,
    docId: existing.docId ?? incoming.docId ?? null,
    chunkId: existing.chunkId ?? incoming.chunkId ?? null,
    uri: existing.uri ?? incoming.uri ?? null,
    path: existing.path ?? incoming.path ?? null,
    sourceType: existing.sourceType ?? incoming.sourceType ?? null,
    location: mergedLocation,
    metadata: existing.metadata ?? incoming.metadata
  }
}

export function prepareSummarySources(
  sources: SummarySourceInput[],
  options: Pick<SourceCitationMiddlewareOptions, "tagPrefix"> = {}
): PreparedSummarySource[] {
  const tagPrefix = sanitizeText(options.tagPrefix) ?? "S"
  const dedupeOrder: string[] = []
  const dedupeMap = new Map<string, PreparedSummarySource>()

  for (const [index, source] of sources.entries()) {
    const sourceRef = canonicalSourceRef(source, index)
    const resolvedLocation = resolveLocation(source.location, source.chunkId)
    const dedupeKey = `${sourceRef}|${resolvedLocation.key}`
    const existing = dedupeMap.get(dedupeKey)
    if (existing) {
      dedupeMap.set(dedupeKey, mergeSource(existing, source))
      continue
    }
    dedupeOrder.push(dedupeKey)
    dedupeMap.set(dedupeKey, {
      ...source,
      sourceRef,
      title: sanitizeText(source.title),
      sourceIndex: 0,
      location: resolvedLocation.location,
      locationKey: resolvedLocation.key,
      locationLabel: resolvedLocation.label,
      locationTag: ""
    })
  }

  return dedupeOrder.map((key, index) => {
    const current = dedupeMap.get(key)
    if (!current) {
      throw new Error(`Missing prepared source for key ${key}`)
    }
    const sourceIndex = index + 1
    return {
      ...current,
      sourceIndex,
      locationTag: buildLocationTag(sourceIndex, current.locationKey, tagPrefix)
    }
  })
}

export function buildCitationInstructions(
  preparedSources: PreparedSummarySource[],
  options: Pick<SourceCitationMiddlewareOptions, "citationsRequiredWhenSourcesPresent"> = {}
): string {
  const citationsRequiredWhenSourcesPresent = options.citationsRequiredWhenSourcesPresent ?? true
  const lines = [
    "Use inline source tags for grounded claims.",
    "Only use the exact source tags listed below.",
    "Do not invent, renumber, or rewrite source tags.",
    "If the evidence is insufficient, say so instead of guessing."
  ]
  if (citationsRequiredWhenSourcesPresent && preparedSources.length > 0) {
    lines.push("At least one valid source tag is required in the final summary.")
  }
  if (preparedSources.length > 0) {
    lines.push(`Allowed tags: ${preparedSources.map((source) => source.locationTag).join(", ")}`)
  }
  return lines.join("\n")
}

export function buildSourceCatalog(preparedSources: PreparedSummarySource[]): string {
  return preparedSources
    .map((source) =>
      [
        `${source.locationTag} ${source.title ?? source.sourceRef}`,
        `ref: ${source.sourceRef}`,
        `location: ${source.locationLabel}`,
        source.uri ? `uri: ${source.uri}` : null,
        source.path ? `path: ${source.path}` : null,
        `excerpt: ${source.excerpt}`
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    )
    .join("\n\n")
}

export function buildComposedSummaryPrompt(input: PreparedSummaryInput): string {
  return [
    input.prompt,
    "",
    "Citation rules:",
    input.citationInstructions,
    "",
    "Source catalog:",
    input.sourceCatalog
  ].join("\n")
}

export function normalizeSummaryCitations(content: string, preparedSources: PreparedSummarySource[]): string {
  let normalized = content ?? ""
  for (const [pattern, replacement] of ALT_BRACKET_NORMALIZERS) {
    normalized = normalized.replace(pattern, replacement)
  }
  const sourcesByIndex = new Map(preparedSources.map((source) => [source.sourceIndex, source]))
  normalized = normalized.replace(SPACED_SOURCE_TAG_RE, (_match, rawIndex: string, rawLocationKey: string) => {
    const sourceIndex = Number.parseInt(rawIndex, 10)
    const expected = sourcesByIndex.get(sourceIndex)
    const normalizedKey = sanitizeLocationKey(rawLocationKey)
    if (!expected) return `[S${sourceIndex}@${normalizedKey}]`
    return normalizedKey === expected.locationKey ? expected.locationTag : `[S${sourceIndex}@${normalizedKey}]`
  })
  normalized = normalized.replace(SOURCE_INDEX_ONLY_TAG_RE, (_match, rawIndex: string) => {
    const sourceIndex = Number.parseInt(rawIndex, 10)
    return sourcesByIndex.get(sourceIndex)?.locationTag ?? `[S${sourceIndex}]`
  })
  normalized = normalized.replace(LEGACY_SOURCE_TAG_RE, (_match, rawIndex: string) => {
    const sourceIndex = Number.parseInt(rawIndex, 10)
    return sourcesByIndex.get(sourceIndex)?.locationTag ?? `[${sourceIndex}]`
  })
  return normalized
}

export function extractSourceCitationMatches(
  content: string,
  preparedSources: PreparedSummarySource[]
): {
  matches: SourceCitationMatch[]
  invalidTags: string[]
} {
  const byIndex = new Map(preparedSources.map((source) => [source.sourceIndex, source]))
  const matches: SourceCitationMatch[] = []
  const invalidTags: string[] = []
  for (const match of content.matchAll(CANONICAL_SOURCE_TAG_RE)) {
    const rawTag = match[0]
    const sourceIndex = Number.parseInt(match[1]?.match(/^S(\d+)@/)?.[1] ?? "", 10)
    const locationKey = match[2] ?? ""
    const expected = byIndex.get(sourceIndex)
    if (!expected || expected.locationKey !== locationKey) {
      invalidTags.push(rawTag)
      continue
    }
    matches.push({
      rawTag,
      tag: expected.locationTag,
      sourceIndex,
      locationKey,
      sourceRef: expected.sourceRef
    })
  }
  return { matches, invalidTags }
}

export function validateSummaryCitations(
  content: string,
  preparedSources: PreparedSummarySource[],
  options: Pick<SourceCitationMiddlewareOptions, "citationsRequiredWhenSourcesPresent"> = {}
): SummaryCitationValidation {
  const citationsRequired = (options.citationsRequiredWhenSourcesPresent ?? true) && preparedSources.length > 0
  if (preparedSources.length === 0) {
    return {
      status: "skipped",
      reason: "no_sources",
      message: "Citation validation skipped because no sources were supplied.",
      citationsRequired: false,
      invalidTags: [],
      missingSourceIndices: [],
      citedSourceIndices: [],
      uncitedSourceIndices: []
    }
  }

  const { matches, invalidTags } = extractSourceCitationMatches(content, preparedSources)
  const citedSourceIndices = Array.from(new Set(matches.map((match) => match.sourceIndex))).sort(
    (left, right) => left - right
  )
  const uncitedSourceIndices = preparedSources
    .map((source) => source.sourceIndex)
    .filter((sourceIndex) => !citedSourceIndices.includes(sourceIndex))

  if (matches.length === 0 && citationsRequired) {
    return {
      status: "failed",
      reason: "missing_tags",
      message: "No valid source location tags were found in the summary.",
      citationsRequired,
      invalidTags,
      missingSourceIndices: preparedSources.map((source) => source.sourceIndex),
      citedSourceIndices,
      uncitedSourceIndices
    }
  }

  if (invalidTags.length > 0) {
    return {
      status: "failed",
      reason: "location_mismatch",
      message: "The summary contains source tags that do not match the prepared source locations.",
      citationsRequired,
      invalidTags,
      missingSourceIndices: uncitedSourceIndices,
      citedSourceIndices,
      uncitedSourceIndices
    }
  }

  return {
    status: "ok",
    reason: "valid",
    message: "Inline source location tags were validated against the prepared source catalog.",
    citationsRequired,
    invalidTags: [],
    missingSourceIndices: uncitedSourceIndices,
    citedSourceIndices,
    uncitedSourceIndices
  }
}

export function generateSummaryCitationProvenance(input: {
  preparedSources: PreparedSummarySource[]
  normalizedContent: string
  strict: boolean
  citationsRequired: boolean
  generatedAt?: string
}): SummaryCitationProvenance {
  const { matches } = extractSourceCitationMatches(input.normalizedContent, input.preparedSources)
  const citedSourceIndices = Array.from(new Set(matches.map((match) => match.sourceIndex))).sort(
    (left, right) => left - right
  )
  const uncitedSourceIndices = input.preparedSources
    .map((source) => source.sourceIndex)
    .filter((sourceIndex) => !citedSourceIndices.includes(sourceIndex))

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    strict: input.strict,
    citationsRequired: input.citationsRequired,
    sources: input.preparedSources.map((source) => ({
      sourceIndex: source.sourceIndex,
      sourceRef: source.sourceRef,
      title: source.title,
      locationTag: source.locationTag,
      locationKey: source.locationKey,
      locationLabel: source.locationLabel,
      excerpt: source.excerpt,
      docId: source.docId ?? null,
      chunkId: source.chunkId ?? null,
      uri: source.uri ?? null,
      path: source.path ?? null,
      sourceType: source.sourceType ?? null,
      metadata: source.metadata
    })),
    citations: matches,
    citedSourceIndices,
    uncitedSourceIndices
  }
}

export class SourceCitationValidationError extends Error {
  readonly result: SummaryCitationResult

  constructor(message: string, result: SummaryCitationResult) {
    super(message)
    this.name = "SourceCitationValidationError"
    this.result = result
  }
}

export function createSourceCitationMiddleware(
  options: SourceCitationMiddlewareOptions = {}
): SummaryCitationMiddleware {
  const strict = options.strict ?? true
  const citationsRequiredWhenSourcesPresent = options.citationsRequiredWhenSourcesPresent ?? true
  const tagPrefix = sanitizeText(options.tagPrefix) ?? "S"

  return {
    prepareSummaryInput(input) {
      const preparedSources = prepareSummarySources(input.sources, { tagPrefix })
      const citationInstructions = buildCitationInstructions(preparedSources, {
        citationsRequiredWhenSourcesPresent
      })
      const sourceCatalog = buildSourceCatalog(preparedSources)
      const preparedInput: PreparedSummaryInput = {
        prompt: input.prompt,
        citationInstructions,
        sourceCatalog,
        composedPrompt: "",
        sources: preparedSources
      }
      preparedInput.composedPrompt = buildComposedSummaryPrompt(preparedInput)
      return preparedInput
    },

    finalizeSummary(input) {
      const normalizedContent = normalizeSummaryCitations(input.content, input.preparedSources)
      const validation = validateSummaryCitations(normalizedContent, input.preparedSources, {
        citationsRequiredWhenSourcesPresent
      })
      const provenance = generateSummaryCitationProvenance({
        preparedSources: input.preparedSources,
        normalizedContent,
        strict,
        citationsRequired: validation.citationsRequired
      })
      return {
        content: input.content,
        normalizedContent,
        validation,
        provenance
      }
    },

    async run(input) {
      const prepared = this.prepareSummaryInput({
        prompt: input.prompt,
        sources: input.sources
      })
      const content = await input.generate(prepared)
      const result = this.finalizeSummary({
        content,
        preparedSources: prepared.sources
      })
      if (strict && result.validation.status === "failed") {
        throw new SourceCitationValidationError(result.validation.message, result)
      }
      return result
    }
  }
}

export async function runSummaryWithSourceCitations(
  input: RunSummaryWithCitationsParams,
  options: SourceCitationMiddlewareOptions = {}
): Promise<SummaryCitationResult> {
  const middleware = createSourceCitationMiddleware(options)
  return middleware.run(input)
}
