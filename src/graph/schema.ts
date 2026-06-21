// src/graph/schema.ts
// Node and edge type definitions with Zod validation schemas

import { z } from 'zod';

// ─── Node Types ────────────────────────────────────────────────────────────
export const NodeTypeEnum = z.enum([
  'file',       // Source file (auth.ts, MeetingRegistry.sol)
  'symbol',     // Function/class/variable (useAuth, MeetingRegistry)
  'decision',   // Architectural decision ("use JWT not sessions")
  'bug',        // Bug reference (#312 CORS error)
  'concept',    // Domain concept (Polygon, IPFS, WebRTC)
  'session',    // Coding session (session-2026-06-21)
  'pattern',    // Recurring pattern ("always use Zod for validation")
  'tool',       // Tool/client (Cursor, Claude, VS Code)
]);
export type NodeType = z.infer<typeof NodeTypeEnum>;

// ─── Edge Types ────────────────────────────────────────────────────────────
export const EdgeTypeEnum = z.enum([
  'imports',      // File A imports File B
  'references',   // Symbol A references Symbol B
  'caused_by',    // Bug caused by file/decision
  'decided_in',   // Decision made in session
  'similar_to',   // Semantic similarity
  'co_edited',    // Co-changed in a git commit
  'defines',      // File defines symbol
  'mentions',     // Session/decision mentions concept
  'tagged_with',  // Node tagged with concept
]);
export type EdgeType = z.infer<typeof EdgeTypeEnum>;

// ─── Graph Node ────────────────────────────────────────────────────────────
export const GraphNodeSchema = z.object({
  id: z.string().regex(/^[a-z0-9_\-/.]+$/, 'Node ID must be lowercase alphanumeric with _ - / .'),
  type: NodeTypeEnum,
  label: z.string().min(1),
  content: z.string().optional(),  // Full text content for embedding
  filePath: z.string().optional(), // Absolute file path (for file/symbol nodes)
  language: z.string().optional(), // Programming language
  line: z.number().int().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime().optional(),
  lastSeenAt: z.string().datetime().optional(),
  accessCount: z.number().int().default(0).optional(),
  // Embedding stored as JSON string of number[]
  embedding: z.string().optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

// ─── Graph Edge ────────────────────────────────────────────────────────────
export const GraphEdgeSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  type: EdgeTypeEnum,
  weight: z.number().min(0).max(1).default(0.5),
  // Hebbian metadata
  accessCount: z.number().int().default(1),
  lastStrengthened: z.string().datetime().optional(),
  lastDecayed: z.string().datetime().optional(),
  archived: z.boolean().default(false),
  metadata: z.record(z.unknown()).optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

// ─── Subgraph result (BFS output) ─────────────────────────────────────────
export interface SubgraphResult {
  nodes: (GraphNode & { _weight?: number; _depth?: number })[];
  edges: GraphEdge[];
}

// ─── Export formats ────────────────────────────────────────────────────────
export const ExportFormatEnum = z.enum(['obsidian', 'graphify', 'json']);
export type ExportFormat = z.infer<typeof ExportFormatEnum>;

// ─── MCP tool input schemas ────────────────────────────────────────────────
export const GraphWriteInputSchema = z.object({
  node: GraphNodeSchema,
  edges: z.array(GraphEdgeSchema).optional(),
});

export const GraphReadInputSchema = z.object({
  nodeId: z.string(),
  depth: z.number().int().min(1).max(5).default(2),
  minWeight: z.number().min(0).max(1).default(0.05),
});

export const GraphSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  nodeTypes: z.array(NodeTypeEnum).optional(),
});

export const GraphInjectInputSchema = z.object({
  currentFile: z.string().optional(),
  task: z.string().optional(),
  tokenBudget: z.number().int().default(3000),
});

export const GraphExportInputSchema = z.object({
  format: ExportFormatEnum.default('json'),
  outDir: z.string().optional(),
});

export const GraphLogMessageInputSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  sessionId: z.string().optional(),
});

// ─── Constants ─────────────────────────────────────────────────────────────
export const WEIGHT_INITIAL = 0.5;
export const WEIGHT_MAX = 1.0;
export const WEIGHT_MIN = 0.0;
export const WEIGHT_STRENGTHEN_OCCURRENCE = 0.1;
export const WEIGHT_STRENGTHEN_COMMIT = 0.15;
export const WEIGHT_DECAY_FACTOR = 0.95;
export const WEIGHT_ARCHIVE_THRESHOLD = 0.05;
export const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Node type color mapping for visualization
export const NODE_TYPE_COLORS: Record<NodeType, string> = {
  file: '#4A9EFF',
  symbol: '#34D399',
  decision: '#FBBF24',
  bug: '#F87171',
  concept: '#A78BFA',
  session: '#94A3B8',
  pattern: '#F97316',
  tool: '#06B6D4',
};
