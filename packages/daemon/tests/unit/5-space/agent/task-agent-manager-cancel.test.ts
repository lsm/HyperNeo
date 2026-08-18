import { describe, test, expect } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';

function makeFakeSession(processingStatus: string = 'processing') {
  const calls: string[] = [];
  const session = {
    getProcessingState: () => ({ status: processingStatus }),
    handleInterrupt: async (): Promise<void> => {
      calls.push('handleInterrupt');
    },
    cleanup: async (): Promise<void> => {
      calls.push('cleanup');
    },
  };
  return { session: session as unknown as AgentSession, calls };
}

function makeSessionManagerStub(liveSession: AgentSession | null) {
  const unregistered: string[] = [];
  const sessionManager = {
    getCachedSession: (): AgentSession | null => liveSession,
    unregisterSession: async (id: string): Promise<void> => {
      unregistered.push(id);
    },
  };
  return { sessionManager, unregistered };
}

function makeManager(sessionManager: unknown): TaskAgentManager {
  return new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    sessionManager,
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
  } as unknown as TaskAgentManagerConfig);
}

describe('TaskAgentManager — cancelBySessionId SessionManager fallback', () => {
  test('index miss resolves via SessionManager and runs handleInterrupt before cleanup', async () => {
    const { session: liveSession, calls } = makeFakeSession();
    const { sessionManager } = makeSessionManagerStub(liveSession);
    const tam = makeManager(sessionManager);

    tam.cancelBySessionId('live-but-not-in-index');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['handleInterrupt', 'cleanup']);
  });

  test('index miss is a safe no-op when SessionManager has no live session either', () => {
    const { sessionManager } = makeSessionManagerStub(null);
    const tam = makeManager(sessionManager);

    expect(() => tam.cancelBySessionId('already-gone')).not.toThrow();
  });

  test('unregisters the session even on a cache miss, to invalidate in-flight loads', async () => {
    const { sessionManager, unregistered } = makeSessionManagerStub(null);
    const tam = makeManager(sessionManager);

    tam.cancelBySessionId('mid-load');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unregistered).toEqual(['mid-load']);
  });

  test('is idempotent: concurrent duplicate cancels tear the session down once', async () => {
    const { session: liveSession, calls } = makeFakeSession();
    const { sessionManager } = makeSessionManagerStub(liveSession);
    const tam = makeManager(sessionManager);

    tam.cancelBySessionId('shared-session');
    tam.cancelBySessionId('shared-session');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(['handleInterrupt', 'cleanup']);
  });

  test('evicts the session from the cache only after teardown succeeds', async () => {
    const { session: liveSession, calls } = makeFakeSession();
    const { sessionManager, unregistered } = makeSessionManagerStub(liveSession);
    const tam = makeManager(sessionManager);

    tam.cancelBySessionId('live-session');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(['handleInterrupt', 'cleanup']);
    expect(unregistered).toEqual(['live-session']);
  });

  test('does not evict when teardown fails, so the session stays retryable', async () => {
    const calls: string[] = [];
    const failingSession = {
      getProcessingState: () => ({ status: 'processing' }),
      handleInterrupt: async (): Promise<void> => {
        calls.push('handleInterrupt');
        throw new Error('interrupt boom');
      },
      cleanup: async (): Promise<void> => {
        calls.push('cleanup');
      },
    };
    const { sessionManager, unregistered } = makeSessionManagerStub(
      failingSession as unknown as AgentSession
    );
    const tam = makeManager(sessionManager);

    tam.cancelBySessionId('failing-session');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toContain('handleInterrupt');
    expect(unregistered).toEqual([]);
  });
});

describe('TaskAgentManager — getLiveSubSessionIdsForTasks', () => {
  function fakeSession(status: string): AgentSession {
    return { getProcessingState: () => ({ status }) } as unknown as AgentSession;
  }

  test('excludes idle sessions so a pause preserves them for reuse', () => {
    const tam = makeManager(makeSessionManagerStub(null).sessionManager);
    const map = new Map<string, AgentSession>([
      ['active-session', fakeSession('processing')],
      ['waiting-session', fakeSession('waiting_for_input')],
      ['idle-session', fakeSession('idle')],
    ]);
    (
      tam as unknown as {
        subSessions: Map<string, Map<string, AgentSession>>;
      }
    ).subSessions.set('task-1', map);

    expect(tam.getLiveSubSessionIdsForTasks(['task-1']).sort()).toEqual([
      'active-session',
      'waiting-session',
    ]);
  });

  test('includes interrupted sessions so an ordinary user interrupt is still torn down', () => {
    const tam = makeManager(makeSessionManagerStub(null).sessionManager);
    const map = new Map<string, AgentSession>([
      ['interrupted-session', fakeSession('interrupted')],
      ['idle-session', fakeSession('idle')],
    ]);
    (
      tam as unknown as {
        subSessions: Map<string, Map<string, AgentSession>>;
      }
    ).subSessions.set('task-1', map);

    expect(tam.getLiveSubSessionIdsForTasks(['task-1']).sort()).toEqual(['interrupted-session']);
  });

  test('returns nothing for tasks with no tracked sessions', () => {
    const tam = makeManager(makeSessionManagerStub(null).sessionManager);
    expect(tam.getLiveSubSessionIdsForTasks(['unknown-task'])).toEqual([]);
  });
});

