import type {
  RagProcessorMetadata,
  RagProcessorService,
  SemanticChunk,
  SemanticChunkingRequest,
  SemanticChunkingResult,
  TextSegment
} from "./types.js"

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n")
}

function cosineSimilarity(left: number[], right: number[]): number | null {
  if (left.length === 0 || left.length !== right.length) return null
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }

  if (leftNorm <= 0 || rightNorm <= 0) return null
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function splitSentenceOffsets(text: string, startOffset: number): TextSegment[] {
  const segments: TextSegment[] = []
  let sentenceStart = 0
  let segmentIndex = 0

  const flush = (endExclusive: number): void => {
    const raw = text.slice(sentenceStart, endExclusive)
    if (!raw.trim()) {
      sentenceStart = endExclusive
      return
    }
    const leadingTrim = raw.length - raw.trimStart().length
    const trailingTrim = raw.length - raw.trimEnd().length
    const start = startOffset + sentenceStart + leadingTrim
    const end = startOffset + endExclusive - trailingTrim
    const content = text.slice(start - startOffset, end - startOffset)
    segments.push({
      index: segmentIndex,
      text: content,
      startOffset: start,
      endOffset: end
    })
    segmentIndex += 1
    sentenceStart = endExclusive
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1] ?? ""
    if ((char === "." || char === "!" || char === "?") && (!next || /\s/.test(next))) {
      flush(index + 1)
    }
  }

  if (sentenceStart < text.length) {
    flush(text.length)
  }

  return segments
}

function hardWrapSegment(segment: TextSegment, maxSegmentCharacters: number): TextSegment[] {
  if (segment.text.length <= maxSegmentCharacters) {
    return [segment]
  }

  const wrapped: TextSegment[] = []
  let relativeStart = 0
  let wrappedIndex = 0

  while (relativeStart < segment.text.length) {
    const remaining = segment.text.length - relativeStart
    if (remaining <= maxSegmentCharacters) {
      wrapped.push({
        index: segment.index + wrappedIndex,
        text: segment.text.slice(relativeStart),
        startOffset: segment.startOffset + relativeStart,
        endOffset: segment.endOffset
      })
      break
    }

    let splitAt = segment.text.lastIndexOf(" ", relativeStart + maxSegmentCharacters)
    if (splitAt <= relativeStart) {
      splitAt = relativeStart + maxSegmentCharacters
    }
    const chunkText = segment.text.slice(relativeStart, splitAt).trim()
    wrapped.push({
      index: segment.index + wrappedIndex,
      text: chunkText,
      startOffset: segment.startOffset + relativeStart,
      endOffset: segment.startOffset + splitAt
    })
    relativeStart = splitAt
    while (segment.text[relativeStart] === " ") {
      relativeStart += 1
    }
    wrappedIndex += 1
  }

  return wrapped
}

function splitIntoSegments(text: string, maxSegmentCharacters: number): TextSegment[] {
  const paragraphs: Array<{ text: string; startOffset: number }> = []
  const paragraphMatcher = /\n{2,}/g
  let cursor = 0

  for (const match of text.matchAll(paragraphMatcher)) {
    const matchIndex = match.index ?? 0
    const paragraph = text.slice(cursor, matchIndex)
    if (paragraph.trim()) {
      paragraphs.push({ text: paragraph, startOffset: cursor })
    }
    cursor = matchIndex + match[0].length
  }

  const trailing = text.slice(cursor)
  if (trailing.trim()) {
    paragraphs.push({ text: trailing, startOffset: cursor })
  }

  const baseSegments = paragraphs.flatMap((paragraph) => splitSentenceOffsets(paragraph.text, paragraph.startOffset))
  const wrappedSegments = baseSegments.flatMap((segment) => hardWrapSegment(segment, maxSegmentCharacters))

  return wrappedSegments.map((segment, index) => ({
    ...segment,
    index
  }))
}

function overlapStartIndex(segments: TextSegment[], coreStartIndex: number, overlapCharacters: number): number {
  if (coreStartIndex <= 0 || overlapCharacters <= 0) {
    return coreStartIndex
  }

  let accumulated = 0
  let index = coreStartIndex - 1
  while (index >= 0) {
    accumulated += segments[index]!.text.length
    if (accumulated >= overlapCharacters) {
      return index
    }
    index -= 1
  }
  return 0
}

