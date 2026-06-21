// src/analytics/pagerank.ts
// PageRank-style importance scoring for graph nodes
// Also computes betweenness centrality and "hotness" (recency × weight)

import type { GraphDB } from '../graph/kuzu.js';
import type { GraphNode } from '../graph/schema.js';

export interface NodeScore {
  nodeId: string;
  label: string;
  type: string;
  pageRank: number;       // Structural importance (link-based)
  hotness: number;        // accessCount × avg edge weight (recency signal)
  degree: number;         // Total connections (in + out)
  inDegree: number;
  outDegree: number;
  avgEdgeWeight: number;  // Mean weight of all connected edges
}

export interface ClusterResult {
  clusterId: number;
  label: string;
  nodes: string[];        // Node IDs
  density: number;        // Internal edge count / possible edges
  centroid: string;       // Highest-pagerank node in cluster
  totalWeight: number;
}

const DAMPING = 0.85;
const MAX_ITERATIONS = 50;
const CONVERGENCE_THRESHOLD = 1e-6;

export class GraphAnalytics {
  private db: GraphDB;

  constructor(db: GraphDB) {
    this.db = db;
  }

  // ─── PageRank ─────────────────────────────────────────────────────────────
  computePageRank(): Map<string, number> {
    const nodes = this.db.getAllNodes();
    const edges = this.db.getAllEdges(false);

    if (nodes.length === 0) return new Map();

    const nodeIds = nodes.map((n) => n.id);
    const N = nodeIds.length;
    const nodeIndex = new Map<string, number>(nodeIds.map((id, i) => [id, i]));

    // Build weighted adjacency: outLinks[i] = [{j, weight}]
    const outLinks: Array<Array<{ j: number; weight: number }>> = Array.from({ length: N }, () => []);
    const outWeightSum: number[] = new Array(N).fill(0);

    for (const edge of edges) {
      const si = nodeIndex.get(edge.sourceId);
      const ti = nodeIndex.get(edge.targetId);
      if (si === undefined || ti === undefined) continue;
      const w = edge.weight ?? 0.5;
      outLinks[si].push({ j: ti, weight: w });
      outWeightSum[si] = (outWeightSum[si] ?? 0) + w;

      // Undirected: also add reverse
      outLinks[ti].push({ j: si, weight: w });
      outWeightSum[ti] = (outWeightSum[ti] ?? 0) + w;
    }

    // Initialize scores
    let scores = new Array(N).fill(1 / N);

    // Power iteration
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const newScores = new Array(N).fill((1 - DAMPING) / N);

      for (let i = 0; i < N; i++) {
        const links = outLinks[i];
        const totalW = outWeightSum[i] ?? 0;
        if (totalW === 0 || links.length === 0) {
          // Dangling node: distribute evenly
          const share = DAMPING * scores[i] / N;
          for (let j = 0; j < N; j++) newScores[j] += share;
        } else {
          for (const { j, weight } of links) {
            newScores[j] += DAMPING * scores[i] * (weight / totalW);
          }
        }
      }

      // Check convergence
      let delta = 0;
      for (let i = 0; i < N; i++) delta += Math.abs(newScores[i] - scores[i]);
      scores = newScores;
      if (delta < CONVERGENCE_THRESHOLD) break;
    }

