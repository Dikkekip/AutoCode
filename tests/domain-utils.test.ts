import {
  extractIssueReferenceIds,
  extractMessageMediaAttachments,
  extractTaskReferenceIdentifiers,
  findIssueReferenceMatches,
  getBuiltinAutomationVariableValues,
  interpolateAutomationTemplate,
  redactCommandText,
  redactHomePathUserSegments,
  redactHomePathUserSegmentsInValue
} from "@openclaw/domain"
import { describe, expect, it } from "vitest"

describe("domain utilities borrowed from Paperclip", () => {
  it("interpolates built-in automation template variables", () => {
    const values = getBuiltinAutomationVariableValues(new Date("2026-04-26T12:34:56.000Z"))

    expect(interpolateAutomationTemplate("Repo health {{ date }}", values)).toBe("Repo health 2026-04-26")
    expect(interpolateAutomationTemplate("Runs on {{weekday}}", values)).toBe("Runs on Sunday")
    expect(interpolateAutomationTemplate("Keep {{unknown}} intact", values)).toBe("Keep {{unknown}} intact")
  })

  it("extracts task references while ignoring markdown code blocks", () => {
    expect(
      extractTaskReferenceIdentifiers(
        [
          "Fix APP-123 and https://openclaw.local/tasks/OPS-9.",
          "",
          "```",
          "IGNORE-1",
          "```",
          "Also see /issues/BUG-77."
        ].join("\n")
      )
    ).toEqual(["APP-123", "OPS-9", "BUG-77"])
  })

  it("redacts home-directory usernames in strings and nested values", () => {
    expect(redactHomePathUserSegments("/home/example/Documents/autocode")).toBe("/home/e******/Documents/autocode")
    expect(redactHomePathUserSegments("/Users/alice/project")).toBe("/Users/a****/project")
    expect(redactHomePathUserSegments("C:\\Users\\alice\\project")).toBe("C:\\Users\\a****\\project")

    expect(
      redactHomePathUserSegmentsInValue({
        cwd: "/home/example/repo",
        nested: ["C:\\Users\\alice\\repo", { path: "/Users/bob/file" }]
      })
    ).toEqual({
      cwd: "/home/e******/repo",
      nested: ["C:\\Users\\a****\\repo", { path: "/Users/b**/file" }]
    })
  })

  it("redacts Paperclip-style command secrets without hiding safe arguments", () => {
    const token = "ghp_123456789012345678901234"
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    const redacted = redactCommandText(
      [
        "OPENAI_API_KEY=sk-1234567890abcdef curl",
        "-H 'Authorization: Bearer secret-token'",
        `--github-token=${token}`,
        `--jwt ${jwt}`,
        "--safe value"
      ].join(" ")
    )

    expect(redacted).toContain("OPENAI_API_KEY=***REDACTED***")
    expect(redacted).toContain("Authorization: Bearer ***REDACTED***")
    expect(redacted).toContain("--github-token=***REDACTED***")
    expect(redacted).toContain("--jwt ***REDACTED***")
    expect(redacted).toContain("--safe value")
    expect(redacted).not.toContain(token)
    expect(redacted).not.toContain(jwt)
  })
})

describe("domain utilities borrowed from DevClaw", () => {
  it("extracts channel-normalized media attachments from message metadata", () => {
    expect(
      extractMessageMediaAttachments({
        MediaPath: "/tmp/upload/a brief.pdf",
        MediaPaths: ["/tmp/upload/photo.jpg", "/tmp/upload/photo.jpg", ""],
        MediaTypes: ["application/pdf", "image/jpeg"],
        FileNames: ["brief.pdf", "site-photo.jpg"]
      })
    ).toEqual([
      {
        localPath: "/tmp/upload/a brief.pdf",
        mimeType: "application/pdf",
        filename: "brief.pdf"
      },
      {
        localPath: "/tmp/upload/photo.jpg",
        mimeType: "image/jpeg",
        filename: "site-photo.jpg"
      }
    ])
  })

  it("extracts unique issue references from operator messages", () => {
    const matches = findIssueReferenceMatches("Fix #42, refs #7, then close #42. Ignore #0 and #100000000.")

    expect(matches.map((match) => [match.issueId, match.matchedText])).toEqual([
      [42, "Fix #42"],
      [7, "refs #7"]
    ])
    expect(extractIssueReferenceIds("addresses #12 and issue #13")).toEqual([12, 13])
  })
})
