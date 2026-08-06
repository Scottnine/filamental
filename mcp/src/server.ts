// Filamental MCP Server — server.ts
// Tool definitions and implementations. Entry point wires this to a transport.

import { randomUUID } from 'crypto'
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join, dirname, resolve, sep } from 'path'
import { helpWorldDir } from './paths.js'
// Compiled from ai-briefing/*.md. Sent in the initialize response so the client
// hands it to the model at connect time and no user has to install a skill file.
import { INSTRUCTIONS } from './briefing.generated.js'
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

  // Rust NodeData uses #[serde(rename = "type")] for entity_type, so data_json
  // must use "type" as the key — not "entity_type" — or get_all_entities silently
  // drops the node during deserialization. RelationshipInstance has the same
  // #[serde(rename = "type")] on its rel_type field — miss that rename here too
  // and the whole node (not just its relationships) fails to parse.
  const { entity_type, ...nodeRest } = node
  const dataJson = JSON.stringify({
    ...nodeRest,
    type: entity_type,
    relationships: node.relationships.map(({ rel_type, ...relRest }) => ({
      ...relRest,
      type: rel_type,
    })),
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
      'Returns matching nodes with a contextual snippet. ' +
      'An optional `filter` narrows results by field value, and may be used on ' +
      'its own to list nodes structurally without any search terms.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search terms. Optional when `filter` is given.' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
        filter: {
          type: 'object',
          description:
            'Field filter, Mongo-shaped. Fields: name, type, status, category, ' +
            'display_name, created, modified, version, or any entity property by ' +
            'bare name (or "properties.<key>" to disambiguate). ' +
            'Field operators: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex. ' +
            'Top level: $and $or $not. A bare value means $eq. ' +
            'Numeric-looking values compare numerically. ' +
            'Example: {"type":"Person","status":{"$ne":"archived"},"role":{"$in":["dev","lead"]}}',
        },
      },
    },
  },
  {
    name: 'get_node',
    description: 'Retrieve full node data for a given entity UUID, including the markdown note body in the `notes` field.',
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
      'Get every edge connected to a node. Each result is stated from the point of ' +
      'view of the node you asked about: `node` is that node, `other` is the node at ' +
      'the far end, and `direction` says where the arrowhead is drawn as seen from ' +
      '`node` — "outgoing" points away at `other`, "incoming" points back at `node`, ' +
      '"bidirectional" points both ways, "none" is a plain line with no arrow. ' +
      'This is what the user actually sees on the graph. It is deliberately not the ' +
      'raw stored value, which is relative to whichever end the connector happened to ' +
      'be drawn from and is invisible to the user. `stored_on` names the node whose ' +
      'file holds the relationship, and matters only when editing that file directly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Entity UUID' },
        direction: {
          type: 'string',
          enum: ['all', 'outgoing', 'incoming', 'undirected'],
          description:
            'Filter by what the arrow does, as seen from this node (default "all"). ' +
            '"outgoing" = arrow points away from it, "incoming" = arrow points at it, ' +
            '"undirected" = plain line with no arrow. A bidirectional edge matches both ' +
            '"outgoing" and "incoming", because it genuinely points both ways.',
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
    name: 'get_context',
    description:
      'Assemble one readable markdown document for a node and its neighbourhood: ' +
      'the node\'s notes plus the notes of every node within `depth` hops, inlined ' +
      'with headings that track hop distance and the connector each was reached by. ' +
      'Use this instead of get_subgraph + repeated get_node when you want to READ ' +
      'the surrounding content rather than inspect graph shape. ' +
      'Set dry_run to size the result before pulling it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Root entity UUID' },
        depth: {
          type: 'number',
          description: 'Hop depth (default 1, max 3). 0 returns the root node alone.',
        },
        direction: {
          type: 'string',
          enum: ['any', 'outgoing', 'incoming'],
          description:
            'Which connectors to follow, resolved from the current node\'s end. ' +
            'Default "any" follows every connector and works on undirected graphs. ' +
            'Use "outgoing" to walk a directed hierarchy downward, "incoming" for parent context.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'When true, return node/edge counts and estimated size only, no markdown. ' +
            'Use to check the cost before pulling a large neighbourhood.',
        },
        max_chars: {
          type: 'number',
          description: 'Truncation cap for the assembled markdown (default 50000, max 200000)',
        },
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
              direction: { type: 'string', enum: ['none', 'incoming', 'outgoing'] },
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
              direction: { type: 'string', enum: ['none', 'incoming', 'outgoing'] },
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
          enum: ['none', 'outgoing', 'incoming', 'bidirectional'],
          description:
            'Where the arrowhead is drawn, stated relative to source_id → target_id. ' +
            '"outgoing" draws it at target_id, "incoming" draws it back at source_id, ' +
            '"bidirectional" draws both, "none" is a plain line with no arrow (default). ' +
            'Note these are the only accepted values — anything else is rejected.',
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
  {
    name: 'read_skill_guide',
    description:
      'Read the full Filamental skill guide: how to design a space, choose entity ' +
      'and connector vocabularies, set colours, arrow directions and physics weights, ' +
      'and the conventions that make a structure readable. The server instructions ' +
      'already carry the essentials, so reach for this when you need depth: building ' +
      'a substantial structure from scratch, or a question the essentials do not settle.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'read_format_reference',
    description:
      'Read the exact on-disk file format: the YAML frontmatter fields of a node ' +
      'markdown file, how relationships are stored, and what the .filamental folder ' +
      'holds. Needed only when reading or writing vault files directly rather than ' +
      'through these tools.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'extract_section',
    description:
      'Move a heading\'s section out of a node into a new node of its own. ' +
      'The heading stays behind with a [[wikilink]] where the content was, and a ' +
      'connector is created from the source to the new node. A section runs to the ' +
      'next heading of the same or higher level, so extracting an h2 takes its h3 ' +
      'children with it. Content is MOVED, not copied: exactly one copy survives. ' +
      'Use dry_run first to see what would move.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id:      { type: 'string', description: 'UUID of the node to extract from' },
        heading: {
          type: 'string',
          description: 'Heading text to extract, with or without leading #s. Case-insensitive.',
        },
        name: {
          type: 'string',
          description: 'Name for the new node (default: the heading text)',
        },
        entity_type: { type: 'string', description: 'Entity type for the new node' },
        folder:      { type: 'string', description: 'Vault-relative folder for the new file' },
        rel_type:    { type: 'string', description: 'Connector type (default "includes")' },
        direction: {
          type: 'string',
          enum: ['none', 'outgoing', 'incoming', 'bidirectional'],
          description: 'Connector direction from source to new node (default "outgoing")',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview the move without writing anything',
        },
      },
      required: ['id', 'heading'],
    },
  },
  {
    name: 'inline_section',
    description:
      'Fold a node\'s content back into another node: the inverse of extract_section. ' +
      'The content lands where the [[wikilink]] to it already sits, or is appended ' +
      'if there is no such link, and the connector between the two is removed. ' +
      'The target node is DELETED by default, because keeping it would leave the same ' +
      'text in two files. Deletion is refused if the target is connected to anything ' +
      'other than the source. Pass delete_target: false to keep the node as an empty ' +
      'stub instead. Use dry_run first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id: { type: 'string', description: 'UUID of the node to inline INTO' },
        target_id: { type: 'string', description: 'UUID of the node whose content moves' },
        level: {
          type: 'number',
          description: 'Heading level for the inlined section, 1-6 (default 2)',
        },
        delete_target: {
          type: 'boolean',
          description:
            'Delete the target node once its content has moved (default true). ' +
            'False leaves it in place with an empty body.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview the merge without writing anything',
        },
      },
      required: ['source_id', 'target_id'],
    },
  },
]

