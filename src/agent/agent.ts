// src/agent/agent.ts
// Main agentic tool-calling loop for ContextGraph
//
// Flow per turn:
//   user message → LLM → [tool calls]? → execute tools → LLM (with results) → final answer
//   Repeat until stop_reason = "end_turn"

import Anthropic from '@anthropic-ai/sdk';
import type { GraphDB } from '../graph/kuzu.js';
import { CONTEXTGRAPH_TOOLS, ToolExecutor } from './tools.js';
import { createBackend, type BackendType } from './backends/index.js';
import type { Message as OllamaMessage } from './backends/ollama.js';

const MAX_TOOL_ROUNDS = 8; // Max tool-call rounds per user turn (prevent infinite loops)

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  projectRoot: string,
  nodeCount: number,
  edgeCount: number,
  sessionId: string
): string {
  return `You are ContextGraph Agent — an intelligent AI assistant embedded in a living neural knowledge graph of the developer's project.

## Your Capabilities
You have access to the project's knowledge graph with ${nodeCount} nodes and ${edgeCount} edges, tracking files, symbols, decisions, bugs, and concepts with Hebbian-weighted relationships.

## Your Tools
- **graph_search** — search nodes by keyword (use this first!)
- **graph_inject** — get rich BFS context from a file or task
- **graph_read** — explore a node's neighborhood
- **graph_write** — record decisions, bugs, concepts the user mentions
- **graph_stats** — get graph statistics
- **graph_rank** — find most important/hot nodes
- **graph_hotpath** — find path between two nodes

## Behavior Rules
1. **Always search first** — before answering any codebase question, call graph_search or graph_inject to get relevant context from the knowledge graph
2. **Be concise** — give clear, direct answers. Use the graph data to ground your responses
3. **Record knowledge** — if the user mentions a decision, bug, or important concept, use graph_write to preserve it
4. **Cite your sources** — mention which nodes/files you found in the graph when relevant
5. **Think step by step** for complex questions, but keep responses focused

## Project Context
- **Project root**: ${projectRoot}
- **Session**: ${sessionId}
- **Graph**: ${nodeCount} nodes, ${edgeCount} edges

You are running as a CLI agent. Be helpful, direct, and use the knowledge graph to give well-grounded answers about this specific project.`;
}

// ─── Agent options ─────────────────────────────────────────────────────────────

export interface AgentOptions {
  db: GraphDB;
  projectRoot: string;
  backend?: BackendType;
  model?: string;
  noMemory?: boolean;
  ollamaUrl?: string;
}

// ─── Conversation message (internal) ─────────────────────────────────────────

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Agent class ──────────────────────────────────────────────────────────────

export class ContextGraphAgent {
  private db: GraphDB;
  private executor: ToolExecutor;
  private projectRoot: string;
  private options: AgentOptions;
  private sessionId: string;
  private initialized = false;

  // Backend handles (only one is set at a time)
  private claudeBackend: import('./backends/claude.js').ClaudeBackend | null = null;
  private ollamaBackend: import('./backends/ollama.js').OllamaBackend | null = null;
  private backendType: BackendType = 'claude';
  private modelName = '';

  // Conversation history for multi-turn REPL
  // For Claude: we manage raw Anthropic message arrays
  // For Ollama: we manage OllamaMessage arrays
  private claudeHistory: Anthropic.MessageParam[] = [];
  private ollamaHistory: OllamaMessage[] = [];
  private simpleHistory: ConversationMessage[] = [];

