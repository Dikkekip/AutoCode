import { analyzePdfLayout, chunkTextSemantically, extractDenseText } from "@openclaw/rag-processors"
import { describe, expect, it } from "vitest"

describe("@openclaw/rag-processors", () => {
  it("extracts dense text from docx archives and page-based pdf payloads", async () => {
    const bytes = Buffer.from(
      "UEsDBBQAAAAIAFxXjFxh4rXQqQAAAAcBAAARAAAAd29yZC9kb2N1bWVudC54bWx9j8EKwjAMhl+l9O46PYiMbaIHn0AfILZxG6xJSatzb+8qiODByxeS/Hwh9f7pR/VAiQNTo9dFqRWSZTdQ1+jL+bTaaRUTkIORCRs9Y9T7tp4qx/bukZJaBBSrqdF9SqEyJtoePcSCA9Kyu7F4SEsrnZlYXBC2GOPi96PZlOXWeBhIZ+WV3ZxryJCM1B7G0IMKINAJhL42eZgpb4bf/BHT/7j53DHfH9oXUEsBAhQDFAAAAAgAXFeMXGHitdCpAAAABwEAABEAAAAAAAAAAAAAAIABAAAAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAABAAEAPwAAANgAAAAAAA==",
      "base64"
    )

    const docx = await extractDenseText({
      source: {
        kind: "docx",
        bytes
      }
    })
    expect(docx.text).toContain("Alpha paragraph")
    expect(docx.text).toContain("Beta paragraph")
    expect(docx.pages).toHaveLength(1)

    const pdfPages = await extractDenseText({
      source: {
        kind: "pdf_pages",
        pages: [
          { pageNumber: 1, text: "First page" },
          { pageNumber: 2, text: "Second page" }
        ]
      }
    })
    expect(pdfPages.text).toContain("First page")
    expect(pdfPages.text).toContain("Second page")
    expect(pdfPages.pages).toHaveLength(2)
  })

  it("detects toc-driven multi-section pdf layouts with generic header fields", () => {
    const analysis = analyzePdfLayout({
      pages: [
        {
          pageNumber: 1,
          text: ["Date: 2026-04-12", "Subject: Family evidence bundle", "Sender: County Office"].join("\n")
        },
        {
          pageNumber: 2,
          text: "Table of Contents",
          tables: [
            {
              rows: [
                ["Attachment", "Page", "Date", "Title", "Document"],
                ["1", "3", "12.01.2026", "Intake report", "A-1"],
                ["2", "5", "", "Decision notice", "A-2"]
              ]
            }
          ]
        },
        { pageNumber: 3, text: "Intake report body" },
        { pageNumber: 4, text: "Intake report appendix" },
        { pageNumber: 5, text: "Decision notice body" },
        { pageNumber: 6, text: "Decision notice appendix" }
      ]
    })

    expect(analysis.layoutKind).toBe("multi_section")
    expect(analysis.tocDetected).toBe(true)
    expect(analysis.tocStartPage).toBe(2)
    expect(analysis.headerFields.subject).toBe("Family evidence bundle")
    expect(analysis.sections).toHaveLength(2)
    expect(analysis.sections[0]).toMatchObject({
      ordinal: 1,
      title: "Intake report",
      pageStart: 3,
      pageEnd: 4
    })
    expect(analysis.sections[1]).toMatchObject({
      ordinal: 2,
      title: "Decision notice",
      pageStart: 5,
      pageEnd: 6
    })
  })

  it("chunks text along semantic boundaries when embeddings are available", async () => {
    const result = await chunkTextSemantically({
      text: [
        "Alpha findings support the first issue.",
        "Alpha chronology adds corroborating detail.",
        "Alpha notes remain consistent across sources.",
        "Beta findings introduce a different theme.",
        "Beta chronology expands the second theme."
      ].join(" "),
      maxChunkCharacters: 220,
      targetChunkCharacters: 110,
      minChunkCharacters: 80,
      overlapCharacters: 0,
      similarityThreshold: 0.85,
      embeddings: {
        async embed(texts) {
          return texts.map((text) => (text.includes("Beta") ? [0, 1] : [1, 0]))
        }
      }
    })

    expect(result.usedEmbeddings).toBe(true)
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks[0]?.text).toContain("Alpha findings")
    expect(result.chunks[0]?.text).not.toContain("Beta findings")
    expect(result.chunks[1]?.text).toContain("Beta findings")
  })
})
