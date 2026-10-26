// Tests for the MCP server's read-only additions: property filtering and
// composed context retrieval.
//
// This suite is deliberately separate from the app's Vitest suite. That one is
// scoped to the repo's `src/` directory by `dir:` in vitest.config.ts, and the
// MCP server is a standalone npm package with its own build — so it gets its own
// runner (node:test via tsx) rather than being pulled into the app's config.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

import {
  evaluateFilter, parseMarkdownFile, serialiseMarkdownOver, toolGetContext, toolFindPath, toolGetStructureReport,
} from '../server.js'

// ── evaluateFilter ────────────────────────────────────────────────────────────

// Mirrors the real shape of the `data_json` column: the entity type is stored
// under "type", because the Rust NodeData renames it with #[serde(rename="type")].
// Writing "entity_type" here instead would make these tests pass against a shape
// no vault actually produces.
const alice = {
  id: 'a',
  name: 'Alice',
  type: 'Person',
  status: 'active',
  version: 3,
  properties: { role: 'lead', headcount: '9', joined: '2024-03-01' },
}

describe('evaluateFilter', () => {
  test('null filter matches everything', () => {
    assert.equal(evaluateFilter(alice, null), true)
  })

  test('bare value is shorthand for $eq', () => {
    assert.equal(evaluateFilter(alice, { name: 'Alice' }), true)
    assert.equal(evaluateFilter(alice, { name: 'Bob' }), false)
  })

  test('entity type resolves under both spellings', () => {
    assert.equal(evaluateFilter(alice, { type: 'Person' }), true)
    assert.equal(evaluateFilter(alice, { entity_type: 'Person' }), true)
    assert.equal(evaluateFilter(alice, { type: 'Place' }), false)
    // Fallback path, for a record built from the TS NodeRecord rather than the DB.
    const tsShaped = { name: 'Bob', entity_type: 'Place', properties: {} }
    assert.equal(evaluateFilter(tsShaped, { type: 'Place' }), true)
  })

  test('bare unknown keys resolve to properties', () => {
    assert.equal(evaluateFilter(alice, { role: 'lead' }), true)
    assert.equal(evaluateFilter(alice, { 'properties.role': 'lead' }), true)
    assert.equal(evaluateFilter(alice, { role: 'junior' }), false)
  })

  test('all field conditions must hold (implicit AND)', () => {
    assert.equal(evaluateFilter(alice, { type: 'Person', role: 'lead' }), true)
    assert.equal(evaluateFilter(alice, { type: 'Person', role: 'junior' }), false)
  })

  test('comparison operators', () => {
    assert.equal(evaluateFilter(alice, { status: { $ne: 'archived' } }), true)
    assert.equal(evaluateFilter(alice, { version: { $gte: 3, $lt: 10 } }), true)
    assert.equal(evaluateFilter(alice, { version: { $gt: 3 } }), false)
  })

  test('numeric-looking property strings compare numerically, not lexically', () => {
    // The bug this guards: '9' < '10' is false as a string comparison.
    assert.equal(evaluateFilter(alice, { headcount: { $lt: '10' } }), true)
    assert.equal(evaluateFilter(alice, { headcount: { $lt: 10 } }), true)
    assert.equal(evaluateFilter(alice, { headcount: { $gt: 10 } }), false)
  })

  test('ISO date strings order correctly', () => {
    assert.equal(evaluateFilter(alice, { joined: { $gte: '2024-01-01' } }), true)
    assert.equal(evaluateFilter(alice, { joined: { $gte: '2025-01-01' } }), false)
  })

  test('$in and $nin', () => {
    assert.equal(evaluateFilter(alice, { role: { $in: ['dev', 'lead'] } }), true)
    assert.equal(evaluateFilter(alice, { role: { $nin: ['dev', 'lead'] } }), false)
    assert.equal(evaluateFilter(alice, { role: { $in: ['dev'] } }), false)
  })

  test('$exists distinguishes missing from empty', () => {
    assert.equal(evaluateFilter(alice, { role: { $exists: true } }), true)
    assert.equal(evaluateFilter(alice, { nonesuch: { $exists: true } }), false)
    assert.equal(evaluateFilter(alice, { nonesuch: { $exists: false } }), true)
    const blank = { ...alice, properties: { role: '' } }
    assert.equal(evaluateFilter(blank, { role: { $exists: true } }), false)
  })

  test('$regex is case-insensitive', () => {
    assert.equal(evaluateFilter(alice, { name: { $regex: '^ali' } }), true)
    assert.equal(evaluateFilter(alice, { name: { $regex: 'zzz' } }), false)
  })

  test('$or, $and, $not', () => {
    assert.equal(evaluateFilter(alice, { $or: [{ type: 'Place' }, { type: 'Person' }] }), true)
    assert.equal(evaluateFilter(alice, { $or: [{ type: 'Place' }, { type: 'Thing' }] }), false)
    assert.equal(evaluateFilter(alice, { $and: [{ type: 'Person' }, { role: 'lead' }] }), true)
    assert.equal(evaluateFilter(alice, { $not: { type: 'Place' } }), true)
    assert.equal(evaluateFilter(alice, { $not: { type: 'Person' } }), false)
  })

  test('missing fields do not satisfy ordering comparisons', () => {
    assert.equal(evaluateFilter(alice, { nonesuch: { $gte: 1 } }), false)
  })

  test('unknown operators are rejected rather than silently ignored', () => {
    assert.throws(() => evaluateFilter(alice, { role: { $bogus: 1 } }))
    assert.throws(() => evaluateFilter(alice, { $bogus: 1 }))
    assert.throws(() => evaluateFilter(alice, { role: { $in: 'not-an-array' } }))
  })
})

