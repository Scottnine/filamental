// Filamental MCP Server — server.ts
// Tool definitions and implementations. Entry point wires this to a transport.

import { randomUUID } from 'crypto'
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join, dirname, resolve, sep } from 'path'
import Database from 'better-sqlite3'
import * as yaml from 'js-yaml'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'

// ── Row type alias ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

// ── NodeRecord ────────────────────────────────────────────────────────────────

interface RelationshipRecord {
  target: string
  rel_type: string
  direction: string
  label?: string | null
  influence?: string | null
  properties?: Record<string, string>
}

interface NodeRecord {
  id: string
  name: string
  entity_type: string
  status: string
  created: string
  modified: string
  modified_by: string
  version: number
  properties: Record<string, string>
  relationships: RelationshipRecord[]
  attachments: string[]
  composition_mode: string | null
  child_view_id: string | null
  has_notes: boolean
  display_name?: string | null
  category?: string | null
}

// ── FTS query builder ─────────────────────────────────────────────────────────

function buildFtsQuery(q: string): string {
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => `"${word.replace(/"/g, '""')}"*`)
    .join(' ')
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

// ── File helpers ──────────────────────────────────────────────────────────────

function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9\-_]/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.length === 0 ? 'node' : cleaned
}

function findAvailablePath(basePath: string): string {
  if (!existsSync(basePath)) return basePath
  const withoutExt = basePath.slice(0, -3) // strip .md
  for (let i = 1; i <= 9999; i++) {
    const candidate = `${withoutExt}_${i}.md`
    if (!existsSync(candidate)) return candidate
  }
  return basePath
}

function fileMtimeSecs(filePath: string): number {
  try {
    return Math.floor(statSync(filePath).mtimeMs / 1000)
  } catch {
    return 0
  }
}

// ── Markdown serialisation / parsing ──────────────────────────────────────────

function serialiseMarkdown(node: NodeRecord, body: string): string {
  const frontmatter: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.entity_type,
    status: node.status,
    created: node.created,
    modified: node.modified,
    modified_by: node.modified_by,
    version: node.version,
    properties: node.properties,
    relationships: node.relationships.map(r => {
      const rel: Record<string, unknown> = {
        target: r.target,
        type: r.rel_type,
        direction: r.direction,
        properties: r.properties ?? {},
      }
      if (r.label != null) rel['label'] = r.label
      if (r.influence != null) rel['influence'] = r.influence
      return rel
    }),
    attachments: node.attachments,
    composition_mode: node.composition_mode,
    child_view_id: node.child_view_id,
    has_notes: node.has_notes,
  }

  if (node.display_name != null) frontmatter['display_name'] = node.display_name
  if (node.category != null) frontmatter['category'] = node.category

  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 })
  return `---\n${yamlStr}---\n\n${body.trim()}`
}

function parseMarkdownFile(filePath: string): { node: NodeRecord; body: string } {
  const raw = readFileSync(filePath, 'utf-8')

  // Split on opening --- and closing ---
  const openIdx = raw.indexOf('---\n')
  if (openIdx !== 0) throw new Error('No YAML frontmatter found')
  const closeIdx = raw.indexOf('\n---\n', 4)
  if (closeIdx === -1) throw new Error('Frontmatter closing delimiter not found')

  const yamlPart = raw.slice(4, closeIdx)
  const body = raw.slice(closeIdx + 5) // skip \n---\n

  const fm = yaml.load(yamlPart) as Record<string, unknown>

  const relationships: RelationshipRecord[] = ((fm['relationships'] as unknown[]) ?? []).map(r => {
    const rel = r as Record<string, unknown>
    const out: RelationshipRecord = {
      target: String(rel['target'] ?? ''),
      rel_type: String(rel['type'] ?? ''),
      direction: String(rel['direction'] ?? 'none'),
      properties: (rel['properties'] as Record<string, string>) ?? {},
    }
    if (rel['label'] != null) out.label = String(rel['label'])
    if (rel['influence'] != null) out.influence = String(rel['influence'])
    return out
  })

  const node: NodeRecord = {
    id: String(fm['id'] ?? ''),
    name: String(fm['name'] ?? ''),
    entity_type: String(fm['type'] ?? 'unclassified'),
    status: String(fm['status'] ?? 'active'),
    created: String(fm['created'] ?? new Date().toISOString()),
    modified: String(fm['modified'] ?? new Date().toISOString()),
    modified_by: String(fm['modified_by'] ?? 'unknown'),
    version: typeof fm['version'] === 'number' ? fm['version'] : 1,
    properties: (fm['properties'] as Record<string, string>) ?? {},
    relationships,
    attachments: (fm['attachments'] as string[]) ?? [],
    composition_mode: (fm['composition_mode'] as string | null) ?? null,
    child_view_id: (fm['child_view_id'] as string | null) ?? null,
    has_notes: Boolean(fm['has_notes']),
  }

  if (fm['display_name'] != null) node.display_name = String(fm['display_name'])
  if (fm['category'] != null) node.category = String(fm['category'])

  return { node, body }
}

