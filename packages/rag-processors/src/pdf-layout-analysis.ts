import type {
  PdfLayoutAnalysisRequest,
  PdfLayoutAnalysisResult,
  PdfLayoutHeaderFieldPattern,
  PdfLayoutPageInput,
  PdfLayoutSection,
  PdfLayoutTable,
  RagProcessorService
} from "./types.js"

const DEFAULT_TOC_HEADING_PATTERNS = [/\btable of contents\b/i, /\bcontents\b/i, /\binnholdsfortegnelse\b/i]

const DEFAULT_TOC_COLUMN_HINTS = [
  "attachment",
  "appendix",
  "annex",
  "exhibit",
  "title",
  "document",
  "page",
  "side",
  "vedlegg",
  "date",
  "dato"
]

const DEFAULT_HEADER_FIELD_PATTERNS: PdfLayoutHeaderFieldPattern[] = [
  { field: "date", aliases: ["date", "dato"] },
  { field: "subject", aliases: ["subject", "title", "gjelder"] },
  { field: "client", aliases: ["client", "klient", "case id"] },
  { field: "caseHandler", aliases: ["case handler", "saksbehandler"] },
  { field: "sender", aliases: ["sender", "from", "avsender"] },
  { field: "recipient", aliases: ["recipient", "to", "mottaker"] }
]

const DATE_TOKEN = /^\d{2}[./-]\d{2}[./-]\d{4}$/

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .trim()
}

function firstPageText(pages: PdfLayoutPageInput[]): string {
  return pages[0]?.text ?? ""
}

function tableLooksLikeToc(table: PdfLayoutTable, columnHints: string[]): boolean {
  const header = table.rows[0]?.map((cell) => cell.toLowerCase()) ?? []
  const headerHits = header.reduce((count, cell) => {
    return count + (columnHints.some((hint) => cell.includes(hint)) ? 1 : 0)
  }, 0)
  if (headerHits >= 2) return true

  return table.rows.some((row) => {
    const cells = row.map((cell) => cell.trim()).filter(Boolean)
    return cells.length >= 3 && /^\d+$/.test(cells[0] ?? "") && /^\d+$/.test(cells[1] ?? "")
  })
}

function parseHeaderFields(text: string, patterns: PdfLayoutHeaderFieldPattern[]): Record<string, string> {
  const fields: Record<string, string> = {}
  const lines = normalizeWhitespace(text).split("\n")

  for (const line of lines) {
    for (const pattern of patterns) {
      if (fields[pattern.field]) continue
      for (const alias of pattern.aliases) {
        const matcher = new RegExp(`^${alias}\\s*:?\\s*(.+)$`, "i")
        const match = line.match(matcher)
        if (match?.[1]) {
          fields[pattern.field] = match[1].trim()
          break
        }
      }
    }
  }

  return fields
}

function parseSectionRow(row: string[]): Omit<PdfLayoutSection, "pageEnd" | "pageCount" | "sectionId"> | null {
  const cells = row.map((cell) => normalizeWhitespace(cell)).filter(Boolean)
  if (cells.length < 3) return null
  if (!/^\d+$/.test(cells[0] ?? "")) return null
  if (!/^\d+$/.test(cells[1] ?? "")) return null

  const ordinal = Number.parseInt(cells[0]!, 10)
  const pageStart = Number.parseInt(cells[1]!, 10)
  const remaining = cells.slice(2)

  let dateText: string | undefined
  if (DATE_TOKEN.test(remaining[0] ?? "")) {
    dateText = remaining.shift()
  }

  let documentNumber: string | undefined
  if (remaining.length >= 2 && /^[A-Za-z0-9-]+$/.test(remaining.at(-1) ?? "")) {
    documentNumber = remaining.pop()
  }

  const title = remaining.join(" ").trim()
  if (!title) return null

  return {
    ordinal,
    title,
    pageStart,
    dateText,
    documentNumber,
    rawCells: cells,
    inferredFrom: "table"
  }
}

function buildSections(rows: string[][], totalPages: number): PdfLayoutSection[] {
  const parsed = rows.map((row) => parseSectionRow(row)).filter((row): row is NonNullable<typeof row> => Boolean(row))

  return parsed.map((section, index) => {
    const nextStart = parsed[index + 1]?.pageStart ?? totalPages + 1
    const pageEnd = Math.max(section.pageStart, nextStart - 1)
    return {
      sectionId: `section-${section.ordinal}`,
      ordinal: section.ordinal,
      title: section.title,
      pageStart: section.pageStart,
      pageEnd,
      pageCount: Math.max(1, pageEnd - section.pageStart + 1),
      dateText: section.dateText,
      documentNumber: section.documentNumber,
      rawCells: section.rawCells,
      inferredFrom: "table"
    }
  })
}

export function analyzePdfLayout(request: PdfLayoutAnalysisRequest): PdfLayoutAnalysisResult {
  const pages = request.pages
  const maxScanPages = Math.max(1, request.maxScanPages ?? 30)
  const minimumDetectedSections = Math.max(1, request.minimumDetectedSections ?? 2)
  const headingPatterns = request.tocHeadingPatterns ?? DEFAULT_TOC_HEADING_PATTERNS
  const columnHints = (request.tocColumnHints ?? DEFAULT_TOC_COLUMN_HINTS).map((hint) => hint.toLowerCase())
  const headerPatterns = request.headerFieldPatterns ?? DEFAULT_HEADER_FIELD_PATTERNS

  const scannedPages = Math.min(maxScanPages, pages.length)
  const firstText = firstPageText(pages)
  const headerFields = parseHeaderFields(firstText, headerPatterns)
  const signals: string[] = []
  const tocRows: string[][] = []
  let tocDetected = false
  let tocStartPage: number | null = null

  for (const page of pages.slice(0, scannedPages)) {
    const normalizedText = normalizeWhitespace(page.text)
    const hasHeading = headingPatterns.some((pattern) => pattern.test(normalizedText))
    const matchingTables = (page.tables ?? []).filter((table) => tableLooksLikeToc(table, columnHints))

    if (hasHeading && !tocDetected) {
      tocDetected = true
      tocStartPage = page.pageNumber
      signals.push(`toc_heading:${page.pageNumber}`)
    }

    if (matchingTables.length > 0) {
      tocDetected = true
      tocStartPage ??= page.pageNumber
      signals.push(`toc_table:${page.pageNumber}`)
      for (const table of matchingTables) {
        tocRows.push(...table.rows)
      }
      continue
    }

    if (tocDetected && tocRows.length > 0) {
      break
    }
  }

  const sections = buildSections(tocRows, pages.length)
  if (sections.length >= minimumDetectedSections) {
    signals.push(`section_count:${sections.length}`)
  }

  return {
    layoutKind: sections.length >= minimumDetectedSections ? "multi_section" : "single_document",
    tocDetected,
    tocStartPage,
    sections,
    headerFields,
    firstPageText: firstText,
    scannedPages,
    signals
  }
}

export const pdfLayoutAnalysisService: RagProcessorService<PdfLayoutAnalysisRequest, PdfLayoutAnalysisResult> =
  Object.freeze({
    processorId: "pdf_layout_analysis",
    execute(request: PdfLayoutAnalysisRequest) {
      return Promise.resolve(analyzePdfLayout(request))
    }
  })
