# Filamental for Claude

Filamental is a desktop app for spatial documents and planning: your notes are
markdown files on your own computer, and Filamental shows how they connect as a
graph you can explore in 2D and 3D. This plugin lets Claude work in that same
project. Claude can search your nodes, follow their connections, read the notes
behind them, and build new structure, and every change shows up in the app.

## What you need

- **The Filamental desktop app**, installed, with at least one project opened.
  Download it at [filamental.space/download](https://filamental.space/download).
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

## What it runs, reads and writes

The plugin runs one command, `npx -y filamental-mcp@0.2.10`. The first time it
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
