import type { Session } from '@hyperneo/shared';
import type { AgentSession } from '../agent/agent-session.ts';

export type AgentSessionFactory = (session: Session) => AgentSession;

export type SessionLoader = (sessionId: string) => Session | null;

export class SessionCache {
  private sessions: Map<string, AgentSession> = new Map();

  private sessionLoadLocks = new Map<string, Promise<AgentSession | null>>();

  private removedWhileLoading = new Set<string>();

  constructor(
    private createAgentSession: AgentSessionFactory,
    private loadFromDB: SessionLoader
  ) {}

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

    const loadPromise = (async (): Promise<AgentSession | null> => {
      try {
        const agentSession = await this.loadSessionAsync(sessionId);
        if (agentSession) {
          if (!this.sessions.has(sessionId) && !this.removedWhileLoading.has(sessionId)) {
            this.sessions.set(sessionId, agentSession);
          } else {
            await agentSession.cleanup().catch(() => {});
          }
        }
        return this.sessions.get(sessionId) ?? null;
      } catch {
        return null;
      } finally {
        this.sessionLoadLocks.delete(sessionId);
        this.removedWhileLoading.delete(sessionId);
      }
    })();
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
    if (this.sessionLoadLocks.has(sessionId)) {
      this.removedWhileLoading.add(sessionId);
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
