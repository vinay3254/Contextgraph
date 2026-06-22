#!/usr/bin/env node
// src/cli/ctx.ts
// ContextGraph CLI — ctx / ctxgraph binary

import { Command } from 'commander';
import path from 'path';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

// Dynamic import helper for runtime components
async function getComponents(projectRoot: string) {
  const { GraphDB } = await import('../graph/kuzu.js');
  const { DecayScheduler } = await import('../graph/decay.js');
  const { ContextBuilder } = await import('../inject/builder.js');
  const { ObsidianExporter } = await import('../export/obsidian.js');
  const { GraphifyExporter } = await import('../export/graphify.js');
  const { FileWatcher } = await import('../watchers/files.js');
  const { GitObserver } = await import('../watchers/git.js');
  const { VizServer } = await import('../viz/server.js');
  const { GraphAnalytics } = await import('../analytics/pagerank.js');
  const { Pathfinder } = await import('../graph/pathfinder.js');
  const { MermaidExporter } = await import('../export/mermaid.js');

  const dataDir = process.env['CONTEXTGRAPH_DATA_DIR']
    ?? path.join(projectRoot, '.contextgraph');
  mkdirSync(dataDir, { recursive: true });

  const db = new GraphDB(dataDir);
  await db.init();

  return { db, dataDir, DecayScheduler, ContextBuilder, ObsidianExporter, GraphifyExporter, FileWatcher, GitObserver, VizServer, GraphAnalytics, Pathfinder, MermaidExporter };
}

// ─── Chalk (dynamic import for ESM) ────────────────────────────────────────
async function chalk() {
  const { default: c } = await import('chalk');
  return c;
}

// ─── MCP config generators ─────────────────────────────────────────────────
function cursorMcpConfig(serverPath: string): object {
  return {
    mcpServers: {
      contextgraph: {
        command: 'node',
        args: [serverPath],
        env: {
          CONTEXTGRAPH_PROJECT_ROOT: process.cwd(),
          CONTEXTGRAPH_DATA_DIR: path.join(process.cwd(), '.contextgraph'),
        },
      },
    },
  };
}

// ─── Program ───────────────────────────────────────────────────────────────
const program = new Command();

program
  .name('ctx')
  .description('ContextGraph — Neural Knowledge Graph for dev context')
  .version('0.1.0');

// ── ctx init ─────────────────────────────────────────────────────────────
program
  .command('init [path]')
  .description('Scan project and build initial knowledge graph')
  .option('--no-git', 'Skip git history processing')
  .action(async (scanPath?: string, opts?: { git: boolean }) => {
    const c = await chalk();
    const projectRoot = path.resolve(scanPath ?? process.cwd());
    console.log(c.cyan.bold('\n⬡  ContextGraph Init'));
    console.log(c.dim(`   Project: ${projectRoot}\n`));

    const { db, dataDir, DecayScheduler, FileWatcher, GitObserver } = await getComponents(projectRoot);

    // Create session node
    const sessionId = `session-${new Date().toISOString().split('T')[0]}`;
    await db.upsertNode({
      id: `session:${sessionId}`,
      type: 'session',
      label: `Init session ${sessionId}`,
      metadata: { type: 'init', projectRoot },
    });

    // Run decay
    const decayScheduler = new DecayScheduler(db);
    await decayScheduler.runDecay();

    // Scan files (one-shot, not persistent)
    console.log(c.yellow('  Scanning files...'));
    const watcher = new FileWatcher(db, projectRoot);
    watcher.start();

    // Let watcher process files for 8 seconds
    await new Promise<void>((resolve) => setTimeout(resolve, 8000));
    watcher.stop();

    // Process git history
    if (opts?.git !== false) {
      console.log(c.yellow('  Processing git history...'));
      const gitObs = new GitObserver(db, projectRoot);
      await gitObs.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));
      gitObs.stop();
    }

    await db.persist();
    const stats = db.getStats();

    console.log(c.green(`\n  ✓ Graph initialized!`));
    console.log(c.dim(`    Nodes: ${stats.nodes}  |  Edges: ${stats.edges}  |  Data: ${dataDir}`));
    console.log(c.dim(`\n  Run ${c.cyan('ctx watch')} to start background watchers`));
    console.log(c.dim(`  Run ${c.cyan('ctx graph')} to open the visualization\n`));
  });