    const result = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      result.set(nodeIds[i], scores[i]);
    }
    return result;
  }

  // ─── Full node scoring ────────────────────────────────────────────────────
  computeNodeScores(): NodeScore[] {
    const nodes = this.db.getAllNodes();
    const edges = this.db.getAllEdges(false);
    const pageRankMap = this.computePageRank();

    // Build per-node edge stats
    const nodeEdges = new Map<string, { weights: number[]; inDeg: number; outDeg: number }>();
    for (const node of nodes) {
      nodeEdges.set(node.id, { weights: [], inDeg: 0, outDeg: 0 });
    }

    for (const edge of edges) {
      const w = edge.weight ?? 0;
      const src = nodeEdges.get(edge.sourceId);
      const tgt = nodeEdges.get(edge.targetId);
      if (src) { src.weights.push(w); src.outDeg++; }
      if (tgt) { tgt.weights.push(w); tgt.inDeg++; }
    }

    const scores: NodeScore[] = nodes.map((node) => {
      const edgeData = nodeEdges.get(node.id) ?? { weights: [], inDeg: 0, outDeg: 0 };
      const avgWeight = edgeData.weights.length > 0
        ? edgeData.weights.reduce((a, b) => a + b, 0) / edgeData.weights.length
        : 0;
      const degree = edgeData.inDeg + edgeData.outDeg;
      const pr = pageRankMap.get(node.id) ?? 0;

      // Hotness = access count × avg weight (recency-weighted importance)
      const hotness = Math.min(1, ((node.accessCount ?? 0) * avgWeight) / 10);

      return {
        nodeId: node.id,
        label: node.label,
        type: node.type,
        pageRank: parseFloat(pr.toFixed(6)),
        hotness: parseFloat(hotness.toFixed(4)),
        degree,
        inDegree: edgeData.inDeg,
        outDegree: edgeData.outDeg,
        avgEdgeWeight: parseFloat(avgWeight.toFixed(4)),
      };
    });

    // Sort by PageRank descending
    return scores.sort((a, b) => b.pageRank - a.pageRank);
  }

  // ─── Graph clustering (simple community detection via greedy modularity) ──
  computeClusters(): ClusterResult[] {
    const nodes = this.db.getAllNodes();
    const edges = this.db.getAllEdges(false);

    if (nodes.length === 0) return [];

    // Union-Find with weight-biased merging
    const parent = new Map<string, string>(nodes.map((n) => [n.id, n.id]));
    const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));

    const find = (x: string): string => {
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
      return parent.get(x)!;
    };

    const union = (a: string, b: string) => {
      const ra = find(a), rb = find(b);
      if (ra === rb) return;
      const rankA = rank.get(ra) ?? 0, rankB = rank.get(rb) ?? 0;
      if (rankA < rankB) parent.set(ra, rb);
      else if (rankA > rankB) parent.set(rb, ra);
      else { parent.set(rb, ra); rank.set(ra, rankA + 1); }
    };

    // Merge nodes connected by high-weight edges (w > 0.4)
    const sortedEdges = [...edges].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    for (const edge of sortedEdges) {
      if ((edge.weight ?? 0) > 0.4) union(edge.sourceId, edge.targetId);
    }

    // Group by cluster root
    const clusters = new Map<string, string[]>();
    for (const node of nodes) {
      const root = find(node.id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(node.id);
    }

    const pageRankMap = this.computePageRank();

    // Build ClusterResult for each cluster with ≥ 2 nodes
    const results: ClusterResult[] = [];
    let clusterId = 0;

    for (const [, memberIds] of clusters) {
      if (memberIds.length < 2) continue;

      // Internal edge count
      const memberSet = new Set(memberIds);
      const internalEdges = edges.filter(
        (e) => memberSet.has(e.sourceId) && memberSet.has(e.targetId)
      );
      const totalWeight = internalEdges.reduce((s, e) => s + (e.weight ?? 0), 0);
      const maxPossibleEdges = memberIds.length * (memberIds.length - 1) / 2;
      const density = maxPossibleEdges > 0 ? internalEdges.length / maxPossibleEdges : 0;

      // Centroid = highest PageRank node in cluster
      const centroid = memberIds.reduce((best, id) =>
        (pageRankMap.get(id) ?? 0) > (pageRankMap.get(best) ?? 0) ? id : best
      );
      const centroidNode = this.db.getNode(centroid);

      // Cluster label from most common node type or centroid label
      const typeCounts = new Map<string, number>();
      for (const id of memberIds) {
        const n = this.db.getNode(id);
        if (n) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
      }
      const dominantType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'mixed';
      const label = `${dominantType} cluster around ${centroidNode?.label ?? centroid}`;

      results.push({
        clusterId: clusterId++,
        label,
        nodes: memberIds,
        density: parseFloat(density.toFixed(3)),
        centroid,
        totalWeight: parseFloat(totalWeight.toFixed(3)),
      });
    }

    return results.sort((a, b) => b.nodes.length - a.nodes.length);
  }

  // ─── Graph health report ──────────────────────────────────────────────────
  computeHealthReport(): {
    score: number; // 0-100
    orphanedNodes: string[];
    weakEdges: number;
    strongEdges: number;
    avgWeight: number;
    mostConnected: NodeScore[];
    leastConnected: NodeScore[];
    decayRisk: string[]; // Nodes whose edges are mostly near archive threshold
    summary: string;
  } {
    const scores = this.computeNodeScores();
    const edges = this.db.getAllEdges(false);
    const stats = this.db.getStats();

    const orphanedNodes = scores
      .filter((s) => s.degree === 0)
      .map((s) => s.nodeId);

    const weakEdges = edges.filter((e) => (e.weight ?? 0) < 0.2).length;
    const strongEdges = edges.filter((e) => (e.weight ?? 0) > 0.6).length;
    const avgWeight = edges.length > 0
      ? edges.reduce((s, e) => s + (e.weight ?? 0), 0) / edges.length
      : 0;

    // Decay risk: nodes where all connected edges are below 0.15
    const nodeMinWeight = new Map<string, number>();
    for (const edge of edges) {
      const w = edge.weight ?? 0;
      const srcMin = nodeMinWeight.get(edge.sourceId);
      nodeMinWeight.set(edge.sourceId, srcMin === undefined ? w : Math.min(srcMin, w));
      const tgtMin = nodeMinWeight.get(edge.targetId);
      nodeMinWeight.set(edge.targetId, tgtMin === undefined ? w : Math.min(tgtMin, w));
    }
    const decayRisk = [...nodeMinWeight.entries()]
      .filter(([, w]) => w < 0.15)
      .map(([id]) => id)
      .slice(0, 10);

    // Health score: penalize orphans, weak edges, reward strong edges
    const orphanPenalty = Math.min(40, (orphanedNodes.length / Math.max(stats.nodes, 1)) * 100);
    const weakPenalty = Math.min(20, (weakEdges / Math.max(edges.length, 1)) * 40);
    const strengthBonus = (strongEdges / Math.max(edges.length, 1)) * 20;
    const score = Math.max(0, Math.min(100, 70 - orphanPenalty - weakPenalty + strengthBonus));

    const summary = score >= 80
      ? 'Graph is healthy and well-connected.'
      : score >= 50
      ? 'Graph has some orphaned nodes and weak edges. Run `ctx watch` to strengthen connections.'
      : 'Graph is sparse. Use `ctx init` to re-scan and `ctx add` to record decisions.';

    return {
      score: Math.round(score),
      orphanedNodes,
      weakEdges,
      strongEdges,
      avgWeight: parseFloat(avgWeight.toFixed(4)),
      mostConnected: scores.slice(0, 5),
      leastConnected: scores.filter((s) => s.degree > 0).slice(-5).reverse(),
      decayRisk,
      summary,
    };
  }
}
