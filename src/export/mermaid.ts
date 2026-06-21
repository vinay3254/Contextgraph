// src/export/mermaid.ts
// Exports subgraphs and full graph as Mermaid diagrams
// Supports: flowchart (default), timeline (sessions), and class diagram (symbols)

import fs from 'fs/promises';
import path from 'path';
import { mkdirSync } from 'fs';
import type { GraphDB } from '../graph/kuzu.js';
import type { NodeType } from '../graph/schema.js';

// Mermaid-safe label: escape quotes, strip special chars
function mermaidLabel(label: string): string {
  return label.replace(/["\[\]{}|]/g, '_').slice(0, 60);
}

// Node shape by type
function nodeShape(type: NodeType | string): { open: string; close: string } {
  const shapes: Record<string, { open: string; close: string }> = {
    file:     { open: '[',  close: ']' },
    symbol:   { open: '((', close: '))' },
    decision: { open: '{{', close: '}}' },
    bug:      { open: '[/', close: '/]' },
    concept:  { open: '([', close: '])' },
    session:  { open: '[(', close: ')]' },
    pattern:  { open: '[\\', close: '\\]' },
    tool:     { open: '(',  close: ')' },
  };
  return shapes[type] ?? { open: '[', close: ']' };
}

// Mermaid style class by type
const TYPE_STYLES: Record<string, string> = {
  file:     'fill:#1e40af,stroke:#3b82f6,color:#fff',
  symbol:   'fill:#065f46,stroke:#34d399,color:#fff',
  decision: 'fill:#92400e,stroke:#fbbf24,color:#fff',
  bug:      'fill:#7f1d1d,stroke:#f87171,color:#fff',
  concept:  'fill:#4c1d95,stroke:#a78bfa,color:#fff',
  session:  'fill:#1e293b,stroke:#94a3b8,color:#fff',
  pattern:  'fill:#7c2d12,stroke:#f97316,color:#fff',
  tool:     'fill:#164e63,stroke:#06b6d4,color:#fff',
};

export class MermaidExporter {
  private db: GraphDB;

  constructor(db: GraphDB) {
    this.db = db;
  }

  // ─── Full graph flowchart (top N nodes by PageRank) ───────────────────────
  async exportFlowchart(opts: {
    outPath?: string;
    maxNodes?: number;
    subgraphNodeIds?: string[];
    direction?: 'TD' | 'LR' | 'BT' | 'RL';
  } = {}): Promise<string> {
    const { maxNodes = 60, direction = 'LR' } = opts;

    let nodes = this.db.getAllNodes();
    let edges = this.db.getAllEdges(false);

    // Filter to subgraph if specified
    if (opts.subgraphNodeIds && opts.subgraphNodeIds.length > 0) {
      const subSet = new Set(opts.subgraphNodeIds);
      nodes = nodes.filter((n) => subSet.has(n.id));
      edges = edges.filter((e) => subSet.has(e.sourceId) && subSet.has(e.targetId));
    }

    // Limit nodes by access count (most active first)
    if (nodes.length > maxNodes) {
      nodes = nodes
        .sort((a, b) => (b.accessCount ?? 0) - (a.accessCount ?? 0))
        .slice(0, maxNodes);
      const nodeSet = new Set(nodes.map((n) => n.id));
      edges = edges.filter((e) => nodeSet.has(e.sourceId) && nodeSet.has(e.targetId));
    }

    const lines: string[] = [`flowchart ${direction}`];

    // Group by type (subgraphs)
    const byType = new Map<string, typeof nodes>();
    for (const node of nodes) {
      if (!byType.has(node.type)) byType.set(node.type, []);
      byType.get(node.type)!.push(node);
    }

    // Add style classes
    lines.push('');
    for (const [type, style] of Object.entries(TYPE_STYLES)) {
      lines.push(`  classDef ${type}Node ${style}`);
    }
    lines.push('');

    // Subgraph per type
    for (const [type, typeNodes] of byType) {
      if (typeNodes.length === 0) continue;
      lines.push(`  subgraph ${type.toUpperCase()}S["${type} nodes"]`);
      for (const node of typeNodes) {
        const { open, close } = nodeShape(node.type);
        const safeId = node.id.replace(/[^a-zA-Z0-9_]/g, '_');
        const label = mermaidLabel(node.label);
        lines.push(`    ${safeId}${open}"${label}"${close}:::${type}Node`);
      }
      lines.push('  end');
    }

    lines.push('');

    // Edges
    const edgeTypeArrows: Record<string, string> = {
      imports:    '-->|imports|',
      references: '-.->|refs|',
      caused_by:  '-->|caused_by|',
      decided_in: '==>|decided_in|',
      similar_to: '<-->|similar|',
      co_edited:  '-->|co_edited|',
      defines:    '-->|defines|',
      mentions:   '-.->|mentions|',
      tagged_with:'-->|tagged|',
    };

    // Only show edges with weight > 0.15, sort by weight
    const significantEdges = edges
      .filter((e) => (e.weight ?? 0) > 0.15)
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

    for (const edge of significantEdges.slice(0, 200)) {
      const srcId = edge.sourceId.replace(/[^a-zA-Z0-9_]/g, '_');
      const tgtId = edge.targetId.replace(/[^a-zA-Z0-9_]/g, '_');
      const arrow = edgeTypeArrows[edge.type] ?? '-->|?|';
      const weightTag = `w=${(edge.weight ?? 0).toFixed(2)}`;
      lines.push(`  ${srcId} ${arrow.replace('|', `|${weightTag} `)} ${tgtId}`);
    }

    const diagram = lines.join('\n');
    if (opts.outPath) {
      mkdirSync(path.dirname(opts.outPath), { recursive: true });
      await fs.writeFile(opts.outPath, diagram, 'utf-8');
    }
    return diagram;
  }

  // ─── Timeline diagram (sessions over time) ───────────────────────────────
  async exportTimeline(outPath?: string): Promise<string> {
    const nodes = this.db.getAllNodes();
    const sessions = nodes
      .filter((n) => n.type === 'session')
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));

    const lines: string[] = ['timeline', '  title ContextGraph Session Timeline'];

    for (const session of sessions) {
      const date = session.createdAt
        ? new Date(session.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'Unknown date';
      const accessInfo = session.accessCount ? ` (${session.accessCount} accesses)` : '';
      lines.push(`  section ${date}`);
      lines.push(`    ${mermaidLabel(session.label)}${accessInfo}`);
    }

    if (sessions.length === 0) {
      lines.push('  section No sessions yet');
      lines.push('    Run ctx watch to start tracking sessions');
    }

    const diagram = lines.join('\n');
    if (outPath) {
      mkdirSync(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, diagram, 'utf-8');
    }
    return diagram;
  }

  // ─── Class diagram (symbols + files) ─────────────────────────────────────
  async exportClassDiagram(outPath?: string): Promise<string> {
    const nodes = this.db.getAllNodes().filter((n) => n.type === 'file' || n.type === 'symbol');
    const edges = this.db.getAllEdges(false).filter(
      (e) => e.type === 'defines' || e.type === 'imports' || e.type === 'references'
    );

    const lines: string[] = ['classDiagram'];

    // Symbols grouped by their file
    const fileSymbols = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.type === 'file') fileSymbols.set(node.id, []);
    }

    for (const edge of edges) {
      if (edge.type === 'defines') {
        const syms = fileSymbols.get(edge.sourceId);
        const symNode = this.db.getNode(edge.targetId);
        if (syms && symNode) {
          syms.push(`  +${mermaidLabel(symNode.label)}()`);
        }
      }
    }

    // Emit class per file
    for (const [fileId, symbols] of fileSymbols) {
      const fileNode = this.db.getNode(fileId);
      if (!fileNode) continue;
      const className = mermaidLabel(fileNode.label).replace(/[./]/g, '_');
      lines.push(`  class ${className} {`);
      for (const sym of symbols.slice(0, 10)) lines.push(sym);
      lines.push('  }');
    }

    // Import relationships
    for (const edge of edges.filter((e) => e.type === 'imports').slice(0, 50)) {
      const src = this.db.getNode(edge.sourceId);
      const tgt = this.db.getNode(edge.targetId);
      if (!src || !tgt) continue;
      const srcClass = mermaidLabel(src.label).replace(/[./]/g, '_');
      const tgtClass = mermaidLabel(tgt.label).replace(/[./]/g, '_');
      lines.push(`  ${srcClass} ..> ${tgtClass} : imports`);
    }

    const diagram = lines.join('\n');
    if (outPath) {
      mkdirSync(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, diagram, 'utf-8');
    }
    return diagram;
  }

  // ─── Wrapped HTML with live preview ──────────────────────────────────────
  async exportHTMLPreview(outPath: string, diagramType: 'flowchart' | 'timeline' | 'class' = 'flowchart'): Promise<void> {
    let diagram: string;
    if (diagramType === 'timeline') diagram = await this.exportTimeline();
    else if (diagramType === 'class') diagram = await this.exportClassDiagram();
    else diagram = await this.exportFlowchart({ maxNodes: 50 });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ContextGraph — Mermaid Export</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <style>
    body { background: #0a0b0e; color: #e2e8f0; font-family: Inter, sans-serif; padding: 24px; }
    h1 { background: linear-gradient(135deg,#6366f1,#a78bfa); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
    .mermaid { background: #12141a; border-radius: 12px; padding: 24px; margin-top: 16px; }
    pre { background: #12141a; padding: 16px; border-radius: 8px; font-size: 12px; overflow: auto; color: #94a3b8; }
    button { background: #6366f1; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; margin-right: 8px; }
  </style>
</head>
<body>
  <h1>⬡ ContextGraph</h1>
  <p style="color:#64748b">Generated: ${new Date().toISOString()} · Type: ${diagramType}</p>
  <button onclick="navigator.clipboard.writeText(document.querySelector('pre').textContent)">Copy Diagram</button>
  <div class="mermaid">${diagram}</div>
  <details style="margin-top:16px"><summary style="cursor:pointer;color:#6366f1">View raw Mermaid source</summary>
    <pre>${diagram.replace(/</g, '&lt;')}</pre>
  </details>
  <script>mermaid.initialize({ theme: 'dark', startOnLoad: true });</script>
</body>
</html>`;

    mkdirSync(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, html, 'utf-8');
  }
}