// ── SQLite upsert / delete ────────────────────────────────────────────────────

function upsertEntity(db: Database.Database, node: NodeRecord, filePath: string, body: string): void {
  const now = node.modified
  const mtime = fileMtimeSecs(filePath)

  const dataJson = JSON.stringify({
    ...node,
    has_notes: body.trim().length > 0,
  })

  const propertiesText = Object.values(node.properties).join(' ')

  db.prepare(
    `INSERT INTO entities
       (id, file_path, name, entity_type, status, version, modified, file_mtime_secs, data_json)
     VALUES
       (@id, @file_path, @name, @entity_type, @status, @version, @modified, @file_mtime_secs, @data_json)
     ON CONFLICT(id) DO UPDATE SET
       file_path       = excluded.file_path,
       name            = excluded.name,
       entity_type     = excluded.entity_type,
       status          = excluded.status,
       version         = excluded.version,
       modified        = excluded.modified,
       file_mtime_secs = excluded.file_mtime_secs,
       data_json       = excluded.data_json`,
  ).run({
    id: node.id,
    file_path: filePath,
    name: node.name,
    entity_type: node.entity_type,
    status: node.status,
    version: node.version,
    modified: now,
    file_mtime_secs: mtime,
    data_json: dataJson,
  })

  db.prepare('DELETE FROM entities_fts WHERE entity_id = ?').run(node.id)
  db.prepare(
    `INSERT INTO entities_fts(entity_id, name, body, properties_text) VALUES(?, ?, ?, ?)`,
  ).run(node.id, node.name, body.trim(), propertiesText)

  db.prepare('DELETE FROM relationships WHERE source_id = ?').run(node.id)

  for (const rel of node.relationships) {
    const edgeId = `${node.id}__${rel.target}__${rel.rel_type}`
    db.prepare(
      `INSERT OR IGNORE INTO relationships
         (edge_id, source_id, target_id, rel_type, direction, label, influence, properties_json)
       VALUES
         (@edge_id, @source_id, @target_id, @rel_type, @direction, @label, @influence, @properties_json)`,
    ).run({
      edge_id: edgeId,
      source_id: node.id,
      target_id: rel.target,
      rel_type: rel.rel_type,
      direction: rel.direction,
      label: rel.label ?? null,
      influence: rel.influence ?? null,
      properties_json: JSON.stringify(rel.properties ?? {}),
    })
  }
}

function deleteEntity(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM entities WHERE id = ?').run(id)
  db.prepare('DELETE FROM entities_fts WHERE entity_id = ?').run(id)
  db.prepare('DELETE FROM relationships WHERE source_id = ? OR target_id = ?').run(id, id)
}

// ── Input validation ──────────────────────────────────────────────────────────

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'name must be a non-empty string')
  }
  if (name.length > 200) {
    throw new McpError(ErrorCode.InvalidParams, 'name must be 200 characters or fewer')
  }
  if (name.includes('\0')) {
    throw new McpError(ErrorCode.InvalidParams, 'name must not contain null bytes')
  }
  if (name.includes('..')) {
    throw new McpError(ErrorCode.InvalidParams, 'name must not contain ".." sequences')
  }
  return name.trim()
}

