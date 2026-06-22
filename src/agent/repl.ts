// src/agent/repl.ts
// Shisya terminal REPL — Copilot CLI-style terminal UI
// Big ASCII art title, status dots, styled messages, boxed input

import readline from 'readline';
import type { ContextGraphAgent } from './agent.js';
import type { BackendType } from './backends/index.js';

// ─── ANSI codes ───────────────────────────────────────────────────────────────

const R = '\x1b[0m';   // reset
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const CYAN  = '\x1b[36m';
const BCYAN = '\x1b[96m'; // bright cyan
const GREEN = '\x1b[32m';
const BGREEN= '\x1b[92m';
const YELLOW= '\x1b[33m';
const MAGENTA='\x1b[35m';
const BMAGENTA='\x1b[95m';
const RED   = '\x1b[31m';
const WHITE = '\x1b[97m';
const GRAY  = '\x1b[90m';

const col = (code: string, s: string) => `${code}${s}${R}`;
const bold = (s: string) => `${BOLD}${s}${R}`;
const dim  = (s: string) => `${DIM}${s}${R}`;

// ─── Terminal width ───────────────────────────────────────────────────────────

function ttyWidth(): number {
  return process.stdout.columns ?? 80;
}

// ─── Box drawing ──────────────────────────────────────────────────────────────

function box(lines: string[], opts?: { color?: string; width?: number }): string[] {
  const w = opts?.width ?? Math.min(ttyWidth() - 2, 78);
  const cc = opts?.color ?? CYAN;
  const hr = '─'.repeat(w - 2);
  const pad = (s: string) => {
    // strip ANSI for length calculation
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
    const extra = w - 2 - stripped.length;
    return s + ' '.repeat(Math.max(0, extra));
  };
  return [
    `${cc}╭${hr}╮${R}`,
    ...lines.map((l) => `${cc}│${R} ${pad(l)}${cc}│${R}`),
    `${cc}╰${hr}╯${R}`,
  ];
}

// ─── SHISYA ASCII art (ANSI Shadow font, 6 lines tall) ───────────────────────
//  S  H  I  S  Y  A

const SHISYA_ART = [
  '███████╗██╗  ██╗██╗███████╗██╗   ██╗ █████╗ ',
  '██╔════╝██║  ██║██║██╔════╝╚██╗ ██╔╝██╔══██╗',
  '███████╗███████║██║███████╗ ╚████╔╝ ███████║',
  '╚════██║██╔══██║██║╚════██║  ╚██╔╝  ██╔══██║',
  '███████║██║  ██║██║███████║   ██║   ██║  ██║',
  '╚══════╝╚═╝  ╚═╝╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝',
];

// ─── Print the startup banner ─────────────────────────────────────────────────

