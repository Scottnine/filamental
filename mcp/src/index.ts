#!/usr/bin/env node
// Filamental MCP Server — index.ts
// Entry point: parse CLI args, resolve vault DB path, open DB, connect transport.

import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import Database from 'better-sqlite3'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

// ── CLI argument parser ───────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i].startsWith('--')) {
      result[argv[i].slice(2)] = argv[i + 1]
      i++ // consume the value
    }
  }
  return result
}

// ── Vault hash (mirrors Rust vault_hash fn — FNV-1a 32-bit) ──────────────────

function vaultHash(vaultPath: string): string {
  let hash = 2_166_136_261
  const bytes = Buffer.from(vaultPath, 'utf-8')
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 16_777_619) >>> 0
  }
  return `vault-${hash.toString(16).padStart(8, '0')}`
}

// ── DB path resolution ────────────────────────────────────────────────────────
//
// Filamental stores its SQLite index in the OS app-config directory, NOT inside
// the vault folder (so cloud-synced vaults don't re-index on every machine).
// Path: <app_config_dir>/vaults/<vault-hash>/filamental.db
//
// If --db is supplied it overrides everything (useful for testing).

function resolveDbPath(vaultPath: string, explicitDb?: string): string {
  if (explicitDb) return resolve(explicitDb)

  // Tauri's app_config_dir for "com.filamental.app"
  let appConfigDir: string
  if (process.platform === 'win32') {
    appConfigDir = join(process.env['APPDATA'] ?? homedir(), 'com.filamental.app')
  } else if (process.platform === 'darwin') {
    appConfigDir = join(homedir(), 'Library', 'Application Support', 'com.filamental.app')
  } else {
    // Linux / XDG
    appConfigDir = join(
      process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
      'com.filamental.app',
    )
  }

  const appDbPath = join(appConfigDir, 'vaults', vaultHash(vaultPath), 'filamental.db')
  if (existsSync(appDbPath)) return appDbPath

  // Fallback: vault-local path (dev builds or future embedded mode)
  return join(vaultPath, '.filamental', 'filamental.db')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const rawVaultArg = args['vault']

  if (!rawVaultArg) {
    console.error('Error: --vault <path> is required')
    console.error('')
    console.error('Usage:')
    console.error('  node --no-warnings dist/index.js --vault /path/to/your/vault')
    console.error('  node --no-warnings dist/index.js --vault /path/to/vault --db /explicit/db/path')
    process.exit(1)
  }

  const vaultPath = resolve(rawVaultArg)

  if (!existsSync(vaultPath)) {
    console.error(`Error: vault path does not exist: ${vaultPath}`)
    process.exit(1)
  }

  const dbPath = resolveDbPath(vaultPath, args['db'])

  if (!existsSync(dbPath)) {
    console.error(`Error: Filamental database not found at:`)
    console.error(`  ${dbPath}`)
    console.error('')
    console.error('Make sure this vault has been opened in Filamental at least once')
    console.error('so that the SQLite index is initialised.')
    process.exit(1)
  }

  const db = new Database(dbPath)

  const server = createServer(db, vaultPath)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
