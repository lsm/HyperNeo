/**
 * ReplyRoutingRegistry — tracks which session sent a message to each task
 * so that task-agent and node-agent replies via `send_message({ target: 'space-agent' })`
 * route back to the originating session instead of always going to `space:chat:${spaceId}`.
 *
 * The registry is keyed by `(taskId, agentName)` to handle per-node routing within
 * a task's workflow. Each entry stores the most recent `replyToSessionId` for that
 * combination, enabling the routing layer to look up where to send the reply.
 *
 * Entries expire after a configurable TTL (default 30 minutes) to prevent stale
 * routing after conversations end.
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

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

  /**
   * Build the composite key from taskId and optional agentName.
   * agentName is used for node-agent targets within a task's workflow.
   */
  private static key(taskId: string, agentName?: string | null): string {
    return agentName ? `${taskId}:${agentName}` : taskId;
  }

  /**
   * Register that a message sent to the given task/node should route
   * replies back to `replyToSessionId`.
   */
  set(taskId: string, replyToSessionId: string, agentName?: string | null): void {
    const key = ReplyRoutingRegistry.key(taskId, agentName);
    this.entries.set(key, { replyToSessionId, updatedAt: Date.now() });
    this.writeCount++;
    // Opportunistic purge: sweep expired entries every 100 writes to prevent
    // unbounded growth from entries that are never looked up again.
    if (this.writeCount % 100 === 0) {
      this.purgeExpired();
    }
  }

  /**
   * Look up the `replyToSessionId` for a given task/node combination.
   * Returns `null` when no routing entry exists (meaning "use default routing").
   * Expired entries are pruned on access.
   */
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

  /**
   * Remove all entries for a given task (e.g., on task completion).
   */
  deleteByTask(taskId: string): void {
    for (const key of this.entries.keys()) {
      if (key === taskId || key.startsWith(`${taskId}:`)) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Remove a specific entry.
   */
  delete(taskId: string, agentName?: string | null): void {
    const key = ReplyRoutingRegistry.key(taskId, agentName);
    this.entries.delete(key);
  }

  /** Expose current size for diagnostics / testing. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Remove all expired entries. Called opportunistically on write (every 100th
   * set) and can be called explicitly by the runtime (e.g. on task completion
   * sweeps). Keeps memory bounded in long-running daemons even when entries
   * are never looked up via `get`.
   */
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }
}
