# Filamental for Claude Code

The full Filamental plugin: the Filamental MCP server and the skill that shows Claude how to read
and build a Filamental structure, in one install.

```
/plugin marketplace add Scottnine/filamental
/plugin install filamental@filamental
```

## What you need

- **Filamental**, installed, with your project opened in it once on this computer. It's a free
  download at [filamental.space/download](https://filamental.space/download), with no account and
  no form.
- **Node.js 22 or later**, since the plugin starts the Filamental MCP server with `npx`.

## What's in the plugin

| File | Purpose |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest |
| `.mcp.json` | Starts the Filamental MCP server over stdio |
| `skills/filamental/SKILL.md` | How Claude should read and build a Filamental structure |

The tools are listed in the [server's README](https://github.com/Scottnine/filamental/tree/main/mcp#tools).

## What it runs, reads and writes

The plugin runs one command, `npx -y filamental-mcp@0.2.19`. The first time it runs, npx
downloads that exact version of the [`filamental-mcp`](https://www.npmjs.com/package/filamental-mcp)
package and its dependencies from the public npm registry. Its source is in the
[`mcp/`](https://github.com/Scottnine/filamental/tree/main/mcp) folder of this repository.

From then on the server works entirely on your computer:

- It reads Filamental's settings folder, to find the project you have open and the reference
  guides Filamental installs.
- It reads and searches the Markdown files in that project, and the `.filamental/` folder that
  holds its node types and connector types.
- When you ask Claude to, it creates, edits and deletes node files in that project. They're the
  same files Filamental shows you, so you see each change as it happens.

It makes no other network requests, and your notes stay on your computer. Filamental has no
telemetry.

## Licence

The plugin and the Filamental MCP server are MIT licensed. Filamental itself is proprietary, and
its terms are at [filamental.space/terms](https://filamental.space/terms).
