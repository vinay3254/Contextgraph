// src/agent/tools.ts
// ContextGraph tool definitions (JSON Schema) + in-process executors
// The agent calls these directly against GraphDB — no HTTP round-trip

import path from 'path';
import { mkdirSync } from 'fs';
import type { GraphDB } from '../graph/kuzu.js';
import { GraphAnalytics } from '../analytics/pagerank.js';
import { Pathfinder } from '../graph/pathfinder.js';
import { ContextBuilder } from '../inject/builder.js';
import { DecayScheduler } from '../graph/decay.js';
import { NLPExtractor } from '../nlp/extractor.js';

// ─── Tool definition (JSON Schema, compatible with Claude + Ollama) ───────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const CONTEXTGRAPH_TOOLS: ToolDefinition[] = [
  {
    name: 'graph_search',
    description:
      'Search the project knowledge graph by keyword. Returns matching nodes (files, symbols, decisions, concepts, bugs, patterns) ranked by relevance. Always call this first to find relevant context before answering a codebase question.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        limit: { type: 'number', description: 'Max results (default 8)', default: 8 },
        nodeTypes: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['file', 'symbol', 'decision', 'bug', 'concept', 'session', 'pattern', 'tool'],
          },
          description: 'Filter by node type (optional)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_inject',
    description:
      'Build a ranked context window from the current file or task. Does weighted BFS from the anchor node, returning the highest-signal nodes in a compact format. Use this when you want deep context about a specific file or current task.',
    input_schema: {
      type: 'object',
      properties: {
        currentFile: { type: 'string', description: 'Relative file path (e.g. src/graph/pathfinder.ts)' },
        task: { type: 'string', description: 'Task description to find related nodes' },
        tokenBudget: { type: 'number', description: 'Approximate token budget (default 2000)', default: 2000 },
      },
    },
  },
  {
    name: 'graph_read',
    description:
      'Read a BFS subgraph from a specific node ID. Returns all reachable nodes and edges up to a given depth. Use when you know the exact node ID and want to explore its neighborhood.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID to start BFS from (e.g. file:src/graph/pathfinder.ts)' },
        depth: { type: 'number', description: 'BFS depth 1-4 (default 2)', default: 2 },
        minWeight: { type: 'number', description: 'Min edge weight to follow (default 0.1)', default: 0.1 },
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'graph_write',
    description:
      'Record a new node (decision, bug, concept, pattern) and its relationships into the knowledge graph. Use this when the user mentions a decision, discovers a bug, or establishes a concept worth remembering.',
    input_schema: {
      type: 'object',
      properties: {
        node: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique node ID — lowercase, e.g. decision:use_jwt' },
            type: {
              type: 'string',
              enum: ['file', 'symbol', 'decision', 'bug', 'concept', 'session', 'pattern', 'tool'],
            },
            label: { type: 'string', description: 'Human-readable label' },
            content: { type: 'string', description: 'Optional longer description' },
          },
          required: ['id', 'type', 'label'],
        },
        edges: {
          type: 'array',
          description: 'Edges from this node (optional)',
          items: {
            type: 'object',
            properties: {
              targetId: { type: 'string' },
              type: {
                type: 'string',
                enum: [
                  'imports', 'references', 'caused_by', 'decided_in',
                  'similar_to', 'co_edited', 'defines', 'mentions', 'tagged_with',
                ],
              },
              weight: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['targetId', 'type'],
          },
        },
      },
      required: ['node'],
    },
  },
  {
    name: 'graph_stats',
    description: 'Get current knowledge graph statistics: node count, edge count, breakdown by node type, last decay time. Call when the user asks about the project graph.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'graph_rank',
    description: 'Get the most important nodes ranked by PageRank, hotness (recency × weight), or degree centrality. Useful for understanding which files/concepts are most central to the project.',
    input_schema: {
      type: 'object',
      properties: {
        sortBy: {
          type: 'string',
          enum: ['pageRank', 'hotness', 'degree'],
          description: 'Ranking metric (default: pageRank)',
          default: 'pageRank',
        },
        limit: { type: 'number', description: 'Number of results (default 10)', default: 10 },
      },
    },
  },
  {
    name: 'graph_hotpath',
    description: 'Find the strongest or shortest path between two nodes in the knowledge graph. Useful for understanding how two files, symbols, or concepts are related.',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Source node ID' },
        targetId: { type: 'string', description: 'Target node ID' },
        method: {
          type: 'string',
          enum: ['strongest', 'shortest'],
          description: 'strongest = highest confidence path, shortest = fewest hops',
          default: 'strongest',
        },
        maxDepth: { type: 'number', description: 'Max path depth (default 6)', default: 6 },
      },
      required: ['sourceId', 'targetId'],
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

export type ToolArgs = Record<string, unknown>;

export interface ToolResult {
  success: boolean;
  result: string;
}

export class ToolExecutor {
  private db: GraphDB;
  private analytics: GraphAnalytics;
  private pathfinder: Pathfinder;
  private contextBuilder: ContextBuilder;
  private nlpExtractor: NLPExtractor;