// ── ctx watch ────────────────────────────────────────────────────────────
program
  .command('watch [path]')
  .description('Start background file and git watchers')
  .action(async (watchPath?: string) => {
    const c = await chalk();
    const projectRoot = path.resolve(watchPath ?? process.cwd());

    console.log(c.cyan.bold('\n⬡  ContextGraph Watch'));
    console.log(c.dim(`   Watching: ${projectRoot}`));
    console.log(c.dim('   Press Ctrl+C to stop\n'));

    const { db, FileWatcher, GitObserver, DecayScheduler } = await getComponents(projectRoot);

    const watcher = new FileWatcher(db, projectRoot);
    const gitObs = new GitObserver(db, projectRoot);
    const decayScheduler = new DecayScheduler(db);

    watcher.start();
    await gitObs.start();
    await decayScheduler.start();

    console.log(c.green('  ✓ Watching for file changes and git commits\n'));

    // Keep alive + periodic save
    setInterval(async () => {
      const stats = db.getStats();
      process.stdout.write(`\r${c.dim(`  ${stats.nodes} nodes · ${stats.edges} edges`)}`);
      await db.persist();
    }, 5000);

    process.on('SIGINT', async () => {
      console.log(c.yellow('\n  Saving graph...'));
      watcher.stop();
      gitObs.stop();
      decayScheduler.stop();
      await db.persist();
      console.log(c.green('  ✓ Saved. Goodbye!\n'));
      process.exit(0);
    });
  });

