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
