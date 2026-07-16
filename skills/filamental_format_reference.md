# Filamental File Format Specification

Complete reference for reading and writing Filamental node files. Load this when generating
or validating node files — not for general analysis questions.

**Terminology note:** "Project", "folder", and "world" all refer to the same thing — the
folder on disk containing a user's work. Use "project folder" as the default term here.

---

## Node File Structure

Each node is a Markdown file with YAML frontmatter. The frontmatter holds structured
metadata; the body below the closing `---` is the node's notes in free Markdown.

### Complete frontmatter schema

```yaml
---
id: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx   # UUID v4 — see UUID section
name: Full human-readable name              # Node identity; also basis for filename
display_name: |-                            # OPTIONAL — multiline display on canvas
  First line of display name
  Second line of display name
type: entity_type_key                       # Must match a key in entity_types.json
status: active                              # active | archived; use active for new nodes
created: 2026-05-10T09:00:00.000Z          # ISO 8601 with Z timezone
modified: 2026-05-10T09:00:00.000Z         # Same as created for new nodes
modified_by: claude                         # Use 'claude' when generating
version: 1                                  # Integer; start at 1 for new nodes
properties:
  key: value                                # Custom metadata — see Properties section
  another_key: another_value               # Or write {} if none
relationships:
- target: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx   # UUID of connected node
  type: connector_type_key                         # Must match a key in connector_types.json
  direction: none                                  # none | incoming | outgoing
  label: short descriptive label                   # OPTIONAL — labels this specific connection
  influence: normal                                # normal | weak | none (UI shows the last as "Weakest" — see Labels vs Keys)
  properties: {}
attachments: []                             # Always empty when generating; user adds via UI. Not scriptable — see Known Quirks
composition_mode: atomic                    # Always atomic for standard nodes
child_view_id: ''                           # Always empty string for standard nodes
has_notes: true                             # true if markdown body is non-empty; false if blank
---

Node notes in Markdown here.

Paragraphs, bullet lists, bold text, and headers are all supported.
Wikilinks [[Node Name]] are supported and create relationships automatically when the
linked node name matches an existing node in the world.

Leave the body blank only if there is genuinely nothing to say about this node yet.
Populated notes make the world significantly more useful for both the user and for AI
analysis.
```

---

## UUID Requirements

All `id` fields must be valid UUID v4. The format is:

```
xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
```

Where:
- The `4` in position 3 is a literal `4` (version indicator)
- The first character of position 4 (`y`) must be one of: `8`, `9`, `a`, `b`
- All other positions are random lowercase hexadecimal characters
- Total structure: 8-4-4-4-12 characters separated by hyphens

**Generate properly.** Do not abbreviate, truncate, or construct UUIDs by hand from
memorable patterns. Every node in a world must have a globally unique id.

**Relationship integrity is critical.** Every `target` UUID in a relationships list must
correspond to an `id` that either:
- Already exists in the world folder (a node you read at session start), or
- Is being created in the same batch as the node referencing it

Before writing any batch of nodes, scan every `target` value and confirm it resolves.
A relationship pointing to a UUID that doesn't exist will appear as a broken connection
in Filamental.

---

## Filename Convention

Filenames derive from the node's `display_name` (if present) or `name` (if no display_name).

