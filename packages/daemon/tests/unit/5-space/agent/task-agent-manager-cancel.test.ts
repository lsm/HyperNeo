/**
 * TaskAgentManager — core cancellation path.
 *
 * Regression coverage for the reported bug: cancelling a running
 * workflow-backed task flipped the DB status to `cancelled` but never stopped
 * the in-flight coder. `cancelBySessionId` resolved the live session ONLY from
 * the in-memory `agentSessionIndex` and silently no-op'd on a miss. It now
 * falls through to the authoritative `SessionManager.getCachedSession` (the
 * non-throwing accessor) and runs the session through the same
 * `stopSessionPreserveDb` teardown (handleInterrupt + cleanup) as the index-hit
 * branch, with a synchronous `cancellingSessions` Set for idempotency.
 *
 * These tests construct a real TaskAgentManager (the constructor only touches
 * `db.getDatabase()` for an inert McpAuditLogRepository and subscribes to the
 * event bus) and drive `cancelBySessionId` / `getLiveSubSessionIdsForTasks`
 * against stubs so the actual fallback branch is exercised — not a mock of it.
 */

import { describe, test, expect } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';

/** A fake live session that records handleInterrupt + cleanup invocations. */
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

/** SessionManager stub: `getCachedSession` returns the provided live session (or null). */
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
    // The constructor only needs db.getDatabase() for an inert
    // McpAuditLogRepository; cancelBySessionId never queries the DB.
    db: { getDatabase: () => new BunDatabase(':memory:') },
    sessionManager,
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
  } as unknown as TaskAgentManagerConfig);
}

