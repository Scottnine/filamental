import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { freeCapReached, FREE_NODE_LIMIT } from '../freeCap.js'

const NOW = 1_800_000_000

function setup(licence: object | null, nodes: number, bridges = 0) {
  const root = mkdtempSync(join(tmpdir(), 'fl-cap-'))
  const config = join(root, 'com.filamental.app')
  mkdirSync(config)
  if (licence) writeFileSync(join(config, 'licence.json'), JSON.stringify(licence))
  const db = new Database(':memory:')
  db.exec('CREATE TABLE entities (data_json TEXT)')
  const add = db.prepare('INSERT INTO entities (data_json) VALUES (?)')
  for (let i = 0; i < nodes; i++) add.run(JSON.stringify({ id: `n${i}` }))
  for (let i = 0; i < bridges; i++) add.run(JSON.stringify({ id: `b${i}`, category: 'bridge' }))
  return { root, config, db, vault: join(root, 'Project') }
}

describe('free node cap over MCP', () => {
  const lapsed = { status: 'free', installed_at: NOW - 30 * 24 * 3600 }

  test('stops the 21st node on the free plan, bridges not counted', () => {
    const s = setup(lapsed, FREE_NODE_LIMIT - 1, 5)
    assert.equal(freeCapReached(s.db, s.vault, s.config, NOW), false)
    s.db.prepare('INSERT INTO entities (data_json) VALUES (?)').run('{"id":"last"}')
    assert.equal(freeCapReached(s.db, s.vault, s.config, NOW), true)
    rmSync(s.root, { recursive: true, force: true })
  })

  test('lifts for an active licence, the trial, the Help Playground and an unreadable licence', () => {
    const full = FREE_NODE_LIMIT + 3
    const active = setup({ status: 'active', installed_at: 1 }, full)
    assert.equal(freeCapReached(active.db, active.vault, active.config, NOW), false)
    const trial = setup({ status: 'free', installed_at: NOW - 3600 }, full)
    assert.equal(freeCapReached(trial.db, trial.vault, trial.config, NOW), false)
    const help = setup(lapsed, full)
    assert.equal(freeCapReached(help.db, join(help.config, 'help-world'), help.config, NOW), false)
    const none = setup(null, full)
    assert.equal(freeCapReached(none.db, none.vault, none.config, NOW), false)
    for (const s of [active, trial, help, none]) rmSync(s.root, { recursive: true, force: true })
  })
})
