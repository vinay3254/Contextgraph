// src/server.ts
// ContextGraph MCP stdio server — entry point
// Registers all 8 MCP tools, runs decay on startup, starts watchers

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import { mkdirSync } from 'fs';

import { GraphDB } from './graph/kuzu.js';
import { DecayScheduler } from './graph/decay.js';
import { FileWatcher } from './watchers/files.js';
import { GitObserver } from './watchers/git.js';
import { ContextBuilder } from './inject/builder.js';
import { ObsidianExporter } from './export/obsidian.js';
import { GraphifyExporter } from './export/graphify.js';
import { NLPExtractor } from './nlp/extractor.js';
import {
  GraphWriteInputSchema,
  GraphReadInputSchema,
  GraphSearchInputSchema,
  GraphInjectInputSchema,
  GraphExportInputSchema,
  GraphLogMessageInputSchema,
} from './graph/schema.js';

// ─── Data directory ────────────────────────────────────────────────────────
const DATA_DIR = process.env['CONTEXTGRAPH_DATA_DIR']
  ?? path.join(process.cwd(), '.contextgraph');
const PROJECT_ROOT = process.env['CONTEXTGRAPH_PROJECT_ROOT']
  ?? process.cwd();

mkdirSync(DATA_DIR, { recursive: true });

// ─── Initialize components ────────────────────────────────────────────────
const db = new GraphDB(DATA_DIR);
const decay = new DecayScheduler(db);
const contextBuilder = new ContextBuilder(db);
const obsidianExporter = new ObsidianExporter(db);
const graphifyExporter = new GraphifyExporter(db);
const nlpExtractor = new NLPExtractor(db);
const fileWatcher = new FileWatcher(db, PROJECT_ROOT);
const gitObserver = new GitObserver(db, PROJECT_ROOT);

// ─── Current session ──────────────────────────────────────────────────────
const sessionId = `session-${new Date().toISOString().split('T')[0]}-${Math.random().toString(36).slice(2, 6)}`;

