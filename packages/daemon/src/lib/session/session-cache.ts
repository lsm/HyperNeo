import type { Session } from '@hyperneo/shared';
import type { AgentSession } from '../agent/agent-session.ts';

export type AgentSessionFactory = (session: Session) => AgentSession;

export type SessionLoader = (sessionId: string) => Session | null;

export class SessionCache {
  private sessions: Map<string, AgentSession> = new Map();

  private sessionLoadLocks = new Map<string, Promise<AgentSession | null>>();

  private removedWhileLoading = new Set<Promise<AgentSession | null>>();

  constructor(
    private createAgentSession: AgentSessionFactory,
    private loadFromDB: SessionLoader
  ) {}

  isLoading(sessionId: string): boolean {
    return this.sessionLoadLocks.has(sessionId);
  }

  get(sessionId: string): AgentSession | null {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    const loadInProgress = this.sessionLoadLocks.get(sessionId);
    if (loadInProgress) {
      throw new Error(
        `Session ${sessionId} is being loaded. Use getAsync() for concurrent access.`
      );
    }

    const session = this.loadFromDB(sessionId);
    if (!session) return null;

    const agentSession = this.createAgentSession(session);
    this.sessions.set(sessionId, agentSession);

    return agentSession;
  }

  async getAsync(sessionId: string): Promise<AgentSession | null> {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    const loadInProgress = this.sessionLoadLocks.get(sessionId);
    if (loadInProgress) {
      return await loadInProgress;
    }

    const loadPromise = Promise.resolve().then(async (): Promise<AgentSession | null> => {
      try {
        const agentSession = await this.loadSessionAsync(sessionId);
        if (agentSession) {
          if (!this.sessions.has(sessionId) && !this.removedWhileLoading.has(loadPromise)) {
            this.sessions.set(sessionId, agentSession);
          } else {
            await agentSession.cleanup().catch(() => {});
          }
        }
        return this.sessions.get(sessionId) ?? null;
      } catch {
        return null;
      } finally {
        this.removedWhileLoading.delete(loadPromise);
        if (this.sessionLoadLocks.get(sessionId) === loadPromise)
          this.sessionLoadLocks.delete(sessionId);
      }
    });
    this.sessionLoadLocks.set(sessionId, loadPromise);

    return await loadPromise;
  }

  private async loadSessionAsync(sessionId: string): Promise<AgentSession | null> {
    const session = this.loadFromDB(sessionId);
    if (!session) return null;

    return this.createAgentSession(session);
  }

  set(sessionId: string, agentSession: AgentSession): void {
    this.sessions.set(sessionId, agentSession);
    this.sessionLoadLocks.delete(sessionId);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    const loading = this.sessionLoadLocks.get(sessionId);
    if (loading) {
      this.removedWhileLoading.add(loading);
    }
    this.sessionLoadLocks.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getActiveCount(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }

  getAll(): Map<string, AgentSession> {
    return this.sessions;
  }

  *entries(): IterableIterator<[string, AgentSession]> {
    yield* this.sessions.entries();
  }
}
