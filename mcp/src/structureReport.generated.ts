// GENERATED FILE — do not edit.
// Source: src/utils/structureReport.ts
// Regenerate with: npm run build:graph-algorithms
//
// Edit the source instead. `npm run check:graph-algorithms` fails if this file
// is out of date, so an edit here would be reverted by the next build.

// The "Structure" section at the top of an AI export: what the space is made of
// and where its weight sits, so a model can orient before it reads a single note.
//
// Pure, and imports nothing but graphAlgorithms (itself import-free), so the MCP
// package can take a copy. The input is a structural subset of VaultSnapshot for
// the same reason: no type import to rewrite.

import { connectedComponents, articulationPoints, type Adjacency } from './graphAlgorithms.generated.js'

export interface StructureInput {
  nodes: Array<{
    id:         string
    name:       string
    type:       string
    body?:      string
    properties: Record<string, string>
  }>
  edges: Array<{ source_id: string; target_id: string; rel_type: string }>
  /** Raw .filamental JSON: key -> { label? }. */
  entity_types:    unknown
  connector_types: unknown
}

const TOP_CONNECTED   = 10
const MAX_LOAD_BEARING = 15
const MAX_GROUPS      = 10
const MAX_NAMES       = 20

function labels(raw: unknown): Record<string, { label?: string }> {
  return raw && typeof raw === 'object' ? raw as Record<string, { label?: string }> : {}
}

const byCountThenName = (a: [string, number], b: [string, number]) =>
  b[1] - a[1] || a[0].localeCompare(b[0])

/** "Person 12 · Organisation 5", counts descending. */
function tally(keys: string[], labelOf: (key: string) => string): string {
  const counts = new Map<string, number>()
  for (const k of keys) counts.set(labelOf(k), (counts.get(labelOf(k)) ?? 0) + 1)
  return [...counts].sort(byCountThenName).map(([l, n]) => `${l} ${n}`).join(' · ')
}

/** "A, B, C and 4 more" */
function nameList(names: string[], cap: number): string {
  const shown = names.slice(0, cap).join(', ')
  return names.length > cap ? `${shown} and ${names.length - cap} more` : shown
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function buildStructureSection(input: StructureInput): string {
  const { nodes, edges } = input
  if (nodes.length === 0) return ''

  const entityLabel    = (key: string) => labels(input.entity_types)[key]?.label ?? key
  const connectorLabel = (key: string) => labels(input.connector_types)[key]?.label ?? key
  const nodeById = new Map(nodes.map(n => [n.id, n]))

  // Undirected, and edges to a missing node are ignored. There is no edge id in
  // a snapshot, so the index stands in; it only has to be unique.
  const adj: Adjacency = new Map()
  const perNode = new Map<string, Map<string, number>>()   // node -> connector label -> count
  const push = (from: string, to: string, edgeId: string) => {
    const list = adj.get(from)
    if (list) list.push({ to, edgeId })
    else adj.set(from, [{ to, edgeId }])
  }
  const usable = edges.filter(e => nodeById.has(e.source_id) && nodeById.has(e.target_id))
  usable.forEach((e, i) => {
    push(e.source_id, e.target_id, String(i))
    push(e.target_id, e.source_id, String(i))
    for (const id of e.source_id === e.target_id ? [e.source_id] : [e.source_id, e.target_id]) {
      const counts = perNode.get(id) ?? new Map<string, number>()
      const label = connectorLabel(e.rel_type)
      counts.set(label, (counts.get(label) ?? 0) + 1)
      perNode.set(id, counts)
    }
  })
  const degree = (id: string) => [...(perNode.get(id)?.values() ?? [])].reduce((a, b) => a + b, 0)
  const byDegreeThenName = (a: string, b: string) =>
    degree(b) - degree(a) || nodeById.get(a)!.name.localeCompare(nodeById.get(b)!.name)

  const out: string[] = ['## Structure']
  out.push(`Classifications: ${tally(nodes.map(n => n.type), entityLabel)}`)
  if (usable.length > 0) out.push(`Connectors: ${tally(usable.map(e => e.rel_type), connectorLabel)}`)

  const connected = nodes.filter(n => degree(n.id) >= 1).map(n => n.id)

  if (connected.length > 0) {
    out.push('', '### Most connected')
    connected.sort(byDegreeThenName).slice(0, TOP_CONNECTED).forEach((id, i) => {
      const n = nodeById.get(id)!
      const kinds = [...perNode.get(id)!].sort(byCountThenName)
      // Name the two heaviest connectors and fold the rest, so a hub with a dozen
      // kinds of tie still reads on one line.
      const shown = kinds.length <= 3
        ? kinds.map(([l, c]) => `${l} ${c}`)
        : [...kinds.slice(0, 2).map(([l, c]) => `${l} ${c}`),
           `other ${kinds.slice(2).reduce((s, [, c]) => s + c, 0)}`]
      out.push(`${i + 1}. ${n.name} (${entityLabel(n.type)}): ${plural(degree(id), 'connection', 'connections')} (${shown.join(', ')})`)
    })
  }

  const nodeIds = nodes.map(n => n.id)
  const loadBearing = [...articulationPoints(nodeIds, adj)].sort(byDegreeThenName)
  if (loadBearing.length > 0) {
    out.push('', '### Load-bearing')
    out.push(`Removing any of these would split the structure: ${nameList(loadBearing.map(id => nodeById.get(id)!.name), MAX_LOAD_BEARING)}`)
  }

  const groups = connectedComponents(nodeIds, adj).filter(g => g.length > 1)
  if (groups.length > 1) {
    out.push('', '### Islands')
    const parts = groups.slice(0, MAX_GROUPS).map((g, i) =>
      `${g.length} ${i === 0 ? 'nodes ' : ''}around ${nodeById.get([...g].sort(byDegreeThenName)[0])!.name}`)
    const more = groups.length > MAX_GROUPS ? ` · and ${groups.length - MAX_GROUPS} more` : ''
    out.push(`${groups.length} separate groups. Largest: ${parts.join(' · ')}${more}`)
  }

  const unconnected = nodes.filter(n => degree(n.id) === 0).map(n => n.name)
  if (unconnected.length > 0) {
    out.push('', `### Unconnected (${unconnected.length})`, nameList(unconnected, MAX_NAMES))
  }

  const thin = nodes
    .filter(n => !n.body?.trim() && Object.keys(n.properties).every(k => k.startsWith('_')))
    .map(n => n.name)
  if (thin.length > 0) {
    out.push('', `### Thin records (${thin.length})`, `Nodes with no notes and no properties: ${nameList(thin, MAX_NAMES)}`)
  }

  return out.join('\n')
}
