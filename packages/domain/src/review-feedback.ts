export type PullRequestFeedbackReason = "changes_requested" | "merge_conflict" | "rejected"

export interface PullRequestReviewComment {
  id: string | number
  author: string
  body: string
  state?: string | null | undefined
  path?: string | null | undefined
  line?: number | null | undefined
}

export interface PullRequestFeedback {
  url: string
  branchName?: string | null | undefined
  reason: PullRequestFeedbackReason
  comments: PullRequestReviewComment[]
}

function feedbackLabel(reason: PullRequestFeedbackReason): string {
  if (reason === "merge_conflict") return "Merge conflicts detected"
  if (reason === "changes_requested") return "Changes were requested"
  return "PR was rejected"
}

function commentLocation(comment: PullRequestReviewComment): string {
  if (!comment.path) return ""
  return ` (${comment.path}${comment.line ? `:${comment.line}` : ""})`
}

export function formatPullRequestFeedback(input: {
  feedback: PullRequestFeedback
  baseBranch: string
  includeConflictInstructions?: boolean | undefined
}): string {
  const lines = [
    "## PR Review Feedback",
    `${feedbackLabel(input.feedback.reason)}. Address the feedback below.`,
    `PR: ${input.feedback.url}`
  ]

  for (const comment of input.feedback.comments) {
    lines.push("", `**${comment.author}** [${comment.state ?? "open"}]${commentLocation(comment)}:`, comment.body)
  }

  if (input.feedback.reason === "merge_conflict" && input.includeConflictInstructions !== false) {
    const branchName = input.feedback.branchName ?? "<pr-branch>"
    lines.push(
      "",
      "### Conflict Resolution Instructions",
      "Update the existing PR branch. Do not create a replacement PR.",
      `Branch: ${branchName}`,
      `Base: ${input.baseBranch}`,
      "",
      "Steps:",
      `1. Fetch and check out ${branchName}.`,
      `2. Rebase onto ${input.baseBranch}.`,
      "3. Resolve conflicts and continue the rebase.",
      `4. Push back to ${branchName} with force-with-lease.`,
      "5. Verify the original PR is still open and mergeable."
    )
  }

  return lines.join("\n")
}

export function reviewFeedbackRequiresExistingBranch(feedback: PullRequestFeedback): boolean {
  return feedback.reason === "merge_conflict" || feedback.reason === "changes_requested"
}
