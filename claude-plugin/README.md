# Filamental for Claude

Filamental is a spatial app for systems and visual thinkers. 2D & 3D work for almost any role or task. Create connected networks, networked documents, documented knowledge.

Limited only by your imagination, add anything, link to anything, share to anyone.

Add themes, colors, tables, columns, images and backgrounds to enhance your work.

Privacy: Your data stays on your machine, under your control and you decide where it goes.

- Intuitive navigation and UI
- Switch between building and publishing.
- Huge range of visual styling options for beautiful documents
- Share and open anywhere using links or html files
- Custom categories and structured properties
- Custom connector types with directional arrows, labels, colors, weights
- Obsidian, Wikilink and Mermaid compatibility
- Insert any files of any type to link them into your project
- Folder bridges jump between your spaces
- All local. You set the terms. You choose where your data resides, not us.
- Built-in help playground, templates, feature suggestions, bug reporting and granular adjustments

## What Claude can do

- **Get its bearings.** A structure report says what a space is made of, which
  nodes carry the most weight, and which are unconnected or still have no notes.
- **Read in context.** One call returns a node's notes with its whole
  neighbourhood inlined as a single readable document.
- **Answer "how is X connected to Y?"** It finds the shortest chain of
  connectors between two nodes, the same route Pathfinder lights in Filamental,
  and says how each hop reads.
- **Search** names, notes and property values, or filter on any field.
- **Build and edit** nodes and connectors, using the space's own node types and
  connector types.
- **Restructure** a long note by moving a section into a node of its own, or
  folding one back in. The text moves rather than being copied, so there's only
  ever one copy of it.

The skill shows Claude how to build a structure that stays clear, with a small,
deliberate set of types, the reasoning written into each node's notes, and only
the relationships your material actually states.

## What you need

- **Filamental**, installed, with a space open. It's a free download at
  [filamental.space/download](https://filamental.space/download), with no
  account and no form.
- **Node.js 22 or later**, since the plugin starts the Filamental MCP server
  with `npx`.

## Where it works

| Surface | What loads |
| --- | --- |
| Claude Code | The skill and the MCP server |
| Cowork, running on your computer | The skill and the MCP server |
| Claude chat | The skill only. Chat doesn't start servers on your computer, so the tools aren't there |

## What's in the plugin

| File | Purpose |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest |
| `.mcp.json` | Starts the Filamental MCP server over stdio |
| `skills/filamental/SKILL.md` | How Claude should read and build a Filamental structure |

## The tools

| Read | Write |
| --- | --- |
| `get_structure_report`, `get_context`, `find_path`, `search_nodes`, `get_node`, `get_connections`, `get_subgraph`, `get_project_info`, `list_node_types`, `list_connector_types`, `read_skill_guide`, `read_format_reference` | `create_node`, `update_node`, `delete_node`, `create_edge`, `delete_edge`, `extract_section`, `inline_section` |

Every tool carries MCP annotations that mark it read-only or say whether it
changes or deletes content. Each one is described in the
[server's README](https://github.com/Scottnine/filamental/tree/main/mcp#tools).

## What it runs, reads and writes

The plugin runs one command, `npx -y filamental-mcp@0.2.16`. The first time it
runs, npx downloads that exact version of the
[`filamental-mcp`](https://www.npmjs.com/package/filamental-mcp) package and its
dependencies from the public npm registry. Its source is in the
[`mcp/`](https://github.com/Scottnine/filamental/tree/main/mcp) folder of this
repository.

From then on the server works entirely on your computer:

- It reads Filamental's settings folder, to find the space you have open and
  the reference guides Filamental installs.
- It reads and searches the Markdown files in that space, and the
  `.filamental/` folder that holds its node types and connector types.
- When you ask Claude to, it creates, edits and deletes node files in that
  space. They're the same files Filamental shows you, so you see each change as
  it happens.

It makes no other network requests, and your notes stay on your computer.
Filamental has no telemetry.

## Licence

The plugin and the Filamental MCP server are MIT licensed. Filamental itself is
proprietary, and its terms are at
[filamental.space/terms](https://filamental.space/terms).
