# ⬡ ContextGraph

> A living neural knowledge graph — every file, symbol, decision, and conversation is a node with Hebbian-weighted edges.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## What Is This?

ContextGraph is an MCP server + CLI that builds a **living knowledge graph** of your dev project. Every concept is a node; every relationship is a **weighted directed edge**. Edge weights:

- **Strengthen** when you revisit them (Hebbian learning: `w += 0.1` per co-occurrence)
- **Decay** over time (synaptic pruning: `w × 0.95` every 24h)
- **Archive** when weight falls below `0.05`

Context injection does **weighted BFS** from your current file, assembles only the highest-signal nodes into the context window. No more random truncation.

```
[CONTEXT GRAPH]
Current: auth.ts (w=1.00)
  → useAuth() [symbol, w=0.92] [defines]
  → JWT [concept, w=0.88] [decided_in]
  → session-2026-06-21 [session, w=0.71] [decided_in]
  → #312 CORS error [bug, w=0.64] [caused_by]
```

---

## Node Types

| Type | Example | Source |
|------|---------|--------|
| `file` | `auth.ts` | File watcher |
| `symbol` | `useAuth()` | AST extraction |
| `decision` | "use JWT not sessions" | Conversation NLP |
| `bug` | `#312 CORS error` | Git / conversation |
| `concept` | `Polygon`, `IPFS` | NLP extraction |
| `session` | `session-2026-06-21` | Auto-created |
| `pattern` | "always use Zod" | Repeated mentions |
| `tool` | `Cursor`, `Claude` | MCP client |

## Edge Types

`imports` · `references` · `caused_by` · `decided_in` · `similar_to` · `co_edited` · `defines` · `mentions` · `tagged_with`

---

## Quick Start

```bash
# In any project
npx contextgraph init        # Scan project, build initial graph
npx contextgraph watch       # Start background watchers

# Install into your editor
npx contextgraph install cursor       # → .cursor/mcp.json
npx contextgraph install vscode       # → .vscode/mcp.json
npx contextgraph install claude-code  # → ~/.claude/mcp.json

# Visualize
npx contextgraph graph                # Opens D3 force graph at localhost:7331

# Export
npx contextgraph export obsidian ./vault   # Obsidian vault with [[wikilinks]]
npx contextgraph export graphify ./out      # graphify-compatible graph.json
```

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `graph_write` | Upsert a node + edges, strengthen weights |
| `graph_read` | BFS subgraph from a node |
| `graph_search` | Text search across all nodes |
| `graph_inject` | Build ranked context window string |
| `graph_decay` | Run weight decay pass |
| `graph_export` | Export (obsidian/graphify/json) |
| `graph_log_message` | Feed conversation turns → NLP extraction |
| `graph_stats` | Node/edge counts, hot subgraph |

---

## MCP Configuration

Add to `.cursor/mcp.json` (or use `ctx install cursor`):

```json
{
  "mcpServers": {
    "contextgraph": {
      "command": "node",
      "args": ["/path/to/contextgraph/dist/server.js"],
      "env": {
        "CONTEXTGRAPH_PROJECT_ROOT": "/path/to/your/project",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

---

## CLI Commands

```bash
ctx init [path]              # Scan + build graph
ctx watch [path]             # Background watchers
ctx add "decided to use JWT" # Add decision node
ctx add "Polygon" -t concept # Add concept node  
ctx search "auth flow"       # Semantic search
ctx inject --file auth.ts    # Print context window
ctx graph                    # Open D3 visualization
ctx export obsidian ./vault  # Export to Obsidian
ctx export graphify ./out    # Export to Graphify
ctx install cursor           # Install MCP config
ctx stats                    # Graph statistics
ctx decay                    # Manual decay pass
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTGRAPH_DATA_DIR` | `./.contextgraph` | Where graph is stored |
| `CONTEXTGRAPH_PROJECT_ROOT` | `process.cwd()` | Project root to watch |
| `ANTHROPIC_API_KEY` | — | Enables Claude Haiku NLP extraction |

---

## Hebbian Weight System

```
Initial weight:     w = 0.5
Co-occurrence:      w = min(1.0, w + 0.1)
Git co-commit:      w = min(1.0, w + 0.15)
24h decay:          w = w × 0.95
Archive threshold:  w < 0.05 → archived
```

---

## Visualization

`ctx graph` opens a D3 force graph at `http://localhost:7331`:

- **Node size** → degree centrality + access count
- **Node color** → type (file=blue, decision=amber, concept=purple…)
- **Edge thickness** → weight
- **Live reload** via SSE when graph changes
- **Search bar** highlights matching nodes
- **Click** node → side panel with edges, weights, content

---

## Export Formats

### Obsidian
One `.md` per node with YAML frontmatter (weight, type, dates) and `[[wikilinks]]` for edges.

### Graphify
Compatible with the [graphify skill](https://github.com/vinay3254/Contextgraph) — `graph.json` with `nodes[{id,label,type,weight}]` + `edges[{source,target,weight,type}]`.

### JSON
Raw export with all nodes, edges, stats, and timestamps.

---

## Architecture

```
src/
├── server.ts          # MCP stdio entry point
├── graph/
│   ├── schema.ts      # Zod types, Hebbian constants
│   ├── kuzu.ts        # Embedded graph DB (JSON persistence)
│   └── decay.ts       # 24h decay scheduler
├── watchers/
│   ├── files.ts       # chokidar + regex AST extraction
│   └── git.ts         # simple-git commit observer
├── inject/
│   └── builder.ts     # Weighted BFS context builder
├── export/
│   ├── obsidian.ts    # Obsidian vault exporter
│   └── graphify.ts    # Graphify JSON exporter
├── viz/
│   └── server.ts      # D3 force graph (localhost:7331)
├── cli/
│   └── ctx.ts         # commander CLI
└── nlp/
    └── extractor.ts   # Claude Haiku entity extractor
```

---

## License

MIT © 2026 vinay3254
