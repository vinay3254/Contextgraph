// src/graph/pathfinder.ts
// Find paths between nodes in the knowledge graph
// - Strongest path: maximize product of edge weights (highest confidence route)
// - Shortest path: minimize hop count (BFS)
// - Explain path: human-readable narration of each hop

import type { GraphDB } from './kuzu.js';
import type { GraphNode, GraphEdge } from './schema.js';

export interface PathHop {
  nodeId: string;
  label: string;
  type: string;
  edgeType?: string;
  edgeWeight?: number;
}

export interface PathResult {
  found: boolean;
  source: string;
  target: string;
  hops: PathHop[];
  totalWeight: number;   // Product of edge weights (strength of path)
  hopCount: number;
  explanation: string;
}

export class Pathfinder {
  private db: GraphDB;

  constructor(db: GraphDB) {
    this.db = db;
  }

  // ─── Strongest path (Dijkstra maximizing weight product) ─────────────────
  async strongestPath(sourceId: string, targetId: string, maxDepth = 6): Promise<PathResult> {
    const notFound = this.notFoundResult(sourceId, targetId);
    if (sourceId === targetId) {
      const node = this.db.getNode(sourceId);
      return {
        found: true, source: sourceId, target: targetId,
        hops: node ? [{ nodeId: node.id, label: node.label, type: node.type }] : [],
        totalWeight: 1.0, hopCount: 0,
        explanation: 'Source and target are the same node.',
      };
    }

    const edges = this.db.getAllEdges(false);

    // Build adjacency list: nodeId → [{neighborId, edgeType, weight}]
    const adj = new Map<string, Array<{ neighborId: string; edgeType: string; weight: number }>>();
    for (const edge of edges) {
      if (!adj.has(edge.sourceId)) adj.set(edge.sourceId, []);
      if (!adj.has(edge.targetId)) adj.set(edge.targetId, []);
      const w = edge.weight ?? 0;
      adj.get(edge.sourceId)!.push({ neighborId: edge.targetId, edgeType: edge.type, weight: w });
      adj.get(edge.targetId)!.push({ neighborId: edge.sourceId, edgeType: edge.type, weight: w });
    }

    // Dijkstra with max weight product (use log to turn product into sum)
    const logWeight = new Map<string, number>([[sourceId, 0]]);
    const prev = new Map<string, { from: string; edgeType: string; weight: number }>();
    const visited = new Set<string>();

    // Priority queue (simple sort — fine for graph sizes we handle)
    const queue: Array<{ nodeId: string; logW: number; depth: number }> = [
      { nodeId: sourceId, logW: 0, depth: 0 },
    ];

    while (queue.length > 0) {
      queue.sort((a, b) => b.logW - a.logW); // Max-heap by logW
      const current = queue.shift()!;
      const { nodeId, logW, depth } = current;

      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      if (nodeId === targetId) break;
      if (depth >= maxDepth) continue;

      for (const { neighborId, edgeType, weight } of adj.get(nodeId) ?? []) {
        if (visited.has(neighborId)) continue;
        const newLogW = logW + Math.log(Math.max(weight, 0.001));
        const existingLogW = logWeight.get(neighborId) ?? -Infinity;
        if (newLogW > existingLogW) {
          logWeight.set(neighborId, newLogW);
          prev.set(neighborId, { from: nodeId, edgeType, weight });
          queue.push({ nodeId: neighborId, logW: newLogW, depth: depth + 1 });
        }
      }
    }

    if (!prev.has(targetId) && sourceId !== targetId) return notFound;

    // Reconstruct path
    const path: Array<{ nodeId: string; edgeType?: string; edgeWeight?: number }> = [];
    let current = targetId;
    while (current !== sourceId) {
      const prevData = prev.get(current);
      if (!prevData) return notFound;
      path.unshift({ nodeId: current, edgeType: prevData.edgeType, edgeWeight: prevData.weight });
      current = prevData.from;
    }
    path.unshift({ nodeId: sourceId });

    const hops: PathHop[] = path.map(({ nodeId, edgeType, edgeWeight }) => {
      const node = this.db.getNode(nodeId);
      return {
        nodeId,
        label: node?.label ?? nodeId,
        type: node?.type ?? 'unknown',
        edgeType,
        edgeWeight,
      };
    });

    const totalWeight = Math.exp(logWeight.get(targetId) ?? 0);
    const explanation = this.buildExplanation(hops);

    return {
      found: true,
      source: sourceId,
      target: targetId,
      hops,
      totalWeight: parseFloat(totalWeight.toFixed(4)),
      hopCount: hops.length - 1,
      explanation,
    };
  }