  constructor(options: AgentOptions) {
    this.db = options.db;
    this.executor = new ToolExecutor(options.db);
    this.projectRoot = options.projectRoot;
    this.options = options;
    this.sessionId = `agent-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async init(): Promise<{ backendType: BackendType; model: string }> {
    const stats = this.db.getStats();
    const systemPrompt = buildSystemPrompt(
      this.projectRoot,
      stats.nodes,
      stats.edges,
      this.sessionId
    );

    const { claude, ollama, info } = await createBackend({
      backend: this.options.backend,
      model: this.options.model,
      systemPrompt,
      tools: CONTEXTGRAPH_TOOLS,
      ollamaUrl: this.options.ollamaUrl,
    });

    this.claudeBackend = claude;
    this.ollamaBackend = ollama;
    this.backendType = info.type;
    this.modelName = info.model;
    this.initialized = true;

    // Create agent session node
    if (!this.options.noMemory) {
      await this.db.upsertNode({
        id: `session:${this.sessionId}`,
        type: 'session',
        label: `Agent session ${this.sessionId}`,
        metadata: {
          startedAt: new Date().toISOString(),
          backend: info.type,
          model: info.model,
          tool: 'agent-cli',
        },
      });
    }

    return { backendType: info.type, model: info.model };
  }

  getBackendInfo(): { type: BackendType; model: string } {
    return { type: this.backendType, model: this.modelName };
  }

  clearHistory(): void {
    this.claudeHistory = [];
    this.ollamaHistory = [];
    this.simpleHistory = [];
  }

  // ─── Main turn method ──────────────────────────────────────────────────────

  async turn(userMessage: string): Promise<string> {
    if (!this.initialized) throw new Error('Agent not initialized — call init() first');

    if (this.backendType === 'claude' && this.claudeBackend) {
      return this.claudeTurn(userMessage);
    } else if (this.backendType === 'ollama' && this.ollamaBackend) {
      return this.ollamaTurn(userMessage);
    }
    throw new Error('No backend available');
  }

  // ─── Claude agentic turn ──────────────────────────────────────────────────

  private async claudeTurn(userMessage: string): Promise<string> {
    const claude = this.claudeBackend!;
    const stats = this.db.getStats();

    // Rebuild system prompt with fresh stats each turn
    const systemPrompt = buildSystemPrompt(
      this.projectRoot,
      stats.nodes,
      stats.edges,
      this.sessionId
    );

    // Append user message to history
    this.claudeHistory.push({ role: 'user', content: userMessage });

    let finalText = '';
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      // Call Claude
      const response = await this.claudeBackend!.chat(
        this.claudeHistory.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }))
      );

      // Handle stop
      if (response.stopReason === 'end_turn' || response.toolCalls.length === 0) {
        finalText = response.content;
        this.claudeHistory.push({ role: 'assistant', content: response.content });
        break;
      }

      // Execute tool calls
      const toolResultMessages: Anthropic.ToolResultBlockParam[] = [];
      const assistantContentBlocks: Anthropic.ContentBlock[] = [];

      if (response.content) {
        assistantContentBlocks.push({ type: 'text', text: response.content });
      }

      for (const toolCall of response.toolCalls) {
        const result = await this.executor.execute(toolCall.name, toolCall.args);
        assistantContentBlocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.args,
        });
        toolResultMessages.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: result.result,
          is_error: !result.success,
        });
      }

      // Append assistant message with tool calls + tool results to history
      this.claudeHistory.push({ role: 'assistant', content: assistantContentBlocks as unknown as string });
      this.claudeHistory.push({ role: 'user', content: toolResultMessages as unknown as string });
    }

    if (rounds >= MAX_TOOL_ROUNDS && !finalText) {
      finalText = 'I hit the maximum tool-call limit. Please try a more specific question.';
    }

    // Log conversation to graph
    if (!this.options.noMemory) {
      await this.logMessage('user', userMessage);
      await this.logMessage('assistant', finalText);
    }

    return finalText;
  }

  // ─── Ollama agentic turn ──────────────────────────────────────────────────

  private async ollamaTurn(userMessage: string): Promise<string> {
    this.ollamaHistory.push({ role: 'user', content: userMessage });

    let finalText = '';
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      const response = await this.ollamaBackend!.chat(this.ollamaHistory);

      if (response.stopReason === 'end_turn' || response.toolCalls.length === 0) {
        finalText = response.content;
        this.ollamaHistory.push({ role: 'assistant', content: response.content });
        break;
      }

      // Append assistant message with tool calls
      this.ollamaHistory.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      // Execute each tool and append results
      for (const toolCall of response.toolCalls) {
        const result = await this.executor.execute(toolCall.name, toolCall.args);
        this.ollamaHistory.push({
          role: 'tool',
          content: result.result,
          tool_call_id: toolCall.id,
          name: toolCall.name,
        });
      }
    }

    if (rounds >= MAX_TOOL_ROUNDS && !finalText) {
      finalText = 'I hit the maximum tool-call limit. Please try a more specific question.';
    }

    if (!this.options.noMemory) {
      await this.logMessage('user', userMessage);
      await this.logMessage('assistant', finalText);
    }

    return finalText;
  }

  // ─── Graph memory ─────────────────────────────────────────────────────────

  private async logMessage(role: 'user' | 'assistant', content: string): Promise<void> {
    if (!content || content.length < 10) return;
    // Log lightweight — just upsert session node access
    await this.db.upsertNode({
      id: `session:${this.sessionId}`,
      type: 'session',
      label: `Agent session ${this.sessionId}`,
      content: `Last ${role}: ${content.slice(0, 200)}`,
    });
    await this.db.persist();
  }
}
