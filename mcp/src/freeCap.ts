// Filamental MCP Server — freeCap.ts
// The free plan's node cap, applied to nodes an AI creates over MCP.
//
// The app enforces the cap in Rust (cmd::node::enforce_free_node_cap), but this
// server writes node files itself, so it has to apply the same rule or a
// connected AI could build past it (the rule since 2026-10-19: the only times going over
// the cap is fine are opening a project and adding bridges). It mirrors the app:
//   • a Setapp install is always paid;
//   • the Help Playground is never capped;
//   • an active licence, or the 15-day trial, lifts the cap;
//   • otherwise 20 nodes per project, bridges not counted.
// If the licence file can't be read, the cap is NOT applied: the app writes that
// file on first run, so its absence means this server can't tell, and blocking a
// paying user on a guess is worse than letting a free one through.

import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import type Database from 'better-sqlite3'
import { appConfigDir } from './paths.js'

export const FREE_NODE_LIMIT = 20
const TRIAL_SECS = 15 * 24 * 3600   // must match TRIAL_SECS in src-tauri/src/licence.rs

export const NODE_LIMIT_MESSAGE =
  `The free plan holds ${FREE_NODE_LIMIT} nodes per project, not counting bridges, and this project is full. ` +
  'Tell the user: they can carry on in another project and bridge the two in Filamental, or go Pro for unlimited nodes.'

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** True when the free plan's cap stops one more node being created in this project. */
export function freeCapReached(
  db: Database.Database,
  vaultPath: string,
  configDir: string = appConfigDir(),
  nowSecs: number = Math.floor(Date.now() / 1000),
): boolean {
  if (/-setapp[\\/]?$/i.test(configDir)) return false
  if (samePath(vaultPath, join(configDir, 'help-world'))) return false

  let licence: { status?: string; installed_at?: number | null }
  try {
    licence = JSON.parse(readFileSync(join(configDir, 'licence.json'), 'utf8'))
  } catch {
    return false
  }
  if (licence.status === 'active') return false
  if (typeof licence.installed_at === 'number' && nowSecs - licence.installed_at < TRIAL_SECS) return false

  let count = 0
  for (const row of db.prepare('SELECT data_json FROM entities').all() as { data_json: string }[]) {
    try {
      if ((JSON.parse(row.data_json) as { category?: string | null }).category !== 'bridge') count++
    } catch {
      count++
    }
  }
  return count >= FREE_NODE_LIMIT
}
