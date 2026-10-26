# Filamental for Claude

Filamental is a desktop app for spatial documents and planning: your notes are
markdown files on your own computer, and Filamental shows how they connect as a
graph you can explore in 2D and 3D. This plugin lets Claude work in that same
project. Claude can search your nodes, follow their connections, read the notes
behind them, and build new structure, and every change shows up in the app.

## What Claude can do

- **Get its bearings.** A structure report says what a project is made of, which
  nodes carry the most weight, and which are unconnected or have no notes yet.
- **Read in context.** One call returns a node's notes with its whole
  neighbourhood inlined as a single readable document.
- **Answer "how is X connected to Y?"** by finding the shortest chain of
  connectors between two nodes, and saying how each hop reads.
- **Search** across names, notes and property values, or filter on any field.
- **Build and edit.** Create, update and delete nodes and connectors, using the
  project's own classifications and connector types.
- **Restructure.** Move a section out of a long note into a node of its own, or
  fold one back in. The text is moved, never copied, so there is only ever one
  copy of it.

The skill teaches Claude how to read a Filamental structure and build one that
stays clear: a small, deliberate vocabulary, reasoning in the notes, and only
the relationships your material actually states.

## What you need

- **The Filamental desktop app**, installed, with at least one project opened.
  It's a free download at [filamental.space/download](https://filamental.space/download).
  On the free plan a project holds 20 nodes, including the ones Claude creates,
  and Pro has no limit.
- **Node.js 22 or later**, because the plugin starts the Filamental MCP server
  with `npx`.

## Where it works

| Surface | What loads |
| --- | --- |
| Claude Code | The skill and the MCP server |
| Cowork, running on your computer | The skill and the MCP server |
| Claude chat | The skill only. Chat doesn't start local servers, so the tools aren't available there |

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
changes or deletes content. Each is described in the
[server's README](https://github.com/Scottnine/filamental/tree/main/mcp#tools).

## What it runs, reads and writes

The plugin runs one command, `npx -y filamental-mcp@0.2.16`. The first time it
runs, npx downloads that exact version of the
[`filamental-mcp`](https://www.npmjs.com/package/filamental-mcp) package and its
dependencies from the public npm registry. Its source is in the
[`mcp/`](https://github.com/Scottnine/filamental/tree/main/mcp) folder of this
repository.

The server then works entirely on your computer:

- It reads the Filamental app's settings folder, to find the project you have
  open and the reference guides the app installs.
- It reads and searches the markdown files in that project, and the
  `.filamental/` folder that holds its categories and connector types.
- When you ask Claude to, it creates, edits and deletes node files in that
  project. Those are the same files the app shows you, so you see each change
  as it happens.

It makes no other network requests and sends your notes nowhere. Filamental
collects no telemetry.

## Licence

This plugin and the Filamental MCP server are MIT licensed. The Filamental
desktop app is proprietary, and its terms are at
[filamental.space/terms](https://filamental.space/terms).