// ── ctx add ──────────────────────────────────────────────────────────────
program
  .command('add <text>')
  .description('Add a decision, concept, or note to the graph')
  .option('-t, --type <type>', 'Node type: decision|concept|bug|pattern', 'decision')
  .option('--tag <concepts>', 'Comma-separated related concepts to link')
  .action(async (text: string, opts: { type: string; tag?: string }) => {
    const c = await chalk();
    const { db } = await getComponents(process.cwd());

    const nodeType = (opts.type ?? 'decision') as 'decision' | 'concept' | 'bug' | 'pattern';
    const nodeId = `${nodeType}:${text.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80)}`;

    await db.upsertNode({
      id: nodeId,
      type: nodeType,
      label: text,
      content: text,
      metadata: { addedVia: 'cli', addedAt: new Date().toISOString() },
    });

    // Link related concepts
    if (opts.tag) {
      for (const concept of opts.tag.split(',').map((s) => s.trim()).filter(Boolean)) {
        const conceptId = `concept:${concept.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
        await db.upsertNode({ id: conceptId, type: 'concept', label: concept });
        await db.upsertEdge({
          sourceId: nodeId, targetId: conceptId, type: 'mentions',
          weight: 0.5, accessCount: 1, archived: false,
        });
      }
    }

    await db.persist();
    console.log(c.green(`\n  ✓ Added ${nodeType}: "${text}"\n`));
  });

// ── ctx search ───────────────────────────────────────────────────────────
program
  .command('search <query>')
  .description('Search the knowledge graph')
  .option('-n, --limit <n>', 'Max results', '10')
  .option('-t, --type <types>', 'Filter by type (comma-separated)')
  .action(async (query: string, opts: { limit: string; type?: string }) => {
    const c = await chalk();
    const { db } = await getComponents(process.cwd());

    const nodeTypes = opts.type?.split(',').map((s) => s.trim()).filter(Boolean);
    const results = await db.searchNodes(query, parseInt(opts.limit), nodeTypes);

    if (results.length === 0) {
      console.log(c.yellow(`\n  No results for "${query}"\n`));
      return;
    }

    console.log(c.cyan(`\n  Search: "${query}" (${results.length} results)\n`));
    for (const node of results) {
      const typeColor: Record<string, string> = {
        file: 'blue', symbol: 'green', decision: 'yellow',
        bug: 'red', concept: 'magenta', session: 'gray',
        pattern: 'yellow', tool: 'cyan',
      };
      const col = (typeColor[node.type] ?? 'white') as keyof typeof c;
      const typeLabel = (c[col] as (s: string) => string)(`[${node.type}]`);
      console.log(`  ${typeLabel} ${node.label}`);
      if (node.content) console.log(c.dim(`    ${node.content.slice(0, 100)}`));
      console.log(c.dim(`    accessed ${node.accessCount}x · id: ${node.id}`));
      console.log();
    }
  });

// ── ctx inject ───────────────────────────────────────────────────────────
program
  .command('inject')
  .description('Print weighted context window to stdout')
  .option('-f, --file <path>', 'Current file')
  .option('-t, --task <text>', 'Current task')
  .option('--budget <tokens>', 'Token budget', '3000')
  .action(async (opts: { file?: string; task?: string; budget: string }) => {
    const { db, ContextBuilder } = await getComponents(process.cwd());
    const builder = new ContextBuilder(db);
    const context = await builder.build({
      currentFile: opts.file,
      task: opts.task,
      tokenBudget: parseInt(opts.budget),
    });
    console.log(context);
  });

// ── ctx graph ────────────────────────────────────────────────────────────
program
  .command('graph')
  .description('Open D3 force graph visualization in browser')
  .option('--no-open', 'Start server without opening browser')
  .action(async (opts: { open: boolean }) => {
    const c = await chalk();
    const { db, VizServer } = await getComponents(process.cwd());

    const viz = new VizServer(db);
    const url = await viz.start();

    console.log(c.cyan(`\n  ⬡  ContextGraph Visualization`));
    console.log(c.dim(`  Running at ${c.cyan.bold(url)}`));
    console.log(c.dim('  Press Ctrl+C to stop\n'));

    if (opts.open !== false) {
      const { default: open } = await import('open');
      await open(url);
    }

    process.on('SIGINT', () => {
      viz.stop();
      process.exit(0);
    });

    // Keep alive
    await new Promise<void>(() => {});
  });

// ── ctx export ───────────────────────────────────────────────────────────
program
  .command('export <format> [outDir]')
  .description('Export graph (format: obsidian | graphify | json | mermaid)')
  .option('--type <type>', 'Mermaid type: flowchart|timeline|class', 'flowchart')
  .option('--html', 'Wrap Mermaid in HTML with live preview', false)
  .action(async (format: string, outDir?: string, opts?: { type: string; html: boolean }) => {
    const c = await chalk();
    const { db, ObsidianExporter, GraphifyExporter, MermaidExporter } = await getComponents(process.cwd());

    if (format === 'obsidian') {
      const dir = outDir ?? path.join(process.cwd(), 'contextgraph-obsidian');
      const exporter = new ObsidianExporter(db);
      const count = await exporter.export(dir);
      console.log(c.green(`\n  ✓ Exported ${count} nodes to Obsidian vault: ${dir}\n`));
    } else if (format === 'graphify') {
      const exporter = new GraphifyExporter(db);
      const outPath = await exporter.export(outDir);
      console.log(c.green(`\n  ✓ Exported Graphify JSON: ${outPath}\n`));
    } else if (format === 'json') {
      const exporter = new GraphifyExporter(db);
      const outPath = await exporter.exportRaw(outDir);
      console.log(c.green(`\n  ✓ Exported raw JSON: ${outPath}\n`));
    } else if (format === 'mermaid') {
      const exporter = new MermaidExporter(db);
      const type = (opts?.type ?? 'flowchart') as 'flowchart' | 'timeline' | 'class';
      const isHtml = !!opts?.html;

      const fileExt = isHtml ? '.html' : '.mmd';
      const defaultName = `graph-${type}${fileExt}`;
      const dest = outDir
        ? (outDir.endsWith(fileExt) || outDir.endsWith('.html') || outDir.endsWith('.mmd') ? outDir : path.join(outDir, defaultName))
        : path.join(process.cwd(), defaultName);

      if (isHtml) {
        await exporter.exportHTMLPreview(dest, type);
      } else {
        if (type === 'timeline') {
          await exporter.exportTimeline(dest);
        } else if (type === 'class') {
          await exporter.exportClassDiagram(dest);
        } else {
          await exporter.exportFlowchart({ outPath: dest, maxNodes: 50 });
        }
      }
      console.log(c.green(`\n  ✓ Exported Mermaid ${type} (${isHtml ? 'HTML' : 'raw'}): ${dest}\n`));
    } else {
      console.log(c.red(`\n  Unknown format: ${format}. Use: obsidian | graphify | json | mermaid\n`));
    }
  });

// ── ctx install ──────────────────────────────────────────────────────────
program
  .command('install <target>')
  .description('Install MCP config (target: cursor | vscode | claude-code)')
  .action(async (target: string) => {
    const c = await chalk();
    const fs = await import('fs/promises');
    const { existsSync } = await import('fs');

    // Find server path
    const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

    const config = cursorMcpConfig(serverPath);

    let configPath: string;
    if (target === 'cursor') {
      configPath = path.join(process.cwd(), '.cursor', 'mcp.json');
    } else if (target === 'vscode') {
      configPath = path.join(process.cwd(), '.vscode', 'mcp.json');
    } else if (target === 'claude-code') {
      configPath = path.join(process.env['HOME'] ?? process.cwd(), '.claude', 'mcp.json');
    } else {
      console.log(c.red(`\n  Unknown target: ${target}. Use: cursor | vscode | claude-code\n`));
      return;
    }

    mkdirSync(path.dirname(configPath), { recursive: true });

    // Merge with existing config if present
    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const raw = await fs.readFile(configPath, 'utf-8');
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {}
    }

    const configRecord = config as Record<string, unknown>;
    const existingMcp = (existing['mcpServers'] as Record<string, unknown>) ?? {};
    const newMcp = (configRecord['mcpServers'] as Record<string, unknown>) ?? {};

    const merged = {
      ...existing,
      mcpServers: {
        ...existingMcp,
        ...newMcp,
      },
    };

    await fs.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(c.green(`\n  ✓ Installed ContextGraph MCP in ${target}: ${configPath}\n`));
  });

// ── ctx stats ────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show graph statistics')
  .action(async () => {
    const c = await chalk();
    const { db } = await getComponents(process.cwd());
    const stats = db.getStats();
    const allNodes = db.getAllNodes();
    const byType: Record<string, number> = {};
    for (const n of allNodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

    console.log(c.cyan('\n  ⬡  ContextGraph Stats\n'));
    console.log(`  ${c.bold('Nodes:')} ${stats.nodes}`);
    console.log(`  ${c.bold('Active edges:')} ${stats.edges}`);
    console.log(`  ${c.bold('Archived edges:')} ${stats.archived}`);
    console.log(`  ${c.bold('Last decay:')} ${stats.lastDecay}`);
    console.log(`\n  ${c.bold('By type:')}`);
    for (const [type, count] of Object.entries(byType)) {
      console.log(`    ${type.padEnd(12)} ${count}`);
    }
    console.log();
  });

// ── ctx decay ────────────────────────────────────────────────────────────
program
  .command('decay')
  .description('Manually run weight decay pass (×0.95 per edge)')
  .action(async () => {
    const c = await chalk();
    const { db, DecayScheduler } = await getComponents(process.cwd());
    const scheduler = new DecayScheduler(db);
    const result = await scheduler.runDecay();
    await db.persist();
    console.log(c.green(`\n  ✓ Decay: ${result.decayed} edges decayed, ${result.archived} archived\n`));
  });

// ── ctx health ───────────────────────────────────────────────────────────
program
  .command('health')
  .description('Run a knowledge graph health check')
  .action(async () => {
    const c = await chalk();
    const { db, GraphAnalytics } = await getComponents(process.cwd());
    const analytics = new GraphAnalytics(db);
    const report = analytics.computeHealthReport();

    console.log(c.cyan.bold('\n  ⬡  ContextGraph Health Check\n'));

    // Color code health score
    let scoreColor = c.green;
    if (report.score < 50) scoreColor = c.red;
    else if (report.score < 85) scoreColor = c.yellow;

    console.log(`  ${c.bold('Health Score:')} ${scoreColor(report.score)}/100`);
    console.log(`  ${c.bold('Status:')}       ${report.summary}\n`);

    console.log(`  ${c.bold('Connections:')}`);
    console.log(`    Average edge weight:  ${report.avgWeight.toFixed(2)}`);
    console.log(`    Strong edges (>0.6):  ${report.strongEdges}`);
    console.log(`    Weak edges (<0.2):    ${report.weakEdges}`);
    console.log(`    Orphaned nodes:       ${report.orphanedNodes.length}`);

    if (report.orphanedNodes.length > 0) {
      console.log(c.yellow(`\n  ${c.bold('Orphaned Nodes (Disconnected):')}`));
      for (const id of report.orphanedNodes.slice(0, 10)) {
        console.log(`    - ${id}`);
      }
      if (report.orphanedNodes.length > 10) {
        console.log(`    ... and ${report.orphanedNodes.length - 10} more`);
      }
    }

    if (report.decayRisk.length > 0) {
      console.log(c.yellow(`\n  ${c.bold('Nodes at Decay Risk (Edges near 0.05 archive threshold):')}`));
      for (const id of report.decayRisk) {
        console.log(`    - ${id}`);
      }
    }

    console.log(c.cyan(`\n  ${c.bold('Most Connected Nodes (Highest PageRank):')}`));
    for (const node of report.mostConnected) {
      console.log(`    ${c.bold(node.pageRank.toFixed(4))}  ${c.dim(node.type.padEnd(8))}  ${node.label}`);
    }

    if (report.leastConnected.length > 0) {
      console.log(c.cyan(`\n  ${c.bold('Least Connected Active Nodes (Lowest PageRank):')}`));
      for (const node of report.leastConnected) {
        console.log(`    ${c.bold(node.pageRank.toFixed(6))}  ${c.dim(node.type.padEnd(8))}  ${node.label}`);
      }
    }
    console.log();
  });

// ── ctx timeline ─────────────────────────────────────────────────────────
program
  .command('timeline')
  .description('Show chronological coding session timeline')
  .action(async () => {
    const c = await chalk();
    const { db } = await getComponents(process.cwd());

    const nodes = db.getAllNodes();
    const sessions = nodes
      .filter((n) => n.type === 'session')
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));

    console.log(c.cyan.bold('\n  ⬡  ContextGraph Session Timeline\n'));

    if (sessions.length === 0) {
      console.log(c.yellow('  No sessions recorded yet. Run `ctx watch` to start tracking.\n'));
      return;
    }

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const dateStr = session.createdAt
        ? new Date(session.createdAt).toLocaleString()
        : 'Unknown Time';

      const bullet = i === sessions.length - 1 ? c.green('●') : c.blue('○');

      console.log(`  ${bullet} ${c.bold(session.label)}`);
      console.log(`    ${c.dim('ID:')}        ${session.id}`);
      console.log(`    ${c.dim('Started:')}   ${dateStr}`);
      console.log(`    ${c.dim('Accesses:')}  ${session.accessCount ?? 0}`);

      if (i < sessions.length - 1) {
        console.log('    |');
      }
    }
    console.log();
  });

// ── ctx agent ────────────────────────────────────────────────────────────
program
  .command('agent [question]')
  .description(
    'Talk to Shisya — the ContextGraph AI agent (interactive REPL or one-shot answer)'
  )
  .option('--backend <type>', 'Force backend: claude | ollama (auto-detect by default)')
  .option('--model <name>', 'Override model name (e.g. llama3, claude-haiku-4-5)')
  .option('--no-memory', 'Disable graph logging for this session')
  .option('--ollama-url <url>', 'Ollama base URL (default: http://localhost:11434)')
  .action(
    async (
      question: string | undefined,
      opts: {
        backend?: string;
        model?: string;
        memory: boolean;
        ollamaUrl?: string;
      }
    ) => {
      const { GraphDB } = await import('../graph/kuzu.js');
      const { ContextGraphAgent } = await import('../agent/agent.js');

      const projectRoot = path.resolve(process.cwd());
      const dataDir =
        process.env['CONTEXTGRAPH_DATA_DIR'] ??
        path.join(projectRoot, '.contextgraph');
      mkdirSync(dataDir, { recursive: true });

      const db = new GraphDB(dataDir);
      await db.init();

      const agent = new ContextGraphAgent({
        db,
        projectRoot,
        backend: opts.backend as 'claude' | 'ollama' | undefined,
        model: opts.model,
        noMemory: !opts.memory,
        ollamaUrl: opts.ollamaUrl,
      });

      // Init agent (detect backend)
      let backendInfo: { backendType: 'claude' | 'ollama'; model: string };
      try {
        const info = await agent.init();
        backendInfo = info;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\n\x1b[31m  ✗ ${message}\x1b[0m\n`);
        process.exit(1);
      }

      // One-shot mode: question provided as argument
      if (question) {
        const spinner = setInterval(() => {
          process.stdout.write('\r\x1b[36m⠋\x1b[0m \x1b[2mThinking…\x1b[0m');
        }, 80);

        try {
          const response = await agent.turn(question);
          clearInterval(spinner);
          process.stdout.write('\r\x1b[K');

          console.log();
          console.log(
            `\x1b[2m[${backendInfo.backendType} · ${backendInfo.model}]\x1b[0m`
          );
          console.log();
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

      // Interactive REPL mode
      const { startRepl } = await import('../agent/repl.js');
      await startRepl(agent, db);
    }
  );

program.parse(process.argv);
