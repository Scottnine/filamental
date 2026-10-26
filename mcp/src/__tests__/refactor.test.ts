// Tests for the write tools: the structural refactors (extract_section, inline_section),
// create_node and update_node, and the annotations every tool carries. These write real
// files, so every fixture builds a throwaway vault in the OS temp directory and removes
// it afterwards. No real vault is ever touched.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

import { TOOLS, toolCreateNode, toolExtractSection, toolInlineSection, toolUpdateNode } from '../server.js'

/**
 * A writable temp vault. Unlike the read-only fixtures this creates the FTS
 * table too, because the write tools call upsertEntity.
 */
function buildWritableVault() {
  const dir = mkdtempSync(join(tmpdir(), 'filamental-mcp-write-'))
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
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

  const addNode = (id: string, name: string, body: string) => {
    const filePath = join(dir, `${id}.md`)
    writeFileSync(
      filePath,
      `---\nid: ${id}\nname: ${name}\ntype: Note\nstatus: active\nversion: 1\n---\n\n${body}\n`,
      'utf-8',
    )
    const data = {
      id, name, type: 'Note', status: 'active', created: '2026-01-01',
      modified: '2026-01-01', modified_by: 'test', version: 1,
      properties: {}, relationships: [], attachments: [],
      composition_mode: null, child_view_id: null, has_notes: true,
    }
    db.prepare(
      `INSERT INTO entities (id, file_path, name, entity_type, status, version, modified, data_json)
       VALUES (?, ?, ?, ?, ?, 1, '2026-01-01', ?)`,
    ).run(id, filePath, name, 'Note', 'active', JSON.stringify(data))
    return filePath
  }

  return { db, dir, addNode }
}

const ARTICLE = [
  'Intro paragraph.',
  '',
  '## Background',
  '',
  'Background content here.',
  '',
  '### Detail',
  '',
  'A nested detail that belongs to Background.',
  '',
  '## Conclusion',
  '',
  'Closing thoughts.',
].join('\n')

