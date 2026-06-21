// src/graph/kuzu.ts
// Embedded graph database client using JSON-file store (KuzuDB-compatible interface)
// Falls back to JSON persistence for Windows compatibility

import fs from 'fs/promises';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { GraphNode, GraphEdge, SubgraphResult } from './schema.js';
import {
  WEIGHT_INITIAL,
  WEIGHT_MAX,
  WEIGHT_STRENGTHEN_OCCURRENCE,
  WEIGHT_STRENGTHEN_COMMIT,
  WEIGHT_DECAY_FACTOR,
  WEIGHT_ARCHIVE_THRESHOLD,
} from './schema.js';

interface GraphStore {
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  version: number;
  lastDecay: string;
}

export class GraphDB {
  private store: GraphStore = {
    nodes: {},
    edges: [],
    version: 1,
    lastDecay: new Date().toISOString(),
  };
  private dbPath: string;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'graph.json');
  }

  async init(): Promise<void> {
    try {
      if (existsSync(this.dbPath)) {
        const raw = await fs.readFile(this.dbPath, 'utf-8');
        this.store = JSON.parse(raw) as GraphStore;
        console.error(`[ContextGraph] Loaded graph: ${Object.keys(this.store.nodes).length} nodes, ${this.store.edges.length} edges`);
      } else {
        console.error('[ContextGraph] Initialized new graph store');
        await this.persist();
      }
    } catch (err) {
      console.error('[ContextGraph] Failed to load graph store, starting fresh:', err);
      this.store = { nodes: {}, edges: [], version: 1, lastDecay: new Date().toISOString() };
    }
  }

  // ─── Upsert Node ──────────────────────────────────────────────────────
  async upsertNode(node: GraphNode): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.store.nodes[node.id];
    if (existing) {
      // Merge — preserve access count, update content + metadata
      this.store.nodes[node.id] = {
        ...existing,
        ...node,
        accessCount: (existing.accessCount ?? 0) + 1,
        lastSeenAt: now,
        createdAt: existing.createdAt ?? now,
      };
    } else {
      this.store.nodes[node.id] = {
        ...node,
        accessCount: 1,
        createdAt: now,
        lastSeenAt: now,
      };
    }
    this.scheduleSave();
  }

  // ─── Upsert Edge ──────────────────────────────────────────────────────
  async upsertEdge(edge: GraphEdge, strengthenDelta = WEIGHT_STRENGTHEN_OCCURRENCE): Promise<void> {
    const now = new Date().toISOString();
    const idx = this.store.edges.findIndex(
      (e) => e.sourceId === edge.sourceId && e.targetId === edge.targetId && e.type === edge.type
    );
    if (idx >= 0) {
      const existing = this.store.edges[idx];
      const newWeight = Math.min(WEIGHT_MAX, (existing.weight ?? WEIGHT_INITIAL) + strengthenDelta);
      this.store.edges[idx] = {
        ...existing,
        weight: newWeight,
        accessCount: (existing.accessCount ?? 1) + 1,
        lastStrengthened: now,
        archived: false,
      };
    } else {
      this.store.edges.push({
        ...edge,
        weight: edge.weight ?? WEIGHT_INITIAL,
        accessCount: 1,
        lastStrengthened: now,
        archived: false,
      });
    }
    this.scheduleSave();
  }

  // ─── Strengthen edge on co-commit ─────────────────────────────────────
  async strengthenCoCommit(sourceId: string, targetId: string): Promise<void> {
    await this.upsertEdge(
      { sourceId, targetId, type: 'co_edited', weight: WEIGHT_INITIAL, accessCount: 1, archived: false },
      WEIGHT_STRENGTHEN_COMMIT
    );
  }

  // ─── BFS Subgraph ──────────────────────────────────────────────────────
  async bfsSubgraph(nodeId: string, depth = 2, minWeight = 0.05): Promise<SubgraphResult> {
    const visited = new Set<string>();
    const resultNodes: (GraphNode & { _weight?: number; _depth?: number })[] = [];
    const resultEdges: GraphEdge[] = [];

    // BFS queue: [nodeId, currentDepth, incomingWeight]
    const queue: Array<[string, number, number]> = [[nodeId, 0, 1.0]];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const [currentId, currentDepth, incomingWeight] = item;

      if (visited.has(currentId) || currentDepth > depth) continue;
      visited.add(currentId);

      const node = this.store.nodes[currentId];
      if (node) {
        resultNodes.push({ ...node, _weight: incomingWeight, _depth: currentDepth });
      }

      if (currentDepth < depth) {
        // Get all edges from this node, sorted by weight descending
        const outEdges = this.store.edges.filter(
          (e) => !e.archived && (e.sourceId === currentId || e.targetId === currentId) && (e.weight ?? 0) >= minWeight
        );
        // Sort by weight descending — highest signal first
        outEdges.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

        for (const edge of outEdges) {
          const neighborId = edge.sourceId === currentId ? edge.targetId : edge.sourceId;
          if (!visited.has(neighborId)) {
            const combinedWeight = incomingWeight * (edge.weight ?? 0);
            if (combinedWeight >= minWeight) {
              queue.push([neighborId, currentDepth + 1, combinedWeight]);
              resultEdges.push(edge);
            }
          }
        }
      }
    }

    return { nodes: resultNodes, edges: resultEdges };
  }

  // ─── Semantic search (simple text match, embeddings via extractor) ─────
  async searchNodes(query: string, limit = 10, nodeTypes?: string[]): Promise<GraphNode[]> {
    const q = query.toLowerCase();
    return Object.values(this.store.nodes)
      .filter((n) => {
        if (nodeTypes && nodeTypes.length > 0 && !nodeTypes.includes(n.type)) return false;
        return (
          n.label.toLowerCase().includes(q) ||
          (n.content?.toLowerCase().includes(q) ?? false) ||
          n.id.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        // Rank by label match first, then access count
        const aLabelMatch = a.label.toLowerCase().includes(q) ? 1 : 0;
        const bLabelMatch = b.label.toLowerCase().includes(q) ? 1 : 0;
        if (bLabelMatch !== aLabelMatch) return bLabelMatch - aLabelMatch;
        return (b.accessCount ?? 0) - (a.accessCount ?? 0);
      })
      .slice(0, limit);
  }

  // ─── Weight Decay ──────────────────────────────────────────────────────
  async decayAllEdges(): Promise<{ decayed: number; archived: number }> {
    const now = new Date().toISOString();
    let decayed = 0;
    let archived = 0;

    for (let i = 0; i < this.store.edges.length; i++) {
      const edge = this.store.edges[i];
      if (edge.archived) continue;

      const newWeight = (edge.weight ?? WEIGHT_INITIAL) * WEIGHT_DECAY_FACTOR;
      this.store.edges[i] = { ...edge, weight: newWeight, lastDecayed: now };
      decayed++;

      if (newWeight < WEIGHT_ARCHIVE_THRESHOLD) {
        this.store.edges[i].archived = true;
        archived++;
      }
    }

    this.store.lastDecay = now;
    await this.persist();
    return { decayed, archived };
  }

  // ─── Get all nodes + edges ─────────────────────────────────────────────
  getAllNodes(): GraphNode[] {
    return Object.values(this.store.nodes);
  }

  getAllEdges(includeArchived = false): GraphEdge[] {
    if (includeArchived) return this.store.edges;
    return this.store.edges.filter((e) => !e.archived);
  }

  getNode(nodeId: string): GraphNode | undefined {
    return this.store.nodes[nodeId];
  }

  getStats(): { nodes: number; edges: number; archived: number; lastDecay: string } {
    const active = this.store.edges.filter((e) => !e.archived).length;
    const archived = this.store.edges.filter((e) => e.archived).length;
    return {
      nodes: Object.keys(this.store.nodes).length,
      edges: active,
      archived,
      lastDecay: this.store.lastDecay,
    };
  }

  // ─── Persistence ───────────────────────────────────────────────────────
  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      if (this.dirty) await this.persist();
    }, 500);
  }

  async persist(): Promise<void> {
    this.dirty = false;
    await fs.writeFile(this.dbPath, JSON.stringify(this.store, null, 2), 'utf-8');
  }

  getDbPath(): string {
    return this.dbPath;
  }
}
