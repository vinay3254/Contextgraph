// src/watchers/git.ts
// Git observer: watches for commits, strengthens co-edited edges between co-changed files

import { simpleGit } from 'simple-git';
import path from 'path';
import type { GraphDB } from '../graph/kuzu.js';

const POLL_INTERVAL_MS = 60_000; // Check every 60 seconds

export class GitObserver {
  private db: GraphDB;
  private rootDir: string;
  private lastSeenHash: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: GraphDB, rootDir: string) {
    this.db = db;
    this.rootDir = rootDir;
  }

  async start(): Promise<void> {
    try {
      const git = simpleGit(this.rootDir);
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        console.error('[GitObserver] Not a git repository, skipping git observation');
        return;
      }

      // Get initial HEAD hash
      try {
        const log = await git.log({ maxCount: 1 });
        this.lastSeenHash = log.latest?.hash ?? null;
      } catch {
        this.lastSeenHash = null;
      }

      // Process existing recent commits on startup
      await this.processNewCommits();

      // Poll for new commits
      this.timer = setInterval(() => void this.processNewCommits(), POLL_INTERVAL_MS);
      this.timer.unref();

      console.error('[GitObserver] Watching for git commits');
    } catch (err) {
      console.error('[GitObserver] Failed to start:', err);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async processNewCommits(): Promise<void> {
    try {
      const git = simpleGit(this.rootDir);

      const logOptions: Record<string, string | number> = { maxCount: 20 };
      if (this.lastSeenHash) {
        logOptions['from'] = this.lastSeenHash;
      }

      const log = await git.log(logOptions);
      if (!log.all.length) return;

      for (const commit of log.all) {
        if (commit.hash === this.lastSeenHash) continue;
        await this.processCommit(commit.hash);
      }

      this.lastSeenHash = log.latest?.hash ?? this.lastSeenHash;
    } catch (err) {
      // Git errors are non-fatal
      console.error('[GitObserver] Error polling commits:', err);
    }
  }

  private async processCommit(hash: string): Promise<void> {
    try {
      const git = simpleGit(this.rootDir);
      const diffSummary = await git.diffSummary([`${hash}^`, hash]);
      const changedFiles = diffSummary.files
        .map((f: { file: string }) => path.join(this.rootDir, f.file))
        .filter((f: string) => !f.includes('node_modules') && !f.includes('.git'));

      if (changedFiles.length < 2) return;

      // Create co_edited edges for all pairs of co-changed files
      for (let i = 0; i < changedFiles.length; i++) {
        for (let j = i + 1; j < changedFiles.length; j++) {
          const sourceId = `file:${path.relative(this.rootDir, changedFiles[i]).replace(/\\/g, '/').toLowerCase()}`;
          const targetId = `file:${path.relative(this.rootDir, changedFiles[j]).replace(/\\/g, '/').toLowerCase()}`;
          await this.db.strengthenCoCommit(sourceId, targetId);
        }
      }

      console.error(`[GitObserver] Processed commit ${hash.slice(0, 8)}: strengthened ${changedFiles.length * (changedFiles.length - 1) / 2} co-edit edges`);
    } catch {
      // Commit processing errors are non-fatal (e.g., initial commit with no parent)
    }
  }
}
