#!/usr/bin/env node
// src/cli/shisya.ts
// Shisya — standalone agentic CLI entry point
// Usage: shisya [question]  or just: shisya  (starts interactive REPL)

import path from 'path';
import { mkdirSync } from 'fs';
import { Command } from 'commander';

const program = new Command();

program
  .name('shisya')
  .description('Shisya — your neural codebase agent, powered by ContextGraph')
  .version('0.1.0')
  .argument('[question]', 'Ask a one-shot question and exit')
  .option('--backend <type>', 'Force backend: claude | ollama (auto-detect by default)')
  .option('--model <name>', 'Override model name (e.g. llama3, claude-haiku-4-5, claude-sonnet-4-5)')
  .option('--no-memory', 'Disable graph memory for this session')
  .option('--ollama-url <url>', 'Ollama base URL (default: http://localhost:11434)')
  .option('--stats', 'Print graph stats and exit')
  .option('--ui', 'Open the Shisya web UI in your browser (localhost:7332)')
  .addHelpText(
    'after',
    `
Examples:
  shisya                                    Start interactive REPL
  shisya --ui                               Open web UI in browser
  shisya "how does the decay system work?"  One-shot answer
  shisya --backend ollama                   Use local Ollama model
  shisya --model claude-sonnet-4-5          Use a specific Claude model
  shisya --stats                            Show graph stats

REPL Slash Commands:
  /help    Show commands
  /info    Show backend + graph stats
  /clear   Reset conversation
  /exit    Quit
`
  );

program.action(
  async (
    question: string | undefined,
    opts: {
      backend?: string;
      model?: string;
      memory: boolean;
      ollamaUrl?: string;
      stats?: boolean;
      ui?: boolean;
    }
  ) => {
    const { GraphDB } = await import('../graph/kuzu.js');
    const { ContextGraphAgent } = await import('../agent/agent.js');

    const projectRoot = path.resolve(process.cwd());
    const dataDir =
      process.env['CONTEXTGRAPH_DATA_DIR'] ?? path.join(projectRoot, '.contextgraph');
    mkdirSync(dataDir, { recursive: true });

    const db = new GraphDB(dataDir);
    await db.init();

    // --stats shortcut
    if (opts.stats) {
      const s = db.getStats();
      const allNodes = db.getAllNodes();
      const byType: Record<string, number> = {};
      for (const n of allNodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
      console.log('\n\x1b[36m\x1b[1m  ⬡  Shisya — Graph Stats\x1b[0m\n');
      console.log(`  \x1b[2mNodes:\x1b[0m   ${s.nodes}`);
      console.log(`  \x1b[2mEdges:\x1b[0m   ${s.edges} active, ${s.archived} archived`);
      console.log(`  \x1b[2mDecay:\x1b[0m   ${s.lastDecay}`);
      console.log(`\n  \x1b[2mBy type:\x1b[0m`);
      for (const [type, count] of Object.entries(byType)) {
        console.log(`    ${type.padEnd(12)} ${count}`);
      }
      console.log();
      process.exit(0);
    }

    // --ui: open web UI
    if (opts.ui) {
      const { ShisyaUIServer } = await import('../agent/ui-server.js');
      const { default: open } = await import('open');
      const ui = new ShisyaUIServer(db, projectRoot, {
        backend: opts.backend as 'claude' | 'ollama' | undefined,
        model: opts.model,
        noMemory: !opts.memory,
      });
      const url = await ui.start();
      console.log(`\n\x1b[36m\x1b[1m  ⬡  Shisya UI\x1b[0m`);
      console.log(`  \x1b[2mRunning at\x1b[0m \x1b[36m\x1b[1m${url}\x1b[0m`);
      console.log(`  \x1b[2mPress Ctrl+C to stop\x1b[0m\n`);
      await open(url);
      process.on('SIGINT', () => { ui.stop(); process.exit(0); });
      await new Promise<void>(() => {});
      return;
    }

    const agent = new ContextGraphAgent({
      db,
      projectRoot,
      backend: opts.backend as 'claude' | 'ollama' | undefined,
      model: opts.model,
      noMemory: !opts.memory,
      ollamaUrl: opts.ollamaUrl,
    });

    // Initialize — detect backend
    let backendInfo: { backendType: 'claude' | 'ollama'; model: string };
    try {
      const info = await agent.init();
      backendInfo = info;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n\x1b[31m${message}\x1b[0m\n`);
      process.exit(1);
    }

    // ── One-shot mode ────────────────────────────────────────────────────────
    if (question) {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let fi = 0;
      const spinner = setInterval(() => {
        process.stdout.write(`\r\x1b[36m${frames[fi++ % frames.length]}\x1b[0m \x1b[2mShisya is thinking…\x1b[0m`);
      }, 80);

      try {
        const response = await agent.turn(question);
        clearInterval(spinner);
        process.stdout.write('\r\x1b[K');

        console.log(`\n\x1b[2m[shisya · ${backendInfo.backendType} · ${backendInfo.model}]\x1b[0m\n`);
        console.log(response);
        console.log();
      } catch (err) {
        clearInterval(spinner);
        process.stdout.write('\r\x1b[K');
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\n\x1b[31m  ✗ ${message}\x1b[0m\n`);
        process.exit(1);
      }
      process.exit(0);
    }

    // ── Interactive REPL mode ────────────────────────────────────────────────
    const { startRepl } = await import('../agent/repl.js');
    await startRepl(agent, db);
  }
);

program.parse(process.argv);
