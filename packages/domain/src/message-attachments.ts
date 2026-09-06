export interface MessageMediaAttachment {
  localPath: string
  mimeType?: string
  filename?: string
}

export interface IssueReferenceMatch {
  issueId: number
  matchedText: string
  index: number
}

function basenameFromPath(value: string): string {
  const normalized = value.replace(/\\/g, "/")
  const segments = normalized.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? value
}

function stringArrayValue(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
}

export function extractMessageMediaAttachments(metadata: Record<string, unknown>): MessageMediaAttachment[] {
  const paths = [
    ...stringArrayValue(metadata.MediaPath),
    ...stringArrayValue(metadata.MediaPaths),
    ...stringArrayValue(metadata.mediaPath),
    ...stringArrayValue(metadata.mediaPaths)
  ]
  const mimeTypes = [
    ...stringArrayValue(metadata.MediaType),
    ...stringArrayValue(metadata.MediaTypes),
    ...stringArrayValue(metadata.mediaType),
    ...stringArrayValue(metadata.mediaTypes)
  ]
  const filenames = [
    ...stringArrayValue(metadata.FileName),
    ...stringArrayValue(metadata.FileNames),
    ...stringArrayValue(metadata.filename),
    ...stringArrayValue(metadata.filenames)
  ]

  const seen = new Set<string>()
  const attachments: MessageMediaAttachment[] = []

  for (const [index, localPath] of paths.entries()) {
    if (seen.has(localPath)) continue
    seen.add(localPath)
    const attachment: MessageMediaAttachment = {
      localPath,
      filename: filenames[index] ?? basenameFromPath(localPath)
    }
    const mimeType = mimeTypes[index]
    if (mimeType) attachment.mimeType = mimeType
    attachments.push(attachment)
  }

  return attachments
}

export function findIssueReferenceMatches(text: string): IssueReferenceMatch[] {
  if (!text) return []

  const matches: IssueReferenceMatch[] = []
  const seen = new Set<number>()
  const issueReferenceRe =
    /(?:\b(?:issue|issues|fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved|address|addresses|refs?)\s+)?#(\d{1,8})\b/gi

  for (let match = issueReferenceRe.exec(text); match !== null; match = issueReferenceRe.exec(text)) {
    const issueId = Number.parseInt(match[1] ?? "", 10)
    if (!Number.isSafeInteger(issueId) || issueId <= 0 || seen.has(issueId)) continue
    seen.add(issueId)
    matches.push({
      issueId,
      matchedText: match[0],
      index: match.index
    })
  }

  return matches
}

export function extractIssueReferenceIds(text: string): number[] {
  return findIssueReferenceMatches(text).map((match) => match.issueId)
}
