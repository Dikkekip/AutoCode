import { unzipSync } from "fflate"

import type {
  DenseTextExtractionRequest,
  DenseTextExtractionResult,
  DenseTextPage,
  RagProcessorService
} from "./types.js"

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n")
}

function normalizePageText(value: string, trimWhitespace: boolean): string {
  const normalized = normalizeLineEndings(value)
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
  return trimWhitespace ? normalized.trim() : normalized
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function pagesToResult(
  sourceKind: DenseTextExtractionResult["sourceKind"],
  pages: DenseTextPage[],
  warnings: DenseTextExtractionResult["warnings"]
): DenseTextExtractionResult {
  const text = pages
    .map((page) => page.text)
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return {
    sourceKind,
    text,
    pages,
    characterCount: text.length,
    warnings
  }
}

function extractDocxText(bytes: Uint8Array, trimWhitespace: boolean): string {
  const archive = unzipSync(bytes)
  const documentXml = archive["word/document.xml"]
  if (!documentXml) {
    throw new Error("DOCX archive is missing word/document.xml")
  }

  const decoder = new TextDecoder("utf-8")
  const xml = decoder.decode(documentXml)
  const flattened = xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<[^>]+>/g, "")
  return normalizePageText(decodeXmlEntities(flattened), trimWhitespace)
}

export async function extractDenseText(request: DenseTextExtractionRequest): Promise<DenseTextExtractionResult> {
  const trimWhitespace = request.trimWhitespace ?? true

  switch (request.source.kind) {
    case "text": {
      const pattern = request.source.pageBreakPattern ?? /\f/g
      const parts = normalizeLineEndings(request.source.text).split(pattern)
      const pages = parts
        .map((part, index) => ({
          pageNumber: index + 1,
          text: normalizePageText(part, trimWhitespace)
        }))
        .filter((page) => page.text.length > 0)
      return pagesToResult("text", pages.length > 0 ? pages : [{ pageNumber: 1, text: "" }], [])
    }
    case "docx": {
      const text = extractDocxText(request.source.bytes, trimWhitespace)
      return pagesToResult("docx", [{ pageNumber: 1, text }], [])
    }
    case "pdf_pages": {
      const pages = request.source.pages.map((page) => ({
        pageNumber: page.pageNumber,
        text: normalizePageText(page.text, trimWhitespace)
      }))
      return pagesToResult("pdf_pages", pages, [])
    }
    default: {
      const exhaustiveCheck: never = request.source
      throw new Error(`Unsupported dense-text source: ${String(exhaustiveCheck)}`)
    }
  }
}

export const denseTextExtractionService: RagProcessorService<DenseTextExtractionRequest, DenseTextExtractionResult> =
  Object.freeze({
    processorId: "dense_text_extraction",
    execute(request: DenseTextExtractionRequest) {
      return extractDenseText(request)
    }
  })