  constructor(db: GraphDB) {
    this.db = db;
    this.analytics = new GraphAnalytics(db);
    this.pathfinder = new Pathfinder(db);
    this.contextBuilder = new ContextBuilder(db);
    this.nlpExtractor = new NLPExtractor(db);
  }

  async execute(toolName: string, args: ToolArgs): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'graph_search': {
          const { query, limit = 8, nodeTypes } = args as {
            query: string;
            limit?: number;
            nodeTypes?: string[];
          };
          const results = await this.db.searchNodes(query, limit, nodeTypes);
          if (results.length === 0) {
            return { success: true, result: `No nodes found matching "${query}".` };
          }
          const formatted = results
            .map((n) =>
              `[${n.type}] ${n.label} (id: ${n.id}, accessed ${n.accessCount ?? 0}x)${n.content ? `\n  "${n.content.slice(0, 120)}"` : ''}`
            )
            .join('\n\n');
          return { success: true, result: `Found ${results.length} nodes:\n\n${formatted}` };
        }

        case 'graph_inject': {
          const { currentFile, task, tokenBudget = 2000 } = args as {
            currentFile?: string;
            task?: string;
            tokenBudget?: number;
          };
          const context = await this.contextBuilder.build({ currentFile, task, tokenBudget });
          return { success: true, result: context };
        }

        case 'graph_read': {
          const { nodeId, depth = 2, minWeight = 0.1 } = args as {
            nodeId: string;
            depth?: number;
            minWeight?: number;
          };
          const subgraph = await this.db.bfsSubgraph(nodeId, depth, minWeight);
          if (subgraph.nodes.length === 0) {
            return { success: true, result: `No nodes found starting from "${nodeId}". Check node ID.` };
          }
          const nodeLines = subgraph.nodes
            .map(
              (n) =>
                `${'  '.repeat(n._depth ?? 0)}→ [${n.type}] ${n.label} (w=${(n._weight ?? 0).toFixed(2)})`
            )
            .join('\n');
          const edgeSummary = subgraph.edges
            .map((e) => `  ${e.sourceId} --[${e.type}, w=${e.weight?.toFixed(2)}]--> ${e.targetId}`)
            .join('\n');
          return {
            success: true,
            result: `Subgraph from "${nodeId}" (${subgraph.nodes.length} nodes, ${subgraph.edges.length} edges):\n\nNodes:\n${nodeLines}\n\nEdges:\n${edgeSummary}`,
          };
        }

        case 'graph_write': {
          const { node, edges = [] } = args as {
            node: { id: string; type: string; label: string; content?: string };
            edges?: Array<{ targetId: string; type: string; weight?: number }>;
          };
          await this.db.upsertNode({
            id: node.id,
            type: node.type as 'decision' | 'concept' | 'bug' | 'pattern' | 'file' | 'symbol' | 'session' | 'tool',
            label: node.label,
            content: node.content,
          });
          for (const edge of edges) {
            await this.db.upsertEdge({
              sourceId: node.id,
              targetId: edge.targetId,
              type: edge.type as 'imports' | 'references' | 'caused_by' | 'decided_in' | 'similar_to' | 'co_edited' | 'defines' | 'mentions' | 'tagged_with',
              weight: edge.weight ?? 0.5,
              accessCount: 1,
              archived: false,
            });
          }
          await this.db.persist();
          return {
            success: true,
            result: `✓ Recorded "${node.label}" [${node.type}] with ${edges.length} edge(s).`,
          };
        }

        case 'graph_stats': {
          const stats = this.db.getStats();
          const allNodes = this.db.getAllNodes();
          const byType: Record<string, number> = {};
          for (const n of allNodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
          return {
            success: true,
            result: JSON.stringify({ ...stats, byType }, null, 2),
          };
        }

        case 'graph_rank': {
          const { sortBy = 'pageRank', limit = 10 } = args as {
            sortBy?: 'pageRank' | 'hotness' | 'degree';
            limit?: number;
          };
          let scores = this.analytics.computeNodeScores();
          if (sortBy === 'hotness') scores = [...scores].sort((a, b) => b.hotness - a.hotness);
          else if (sortBy === 'degree') scores = [...scores].sort((a, b) => b.degree - a.degree);
          const top = scores.slice(0, limit);
          const formatted = top
            .map(
              (s, i) =>
                `${i + 1}. [${s.type}] ${s.label}\n   pageRank=${s.pageRank.toFixed(4)}, hotness=${s.hotness.toFixed(4)}, degree=${s.degree}`
            )
            .join('\n\n');
          return { success: true, result: `Top ${limit} nodes by ${sortBy}:\n\n${formatted}` };
        }

        case 'graph_hotpath': {
          const { sourceId, targetId, method = 'strongest', maxDepth = 6 } = args as {
            sourceId: string;
            targetId: string;
            method?: 'strongest' | 'shortest';
            maxDepth?: number;
          };
          const result =
            method === 'shortest'
              ? await this.pathfinder.shortestPath(sourceId, targetId, maxDepth)
              : await this.pathfinder.strongestPath(sourceId, targetId, maxDepth);
          return { success: true, result: JSON.stringify(result, null, 2) };
        }

        default:
          return { success: false, result: `Unknown tool: ${toolName}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, result: `Tool "${toolName}" failed: ${message}` };
    }
  }
}
