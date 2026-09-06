export interface DependencyGraphNode {
  id: string
  dependsOn: string[]
}

function normalizedNode(node: DependencyGraphNode): DependencyGraphNode {
  return {
    id: node.id.trim(),
    dependsOn: Array.from(new Set(node.dependsOn.map((dependency) => dependency.trim()).filter(Boolean)))
  }
}

export function topologicalDependencyOrder(nodes: DependencyGraphNode[]): string[] {
  const normalized = nodes.map(normalizedNode)
  const byId = new Map<string, DependencyGraphNode>()

  for (const node of normalized) {
    if (!node.id) throw new Error("Dependency graph contains an empty node id.")
    if (byId.has(node.id)) throw new Error(`Dependency graph contains duplicate node id: ${node.id}`)
    byId.set(node.id, node)
  }

  for (const node of normalized) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) {
        throw new Error(`Dependency graph node ${node.id} cannot depend on itself.`)
      }
      if (!byId.has(dependency)) {
        throw new Error(`Dependency graph node ${node.id} references unknown dependency: ${dependency}`)
      }
    }
  }

  const ordered: string[] = []
  const complete = new Set<string>()
  const visiting = new Set<string>()

  const visit = (nodeId: string, path: string[]): void => {
    if (complete.has(nodeId)) return
    if (visiting.has(nodeId)) {
      const cycleStart = path.indexOf(nodeId)
      const cycle = [...path.slice(Math.max(0, cycleStart)), nodeId]
      throw new Error(`Dependency graph contains a cycle: ${cycle.join(" -> ")}`)
    }

    visiting.add(nodeId)
    const node = byId.get(nodeId)!
    for (const dependency of node.dependsOn) {
      visit(dependency, [...path, nodeId])
    }
    visiting.delete(nodeId)
    complete.add(nodeId)
    ordered.push(nodeId)
  }

  for (const node of normalized) {
    visit(node.id, [])
  }

  return ordered
}

export function validateDependencyGraph(nodes: DependencyGraphNode[]): void {
  topologicalDependencyOrder(nodes)
}