**Derivation rules:**
- Spaces → underscores `_`
- Newlines in `display_name` → `-n`
- Most punctuation (hyphens, dots) → preserved or replaced with underscores
- Special characters that are invalid in filenames (`/`, `\`, `:`, `$`, `%`, `#`, `"`, `?`) → underscores
- Multiple consecutive underscores are acceptable

**Examples from real worlds:**

| name / display_name | filename |
|---|---|
| `Mendoza Haulage\n34 tanker fleet` (display_name with newline) | `Mendoza_Haulage-n34_tanker_fleet.md` |
| `Minister of Infrastructure - V. Harkov` (no display_name) | `Minister_of_Infrastructure-nV__Harkov.md` |
| `Bank Account Nicosia $4.2M` | `Bank_Account-nNicosia____4_2M.md` |
| `Dept of Energy Philippines` | `Dept_of_Energy-nPhilippines.md` |
| `Petroval SEA Fuel Logistics HQ` | `Petroval_SEA-nFuel_Logistics_HQ.md` |

**When in doubt**, use a simple safe derivation: replace all spaces with underscores, avoid
special characters, keep it readable. Filamental resolves nodes by `id`, not by filename,
so a slightly imperfect filename still works — the important thing is uniqueness and no
invalid filesystem characters.

---

## Labels vs Keys — Critical Distinction

Every type in Filamental has two identifiers:

| What | Where it appears | Example |
|---|---|---|
| **Key** | Node file `type:` field, connector `type:` field | `distribution`, `money`, `controls` |
| **Label** | UI display, user conversation | `Distribution`, `Money`, `Controls` |

The same key/label split applies to the `influence` field on individual relationships: the
file always stores `normal`, `weak`, or `none`; the UI shows that last one as "Weakest." A
user talking about "the weakest tie" or "weakest influence" means `influence: none` in the
file — never write a literal `weakest` value, it isn't part of the schema.

In current Filamental projects, keys and labels are typically close or identical. They
can still diverge — particularly in older projects or when a user has customised the
label after the key was set. The principle always applies: a user describes what they see
(the label); node files require the key.

**Always use keys in files. Always use labels in conversation.**

A user asking to "connect these with the Money connector" requires `type: money` in the
file — not `type: Money`, not `type: "Money"`. Look up the correct key from the
`connector_types.json` read at session start. Never assume the key matches the label
exactly without checking.

Build a key↔label map at the start of every session and resolve in both directions.

---

## entity_types.json Structure

```json
{
  "type_key": {
    "colour": "#hexcolor",
    "default_properties": {},
    "icon": "sphere",
    "label": "Human-readable label shown in UI",
    "subtypes": {}
  }
}
```

**Key points:**
- `type_key` is the value used in node frontmatter `type:` fields — always a lowercase key,
  never the label string
- `icon` is one of: `sphere`, `cube`, `cylinder`
- `default_properties` defines which property keys are expected on nodes of this type;
  `{}` means none are formally defined
- The `unclassified` type is always present as a fallback; use it only when nothing else fits

**When scaffolding a new project**, choose type keys that are short, lowercase, and meaningful:
`person`, `company`, `account`, `document`, `system`, `process`, `location`. Avoid generic
names like `type_1` or `node` — they lose meaning as the world grows.

---

## connector_types.json Structure

```json
{
  "connector_key": {
    "colour": "#hexcolor",
    "directionality": "none",
    "label": "Human-readable label shown on connections",
    "rest_length": 150,
    "subtypes": {},
    "thickness": 1,
    "trigger": null
  }
}
```

**Key points:**
- `connector_key` is the value used in relationship `type:` fields — always a key, never
  the label string
- `rest_length` controls the default visual spacing between connected nodes (150 is standard;
  200 gives more space for complex clusters)
- The `universal` connector type is always present as a general-purpose fallback
- `style` can be `solid` or `dashed` (optional field; defaults to solid when absent)
- `physics_attraction` (optional) controls how strongly this connector pulls nodes together

**`thickness` vs `physics_attraction` — do not conflate these.** `thickness` is a pure
rendering property: it controls how bold the line looks and has no effect on the physics
simulation whatsoever. `physics_attraction` is the property that actually changes how hard a
connector type pulls its two nodes together in 2D, 3D, and Dark Energy layouts. A connector
can be visually bold (`thickness: 2`) but physically weak (`physics_attraction: 0.1`), or the
reverse — they're independent. If a project's graph looks correctly weighted at a glance but
doesn't cluster the way the underlying facts would suggest once Dark Energy or 3D is turned
on, check `physics_attraction` before assuming the type design is wrong; it's a very common
oversight to set `thickness` per connector type for visual clarity and never touch
`physics_attraction` at all, leaving every connector at the same default pull.

**`influence` is the equivalent per-edge control**, set on the individual relationship
rather than on the connector type. This is what lets two edges of the *same* connector type
behave differently — for example, two `money` edges where one represents a genuinely large,
well-evidenced transaction (`influence: normal`) and the other is a thin or largely
structural reference (`influence: weak`). Layering per-edge `influence` on top of per-type
`physics_attraction` is the combination that produces a graph where the physical layout
actually tracks the strength of the underlying facts, rather than every edge of a given type
pulling identically regardless of how significant it is.

**`influence` is its own Labels vs Keys case.** The value stored in the node file is one of
`normal`, `weak`, or `none` — write exactly that in the YAML, `none` is the correct key for
the bottom of the scale. The UI displays that bottom value as "Weakest" rather than "None,"
purely so a user reads it as the least-strength point on a scale rather than a binary
off/on. When a user asks for "the weakest setting" or similar, that means `influence: none`
in the file — don't write a literal `weakest` value, it doesn't exist in the schema.

`influence` describes attraction strength only — it says nothing about whether a
relationship is real or significant. `normal`, `weak` and `none` are three points on one
spectrum (full pull → reduced pull → barely any pull); `none` does not mean "no
relationship" or "ignore this edge," it means the edge is fully present, drawn, and
traceable, but pulls its two nodes together only minimally in the layout. A common
legitimate use of it is a real, worth-recording connection that would otherwise distort the
physics if it pulled at full strength — an administrative or reference-only link between two
nodes that are each already well-anchored elsewhere. Don't use it as a substitute for
judging an edge unimportant; the label and connector type still carry that meaning.

**When scaffolding a new project**, name connectors by relationship semantics, not by
visual properties: `owns`, `controls`, `supplies`, `depends_on`, `funds`, `related_to`.
The label can be more descriptive; the key should be short and unambiguous. Assign
`physics_attraction` at the same time you assign labels — connectors carrying the domain's
real signal should pull harder than administrative or structural ones.

---

## positions.json

Stores the x/y/z canvas coordinates of each node, keyed by node UUID:

```json
{
  "node-uuid-here": { "x": 225, "y": 410.8, "z": 0 },
  "another-uuid":   { "x": -75, "y": 57.6,  "z": 388.6 }
}
```

**Reading positions:**
- All `z: 0` → project is being worked in 2D mode
- Varied z-values → project is in 3D mode; the spread indicates how much depth the user
  has applied
- Nodes with similar x/y/z values are spatially close on the canvas — this can indicate
  intentional grouping even if no formal relationship connects them
- A node at approximately (0, 0, 0) or at the centroid of the coordinate range is
  likely the central anchor of the graph

When writing new nodes, you do not need to write entries to `positions.json` — Filamental
places new nodes automatically when the project is refreshed.

---

## world.json — Default Template

Use this template when creating a new world. The user can adjust physics settings in the
app once the world is open.

```json
{
  "appearance": {
    "connectorLabelWidth": 160,
    "degreeScaling": true,
    "gridFloor": false,
    "nodeFontFamily": "",
    "nodeMaxWidth": 432,
    "rightPanelSections": [
      {"id": "notes", "visible": true},
      {"id": "relationships", "visible": true},
      {"id": "type_properties", "visible": true},
      {"id": "attachments", "visible": true},
      {"id": "metadata", "visible": true}
    ],
    "textLabels": true
  },
  "forces": {
    "expansion": 50,
    "gravity": 0
  },
  "physics": {
    "clustering": 10,
    "damping": 0.4,
    "gravityWell": false,
    "physicsOnNavigation": false,
    "repulsion": 50
  },
  "vault": {
    "auditLogEnabled": false,
    "backupRetentionDays": 7,
    "defaultFolder": ""
  }
}
```

**A note on the `"vault"` key name.** Current terminology calls a Filamental project a
"project" or "folder" — not a "vault" — but the `world.json` schema still uses `vault` as
the internal key for this settings block, and `colour` (not `color`) throughout both
`entity_types.json` and `connector_types.json`. These are fixed schema field names, not
terminology choices, and should never be renamed as part of a terminology or spelling pass
over a project's content — the app reads these exact key names. Update prose, labels, and
node content to current terminology and spelling conventions freely; leave schema keys
alone.

---

## Properties — Guidance for Writing

Properties are free-form key-value pairs. Keys are strings; values are strings or simple
types (numbers, booleans).

When `default_properties` is defined for an entity type, use those keys. When it is `{}`,
infer appropriate keys from the node's entity type and content.

**Principle:** properties hold structured facts that are awkward to express in prose notes
but useful for quick reference, filtering, and AI analysis. Favour things that would go in
a table: dates, amounts, codes, identifiers, statuses, quantities, jurisdictions.

**Good examples by domain:**

Investigation world:
```yaml
# The entity type carrying individual claims/matters (e.g. "venture", "allegation", "matter")
properties:
  evidentiary_status: under_investigation   # e.g. proven | under_investigation | reported_pattern | alleged_unresolved
  amount: USD 2.1M
  period: "2024-2025"

# Person (political)
properties:
  role: Minister of Infrastructure
  appointed: "2017"
  nationality: Ukrainian
  party: National Progress Party

# Shell company
properties:
  jurisdiction: Cyprus
  incorporated: "2019-01-15"
  registered_capital: EUR 1000
  director: E. Harkov

# Bank account
properties:
  bank: Hellenic Bank Nicosia
  balance: USD 4.2M
  account_type: Corporate current
```

Operational/logistics world:
```yaml
# Distribution fleet
properties:
  fleet_size: "34 tankers"
  vehicle_type: Volvo FH series
  base: Manila
  operator: Mendoza Haulage

# Depot
properties:
  capacity: 12ML
  location: Manila
  status: operational
  owned_by: Petroval SEA

# System
properties:
  vendor: SAP
  product: S/4HANA
  deployment_status: Partial
  modules_live: Finance, Procurement
```

---

## Integrity Checklist

Run through this before finalising any batch of nodes. Do not skip it — broken UUIDs and
invalid type keys will cause silent failures in Filamental.

- [ ] Every `id` is a unique, properly formed UUID v4
- [ ] No two nodes in the batch share the same `id`
- [ ] No node reuses an `id` from an existing node in the world folder
- [ ] Every node `type` exactly matches a key in this world's `entity_types.json`
- [ ] Every relationship `type` exactly matches a key in this world's `connector_types.json`
- [ ] Every relationship `target` UUID resolves to either an existing node or a node in this batch
- [ ] `has_notes` is `true` if the markdown body is non-empty; `false` if blank
- [ ] `created` and `modified` are valid ISO 8601 timestamps with timezone
- [ ] Filenames are derived from `name` or `display_name` and contain no invalid filesystem characters
- [ ] No filename duplicates within the batch or with existing files in the world folder

---

## Complete Example Node

```
---
id: 3f8a2c1d-b7e4-4f9a-8d2e-1c5b9a7f3e6d
name: Meridian Holdings Cyprus
display_name: |-
  Meridian Holdings
  Cyprus
type: app
status: active
created: 2026-05-10T09:00:00.000Z
modified: 2026-05-10T09:00:00.000Z
modified_by: claude
version: 1
properties:
  jurisdiction: Cyprus
  incorporated: "2019-01-10"
  director: E. Harkov
  registered_capital: EUR 1000
relationships:
- target: 60aa8bfd-2c4c-4a2f-bc3a-43d6e85c53c5
  type: related_to
  direction: none
  label: beneficial owner (indirect)
  influence: normal
  properties: {}
- target: 9d4e7f2a-3b1c-4e8d-a5f6-2c7b8e9d1a3f
  type: data
  direction: outgoing
  label: transfers to
  influence: normal
  properties: {}
attachments: []
composition_mode: atomic
child_view_id: ''
has_notes: true
---

Shell holding company incorporated in Cyprus four months before the RD-2019-441 tender
publication. Director is E. Harkov, spouse of the Minister of Infrastructure.

Registered capital of EUR 1,000. No employees on record. Primary purpose appears to be
receipt and onward transfer of contract proceeds.

**Relationship to tender:** Harkov Construction LLC (the winning bidder) transferred
EUR 2.1M to Meridian Holdings within 90 days of contract award. No commercial rationale
on record.
```

---

## Notes on Fields Under Development

The following fields are present in all nodes but have limited current function. Include
them in generated files with these values and expect their role to expand in future
Filamental versions:

- `composition_mode: atomic` — always use this value
- `child_view_id: ''` — always empty string
- `metadata` in `world.json` — the audit log section will expand; leave defaults as shown

---

## Known Quirks

**Concurrent writes while the project is open live in the app.** If a user has the project
open in Filamental while you're also writing to the same folder, a save from the app and a
write from you can occasionally collide. The most visible symptom is a `.filamental/*.json`
config file (`entity_types.json`, `connector_types.json`, `world.json`) that reads back as
truncated or invalid JSON — cut off mid-value, missing its closing braces — even though it
looked complete moments earlier in a different read.

This is a save-timing collision, not permanent data loss. Handle it as follows:
1. Re-read the file — it may already have resolved by the time you check again.
2. If it's still incomplete, reconstruct it from whatever partial content is visible in the
   truncated read, rather than overwriting from your own cached copy of what the file used
   to contain. If the user has been adjusting settings live in the app (physics sliders,
   colours, etc.), those changes may be reflected in the partial file and must be preserved,
   not clobbered.
3. Re-validate as JSON (or re-parse the YAML frontmatter, for node files) after any repair,
   before relying on it further.
4. Don't state a cause to the user with more confidence than the evidence supports. What you
   know is: the file was incomplete, here's what was recoverable, here's what was rewritten.
   Whether it was the app's save, your own write, or a filesystem sync delay is often not
   determinable from the file alone — say so rather than guessing.

**Attachments cannot be added programmatically.** The `attachments: []` field is not
something to populate by hand, and there is no tool call, API, or file-placement trick that
creates a real attachment. It is drag-and-drop only, inside the app. Do not satisfy an
"attach a file" request by copying a file into `.filamental/assets/<node-id>/` and reporting
the node as having an attachment — that folder is where the app stores things like
`cover_image` once *it* has written them, but a file placed there manually is never picked
up or referenced by the node, and `attachments` will still read back as `[]`. If asked to
get a file "into" a node and there's a live MCP connection to the project (`mcp__filamental__*`
tools resolving successfully), that MCP has no attachment parameter either — check with
`get_node` before claiming success, don't assume a write worked. The correct approach: create
the file, leave it somewhere visible in the project folder (not inside `.filamental/`), point
to it by name in the node's notes, and tell the user it needs manual drag-and-drop — there is
no scripted alternative. Note that dragging a file into the app this way creates a distinct
file-backed node (type defaults to `unclassified`, properties carry `_asset_rel_path` and
`_asset_ext`, and the node has no markdown file of its own), not a markdown node with an
attachment — if the user wants a document to be independently clickable-to-open from the
graph rather than attached to an existing node, that file-node behaviour is probably what
they actually want; confirm which before building either one.
