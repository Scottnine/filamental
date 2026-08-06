// Tests for the connection briefing and the on-demand reference documents.
// These are what remove the need for a user to install a skill file by hand,
// so the guarantees worth pinning down are: the briefing is actually sent, and
// a missing document degrades into guidance rather than an error.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { createServer, stripFrontmatter, readReferenceDoc } from '../server.js'

describe('stripFrontmatter', () => {
  test('removes a leading YAML block', () => {
    const raw = '---\nid: abc\nname: Guide\n---\n\n# Real Title\n\nBody text.\n'
    const out = stripFrontmatter(raw)
    assert.equal(out.startsWith('# Real Title'), true)
    assert.doesNotMatch(out, /id: abc/)
    assert.match(out, /Body text\./)
  })

  test('leaves a document without frontmatter intact', () => {
    const raw = '# Just A Title\n\nBody.\n'
    assert.equal(stripFrontmatter(raw), '# Just A Title\n\nBody.')
  })

  test('leaves an unterminated block intact rather than eating the document', () => {
    const raw = '---\nid: abc\nname: broken\n'
    assert.equal(stripFrontmatter(raw), raw.trim())
  })

  test('does not mistake a horizontal rule further down for a delimiter', () => {
    const raw = '# Title\n\nIntro.\n\n---\n\nMore text.\n'
    const out = stripFrontmatter(raw)
    assert.match(out, /^# Title/)
    assert.match(out, /More text\./)
  })
})

describe('readReferenceDoc', () => {
  test('a missing document returns guidance, not a thrown error', () => {
    const r = readReferenceDoc('__no_such_file__.md', 'skill guide') as any
    assert.equal(r.content, null)
    assert.match(r.error, /skill guide/)
    // The message must tell the model to carry on rather than stall.
    assert.match(r.error, /Continue using the tool descriptions/)
  })
})

describe('server instructions', () => {
  test('the briefing is attached to the server and is non-trivial', () => {
    const db = new Database(':memory:')
    try {
      const server = createServer(() => db, () => '/tmp/vault', () => null)
      // The SDK stores it privately and emits it in the initialize result.
      const instructions = (server as any)._instructions as string
      assert.equal(typeof instructions, 'string')
      assert.ok(instructions.length > 1000, 'briefing should carry the essentials')

      // The things a model most needs to be told up front.
      assert.match(instructions, /list_node_types/)
      assert.match(instructions, /get_context/)
      assert.match(instructions, /read_skill_guide/)
      // Keys vs labels, and the warning that this server cannot define types.
      assert.match(instructions, /cannot define new types/)
      assert.match(instructions, /influence "none" is still a real, drawn connection/i)
    } finally {
      db.close()
    }
  })

  test('the briefing stays small enough to send every session', () => {
    const db = new Database(':memory:')
    try {
      const server = createServer(() => db, () => '/tmp/vault', () => null)
      const instructions = (server as any)._instructions as string
      // The full documents are ~52K combined and are served on demand instead.
      // If this ever grows past a few thousand characters, the tiering has been
      // lost and every connecting session pays for it.
      assert.ok(
        instructions.length < 6000,
        `briefing is ${instructions.length} chars; serve depth via read_skill_guide instead`,
      )
    } finally {
      db.close()
    }
  })
})
