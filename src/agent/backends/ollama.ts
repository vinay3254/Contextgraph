// src/agent/backends/ollama.ts
// Ollama local model backend — calls http://localhost:11434/api/chat
// Formats tools as function-calling JSON supported by Ollama >= 0.3.0

import type { ToolDefinition, ToolArgs } from '../tools.js';

export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OllamaToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

interface OllamaResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
}

export interface LLMResponse {
  content: string;
  toolCalls: Array<{ name: string; id: string; args: ToolArgs }>;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
}

export class OllamaBackend {
  private baseUrl: string;
  private model: string;
  private systemPrompt: string;
  private tools: ToolDefinition[];

  constructor(options: {
    baseUrl?: string;
    model?: string;
    systemPrompt: string;
    tools: ToolDefinition[];
  }) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:11434';
    this.model = options.model ?? 'llama3';
    this.systemPrompt = options.systemPrompt;
    this.tools = options.tools;
  }

  async chat(messages: Message[]): Promise<LLMResponse> {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: this.systemPrompt }, ...messages],
      tools: this.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 4096,
      },
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as OllamaResponse;
    const msg = data.message;

    const toolCalls: LLMResponse['toolCalls'] = [];
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let args: ToolArgs = {};
        try {
          args = JSON.parse(tc.function.arguments) as ToolArgs;
        } catch {
          args = {};
        }
        toolCalls.push({ name: tc.function.name, id: tc.id, args });
      }
    }

    return {
      content: msg.content ?? '',
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }

  static async isAvailable(baseUrl = 'http://localhost:11434'): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as { models: Array<{ name: string }> };
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  getModel(): string {
    return this.model;
  }
}
