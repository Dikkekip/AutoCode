import { describe, expect, it } from "vitest"

import {
  createSourceCitationMiddleware,
  prepareSummarySources,
  runSummaryWithSourceCitations,
  SourceCitationValidationError
} from "./index.js"

describe("source citation middleware", () => {
  it("dedupes repeated source locations and assigns stable source tags", () => {
    const prepared = prepareSummarySources([
      {
        ref: "doc:vedlegg-75",
        title: "Vedlegg 75",
        excerpt: "Short excerpt.",
        location: { pageStart: 2, pageEnd: 3 }
      },
      {
        ref: "doc:vedlegg-75",
        title: "Vedlegg 75",
        excerpt: "Longer excerpt with more detail.",
        uri: "https://example.test/vedlegg-75.pdf",
        location: { pageStart: 2, pageEnd: 3 }
      },
      {
        ref: "doc:chat-12",
        title: "Chat export",
        excerpt: "Message thread excerpt.",
        location: { lineStart: 10, lineEnd: 18 }
      }
    ])

    expect(prepared).toHaveLength(2)
    expect(prepared[0]).toMatchObject({
      sourceIndex: 1,
      locationKey: "p2-3",
      locationTag: "[S1@p2-3]",
      excerpt: "Longer excerpt with more detail.",
      uri: "https://example.test/vedlegg-75.pdf"
    })
    expect(prepared[1]).toMatchObject({
      sourceIndex: 2,
      locationKey: "l10-18",
      locationTag: "[S2@l10-18]"
    })
  })

  it("normalizes legacy numeric citations into source location tags and builds provenance", () => {
    const middleware = createSourceCitationMiddleware()
    const prepared = middleware.prepareSummaryInput({
      prompt: "Summarize the evidence",
      sources: [
        {
          ref: "doc:vedlegg-12",
          title: "Vedlegg 12",
          excerpt: "Incident description excerpt.",
          docId: "doc-12",
          chunkId: "chunk-12",
          location: { pageStart: 4, pageEnd: 5 }
        }
      ]
    })

    const result = middleware.finalizeSummary({
      content: "The report confirms the incident chronology [1].",
      preparedSources: prepared.sources
    })

    expect(result.normalizedContent).toContain("[S1@p4-5]")
    expect(result.validation.status).toBe("ok")
    expect(result.provenance.sources[0]).toMatchObject({
      sourceIndex: 1,
      sourceRef: "doc:vedlegg-12",
      locationTag: "[S1@p4-5]",
      docId: "doc-12",
      chunkId: "chunk-12"
    })
    expect(result.provenance.citations[0]).toMatchObject({
      sourceIndex: 1,
      locationKey: "p4-5",
      sourceRef: "doc:vedlegg-12"
    })
  })

  it("throws in strict mode when the model invents or mismatches location tags", async () => {
    await expect(
      runSummaryWithSourceCitations(
        {
          prompt: "Summarize the evidence",
          sources: [
            {
              ref: "doc:vedlegg-9",
              title: "Vedlegg 9",
              excerpt: "Key evidence.",
              location: { pageStart: 7 }
            }
          ],
          generate: async () => "This cites the wrong location [S1@p9]."
        },
        { strict: true }
      )
    ).rejects.toBeInstanceOf(SourceCitationValidationError)
  })

  it("passes the composed prompt to generators and preserves uncited source tracking", async () => {
    const result = await runSummaryWithSourceCitations(
      {
        prompt: "Write a concise evidence summary.",
        sources: [
          {
            ref: "doc:timeline-1",
            title: "Timeline bundle",
            excerpt: "The child welfare office logged the complaint on 2026-01-14.",
            location: { pageStart: 1 }
          },
          {
            ref: "doc:timeline-2",
            title: "Phone note",
            excerpt: "A follow-up phone call happened the next day.",
            location: { pageStart: 2 }
          }
        ],
        generate: async (input) => {
          expect(input.composedPrompt).toContain("Allowed tags: [S1@p1], [S2@p2]")
          expect(input.sourceCatalog).toContain("[S1@p1] Timeline bundle")
          return "The complaint was logged on 2026-01-14 [S1@p1]."
        }
      },
      { strict: true }
    )

    expect(result.validation.status).toBe("ok")
    expect(result.provenance.citedSourceIndices).toEqual([1])
    expect(result.provenance.uncitedSourceIndices).toEqual([2])
  })
})
