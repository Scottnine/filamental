#!/usr/bin/env node
// Filamental MCP Server — index.ts
// Entry point: resolve vault path (from --vault arg or active-vault file),
// open DB, connect transport. Re-connects automatically when vault changes.

import { existsSync, readFileSync, watchFile } from 'fs'
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
      i++
    }
  }
  return result
}

// ── App config dir (mirrors Tauri's app_config_dir for "com.filamental.app") ──

function appConfigDir(): string {
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? homedir(), 'com.filamental.app')
  } else if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'com.filamental.app')
  } else {
    return join(
      process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
      'com.filamental.app',
    )
  }
}

// ── Read the active vault path written by Filamental on every vault open ──────

function readActiveVault(): string | null {
  const filePath = join(appConfigDir(), 'active-vault')
  if (!existsSync(filePath)) return null
  const content = readFileSync(filePath, 'utf-8').trim()
  return content.length > 0 ? content : null
}

// ── Vault hash (FNV-1a 32-bit — mirrors Rust vault_hash fn) ──────────────────

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

function resolveDbPath(vaultPath: string, explicitDb?: string): string {
  if (explicitDb) return resolve(explicitDb)

  const appDbPath = join(appConfigDir(), 'vaults', vaultHash(vaultPath), 'filamental.db')
  if (existsSync(appDbPath)) return appDbPath

  return join(vaultPath, '.filamental', 'filamental.db')
}

// ── State shared across reconnects ────────────────────────────────────────────

interface ActiveState {
  vaultPath: string
  db: Database.Database
}

let activeState: ActiveState | null = null

function openVault(vaultPath: string, explicitDb?: string): ActiveState {
  const dbPath = resolveDbPath(vaultPath, explicitDb)
  if (!existsSync(dbPath)) {
    throw new Error(
      `Filamental database not found at ${dbPath}.\n` +
      `Open this vault in Filamental at least once so the SQLite index is initialised.`,
    )
  }
  const db = new Database(dbPath)
  return { vaultPath, db }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const explicitVault = args['vault'] ? resolve(args['vault']) : undefined
  const explicitDb    = args['db']    ? resolve(args['db'])    : undefined

  // Resolve the initial vault path: explicit arg → active-vault file
  let initialVaultPath: string

  if (explicitVault) {
    if (!existsSync(explicitVault)) {
      console.error(`Error: vault path does not exist: ${explicitVault}`)
      process.exit(1)
    }
    initialVaultPath = explicitVault
  } else {
    const active = readActiveVault()
    if (!active) {
      console.error('Error: no vault path supplied and no active-vault file found.')
      console.error('')
      console.error('Either:')
      console.error('  1. Open a vault in Filamental (it writes the active-vault file automatically), or')
      console.error('  2. Pass --vault <path> explicitly.')
      process.exit(1)
    }
    if (!existsSync(active)) {
      console.error(`Error: active vault path does not exist: ${active}`)
      process.exit(1)
    }
    initialVaultPath = active
  }

  // Open the initial DB connection
  try {
    activeState = openVault(initialVaultPath, explicitDb)
  } catch (err) {
    console.error(`Error: ${err}`)
    process.exit(1)
  }

  // Watch the active-vault file for changes (user switched worlds in Filamental).
  // Only active when --vault was NOT explicitly supplied — explicit arg is pinned.
  if (!explicitVault) {
    const activeVaultFile = join(appConfigDir(), 'active-vault')
    watchFile(activeVaultFile, { interval: 2000 }, () => {
      const newPath = readActiveVault()
      if (!newPath || newPath === activeState?.vaultPath) return
      if (!existsSync(newPath)) return

      try {
        const next = openVault(newPath)
        activeState?.db.close()
        activeState = next
        // Notify via stderr so Claude Desktop can surface the switch if desired
        console.error(`[filamental-mcp] vault switched → ${newPath}`)
      } catch {
        // Keep the old connection alive if the new vault's DB isn't ready yet
      }
    })
  }

  // Create the MCP server — it reads activeState on each tool call via the getter
  const server = createServer(
    () => activeState!.db,
    () => activeState!.vaultPath,
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