// ── Tool schemas ──────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_nodes',
    description:
      'Full-text search across entity names, note bodies and property values. ' +
      'Returns matching nodes with a contextual snippet.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search terms' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_node',
    description: 'Retrieve full node data for a given entity UUID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Entity UUID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_connections',
    description:
      'Get all edges connected to a node. Each result includes the resolved ' +
      'name and type of both the source and target.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Entity UUID' },
        direction: {
          type: 'string',
          enum: ['all', 'outgoing', 'incoming'],
          description: 'Filter by whether the node is source or target (default "all")',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_subgraph',
    description:
      'BFS traversal from a root node collecting all reachable nodes and edges ' +
      'up to the given hop depth. Results are deduplicated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Root entity UUID' },
        depth: { type: 'number', description: 'Hop depth (default 1, max 3)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_node_types',
    description:
      'Return the full entity type configuration for this vault ' +
      '(from .filamental/entity_types.json).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'list_connector_types',
    description:
      'Return the full connector type configuration for this vault ' +
      '(from .filamental/connector_types.json).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_vault_info',
    description:
      'Return summary counts (nodes, edges) and the top-level entity and ' +
      'connector type names configured for this vault.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'create_node',
    description:
      'Create a new node in the vault. Writes a markdown file and updates the SQLite index. ' +
      'Returns { id, file_path }. Call get_node(id) to retrieve the full record.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Display name (max 200 chars, required)' },
        entity_type: { type: 'string', description: 'Entity type key (default "unclassified")' },
        status: { type: 'string', enum: ['active', 'archived'], description: 'Node status (default "active")' },
        properties: {
          type: 'object',
          description: 'Key/value string pairs',
          additionalProperties: { type: 'string' },
        },
        relationships: {
          type: 'array',
          description: 'Edges to other nodes',
          items: {
            type: 'object',
            properties: {
              target:    { type: 'string', description: 'Target node UUID' },
              rel_type:  { type: 'string', description: 'Connector type key' },
              direction: { type: 'string', enum: ['none', 'source', 'target'] },
              label:     { type: 'string' },
              influence: { type: 'string', enum: ['normal', 'weak', 'none'] },
              properties: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['target', 'rel_type', 'direction'],
          },
        },
        notes:  { type: 'string', description: 'Markdown body text' },
        folder: { type: 'string', description: 'Subfolder path relative to vault root' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_node',
    description:
      'Update an existing node. Only supplied fields are changed; omitted fields retain their current values. ' +
      'Providing relationships or properties replaces the entire array/map. ' +
      'Returns { id, file_path }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id:          { type: 'string', description: 'UUID of the node to update' },
        name:        { type: 'string', description: 'New display name (max 200 chars)' },
        entity_type: { type: 'string' },
        status:      { type: 'string', enum: ['active', 'archived'] },
        properties:  { type: 'object', additionalProperties: { type: 'string' } },
        relationships: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              target:    { type: 'string' },
              rel_type:  { type: 'string' },
              direction: { type: 'string', enum: ['none', 'source', 'target'] },
              label:     { type: 'string' },
              influence: { type: 'string', enum: ['normal', 'weak', 'none'] },
              properties: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['target', 'rel_type', 'direction'],
          },
        },
        notes:        { type: 'string', description: 'Replaces the full markdown body if provided' },
        display_name: { type: 'string', description: 'Pass empty string to clear' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_node',
    description:
      'Delete a node from the vault. Removes the markdown file and all references ' +
      'from the SQLite index (entities, FTS, relationships). Returns { deleted: true, file_path }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'UUID of the node to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_edge',
    description:
      'Add a relationship from one node to another. Reads the source node file, appends the ' +
      'relationship, writes it back, and updates the SQLite index. ' +
      'Returns { edge_id, source_id, target_id }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id:  { type: 'string', description: 'UUID of the source node' },
        target_id:  { type: 'string', description: 'UUID of the target node' },
        rel_type:   { type: 'string', description: 'Connector type key' },
        direction:  {
          type: 'string',
          enum: ['none', 'source', 'target'],
          description: 'Arrow direction (default "none")',
        },
        label:      { type: 'string', description: 'Optional edge label text' },
        influence:  {
          type: 'string',
          enum: ['normal', 'weak', 'none'],
          description: 'Optional physics influence override',
        },
        properties: {
          type: 'object',
          description: 'Optional key/value string pairs',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['source_id', 'target_id', 'rel_type'],
    },
  },
  {
    name: 'delete_edge',
    description:
      'Remove a relationship from the vault. Reads the source node file, strips the matching ' +
      'relationship, writes it back, and updates the SQLite index. ' +
      'Returns { deleted: true, edge_id }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id: { type: 'string', description: 'UUID of the source node' },
        target_id: { type: 'string', description: 'UUID of the target node' },
        rel_type:  { type: 'string', description: 'Connector type key' },
      },
      required: ['source_id', 'target_id', 'rel_type'],
    },
  },
]

