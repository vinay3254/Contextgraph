// src/graph/decay.ts
// Hebbian weight decay scheduler — runs every 24h, ×0.95 per cycle

import { DECAY_INTERVAL_MS } from './schema.js';
import type { GraphDB } from './kuzu.js';

export class DecayScheduler {
  private timer: NodeJS.Timeout | null = null;
  private db: GraphDB;

  constructor(db: GraphDB) {
    this.db = db;
  }

  /** Run decay immediately, then schedule recurring 24h decay */
  async start(): Promise<void> {
    await this.runDecay();
    this.timer = setInterval(() => void this.runDecay(), DECAY_INTERVAL_MS);
    // Allow process to exit even if timer is active
    this.timer.unref();
  }

  async runDecay(): Promise<{ decayed: number; archived: number }> {
    const result = await this.db.decayAllEdges();
    console.error(
      `[DecayScheduler] Decay complete — ${result.decayed} edges decayed, ${result.archived} archived`
    );
    return result;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