function printBanner(
  backendType: BackendType,
  model: string,
  nodeCount: number,
  edgeCount: number,
  projectRoot: string,
): void {
  const w = Math.min(ttyWidth() - 2, 78);
  const hrFull = '─'.repeat(w);
  const shortRoot = projectRoot.split(/[/\\]/).slice(-2).join('/');

  // ── header box ──────────────────────────────────────────────────────────────
  console.log();
  console.log(col(CYAN, `╭${hrFull}╮`));

  // "Welcome to" line
  const welcomeLine = '  Welcome to';
  const padW = w - welcomeLine.length;
  console.log(`${col(CYAN, '│')}${col(DIM, welcomeLine)}${' '.repeat(padW)}${col(CYAN, '│')}`);

  // blank line
  console.log(`${col(CYAN, '│')}${' '.repeat(w)}${col(CYAN, '│')}`);

  // ASCII art lines  — indented 4 spaces, colored bright cyan
  for (const artLine of SHISYA_ART) {
    const padded = '    ' + artLine;
    const stripped = padded.replace(/\x1b\[[0-9;]*m/g, '');
    const extra = w - stripped.length;
    console.log(
      `${col(CYAN, '│')} ${col(BCYAN + BOLD, padded.trimEnd())}${' '.repeat(Math.max(0, extra - 1))}${col(CYAN, '│')}`
    );
  }

  // subtitle
  const sub = '    Neural Codebase Agent — powered by ContextGraph';
  const subPad = w - sub.length;
  console.log(`${col(CYAN, '│')}${col(DIM, sub)}${' '.repeat(Math.max(0, subPad))}${col(CYAN, '│')}`);

  // blank
  console.log(`${col(CYAN, '│')}${' '.repeat(w)}${col(CYAN, '│')}`);

  // tagline
  const tag = '    Shisya knows your codebase. Type a question or /help.';
  const tagPad = w - tag.length;
  console.log(`${col(CYAN, '│')}${col(DIM, tag)}${' '.repeat(Math.max(0, tagPad))}${col(CYAN, '│')}`);

  // blank
  console.log(`${col(CYAN, '│')}${' '.repeat(w)}${col(CYAN, '│')}`);
  console.log(col(CYAN, `╰${hrFull}╯`));

  // ── status dots ─────────────────────────────────────────────────────────────
  console.log();
  const backendLabel = backendType === 'claude'
    ? `${col(BCYAN, '☁')}  ${bold(col(BCYAN, 'Claude'))}  ${col(DIM, model)}`
    : `${col(GREEN, '🦙')} ${bold(col(GREEN, 'Ollama'))}  ${col(DIM, model)}`;

  console.log(`  ${col(BGREEN, '◉')}  Connected to ContextGraph — ${col(BCYAN, bold(String(nodeCount)))} nodes · ${col(CYAN, bold(String(edgeCount)))} edges`);
  console.log(`  ${col(BCYAN, '◉')}  Backend: ${backendLabel}`);

  // ── context line ────────────────────────────────────────────────────────────
  console.log();
  console.log(`  ${col(GRAY, '~/')}${col(CYAN + BOLD, shortRoot)} ${col(MAGENTA, '[✦ graph]')}`);
  console.log();
}

// ─── Print input box hint ──────────────────────────────────────────────────────

function printInputBox(): void {
  const w = Math.min(ttyWidth() - 2, 78);
  const inner = w - 4;
  const placeholder = 'Enter your question or / for commands';
  const padded = placeholder.padEnd(inner);
  console.log(col(GRAY, `  ╭${'─'.repeat(w - 2)}╮`));
  console.log(`  ${col(GRAY, '│')} ${col(DIM, padded)} ${col(GRAY, '│')}`);
  console.log(col(GRAY, `  ╰${'─'.repeat(w - 2)}╯`));
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(): NodeJS.Timeout {
  let i = 0;
  return setInterval(() => {
    process.stdout.write(
      `\r  ${col(BCYAN, SPINNER_FRAMES[i % SPINNER_FRAMES.length])} ${col(DIM, 'Shisya is thinking…')}  `
    );
    i++;
  }, 80);
}

function stopSpinner(t: NodeJS.Timeout): void {
  clearInterval(t);
  process.stdout.write('\r\x1b[K');
}

// ─── Print user message ───────────────────────────────────────────────────────

function printUser(text: string): void {
  console.log();
  console.log(`  ${col(YELLOW, '○')} ${col(DIM, 'you')}`);
  for (const line of text.split('\n')) {
    console.log(`  ${col(GRAY, '│')} ${col(GRAY, line)}`);
  }
}

// ─── Print agent response ─────────────────────────────────────────────────────

function printAgent(text: string): void {
  const w = Math.min(ttyWidth() - 6, 74);
  const hr = '─'.repeat(w);

  console.log();
  console.log(`  ${col(BCYAN, '◉')} ${col(CYAN + BOLD, 'Shisya')}  ${col(DIM, new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }))}`);
  console.log(`  ${col(CYAN, '╭' + hr + '╮')}`);

  const lines = text.split('\n');
  for (const raw of lines) {
    // markdown-lite rendering
    let line = raw;
    let prefix = '  ';

    // headers
    if (line.startsWith('### ')) {
      line = col(BOLD + WHITE, line.slice(4));
    } else if (line.startsWith('## ')) {
      line = col(BOLD + BCYAN, line.slice(3));
    } else if (line.startsWith('# ')) {
      line = col(BOLD + BCYAN, line.slice(2));
    }
    // bullet
    else if (/^[-•*]\s/.test(line)) {
      line = col(CYAN, '  ▸') + ' ' + line.slice(2);
      prefix = '';
    }
    // numbered
    else if (/^\d+\.\s/.test(line)) {
      line = col(DIM, line.slice(0, line.indexOf('.') + 1)) + col(WHITE, line.slice(line.indexOf('.') + 1));
    }

    // inline **bold**
    line = line.replace(/\*\*([^*]+)\*\*/g, `${BOLD + WHITE}$1${R}`);
    // inline `code`
    line = line.replace(/`([^`]+)`/g, `${col(BMAGENTA, '`')}${col(BMAGENTA, '$1')}${col(BMAGENTA, '`')}`);

    // word-wrap at w chars
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (stripped.length <= w - 2) {
      const extra = w - 2 - stripped.length;
      console.log(`  ${col(CYAN, '│')} ${prefix}${line}${' '.repeat(Math.max(0, extra))} ${col(CYAN, '│')}`);
    } else {
      // just print it, let terminal wrap
      console.log(`  ${col(CYAN, '│')} ${prefix}${line} ${col(CYAN, '│')}`);
    }
  }

  console.log(`  ${col(CYAN, '╰' + hr + '╯')}`);
  console.log();
}

// ─── Slash commands table ─────────────────────────────────────────────────────

function printHelp(): void {
  const cmds: [string, string][] = [
    ['/help',  'Show this help'],
    ['/clear', 'Clear conversation history'],
    ['/info',  'Show backend + graph stats'],
    ['/exit',  'Exit Shisya'],
  ];
  console.log();
  console.log(`  ${col(CYAN + BOLD, 'Commands:')}`);
  for (const [cmd, desc] of cmds) {
    console.log(`    ${col(YELLOW, cmd.padEnd(10))}  ${col(DIM, desc)}`);
  }
  console.log();
}

// ─── System message ───────────────────────────────────────────────────────────

function printSystem(text: string): void {
  console.log();
  console.log(`  ${col(DIM, '· ')}${col(GRAY, text)}`);
  console.log();
}

// ─── REPL entry point ────────────────────────────────────────────────────────

export async function startRepl(
  agent: ContextGraphAgent,
  db: import('../graph/kuzu.js').GraphDB,
): Promise<void> {
  const { type: backendType, model } = agent.getBackendInfo();
  const stats = db.getStats();
  const projectRoot = process.env['CONTEXTGRAPH_PROJECT_ROOT'] ?? process.cwd();

  // Print the full Copilot-style banner
  printBanner(backendType, model, stats.nodes, stats.edges, projectRoot);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Styled prompt: "○ you ›"
  const setPrompt = () => {
    rl.setPrompt(`  ${col(GREEN, '○')} ${col(DIM, 'you')} ${col(GREEN, '›')} `);
    rl.prompt();
  };

  setPrompt();

  rl.on('line', async (rawLine) => {
    const line = rawLine.trim();

    if (!line) {
      setPrompt();
      return;
    }

    // ── slash commands ───────────────────────────────────────────────────────
    if (line.startsWith('/')) {
      const cmd = line.toLowerCase().split(' ')[0];

      if (cmd === '/exit' || cmd === '/quit') {
        printSystem('Goodbye! Graph state saved.');
        rl.close();
        process.exit(0);
      }

      if (cmd === '/clear') {
        agent.clearHistory();
        // Clear visible terminal content
        process.stdout.write('\x1b[2J\x1b[H');
        printBanner(backendType, model, db.getStats().nodes, db.getStats().edges, projectRoot);
        printSystem('Conversation cleared.');
        setPrompt();
        return;
      }

      if (cmd === '/help') {
        printHelp();
        setPrompt();
        return;
      }

      if (cmd === '/info') {
        const s = db.getStats();
        const info = agent.getBackendInfo();
        console.log();
        console.log(`  ${col(DIM, 'Backend:')} ${info.type}  ${col(BCYAN, info.model)}`);
        console.log(`  ${col(DIM, 'Nodes:')}   ${col(BCYAN, String(s.nodes))} active`);
        console.log(`  ${col(DIM, 'Edges:')}   ${col(BCYAN, String(s.edges))} active  ${col(DIM, String(s.archived) + ' archived')}`);
        console.log(`  ${col(DIM, 'Decay:')}   ${col(DIM, s.lastDecay)}`);
        console.log();
        setPrompt();
        return;
      }

      console.log();
      console.log(`  ${col(YELLOW, `Unknown command: ${cmd}`)}  — type ${col(CYAN, '/help')}`);
      console.log();
      setPrompt();
      return;
    }

    // ── normal message ───────────────────────────────────────────────────────
    printUser(line);

    const spinner = startSpinner();
    try {
      const response = await agent.turn(line);
      stopSpinner(spinner);
      printAgent(response);
    } catch (err) {
      stopSpinner(spinner);
      const msg = err instanceof Error ? err.message : String(err);
      console.log();
      console.log(`  ${col(RED, '✗')} ${col(RED, msg)}`);
      console.log();
    }

    setPrompt();
  });

  rl.on('close', () => {
    printSystem('Session ended.');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log();
    printSystem('Ctrl+C — Goodbye!');
    process.exit(0);
  });
}