// ── Read tool implementations ─────────────────────────────────────────────────

function toolSearchNodes(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const query = String(args.query ?? '').trim()
  const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 100) : 20

  if (!query) return []

  const ftsQuery = buildFtsQuery(query)

  const rows = db
    .prepare(
      `SELECT
         f.entity_id AS id,
         e.name,
         e.entity_type AS type,
         e.status,
         CASE
           WHEN instr(lower(e.name),            lower(@query)) > 0 THEN 'name'
           WHEN instr(lower(f.properties_text), lower(@query)) > 0 THEN 'property'
           ELSE 'body'
         END AS match_field,
         snippet(entities_fts, 2, '[', ']', '...', 15) AS snippet,
         rank
       FROM entities_fts f
       JOIN entities e ON e.id = f.entity_id
       WHERE entities_fts MATCH @fts_query
       ORDER BY rank
       LIMIT @limit`,
    )
    .all({ query, fts_query: ftsQuery, limit }) as Row[]

  return rows.map(r => ({
    id:          str(r['id']),
    name:        str(r['name']),
    type:        str(r['type']),
    status:      str(r['status']),
    match_field: str(r['match_field']),
    snippet:     str(r['snippet']),
  }))
}

function toolGetNode(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const id = String(args.id ?? '')
  const row = db
    .prepare('SELECT data_json FROM entities WHERE id = ?')
    .get(id) as Row | undefined

  if (!row) {
    throw new McpError(ErrorCode.InvalidParams, `Node not found: ${id}`)
  }

  return JSON.parse(str(row['data_json'])) as object
}

function toolGetConnections(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const id = String(args.id ?? '')
  const dir = String(args.direction ?? 'all')

  const exists = db.prepare('SELECT 1 FROM entities WHERE id = ?').get(id)
  if (!exists) throw new McpError(ErrorCode.InvalidParams, `Node not found: ${id}`)

  const base = `
    SELECT r.edge_id, r.source_id, r.target_id, r.rel_type, r.direction,
           r.label, r.properties_json,
           se.name AS source_name, se.entity_type AS source_type,
           te.name AS target_name, te.entity_type AS target_type
    FROM relationships r
    JOIN entities se ON se.id = r.source_id
    JOIN entities te ON te.id = r.target_id`

  let rows: Row[]
  if (dir === 'outgoing') {
    rows = db.prepare(`${base} WHERE r.source_id = ?`).all(id) as Row[]
  } else if (dir === 'incoming') {
    rows = db.prepare(`${base} WHERE r.target_id = ?`).all(id) as Row[]
  } else {
    rows = db.prepare(`${base} WHERE r.source_id = ? OR r.target_id = ?`).all(id, id) as Row[]
  }

  return rows.map(r => ({
    edge_id:   str(r['edge_id']),
    source:    { id: str(r['source_id']), name: str(r['source_name']), type: str(r['source_type']) },
    target:    { id: str(r['target_id']), name: str(r['target_name']), type: str(r['target_type']) },
    rel_type:  str(r['rel_type']),
    direction: str(r['direction']),
    label:     r['label'] != null ? str(r['label']) : null,
    properties: JSON.parse(str(r['properties_json']) || '{}') as Record<string, string>,
  }))
}