describe('extract_section', () => {
  test('moves the section out, leaves a wikilink, and links the new node', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      const srcPath = addNode('src', 'Article', ARTICLE)

      const r = toolExtractSection(db, dir, { id: 'src', heading: 'Background' }) as any
      assert.equal(r.extracted_node.name, 'Background')

      // The new node holds the content, including the nested h3.
      const extracted = readFileSync(r.extracted_node.file_path, 'utf-8')
      assert.match(extracted, /Background content here\./)
      assert.match(extracted, /### Detail/)
      assert.match(extracted, /A nested detail/)

      // The source keeps its heading, loses the content, gains a wikilink.
      const source = readFileSync(srcPath, 'utf-8')
      assert.match(source, /## Background/)
      assert.match(source, /\[\[Background\]\]/)
      assert.doesNotMatch(source, /Background content here\./)
      assert.doesNotMatch(source, /A nested detail/)

      // Untouched siblings survive.
      assert.match(source, /Intro paragraph\./)
      assert.match(source, /## Conclusion/)
      assert.match(source, /Closing thoughts\./)

      assert.equal(r.edge.rel_type, 'includes')
      assert.equal(r.edge.direction, 'outgoing')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('content is moved exactly once, never duplicated', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      const srcPath = addNode('src', 'Article', ARTICLE)
      const r = toolExtractSection(db, dir, { id: 'src', heading: 'Background' }) as any

      const both =
        readFileSync(srcPath, 'utf-8') + readFileSync(r.extracted_node.file_path, 'utf-8')
      assert.equal(both.split('Background content here.').length - 1, 1)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a heading inside a code fence is not mistaken for a real heading', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      const withCode = [
        '## Setup',
        '',
        '```bash',
        '# Conclusion',
        'echo "a shell comment, not a heading"',
        '```',
        '',
        'Real setup text.',
        '',
        '## Conclusion',
        '',
        'The actual conclusion.',
      ].join('\n')
      const srcPath = addNode('src', 'Guide', withCode)

      const r = toolExtractSection(db, dir, { id: 'src', heading: 'Setup' }) as any

      // Setup must run to the REAL '## Conclusion', carrying the whole fence.
      const extracted = readFileSync(r.extracted_node.file_path, 'utf-8')
      assert.match(extracted, /a shell comment, not a heading/)
      assert.match(extracted, /Real setup text\./)
      assert.doesNotMatch(extracted, /The actual conclusion\./)

      assert.match(readFileSync(srcPath, 'utf-8'), /The actual conclusion\./)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dry_run writes nothing', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      const srcPath = addNode('src', 'Article', ARTICLE)
      const before = readFileSync(srcPath, 'utf-8')
      const countBefore = (db.prepare('SELECT COUNT(*) n FROM entities').get() as any).n

      const r = toolExtractSection(db, dir, {
        id: 'src', heading: 'Background', dry_run: true,
      }) as any

      assert.equal(r.would_create.name, 'Background')
      assert.match(r.preview, /Background content here\./)
      assert.equal(readFileSync(srcPath, 'utf-8'), before)
      assert.equal((db.prepare('SELECT COUNT(*) n FROM entities').get() as any).n, countBefore)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a custom name is honoured and used for the wikilink', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      const srcPath = addNode('src', 'Article', ARTICLE)
      const r = toolExtractSection(db, dir, {
        id: 'src', heading: 'Background', name: 'Historical Context',
      }) as any
      assert.equal(r.extracted_node.name, 'Historical Context')
      assert.match(readFileSync(srcPath, 'utf-8'), /\[\[Historical Context\]\]/)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('missing, empty and unknown targets are rejected', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      addNode('src', 'Article', ARTICLE)
      addNode('bare', 'Bare', '## Empty\n\n## Next\n\ntext')
      assert.throws(() => toolExtractSection(db, dir, { id: 'src', heading: 'Nope' }))
      assert.throws(() => toolExtractSection(db, dir, { id: 'bare', heading: 'Empty' }))
      assert.throws(() => toolExtractSection(db, dir, { id: 'missing', heading: 'x' }))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('inline_section', () => {
  test('extract then inline round-trips the content back', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      const srcPath = addNode('src', 'Article', ARTICLE)

      const ex = toolExtractSection(db, dir, { id: 'src', heading: 'Background' }) as any
      assert.doesNotMatch(readFileSync(srcPath, 'utf-8'), /Background content here\./)

      const inl = toolInlineSection(db, {
        source_id: 'src', target_id: ex.extracted_node.id,
      }) as any

      assert.equal(inl.target_deleted, true)
      assert.equal(inl.placement, 'replaced wikilink in place')

      const restored = readFileSync(srcPath, 'utf-8')
      assert.match(restored, /Background content here\./)
      assert.match(restored, /A nested detail/)
      assert.doesNotMatch(restored, /\[\[Background\]\]/)

      // The extracted file is gone, and its index row with it.
      assert.equal(existsSync(ex.extracted_node.file_path), false)
      assert.equal(
        db.prepare('SELECT 1 FROM entities WHERE id = ?').get(ex.extracted_node.id),
        undefined,
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses to delete a target that is connected to other nodes', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      addNode('src', 'Article', ARTICLE)
      const ex = toolExtractSection(db, dir, { id: 'src', heading: 'Background' }) as any
      addNode('other', 'Other', 'Some other note.')

      // A third node also points at the extracted one.
      db.prepare(
        `INSERT INTO relationships (edge_id, source_id, target_id, rel_type, direction)
         VALUES ('x', 'other', ?, 'refers_to', 'outgoing')`,
      ).run(ex.extracted_node.id)

      assert.throws(
        () => toolInlineSection(db, { source_id: 'src', target_id: ex.extracted_node.id }),
        /still connected/,
      )

      // A refusal must leave the content exactly as it was.
      assert.match(
        readFileSync(ex.extracted_node.file_path, 'utf-8'),
        /Background content here\./,
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('delete_target false keeps the node but empties it, so content is not duplicated', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      const srcPath = addNode('src', 'Article', ARTICLE)
      const ex = toolExtractSection(db, dir, { id: 'src', heading: 'Background' }) as any

      const r = toolInlineSection(db, {
        source_id: 'src', target_id: ex.extracted_node.id, delete_target: false,
      }) as any

      assert.equal(r.target_deleted, false)
      assert.equal(existsSync(ex.extracted_node.file_path), true)

      const both =
        readFileSync(srcPath, 'utf-8') + readFileSync(ex.extracted_node.file_path, 'utf-8')
      assert.equal(both.split('Background content here.').length - 1, 1)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('appends when there is no wikilink to land on', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      const aPath = addNode('a', 'Alpha', 'Alpha body.')
      addNode('b', 'Beta', 'Beta body.')

      const r = toolInlineSection(db, { source_id: 'a', target_id: 'b' }) as any
      assert.equal(r.placement, 'appended')

      const merged = readFileSync(aPath, 'utf-8')
      assert.match(merged, /Alpha body\./)
      assert.match(merged, /## Beta/)
      assert.match(merged, /Beta body\./)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dry_run writes nothing and previews the result', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      const aPath = addNode('a', 'Alpha', 'Alpha body.')
      const bPath = addNode('b', 'Beta', 'Beta body.')
      const beforeA = readFileSync(aPath, 'utf-8')

      const r = toolInlineSection(db, {
        source_id: 'a', target_id: 'b', dry_run: true,
      }) as any

      assert.match(r.preview, /Beta body\./)
      assert.equal(readFileSync(aPath, 'utf-8'), beforeA)
      assert.equal(existsSync(bPath), true)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects inlining a node into itself and unknown ids', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      addNode('a', 'Alpha', 'Alpha body.')
      assert.throws(() => toolInlineSection(db, { source_id: 'a', target_id: 'a' }))
      assert.throws(() => toolInlineSection(db, { source_id: 'a', target_id: 'nope' }))
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('create_node and update_node', () => {
  test('relationships take the same four directions as create_edge, and nothing else', () => {
    const { db, dir, addNode } = buildWritableVault()
    try {
      addNode('t1', 'Target', 'Body.')
      const made = toolCreateNode(db, dir, {
        name: 'Both ways',
        relationships: [{ target: 't1', rel_type: 'links', direction: 'bidirectional' }],
      }) as { id: string; file_path: string }
      assert.match(readFileSync(made.file_path, 'utf-8'), /direction: bidirectional/)

      assert.throws(
        () => toolCreateNode(db, dir, {
          name: 'Bad arrow',
          relationships: [{ target: 't1', rel_type: 'links', direction: 'sideways' }],
        }),
        /Invalid direction "sideways"/,
      )
      assert.throws(
        () => toolUpdateNode(db, dir, {
          id: made.id,
          relationships: [{ target: 't1', rel_type: 'links', direction: 'both' }],
        }),
        /Invalid direction "both"/,
      )
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('create_node sets a display name, and an empty one is left off', () => {
    const { db, dir } = buildWritableVault()
    try {
      const titled = toolCreateNode(db, dir, { name: 'Ada Lovelace (mathematician)', display_name: 'Ada Lovelace' }) as { file_path: string }
      assert.match(readFileSync(titled.file_path, 'utf-8'), /display_name: Ada Lovelace\n/)
      const plain = toolCreateNode(db, dir, { name: 'Plain', display_name: '' }) as { file_path: string }
      assert.doesNotMatch(readFileSync(plain.file_path, 'utf-8'), /display_name/)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tool annotations', () => {
  test('every tool has a title and says whether it reads, writes or destroys', () => {
    for (const tool of TOOLS) {
      const a = tool.annotations as Record<string, unknown>
      assert.ok(typeof a?.title === 'string' && a.title, `${tool.name} has no title`)
      assert.equal(typeof a.readOnlyHint, 'boolean', `${tool.name} has no readOnlyHint`)
      if (!a.readOnlyHint) assert.equal(typeof a.destructiveHint, 'boolean', `${tool.name} has no destructiveHint`)
      assert.equal(a.openWorldHint, false, `${tool.name} is local-only`)
    }
  })

  test('the deleting tools are marked destructive, the reading ones read-only', () => {
    const by = Object.fromEntries(TOOLS.map(t => [t.name, t.annotations as Record<string, unknown>]))
    for (const name of ['delete_node', 'delete_edge', 'update_node', 'inline_section']) {
      assert.equal(by[name].destructiveHint, true, name)
    }
    assert.ok(by['get_project_info'] && !by['get_vault_info'], 'listed as get_project_info, never by its old name')
    for (const name of ['search_nodes', 'get_node', 'get_context', 'find_path', 'get_structure_report']) {
      assert.equal(by[name].readOnlyHint, true, name)
    }
  })
})
