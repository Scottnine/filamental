// Tests for the MCP server's read-only additions: property filtering and
// composed context retrieval.
//
// This suite is deliberately separate from the app's Vitest suite. That one is
// scoped to the repo's `src/` directory by `dir:` in vitest.config.ts, and the
// MCP server is a standalone npm package with its own build — so it gets its own
// runner (node:test via tsx) rather than being pulled into the app's config.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

import { evaluateFilter, toolGetContext } from '../server.js'

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
