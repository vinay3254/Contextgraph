// src/agent/repl.ts
// Interactive readline REPL for the ContextGraph agent
// Supports multi-turn conversation, slash commands, and rich terminal output

import readline from 'readline';
import type { ContextGraphAgent } from './agent.js';
import type { BackendType } from './backends/index.js';

// ─── ANSI color helpers (inline, no extra deps) ───────────────────────────────

const ESC = '\x1b[';
const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  cyan: `${ESC}36m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  red: `${ESC}31m`,
  gray: `${ESC}90m`,
  white: `${ESC}97m`,
};

function color(code: string, text: string): string {
  return `${code}${text}${c.reset}`;
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const SLASH_COMMANDS: Record<string, string> = {
  '/help': 'Show available commands',
  '/clear': 'Clear conversation history (start fresh)',
  '/exit': 'Exit the agent REPL',
  '/quit': 'Exit the agent REPL',
  '/info': 'Show current backend and graph stats',
};

// ─── Spinner ──────────────────────────────────────────────────────────────────

function startSpinner(label: string): NodeJS.Timeout {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${color(c.cyan, frames[i % frames.length])} ${color(c.dim, label)}`);
    i++;
  }, 80);
  return timer;
}

function stopSpinner(timer: NodeJS.Timeout): void {
  clearInterval(timer);
  process.stdout.write('\r\x1b[K'); // Clear spinner line
}

// ─── Format assistant response ────────────────────────────────────────────────

function printResponse(text: string): void {
  const lines = text.split('\n');
  console.log();
  console.log(color(c.green, '┌─ Agent ──────────────────────────────────'));
  for (const line of lines) {
    // Simple markdown-like formatting
    if (line.startsWith('## ')) {
      console.log(`│ ${color(c.bold + c.cyan, line.slice(3))}`);
    } else if (line.startsWith('### ')) {
      console.log(`│ ${color(c.bold, line.slice(4))}`);
    } else if (line.startsWith('**') && line.endsWith('**')) {
      console.log(`│ ${color(c.bold, line.slice(2, -2))}`);
    } else if (line.startsWith('- ') || line.startsWith('• ')) {
      console.log(`│ ${color(c.yellow, '▸')} ${line.slice(2)}`);
    } else if (line.startsWith('```')) {
      console.log(`│ ${color(c.dim, line)}`);
    } else if (line.trim().startsWith('→')) {
      console.log(`│   ${color(c.cyan, line.trim())}`);
    } else {
      console.log(`│ ${line}`);
    }
  }
  console.log(color(c.green, '└──────────────────────────────────────────'));
  console.log();
}

// ─── Print slash command help ─────────────────────────────────────────────────

function printHelp(): void {
  console.log();
  console.log(color(c.cyan + c.bold, '  Slash Commands:'));
  for (const [cmd, desc] of Object.entries(SLASH_COMMANDS)) {
    console.log(`  ${color(c.yellow, cmd.padEnd(12))}  ${color(c.dim, desc)}`);
  }
  console.log();
  console.log(color(c.dim, '  Type any question to ask the agent. Multi-turn conversation is supported.'));
  console.log();
}

// ─── Print banner ─────────────────────────────────────────────────────────────

function printBanner(backendType: BackendType, model: string, nodeCount: number): void {
  console.log();
  console.log(color(c.cyan + c.bold, '  ⬡  ContextGraph Agent'));
  console.log(color(c.dim, `  Neural knowledge graph assistant for your dev project`));
  console.log();
  console.log(`  ${color(c.dim, 'Backend:')}  ${color(c.green, backendType === 'claude' ? '☁  Claude' : '🦙 Ollama')}  ${color(c.dim, model)}`);
  console.log(`  ${color(c.dim, 'Graph:')}    ${color(c.cyan, `${nodeCount} nodes`)} loaded in memory`);
  console.log();
  console.log(color(c.dim, `  Type your question, or /help for commands. Ctrl+C to exit.`));
  console.log();
}

// ─── REPL main function ───────────────────────────────────────────────────────

export async function startRepl(
  agent: ContextGraphAgent,
  db: import('../graph/kuzu.js').GraphDB
): Promise<void> {
  const { type: backendType, model } = agent.getBackendInfo();
  const stats = db.getStats();

  printBanner(backendType, model, stats.nodes);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => {
    rl.setPrompt(
      `${color(c.cyan + c.bold, '⬡')} ${color(c.dim, 'you')} ${color(c.cyan, '›')} `
    );
    rl.prompt();
  };

  prompt();

  rl.on('line', async (input) => {
    const line = input.trim();

    if (!line) {
      prompt();
      return;
    }

    // Slash commands
    if (line.startsWith('/')) {
      const cmd = line.toLowerCase().split(' ')[0];

      if (cmd === '/exit' || cmd === '/quit') {
        console.log(color(c.dim, '\n  Goodbye! Graph state saved.\n'));
        rl.close();
        process.exit(0);
      }

      if (cmd === '/clear') {
        agent.clearHistory();
        console.log(color(c.green, '\n  ✓ Conversation cleared. Starting fresh.\n'));
        prompt();
        return;
      }

      if (cmd === '/help') {
        printHelp();
        prompt();
        return;
      }

      if (cmd === '/info') {
        const s = db.getStats();
        const info = agent.getBackendInfo();
        console.log();
        console.log(`  ${color(c.dim, 'Backend:')} ${info.type} (${info.model})`);
        console.log(`  ${color(c.dim, 'Nodes:')}   ${s.nodes}`);
        console.log(`  ${color(c.dim, 'Edges:')}   ${s.edges} active, ${s.archived} archived`);
        console.log(`  ${color(c.dim, 'Decay:')}   ${s.lastDecay}`);
        console.log();
        prompt();
        return;
      }

      console.log(color(c.yellow, `\n  Unknown command: ${cmd}. Type /help for commands.\n`));
      prompt();
      return;
    }

    // Normal user message — call agent
    const spinner = startSpinner('Thinking…');

    try {
      const response = await agent.turn(line);
      stopSpinner(spinner);
      printResponse(response);
    } catch (err) {
      stopSpinner(spinner);
      const message = err instanceof Error ? err.message : String(err);
      console.log();
      console.log(color(c.red, `  ✗ Error: ${message}`));
      console.log();
    }

    prompt();
  });

  rl.on('close', () => {
    console.log(color(c.dim, '\n  Session ended.\n'));
    process.exit(0);
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log(color(c.dim, '\n\n  Ctrl+C — Goodbye!\n'));
    process.exit(0);
  });
}
