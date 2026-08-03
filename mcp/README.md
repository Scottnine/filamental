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
| `get_connections` | All edges connected to a node, reported from that node's point of view (see [Arrow direction](#arrow-direction)) |
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

## Arrow direction

A connector's `direction` is one of `none`, `outgoing`, `incoming` or `bidirectional`. Nothing else is accepted, and an unrecognised value is rejected rather than stored.

On **writes** (`create_edge`, `create_node`, `update_node`) direction is stated relative to `source` → `target`: `outgoing` draws the arrowhead at the target, `incoming` draws it back at the source, `bidirectional` draws both, `none` is a plain line.

On **reads** (`get_connections`) direction is instead stated relative to the node you asked about, because that is what the user sees on screen:

| Field | Meaning |
|---|---|
| `node` | The node you asked about |
| `other` | The node at the far end |
| `direction` | Where the arrowhead is drawn, as seen from `node` |
| `stored_on` | Which node's file holds the relationship |

This distinction matters. Which end of a connector is stored as `source` is decided by whichever end the user happened to drag from when drawing it, and is invisible on the graph — an undirected connector looks identical either way round. So the same arrow reads as `outgoing` from one end and `incoming` from the other, and `get_connections` flips it for you. Filtering with `direction: "outgoing"` gives you edges whose arrow points *away from* the node you asked about, never edges that merely happen to be stored with it as `source`. A `bidirectional` edge matches both `outgoing` and `incoming` filters, since it genuinely points both ways; `undirected` matches only edges with no arrow at all.

Use `stored_on` only if you are editing the underlying Markdown file directly. It says nothing about what the arrow does.

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

## Compatibility

| filamental-mcp | Filamental app | DB schema |
|---|---|---|
| 0.2.6+ | 0.3.0 and later (current) | v6 |
| 0.2.0 – 0.2.5 | 0.2.x | v5 |

The server keeps working even on a schema mismatch (the DB is a disposable index, so most read/write operations tolerate drift). If a tool call fails for an unrelated reason while versions are mismatched, the error message is annotated with which side to update.

---

## Known limitations

- The pre-built binary (`better-sqlite3`) is Windows x64 only. Other platforms require building from source.
- Auto-config via Filamental Settings has been tested on Windows. macOS path resolution is included but untested.

---

## License

[MIT](https://opensource.org/licenses/MIT) — Copyright Filamental