describe('TaskAgentManager — resumeRateLimitedSubSession (banner-Cancel respawn)', () => {
  interface FakeRateLimitSession {
    retryNowReturns: boolean;
    bannerCancelled: boolean;
    calls: string[];
    resumeBus?: InternalEventBus<DaemonInternalEventMap>;
    resumeSessionId?: string;
  }

  function makeRateLimitSession(opts: FakeRateLimitSession): AgentSession {
    const calls = opts.calls;
    const session = {
      getProcessingState: () => ({ status: 'idle' }),
      retryNowAfterRateLimit: async () => opts.retryNowReturns,
      isRateLimitBannerCancelled: () => opts.bannerCancelled,
      handleInterrupt: async () => {
        calls.push('handleInterrupt');
        if (opts.resumeBus && opts.resumeSessionId) {
          opts.resumeBus.publish('session.rate_limit_resume', { sessionId: opts.resumeSessionId });
        }
      },
      cleanup: async () => {
        calls.push('cleanup');
      },
    };
    return session as unknown as AgentSession;
  }

  function makeNodeExecutionRepoStub(sessionId: string) {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const repo = {
      getByAgentSessionId: (id: string) =>
        id === sessionId
          ? {
              id: 'exec-1',
              workflowRunId: 'run-1',
              workflowNodeId: 'node-1',
              agentName: 'coder',
              agentId: 'a1',
              agentSessionId: sessionId,
              status: 'in_progress',
              result: null,
              data: null,
              createdAt: 0,
              startedAt: 100,
              completedAt: null,
              updatedAt: 0,
            }
          : null,
      update: (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return { id, ...patch } as unknown;
      },
    };
    return { repo, updates };
  }

  function makeManagerWithExecRepo(
    sessionManager: unknown,
    nodeExecutionRepo: unknown,
    taskRepo?: unknown,
    bus: InternalEventBus<DaemonInternalEventMap> = new InternalEventBus<DaemonInternalEventMap>()
  ) {
    return new TaskAgentManager({
      db: { getDatabase: () => new BunDatabase(':memory:') },
      sessionManager,
      nodeExecutionRepo,
      taskRepo,
      internalEventBus: bus,
    } as unknown as TaskAgentManagerConfig);
  }

  function makeTaskRepoStub(initial: {
    status?: string;
    restrictions?: Record<string, unknown> | null;
  }) {
    const taskUpdates: Array<Record<string, unknown>> = [];
    let row: { id: string; status: string; restrictions: Record<string, unknown> | null } = {
      id: 'task-1',
      status: initial.status ?? 'in_progress',
      restrictions: initial.restrictions ?? null,
    };
    const repo = {
      getTask: () => ({ ...row }),
      updateTask: (_id: string, patch: Record<string, unknown>) => {
        taskUpdates.push(patch);
        row = { ...row, ...patch } as typeof row;
        return row;
      },
    };
    return { repo, taskUpdates, getRow: () => row };
  }

  function seedSession(tam: TaskAgentManager, sessionId: string, session: AgentSession) {
    (tam as unknown as { agentSessionIndex: Map<string, AgentSession> }).agentSessionIndex.set(
      sessionId,
      session
    );
    const subSessions = (tam as unknown as { subSessions: Map<string, Map<string, AgentSession>> })
      .subSessions;
    const nodeMap = new Map<string, AgentSession>();
    nodeMap.set(sessionId, session);
    subSessions.set('task-1', nodeMap);
  }

  test('re-spawns the execution when a parked (banner-cancelled) session cannot retry', async () => {
    const sessionId = 'parked-session';
    const calls: string[] = [];
    const session = makeRateLimitSession({
      retryNowReturns: false,
      bannerCancelled: true,
      calls,
    });
    const { repo, updates } = makeNodeExecutionRepoStub(sessionId);
    const { sessionManager, unregistered } = makeSessionManagerStub(session);
    const tam = makeManagerWithExecRepo(sessionManager, repo);
    seedSession(tam, sessionId, session);

    const outcome = await tam.resumeRateLimitedSubSession(sessionId);

    expect(outcome).toBe('respawned');
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({
      status: 'pending',
      agentSessionId: null,
      startedAt: null,
      completedAt: null,
    });
    expect(calls).toEqual(['handleInterrupt', 'cleanup']);
    expect(unregistered).toContain(sessionId);
    const index = (tam as unknown as { agentSessionIndex: Map<string, AgentSession> })
      .agentSessionIndex;
    expect(index.has(sessionId)).toBe(false);
  });

  test('does NOT respawn while an auto-retry is in flight (banner-only gate, not the raw pause flag)', async () => {
    const sessionId = 'cooldown-firing-session';
    const calls: string[] = [];
    const session = makeRateLimitSession({
      retryNowReturns: false,
      bannerCancelled: false,
      calls,
    });
    const { repo, updates } = makeNodeExecutionRepoStub(sessionId);
    const tam = makeManagerWithExecRepo(makeSessionManagerStub(session).sessionManager, repo);
    seedSession(tam, sessionId, session);

    const outcome = await tam.resumeRateLimitedSubSession(sessionId);

    expect(outcome).toBe('noop');
    expect(updates).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('the resume event fired during respawn cleanup clears the limitedSessionsByTask entry', async () => {
    const sessionId = 'parked-session';
    const bus = new InternalEventBus<DaemonInternalEventMap>();
    const calls: string[] = [];
    const session = makeRateLimitSession({
      retryNowReturns: false,
      bannerCancelled: true,
      calls,
      resumeBus: bus,
      resumeSessionId: sessionId,
    });
    const { repo } = makeNodeExecutionRepoStub(sessionId);
    const { sessionManager } = makeSessionManagerStub(session);
    const task = makeTaskRepoStub({ status: 'rate_limited', restrictions: null });
    const tam = makeManagerWithExecRepo(sessionManager, repo, task.repo, bus);
    seedSession(tam, sessionId, session);
    const limited = (
      tam as unknown as {
        limitedSessionsByTask: Map<
          string,
          Map<string, { resetAt: number; kind: string; reason: string }>
        >;
      }
    ).limitedSessionsByTask;
    limited.set('task-1', new Map());
    limited
      .get('task-1')!
      .set(sessionId, { resetAt: 12345, kind: 'rate_limit', reason: 'backoff-ladder' });

    const outcome = await tam.resumeRateLimitedSubSession(sessionId);

    expect(outcome).toBe('respawned');
    expect(limited.has('task-1')).toBe(false);
  });

  test('returns "retried" (no respawn) when an armed cooldown can still fire', async () => {
    const sessionId = 'cooldown-session';
    const calls: string[] = [];
    const session = makeRateLimitSession({
      retryNowReturns: true,
      bannerCancelled: true,
      calls,
    });
    const { repo, updates } = makeNodeExecutionRepoStub(sessionId);
    const tam = makeManagerWithExecRepo(makeSessionManagerStub(session).sessionManager, repo);
    seedSession(tam, sessionId, session);

    const outcome = await tam.resumeRateLimitedSubSession(sessionId);

    expect(outcome).toBe('retried');
    expect(updates).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('returns "noop" for a session that was never rate-limited', async () => {
    const sessionId = 'plain-session';
    const calls: string[] = [];
    const session = makeRateLimitSession({
      retryNowReturns: false,
      bannerCancelled: false,
      calls,
    });
    const { repo, updates } = makeNodeExecutionRepoStub(sessionId);
    const tam = makeManagerWithExecRepo(makeSessionManagerStub(session).sessionManager, repo);
    seedSession(tam, sessionId, session);

    const outcome = await tam.resumeRateLimitedSubSession(sessionId);

    expect(outcome).toBe('noop');
    expect(updates).toHaveLength(0);
    expect(calls).toHaveLength(0);
    const index = (tam as unknown as { agentSessionIndex: Map<string, AgentSession> })
      .agentSessionIndex;
    expect(index.has(sessionId)).toBe(true);
  });

  test('returns "noop" when the session is no longer in memory', async () => {
    const { repo, updates } = makeNodeExecutionRepoStub('gone-session');
    const sessionManager = {
      getCachedSession: () => null,
      getSession: () => null,
      unregisterSession: async () => {},
    };
    const tam = makeManagerWithExecRepo(sessionManager, repo);

    const outcome = await tam.resumeRateLimitedSubSession('gone-session');

    expect(outcome).toBe('noop');
    expect(updates).toHaveLength(0);
  });
});
