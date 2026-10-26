#!/usr/bin/env node
// Filamental MCP Server — index.ts
// Entry point: resolve vault path (from --vault arg or active-vault file),
// open DB, connect transport. Re-connects automatically when vault changes.

import { existsSync, readFileSync, watchFile } from 'fs'
import { join, resolve } from 'path'
import Database from 'better-sqlite3'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { appConfigDir } from './paths.js'

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

// ── Schema compatibility ──────────────────────────────────────────────────────
// Must match SCHEMA_VERSION in src-tauri/src/index.rs

const SUPPORTED_SCHEMA_VERSION = 6

function schemaVersionHint(detected: number): string {
  if (detected > SUPPORTED_SCHEMA_VERSION) {
    return (
      `Version mismatch: your Filamental app uses schema v${detected} but this MCP only supports v${SUPPORTED_SCHEMA_VERSION}. ` +
      `To fix:\n  1. Update filamental-mcp to its latest version (npm update -g filamental-mcp if you installed it globally)\n  2. Restart your AI app`
    )
  }
  return (
    `Version mismatch: this MCP expects schema v${SUPPORTED_SCHEMA_VERSION} but detected v${detected}. ` +
    `To fix:\n  1. Download the latest Filamental app at https://filamental.space/download\n  2. Install it\n  3. Restart your AI app`
  )
}

// ── State shared across reconnects ────────────────────────────────────────────

interface ActiveState {
  vaultPath: string
  db: Database.Database
  schemaHint: string | null
}

let activeState: ActiveState | null = null

function openVault(vaultPath: string, explicitDb?: string): ActiveState {
  const dbPath = resolveDbPath(vaultPath, explicitDb)
  if (!existsSync(dbPath)) {
    throw new Error(
      `Filamental database not found at ${dbPath}.\n` +
      `Open this project in Filamental at least once so the SQLite index is initialised.`,
    )
  }
  const db = new Database(dbPath)

  // Filamental stores its schema version in a schema_meta table (see apply_schema()
  // in src-tauri/src/index.rs) — NOT via SQLite's PRAGMA user_version, which the
  // Rust side never touches and which therefore always reads 0.
  const versionRow = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined
  const schemaVersion = versionRow ? Number(versionRow.value) : 0
  let schemaHint: string | null = null

  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    schemaHint = schemaVersionHint(schemaVersion)
    // Log to stderr only — user never sees this in normal operation
    console.error(`[filamental-mcp] warning: ${schemaHint}`)
  }

  return { vaultPath, db, schemaHint }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  // --project; --vault is its name before 0.2.16, still written by older configs.
  const projectArg    = args['project'] ?? args['vault']
  const explicitVault = projectArg ? resolve(projectArg) : undefined
  const explicitDb    = args['db']    ? resolve(args['db'])    : undefined

  // Resolve the initial vault path: explicit arg → active-vault file.
  // Null when the last project Filamental opened has since been moved or deleted:
  // the server still starts, and the watcher below picks up the next project opened.
  let initialVaultPath: string | null = null
  let missingVaultPath: string | null = null

  if (explicitVault) {
    if (!existsSync(explicitVault)) {
      console.error(`Error: project path does not exist: ${explicitVault}`)
      process.exit(1)
    }
    initialVaultPath = explicitVault
  } else {
    const active = readActiveVault()
    if (!active) {
      console.error('Error: no project path supplied and no active-vault file found.')
      console.error('')
      console.error('Either:')
      console.error('  1. Open a project in Filamental (it writes the active-vault file automatically), or')
      console.error('  2. Pass --project <path> explicitly.')
      process.exit(1)
    }
    if (existsSync(active)) {
      initialVaultPath = active
    } else {
      missingVaultPath = active
      console.error(`[filamental-mcp] last project no longer exists: ${active} (waiting for a project to open)`)
    }
  }

  // Open the initial DB connection
  if (initialVaultPath) {
    try {
      activeState = openVault(initialVaultPath, explicitDb)
    } catch (err) {
      console.error(`Error: ${err}`)
      process.exit(1)
    }
  }

  const current = (): ActiveState => {
    if (activeState) return activeState
    throw new Error(
      `The last project Filamental opened no longer exists (${missingVaultPath}). ` +
      `Open a project in Filamental, then try again.`,
    )
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
        console.error(`[filamental-mcp] project switched → ${newPath}`)
      } catch {
        // Keep the old connection alive if the new vault's DB isn't ready yet
      }
    })
  }

  // Create the MCP server — it reads activeState on each tool call via the getter
  const server = createServer(
    () => current().db,
    () => current().vaultPath,
    () => activeState?.schemaHint ?? null,
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