// ─── MCP Server ───────────────────────────────────────────────────────────
const server = new Server(
  { name: 'contextgraph', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ─────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'graph_write',
      description: 'Upsert a node and its edges into the knowledge graph. Edge weights are strengthened on each call (Hebbian learning). Use this to record files, decisions, concepts, bugs, patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          node: {
            type: 'object',
            description: 'The node to upsert',
            properties: {
              id: { type: 'string', description: 'Unique node ID (lowercase, alphanumeric + _-/.)' },
              type: { type: 'string', enum: ['file', 'symbol', 'decision', 'bug', 'concept', 'session', 'pattern', 'tool'] },
              label: { type: 'string', description: 'Human-readable label' },
              content: { type: 'string', description: 'Optional text content for semantic search' },
              filePath: { type: 'string', description: 'Absolute file path (for file/symbol nodes)' },
            },
            required: ['id', 'type', 'label'],
          },
          edges: {
            type: 'array',
            description: 'Edges to upsert from this node',
            items: {
              type: 'object',
              properties: {
                targetId: { type: 'string' },
                type: { type: 'string', enum: ['imports', 'references', 'caused_by', 'decided_in', 'similar_to', 'co_edited', 'defines', 'mentions', 'tagged_with'] },
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
      name: 'graph_read',
      description: 'Read a subgraph via weighted BFS from a node. Returns nodes ranked by edge weight. Use to understand a file\'s context, dependencies, and related decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Starting node ID' },
          depth: { type: 'number', description: 'BFS depth (1-5, default 2)', default: 2 },
          minWeight: { type: 'number', description: 'Minimum edge weight to follow (default 0.05)', default: 0.05 },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'graph_search',
      description: 'Search the graph by text query. Returns matching nodes ranked by relevance and access count.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results (default 10)', default: 10 },
          nodeTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by node types' },
        },
        required: ['query'],
      },
    },
    {
      name: 'graph_inject',
      description: 'Build a ranked context window string from the current file/task. Does weighted BFS, assembles highest-signal nodes within token budget. Use this to get relevant context before answering a question.',
      inputSchema: {
        type: 'object',
        properties: {
          currentFile: { type: 'string', description: 'Current file path (relative to project root)' },
          task: { type: 'string', description: 'Current task description' },
          tokenBudget: { type: 'number', description: 'Max tokens for context (default 3000)', default: 3000 },
        },
      },
    },
    {
      name: 'graph_decay',
      description: 'Run a weight decay pass (×0.95) on all edges. Edges below 0.05 are archived. Called automatically on startup every 24h.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'graph_export',
      description: 'Export the graph in a specified format.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['obsidian', 'graphify', 'json'], default: 'json' },
          outDir: { type: 'string', description: 'Output directory (optional)' },
        },
      },
    },
    {
      name: 'graph_log_message',
      description: 'Log a conversation turn into the graph. Claude Haiku extracts entities (decisions, bugs, concepts, patterns) and upserts them as nodes. Call this after each assistant turn.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string', description: 'Message content' },
          sessionId: { type: 'string', description: 'Session ID (optional)' },
        },
        required: ['role', 'content'],
      },
    },
    {
      name: 'graph_stats',
      description: 'Get graph statistics: node count, edge count, archived edges, last decay time.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

// ─── Tool Handlers ────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── graph_write ──────────────────────────────────────────────────
      case 'graph_write': {
        const input = GraphWriteInputSchema.parse(args);
        await db.upsertNode(input.node);
        for (const edge of input.edges ?? []) {
          await db.upsertEdge({
            ...edge,
            sourceId: input.node.id,
            accessCount: 1,
            archived: false,
          });
        }
        return {
          content: [{
            type: 'text',
            text: `✓ Upserted node "${input.node.label}" [${input.node.type}] with ${input.edges?.length ?? 0} edges`,
          }],
        };
      }

      // ── graph_read ───────────────────────────────────────────────────
      case 'graph_read': {
        const input = GraphReadInputSchema.parse(args);
        const subgraph = await db.bfsSubgraph(input.nodeId, input.depth, input.minWeight);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              anchor: input.nodeId,
              nodeCount: subgraph.nodes.length,
              edgeCount: subgraph.edges.length,
              nodes: subgraph.nodes.map((n) => ({
                id: n.id,
                label: n.label,
                type: n.type,
                weight: n._weight,
                depth: n._depth,
                accessCount: n.accessCount,
              })),
              edges: subgraph.edges.map((e) => ({
                source: e.sourceId,
                target: e.targetId,
                type: e.type,
                weight: e.weight,
              })),
            }, null, 2),
          }],
        };
      }

      // ── graph_search ─────────────────────────────────────────────────
      case 'graph_search': {
        const input = GraphSearchInputSchema.parse(args);
        const results = await db.searchNodes(input.query, input.limit, input.nodeTypes);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(results.map((n) => ({
              id: n.id,
              label: n.label,
              type: n.type,
              accessCount: n.accessCount,
              content: n.content?.slice(0, 200),
            })), null, 2),
          }],
        };
      }

      // ── graph_inject ─────────────────────────────────────────────────
      case 'graph_inject': {
        const input = GraphInjectInputSchema.parse(args);
        const context = await contextBuilder.build({
          currentFile: input.currentFile,
          task: input.task,
          tokenBudget: input.tokenBudget,
        });
        return { content: [{ type: 'text', text: context }] };
      }

      // ── graph_decay ──────────────────────────────────────────────────
      case 'graph_decay': {
        const result = await decay.runDecay();
        return {
          content: [{
            type: 'text',
            text: `✓ Decay complete: ${result.decayed} edges decayed (×0.95), ${result.archived} archived (below 0.05)`,
          }],
        };
      }

      // ── graph_export ─────────────────────────────────────────────────
      case 'graph_export': {
        const input = GraphExportInputSchema.parse(args);
        let result: string;

        if (input.format === 'obsidian') {
          const outDir = input.outDir ?? path.join(PROJECT_ROOT, 'contextgraph-obsidian');
          const count = await obsidianExporter.export(outDir);
          result = `✓ Exported ${count} nodes to Obsidian vault: ${outDir}`;
        } else if (input.format === 'graphify') {
          const outPath = await graphifyExporter.export(input.outDir);
          result = `✓ Exported graph to Graphify format: ${outPath}`;
        } else {
          const outPath = await graphifyExporter.exportRaw(input.outDir);
          result = `✓ Exported raw graph JSON: ${outPath}`;
        }

        return { content: [{ type: 'text', text: result }] };
      }

      // ── graph_log_message ────────────────────────────────────────────
      case 'graph_log_message': {
        const input = GraphLogMessageInputSchema.parse(args);
        const sid = input.sessionId ?? sessionId;

        // Ensure session node exists
        await db.upsertNode({
          id: `session:${sid}`,
          type: 'session',
          label: `Session ${sid}`,
          metadata: { startedAt: new Date().toISOString() },
        });

        // Extract entities (if NLP enabled)
        const entities = await nlpExtractor.extract(input.role, input.content, sid);

        return {
          content: [{
            type: 'text',
            text: nlpExtractor.isEnabled()
              ? `✓ Logged ${input.role} message. Extracted ${entities.length} entities: ${entities.map((e) => e.label).join(', ') || 'none'}`
              : `✓ Logged ${input.role} message (NLP disabled — set ANTHROPIC_API_KEY to enable entity extraction)`,
          }],
        };
      }

      // ── graph_stats ──────────────────────────────────────────────────
      case 'graph_stats': {
        const stats = db.getStats();
        const allNodes = db.getAllNodes();
        const byType: Record<string, number> = {};
        for (const n of allNodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...stats,
              byType,
              sessionId,
              projectRoot: PROJECT_ROOT,
              dataDir: DATA_DIR,
            }, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────
async function main() {
  // Initialize DB
  await db.init();

  // Create session node
  await db.upsertNode({
    id: `session:${sessionId}`,
    type: 'session',
    label: `Session ${sessionId}`,
    metadata: { startedAt: new Date().toISOString(), tool: 'mcp' },
  });

  // Run decay on startup
  await decay.start();

  // Start background watchers
  fileWatcher.start();
  await gitObserver.start();

  // Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[ContextGraph] MCP server running | Session: ${sessionId}`);
  console.error(`[ContextGraph] Project root: ${PROJECT_ROOT}`);
  console.error(`[ContextGraph] Data dir: ${DATA_DIR}`);
}

main().catch((err) => {
  console.error('[ContextGraph] Fatal error:', err);
  process.exit(1);
});
