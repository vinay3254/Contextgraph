// src/agent/backends/index.ts
// Auto-detect and route to the best available LLM backend

import { ClaudeBackend } from './claude.js';
import { OllamaBackend } from './ollama.js';
import type { ToolDefinition } from '../tools.js';

export type BackendType = 'claude' | 'ollama';

export interface BackendOptions {
  backend?: BackendType;
  model?: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  ollamaUrl?: string;
}

export interface BackendInfo {
  type: BackendType;
  model: string;
}

export async function createBackend(
  options: BackendOptions
): Promise<{ claude: ClaudeBackend | null; ollama: OllamaBackend | null; info: BackendInfo }> {
  const { backend, model, systemPrompt, tools, ollamaUrl } = options;

  // Forced backend selection
  if (backend === 'claude') {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'Claude backend requested but ANTHROPIC_API_KEY is not set.\n' +
          'Set it with: set ANTHROPIC_API_KEY=sk-ant-...'
      );
    }
    const claude = new ClaudeBackend({ apiKey, model, systemPrompt, tools });
    return { claude, ollama: null, info: { type: 'claude', model: claude.getModel() } };
  }

  if (backend === 'ollama') {
    const ollama = new OllamaBackend({ baseUrl: ollamaUrl, model, systemPrompt, tools });
    const available = await OllamaBackend.isAvailable(ollamaUrl);
    if (!available) {
      throw new Error(
        'Ollama backend requested but Ollama is not running.\n' +
          'Start it with: ollama serve\n' +
          'Then pull a model: ollama pull llama3'
      );
    }
    return { claude: null, ollama, info: { type: 'ollama', model: ollama.getModel() } };
  }

  // Auto-detect: prefer Claude if key available, then try Ollama
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey) {
    const claude = new ClaudeBackend({ apiKey, model, systemPrompt, tools });
    return { claude, ollama: null, info: { type: 'claude', model: claude.getModel() } };
  }

  // Try Ollama
  const ollamaAvailable = await OllamaBackend.isAvailable(ollamaUrl);
  if (ollamaAvailable) {
    const ollama = new OllamaBackend({ baseUrl: ollamaUrl, model, systemPrompt, tools });
    return { claude: null, ollama, info: { type: 'ollama', model: ollama.getModel() } };
  }

  throw new Error(
    '⚠  No LLM backend available.\n\n' +
      'Options:\n' +
      '  1. Set ANTHROPIC_API_KEY for Claude (best quality)\n' +
      '     set ANTHROPIC_API_KEY=sk-ant-...\n\n' +
      '  2. Run Ollama locally (free, private)\n' +
      '     Install: https://ollama.ai\n' +
      '     Start:   ollama serve\n' +
      '     Model:   ollama pull llama3\n' +
      '     Then run: ctx agent again'
  );
}
