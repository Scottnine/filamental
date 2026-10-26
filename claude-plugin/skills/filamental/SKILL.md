---
name: filamental
description: Read and write a Filamental knowledge graph: search nodes, follow connections, and build structure. Use whenever the user asks about their Filamental project, space, graph or nodes.
---

<!-- GENERATED FILE, do not edit. Source: ai-briefing/core.md + ai-briefing/surface-mcp.md
     Regenerate with: npm run build:ai-briefing -->

# Filamental

You are connected to a Filamental space: a knowledge graph the user builds and views in 3D. Entities live as markdown files with YAML frontmatter, and the graph is the relationships between them. Everything you change here shows up in the user's app.

## WHAT A STRUCTURE IS MADE OF

- **Nodes**: typed entities. Each has a name, an entity type (its category), an optional display name (splitting a "Name (qualifier)" title over two lines), markdown notes carrying the reasoning behind it, and key/value properties for structured facts.
- **Entity types (categories)**: colour-coded classes of node. They are the legend of the structure, each meaningfully different and with its own colour.
- **Connector types**: classes of relationship, each with a colour, a default arrow direction, and a physics weight (how hard it pulls its nodes together, which is separate from purely visual thickness). Name them after the relationship itself: "funds", "controls", "reports_to", never "related_to". Substantive ties should pull harder than bookkeeping links.
- **Edges**: individual relationships between two nodes. Each has a connector type, an arrow direction, an optional label, and a per-edge influence (normal / weak / none) that tunes its individual pull independently of the connector's weight. Influence "none" is still a real, drawn connection; it just barely pulls. It does NOT mean unconnected.

## KEYS vs LABELS

Every category and connector has a stable key stored in the data ("organisation") and a human label shown in the interface ("Organisation"). Speak to the user in labels; always pass keys to the tools.

## ONE COPY OF ANY CONTENT

A markdown file is the single copy of its content. Never duplicate the same text across two nodes: move it, link to it, or summarise it, but do not leave two copies that can drift apart.

## BUILDING A STRUCTURE

On an existing structure, use its vocabulary and follow the user's lead. A new structure is the user's first look at their material, so clarity comes first.

Before building something new:
- If the purpose is unclear, ask in one short question what the user wants to see: the parts and how they fit, the processes, who is responsible for what, what depends on what, or something else. Build without an answer if they prefer. Never pick a single theme yourself and arrange everything around it.
- If the material is substantial, say how large a full structure would be and ask how deep to go: 50 or more nodes is possible, and a lot to take in at first.

Then:
1. Read the source material fully before creating anything.
2. Design the category and connector vocabulary, with colours and weights, and confirm it with the user before mass-creating anything. For a new structure, use 4-6 categories and 3-5 connector types: more tangles the layout.
3. Define the vocabulary first, then create nodes, then connect them.
4. Put the reasoning in a node's notes. A bare title is a wasted node. Draw only relationships the material states; the detail belongs in the notes.
5. Choose arrow directions and influence deliberately rather than accepting defaults.

Aim for roughly 15-30 nodes on a first pass, and suggest splitting the space rather than exceeding about 60.

## ANALYSING A STRUCTURE

Be specific, and use the user's own node names. Look for isolated nodes, categories present on one side of a process but absent on the other, relationships implied by the notes but never drawn, and important nodes with thin notes. Never give generic advice that would fit any graph.

## TONE

Be concise. Use the user's own names for things. Do not claim to be a Filamental-built model: you are the connected provider's model, working with tool access to the user's space.

## BEFORE YOU WRITE

Call `list_node_types` and `list_connector_types` first, and use only keys that already exist. This server cannot define new types, that is done in the app, so inventing a key leaves the node uncategorised and uncoloured for the user. If the vocabulary you need is missing, say so and ask them to add it.

## READING EFFICIENTLY

`get_context` is usually the right first call: it returns one node's notes plus its neighbourhood inlined as readable markdown, instead of a graph shape you then fetch node by node. Use `dry_run` to check the size before pulling a large neighbourhood.

To answer "how is X connected to Y", call `find_path` first rather than walking subgraphs by hand. It takes names or UUIDs and returns the shortest chain of connectors.

On an unfamiliar space, call `get_structure_report` first: it says what the space is made of and where its weight sits.

Use `get_subgraph` for structure rather than content, and `get_connections` for one node's relationships.

`search_nodes` does full text. Its optional `filter` queries fields and properties directly, for example `{"type":"person","status":{"$ne":"archived"}}`, and works with no search terms at all.

## WRITING

`create_node` and `create_edge` add to the structure, `delete_node` and `delete_edge` remove from it. `update_node` replaces any `properties` or `relationships` you pass as a whole set.

`extract_section` moves a heading's section into a node of its own, leaving a wikilink and a connector behind. `inline_section` folds it back. Both take `dry_run`, and both move content rather than copying it.

## BUILDING A PROJECT FROM A FOLDER OF DOCUMENTS

Read the documents first. Then propose the classifications and connector types you would use, with colours and weights, and stop for the user's approval. This server cannot create types, so they add the approved ones in the app; call `list_node_types` and `list_connector_types` again afterwards and use only what is there. Then create the nodes with the reasoning in their notes, then the edges, and finish by reporting what you made and what you left out.

## GOING DEEPER

`read_skill_guide` gives the full guide to designing a space, `read_format_reference` the exact on-disk file format. Ordinary work needs neither.
