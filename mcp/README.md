# filamental-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that connects AI assistants (Claude Desktop, Claude Code, etc.) directly to your [Filamental](https://filamental.app) knowledge graph.

The server reads and writes your vault -- searching nodes, following connections, creating and updating content -- while Filamental is running or closed. It talks to the same SQLite index the app uses, so changes are immediately visible when you open Filamental.

**Requires Node.js 22+ and Filamental desktop app.**

---

## Prerequisites

- [Filamental](https://filamental.app) installed and at least one vault opened (this initialises the SQLite index)
- Node.js 22 or later

---

## Setup via Filamental

The easiest way to connect is through the app:

1. Open Filamental and go to **Settings > AI Integrations**
2. Click **Connect to Claude Desktop**
3. Restart Claude Desktop

Filamental resolves all paths automatically. The MCP follows whichever vault you have open — no restart needed when you switch worlds.

---

## Manual setup

Install globally:

```bash
npm install -g filamental-mcp
```

Then add to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "filamental": {
      "command": "node",
      "args": [
        "--no-warnings",
        "/absolute/path/to/node_modules/filamental-mcp/dist/index.js"
      ]
    }
  }
}
```

No `--vault` argument needed. The server reads the active vault from Filamental automatically and reconnects when you switch worlds. To pin to a specific vault (e.g. for testing), pass `--vault <absolute-path>` explicitly.

### Claude Code

Add a `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "filamental": {
      "command": "npx",
      "args": [
        "filamental-mcp",
        "--vault",
        "/absolute/path/to/your/vault"
      ]
    }
  }
}
```

---

## Tools

### Read

| Tool | Description |
|---|---|
| `get_vault_info` | Node and edge counts plus entity and connector type names |
| `list_node_types` | Full entity type configuration for this vault |
| `list_connector_types` | Full connector type configuration for this vault |
| `search_nodes` | Full-text search across node names, note bodies and property values |
| `get_node` | Full node record by UUID |
| `get_connections` | All edges connected to a node, with source and target names resolved |
| `get_subgraph` | BFS traversal from a root node up to N hops (max depth 3) |

### Write

| Tool | Description |
|---|---|
| `create_node` | Create a new node -- writes a markdown file and updates the SQLite index |
| `update_node` | Update an existing node; omitted fields are unchanged |
| `delete_node` | Delete a node and remove it from the index |
| `create_edge` | Add a relationship between two nodes |
| `delete_edge` | Remove a relationship between two nodes |

---

## CLI options

```
filamental-mcp --vault <path>          Use vault at <path>
filamental-mcp --vault <path> --db <path>   Override the SQLite database path (for testing)
```

---

## How it works

Filamental stores all node data as Markdown files with YAML frontmatter inside your vault folder. It also maintains a SQLite index (stored in your OS app-config directory, not inside the vault) for fast full-text search and graph traversal.

This server opens that SQLite index read-write. Read tools query it directly. Write tools update both the Markdown file on disk and the SQLite index so the Filamental app sees changes immediately on next load.

---

## Known limitations

- The pre-built binary (`better-sqlite3`) is Windows x64 only. Other platforms require building from source.
- The server must be restarted if you change the active vault in Filamental.
- Auto-config via Filamental Settings has been tested on Windows. macOS path resolution is included but untested.

---

## License

[MIT](https://opensource.org/licenses/MIT) — Copyright Blackcat Marketing LLC