// ── Property filter evaluation ────────────────────────────────────────────────

/**
 * Resolve a filter field name against a node record.
 *
 * Bare names that are not one of the known top-level columns resolve to entries
 * in `properties`, so `{ role: 'lead' }` reads the way a user expects without
 * requiring the `properties.` prefix. The explicit prefix is still honoured so a
 * property that shares a name with a column (a `status` property, say) stays
 * reachable.
 */
function resolveField(node: Record<string, unknown>, field: string): unknown {
  if (field.startsWith('properties.')) {
    const props = (node['properties'] ?? {}) as Record<string, unknown>
    return props[field.slice('properties.'.length)]
  }

  switch (field) {
    case 'name':
    case 'status':
    case 'category':
    case 'display_name':
    case 'created':
    case 'modified':
    case 'version':
      return node[field]
    case 'type':
    case 'entity_type':
      // data_json stores this as "type" — the Rust NodeData renames it via
      // #[serde(rename = "type")] (see upsertEntity). Accept the TS-side spelling
      // too so a record built from NodeRecord rather than the DB also filters.
      return node['type'] ?? node['entity_type']
    default: {
      const props = (node['properties'] ?? {}) as Record<string, unknown>
      return props[field]
    }
  }
}

/**
 * Order two values.
 *
 * Properties are stored as strings, so a numeric comparison on them would
 * otherwise be lexicographic — '10' < '9' — which is wrong for every numeric
 * property a vault is likely to hold. Compare numerically whenever both sides
 * parse as finite numbers, and fall back to string order otherwise. ISO dates
 * sort correctly as strings, so they need no special case.
 */
