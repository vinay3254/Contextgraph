// src/agent/backends/claude.ts
// Claude API backend — uses native tool-use API for agentic loop

import Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ToolArgs } from '../tools.js';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  toolCalls: Array<{ name: string; id: string; args: ToolArgs }>;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
}

export class ClaudeBackend {
  private client: Anthropic;
  private model: string;
  private systemPrompt: string;
  private tools: ToolDefinition[];

  constructor(options: {
    apiKey: string;
    model?: string;
    systemPrompt: string;
    tools: ToolDefinition[];
  }) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? 'claude-haiku-4-5';
    this.systemPrompt = options.systemPrompt;
    this.tools = options.tools;
  }

  async chat(
    history: Message[],
    toolResults?: Array<{ id: string; content: string }>
  ): Promise<LLMResponse> {
    // Build Anthropic message format
    const messages: Anthropic.MessageParam[] = [];

    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // If we have tool results, append them as user message
    if (toolResults && toolResults.length > 0) {
      // Tool results are already appended in the history by the agent loop
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: this.systemPrompt,
      tools: this.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool['input_schema'],
      })),
      messages,
    });

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    const content = textBlocks.map((b) => b.text).join('\n');
    const toolCalls = toolBlocks.map((b) => ({
      name: b.name,
      id: b.id,
      args: b.input as ToolArgs,
    }));

    return {
      content,
      toolCalls,
      stopReason:
        response.stop_reason === 'tool_use'
          ? 'tool_use'
          : response.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : 'end_turn',
    };
  }

  /**
   * Build Anthropic-format messages for tool calls and results.
   * The agent loop calls this to append tool interactions to history.
   */
  buildToolMessages(
    assistantContent: Anthropic.ContentBlock[],
    toolResults: Array<{ id: string; name: string; content: string; isError: boolean }>
  ): Anthropic.MessageParam[] {
    return [
      { role: 'assistant', content: assistantContent },
      {
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        })),
      },
    ];
  }

  getModel(): string {
    return this.model;
  }
}