describe('TaskAgentManager — cancelBySessionId SessionManager fallback', () => {
  test('index miss resolves via SessionManager and runs handleInterrupt before cleanup', async () => {
    // A live SDK subprocess that is NOT in agentSessionIndex (activated via a
    // path that registered only with SessionManager, evicted from the index
    // while still running, or out-of-index after a daemon restart).
    const { session: liveSession, calls } = makeFakeSession();
    const { sessionManager } = makeSessionManagerStub(liveSession);
    const tam = makeManager(sessionManager);

    tam.cancelBySessionId('live-but-not-in-index');

    // cancelBySessionId is fire-and-forget; let the teardown promise settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Full interrupt semantics — handleInterrupt runs BEFORE cleanup so a
    // cancelled session does not retain persisted waiting_for_input state or an
    // orphaned question card. Cleanup then stops the subprocess.
    expect(calls).toEqual(['handleInterrupt', 'cleanup']);
  });

  test('index miss is a safe no-op when SessionManager has no live session either', () => {
    const { sessionManager } = makeSessionManagerStub(null);
    const tam = makeManager(sessionManager);

    // Genuinely not live (already cleaned up): preserve the original
    // "no-op if not found" contract — no teardown, no throw.
    expect(() => tam.cancelBySessionId('already-gone')).not.toThrow();
  });

  test('unregisters the session even on a cache miss, to invalidate in-flight loads', async () => {
    // An in-flight getSessionAsync load isn't visible to getCachedSession yet, so
    // cancel must still unregister — SessionCache.remove marks
    // removedWhileLoading and the pending load skips inserting on completion
    // (otherwise the coder could be loaded + restarted after cancellation).
    const { sessionManager, unregistered } = makeSessionManagerStub(null);
    const tam = makeManager(sessionManager);

    tam.cancelBySessionId('mid-load');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unregistered).toEqual(['mid-load']);
  });

  test('is idempotent: concurrent duplicate cancels tear the session down once', async () => {
    // cancelWorkflowRun can invoke the stop path once per task in the run, so
    // the same session can reach cancelBySessionId more than once. The
    // synchronous cancellingSessions Set makes a second concurrent call no-op.
    const { session: liveSession, calls } = makeFakeSession();
    const { sessionManager } = makeSessionManagerStub(liveSession);
    const tam = makeManager(sessionManager);

    tam.cancelBySessionId('shared-session');
    tam.cancelBySessionId('shared-session');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Exactly one handleInterrupt + cleanup — not two.
    expect(calls).toEqual(['handleInterrupt', 'cleanup']);
  });

  test('evicts the session from the cache only after teardown succeeds', async () => {
    // The cache/subSessions eviction is deferred until stopSessionPreserveDb
    // completes, so a failed teardown leaves the session reachable for a retry.
    const { session: liveSession, calls } = makeFakeSession();
    const { sessionManager, unregistered } = makeSessionManagerStub(liveSession);
    const tam = makeManager(sessionManager);

    tam.cancelBySessionId('live-session');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Teardown ran (handleInterrupt then cleanup)...
    expect(calls).toEqual(['handleInterrupt', 'cleanup']);
    // ...and the cache entry was evicted afterward.
    expect(unregistered).toEqual(['live-session']);
  });

  test('does not evict when teardown fails, so the session stays retryable', async () => {
    // stopSessionPreserveDb is called with strict:true, so a handleInterrupt/
    // cleanup failure rejects and the .then(evict) is skipped — the session
    // stays in the cache for a retry instead of being left streaming with no
    // manager-owned reference.
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
    // Not evicted — retained for a retry.
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

    // Only non-idle sessions are returned; the idle one stays available for a
    // later activation (matching the per-row cancel loop, which also skips idle
    // executions when a task is paused back to `open`).
    expect(tam.getLiveSubSessionIdsForTasks(['task-1']).sort()).toEqual([
      'active-session',
      'waiting-session',
    ]);
  });

  test('includes interrupted sessions so an ordinary user interrupt is still torn down', () => {
    // A session interrupted by an ordinary user interrupt is only transiently
    // `interrupted` (handleInterrupt returns it to idle WITHOUT cleanup), so
    // task cancellation must still reach it via the sweep — otherwise it stays
    // registered and is restartable. Dedup against an in-flight cancellation is
    // handled by cancellingSessions in cancelBySessionId.
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
  /**
   * Regression for the banner-Cancel recovery gap (codex P2): after the cooldown
   * banner's Cancel (cancelRateLimitRetry → cancel(false) + setIdle), the task
   * stayed rate_limited but retryNow couldn't fire and the in-memory session was
   * skipped by the cross-restart sweep — so the visible Resume couldn't restart
   * the consumed turn until a daemon restart. The fix: on Resume of a parked
   * session, re-spawn the execution (reset to pending + clear agentSessionId)
   * so the workflow tick spawns a replacement.
   */
  interface FakeRateLimitSession {
    retryNowReturns: boolean;
    bannerCancelled: boolean;
    calls: string[];
    /** When set, handleInterrupt publishes session.rate_limit_resume (mirroring
     *  real AgentSession, whose handleInterrupt cancels the watchdog → notifyResume). */
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
        // Mirror real AgentSession.handleInterrupt → watchdog.cancel(true) →
        // notifyResume → publish session.rate_limit_resume (synchronous).
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

  /**
   * Minimal taskRepo stub: holds an in-memory task row so the respawn cleanup
   * (getTask + updateTask + emitTaskUpdatedEvent) can read/mutate it. The
   * cleanup only touches `status` and `restrictions`.
   */
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

  /** Seed both the reverse index and the subSessions map so the manager sees it. */
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
      retryNowReturns: false, // banner-cancelled: timer dropped, episode cleared
      bannerCancelled: true, // …but the task stays rate-limited (pause never resumed)
      calls,
    });
    const { repo, updates } = makeNodeExecutionRepoStub(sessionId);
    const { sessionManager, unregistered } = makeSessionManagerStub(session);
    const tam = makeManagerWithExecRepo(sessionManager, repo);
    seedSession(tam, sessionId, session);

    const outcome = await tam.resumeRateLimitedSubSession(sessionId);

    expect(outcome).toBe('respawned');
    // The execution is reset to pending with the stale session binding cleared
    // so the workflow tick spawns a fresh replacement.
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({
      status: 'pending',
      agentSessionId: null,
      startedAt: null,
      completedAt: null,
    });
    // The orphaned idle session is stopped + evicted + unregistered.
    expect(calls).toEqual(['handleInterrupt', 'cleanup']);
    expect(unregistered).toContain(sessionId);
    const index = (tam as unknown as { agentSessionIndex: Map<string, AgentSession> })
      .agentSessionIndex;
    expect(index.has(sessionId)).toBe(false);
  });

  test('does NOT respawn while an auto-retry is in flight (banner-only gate, not the raw pause flag)', async () => {
    // During the window after the cooldown timer fires while fireCooldownRetry
    // is mid-await, retryNow() is false but the session is NOT banner-cancelled
    // — an auto-retry is actively starting. The respawn must NOT fire (it would
    // discard the in-flight retry). The banner-only gate makes this a no-op.
    const sessionId = 'cooldown-firing-session';
    const calls: string[] = [];
    const session = makeRateLimitSession({
      retryNowReturns: false, // timer already cleared (cooldown fired)
      bannerCancelled: false, // NOT banner-cancelled — auto-retry in flight
      calls,
    });
    const { repo, updates } = makeNodeExecutionRepoStub(sessionId);
    const tam = makeManagerWithExecRepo(makeSessionManagerStub(session).sessionManager, repo);
    seedSession(tam, sessionId, session);

    const outcome = await tam.resumeRateLimitedSubSession(sessionId);

    expect(outcome).toBe('noop');
    expect(updates).toHaveLength(0); // execution left untouched
    expect(calls).toHaveLength(0); // session not stopped
  });

  test('the resume event fired during respawn cleanup clears the limitedSessionsByTask entry', async () => {
    // Locks in the invariant the greptile comment worried about: the banner-
    // cancelled session's entry is removed by the session.rate_limit_resume event
    // published synchronously inside stopSessionPreserveDb → handleInterrupt
    // (mirroring real AgentSession, whose handleInterrupt cancels the watchdog →
    // notifyResume). So a replacement session's later pause/resume resolves
    // cleanly instead of finding a stale entry that traps the task rate-limited.
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
    // Wire the manager to the SAME bus the fake session publishes the resume
    // event onto, so the real resume listener runs during handleInterrupt.
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
    // handleInterrupt published the resume event synchronously, the listener
    // resolved the task (subSessions still held the session mid-stop) and
    // deleted the entry — so the map is gone and a replacement isn't trapped.
    expect(limited.has('task-1')).toBe(false);
  });

  test('returns "retried" (no respawn) when an armed cooldown can still fire', async () => {
    const sessionId = 'cooldown-session';
    const calls: string[] = [];
    const session = makeRateLimitSession({
      retryNowReturns: true, // armed cooldown / startup-exhausted → retryNow fires
      bannerCancelled: true,
      calls,
    });
    const { repo, updates } = makeNodeExecutionRepoStub(sessionId);
    const tam = makeManagerWithExecRepo(makeSessionManagerStub(session).sessionManager, repo);
    seedSession(tam, sessionId, session);

    const outcome = await tam.resumeRateLimitedSubSession(sessionId);

    expect(outcome).toBe('retried');
    expect(updates).toHaveLength(0); // execution left untouched
    expect(calls).toHaveLength(0); // session not stopped
  });

  test('returns "noop" for a session that was never rate-limited', async () => {
    const sessionId = 'plain-session';
    const calls: string[] = [];
    const session = makeRateLimitSession({
      retryNowReturns: false,
      bannerCancelled: false, // not parked → genuine no-op
      calls,
    });
    const { repo, updates } = makeNodeExecutionRepoStub(sessionId);
    const tam = makeManagerWithExecRepo(makeSessionManagerStub(session).sessionManager, repo);
    seedSession(tam, sessionId, session);

    const outcome = await tam.resumeRateLimitedSubSession(sessionId);

    expect(outcome).toBe('noop');
    expect(updates).toHaveLength(0);
    expect(calls).toHaveLength(0);
    // Session is left intact (not evicted).
    const index = (tam as unknown as { agentSessionIndex: Map<string, AgentSession> })
      .agentSessionIndex;
    expect(index.has(sessionId)).toBe(true);
  });

  test('returns "noop" when the session is no longer in memory', async () => {
    const { repo, updates } = makeNodeExecutionRepoStub('gone-session');
    // getAgentSessionById falls through to SessionManager.getSession() when the
    // reverse index misses, so the stub must expose it.
    const sessionManager = {
      getCachedSession: () => null,
      getSession: () => null,
      unregisterSession: async () => {},
    };
    const tam = makeManagerWithExecRepo(sessionManager, repo);
    // Nothing seeded — getAgentSessionById returns undefined.

    const outcome = await tam.resumeRateLimitedSubSession('gone-session');

    expect(outcome).toBe('noop');
    expect(updates).toHaveLength(0);
  });
});