function compareValues(a: unknown, b: unknown): number {
  const na = typeof a === 'number' ? a : Number(str(a))
  const nb = typeof b === 'number' ? b : Number(str(b))
  if (Number.isFinite(na) && Number.isFinite(nb) && str(a) !== '' && str(b) !== '') {
    return na === nb ? 0 : na < nb ? -1 : 1
  }
  const sa = str(a)
  const sb = str(b)
  return sa === sb ? 0 : sa < sb ? -1 : 1
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual == null) return expected == null
  return compareValues(actual, expected) === 0
}

/** Apply one operator object, e.g. `{ $gte: 3, $lt: 10 }`, to a single field. */
function evaluateOperators(actual: unknown, ops: Record<string, unknown>): boolean {
  for (const [op, expected] of Object.entries(ops)) {
    switch (op) {
      case '$eq':  if (!looseEquals(actual, expected)) return false; break
      case '$ne':  if (looseEquals(actual, expected)) return false; break
      case '$gt':  if (actual == null || compareValues(actual, expected) <= 0) return false; break
      case '$gte': if (actual == null || compareValues(actual, expected) <  0) return false; break
      case '$lt':  if (actual == null || compareValues(actual, expected) >= 0) return false; break
      case '$lte': if (actual == null || compareValues(actual, expected) >  0) return false; break

      case '$in':
      case '$nin': {
        if (!Array.isArray(expected)) {
          throw new McpError(ErrorCode.InvalidParams, `${op} expects an array`)
        }
        const hit = expected.some(e => looseEquals(actual, e))
        if (op === '$in' ? !hit : hit) return false
        break
      }

      case '$exists': {
        const present = actual != null && str(actual) !== ''
        if (present !== Boolean(expected)) return false
        break
      }

      case '$regex': {
        let re: RegExp
        try {
          re = new RegExp(str(expected), 'i')
        } catch {
          throw new McpError(ErrorCode.InvalidParams, `Invalid $regex: ${str(expected)}`)
        }
        if (actual == null || !re.test(str(actual))) return false
        break
      }

      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown filter operator: ${op}`)
    }
  }
  return true
}

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).some(k => k.startsWith('$'))
  )
}

/**
 * Evaluate a Mongo-shaped filter against a node record.
 *
 * Supported at field level: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex.
 * Supported at top level: $and $or $not. A bare value is shorthand for $eq.
 */
export function evaluateFilter(node: Record<string, unknown>, filter: unknown): boolean {
  if (filter == null) return true
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new McpError(ErrorCode.InvalidParams, 'filter must be an object')
  }

  for (const [key, condition] of Object.entries(filter as Record<string, unknown>)) {
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(condition)) {
        throw new McpError(ErrorCode.InvalidParams, `${key} expects an array of filters`)
      }
      const results = condition.map(c => evaluateFilter(node, c))
      if (key === '$and' ? !results.every(Boolean) : !results.some(Boolean)) return false
      continue
    }

    if (key === '$not') {
      if (evaluateFilter(node, condition)) return false
      continue
    }

    if (key.startsWith('$')) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown top-level filter operator: ${key}`)
    }

    const actual = resolveField(node, key)
    const ok = isOperatorObject(condition)
      ? evaluateOperators(actual, condition)
      : looseEquals(actual, condition)
    if (!ok) return false
  }

  return true
}

// ── Read tool implementations ─────────────────────────────────────────────────

export function toolSearchNodes(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const query = String(args.query ?? '').trim()
  const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 100) : 20
  const filter = args.filter ?? null

  // Unchanged from before `filter` existed: no query and no filter is not a
  // request to return the whole vault.
  if (!query && filter == null) return []

  // With a filter the LIMIT can no longer be pushed into SQL — rows are dropped
  // after the query runs, so limiting first would silently under-return. Pull a
  // wider candidate set, filter, then trim.
  const candidateLimit = filter == null ? limit : Math.min(Math.max(limit * 20, 200), 2000)

  let rows: Row[]

  if (query) {
    const ftsQuery = buildFtsQuery(query)
    rows = db
      .prepare(
        `SELECT
           f.entity_id AS id,
           e.name,
           e.entity_type AS type,
           e.status,
           e.data_json,
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
      .all({ query, fts_query: ftsQuery, limit: candidateLimit }) as Row[]
  } else {
    // Filter-only search: no text to rank by, so order by name for a stable result.
    rows = db
      .prepare(
        `SELECT id, name, entity_type AS type, status, data_json,
                'filter' AS match_field, '' AS snippet
         FROM entities
         ORDER BY name
         LIMIT @limit`,
      )
      .all({ limit: candidateLimit }) as Row[]
  }

  const matched =
    filter == null
      ? rows
      : rows.filter(r => {
          const data = JSON.parse(str(r['data_json']) || '{}') as Record<string, unknown>
          return evaluateFilter(data, filter)
        })

  return matched.slice(0, limit).map(r => ({
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
    .prepare('SELECT file_path, data_json FROM entities WHERE id = ?')
    .get(id) as Row | undefined

  if (!row) {
    throw new McpError(ErrorCode.InvalidParams, `Node not found: ${id}`)
  }

  const data = JSON.parse(str(row['data_json'])) as Record<string, unknown>

  let notes = ''
  try {
    notes = parseMarkdownFile(str(row['file_path'])).body
  } catch {
    // file unreadable — return metadata without notes
  }

  return { ...data, notes }
}

/** The only direction values the app understands. Anything else is not an arrow. */
const DIRECTIONS = ['none', 'outgoing', 'incoming', 'bidirectional'] as const

/**
 * Reject a direction the app cannot render rather than writing it through.
 * `direction` is an untyped String in the Rust layer, so a bad value would be
 * stored happily and then draw as a plain line — the caller would believe it had
 * set an arrow that does not exist.
 */
function parseDirection(raw: unknown): string {
  if (raw == null) return 'none'
  const value = String(raw)
  if (!(DIRECTIONS as readonly string[]).includes(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid direction "${value}". Expected one of: ${DIRECTIONS.join(', ')}.`,
    )
  }
  return value
}

