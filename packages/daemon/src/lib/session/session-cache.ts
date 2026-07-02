/**
 * Session Cache Module
 *
 * In-memory session caching with lazy loading and race condition prevention:
 * - Map-based storage of AgentSession instances
 * - Lazy loading from database with locking to prevent duplicate SDK connections
 * - Cache invalidation on session deletion
 */

import type { Session } from '@hyperneo/shared';
import type { AgentSession } from '../agent/agent-session';

/**
 * Factory function type for creating AgentSession instances
 */
export type AgentSessionFactory = (session: Session) => AgentSession;

/**
 * Function type for loading session data from database
 */
export type SessionLoader = (sessionId: string) => Session | null;

export class SessionCache {
  private sessions: Map<string, AgentSession> = new Map();

  // FIX: Session lazy-loading race condition
  // Prevents multiple simultaneous loads of the same session
  // which would create duplicate Claude API connections
  private sessionLoadLocks = new Map<string, Promise<AgentSession | null>>();

  // FIX: remove() race condition
  // Tracks sessions that were explicitly removed while a load was in flight.
  // Without this, the in-flight load would re-insert the session into `sessions`
  // after remove() cleared it (the guard at getAsync line 99 only blocks set()
  // races, not remove() races).
  private removedWhileLoading = new Set<string>();

  constructor(
    private createAgentSession: AgentSessionFactory,
    private loadFromDB: SessionLoader
  ) {}

  /**
   * Get session synchronously (with lazy-loading race condition fix)
   *
   * FIX: Prevents multiple simultaneous loads of the same session
   * which would create duplicate Claude API connections
   *
   * @throws Error if session is currently being loaded - use getAsync() instead
   */
  get(sessionId: string): AgentSession | null {
    // Check in-memory first
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    // Check if load already in progress
    const loadInProgress = this.sessionLoadLocks.get(sessionId);
    if (loadInProgress) {
      // Wait for the load to complete (this is sync, so we throw an error)
      // Callers should use getAsync() for concurrent access
      throw new Error(
        `Session ${sessionId} is being loaded. Use getAsync() for concurrent access.`
      );
    }

    // Load synchronously (for backward compatibility)
    const session = this.loadFromDB(sessionId);
    if (!session) return null;

    // Create agent session
    const agentSession = this.createAgentSession(session);
    this.sessions.set(sessionId, agentSession);

    return agentSession;
  }

  /**
   * Get session asynchronously (preferred for concurrent access)
   *
   * FIX: Handles concurrent requests properly with locking
   */
  async getAsync(sessionId: string): Promise<AgentSession | null> {
    // Check in-memory first
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    // Check if load already in progress
    const loadInProgress = this.sessionLoadLocks.get(sessionId);
    if (loadInProgress) {
      return await loadInProgress; // Wait for existing load
    }

    // Start new load with lock
    const loadPromise = this.loadSessionAsync(sessionId);
    this.sessionLoadLocks.set(sessionId, loadPromise);

    try {
      const agentSession = await loadPromise;
      if (agentSession) {
        // Guard 1 (set race): if set() was called while we were loading (e.g. via
        // registerSession), prefer the registered live instance (which has MCP tools
        // attached) over the bare DB-loaded duplicate. Without this check, the load
        // would overwrite the registered session with a duplicate that creates competing
        // event subscriptions.
        //
        // Guard 2 (remove race): if remove() was called while we were loading, skip
        // re-insertion — the caller explicitly evicted this session and we must not
        // silently resurrect it.
        if (!this.sessions.has(sessionId) && !this.removedWhileLoading.has(sessionId)) {
          this.sessions.set(sessionId, agentSession);
        }
      }
      return this.sessions.get(sessionId) ?? null;
    } catch {
      // Failed to load session - return null for caller to handle
      return null;
    } finally {
      this.sessionLoadLocks.delete(sessionId);
      this.removedWhileLoading.delete(sessionId);
    }
  }

  /**
   * Load session from database (private helper)
   */
  private async loadSessionAsync(sessionId: string): Promise<AgentSession | null> {
    const session = this.loadFromDB(sessionId);
    if (!session) return null;

    // Create agent session
    return this.createAgentSession(session);
  }

  /**
   * Set a session in the cache.
   *
   * Also clears any in-flight load lock for this session ID so that new
   * getAsync() callers immediately see the registered instance rather than
   * waiting for a concurrent DB load that would create a competing duplicate.
   * Existing callers already awaiting the lock are handled by the guard in
   * getAsync() which prefers the registered instance on completion.
   */
  set(sessionId: string, agentSession: AgentSession): void {
    this.sessions.set(sessionId, agentSession);
    // Cancel any pending load so new getAsync callers short-circuit to the in-memory check
    this.sessionLoadLocks.delete(sessionId);
  }

  /**
   * Remove a session from the cache.
   *
   * - Clears `sessions` so subsequent synchronous `get()` calls see no entry.
   * - Clears `sessionLoadLocks` so NEW `getAsync()` callers are not blocked on
   *   a stale in-flight load (they will start a fresh load instead).
   * - Marks `removedWhileLoading` so the ORIGINAL in-flight `getAsync()` caller
   *   (already past the lock check) skips re-inserting the stale session when
   *   its load completes.
   */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    // If a load is in flight, mark the session so the load cannot re-insert it.
    if (this.sessionLoadLocks.has(sessionId)) {
      this.removedWhileLoading.add(sessionId);
    }
    this.sessionLoadLocks.delete(sessionId);
  }

  /**
   * Check if a session exists in the cache
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get the count of active sessions in cache
   */
  getActiveCount(): number {
    return this.sessions.size;
  }

  /**
   * Clear all sessions from cache
   */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Get all sessions in the cache
   */
  getAll(): Map<string, AgentSession> {
    return this.sessions;
  }

  /**
   * Get all sessions as an iterator for cleanup operations
   */
  *entries(): IterableIterator<[string, AgentSession]> {
    yield* this.sessions.entries();
  }
}
