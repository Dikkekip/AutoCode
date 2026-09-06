import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AuditWriter } from "@openclaw/audit-runtime"
import type { DispatcherStore } from "@openclaw/db"
import {
  type Agent,
  deriveMemoryLifecycleStatus,
  detectRepoContext,
  type MemoryAudience,
  type MemoryChunk,
  type MemoryImportance,
  type MemoryLayer,
  type MemoryProvenance,
  type MemoryRetentionPolicy,
  type Project,
  type RetrievedMemoryChunk,
  type Run,
  type RunEvent,
  type Task
} from "@openclaw/domain"
import {
  type RetrievalCandidate,
  type RetrievalEvaluationDataset,
  type RetrievalEvaluationReport,
  type RetrievalEvaluationThresholds,
  runRetrievalEvaluation as runDatasetEvaluation
} from "@openclaw/evaluation"
import { buildCompactionSummary, defaultCompactionPolicy, isExpired, selectCompactionCandidates } from "./compaction.js"
import { normalizeMemoryRecord } from "./record.js"
import { checkMemorySafety } from "./safety.js"

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
const REPO_CHUNK_SIZE = 1200
const REPO_CHUNK_OVERLAP = 200
const MAX_RESULTS = 6
const MAX_REPO_DOC_RESULTS = 3
const MAX_RUN_RESULTS = 3

export interface MemoryCompactionPolicy {
  enabled: boolean
  maxChunks: number
  maxContentChars: number
  keepRecent: number
  minimumAgeHours: number
}

export interface MemoryRecordInput {
  projectId: string
  layer: MemoryLayer
  sourceKind: MemoryChunk["sourceKind"]
  sourceRef: string
  sourcePath?: string | null
  audience: MemoryAudience
  title: string
  content: string
  metadata?: Record<string, unknown>
  lifecycleStatus?: MemoryChunk["lifecycleStatus"]
  freshnessScore?: number | null
  expiresAt?: string | null
  compactedAt?: string | null
  supersededByChunkId?: string | null
  provenance: MemoryProvenance
  retention: MemoryRetentionPolicy
}

export interface MemoryCompactionResult {
  summaryChunk: MemoryChunk | null
  compactedChunkIds: string[]
  skippedChunkIds: string[]
}

type RepoDocCandidate = {
  audience: Extract<MemoryAudience, "shared" | "codex" | "gemini" | "project">
  path: string
  reason: string
}

type ChunkedDocument = {
  title: string
  heading: string | null
  content: string
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function trimExcerpt(value: string, maxLength: number): string {
  const normalized = normalizeWhitespace(value)
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function chunkByWindow(text: string, title: string, heading: string | null): ChunkedDocument[] {
  const normalized = normalizeWhitespace(text)
  if (!normalized) return []

  const chunks: ChunkedDocument[] = []
  let start = 0
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + REPO_CHUNK_SIZE)
    chunks.push({
      title: chunks.length === 0 ? title : `${title} (part ${chunks.length + 1})`,
      heading,
      content: normalized.slice(start, end).trim()
    })
    if (end >= normalized.length) break
    start = Math.max(end - REPO_CHUNK_OVERLAP, start + 1)
  }
  return chunks.filter((chunk) => chunk.content.length > 0)
}

function chunkMarkdown(text: string, baseTitle: string): ChunkedDocument[] {
  const lines = text.replace(/\r/g, "").split("\n")
  const sections: Array<{ heading: string | null; content: string }> = []
  let heading: string | null = null
  let buffer: string[] = []

  function pushSection(): void {
    const content = normalizeWhitespace(buffer.join("\n"))
    if (content) sections.push({ heading, content })
    buffer = []
  }

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      pushSection()
      heading = line.replace(/^#{1,6}\s+/, "").trim()
      buffer.push(line)
      continue
    }
    buffer.push(line)
  }
  pushSection()

  if (sections.length <= 1) return chunkByWindow(text, baseTitle, null)

  const chunks: ChunkedDocument[] = []
  for (const section of sections) {
    const title = section.heading ? `${baseTitle} - ${section.heading}` : baseTitle
    chunks.push(...chunkByWindow(section.content, title, section.heading))
  }
  return chunks
}

