// src/watchers/files.ts
// File watcher: chokidar + tree-sitter AST extraction
// Watches project directory, upserts file/symbol nodes and import edges

import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import type { GraphDB } from '../graph/kuzu.js';
import type { GraphNode, GraphEdge } from '../graph/schema.js';
import { WEIGHT_INITIAL } from '../graph/schema.js';

const DEBOUNCE_MS = 500;

interface ParsedSymbol {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'export';
  line: number;
}

interface ParsedFile {
  filePath: string;
  language: string;
  symbols: ParsedSymbol[];
  imports: string[];
}

// ─── Language Detection ────────────────────────────────────────────────────
function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.sol': 'solidity',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.md': 'markdown',
  };
  return map[ext] ?? null;
}

// ─── Simple Regex-based AST extraction (no native modules required) ────────
function extractSymbolsAndImports(content: string, language: string): { symbols: ParsedSymbol[]; imports: string[] } {
  const symbols: ParsedSymbol[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');

  if (language === 'typescript' || language === 'javascript') {
    lines.forEach((line, i) => {
      const lineNum = i + 1;

      // Import detection
      const importMatch = line.match(/^import\s+.*?\s+from\s+['"](.+?)['"]/);
      if (importMatch?.[1]) imports.push(importMatch[1]);

      const requireMatch = line.match(/require\s*\(\s*['"](.+?)['"]\s*\)/);
      if (requireMatch?.[1]) imports.push(requireMatch[1]);

      // Function declarations
      const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (funcMatch?.[1]) symbols.push({ name: funcMatch[1], kind: 'function', line: lineNum });

      // Arrow functions assigned to const
      const arrowMatch = line.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/);
      if (arrowMatch?.[1]) symbols.push({ name: arrowMatch[1], kind: 'function', line: lineNum });

      // Class declarations
      const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch?.[1]) symbols.push({ name: classMatch[1], kind: 'class', line: lineNum });

      // Interface / type alias (treat as symbol)
      const interfaceMatch = line.match(/^(?:export\s+)?(?:interface|type)\s+(\w+)/);
      if (interfaceMatch?.[1]) symbols.push({ name: interfaceMatch[1], kind: 'variable', line: lineNum });

      // Export const/let/var
      const exportVarMatch = line.match(/^export\s+(?:const|let|var)\s+(\w+)/);
      if (exportVarMatch?.[1] && !arrowMatch) symbols.push({ name: exportVarMatch[1], kind: 'export', line: lineNum });
    });
  } else if (language === 'python') {
    lines.forEach((line, i) => {
      const lineNum = i + 1;
      const importMatch = line.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/);
      if (importMatch) {
        const mod = importMatch[1] ?? importMatch[2]?.split(',')[0]?.trim();
        if (mod) imports.push(mod);
      }
      const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/);
      if (funcMatch?.[1]) symbols.push({ name: funcMatch[1], kind: 'function', line: lineNum });

      const classMatch = line.match(/^class\s+(\w+)/);
      if (classMatch?.[1]) symbols.push({ name: classMatch[1], kind: 'class', line: lineNum });
    });
  } else if (language === 'solidity') {
    lines.forEach((line, i) => {
      const lineNum = i + 1;
      const importMatch = line.match(/^import\s+["'](.+?)["']/);
      if (importMatch?.[1]) imports.push(importMatch[1]);

      const contractMatch = line.match(/^(?:abstract\s+)?contract\s+(\w+)/);
      if (contractMatch?.[1]) symbols.push({ name: contractMatch[1], kind: 'class', line: lineNum });

      const funcMatch = line.match(/^\s*function\s+(\w+)/);
      if (funcMatch?.[1]) symbols.push({ name: funcMatch[1], kind: 'function', line: lineNum });

      const eventMatch = line.match(/^\s*event\s+(\w+)/);
      if (eventMatch?.[1]) symbols.push({ name: eventMatch[1], kind: 'variable', line: lineNum });
    });
  }

  return { symbols, imports };
}

// ─── Convert file path to node ID ─────────────────────────────────────────
function filePathToNodeId(filePath: string, rootDir: string): string {
  const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
  return `file:${rel.replace(/[^a-z0-9_\-/.]/gi, '_').toLowerCase()}`;
}

function symbolToNodeId(filePath: string, symbolName: string, rootDir: string): string {
  const fileId = filePathToNodeId(filePath, rootDir).replace('file:', '');
  return `sym:${fileId}::${symbolName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
}

// ─── File Watcher ─────────────────────────────────────────────────────────
export class FileWatcher {
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private db: GraphDB;
  private rootDir: string;
  private debounceMap = new Map<string, NodeJS.Timeout>();
  private ignoredDirs = ['node_modules', 'dist', '.git', '.contextgraph', '__pycache__', '.next', 'build'];

  constructor(db: GraphDB, rootDir: string) {
    this.db = db;
    this.rootDir = rootDir;
  }

  start(): void {
    const ignoredPatterns = this.ignoredDirs.map((d) => `**/${d}/**`);

    this.watcher = chokidar.watch(this.rootDir, {
      ignored: [/(^|[/\\])\../, ...ignoredPatterns],
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher
      .on('add', (filePath) => this.scheduleProcess(filePath))
      .on('change', (filePath) => this.scheduleProcess(filePath))
      .on('unlink', (filePath) => this.handleDelete(filePath))
      .on('error', (err) => console.error('[FileWatcher] Error:', err));

    console.error(`[FileWatcher] Watching ${this.rootDir}`);
  }

  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleProcess(filePath: string): void {
    const existing = this.debounceMap.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceMap.delete(filePath);
      void this.processFile(filePath);
    }, DEBOUNCE_MS);
    this.debounceMap.set(filePath, timer);
  }

  private async processFile(filePath: string): Promise<void> {
    const lang = detectLanguage(filePath);
    if (!lang) return; // Skip unsupported file types

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.length > 500_000) return; // Skip huge files

      const { symbols, imports } = extractSymbolsAndImports(content, lang);
      const fileNodeId = filePathToNodeId(filePath, this.rootDir);
      const relPath = path.relative(this.rootDir, filePath).replace(/\\/g, '/');

      // Upsert file node
      const fileNode: GraphNode = {
        id: fileNodeId,
        type: 'file',
        label: relPath,
        filePath,
        language: lang,
        content: content.slice(0, 2000), // Store first 2k chars for search
        metadata: { symbolCount: symbols.length, importCount: imports.length },
      };
      await this.db.upsertNode(fileNode);

      // Upsert symbol nodes + defines edges
      for (const sym of symbols.slice(0, 50)) { // Cap at 50 symbols per file
        const symNodeId = symbolToNodeId(filePath, sym.name, this.rootDir);
        const symNode: GraphNode = {
          id: symNodeId,
          type: 'symbol',
          label: sym.name,
          filePath,
          language: lang,
          line: sym.line,
          metadata: { kind: sym.kind },
        };
        await this.db.upsertNode(symNode);

        await this.db.upsertEdge({
          sourceId: fileNodeId,
          targetId: symNodeId,
          type: 'defines',
          weight: WEIGHT_INITIAL,
          accessCount: 1,
          archived: false,
        });
      }

      // Upsert import edges
      for (const imp of imports) {
        // Resolve relative imports
        let importedId: string;
        if (imp.startsWith('.')) {
          const resolved = path.resolve(path.dirname(filePath), imp);
          // Try common extensions
          for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.py', '.sol']) {
            const candidate = `${resolved}${ext}`;
            const candidateId = filePathToNodeId(candidate, this.rootDir);
            // We upsert even if target file doesn't exist yet — it will be linked when found
            importedId = candidateId;
            break;
          }
          importedId = filePathToNodeId(resolved + '.ts', this.rootDir);
        } else {
          // External module — create a concept node
          importedId = `pkg:${imp.replace(/[^a-z0-9_\-/.@]/gi, '_').toLowerCase()}`;
          const pkgNode: GraphNode = {
            id: importedId,
            type: 'concept',
            label: imp,
            metadata: { source: 'import' },
          };
          await this.db.upsertNode(pkgNode);
        }

        await this.db.upsertEdge({
          sourceId: fileNodeId,
          targetId: importedId,
          type: 'imports',
          weight: WEIGHT_INITIAL,
          accessCount: 1,
          archived: false,
        });
      }
    } catch (err) {
      console.error(`[FileWatcher] Failed to process ${filePath}:`, err);
    }
  }

  private handleDelete(filePath: string): void {
    const fileNodeId = filePathToNodeId(filePath, this.rootDir);
    console.error(`[FileWatcher] File deleted: ${fileNodeId}`);
    // We don't delete nodes — edges will decay naturally
  }
}