function toolGetSubgraph(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const rootId = String(args.id ?? '')

  const exists = db.prepare('SELECT 1 FROM entities WHERE id = ?').get(rootId)
  if (!exists) throw new McpError(ErrorCode.InvalidParams, `Node not found: ${rootId}`)

  const depth = Math.min(
    typeof args.depth === 'number' ? Math.max(1, Math.floor(args.depth)) : 1,
    3,
  )

  const visitedNodes = new Set<string>([rootId])
  const visitedEdges = new Set<string>()
  const collectedEdges: Row[] = []

  const relStmt = db.prepare(
    `SELECT edge_id, source_id, target_id, rel_type, direction, label, properties_json
     FROM relationships
     WHERE source_id = ? OR target_id = ?`,
  )
  const nodeStmt = db.prepare('SELECT data_json FROM entities WHERE id = ?')

  let frontier = [rootId]

  for (let d = 0; d < depth; d++) {
    if (frontier.length === 0) break
    const nextFrontier: string[] = []

    for (const nodeId of frontier) {
      const rows = relStmt.all(nodeId, nodeId) as Row[]

      for (const row of rows) {
        const edgeId = str(row['edge_id'])
        if (visitedEdges.has(edgeId)) continue
        visitedEdges.add(edgeId)
        collectedEdges.push(row)

        const srcId = str(row['source_id'])
        const otherId = srcId === nodeId ? str(row['target_id']) : srcId
        if (!visitedNodes.has(otherId)) {
          visitedNodes.add(otherId)
          nextFrontier.push(otherId)
        }
      }
    }

    frontier = nextFrontier
  }

  const nodes = [...visitedNodes].flatMap(nodeId => {
    const row = nodeStmt.get(nodeId) as Row | undefined
    return row ? [JSON.parse(str(row['data_json'])) as object] : []
  })

  const edges = collectedEdges.map(r => ({
    edge_id:    str(r['edge_id']),
    source_id:  str(r['source_id']),
    target_id:  str(r['target_id']),
    rel_type:   str(r['rel_type']),
    direction:  str(r['direction']),
    label:      r['label'] != null ? str(r['label']) : null,
    properties: JSON.parse(str(r['properties_json']) || '{}') as Record<string, string>,
  }))

  return { nodes, edges }
}

function toolListNodeTypes(vaultPath: string): unknown {
  try {
    const raw = readFileSync(join(vaultPath, '.filamental', 'entity_types.json'), 'utf-8')
    return JSON.parse(raw) as object
  } catch {
    return {}
  }
}

function toolListConnectorTypes(vaultPath: string): unknown {
  try {
    const raw = readFileSync(join(vaultPath, '.filamental', 'connector_types.json'), 'utf-8')
    return JSON.parse(raw) as object
  } catch {
    return {}
  }
}

function toolGetVaultInfo(db: Database.Database, vaultPath: string): unknown {
  const nodeRow = db
    .prepare('SELECT COUNT(*) AS node_count FROM entities')
    .get() as Row
  const edgeRow = db
    .prepare('SELECT COUNT(*) AS edge_count FROM relationships')
    .get() as Row

  const nodeCount = Number(nodeRow['node_count'] ?? 0)
  const edgeCount = Number(edgeRow['edge_count'] ?? 0)

  let entityTypes: string[] = []
  let connectorTypes: string[] = []

  try {
    const raw = readFileSync(join(vaultPath, '.filamental', 'entity_types.json'), 'utf-8')
    entityTypes = Object.keys(JSON.parse(raw) as Record<string, unknown>)
  } catch { /* non-fatal */ }

  try {
    const raw = readFileSync(join(vaultPath, '.filamental', 'connector_types.json'), 'utf-8')
    connectorTypes = Object.keys(JSON.parse(raw) as Record<string, unknown>)
  } catch { /* non-fatal */ }

  return {
    node_count:      nodeCount,
    edge_count:      edgeCount,
    entity_types:    entityTypes,
    connector_types: connectorTypes,
  }
}