function chunkDocument(path: string, text: string): ChunkedDocument[] {
  if (path.endsWith(".md") || /^#{1,6}\s+/m.test(text)) return chunkMarkdown(text, path)
  return chunkByWindow(text, path, null)
}

function adapterAudience(agent: Agent): Extract<MemoryAudience, "codex" | "gemini" | "project"> {
  if (agent.adapterType === "gemini_local") return "gemini"
  if (agent.adapterType === "azure_foundry") return "project"
  return "codex"
}

function repoSourceRef(audience: RepoDocCandidate["audience"], path: string, index: number): string {
  return `repo:${audience}:${path}#${index}`
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
    )
  )
}

function cosineSimilarity(left: number[], right: number[]): number | null {
  if (left.length === 0 || left.length !== right.length) return null
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return null
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}

function scoreKeywords(queryTokens: string[], chunk: MemoryChunk): number {
  if (queryTokens.length === 0) return 0
  const haystack = [
    chunk.title,
    chunk.sourcePath ?? "",
    chunk.content,
    ...(Array.isArray(chunk.metadata.labels) ? chunk.metadata.labels.map(String) : []),
    ...(Array.isArray(chunk.metadata.changedFiles) ? chunk.metadata.changedFiles.map(String) : []),
    ...(chunk.provenance.tags ?? [])
  ].join(" ")
  const chunkTokens = new Set(tokenize(haystack))
  let overlap = 0
  for (const token of queryTokens) {
    if (chunkTokens.has(token)) overlap += 1
  }
  return overlap / queryTokens.length
}

function buildRunSummary(task: Task, run: Run, events: RunEvent[]): string {
  const curatedEvents = events
    .filter((event) => event.level !== "info" || event.message.startsWith("Task package attached") === false)
    .slice(-4)
    .map((event) => `- [${event.level}] ${event.message}`)

  const parts = [
    `Task: ${task.title}`,
    `Description: ${task.description ?? "No description provided."}`,
    `Labels: ${task.labels.join(", ") || "none"}`,
    `Changed files: ${task.changedFiles.join(", ") || "none"}`,
    `Run status: ${run.status}`,
    `Verification summary: ${run.verificationSummary ?? "none"}`,
    `Error: ${run.errorText ?? "none"}`,
    `Response: ${run.responseText ?? "none"}`
  ]

  if (curatedEvents.length > 0) {
    parts.push("Events:")
    parts.push(...curatedEvents)
  }

  return parts.join("\n")
}

function defaultRetention(importance: MemoryImportance = "normal"): MemoryRetentionPolicy {
  return {
    preserveDecisionTrace: importance === "critical" || importance === "high",
    preserveRaw: true,
    pinned: false,
    importance,
    retainUntil: null
  }
}

export class MemoryRuntime {
  constructor(private readonly store: DispatcherStore) {}

  private embeddingBaseUrl(): string {
    const configured = process.env.EMBEDDING_OPENAI_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim()
    return (configured && configured.length > 0 ? configured : DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "")
  }

  private embeddingProvider(): string {
    const baseUrl = this.embeddingBaseUrl()
    if (baseUrl.includes("cognitiveservices.azure.com")) return "azure-openai"
    return baseUrl === DEFAULT_OPENAI_BASE_URL ? "openai" : `openai-compatible:${baseUrl}`
  }

  private embeddingModel(): string {
    return (
      process.env.EMBEDDING_OPENAI_MODEL?.trim() ||
      process.env.EMBEDDING_OPENAI_EMBEDDING_MODEL?.trim() ||
      process.env.OPENAI_EMBEDDING_MODEL?.trim() ||
      DEFAULT_EMBEDDING_MODEL
    )
  }

  private embeddingApiKey(): string | null {
    const key =
      process.env.EMBEDDING_OPENAI_API_KEY?.trim() ||
      process.env.EMBEDDING_AZURE_OPENAI_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.AZURE_OPENAI_API_KEY?.trim()
    return key ? key : null
  }

  private async embedText(text: string): Promise<number[] | null> {
    const apiKey = this.embeddingApiKey()
    if (!apiKey) return null

    const response = await fetch(`${this.embeddingBaseUrl()}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: this.embeddingModel(),
        input: text
      })
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Embedding request failed: ${response.status} ${detail}`)
    }