  // ─── Shortest path (BFS, ignoring weights) ───────────────────────────────
  async shortestPath(sourceId: string, targetId: string, maxDepth = 8): Promise<PathResult> {
    const notFound = this.notFoundResult(sourceId, targetId);
    if (sourceId === targetId) {
      const node = this.db.getNode(sourceId);
      return {
        found: true, source: sourceId, target: targetId,
        hops: node ? [{ nodeId: node.id, label: node.label, type: node.type }] : [],
        totalWeight: 1.0, hopCount: 0,
        explanation: 'Source and target are the same node.',
      };
    }

    const edges = this.db.getAllEdges(false);
    const adj = new Map<string, Array<{ neighborId: string; edgeType: string; weight: number }>>();
    for (const edge of edges) {
      if (!adj.has(edge.sourceId)) adj.set(edge.sourceId, []);
      if (!adj.has(edge.targetId)) adj.set(edge.targetId, []);
      const w = edge.weight ?? 0;
      adj.get(edge.sourceId)!.push({ neighborId: edge.targetId, edgeType: edge.type, weight: w });
      adj.get(edge.targetId)!.push({ neighborId: edge.sourceId, edgeType: edge.type, weight: w });
    }

    const visited = new Set<string>([sourceId]);
    const prev = new Map<string, { from: string; edgeType: string; weight: number }>();
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: sourceId, depth: 0 }];

    while (queue.length > 0) {
      const { nodeId, depth } = queue.shift()!;
      if (nodeId === targetId) break;
      if (depth >= maxDepth) continue;

      for (const { neighborId, edgeType, weight } of adj.get(nodeId) ?? []) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          prev.set(neighborId, { from: nodeId, edgeType, weight });
          queue.push({ nodeId: neighborId, depth: depth + 1 });
        }
      }
    }

    if (!prev.has(targetId)) return notFound;

    const path: Array<{ nodeId: string; edgeType?: string; edgeWeight?: number }> = [];
    let current = targetId;
    while (current !== sourceId) {
      const prevData = prev.get(current);
      if (!prevData) return notFound;
      path.unshift({ nodeId: current, edgeType: prevData.edgeType, edgeWeight: prevData.weight });
      current = prevData.from;
    }
    path.unshift({ nodeId: sourceId });

    const hops: PathHop[] = path.map(({ nodeId, edgeType, edgeWeight }) => {
      const node = this.db.getNode(nodeId);
      return { nodeId, label: node?.label ?? nodeId, type: node?.type ?? 'unknown', edgeType, edgeWeight };
    });

    const totalWeight = hops.reduce((prod, h) => prod * (h.edgeWeight ?? 1), 1);
    return {
      found: true, source: sourceId, target: targetId,
      hops, totalWeight: parseFloat(totalWeight.toFixed(4)),
      hopCount: hops.length - 1,
      explanation: this.buildExplanation(hops),
    };
  }

  // ─── Build human-readable explanation ────────────────────────────────────
  private buildExplanation(hops: PathHop[]): string {
    if (hops.length === 0) return 'No path found.';
    if (hops.length === 1) return `Single node: ${hops[0].label}`;

    const parts = hops.map((hop, i) => {
      if (i === 0) return `**${hop.label}** [${hop.type}]`;
      const arrow = hop.edgeType ? ` —[${hop.edgeType} w=${hop.edgeWeight?.toFixed(2)}]→ ` : ' → ';
      return `${arrow}**${hop.label}** [${hop.type}]`;
    });

    return parts.join('');
  }

  private notFoundResult(sourceId: string, targetId: string): PathResult {
    return {
      found: false,
      source: sourceId,
      target: targetId,
      hops: [],
      totalWeight: 0,
      hopCount: -1,
      explanation: `No path found between "${sourceId}" and "${targetId}" within search depth.`,
    };
  }
}
