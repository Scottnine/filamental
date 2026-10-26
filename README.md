# Filamental

Spatial documents and planning, for Windows, macOS and Linux. Filamental takes a folder of
markdown files and shows how they connect, as a structure you can explore in 2D and 3D. Your files
stay on your own computer.

**[filamental.space](https://filamental.space)**

---

## Install

Every download is on [filamental.space/download](https://filamental.space/download), with no
account and no form, and the installers are attached to each
[release](https://github.com/Scottnine/filamental/releases/latest) here too.

| Platform | Install |
|---|---|
| Windows 10 and 11 | The installer (`.exe` or `.msi`), the [Microsoft Store](https://apps.microsoft.com/detail/9PDFB1Q5RVCS), `winget install Filamental.Filamental` or `choco install filamental` |
| macOS 10.15 and later | The universal `.dmg`, or `brew install --cask scottnine/filamental/filamental` |
| Linux | The `.deb` or the AppImage, from the [download page](https://filamental.space/download) |

Once installed, Filamental keeps itself up to date.

---

## What's in this repository

| Folder | What it is |
|---|---|
| [`mcp/`](mcp) | The Filamental MCP server, [`filamental-mcp`](https://www.npmjs.com/package/filamental-mcp) on npm. It lets Claude and other AI apps search, read and build your Filamental project |
| [`claude-plugin/`](claude-plugin) | Filamental as a Claude plugin: the MCP server plus a skill that teaches Claude how to work with a Filamental structure |
| [`skills/`](skills) | The Filamental agent skill and file-format reference, for AI apps that read skills |

---

## Licence

The **Filamental application** is proprietary. All rights reserved. It is licensed to end users
solely under the terms at [filamental.space/terms](https://filamental.space/terms). This repository
does not contain its source.

The **MCP server** (`mcp/`), the **Claude plugin** (`claude-plugin/`) and the **agent skills**
(`skills/`) are MIT licensed so that other tools can integrate with Filamental. That permission
covers those directories only.

See [LICENSE](LICENSE) for the full statement.