    const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
    const vector = payload.data?.[0]?.embedding
    return Array.isArray(vector) ? vector : null
  }

  private async refreshEmbedding(chunk: MemoryChunk): Promise<void> {
    const provider = this.embeddingProvider()
    const model = this.embeddingModel()

    if (!this.embeddingApiKey()) {
      this.store.deleteMemoryEmbedding(chunk.id, provider, model)
      return
    }

    try {
      const vector = await this.embedText(chunk.content)
      if (!vector || vector.length === 0) {
        this.store.deleteMemoryEmbedding(chunk.id, provider, model)
        return
      }
      this.store.upsertMemoryEmbedding({
        chunkId: chunk.id,
        provider,
        model,
        dimensions: vector.length,
        vector
      })
    } catch {
      this.store.deleteMemoryEmbedding(chunk.id, provider, model)
      throw new Error(`Failed to refresh embedding for memory chunk ${chunk.id}.`)
    }
  }

  async recordMemory(input: MemoryRecordInput): Promise<MemoryChunk> {
    const safety = checkMemorySafety(input.content, input.title)
    if (!safety.allowed) {
      try {
        const project = this.store.getProjectById(input.projectId)
        const auditLogPath = join(project.repoPath, ".openclaw/audit.log")
        const auditWriter = new AuditWriter(auditLogPath)
        auditWriter.append("memory-governed-reject", {
          projectId: input.projectId,
          layer: input.layer,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef,
          title: input.title,
          reason: safety.reason
        })
      } catch (err) {
        // Ignored
      }
      throw new Error(safety.reason)
    }

    const normalized = normalizeMemoryRecord(input)
    const record = this.store.upsertMemoryChunk({
      projectId: input.projectId,
      layer: input.layer,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      sourcePath: input.sourcePath ?? null,
      audience: input.audience,
      lifecycleStatus: input.lifecycleStatus ?? "ready",
      title: input.title,
      content: normalized.content,
      contentHash: normalized.contentHash,
      freshnessScore: normalized.freshnessScore,
      expiresAt: normalized.expiresAt,
      compactedAt: input.compactedAt ?? null,
      supersededByChunkId: input.supersededByChunkId ?? null,
      provenance: normalized.provenance,
      retention: normalized.retention,
      metadata: normalized.metadata
    })

    if (record.changed) {
      await this.refreshEmbedding(record.chunk).catch(() => undefined)
      try {
        const project = this.store.getProjectById(input.projectId)
        const auditLogPath = join(project.repoPath, ".openclaw/audit.log")
        const auditWriter = new AuditWriter(auditLogPath)
        auditWriter.append("memory-governed-write", {
          projectId: input.projectId,
          chunkId: record.chunk.id,
          layer: input.layer,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef,
          title: input.title
        })
      } catch (err) {
        // Ignored
      }
    }
    return record.chunk
  }

  async syncProjectMemory(project: Project, agent: Agent): Promise<void> {
    await this.upsertRepoMemory(project, agent)
  }

  async upsertRepoMemory(project: Project, agent: Agent): Promise<void> {
    const repoContext = detectRepoContext(project.repoPath, project.verifyCommand)
    const audience = adapterAudience(agent)
    const adapterReadItems =
      audience === "codex"
        ? repoContext.codexReadItems
        : audience === "gemini"
          ? repoContext.geminiReadItems
          : [...repoContext.codexReadItems, ...repoContext.geminiReadItems]
    const now = new Date().toISOString()
    const candidates: RepoDocCandidate[] = [
      ...repoContext.sharedReadItems.map((item) => ({ audience: "shared" as const, ...item })),
      ...adapterReadItems.map((item) => ({
        audience,
        ...item
      }))
    ]

    const deduped = new Map<string, RepoDocCandidate>()
    for (const candidate of candidates) deduped.set(`${candidate.audience}:${candidate.path}`, candidate)

    const expectedRefs = new Set<string>()
    for (const candidate of deduped.values()) {
      const absolutePath = `${project.repoPath}/${candidate.path}`
      if (!existsSync(absolutePath)) continue

      const contents = readFileSync(absolutePath, "utf8")
      const chunks = chunkDocument(candidate.path, contents)
      for (const [index, chunk] of chunks.entries()) {
        const sourceRef = repoSourceRef(candidate.audience, candidate.path, index)
        expectedRefs.add(sourceRef)
        const contentHash = sha256(normalizeWhitespace(chunk.content))
        const existing = this.store.findMemoryChunk(project.id, "repo_doc", sourceRef)
        const provenance =
          existing?.contentHash === contentHash
            ? existing.provenance
            : {
                sources: [{ kind: "file" as const, ref: sourceRef, path: candidate.path, capturedAt: now }],
                freshness: { recordedAt: now, observedAt: now, score: 1 },
                derivation: { kind: "import" as const, sourceChunkIds: [], summaryOfSourceRefs: [candidate.path] },
                tags: [candidate.reason]
              }

        try {
          await this.recordMemory({
            projectId: project.id,
            layer: "repo_docs",
            sourceKind: "repo_doc",
            sourceRef,
            sourcePath: candidate.path,
            audience: candidate.audience,
            title: chunk.title,
            content: chunk.content,
            freshnessScore: 1,
            provenance,
            retention: defaultRetention("normal"),
            metadata: {
              path: candidate.path,
              reason: candidate.reason,
              heading: chunk.heading,
              chunkIndex: index
            }
          })
        } catch (error) {
          expectedRefs.delete(sourceRef)
          console.warn(
            `[Memory Sync] Skipped chunk from ${candidate.path} due to safety rejection: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    const existing = this.store.listMemoryChunks(project.id, ["shared", audience], ["repo_doc"])
    const staleRefs = existing.map((chunk) => chunk.sourceRef).filter((sourceRef) => !expectedRefs.has(sourceRef))
    this.store.deleteMemoryChunksForSource(project.id, "repo_doc", staleRefs)

    if (staleRefs.length > 0) {
      try {
        const auditLogPath = join(project.repoPath, ".openclaw/audit.log")
        const auditWriter = new AuditWriter(auditLogPath)
        for (const ref of staleRefs) {
          auditWriter.append("memory-governed-delete", {
            projectId: project.id,
            sourceKind: "repo_doc",
            sourceRef: ref
          })
        }
      } catch (err) {
        // Ignored
      }
    }
  }

  async recordRunMemory(task: Task, run: Run): Promise<void> {
    const now = new Date().toISOString()
    const summary = buildRunSummary(task, run, this.store.getRunEvents(run.id))
    await this.recordMemory({
      projectId: task.projectId,
      layer: "run_summaries",
      sourceKind: "run_summary",
      sourceRef: `run:${run.id}`,
      audience: "project",
      title: `Run memory: ${task.title}`,
      content: summary,
      freshnessScore: run.status === "failed" ? 0.6 : 0.9,
      provenance: {
        sources: [{ kind: "run", ref: run.id, capturedAt: now }],
        freshness: {
          recordedAt: now,
          observedAt: run.finishedAt ?? run.updatedAt,
          score: run.status === "failed" ? 0.6 : 0.9
        },
        derivation: null,
        tags: task.labels
      },
      retention: {
        ...defaultRetention(run.status === "failed" ? "high" : "normal"),
        preserveDecisionTrace: run.status !== "succeeded"
      },
      metadata: {
        taskId: task.id,
        runId: run.id,
        labels: task.labels,
        changedFiles: task.changedFiles,
        runStatus: run.status,
        adapterType: run.adapterType
      }
    })
  }

  async retrieveRelevantMemory(task: Task, agent: Agent, project: Project): Promise<RetrievedMemoryChunk[]> {
    const audience = adapterAudience(agent)
    const chunks = this.store
      .listMemoryChunks(project.id, ["project", "shared", audience])
      .filter((chunk) => !isExpired(chunk))
      .filter((chunk) => !chunk.supersededByChunkId || chunk.retention.preserveRaw)
    if (chunks.length === 0) return []

    const query = [
      task.title,
      task.description ?? "",
      task.labels.join(" "),
      task.changedFiles.join(" "),
      task.stage ?? "",
      task.lastError ?? ""
    ].join("\n")
    const queryTokens = tokenize(query)

    let similarityByChunkId = new Map<string, number>()
    try {
      const queryVector = await this.embedText(query)
      if (queryVector) {
        const embeddings = this.store.listMemoryEmbeddings(
          chunks.map((chunk) => chunk.id),
          this.embeddingProvider(),
          this.embeddingModel()
        )
        for (const embedding of embeddings) {
          const similarity = cosineSimilarity(queryVector, embedding.vector)
          if (similarity !== null) similarityByChunkId.set(embedding.chunkId, similarity)
        }
      }
    } catch {
      similarityByChunkId = new Map<string, number>()
    }

    const ranked = chunks
      .map((chunk) => ({
        chunk,
        similarity: similarityByChunkId.get(chunk.id) ?? null,
        keywordScore: scoreKeywords(queryTokens, chunk),
        freshnessScore: chunk.freshnessScore
      }))
      .filter((entry) => entry.keywordScore > 0 || entry.similarity !== null)
      .sort((left, right) => {
        if (right.keywordScore !== left.keywordScore) return right.keywordScore - left.keywordScore
        const rightSimilarity = right.similarity ?? Number.NEGATIVE_INFINITY
        const leftSimilarity = left.similarity ?? Number.NEGATIVE_INFINITY
        if (rightSimilarity !== leftSimilarity) return rightSimilarity - leftSimilarity
        const rightFreshness = right.freshnessScore ?? Number.NEGATIVE_INFINITY
        const leftFreshness = left.freshnessScore ?? Number.NEGATIVE_INFINITY
        if (rightFreshness !== leftFreshness) return rightFreshness - leftFreshness
        return right.chunk.updatedAt.localeCompare(left.chunk.updatedAt)
      })

    const selected: RetrievedMemoryChunk[] = []
    let repoDocCount = 0
    let runSummaryCount = 0
    for (const candidate of ranked) {
      if (candidate.chunk.sourceKind === "repo_doc") {
        if (repoDocCount >= MAX_REPO_DOC_RESULTS) continue
        repoDocCount += 1
      } else if (candidate.chunk.sourceKind === "run_summary" || candidate.chunk.sourceKind === "memory_summary") {
        if (runSummaryCount >= MAX_RUN_RESULTS) continue
        runSummaryCount += 1
      }
      selected.push(candidate)
      if (selected.length >= MAX_RESULTS) break
    }

    return selected
  }

  formatPromptMemory(items: RetrievedMemoryChunk[]): string | null {
    if (items.length === 0) return null
    const lines = ["Relevant memory:"]
    for (const item of items) {
      const label =
        item.chunk.sourceKind === "repo_doc" ? `${item.chunk.sourcePath ?? item.chunk.title}` : item.chunk.title
      const sourceRefs = item.chunk.provenance.sources.map((source) => source.ref).join(", ")
      lines.push(
        `- [${item.chunk.sourceKind}] ${label}: ${trimExcerpt(item.chunk.content, 280)}${sourceRefs ? ` (sources: ${sourceRefs})` : ""}`
      )
    }
    return lines.join("\n")
  }

  async compactProjectMemory(
    projectId: string,
    policy: Partial<MemoryCompactionPolicy> = {}
  ): Promise<MemoryCompactionResult> {
    const resolved = { ...defaultCompactionPolicy(), ...policy }
    const chunks = this.store
      .listMemoryChunks(projectId)
      .filter((chunk) => !isExpired(chunk))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const { candidates, skipped } = selectCompactionCandidates(chunks, resolved)
    if (candidates.length === 0) {
      return { summaryChunk: null, compactedChunkIds: [], skippedChunkIds: skipped.map((chunk) => chunk.id) }
    }

    const now = new Date().toISOString()
    const summary = buildCompactionSummary(candidates)
    const summarySourceRef = `summary:${projectId}:${sha256(candidates.map((chunk) => chunk.id).join(","))}`
    const summaryChunk = await this.recordMemory({
      projectId,
      layer: "run_summaries",
      sourceKind: "memory_summary",
      sourceRef: summarySourceRef,
      audience: "project",
      title: summary.title,
      content: summary.content,
      freshnessScore: 0.5,
      provenance: {
        sources: candidates.map((chunk) => ({ kind: "memory_chunk", ref: chunk.sourceRef, capturedAt: now })),
        freshness: { recordedAt: now, observedAt: now, score: 0.5 },
        derivation: {
          kind: "compaction",
          sourceChunkIds: candidates.map((chunk) => chunk.id),
          summaryOfSourceRefs: candidates.map((chunk) => chunk.sourceRef)
        },
        tags: ["compaction", "portable-summary"]
      },
      retention: {
        preserveDecisionTrace: true,
        preserveRaw: true,
        pinned: false,
        importance: "high",
        retainUntil: null
      },
      metadata: {
        compactedChunkCount: candidates.length
      }
    })

    for (const chunk of candidates) {
      await this.recordMemory({
        projectId: chunk.projectId,
        layer: chunk.layer,
        sourceKind: chunk.sourceKind,
        sourceRef: chunk.sourceRef,
        sourcePath: chunk.sourcePath,
        audience: chunk.audience,
        title: chunk.title,
        content: chunk.content,
        metadata: chunk.metadata,
        lifecycleStatus: "compacted",
        freshnessScore: chunk.freshnessScore,
        expiresAt: chunk.expiresAt,
        compactedAt: now,
        supersededByChunkId: summaryChunk.id,
        provenance: {
          ...chunk.provenance,
          derivation: {
            kind: "compaction",
            sourceChunkIds: [chunk.id],
            summaryOfSourceRefs: [summaryChunk.sourceRef],
            notes: "Compacted into summary chunk."
          }
        },
        retention: {
          ...chunk.retention,
          preserveRaw: false
        }
      })
    }

    return {
      summaryChunk,
      compactedChunkIds: candidates.map((chunk) => chunk.id),
      skippedChunkIds: skipped.map((chunk) => chunk.id)
    }
  }

  async evaluateRetrieval(
    dataset: RetrievalEvaluationDataset,
    thresholds: RetrievalEvaluationThresholds,
    retrieve: (item: {
      query: string
      expectedSourceRefs: string[]
      metadata: Record<string, unknown>
    }) => Promise<RetrievalCandidate[]>,
    options?: { projectId?: string }
  ): Promise<RetrievalEvaluationReport> {
    const report = await runDatasetEvaluation(dataset, thresholds, async (item) =>
      retrieve({
        query: item.query,
        expectedSourceRefs: item.expectedSourceRefs,
        metadata: item.metadata
      })
    )

    if (options?.projectId) {
      const now = new Date().toISOString()
      await this.recordMemory({
        projectId: options.projectId,
        layer: "retrieval_eval_reports",
        sourceKind: "eval_report",
        sourceRef: `eval:${dataset.manifest.datasetVersion}:${report.generatedAt}`,
        audience: "shared",
        title: `Retrieval eval ${dataset.manifest.datasetVersion}`,
        content: JSON.stringify(report.summary, null, 2),
        freshnessScore: 0.8,
        provenance: {
          sources: [{ kind: "dataset", ref: dataset.manifest.datasetVersion, capturedAt: now }],
          freshness: { recordedAt: now, observedAt: now, score: 0.8 },
          derivation: {
            kind: "evaluation",
            sourceChunkIds: [],
            summaryOfSourceRefs: [dataset.manifest.datasetVersion]
          },
          tags: ["retrieval-eval", report.summary.pass ? "pass" : "fail"]
        },
        retention: {
          preserveDecisionTrace: true,
          preserveRaw: true,
          pinned: !report.summary.pass,
          importance: report.summary.pass ? "normal" : "high",
          retainUntil: null
        },
        metadata: {
          report
        }
      })
    }

    return report
  }
}

export class MemoryService extends MemoryRuntime {}

export class LayeredMemoryRuntime {
  private readonly memory: MemoryRuntime

  constructor(private readonly store: DispatcherStore) {
    this.memory = new MemoryRuntime(store)
  }

  async syncProjectMemory(project: Project, agent: Agent): Promise<void> {
    await this.memory.syncProjectMemory(project, agent)
  }

  async retrieve(task: Task, agent: Agent, project: Project): Promise<string | null> {
    const chunks = await this.memory.retrieveRelevantMemory(task, agent, project)
    return this.memory.formatPromptMemory(chunks)
  }

  classifyAudience(layer: MemoryLayer): MemoryAudience {
    switch (layer) {
      case "run_history":
        return "project"
      case "repo_docs":
      case "portable_skills":
      case "run_summaries":
      case "retrieval_eval_reports":
      case "shared_decisions":
      default:
        return "shared"
    }
  }

  compactContent(content: string, maxChars = 1200): string {
    const normalized = content
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    if (normalized.length <= maxChars) return normalized
    return `${normalized.slice(0, maxChars - 1).trimEnd()}…`
  }

  get service(): MemoryRuntime {
    return this.memory
  }
}

export { checkMemorySafety } from "./safety.js"