// ── Write tool implementations ────────────────────────────────────────────────

function toolCreateNode(
  db: Database.Database,
  vaultPath: string,
  args: Record<string, unknown>,
): unknown {
  const name = validateName(args.name)
  const entityType = typeof args.entity_type === 'string' ? args.entity_type : 'unclassified'
  const status = args.status === 'archived' ? 'archived' : 'active'
  const properties = (args.properties as Record<string, string>) ?? {}
  const notes = typeof args.notes === 'string' ? args.notes : ''
  const folder = typeof args.folder === 'string' ? args.folder : ''

  const rawRels = (args.relationships as unknown[]) ?? []
  const relationships: RelationshipRecord[] = rawRels.map(r => {
    const rel = r as Record<string, unknown>
    const out: RelationshipRecord = {
      target: String(rel['target'] ?? ''),
      rel_type: String(rel['rel_type'] ?? ''),
      direction: String(rel['direction'] ?? 'none'),
      properties: (rel['properties'] as Record<string, string>) ?? {},
    }
    if (rel['label'] != null) out.label = String(rel['label'])
    if (rel['influence'] != null) out.influence = String(rel['influence'])
    return out
  })

  const id = randomUUID()
  const now = new Date().toISOString()

  const node: NodeRecord = {
    id,
    name,
    entity_type: entityType,
    status,
    created: now,
    modified: now,
    modified_by: 'filamental-mcp',
    version: 1,
    properties,
    relationships,
    attachments: [],
    composition_mode: null,
    child_view_id: null,
    has_notes: notes.trim().length > 0,
  }

  const safeFilename = sanitiseFilename(name)
  const resolvedVault = resolve(vaultPath)
  const folderPath = folder ? resolve(vaultPath, folder) : resolvedVault

  if (folder) {
    if (folderPath !== resolvedVault && !folderPath.startsWith(resolvedVault + sep)) {
      throw new McpError(ErrorCode.InvalidParams, 'folder must not escape the vault root')
    }
  }

  mkdirSync(folderPath, { recursive: true })

  const basePath = join(folderPath, `${safeFilename}.md`)
  const filePath = findAvailablePath(basePath)

  const markdown = serialiseMarkdown(node, notes)
  writeFileSync(filePath, markdown, 'utf-8')

  upsertEntity(db, node, filePath, notes)

  return { id, file_path: filePath }
}

