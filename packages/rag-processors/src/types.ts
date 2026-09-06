export type RagProcessorId = "semantic_vector_chunking" | "pdf_layout_analysis" | "dense_text_extraction"

export type RagProcessorMetadata = Record<string, string | number | boolean | null>

export interface RagProcessorService<TRequest, TResult> {
  readonly processorId: RagProcessorId
  execute(request: TRequest): Promise<TResult>
}

export interface DenseTextPage {
  pageNumber: number
  text: string
}

export interface DenseTextExtractionWarning {
  code: string
  message: string
}

export type DenseTextSource =
  | {
      kind: "text"
      text: string
      fileName?: string | undefined
      pageBreakPattern?: RegExp | undefined
    }
  | {
      kind: "docx"
      bytes: Uint8Array
      fileName?: string | undefined
    }
  | {
      kind: "pdf_pages"
      pages: DenseTextPage[]
      fileName?: string | undefined
    }

export interface DenseTextExtractionRequest {
  source: DenseTextSource
  trimWhitespace?: boolean | undefined
}

export interface DenseTextExtractionResult {
  sourceKind: DenseTextSource["kind"]
  text: string
  pages: DenseTextPage[]
  characterCount: number
  warnings: DenseTextExtractionWarning[]
}

export interface PdfLayoutTable {
  rows: string[][]
}

export interface PdfLayoutPageInput {
  pageNumber: number
  text: string
  tables?: PdfLayoutTable[] | undefined
}

export interface PdfLayoutHeaderFieldPattern {
  field: string
  aliases: string[]
}

export interface PdfLayoutAnalysisRequest {
  pages: PdfLayoutPageInput[]
  maxScanPages?: number | undefined
  minimumDetectedSections?: number | undefined
  tocHeadingPatterns?: RegExp[] | undefined
  tocColumnHints?: string[] | undefined
  headerFieldPatterns?: PdfLayoutHeaderFieldPattern[] | undefined
}

export interface PdfLayoutSection {
  sectionId: string
  ordinal: number
  title: string
  pageStart: number
  pageEnd: number
  pageCount: number
  dateText?: string | undefined
  documentNumber?: string | undefined
  rawCells: string[]
  inferredFrom: "table"
}

export interface PdfLayoutAnalysisResult {
  layoutKind: "single_document" | "multi_section"
  tocDetected: boolean
  tocStartPage: number | null
  sections: PdfLayoutSection[]
  headerFields: Record<string, string>
  firstPageText: string
  scannedPages: number
  signals: string[]
}

export interface TextSegment {
  index: number
  text: string
  startOffset: number
  endOffset: number
}

export interface TextEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
}

export interface SemanticChunkingRequest {
  text: string
  maxChunkCharacters?: number | undefined
  targetChunkCharacters?: number | undefined
  minChunkCharacters?: number | undefined
  overlapCharacters?: number | undefined
  similarityThreshold?: number | undefined
  embeddings?: TextEmbeddingProvider | undefined
  metadata?: RagProcessorMetadata | undefined
}

export interface SemanticChunk {
  chunkIndex: number
  text: string
  characterCount: number
  startOffset: number
  endOffset: number
  segmentIndices: number[]
  overlapFromPreviousCharacters: number
  metadata: RagProcessorMetadata
}

export interface SemanticChunkingResult {
  chunks: SemanticChunk[]
  segmentCount: number
  usedEmbeddings: boolean
}