// ── toolGetContext ────────────────────────────────────────────────────────────

/**
 * Build a throwaway vault: three nodes in a line, A -> B -> C, with the C edge
 * deliberately stored target-first so the direction-resolution path is exercised.
 */
function buildFixture(bodyPadding = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'filamental-mcp-test-'))
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, file_path TEXT NOT NULL, name TEXT NOT NULL,
      entity_type TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      modified TEXT NOT NULL, file_mtime_secs INTEGER NOT NULL DEFAULT 0,
      data_json TEXT NOT NULL
    );
    CREATE TABLE relationships (
      edge_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      rel_type TEXT NOT NULL, direction TEXT NOT NULL, label TEXT,
      influence TEXT, edge_order INTEGER, properties_json TEXT NOT NULL DEFAULT '{}'
    );
  `)

  const addNode = (id: string, name: string, body: string) => {
    const filePath = join(dir, `${id}.md`)
    writeFileSync(
      filePath,
      `---\nid: ${id}\nname: ${name}\nentity_type: Person\nstatus: active\n---\n\n${body}\n`,
      'utf-8',
    )
    // "type", not "entity_type" — see the note on the `alice` fixture above.
    const data = {
      id, name, type: 'Person', status: 'active',
      version: 1, properties: {}, relationships: [],
    }
    db.prepare(
      `INSERT INTO entities (id, file_path, name, entity_type, status, version, modified, data_json)
       VALUES (?, ?, ?, ?, ?, 1, '2026-01-01', ?)`,
    ).run(id, filePath, name, 'Person', 'active', JSON.stringify(data))
  }

  const pad = bodyPadding > 0 ? `\n${'x'.repeat(bodyPadding)}` : ''
  addNode('a', 'Alice', `Alice body text.${pad}`)
  addNode('b', 'Bob', `Bob body text.${pad}`)
  addNode('c', 'Carol', `Carol body text.${pad}`)

  // A -> B, stored source-first.
  db.prepare(
    `INSERT INTO relationships (edge_id, source_id, target_id, rel_type, direction, label)
     VALUES ('e1', 'a', 'b', 'knows', 'outgoing', NULL)`,
  ).run()

  // B -> C, but stored with C as source. Read from B this must resolve to
  // 'outgoing'; a naive source_id check would miss it entirely.
  db.prepare(
    `INSERT INTO relationships (edge_id, source_id, target_id, rel_type, direction, label)
     VALUES ('e2', 'c', 'b', 'reports_to', 'incoming', 'line manager')`,
  ).run()

  return { db, dir }
}

describe('toolGetContext', () => {
  test('depth 0 returns the root alone, with its notes inlined', () => {
    const { db, dir } = buildFixture()
    try {
      const r = toolGetContext(db, { id: 'a', depth: 0 }) as any
      assert.equal(r.node_count, 1)
      assert.match(r.markdown, /# Alice \[Person\]/)
      assert.match(r.markdown, /Alice body text\./)
      assert.doesNotMatch(r.markdown, /Bob body text\./)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('depth 1 inlines neighbours and names the connector', () => {
    const { db, dir } = buildFixture()
    try {
      const r = toolGetContext(db, { id: 'a', depth: 1 }) as any
      assert.equal(r.node_count, 2)
      assert.match(r.markdown, /Alice body text\./)
      assert.match(r.markdown, /## Bob \[Person\] — knows from Alice/)
      assert.match(r.markdown, /Bob body text\./)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('traversal resolves direction from the queried end, not the stored source', () => {
    const { db, dir } = buildFixture()
    try {
      // e2 is stored c -> b. Walking outgoing from A must still reach Carol at
      // hop 2 via B, because from B's end that arrow reads as outgoing.
      const r = toolGetContext(db, { id: 'a', depth: 2, direction: 'outgoing' }) as any
      assert.equal(r.node_count, 3)
      assert.match(r.markdown, /### Carol \[Person\] — reports_to \(line manager\) from Bob/)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dry_run reports size without returning content', () => {
    const { db, dir } = buildFixture()
    try {
      const dry = toolGetContext(db, { id: 'a', depth: 2, dry_run: true }) as any
      const wet = toolGetContext(db, { id: 'a', depth: 2 }) as any
      assert.equal(dry.markdown, undefined)
      assert.equal(dry.node_count, wet.node_count)
      assert.equal(dry.estimated_chars, wet.markdown.length)
      assert.equal(dry.would_truncate, false)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('max_chars truncates, flags it, and dry_run predicts it', () => {
    // Each body is padded past the 1000-char floor so the cap can actually bite.
    const { db, dir } = buildFixture(1200)
    try {
      const r = toolGetContext(db, { id: 'a', depth: 2, max_chars: 1000 }) as any
      assert.equal(r.truncated, true)
      assert.equal(r.char_count, 1000)
      assert.match(r.markdown, /_\[truncated at max_chars\]_$/)

      const dry = toolGetContext(db, {
        id: 'a', depth: 2, max_chars: 1000, dry_run: true,
      }) as any
      assert.equal(dry.would_truncate, true)
      assert.ok(dry.estimated_chars > 1000)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unreadable note file degrades to a placeholder, not a failure', () => {
    const { db, dir } = buildFixture()
    try {
      // Point Bob at a file that does not exist; the node must still appear.
      db.prepare("UPDATE entities SET file_path = ? WHERE id = 'b'").run(
        join(dir, 'missing.md'),
      )
      const r = toolGetContext(db, { id: 'a', depth: 1 }) as any
      assert.equal(r.node_count, 2)
      assert.match(r.markdown, /## Bob \[Person\] — knows from Alice/)
      assert.match(r.markdown, /_\(no notes\)_/)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unknown node and bad direction are rejected', () => {
    const { db, dir } = buildFixture()
    try {
      assert.throws(() => toolGetContext(db, { id: 'nope' }))
      assert.throws(() => toolGetContext(db, { id: 'a', direction: 'sideways' }))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── toolFindPath ──────────────────────────────────────────────────────────────

/** Add a bare node row. find_path reads names and ids only, never the file. */
function addBareNode(db: Database.Database, id: string, name: string) {
  db.prepare(
    `INSERT INTO entities (id, file_path, name, entity_type, status, version, modified, data_json)
     VALUES (?, '', ?, 'Person', 'active', 1, '2026-01-01', '{}')`,
  ).run(id, name)
}

describe('toolFindPath', () => {
  test('finds the route, stating each hop from the end it is crossed', () => {
    const { db, dir } = buildFixture()
    try {
      const r = toolFindPath(db, { from: 'a', to: 'c' }) as any
      assert.equal(r.found, true)
      assert.equal(r.hops, 2)
      assert.deepEqual(r.path.map((h: any) => h.from.name), ['Alice', 'Bob'])
      assert.deepEqual(r.path.map((h: any) => h.to.name), ['Bob', 'Carol'])
      assert.deepEqual(r.path.map((h: any) => h.connector_type), ['knows', 'reports_to'])
      assert.equal(r.path[1].label, 'line manager')
      // e2 is stored c -> b as 'incoming'; crossed from b it reads 'outgoing'.
      assert.deepEqual(r.path.map((h: any) => h.direction), ['outgoing', 'outgoing'])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('follow refuses to cross an arrow backwards, any does not', () => {
    const { db, dir } = buildFixture()
    try {
      const any = toolFindPath(db, { from: 'c', to: 'a' }) as any
      assert.equal(any.found, true)
      assert.equal(any.hops, 2)

      const follow = toolFindPath(db, { from: 'c', to: 'a', direction: 'follow' }) as any
      assert.equal(follow.found, false)
      assert.match(follow.message, /following the arrows/)

      const forward = toolFindPath(db, { from: 'a', to: 'c', direction: 'follow' }) as any
      assert.equal(forward.found, true)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('follow crosses plain and bidirectional lines either way', () => {
    const { db, dir } = buildFixture()
    try {
      addBareNode(db, 'd', 'Dave')
      addBareNode(db, 'e', 'Erin')
      db.prepare(
        `INSERT INTO relationships (edge_id, source_id, target_id, rel_type, direction)
         VALUES ('e3', 'c', 'd', 'works_with', 'none'), ('e4', 'e', 'd', 'mentors', 'bidirectional')`,
      ).run()
      const r = toolFindPath(db, { from: 'd', to: 'e', direction: 'follow' }) as any
      assert.equal(r.found, true)
      assert.equal(r.path[0].direction, 'bidirectional')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('looks nodes up by name, case-insensitively', () => {
    const { db, dir } = buildFixture()
    try {
      const r = toolFindPath(db, { from: 'alice', to: '  CAROL ' }) as any
      assert.equal(r.found, true)
      assert.equal(r.from.id, 'a')
      assert.equal(r.to.id, 'c')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an ambiguous name returns the candidates and asks for a UUID', () => {
    const { db, dir } = buildFixture()
    try {
      addBareNode(db, 'b2', 'Bob')
      const r = toolFindPath(db, { from: 'a', to: 'Bob' }) as any
      assert.equal(r.found, false)
      assert.equal(r.ambiguous, 'to')
      assert.deepEqual(r.candidates.map((c: any) => c.id).sort(), ['b', 'b2'])
      assert.match(r.message, /UUID/)
      // The UUID resolves it.
      assert.equal((toolFindPath(db, { from: 'a', to: 'b2' }) as any).found, false)
      assert.equal((toolFindPath(db, { from: 'a', to: 'b' }) as any).found, true)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no route says so', () => {
    const { db, dir } = buildFixture()
    try {
      addBareNode(db, 'd', 'Dave')
      const r = toolFindPath(db, { from: 'a', to: 'd' }) as any
      assert.equal(r.found, false)
      assert.match(r.message, /No route from Alice to Dave/)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('max_hops caps the search', () => {
    const { db, dir } = buildFixture()
    try {
      assert.equal((toolFindPath(db, { from: 'a', to: 'c', max_hops: 1 }) as any).found, false)
      assert.equal((toolFindPath(db, { from: 'a', to: 'c', max_hops: 2 }) as any).found, true)
      // Default is generous enough for the fixture; an absurd value is clamped, not rejected.
      assert.equal((toolFindPath(db, { from: 'a', to: 'c', max_hops: 999 }) as any).found, true)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('markdown gives one line per hop', () => {
    const { db, dir } = buildFixture()
    try {
      const r = toolFindPath(db, { from: 'a', to: 'c', format: 'markdown' }) as any
      assert.equal(r.found, true)
      assert.deepEqual(r.markdown.split('\n'), [
        '2 hops from Alice to Carol:',
        '1. Alice → Bob (knows)',
        '2. Bob → Carol (reports_to: line manager)',
      ])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unknown node and a bad option are rejected', () => {
    const { db, dir } = buildFixture()
    try {
      assert.throws(() => toolFindPath(db, { from: 'a', to: 'nobody' }))
      assert.throws(() => toolFindPath(db, { from: 'a', to: 'c', direction: 'sideways' }))
      assert.throws(() => toolFindPath(db, { from: 'a', to: 'c', format: 'xml' }))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── toolGetStructureReport ────────────────────────────────────────────────────

/** The index's search table, which is where the report reads note bodies from. */
function addSearchIndex(db: Database.Database, bodies: Record<string, string>) {
  db.exec(`CREATE VIRTUAL TABLE entities_fts USING fts5 (entity_id UNINDEXED, name, body, properties_text)`)
  for (const [id, body] of Object.entries(bodies)) {
    db.prepare('INSERT INTO entities_fts(entity_id, name, body, properties_text) VALUES (?, ?, ?, ?)')
      .run(id, id, body, '')
  }
}

describe('toolGetStructureReport', () => {
  test('summarises the fixture: ranking, load-bearing node, thin record', () => {
    const { db, dir } = buildFixture()
    try {
      addSearchIndex(db, { a: 'Alice notes', b: 'Bob notes', c: '' })
      const r = toolGetStructureReport(db, dir) as any
      assert.equal(r.node_count, 3)
      assert.equal(r.edge_count, 2)
      assert.match(r.markdown, /^## Structure\nClassifications: Person 3\nConnectors: knows 1 · reports_to 1/)
      assert.match(r.markdown, /1\. Bob \(Person\): 2 connections/)
      assert.match(r.markdown, /Removing any of these would split the structure: Bob/)
      assert.match(r.markdown, /### Thin records \(1\)\nNodes with no notes and no properties: Carol/)
      assert.doesNotMatch(r.markdown, /Islands|Unconnected/)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('uses the labels from the space configuration', () => {
    const { db, dir } = buildFixture()
    try {
      addSearchIndex(db, { a: 'x', b: 'x', c: 'x' })
      mkdirSync(join(dir, '.filamental'))
      writeFileSync(join(dir, '.filamental', 'entity_types.json'), JSON.stringify({ Person: { label: 'People' } }))
      writeFileSync(join(dir, '.filamental', 'connector_types.json'), JSON.stringify({ reports_to: { label: 'reports to' } }))
      const r = toolGetStructureReport(db, dir) as any
      assert.match(r.markdown, /Classifications: People 3/)
      assert.match(r.markdown, /Connectors: knows 1 · reports to 1/)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a node missing from the search index counts as having no notes, not as an error', () => {
    const { db, dir } = buildFixture()
    try {
      addSearchIndex(db, { a: 'Alice notes' })
      const r = toolGetStructureReport(db, dir) as any
      assert.match(r.markdown, /Thin records \(2\)/)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an empty space says so', () => {
    const { db, dir } = buildFixture()
    try {
      addSearchIndex(db, {})
      db.exec('DELETE FROM entities; DELETE FROM relationships;')
      const r = toolGetStructureReport(db, dir) as any
      assert.equal(r.node_count, 0)
      assert.equal(r.markdown, 'This space has no nodes yet.')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Writing over a note someone else also edits ──────────────────────────────

describe('serialiseMarkdownOver', () => {
  // Written by the app (unquoted timestamps), then given Obsidian keys and a cover image.
  const SHARED = [
    '---',
    'tags:',
    '- frontofhouse',
    'id: n1',
    'name: Shared',
    'display_name: Old display',
    'type: rails',
    'status: active',
    'created: 2026-03-02T13:36:20+00:00',
    'modified: 2026-04-14T17:21:15+00:00',
    'modified_by: import',
    'version: 2',
    'properties: {}',
    'relationships: []',
    'attachments: []',
    'composition_mode: atomic',
    "child_view_id: ''",
    'cover_image: .filamental/assets/n1/cover.jpg',
    'due: 2024-06-01',
    'aliases:',
    '- The shared one',
    '---',
    '',
    'Body.',
    '',
  ].join('\n')

  test('the app-written timestamps read back as the text they are', () => {
    const dir = mkdtempSync(join(tmpdir(), 'filamental-mcp-yaml-'))
    try {
      const file = join(dir, 'n1.md')
      writeFileSync(file, SHARED, 'utf-8')
      const { node } = parseMarkdownFile(file)
      assert.equal(node.created, '2026-03-02T13:36:20+00:00')
      assert.equal(node.modified, '2026-04-14T17:21:15+00:00')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('keeps every key it does not own, in place, and its text unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'filamental-mcp-yaml-'))
    try {
      const file = join(dir, 'n1.md')
      writeFileSync(file, SHARED, 'utf-8')
      const { node, body } = parseMarkdownFile(file)
      node.entity_type = 'decision'
      node.display_name = null
      node.version += 1

      const out = serialiseMarkdownOver(node, body, SHARED)
      const lines = out.split('\n')
      assert.equal(lines[1], 'tags:')
      assert.ok(lines.includes('  - frontofhouse') || lines.includes('- frontofhouse'))
      assert.ok(lines.includes('cover_image: .filamental/assets/n1/cover.jpg'), 'the cover image survives')
      assert.ok(lines.includes('due: 2024-06-01'), 'a date stays as written')
      assert.ok(lines.includes('created: 2026-03-02T13:36:20+00:00'))
      assert.ok(lines.includes('type: decision'))
      assert.ok(lines.includes('version: 3'))
      assert.ok(out.includes('The shared one'))
      assert.ok(!out.includes('display_name'), 'a cleared display name is dropped')
      assert.ok(out.endsWith('\n\nBody.'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a note this server wrote itself is rewritten unchanged in shape', () => {
    const node = {
      id: 'n2', name: 'Own', entity_type: 'rails', status: 'active',
      created: '2026-03-02T13:36:20+00:00', modified: '2026-03-02T13:36:20+00:00', modified_by: 'filamental-mcp',
      version: 1, properties: { owner: 'Ana' }, relationships: [], attachments: [],
      composition_mode: 'atomic', child_view_id: '', has_notes: true,
    }
    const fresh = serialiseMarkdownOver(node, 'Body.', '')
    assert.equal(serialiseMarkdownOver(node, 'Body.', fresh), fresh)
    assert.ok(fresh.includes('created: 2026-03-02T13:36:20+00:00'), 'written unquoted, as the app writes it')
  })
})