function toolUpdateNode(
  db: Database.Database,
  vaultPath: string,
  args: Record<string, unknown>,
): unknown {
  const id = String(args.id ?? '').trim()
  if (!id) throw new McpError(ErrorCode.InvalidParams, 'id is required')

  const entityRow = db
    .prepare('SELECT file_path, data_json FROM entities WHERE id = ?')
    .get(id) as Row | undefined

  if (!entityRow) throw new McpError(ErrorCode.InvalidParams, `Node not found: ${id}`)

  const filePath = str(entityRow['file_path'])
  let existingNode: NodeRecord
  let existingBody: string

  try {
    const parsed = parseMarkdownFile(filePath)
    existingNode = parsed.node
    existingBody = parsed.body
  } catch {
    // Fall back to data_json if file is unreadable
    existingNode = JSON.parse(str(entityRow['data_json'])) as NodeRecord
    existingBody = ''
  }

  // Snapshot before applying changes so we can skip the write if nothing changed
  const beforeSnapshot = JSON.stringify({
    name: existingNode.name,
    entity_type: existingNode.entity_type,
    status: existingNode.status,
    properties: existingNode.properties,
    relationships: existingNode.relationships,
    display_name: existingNode.display_name ?? null,
  })
  const beforeBody = existingBody

  // Apply updates — only mutate supplied fields
  if (typeof args.name === 'string') {
    existingNode.name = validateName(args.name)
  }
  if (typeof args.entity_type === 'string') {
    existingNode.entity_type = args.entity_type
  }
  if (args.status === 'active' || args.status === 'archived') {
    existingNode.status = args.status
  }
  if (args.properties != null) {
    existingNode.properties = args.properties as Record<string, string>
  }
  if (Array.isArray(args.relationships)) {
    existingNode.relationships = (args.relationships as unknown[]).map(r => {
      const rel = r as Record<string, unknown>
      const out: RelationshipRecord = {
        target: String(rel['target'] ?? ''),
        rel_type: String(rel['rel_type'] ?? ''),
        direction: String(rel['direction'] ?? 'none'),
        properties: (rel['properties'] as Record<string, string>) ?? {},
      }
      if (rel['label'] != null) out.label = String(rel['label'])
      if (rel['influence'] != null) out.influence = String(rel['influence'])
      return out
    })
  }
  if (typeof args.notes === 'string') {
    existingBody = args.notes
  }
  if (typeof args.display_name === 'string') {
    existingNode.display_name = args.display_name === '' ? null : args.display_name
  }

  const afterSnapshot = JSON.stringify({
    name: existingNode.name,
    entity_type: existingNode.entity_type,
    status: existingNode.status,
    properties: existingNode.properties,
    relationships: existingNode.relationships,
    display_name: existingNode.display_name ?? null,
  })

  const changed = afterSnapshot !== beforeSnapshot || existingBody !== beforeBody

  if (changed) {
    existingNode.modified = new Date().toISOString()
    existingNode.modified_by = 'filamental-mcp'
    existingNode.version += 1
  }

  existingNode.has_notes = existingBody.trim().length > 0

  const markdown = serialiseMarkdown(existingNode, existingBody)
  writeFileSync(filePath, markdown, 'utf-8')

  upsertEntity(db, existingNode, filePath, existingBody)

  return { id, file_path: filePath }
}

function toolDeleteNode(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const id = String(args.id ?? '').trim()
  if (!id) throw new McpError(ErrorCode.InvalidParams, 'id is required')

  const entityRow = db
    .prepare('SELECT file_path FROM entities WHERE id = ?')
    .get(id) as Row | undefined

  if (!entityRow) throw new McpError(ErrorCode.InvalidParams, `Node not found: ${id}`)

  const filePath = str(entityRow['file_path'])

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  } catch (err) {
    throw new McpError(ErrorCode.InternalError, `Failed to delete file: ${err}`)
  }

  deleteEntity(db, id)

  return { deleted: true, file_path: filePath }
}

// ── Edge tool implementations ─────────────────────────────────────────────────

function toolCreateEdge(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const sourceId = String(args.source_id ?? '').trim()
  const targetId = String(args.target_id ?? '').trim()
  const relType  = String(args.rel_type  ?? '').trim()

  if (!sourceId) throw new McpError(ErrorCode.InvalidParams, 'source_id is required')
  if (!targetId) throw new McpError(ErrorCode.InvalidParams, 'target_id is required')
  if (!relType)  throw new McpError(ErrorCode.InvalidParams, 'rel_type is required')

  // Verify both nodes exist
  const srcRow = db.prepare('SELECT file_path, data_json FROM entities WHERE id = ?').get(sourceId) as Row | undefined
  if (!srcRow) throw new McpError(ErrorCode.InvalidParams, `Source node not found: ${sourceId}`)
  const tgtExists = db.prepare('SELECT 1 FROM entities WHERE id = ?').get(targetId)
  if (!tgtExists) throw new McpError(ErrorCode.InvalidParams, `Target node not found: ${targetId}`)

  // Check for duplicate
  const edgeId = `${sourceId}__${targetId}__${relType}`
  const existing = db.prepare('SELECT 1 FROM relationships WHERE edge_id = ?').get(edgeId)
  if (existing) throw new McpError(ErrorCode.InvalidParams, `Edge already exists: ${edgeId}`)

  const filePath = str(srcRow['file_path'])
  let node: NodeRecord
  let body: string

  try {
    const parsed = parseMarkdownFile(filePath)
    node = parsed.node
    body = parsed.body
  } catch {
    node = JSON.parse(str(srcRow['data_json'])) as NodeRecord
    body = ''
  }

  const newRel: RelationshipRecord = {
    target:    targetId,
    rel_type:  relType,
    direction: String(args.direction ?? 'none'),
    properties: (args.properties as Record<string, string>) ?? {},
  }
  if (args.label    != null) newRel.label    = String(args.label)
  if (args.influence != null) newRel.influence = String(args.influence)

  node.relationships.push(newRel)
  node.modified    = new Date().toISOString()
  node.modified_by = 'filamental-mcp'
  node.version    += 1

  writeFileSync(filePath, serialiseMarkdown(node, body), 'utf-8')
  upsertEntity(db, node, filePath, body)

  return { edge_id: edgeId, source_id: sourceId, target_id: targetId }
}

