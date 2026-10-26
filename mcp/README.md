# filamental-mcp

The [Model Context Protocol](https://modelcontextprotocol.io/) server for
[Filamental](https://filamental.space). It lets Claude and other AI apps search, read and build the
knowledge graph in your Filamental project: the same markdown files the app shows you, so every
change appears in the app as it happens.

The server runs on your computer, works whether Filamental is open or closed, and makes no network
requests of its own.

**Requires** the Filamental desktop app, with the project opened in it at least once, and
Node.js 22 or later.

---

## Setup

### From Filamental

Open **Settings › AI**. Under **Connect an AI app**, **Connect** sets up Claude Desktop in one click.
For any other app, **Show setup** beside **Other AI apps** gives the exact block for that app, with
the paths for your computer filled in.

### By hand

Add this to your AI app's MCP settings file (`claude_desktop_config.json`, `.mcp.json` for
Claude Code, `.cursor/mcp.json` and so on):

```json
{
  "mcpServers": {
    "filamental": {
      "command": "npx",
      "args": ["-y", "filamental-mcp"]
    }
  }
}
```

No path is needed. The server works on whichever project Filamental has open, and follows you
when you open another, with no restart. To pin it to one project instead, add
`"--project", "/absolute/path/to/your/project"` to `args`.

---

## Tools

### Orient and read

| Tool | What it does |
|---|---|
| `get_structure_report` | A short orientation to the whole project: its classifications and connectors, the most connected nodes, the load-bearing ones, separate groups, and nodes that are unconnected or have no notes |
| `get_context` | One node's notes plus its neighbourhood, inlined as one readable markdown document. `dry_run` sizes it first |
| `find_path` | The shortest chain of connectors between two nodes, by name or UUID, with how each hop reads |
| `search_nodes` | Full-text search across names, notes and property values, with an optional field `filter` that also works on its own |
| `get_node` | One node's full record, notes included |
| `get_connections` | Every connector on a node, stated from that node's point of view (see [Arrow direction](#arrow-direction)) |
| `get_subgraph` | Every node and connector within up to 3 hops of a node |
| `get_project_info` | Node and connector counts, and the classification and connector type names |
| `list_node_types` | The project's classifications (entity types), with their colours and settings |
| `list_connector_types` | The project's connector types, with their colours, directions and weights |

### Write

| Tool | What it does |
|---|---|
| `create_node` | Create a node: writes its markdown file and updates the index |
| `update_node` | Change a node. Omitted fields stay as they are; a `properties` or `relationships` you pass replaces the whole set |
| `delete_node` | Delete a node and its file |
| `create_edge` | Connect two nodes |
| `delete_edge` | Remove a connector |
| `extract_section` | Move a heading's section out of a node into a node of its own, leaving a `[[wikilink]]` and a connector behind. `dry_run` previews it |
| `inline_section` | Fold a node's content back into another: the inverse of `extract_section`. `dry_run` previews it |

The content is moved, never copied, so exactly one copy of any text survives.

### Guides

| Tool | What it does |
|---|---|
| `read_skill_guide` | The full guide to designing a Filamental structure. The server sends the essentials when it connects, so this is for depth |
| `read_format_reference` | The exact on-disk format of node files and the `.filamental/` folder |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`), so your AI app can tell the
read-only tools from the ones that change or delete content.

On Filamental's free plan a project holds 20 nodes, not counting bridges, and that includes nodes
an AI creates: `create_node` says so when a project is full. Pro has no limit.

---

## Arrow direction

A connector's `direction` is one of `none`, `outgoing`, `incoming` or `bidirectional`. Nothing else
is accepted, and an unrecognised value is rejected rather than stored.

On **writes** (`create_edge`, `create_node`, `update_node`) direction is stated relative to
`source` → `target`: `outgoing` draws the arrowhead at the target, `incoming` draws it back at the
source, `bidirectional` draws both, `none` is a plain line.

On **reads** (`get_connections`) direction is instead stated relative to the node you asked about,
because that is what the user sees on screen:

| Field | Meaning |
|---|---|
| `node` | The node you asked about |
| `other` | The node at the far end |
| `direction` | Where the arrowhead is drawn, as seen from `node` |
| `stored_on` | Which node's file holds the relationship |

This matters because which end of a connector is stored as `source` is simply whichever end the
user happened to drag from, and it's invisible on the graph: an undirected connector looks the same
either way round. So the same arrow reads as `outgoing` from one end and `incoming` from the other,
and `get_connections` flips it for you. Filtering with `direction: "outgoing"` gives the edges whose
arrow points *away from* the node you asked about. A `bidirectional` edge matches both `outgoing`
and `incoming`, since it genuinely points both ways; `undirected` matches only edges with no arrow.

Use `stored_on` only if you're editing the underlying markdown file directly. It says nothing
about what the arrow does.

---

## CLI options

```
filamental-mcp                              Follow the project Filamental has open
filamental-mcp --project <path>             Pin to the project at <path>
filamental-mcp --project <path> --db <path> Also override the SQLite index path (for testing)
```

---

## How it works

Every node in a Filamental project is a markdown file with YAML front matter, inside the project
folder. The app also keeps a SQLite index of each project for fast search and traversal, stored in
the app's own settings folder rather than in the project.

The server opens that index. Read tools query it; write tools update the markdown file and the
index together, and keep any front-matter fields they don't own (Obsidian's `tags` and `aliases`,
say) exactly where they were.

---

## Compatibility

| filamental-mcp | Filamental app | Index schema |
|---|---|---|
| 0.2.6 and later | 0.3.0 and later | v6 |
| 0.2.0 – 0.2.5 | 0.2.x | v5 |

On a schema mismatch the server keeps working where it can, since the index is disposable, and
annotates any failing call with which side to update.

---

## Licence

[MIT](https://opensource.org/licenses/MIT). The Filamental desktop app itself is proprietary; its
terms are at [filamental.space/terms](https://filamental.space/terms).
