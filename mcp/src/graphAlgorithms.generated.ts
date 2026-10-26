// GENERATED FILE — do not edit.
// Source: src/utils/graphAlgorithms.ts
// Regenerate with: npm run build:graph-algorithms
//
// Edit the source instead. `npm run check:graph-algorithms` fails if this file
// is out of date, so an edit here would be reverted by the next build.

// Filamental — graph algorithms over a plain adjacency map.
//
// NO IMPORTS, on purpose. scripts/build-graph-algorithms.mjs copies this file
// verbatim into the MCP package, which cannot reach into src/, so anything
// imported here would break that copy. Callers build the adjacency from their
// own edge shape and hand it in.

export interface AdjEdge { to: string; edgeId: string }
export type Adjacency = Map<string, AdjEdge[]>

/**
 * Breadth-first shortest route. Neighbours are visited in array order, so ties
 * resolve to the earliest edge and the result is deterministic. Returns null
 * when there is no route, or when the route would exceed maxHops. from === to
 * returns the single node and no edges.
 */
export function shortestPath(
  adj:      Adjacency,
  from:     string,
  to:       string,
  maxHops?: number,
): { nodeIds: string[]; edgeIds: string[] } | null {
  if (from === to) return { nodeIds: [from], edgeIds: [] }
  // No has() guard on either end: with a directed adjacency a node that only
  // has arrows pointing at it is never a key, yet is still a reachable target.

  // For each reached node: who we came from, and along which edge.
  const via = new Map<string, { prev: string; edgeId: string; hops: number }>()
  via.set(from, { prev: '', edgeId: '', hops: 0 })

  const queue = [from]
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]
    const hops = via.get(current)!.hops
    if (maxHops !== undefined && hops >= maxHops) continue

    for (const { to: next, edgeId } of adj.get(current) ?? []) {
      if (via.has(next)) continue
      via.set(next, { prev: current, edgeId, hops: hops + 1 })
      if (next === to) return unwind(via, from, to)
      queue.push(next)
    }
  }
  return null
}

function unwind(
  via:  Map<string, { prev: string; edgeId: string; hops: number }>,
  from: string,
  to:   string,
): { nodeIds: string[]; edgeIds: string[] } {
  const nodeIds = [to]
  const edgeIds: string[] = []
  for (let at = to; at !== from;) {
    const step = via.get(at)!
    edgeIds.push(step.edgeId)
    nodeIds.push(step.prev)
    at = step.prev
  }
  return { nodeIds: nodeIds.reverse(), edgeIds: edgeIds.reverse() }
}

/**
 * Groups of nodes that can reach each other, largest first (ties keep the order
 * of nodeIds). A node with no edges is a group of one. Edges to ids outside
 * nodeIds are ignored.
 */
export function connectedComponents(nodeIds: string[], adj: Adjacency): string[][] {
  const known = new Set(nodeIds)
  const seen = new Set<string>()
  const groups: string[][] = []

  for (const start of nodeIds) {
    if (seen.has(start)) continue
    seen.add(start)
    const group = [start]
    for (let head = 0; head < group.length; head++) {
      for (const { to } of adj.get(group[head]) ?? []) {
        if (!known.has(to) || seen.has(to)) continue
        seen.add(to)
        group.push(to)
      }
    }
    groups.push(group)
  }
  return groups.sort((a, b) => b.length - a.length)
}

/**
 * Nodes whose removal would split their group in two or more. Tarjan's
 * lowpoint method with an explicit stack, because a recursive walk overflows on
 * a long chain. The edge we arrived by is skipped by id, not the parent by node,
 * so two parallel edges between the same pair correctly make neither a bridge.
 * Self-loops are ignored.
 */
export function articulationPoints(nodeIds: string[], adj: Adjacency): Set<string> {
  const known = new Set(nodeIds)
  const disc = new Map<string, number>()
  const low = new Map<string, number>()
  const found = new Set<string>()
  let clock = 0

  for (const root of nodeIds) {
    if (disc.has(root)) continue
    disc.set(root, clock)
    low.set(root, clock)
    clock++
    let rootChildren = 0
    const stack = [{ node: root, viaEdge: '', next: 0 }]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const neighbours = adj.get(frame.node) ?? []

      if (frame.next < neighbours.length) {
        const { to, edgeId } = neighbours[frame.next++]
        if (edgeId === frame.viaEdge || to === frame.node || !known.has(to)) continue
        if (disc.has(to)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, disc.get(to)!))
        } else {
          disc.set(to, clock)
          low.set(to, clock)
          clock++
          if (frame.node === root) rootChildren++
          stack.push({ node: to, viaEdge: edgeId, next: 0 })
        }
        continue
      }

      stack.pop()
      const parent = stack[stack.length - 1]
      if (!parent) continue
      low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      if (parent.node !== root && low.get(frame.node)! >= disc.get(parent.node)!) {
        found.add(parent.node)
      }
    }
    if (rootChildren > 1) found.add(root)
  }
  return found
}
