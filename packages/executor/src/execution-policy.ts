import { join } from "node:path"
import { type ExecutionPolicy, resolveProjectProfile, validateExecutionPolicy } from "@openclaw/project-profiles"

export function executionPolicyForRepo(repoPath: string): ExecutionPolicy {
  return validateExecutionPolicy(resolveProjectProfile(repoPath)?.executionPolicy)
}

export function executionDependencyPaths(repoPath: string): { shared: string[]; isolated: string[] } {
  const policy = executionPolicyForRepo(repoPath)
  return {
    shared: policy.nodeTestRoot ? [join(policy.nodeTestRoot, "node_modules")] : [],
    isolated: policy.pythonTestRoot ? [join(policy.pythonTestRoot, ".venv")] : []
  }
}