/**
 * How an edge's arrow reads from `nodeId`'s end.
 *
 * The stored value is relative to the edge's own source → target, which is set
 * by whichever end happened to be drawn first and is invisible to the user. The
 * same arrow therefore reads as 'outgoing' from one end and 'incoming' from the
 * other, so it has to be flipped when the queried node is the target. Mirrors
 * src/utils/edgeDirection.ts on the app side.
 */
function effectiveDirection(stored: string, sourceId: string, nodeId: string): string {
  const dir = (DIRECTIONS as readonly string[]).includes(stored) ? stored : 'none'
  if (sourceId === nodeId) return dir
  if (dir === 'outgoing') return 'incoming'
  if (dir === 'incoming') return 'outgoing'
  return dir
}

/** Filter on what the arrow does, not on which end is stored first. */
function matchesDirectionFilter(effective: string, filter: string): boolean {
  switch (filter) {
    // A bidirectional arrow genuinely points both ways, so it matches both.
    case 'outgoing':   return effective === 'outgoing' || effective === 'bidirectional'
    case 'incoming':   return effective === 'incoming' || effective === 'bidirectional'
    case 'undirected': return effective === 'none'
    default:           return true
  }
}

function toolGetConnections(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const id = String(args.id ?? '')
  const filter = String(args.direction ?? 'all')

  const exists = db.prepare('SELECT 1 FROM entities WHERE id = ?').get(id)
  if (!exists) throw new McpError(ErrorCode.InvalidParams, `Node not found: ${id}`)

  // Always fetch both ends. Which end is stored as source is an artefact of how
  // the connector was drawn, so it must not decide what the caller sees.
  const rows = db.prepare(`
    SELECT r.edge_id, r.source_id, r.target_id, r.rel_type, r.direction,
           r.label, r.properties_json,
           se.name AS source_name, se.entity_type AS source_type,
           te.name AS target_name, te.entity_type AS target_type
    FROM relationships r
    JOIN entities se ON se.id = r.source_id
    JOIN entities te ON te.id = r.target_id
    WHERE r.source_id = ? OR r.target_id = ?`).all(id, id) as Row[]

  return rows
    .map(r => {
      const sourceId = str(r['source_id'])
      const isSource = sourceId === id
      const self  = isSource
        ? { id: sourceId,             name: str(r['source_name']), type: str(r['source_type']) }
        : { id: str(r['target_id']),  name: str(r['target_name']), type: str(r['target_type']) }
      const other = isSource
        ? { id: str(r['target_id']),  name: str(r['target_name']), type: str(r['target_type']) }
        : { id: sourceId,             name: str(r['source_name']), type: str(r['source_type']) }

      return {
        edge_id:    str(r['edge_id']),
        rel_type:   str(r['rel_type']),
        node:       self,
        other:      other,
        direction:  effectiveDirection(str(r['direction']), sourceId, id),
        label:      r['label'] != null ? str(r['label']) : null,
        properties: JSON.parse(str(r['properties_json']) || '{}') as Record<string, string>,
        // Which node's .md file physically holds this relationship. Needed only
        // when editing the file directly; it says nothing about the arrow.
        stored_on:  sourceId,
      }
    })
    .filter(c => matchesDirectionFilter(c.direction, filter))
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

/** One node as it appears in an assembled context document. */
interface ContextEntry {
  id: string
  name: string
  type: string
  hop: number
  /** How this node was reached. Null for the root. */
  via: { from: string; rel_type: string; label: string | null; direction: string } | null
  body: string
}

/**
 * Assemble a readable markdown document for a node and everything around it.
 *
 * `get_subgraph` answers "what is the shape here" and returns nodes and edges;
 * answering "what does this say" from that costs one `get_node` call per node.
 * This walks the same BFS but inlines the note bodies, so a caller gets the
 * whole readable neighbourhood in one round trip.
 */
export function toolGetContext(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const rootId = String(args.id ?? '')

  const rootRow = db
    .prepare('SELECT data_json FROM entities WHERE id = ?')
    .get(rootId) as Row | undefined
  if (!rootRow) throw new McpError(ErrorCode.InvalidParams, `Node not found: ${rootId}`)

  const depth = Math.min(
    typeof args.depth === 'number' ? Math.max(0, Math.floor(args.depth)) : 1,
    3,
  )
  const dryRun = args.dry_run === true
  const maxChars = Math.min(
    typeof args.max_chars === 'number' ? Math.max(1000, Math.floor(args.max_chars)) : 50000,
    200000,
  )

  const directionArg = String(args.direction ?? 'any')
  if (!['any', 'outgoing', 'incoming'].includes(directionArg)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid direction "${directionArg}". Expected one of: any, outgoing, incoming.`,
    )
  }
  // `matchesDirectionFilter` treats anything it does not recognise as "match
  // everything", which is exactly what 'any' should do.
  const dirFilter = directionArg === 'any' ? 'all' : directionArg

  const relStmt = db.prepare(
    `SELECT edge_id, source_id, target_id, rel_type, direction, label
     FROM relationships
     WHERE source_id = ? OR target_id = ?`,
  )
  const nodeStmt = db.prepare('SELECT file_path, data_json FROM entities WHERE id = ?')

  /** Read a node's metadata and note body. Missing files degrade to empty text. */
  function loadEntry(
    id: string,
    hop: number,
    via: ContextEntry['via'],
  ): ContextEntry | null {
    const row = nodeStmt.get(id) as Row | undefined
    if (!row) return null
    const data = JSON.parse(str(row['data_json']) || '{}') as Record<string, unknown>
    let body = ''
    try {
      body = parseMarkdownFile(str(row['file_path'])).body.trim()
    } catch {
      // Unreadable or unparseable file — keep the node, drop the text.
    }
    return {
      id,
      name: str(data['name']),
      // "type" is the key in data_json; see the serde note in upsertEntity.
      type: str(data['type'] ?? data['entity_type']),
      hop,
      via,
      body,
    }
  }

  const rootEntry = loadEntry(rootId, 0, null)
  if (!rootEntry) throw new McpError(ErrorCode.InvalidParams, `Node not found: ${rootId}`)

  const entries: ContextEntry[] = [rootEntry]
  const visitedNodes = new Set<string>([rootId])
  const visitedEdges = new Set<string>()
  let edgeCount = 0

  let frontier: Array<{ id: string; name: string }> = [{ id: rootId, name: rootEntry.name }]

  for (let d = 0; d < depth; d++) {
    if (frontier.length === 0) break
    const nextFrontier: Array<{ id: string; name: string }> = []

    for (const current of frontier) {
      const rows = relStmt.all(current.id, current.id) as Row[]

      for (const row of rows) {
        const edgeId = str(row['edge_id'])
        const srcId = str(row['source_id'])

        // Resolve the arrow from this node's end before filtering. Which end is
        // stored as source is an artefact of drawing order, so filtering on
        // source_id here would drop half the graph.
        const effective = effectiveDirection(str(row['direction']), srcId, current.id)
        if (!matchesDirectionFilter(effective, dirFilter)) continue

        if (!visitedEdges.has(edgeId)) {
          visitedEdges.add(edgeId)
          edgeCount++
        }

        const otherId = srcId === current.id ? str(row['target_id']) : srcId
        if (visitedNodes.has(otherId)) continue
        visitedNodes.add(otherId)

        const entry = loadEntry(otherId, d + 1, {
          from: current.name,
          rel_type: str(row['rel_type']),
          label: row['label'] != null ? str(row['label']) : null,
          direction: effective,
        })
        if (!entry) continue

        entries.push(entry)
        nextFrontier.push({ id: otherId, name: entry.name })
      }
    }

    frontier = nextFrontier
  }

  // Render. Heading level tracks hop distance so the hierarchy is visible.
  const sections = entries.map(e => {
    const hashes = '#'.repeat(Math.min(e.hop + 1, 6))
    const relation = e.via
      ? ` — ${e.via.rel_type}${e.via.label ? ` (${e.via.label})` : ''} from ${e.via.from}`
      : ''
    const header = `${hashes} ${e.name} [${e.type}]${relation}`
    return e.body ? `${header}\n\n${e.body}` : `${header}\n\n_(no notes)_`
  })

  const full = sections.join('\n\n')
  const truncated = full.length > maxChars

  if (dryRun) {
    return {
      root: { id: rootEntry.id, name: rootEntry.name, type: rootEntry.type },
      node_count: entries.length,
      edge_count: edgeCount,
      estimated_chars: full.length,
      would_truncate: truncated,
      max_chars: maxChars,
    }
  }

  return {
    root: { id: rootEntry.id, name: rootEntry.name, type: rootEntry.type },
    node_count: entries.length,
    edge_count: edgeCount,
    char_count: Math.min(full.length, maxChars),
    truncated,
    markdown: truncated ? `${full.slice(0, maxChars)}\n\n_[truncated at max_chars]_` : full,
  }
}

/**
 * Drop a leading YAML frontmatter block.
 *
 * The reference documents are themselves nodes in the help vault, so they carry
 * the usual frontmatter: ids, timestamps, relationships. That is vault
 * bookkeeping, and sending it to a model is pure noise ahead of the prose.
 * A document with no frontmatter, or an unterminated block, is returned intact.
 */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---\n')) return raw.trim()
  const close = raw.indexOf('\n---\n', 4)
  if (close === -1) return raw.trim()
  return raw.slice(close + 5).trim()
}

/**
 * Serve one of the reference documents the desktop app installs.
 *
 * These are the same files the app offers as downloads and the same ones the
 * in-app assistant reads, so an MCP client gets identical depth without the user
 * having to install anything. The directory belongs to the app rather than this
 * package, so absence is an expected state, not a failure.
 */
export function readReferenceDoc(filename: string, label: string): unknown {
  const path = join(helpWorldDir(), filename)
  try {
    return { filename, content: stripFrontmatter(readFileSync(path, 'utf-8')) }
  } catch {
    return {
      filename,
      content: null,
      error:
        `The ${label} is not available. It ships with the Filamental desktop app ` +
        `and is expected at ${path}. Continue using the tool descriptions and the ` +
        `server instructions, which cover the essentials.`,
    }
  }
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
    direction: parseDirection(args.direction),
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

// ── Markdown section surgery ──────────────────────────────────────────────────

/**
 * Which lines of a body are inside a fenced code block.
 *
 * Headings are found by line prefix, and a '# comment' inside a shell or Python
 * fence looks exactly like an h1. Without this, extracting a section from a note
 * containing code would cut the document at the wrong place.
 */
function fencedLines(lines: string[]): boolean[] {
  const inFence: boolean[] = new Array(lines.length).fill(false)
  let fence: string | null = null

  lines.forEach((line, i) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence == null && m) {
      fence = m[1]![0]!
      inFence[i] = true
      return
    }
    if (fence != null) {
      inFence[i] = true
      // A closing fence is the same character, at least as long, nothing after it.
      if (m && m[1]![0] === fence && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)) fence = null
    }
  })

  return inFence
}

interface FoundSection {
  level: number
  title: string
  /** Line index of the heading itself. */
  start: number
  /** Exclusive line index where the section ends. */
  end: number
  /** Section text with the heading line removed. */
  content: string
}

/** Normalise a heading for matching: strip #s, trim, casefold. */
function normaliseHeading(raw: string): string {
  return raw.replace(/^\s*#+\s*/, '').trim().toLowerCase()
}

/**
 * Locate a heading and the extent of its section.
 *
 * A section runs from its heading to the next heading of the same or higher
 * level, so extracting an h2 takes its h3 children with it.
 */
function findSection(body: string, heading: string): FoundSection | null {
  const lines = body.split('\n')
  const fenced = fencedLines(lines)
  const wanted = normaliseHeading(heading)

  let start = -1
  let level = 0

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!)
    if (!m) continue
    if (normaliseHeading(m[2]!) === wanted) {
      start = i
      level = m[1]!.length
      break
    }
  }

  if (start === -1) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (fenced[i]) continue
    const m = /^(#{1,6})\s+/.exec(lines[i]!)
    if (m && m[1]!.length <= level) {
      end = i
      break
    }
  }

  return {
    level,
    title: /^#{1,6}\s+(.*)$/.exec(lines[start]!)![1]!.trim(),
    start,
    end,
    content: lines.slice(start + 1, end).join('\n').trim(),
  }
}

/** Splice a replacement block in place of lines [start, end). */
function replaceLines(body: string, start: number, end: number, replacement: string[]): string {
  const lines = body.split('\n')
  lines.splice(start, end - start, ...replacement)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Persist a node's frontmatter and body, and refresh its index row. */
function writeNode(
  db: Database.Database,
  filePath: string,
  node: NodeRecord,
  body: string,
): void {
  node.modified = new Date().toISOString()
  node.modified_by = 'filamental-mcp'
  node.version += 1
  node.has_notes = body.trim().length > 0
  writeFileSync(filePath, serialiseMarkdown(node, body), 'utf-8')
  upsertEntity(db, node, filePath, body)
}

/** Load a node from its file, falling back to the index row if the file is bad. */
function loadNodeForEdit(
  db: Database.Database,
  id: string,
  what: string,
): { node: NodeRecord; body: string; filePath: string } {
  const row = db
    .prepare('SELECT file_path, data_json FROM entities WHERE id = ?')
    .get(id) as Row | undefined
  if (!row) throw new McpError(ErrorCode.InvalidParams, `${what} not found: ${id}`)

  const filePath = str(row['file_path'])
  try {
    const parsed = parseMarkdownFile(filePath)
    return { node: parsed.node, body: parsed.body, filePath }
  } catch {
    return {
      node: JSON.parse(str(row['data_json'])) as NodeRecord,
      body: '',
      filePath,
    }
  }
}

/**
 * Move a heading's section out of a node into a new node of its own, leaving a
 * wikilink behind and creating a connector between the two.
 *
 * Content is moved, never copied: the section is removed from the source in the
 * same operation that writes it to the new node, so there is still exactly one
 * copy of it in the vault.
 */
export function toolExtractSection(
  db: Database.Database,
  vaultPath: string,
  args: Record<string, unknown>,
): unknown {
  const id = String(args.id ?? '').trim()
  const heading = String(args.heading ?? '').trim()
  if (!id) throw new McpError(ErrorCode.InvalidParams, 'id is required')
  if (!heading) throw new McpError(ErrorCode.InvalidParams, 'heading is required')

  const { node, body, filePath } = loadNodeForEdit(db, id, 'Node')

  const section = findSection(body, heading)
  if (!section) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Heading not found in node ${id}: "${heading}"`,
    )
  }
  if (!section.content) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Section "${section.title}" is empty; nothing to extract.`,
    )
  }

  const newName = typeof args.name === 'string' && args.name.trim()
    ? args.name.trim()
    : section.title
  const relType = String(args.rel_type ?? 'includes').trim() || 'includes'
  const direction = parseDirection(args.direction ?? 'outgoing')

  if (args.dry_run === true) {
    return {
      would_create: { name: newName, entity_type: args.entity_type ?? 'unclassified' },
      section: { title: section.title, level: section.level, chars: section.content.length },
      source: { id, name: node.name, file_path: filePath },
      rel_type: relType,
      direction,
      preview: section.content.slice(0, 500),
    }
  }

  const created = toolCreateNode(db, vaultPath, {
    name: newName,
    entity_type: args.entity_type,
    notes: section.content,
    folder: args.folder,
  }) as { id: string; file_path: string }

  // Leave the heading in place so the document still reads, with a wikilink
  // where the content used to be.
  const newBody = replaceLines(body, section.start, section.end, [
    '#'.repeat(section.level) + ' ' + section.title,
    '',
    `[[${newName}]]`,
    '',
  ])

  node.relationships.push({
    target: created.id,
    rel_type: relType,
    direction,
    properties: {},
  })

  writeNode(db, filePath, node, newBody)

  return {
    extracted_node: { id: created.id, name: newName, file_path: created.file_path },
    source: { id, name: node.name, file_path: filePath },
    edge: { source_id: id, target_id: created.id, rel_type: relType, direction },
    chars_moved: section.content.length,
  }
}

/**
 * Fold a node's content back into another node: the inverse of extract_section.
 *
 * The target is deleted by default, because leaving it would put the same text
 * in two files and the vault's rule is that a `.md` file is the one copy of its
 * content. Deletion is refused when the target is connected to anything besides
 * the source, since that would silently break relationships this operation was
 * never asked to touch.
 */
export function toolInlineSection(
  db: Database.Database,
  args: Record<string, unknown>,
): unknown {
  const sourceId = String(args.source_id ?? '').trim()
  const targetId = String(args.target_id ?? '').trim()
  if (!sourceId) throw new McpError(ErrorCode.InvalidParams, 'source_id is required')
  if (!targetId) throw new McpError(ErrorCode.InvalidParams, 'target_id is required')
  if (sourceId === targetId) {
    throw new McpError(ErrorCode.InvalidParams, 'source_id and target_id must differ')
  }

  const src = loadNodeForEdit(db, sourceId, 'Source node')
  const tgt = loadNodeForEdit(db, targetId, 'Target node')

  const deleteTarget = args.delete_target !== false

  // Connections the target has to anything other than the source.
  const foreignEdges = (
    db.prepare(
      `SELECT edge_id, source_id, target_id FROM relationships
       WHERE (source_id = @t OR target_id = @t)
         AND NOT (source_id = @s AND target_id = @t)
         AND NOT (source_id = @t AND target_id = @s)`,
    ).all({ t: targetId, s: sourceId }) as Row[]
  ).map(r => str(r['edge_id']))

  if (deleteTarget && foreignEdges.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Refusing to delete "${tgt.node.name}": it is still connected to ` +
        `${foreignEdges.length} other node(s). Inline it with delete_target: false ` +
        `to keep the node, or remove those connectors first.`,
    )
  }

  const level = typeof args.level === 'number' ? Math.min(Math.max(1, args.level), 6) : 2
  const sectionLines = [
    '#'.repeat(level) + ' ' + tgt.node.name,
    '',
    tgt.body.trim(),
    '',
  ]

  // Prefer to land the content where the wikilink already points, so the
  // document keeps its shape. Fall back to appending.
  const lines = src.body.split('\n')
  const linkIdx = lines.findIndex(
    l => l.trim() === `[[${tgt.node.name}]]`,
  )

  const newBody =
    linkIdx === -1
      ? `${src.body.trim()}\n\n${sectionLines.join('\n')}`.replace(/\n{3,}/g, '\n\n').trim()
      : replaceLines(src.body, linkIdx, linkIdx + 1, sectionLines)

  if (args.dry_run === true) {
    return {
      would_inline: { id: targetId, name: tgt.node.name, chars: tgt.body.trim().length },
      into: { id: sourceId, name: src.node.name },
      placement: linkIdx === -1 ? 'appended' : 'replaced wikilink in place',
      delete_target: deleteTarget,
      foreign_edges: foreignEdges.length,
      preview: newBody.slice(0, 500),
    }
  }

  // Drop connectors between the two that live on the source's file.
  src.node.relationships = src.node.relationships.filter(r => r.target !== targetId)

  writeNode(db, src.filePath, src.node, newBody)

  let deleted = false
  if (deleteTarget) {
    toolDeleteNode(db, { id: targetId })
    deleted = true
  } else {
    // Content moved out, so the target must not keep a second copy of it.
    writeNode(db, tgt.filePath, tgt.node, '')
  }

  return {
    inlined: { id: targetId, name: tgt.node.name },
    into: { id: sourceId, name: src.node.name, file_path: src.filePath },
    placement: linkIdx === -1 ? 'appended' : 'replaced wikilink in place',
    target_deleted: deleted,
    chars_moved: tgt.body.trim().length,
  }
}