function toolDeleteEdge(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const sourceId = String(args.source_id ?? '').trim()
  const targetId = String(args.target_id ?? '').trim()
  const relType  = String(args.rel_type  ?? '').trim()

  if (!sourceId) throw new McpError(ErrorCode.InvalidParams, 'source_id is required')
  if (!targetId) throw new McpError(ErrorCode.InvalidParams, 'target_id is required')
  if (!relType)  throw new McpError(ErrorCode.InvalidParams, 'rel_type is required')

  const edgeId = `${sourceId}__${targetId}__${relType}`
  const edgeRow = db.prepare('SELECT 1 FROM relationships WHERE edge_id = ?').get(edgeId)
  if (!edgeRow) throw new McpError(ErrorCode.InvalidParams, `Edge not found: ${edgeId}`)

  const srcRow = db.prepare('SELECT file_path, data_json FROM entities WHERE id = ?').get(sourceId) as Row | undefined
  if (!srcRow) throw new McpError(ErrorCode.InvalidParams, `Source node not found: ${sourceId}`)

  const filePath = str(srcRow['file_path'])
  let node: NodeRecord
  let body: string

  try {
    const parsed = parseMarkdownFile(filePath)
    node = parsed.node
    body = parsed.body
  } catch {
    node = JSON.parse(str(srcRow['data_json'])) as NodeRecord
    body = ''
  }

  const before = node.relationships.length
  node.relationships = node.relationships.filter(
    r => !(r.target === targetId && r.rel_type === relType),
  )

  if (node.relationships.length === before) {
    // Edge was in SQLite but not in file — remove from DB only (repair path)
    db.prepare('DELETE FROM relationships WHERE edge_id = ?').run(edgeId)
    return { deleted: true, edge_id: edgeId }
  }

  node.modified    = new Date().toISOString()
  node.modified_by = 'filamental-mcp'
  node.version    += 1

  writeFileSync(filePath, serialiseMarkdown(node, body), 'utf-8')
  upsertEntity(db, node, filePath, body)

  return { deleted: true, edge_id: edgeId }
}

// ── Server factory ────────────────────────────────────────────────────────────

export function createServer(db: Database.Database, vaultPath: string): Server {
  const server = new Server(
    { name: 'filamental', version: '0.2.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params
    const a = args as Record<string, unknown>

    try {
      let result: unknown
      switch (name) {
        case 'search_nodes':         result = toolSearchNodes(db, a);                    break
        case 'get_node':             result = toolGetNode(db, a);                        break
        case 'get_connections':      result = toolGetConnections(db, a);                 break
        case 'get_subgraph':         result = toolGetSubgraph(db, a);                    break
        case 'list_node_types':      result = toolListNodeTypes(vaultPath);              break
        case 'list_connector_types': result = toolListConnectorTypes(vaultPath);         break
        case 'get_vault_info':       result = toolGetVaultInfo(db, vaultPath);           break
        case 'create_node':          result = toolCreateNode(db, vaultPath, a);          break
        case 'update_node':          result = toolUpdateNode(db, vaultPath, a);          break
        case 'delete_node':          result = toolDeleteNode(db, a);                     break
        case 'create_edge':          result = toolCreateEdge(db, a);                     break
        case 'delete_edge':          result = toolDeleteEdge(db, a);                     break
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      if (err instanceof McpError) throw err
      throw new McpError(ErrorCode.InternalError, String(err))
    }
  })

  return server
}
