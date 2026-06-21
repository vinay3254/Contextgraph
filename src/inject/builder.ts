// src/inject/builder.ts
// Weighted BFS context injection — builds ranked context window string
// from current file/task node, walks graph by edge weight

import path from 'path';
import type { GraphDB } from '../graph/kuzu.js';
import type { GraphNode } from '../graph/schema.js';
import { NODE_TYPE_COLORS } from '../graph/schema.js';

const CHARS_PER_TOKEN = 4;

interface ContextNode extends GraphNode {
  _weight: number;
  _depth: number;
  _edgeType?: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function formatNodeLine(node: ContextNode): string {
  const indent = '  '.repeat(node._depth);
  const weightStr = node._weight.toFixed(2);
  const typeTag = node.type.padEnd(8);
  const edgeHint = node._edgeType ? ` [${node._edgeType}]` : '';
  return `${indent}→ ${node.label} (${typeTag} w=${weightStr})${edgeHint}`;
}

export class ContextBuilder {
  private db: GraphDB;

  constructor(db: GraphDB) {
    this.db = db;
  }

  async build(options: {
    currentFile?: string;
    task?: string;
    tokenBudget?: number;
  }): Promise<string> {
    const budget = options.tokenBudget ?? 3000;
    const lines: string[] = [];
    let usedTokens = 0;

    lines.push('[CONTEXT GRAPH — ContextGraph v0.1]');
    lines.push(`Generated: ${new Date().toISOString()}`);

    // Find anchor node from current file
    let anchorId: string | null = null;

    if (options.currentFile) {
      const relPath = options.currentFile.replace(/\\/g, '/');
      // Try exact match first
      anchorId = `file:${relPath.toLowerCase()}`;
      let node = this.db.getNode(anchorId);

      // Try basename match if exact fails
      if (!node) {
        const basename = path.basename(relPath).toLowerCase();
        const allNodes = this.db.getAllNodes();
        const match = allNodes.find(
          (n) => n.type === 'file' && n.label.toLowerCase().endsWith(basename)
        );
        if (match) {
          anchorId = match.id;
          node = match;
        }
      }

      if (node) {
        lines.push(`\nCurrent File: ${node.label}`);
        usedTokens += estimateTokens(lines.join('\n'));
      }
    }

    // Task context
    if (options.task) {
      // Search for nodes related to the task
      const taskNodes = await this.db.searchNodes(options.task, 5);
      if (taskNodes.length > 0) {
        lines.push(`\nTask: ${options.task}`);
        lines.push('Related nodes (by text search):');
        for (const n of taskNodes) {
          if (usedTokens + estimateTokens(n.label) > budget * 0.3) break;
          lines.push(`  • ${n.label} [${n.type}]`);
          usedTokens += estimateTokens(n.label);
        }
      }
    }

    // BFS from anchor node
    if (anchorId) {
      const subgraph = await this.db.bfsSubgraph(anchorId, 3, 0.1);

      // Build edge type lookup
      const edgeMap = new Map<string, string>();
      for (const edge of subgraph.edges) {
        edgeMap.set(`${edge.sourceId}→${edge.targetId}`, edge.type);
        edgeMap.set(`${edge.targetId}→${edge.sourceId}`, edge.type);
      }

      lines.push('\nKnowledge Graph Context:');
      lines.push(`Anchor: ${this.db.getNode(anchorId)?.label ?? anchorId} (w=1.00)`);

      // Sort nodes by weight descending, skip the anchor itself
      const contextNodes = (subgraph.nodes as ContextNode[])
        .filter((n) => n.id !== anchorId)
        .sort((a, b) => b._weight - a._weight);

      for (const node of contextNodes) {
        const line = formatNodeLine(node);
        const lineTokens = estimateTokens(line);

        if (usedTokens + lineTokens > budget * 0.6) break;

        lines.push(line);
        usedTokens += lineTokens;

        // Include content snippet for high-weight nodes
        if (node._weight > 0.5 && node.content) {
          const snippet = node.content.slice(0, 200).replace(/\n/g, ' ');
          const snippetLine = `${'  '.repeat(node._depth + 1)}  "${snippet}..."`;
          if (usedTokens + estimateTokens(snippetLine) < budget * 0.7) {
            lines.push(snippetLine);
            usedTokens += estimateTokens(snippetLine);
          }
        }
      }
    }

    // Hot nodes — recently accessed with high weight
    const allNodes = this.db.getAllNodes()
      .filter((n) => (n.accessCount ?? 0) > 2)
      .sort((a, b) => (b.accessCount ?? 0) - (a.accessCount ?? 0))
      .slice(0, 10);

    if (allNodes.length > 0) {
      lines.push('\nHot Nodes (recently active):');
      for (const node of allNodes) {
        if (node.id === anchorId) continue;
        const line = `  ★ ${node.label} [${node.type}] (accessed ${node.accessCount}x)`;
        if (usedTokens + estimateTokens(line) > budget * 0.9) break;
        lines.push(line);
        usedTokens += estimateTokens(line);
      }
    }

    // Graph stats footer
    const stats = this.db.getStats();
    lines.push(`\n[Graph: ${stats.nodes} nodes · ${stats.edges} active edges · last decay: ${stats.lastDecay}]`);

    return lines.join('\n');
  }
}