// ── Connection briefing ───────────────────────────────────────────────────────

// ── Server factory ────────────────────────────────────────────────────────────

export function createServer(
  getDb: () => Database.Database,
  getVaultPath: () => string,
  getSchemaHint: () => string | null,
): Server {
  const server = new Server(
    { name: 'filamental', version: '0.2.9' },
    // `instructions` is delivered in the initialize response and surfaced to the
    // model by the client, so the user does not have to install anything for the
    // assistant to know how a Filamental space works.
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params
    const a = args as Record<string, unknown>

    // Resolve db and vaultPath fresh on every call so vault switches are transparent
    const db        = getDb()
    const vaultPath = getVaultPath()

    try {
      let result: unknown
      switch (name) {
        case 'search_nodes':         result = toolSearchNodes(db, a);                    break
        case 'get_node':             result = toolGetNode(db, a);                        break
        case 'get_connections':      result = toolGetConnections(db, a);                 break
        case 'get_subgraph':         result = toolGetSubgraph(db, a);                    break
        case 'get_context':          result = toolGetContext(db, a);                     break
        case 'list_node_types':      result = toolListNodeTypes(vaultPath);              break
        case 'list_connector_types': result = toolListConnectorTypes(vaultPath);         break
        case 'get_vault_info':       result = toolGetVaultInfo(db, vaultPath);           break
        case 'create_node':          result = toolCreateNode(db, vaultPath, a);          break
        case 'update_node':          result = toolUpdateNode(db, vaultPath, a);          break
        case 'delete_node':          result = toolDeleteNode(db, a);                     break
        case 'create_edge':          result = toolCreateEdge(db, a);                     break
        case 'delete_edge':          result = toolDeleteEdge(db, a);                     break
        case 'read_skill_guide':
          result = readReferenceDoc('filamental_SKILL.md', 'skill guide')
          break
        case 'read_format_reference':
          result = readReferenceDoc('filamental_format_reference.md', 'format reference')
          break
        case 'extract_section':      result = toolExtractSection(db, vaultPath, a);      break
        case 'inline_section':       result = toolInlineSection(db, a);                  break
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      if (err instanceof McpError) throw err
      // Append version hint only if there is one — keeps the message clean when versions match
      const hint = getSchemaHint()
      const base = String(err)
      throw new McpError(
        ErrorCode.InternalError,
        hint ? `${base}\n\n${hint}` : base,
      )
    }
  })

  return server
}
