import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { VerifiedSessionStop } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';

interface FakeSessionCalls {
  interrupts: number;
  cleanups: number;
  terminations: number;
  statusQueries: number;
  terminateOptions: Array<{ forceDelayMs?: number } | undefined>;
}

interface FakeSessionController {
  calls: FakeSessionCalls;
  setStatus(status: string): void;
  clearPids(): void;
  session: AgentSession;
}

interface FakeSessionOptions {
  statusSequence?: string[];
  interruptErrors?: unknown[];
  interruptGate?: Promise<void>;
  livePids?: number[];
  onTerminate?: (controller: FakeSessionController) => void;
}

function makeFakeSession(options: FakeSessionOptions = {}): FakeSessionController {
  const statusSequence = options.statusSequence ?? ['processing', 'idle'];
  let statusIndex = 0;
  let livePids = [...(options.livePids ?? [])];
  const calls: FakeSessionCalls = {
    interrupts: 0,
    cleanups: 0,
    terminations: 0,
    statusQueries: 0,
    terminateOptions: [],
  };
  const controller: FakeSessionController = {
    calls,
    setStatus(status: string) {
      statusSequence[statusIndex] = status;
    },
    clearPids() {
      livePids = [];
    },
    session: null as unknown as AgentSession,
  };
  let interruptCalls = 0;
  controller.session = {
    processExitedPromise: null,
    handleInterrupt: async () => {
      if (options.interruptGate) await options.interruptGate;
      interruptCalls++;
      calls.interrupts++;
      const err = options.interruptErrors?.[interruptCalls - 1];
      if (err !== undefined) throw err;
      if (statusIndex < statusSequence.length - 1) {
        statusIndex++;
      }
    },
    cleanup: async () => {
      calls.cleanups++;
    },
    getProcessingState: () => {
      calls.statusQueries++;
      return { status: statusSequence[statusIndex] };
    },
    isInterruptInProgress: () => false,
    getTrackedAgentRootPidsSplit: () => ({ live: [...livePids], exited: [] }),
    terminateTrackedAgentProcesses: (opts?: { forceDelayMs?: number }) => {
      calls.terminations++;
      calls.terminateOptions.push(opts);
      options.onTerminate?.(controller);
    },
  } as unknown as AgentSession;
  return controller;
}

function makeSessionManager() {
  const cached = new Map<string, AgentSession>();
  const unregisterCalls: string[] = [];
  return {
    cached,
    unregisterCalls,
    getCachedSession: (sessionId: string) => cached.get(sessionId) ?? null,
    unregisterSession: async (sessionId: string) => {
      unregisterCalls.push(sessionId);
      cached.delete(sessionId);
    },
  };
}

