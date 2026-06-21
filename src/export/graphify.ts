// src/export/graphify.ts
// Exports the graph in Graphify-compatible JSON schema
// Compatible with the graphify skill's graph.json format

import fs from 'fs/promises';
import path from 'path';
import { mkdirSync } from 'fs';
import type { GraphDB } from '../graph/kuzu.js';

interface GraphifyNode {
  id: string;
  label: string;
  type: string;
  weight: number;
  accessCount: number;
  file_type?: string;
  source_file?: string;
  metadata?: Record<string, unknown>;
}

interface GraphifyEdge {
  source: string;
  target: string;
  weight: number;
  type: string;
  relation: string;
  confidence: string;
  confidence_score: number;
  archived: boolean;
}

interface GraphifyExport {
  version: '1.0';
  generated: string;
  source: 'contextgraph';
  stats: {
    nodes: number;
    edges: number;
    archivedEdges: number;
  };
  nodes: GraphifyNode[];
  edges: GraphifyEdge[];
}

export class GraphifyExporter {
  private db: GraphDB;

  constructor(db: GraphDB) {
    this.db = db;
  }

  async export(outDir?: string): Promise<string> {
    const nodes = this.db.getAllNodes();
    const edges = this.db.getAllEdges(true); // include archived

    // Compute per-node weight as average outgoing edge weight
    const nodeOutWeights = new Map<string, number[]>();
    for (const edge of edges.filter((e) => !e.archived)) {
      if (!nodeOutWeights.has(edge.sourceId)) nodeOutWeights.set(edge.sourceId, []);
      nodeOutWeights.get(edge.sourceId)!.push(edge.weight ?? 0);
    }

    const graphifyNodes: GraphifyNode[] = nodes.map((node) => {
      const weights = nodeOutWeights.get(node.id) ?? [];
      const avgWeight = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) / weights.length : 0.5;
      return {
        id: node.id,
        label: node.label,
        type: node.type,
        weight: parseFloat(avgWeight.toFixed(3)),
        accessCount: node.accessCount ?? 0,
        file_type: node.language,
        source_file: node.filePath,
        metadata: node.metadata,
      };
    });

    const graphifyEdges: GraphifyEdge[] = edges.map((edge) => ({
      source: edge.sourceId,
      target: edge.targetId,
      weight: parseFloat((edge.weight ?? 0).toFixed(3)),
      type: edge.type,
      relation: edge.type,
      confidence: 'EXTRACTED',
      confidence_score: edge.weight ?? 0,
      archived: edge.archived,
    }));

    const activeEdges = edges.filter((e) => !e.archived);
    const archivedEdges = edges.filter((e) => e.archived);

    const exportData: GraphifyExport = {
      version: '1.0',
      generated: new Date().toISOString(),
      source: 'contextgraph',
      stats: {
        nodes: nodes.length,
        edges: activeEdges.length,
        archivedEdges: archivedEdges.length,
      },
      nodes: graphifyNodes,
      edges: graphifyEdges,
    };

    const outputPath = outDir
      ? path.join(outDir, 'graph.json')
      : path.join(process.cwd(), 'graphify-out', 'graph.json');

    mkdirSync(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(exportData, null, 2), 'utf-8');
    return outputPath;
  }

  /** Export as raw JSON (all nodes + edges) */
  async exportRaw(outDir?: string): Promise<string> {
    const nodes = this.db.getAllNodes();
    const edges = this.db.getAllEdges(false);
    const stats = this.db.getStats();

    const outputPath = outDir
      ? path.join(outDir, 'contextgraph-export.json')
      : path.join(process.cwd(), 'contextgraph-export.json');

    mkdirSync(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(
      outputPath,
      JSON.stringify({ nodes, edges, stats, generated: new Date().toISOString() }, null, 2),
      'utf-8'
    );
    return outputPath;
  }
}
