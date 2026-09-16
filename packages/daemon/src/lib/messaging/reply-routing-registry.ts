const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface RoutingEntry {
  replyToSessionId: string;
  updatedAt: number;
}

export class ReplyRoutingRegistry {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, RoutingEntry>();
  private writeCount = 0;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private static key(taskId: string, agentName?: string | null): string {
    return agentName ? `${taskId}:${agentName}` : taskId;
  }

  set(taskId: string, replyToSessionId: string, agentName?: string | null): void {
    const key = ReplyRoutingRegistry.key(taskId, agentName);
    this.entries.set(key, { replyToSessionId, updatedAt: Date.now() });
    this.writeCount++;
    if (this.writeCount % 100 === 0) {
      this.purgeExpired();
    }
  }

  get(taskId: string, agentName?: string | null): string | null {
    const key = ReplyRoutingRegistry.key(taskId, agentName);
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (Date.now() - entry.updatedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.replyToSessionId;
  }

  deleteByTask(taskId: string): void {
    for (const key of this.entries.keys()) {
      if (key === taskId || key.startsWith(`${taskId}:`)) {
        this.entries.delete(key);
      }
    }
  }

  delete(taskId: string, agentName?: string | null): void {
    const key = ReplyRoutingRegistry.key(taskId, agentName);
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }
}