function makeManager(sessionManager: ReturnType<typeof makeSessionManager>): TaskAgentManager {
  const db = new BunDatabase(':memory:');
  return new TaskAgentManager({
    db: { getDatabase: () => db },
    internalEventBus: { subscribe: () => () => {} },
    sessionManager,
  } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
}

function registerSession(
  manager: TaskAgentManager,
  taskId: string,
  sessionId: string,
  session: AgentSession
): void {
  const internals = internalsOf(manager);
  let nodeMap = internals.subSessions.get(taskId);
  if (!nodeMap) {
    nodeMap = new Map();
    internals.subSessions.set(taskId, nodeMap);
  }
  nodeMap.set(sessionId, session);
  internals.agentSessionIndex.set(sessionId, session);
}

function internalsOf(manager: TaskAgentManager) {
  return manager as unknown as {
    subSessions: Map<string, Map<string, AgentSession>>;
    agentSessionIndex: Map<string, AgentSession>;
  };
}

describe('TaskAgentManager.stopSessionsVerified', () => {
  test('returns an empty result list for empty input', async () => {
    const manager = makeManager(makeSessionManager());
    const results = await manager.stopSessionsVerified([]);
    expect(results).toEqual([]);
  });

  test('awaits the interrupt before reporting the session stopped', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    let releaseInterrupt: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const fake = makeFakeSession({ statusSequence: ['processing', 'idle'], interruptGate: gate });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    let settled = false;
    const promise = manager.stopSessionsVerified(['sess-1']).then((results) => {
      settled = true;
      return results;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseInterrupt();
    const results = await promise;
    expect(settled).toBe(true);
    expect(results).toEqual([{ sessionId: 'sess-1', stopped: true }]);
  });

  test('happy path: interrupts once, verifies down, detaches, and unregisters', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing', 'idle'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.interrupts).toBe(1);
    expect(fake.calls.cleanups).toBeGreaterThanOrEqual(1);
    expect(fake.calls.terminations).toBe(0);
    expect(fake.calls.statusQueries).toBeGreaterThanOrEqual(1);
    expect(results).toEqual([{ sessionId: 'sess-1', stopped: true }]);

    const internals = internalsOf(manager);
    expect(internals.agentSessionIndex.has('sess-1')).toBe(false);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(false);
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
  });

  test('retries the interrupt once when the first attempt fails to land', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing', 'processing', 'idle'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.interrupts).toBe(2);
    expect(fake.calls.terminations).toBe(0);
    expect(results).toEqual([
      {
        sessionId: 'sess-1',
        stopped: true,
        detail: 'first interrupt did not land; stopped on retry',
      },
    ]);
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
  });

  test('surfaces a strict stop error and recovers when the retry lands', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      interruptErrors: [new Error('boom')],
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.interrupts).toBe(2);
    expect(results[0]?.stopped).toBe(true);
    expect(results[0]?.detail).toContain('interrupt failed: ');
    expect(results[0]?.detail).toContain('boom');
    expect(results[0]?.detail).toContain('stopped on retry');
  });

  test('escalates to tracked process termination and reports the leak when still alive', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.interrupts).toBe(2);
    expect(fake.calls.terminations).toBe(1);
    expect(fake.calls.terminateOptions[0]?.forceDelayMs).toBe(2000);
    expect(results[0]?.stopped).toBe(false);
    expect(results[0]?.detail).toContain('escalated after verification failure');
    expect(results[0]?.detail).toContain("still alive: processing state 'processing'");

    const internals = internalsOf(manager);
    expect(internals.agentSessionIndex.has('sess-1')).toBe(false);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(false);
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
  });

  test('reports stopped when escalation terminates the surviving process', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({
      statusSequence: ['processing'],
      onTerminate: (controller) => controller.setStatus('idle'),
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.terminations).toBe(1);
    expect(results[0]?.stopped).toBe(true);
    expect(results[0]?.detail).toContain('escalated after verification failure');
  });

  test('verifies no live SDK process remains and escalates when one lingers', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      livePids: [4242],
      onTerminate: (controller) => controller.clearPids(),
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.interrupts).toBe(2);
    expect(fake.calls.terminations).toBe(1);
    expect(results[0]?.stopped).toBe(true);
    expect(results[0]?.detail).toContain('live SDK process pid(s) 4242');
  });

  test('reports an already-gone session as stopped and still unregisters it', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);

    const results = await manager.stopSessionsVerified(['ghost-session']);

    expect(results).toEqual([
      {
        sessionId: 'ghost-session',
        stopped: true,
        detail: 'no in-memory session; unregistered',
      },
    ]);
    expect(sessionManager.unregisterCalls).toEqual(['ghost-session']);
  });

  test('reports accurate per-session results for a mixed batch', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const healthy = makeFakeSession({ statusSequence: ['processing', 'idle'] });
    const stubborn = makeFakeSession({ statusSequence: ['processing'] });
    registerSession(manager, 'task-1', 'sess-healthy', healthy.session);
    registerSession(manager, 'task-2', 'sess-stubborn', stubborn.session);

    const results: VerifiedSessionStop[] = await manager.stopSessionsVerified([
      'sess-healthy',
      'sess-stubborn',
    ]);

    expect(results).toHaveLength(2);
    const healthyResult = results.find((r) => r.sessionId === 'sess-healthy');
    const stubbornResult = results.find((r) => r.sessionId === 'sess-stubborn');
    expect(healthyResult?.stopped).toBe(true);
    expect(healthyResult?.detail).toBeUndefined();
    expect(stubbornResult?.stopped).toBe(false);
    expect(healthy.calls.terminations).toBe(0);
    expect(stubborn.calls.terminations).toBe(1);
    expect(sessionManager.unregisterCalls.sort()).toEqual(['sess-healthy', 'sess-stubborn']);
  });

  test('getSubSessionIdsForTasks enumerates every sub-session id for the given tasks', () => {
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession();
    registerSession(manager, 'task-1', 'space:s1:task:task-1:exec:exec-1', fake.session);
    registerSession(manager, 'task-1', 'space:s1:task:task-1:exec:exec-2', fake.session);
    registerSession(manager, 'task-2', 'space:s1:task:task-2:exec:exec-3', fake.session);

    expect(manager.getSubSessionIdsForTasks(['task-1', 'task-2', 'task-3']).sort()).toEqual([
      'space:s1:task:task-1:exec:exec-1',
      'space:s1:task:task-1:exec:exec-2',
      'space:s1:task:task-2:exec:exec-3',
    ]);
  });
});