function buildChunk(
  text: string,
  segments: TextSegment[],
  chunkIndex: number,
  overlapStart: number,
  coreStart: number,
  end: number,
  baseMetadata: RagProcessorMetadata
): SemanticChunk {
  const startOffset = segments[overlapStart]!.startOffset
  const endOffset = segments[end]!.endOffset
  const overlapFromPreviousCharacters = coreStart > overlapStart ? segments[coreStart]!.startOffset - startOffset : 0

  return {
    chunkIndex,
    text: text.slice(startOffset, endOffset).trim(),
    characterCount: endOffset - startOffset,
    startOffset,
    endOffset,
    segmentIndices: segments.slice(overlapStart, end + 1).map((segment) => segment.index),
    overlapFromPreviousCharacters,
    metadata: {
      ...baseMetadata,
      coreStartSegmentIndex: coreStart,
      coreEndSegmentIndex: end
    }
  }
}

export async function chunkTextSemantically(request: SemanticChunkingRequest): Promise<SemanticChunkingResult> {
  const text = normalizeLineEndings(request.text).trim()
  if (!text) {
    return {
      chunks: [],
      segmentCount: 0,
      usedEmbeddings: false
    }
  }

  const maxChunkCharacters = Math.max(200, request.maxChunkCharacters ?? 1400)
  const targetChunkCharacters = Math.min(
    maxChunkCharacters,
    Math.max(120, request.targetChunkCharacters ?? Math.round(maxChunkCharacters * 0.75))
  )
  const minChunkCharacters = Math.min(
    maxChunkCharacters,
    Math.max(80, request.minChunkCharacters ?? Math.round(maxChunkCharacters * 0.2))
  )
  const overlapCharacters = Math.max(0, request.overlapCharacters ?? 200)
  const similarityThreshold = request.similarityThreshold ?? 0.78
  const segments = splitIntoSegments(text, Math.max(180, Math.floor(maxChunkCharacters / 2)))
  const usedEmbeddings = Boolean(request.embeddings)
  const vectors = request.embeddings ? await request.embeddings.embed(segments.map((segment) => segment.text)) : null
  const baseMetadata = request.metadata ?? {}
  const chunks: SemanticChunk[] = []

  let cursor = 0
  while (cursor < segments.length) {
    const overlapStart = overlapStartIndex(segments, cursor, overlapCharacters)
    let end = cursor

    while (end + 1 < segments.length) {
      const next = end + 1
      const startOffset = segments[overlapStart]!.startOffset
      const proposedEndOffset = segments[next]!.endOffset
      const proposedChunkCharacters = proposedEndOffset - startOffset
      const proposedCoreCharacters = proposedEndOffset - segments[cursor]!.startOffset
      const similarity = vectors ? cosineSimilarity(vectors[end] ?? [], vectors[next] ?? []) : null
      const lowSemanticAffinity = similarity !== null && similarity < similarityThreshold

      if (proposedChunkCharacters > maxChunkCharacters) {
        break
      }

      if (
        proposedCoreCharacters >= targetChunkCharacters &&
        (lowSemanticAffinity || proposedCoreCharacters >= maxChunkCharacters)
      ) {
        break
      }

      end = next

      if (
        proposedCoreCharacters >= maxChunkCharacters ||
        (proposedCoreCharacters >= minChunkCharacters && lowSemanticAffinity)
      ) {
        break
      }
    }

    chunks.push(buildChunk(text, segments, chunks.length, overlapStart, cursor, end, baseMetadata))
    cursor = end + 1
  }

  return {
    chunks,
    segmentCount: segments.length,
    usedEmbeddings
  }
}

export const semanticVectorChunkingService: RagProcessorService<SemanticChunkingRequest, SemanticChunkingResult> =
  Object.freeze({
    processorId: "semantic_vector_chunking",
    execute(request: SemanticChunkingRequest) {
      return chunkTextSemantically(request)
    }
  })
