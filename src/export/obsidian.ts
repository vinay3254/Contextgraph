// src/export/obsidian.ts
// Exports the graph as an Obsidian vault — one .md file per node, [[wikilinks]] for edges

import fs from 'fs/promises';
import path from 'path';
import { mkdirSync } from 'fs';
import type { GraphDB } from '../graph/kuzu.js';

function sanitizeFilename(label: string): string {
  return label.replace(/[/\\:*?"<>|]/g, '_').slice(0, 100);
}

function nodeIdToFilename(id: string): string {
  return sanitizeFilename(id.replace(/[:/]/g, '_'));
}

export class ObsidianExporter {
  private db: GraphDB;

  constructor(db: GraphDB) {
    this.db = db;
  }

  async export(outDir: string): Promise<number> {
    mkdirSync(outDir, { recursive: true });

    const nodes = this.db.getAllNodes();
    const edges = this.db.getAllEdges();

    // Build adjacency: nodeId → list of {targetId, edgeType, weight}
    const adjOut = new Map<string, Array<{ targetId: string; type: string; weight: number }>>();
    const adjIn = new Map<string, Array<{ sourceId: string; type: string; weight: number }>>();

    for (const edge of edges) {
      if (!adjOut.has(edge.sourceId)) adjOut.set(edge.sourceId, []);
      if (!adjIn.has(edge.targetId)) adjIn.set(edge.targetId, []);
      adjOut.get(edge.sourceId)!.push({ targetId: edge.targetId, type: edge.type, weight: edge.weight ?? 0 });
      adjIn.get(edge.targetId)!.push({ sourceId: edge.sourceId, type: edge.type, weight: edge.weight ?? 0 });
    }

    // Write one .md file per node
    for (const node of nodes) {
      const filename = nodeIdToFilename(node.id);
      const outEdges = adjOut.get(node.id) ?? [];
      const inEdges = adjIn.get(node.id) ?? [];

      // YAML frontmatter
      const frontmatter = [
        '---',
        `id: "${node.id}"`,
        `type: ${node.type}`,
        `label: "${node.label}"`,
        `weight: ${(outEdges.reduce((s, e) => s + e.weight, 0) / Math.max(outEdges.length, 1)).toFixed(3)}`,
        `access_count: ${node.accessCount ?? 0}`,
        node.filePath ? `file_path: "${node.filePath}"` : null,
        node.language ? `language: ${node.language}` : null,
        node.createdAt ? `created_at: ${node.createdAt}` : null,
        node.lastSeenAt ? `last_seen: ${node.lastSeenAt}` : null,
        '---',
      ].filter(Boolean).join('\n');

      // Body
      const body: string[] = [
        `# ${node.label}`,
        '',
        `**Type:** \`${node.type}\`  `,
        node.filePath ? `**File:** \`${node.filePath}\`` : '',
        '',
      ];

      if (node.content) {
        body.push('## Content', '', '```', node.content.slice(0, 1000), '```', '');
      }

      if (outEdges.length > 0) {
        body.push('## References →', '');
        const sortedOut = [...outEdges].sort((a, b) => b.weight - a.weight);
        for (const e of sortedOut) {
          const targetNode = this.db.getNode(e.targetId);
          const targetLabel = targetNode?.label ?? e.targetId;
          const targetFile = nodeIdToFilename(e.targetId);
          body.push(`- [[${targetFile}|${targetLabel}]] *(${e.type}, w=${e.weight.toFixed(2)})*`);
        }
        body.push('');
      }

      if (inEdges.length > 0) {
        body.push('## Referenced By ←', '');
        const sortedIn = [...inEdges].sort((a, b) => b.weight - a.weight);
        for (const e of sortedIn) {
          const sourceNode = this.db.getNode(e.sourceId);
          const sourceLabel = sourceNode?.label ?? e.sourceId;
          const sourceFile = nodeIdToFilename(e.sourceId);
          body.push(`- [[${sourceFile}|${sourceLabel}]] *(${e.type}, w=${e.weight.toFixed(2)})*`);
        }
        body.push('');
      }

      if (node.metadata) {
        body.push('## Metadata', '', '```json', JSON.stringify(node.metadata, null, 2), '```', '');
      }

      const content = [frontmatter, '', body.join('\n')].join('\n');
      await fs.writeFile(path.join(outDir, `${filename}.md`), content, 'utf-8');
    }

    // Write index
    const indexLines = [
      '# ContextGraph — Obsidian Vault Index',
      '',
      `> Generated: ${new Date().toISOString()}`,
      `> Nodes: ${nodes.length} | Active Edges: ${edges.length}`,
      '',
      '## Nodes by Type',
      '',
    ];

    const byType = new Map<string, typeof nodes>();
    for (const node of nodes) {
      if (!byType.has(node.type)) byType.set(node.type, []);
      byType.get(node.type)!.push(node);
    }

    for (const [type, typeNodes] of byType) {
      indexLines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)} (${typeNodes.length})`);
      for (const n of typeNodes.slice(0, 50)) {
        const filename = nodeIdToFilename(n.id);
        indexLines.push(`- [[${filename}|${n.label}]]`);
      }
      indexLines.push('');
    }

    await fs.writeFile(path.join(outDir, '_INDEX.md'), indexLines.join('\n'), 'utf-8');
    return nodes.length;
  }
}
