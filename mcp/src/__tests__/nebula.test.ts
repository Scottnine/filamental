// rename_nebula: a nebula's name must never differ between its members, so a
// rename lands on every member at once, through update_node's own write path.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

import { parseMarkdownFile, toolRenameNebula } from '../server.js'

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'filamental-mcp-nebula-'))
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
    CREATE VIRTUAL TABLE entities_fts USING fts5 (
      entity_id UNINDEXED, name, body, properties_text, tokenize = 'unicode61'
    );
  `)
  const add = (id: string, properties: Record<string, string>) => {
    const filePath = join(dir, `${id}.md`)
    const props = Object.entries(properties).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    writeFileSync(
      filePath,
      `---\nid: ${id}\nname: ${id.toUpperCase()}\ntype: person\nstatus: active\n` +
      (props ? `properties:\n${props}\n` : '') + `---\n\nBody of ${id}.\n`,
      'utf-8',
    )
    const data = { id, name: id.toUpperCase(), type: 'person', status: 'active', version: 1, properties, relationships: [] }
    db.prepare(
      `INSERT INTO entities (id, file_path, name, entity_type, status, version, modified, data_json)
       VALUES (?, ?, ?, 'person', 'active', 1, '2026-01-01', ?)`,
    ).run(id, filePath, id.toUpperCase(), JSON.stringify(data))
    return filePath
  }
  const files = {
    a: add('a', { nebula: 'Launch', role: 'lead' }),
    b: add('b', { nebula: 'Launch' }),
    c: add('c', { nebula: 'Budget' }),
    d: add('d', {}),
  }
  return { db, dir, files }
}

const nebulaOf = (file: string) => parseMarkdownFile(file).node.properties.nebula

describe('toolRenameNebula', () => {
  test('renames on every member, keeps other properties and the body', () => {
    const { db, dir, files } = buildFixture()
    try {
      const r = toolRenameNebula(db, dir, { from: 'Launch', to: 'Go, Live' }) as { members: string[]; to: string }
      assert.deepEqual(r.members.sort(), ['a', 'b'])
      assert.equal(r.to, 'Go Live')
      assert.equal(nebulaOf(files.a), 'Go Live')
      assert.equal(nebulaOf(files.b), 'Go Live')
      assert.equal(nebulaOf(files.c), 'Budget')
      assert.equal(parseMarkdownFile(files.a).node.properties.role, 'lead')
      assert.match(parseMarkdownFile(files.a).body, /Body of a\./)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('renaming onto an existing nebula joins the two', () => {
    const { db, dir, files } = buildFixture()
    try {
      toolRenameNebula(db, dir, { from: 'Launch', to: 'Budget' })
      for (const f of [files.a, files.b, files.c]) assert.equal(nebulaOf(f), 'Budget')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unknown nebula is an error, and nothing is written', () => {
    const { db, dir, files } = buildFixture()
    try {
      assert.throws(() => toolRenameNebula(db, dir, { from: 'Nope', to: 'X' }), /No node is in a nebula called "Nope"/)
      assert.throws(() => toolRenameNebula(db, dir, { from: 'Launch', to: ' , ' }), /required/)
      assert.equal(nebulaOf(files.a), 'Launch')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
