import { Database as BunDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { VerifiedSessionStop } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as RuntimeDatabase } from '../../../../src/storage/sqlite-compat';

interface FakeInterruptOptions {
  skipDeferredReplay?: boolean;
  preserveDeliveryJobs?: boolean;
}

interface FakeSessionCalls {
  interrupts: number;
  cleanups: number;
  terminations: number;
  statusQueries: number;
  terminateOptions: Array<{ forceDelayMs?: number } | undefined>;
  interruptOptions: Array<FakeInterruptOptions | undefined>;
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
  interruptInProgress?: boolean;
  processingStateError?: unknown;
  cleanupError?: unknown;
  terminateError?: unknown;
  processExitedPromise?: Promise<void> | null;
  eventLog?: string[];
  label?: string;
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
    interruptOptions: [],
  };
  const note = (name: string): void => {
    if (options.eventLog) options.eventLog.push(options.label ? `${options.label}:${name}` : name);
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
    processExitedPromise: options.processExitedPromise ?? null,
    handleInterrupt: async (interruptOptions?: FakeInterruptOptions) => {
      calls.interruptOptions.push(interruptOptions);
      note('interrupt-enter');
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
      note('cleanup');
      if (options.cleanupError !== undefined) throw options.cleanupError;
    },
    getProcessingState: () => {
      if (options.processingStateError !== undefined) throw options.processingStateError;
      calls.statusQueries++;
      return { status: statusSequence[statusIndex] };
    },
    isInterruptInProgress: () => options.interruptInProgress === true,
    getTrackedAgentRootPidsSplit: () => ({ live: [...livePids], exited: [] }),
    terminateTrackedAgentProcesses: (opts?: { forceDelayMs?: number }) => {
      calls.terminations++;
      calls.terminateOptions.push(opts);
      note('terminate');
      options.onTerminate?.(controller);
      if (options.terminateError !== undefined) throw options.terminateError;
    },
  } as unknown as AgentSession;
  return controller;
}

interface FakeSessionManagerOptions {
  events?: string[];
  failUnregisterFor?: string[];
}

function makeSessionManager(options: FakeSessionManagerOptions = {}) {
  const cached = new Map<string, AgentSession>();
  const unregisterCalls: string[] = [];
  return {
    cached,
    unregisterCalls,
    getCachedSession: (sessionId: string) => cached.get(sessionId) ?? null,
    getSession: (sessionId: string) => cached.get(sessionId) ?? null,
    unregisterSession: async (sessionId: string) => {
      options.events?.push('unregister');
      unregisterCalls.push(sessionId);
      cached.delete(sessionId);
      if (options.failUnregisterFor?.includes(sessionId)) {
        throw new Error('unregister rejected');
      }
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
    cancellingSessions: Set<string>;
    sessionListeners: Map<string, () => void>;
    completionCallbacks: Map<string, unknown>;
    stopSessionPreserveDb: (
      sessionId: string,
      session: AgentSession,
      options?: { strict?: boolean; preserveDeliveryJobs?: boolean }
    ) => Promise<void>;
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
    expect(fake.calls.interruptOptions).toEqual([{ skipDeferredReplay: true }]);
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

  test('reports a missing session as stopped even when its unregister rejects', async () => {
    const sessionManager = makeSessionManager({ failUnregisterFor: ['ghost'] });
    const manager = makeManager(sessionManager);

    const results = await manager.stopSessionsVerified(['ghost']);

    expect(results).toEqual([
      {
        sessionId: 'ghost',
        stopped: true,
        detail: 'no in-memory session; unregistered',
      },
    ]);
    expect(sessionManager.unregisterCalls).toEqual(['ghost']);
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

describe('TaskAgentManager.stopSessionsVerified fan-out and crash containment', () => {
  test('contains a verified-stop crash to the failing session', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const crashy = makeFakeSession({ processingStateError: new Error('state blew up') });
    const healthy = makeFakeSession({ statusSequence: ['processing', 'idle'] });
    registerSession(manager, 'task-1', 'sess-crashy', crashy.session);
    registerSession(manager, 'task-2', 'sess-healthy', healthy.session);

    const results = await manager.stopSessionsVerified(['sess-crashy', 'sess-healthy']);

    expect(results).toHaveLength(2);
    const crashed = results.find((r) => r.sessionId === 'sess-crashy');
    const fine = results.find((r) => r.sessionId === 'sess-healthy');
    expect(crashed).toEqual({
      sessionId: 'sess-crashy',
      stopped: false,
      detail: 'verified stop crashed: state blew up',
    });
    expect(fine?.stopped).toBe(true);
    expect(fine?.detail).toBeUndefined();
    expect(crashy.calls.cleanups).toBeGreaterThanOrEqual(1);
    expect(crashy.calls.terminations).toBe(0);
    expect(sessionManager.unregisterCalls).toEqual(['sess-healthy']);
    const internals = internalsOf(manager);
    expect(internals.agentSessionIndex.has('sess-crashy')).toBe(false);
    expect(internals.agentSessionIndex.has('sess-healthy')).toBe(false);
    expect(internals.cancellingSessions.size).toBe(0);
  });

  test('fans the batch out so every interrupt starts before any completes', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const events: string[] = [];
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const a = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      interruptGate: gateA,
      eventLog: events,
      label: 'sess-a',
    });
    const b = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      interruptGate: gateB,
      eventLog: events,
      label: 'sess-b',
    });
    registerSession(manager, 'task-1', 'sess-a', a.session);
    registerSession(manager, 'task-1', 'sess-b', b.session);

    const promise = manager.stopSessionsVerified(['sess-a', 'sess-b']);
    expect(events).toEqual(['sess-a:interrupt-enter', 'sess-b:interrupt-enter']);

    releaseA();
    releaseB();
    const results = await promise;
    expect(results).toEqual([
      { sessionId: 'sess-a', stopped: true },
      { sessionId: 'sess-b', stopped: true },
    ]);
  });
});

describe('TaskAgentManager.stopSessionVerified ladder notes', () => {
  test('records the retry interrupt failure and the escalation that rescued it', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({
      statusSequence: ['processing'],
      interruptErrors: [undefined, new Error('retry boom')],
      onTerminate: (controller) => controller.setStatus('idle'),
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.interrupts).toBe(2);
    expect(fake.calls.terminations).toBe(1);
    expect(results[0]).toEqual({
      sessionId: 'sess-1',
      stopped: true,
      detail:
        'retry interrupt failed: Failed to stop session sess-1: retry boom; ' +
        "escalated after verification failure (processing state 'processing')",
    });
  });

  test('reports the escalation failure and keeps the leak verdict last', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({
      statusSequence: ['processing'],
      terminateError: new Error('kill boom'),
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.terminations).toBe(1);
    expect(results[0]?.stopped).toBe(false);
    expect(results[0]?.detail).toBe(
      "escalated after verification failure (processing state 'processing'); " +
        "escalation failed: kill boom; still alive: processing state 'processing'"
    );
  });

  test('keeps the stop verdict when the final unregister rejects', async () => {
    const sessionManager = makeSessionManager({ failUnregisterFor: ['sess-1'] });
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing', 'idle'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(results[0]).toEqual({
      sessionId: 'sess-1',
      stopped: true,
      detail: 'unregister failed: unregister rejected',
    });
  });

  test('treats an interrupted processing state as down', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['interrupted'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.interrupts).toBe(1);
    expect(fake.calls.terminations).toBe(0);
    expect(results).toEqual([{ sessionId: 'sess-1', stopped: true }]);
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
  });
});

describe('TaskAgentManager.inspectSessionDown', () => {
  test('treats an in-progress interrupt as not down and reports it as the reason', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['idle'], interruptInProgress: true });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(fake.calls.interrupts).toBe(2);
    expect(fake.calls.terminations).toBe(1);
    expect(results[0]?.stopped).toBe(false);
    expect(results[0]?.detail).toBe(
      'escalated after verification failure (interrupt still in progress); ' +
        'still alive: interrupt still in progress'
    );
  });

  test('checks the processing state before the interrupt-in-progress flag', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing'], interruptInProgress: true });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(results[0]?.stopped).toBe(false);
    expect(results[0]?.detail).toContain("still alive: processing state 'processing'");
    expect(results[0]?.detail).not.toContain('interrupt still in progress');
  });

  test('waits for the tracked process exit before checking live pids', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    let releaseExit: () => void = () => {};
    const exitGate = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      livePids: [4242],
      processExitedPromise: exitGate,
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    let settled = false;
    const promise = manager.stopSessionsVerified(['sess-1']).then((results) => {
      settled = true;
      return results;
    });
    await tick();
    expect(settled).toBe(false);
    expect(fake.calls.interrupts).toBe(1);
    expect(fake.calls.terminations).toBe(0);

    fake.clearPids();
    releaseExit();
    const results = await promise;
    expect(settled).toBe(true);
    expect(results).toEqual([{ sessionId: 'sess-1', stopped: true }]);
    expect(fake.calls.terminations).toBe(0);
  });

  test('times out the process-exit settle window instead of hanging', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      processExitedPromise: new Promise<void>(() => {}),
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const startedAt = Date.now();
    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    expect(fake.calls.interrupts).toBe(1);
    expect(fake.calls.terminations).toBe(0);
    expect(results).toEqual([{ sessionId: 'sess-1', stopped: true }]);
  });
});

describe('TaskAgentManager.cancelBySessionId', () => {
  test('removes the index entry synchronously and finishes the stop asynchronously', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const events: string[] = [];
    let releaseInterrupt: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      interruptGate: gate,
      eventLog: events,
      label: 'sess-1',
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);
    const internals = internalsOf(manager);

    manager.cancelBySessionId('sess-1');
    expect(internals.agentSessionIndex.has('sess-1')).toBe(false);
    expect(events).toEqual(['sess-1:interrupt-enter']);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(true);
    expect(sessionManager.unregisterCalls).toEqual([]);

    releaseInterrupt();
    await tick();
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(false);
    expect(internals.cancellingSessions.has('sess-1')).toBe(false);
  });

  test('absorbs a cache-visible cancel while a verified stop is in flight', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const events: string[] = [];
    let releaseInterrupt: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      interruptGate: gate,
      eventLog: events,
      label: 'sess-1',
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);
    sessionManager.cached.set('sess-1', fake.session);
    const internals = internalsOf(manager);

    let settled = false;
    const promise = manager.stopSessionsVerified(['sess-1']).then((results) => {
      settled = true;
      return results;
    });
    await tick();
    expect(settled).toBe(false);
    expect(internals.cancellingSessions.has('sess-1')).toBe(true);
    expect(internals.agentSessionIndex.has('sess-1')).toBe(false);

    manager.cancelBySessionId('sess-1');
    expect(events.filter((entry) => entry === 'sess-1:interrupt-enter')).toHaveLength(1);
    expect(sessionManager.unregisterCalls).toEqual([]);

    releaseInterrupt();
    await promise;
    await tick();
    expect(events.filter((entry) => entry === 'sess-1:interrupt-enter')).toHaveLength(1);
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
  });

  test('fires a background unregister for a cache-invisible session mid-verified-stop', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    let releaseInterrupt: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      interruptGate: gate,
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const promise = manager.stopSessionsVerified(['sess-1']);
    await tick();

    manager.cancelBySessionId('sess-1');
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);

    releaseInterrupt();
    await promise;
    expect(sessionManager.unregisterCalls).toEqual(['sess-1', 'sess-1']);
  });

  test('swallows the unregister rejection for an unknown session', async () => {
    const sessionManager = makeSessionManager({ failUnregisterFor: ['ghost'] });
    const manager = makeManager(sessionManager);

    manager.cancelBySessionId('ghost');
    await tick();

    expect(sessionManager.unregisterCalls).toEqual(['ghost']);
  });

  test('a strict stop failure keeps bookkeeping and clears the guard for a retry', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      interruptErrors: [new Error('nope')],
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);
    sessionManager.cached.set('sess-1', fake.session);
    const internals = internalsOf(manager);

    manager.cancelBySessionId('sess-1');
    await tick();
    expect(sessionManager.unregisterCalls).toEqual([]);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(true);
    expect(internals.cancellingSessions.has('sess-1')).toBe(false);

    manager.cancelBySessionId('sess-1');
    await tick();
    expect(fake.calls.interrupts).toBe(2);
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(false);
  });
});

describe('TaskAgentManager verified-stop bookkeeping', () => {
  test('detaches bookkeeping before unregistering and clears every node map', async () => {
    const events: string[] = [];
    const sessionManager = makeSessionManager({ events });
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      eventLog: events,
      label: 'sess-1',
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);
    registerSession(manager, 'task-2', 'sess-1', fake.session);
    const internals = internalsOf(manager);
    internals.sessionListeners.set('sess-1', () => events.push('unsub'));
    internals.completionCallbacks.set('sess-1', []);

    await manager.stopSessionsVerified(['sess-1']);

    expect(events.filter((entry) => entry === 'unsub')).toHaveLength(1);
    expect(events.indexOf('unsub')).toBeLessThan(events.indexOf('unregister'));
    expect(internals.sessionListeners.has('sess-1')).toBe(false);
    expect(internals.completionCallbacks.has('sess-1')).toBe(false);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(false);
    expect(internals.subSessions.get('task-2')?.has('sess-1')).toBe(false);
  });

  test('unsubscribes a listener that survived strict stop failures during detach', async () => {
    const events: string[] = [];
    const sessionManager = makeSessionManager({ events });
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({
      statusSequence: ['processing'],
      interruptErrors: [new Error('boom-one'), new Error('boom-two')],
      onTerminate: (controller) => controller.setStatus('idle'),
      eventLog: events,
      label: 'sess-1',
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);
    const internals = internalsOf(manager);
    internals.sessionListeners.set('sess-1', () => events.push('unsub'));
    internals.completionCallbacks.set('sess-1', []);

    const results = await manager.stopSessionsVerified(['sess-1']);

    expect(results[0]?.stopped).toBe(true);
    expect(events.filter((entry) => entry === 'unsub')).toEqual(['unsub']);
    expect(events.indexOf('sess-1:terminate')).toBeLessThan(events.indexOf('unsub'));
    expect(internals.sessionListeners.has('sess-1')).toBe(false);
    expect(internals.completionCallbacks.has('sess-1')).toBe(false);
  });
});

describe('TaskAgentManager.stopSessionPreserveDb detach ordering', () => {
  function rigBookkeeping(manager: TaskAgentManager, events: string[]) {
    const internals = internalsOf(manager);
    internals.sessionListeners.set('sess-1', () => events.push('unsub'));
    internals.completionCallbacks.set('sess-1', []);
    return internals;
  }

  test('non-strict detaches the listener before interrupting', async () => {
    const events: string[] = [];
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      eventLog: events,
      label: 'sess-1',
    });
    const internals = rigBookkeeping(manager, events);

    await internals.stopSessionPreserveDb('sess-1', fake.session);

    expect(events).toEqual(['unsub', 'sess-1:interrupt-enter', 'sess-1:cleanup']);
    expect(internals.sessionListeners.has('sess-1')).toBe(false);
    expect(internals.completionCallbacks.has('sess-1')).toBe(false);
  });

  test('strict defers the detach until the interrupt and cleanup succeed', async () => {
    const events: string[] = [];
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      eventLog: events,
      label: 'sess-1',
    });
    const internals = rigBookkeeping(manager, events);

    await internals.stopSessionPreserveDb('sess-1', fake.session, { strict: true });

    expect(events).toEqual(['sess-1:interrupt-enter', 'sess-1:cleanup', 'unsub']);
    expect(internals.sessionListeners.has('sess-1')).toBe(false);
    expect(internals.completionCallbacks.has('sess-1')).toBe(false);
  });

  test('strict failure keeps the listener and completion callback registered', async () => {
    const events: string[] = [];
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession({
      interruptErrors: [new Error('nope')],
      eventLog: events,
      label: 'sess-1',
    });
    const internals = rigBookkeeping(manager, events);

    await expect(
      internals.stopSessionPreserveDb('sess-1', fake.session, { strict: true })
    ).rejects.toThrow('Failed to stop session sess-1: nope');

    expect(fake.calls.cleanups).toBe(1);
    expect(events).toEqual(['sess-1:interrupt-enter', 'sess-1:cleanup']);
    expect(internals.sessionListeners.has('sess-1')).toBe(true);
    expect(internals.completionCallbacks.has('sess-1')).toBe(true);
  });

  test('non-strict swallows interrupt and cleanup failures', async () => {
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession({
      interruptErrors: [new Error('nope')],
      cleanupError: new Error('clean-err'),
    });

    await expect(
      internalsOf(manager).stopSessionPreserveDb('sess-1', fake.session)
    ).resolves.toBeUndefined();
    expect(fake.calls.cleanups).toBe(1);
  });

  test('a cleanup failure never masks the interrupt failure in the strict error', async () => {
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession({
      interruptErrors: [new Error('int-err')],
      cleanupError: new Error('clean-err'),
    });

    await expect(
      internalsOf(manager).stopSessionPreserveDb('sess-1', fake.session, { strict: true })
    ).rejects.toThrow('Failed to stop session sess-1: int-err');
    expect(fake.calls.cleanups).toBe(1);
  });

  test('passes preserveDeliveryJobs through to the interrupt alongside skipDeferredReplay', async () => {
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession();
    const internals = internalsOf(manager);

    await internals.stopSessionPreserveDb('sess-1', fake.session);
    await internals.stopSessionPreserveDb('sess-1', fake.session, { preserveDeliveryJobs: true });
    await internals.stopSessionPreserveDb('sess-1', fake.session, { strict: true });

    expect(fake.calls.interruptOptions).toEqual([
      { skipDeferredReplay: true },
      { preserveDeliveryJobs: true, skipDeferredReplay: true },
      { skipDeferredReplay: true },
    ]);
  });
});

describe('parkStoppedWorkflowTask drives the verified-stop ladder', () => {
  test('parks a task through the real TaskAgentManager ladder', async () => {
    const db = new RuntimeDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
       allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', 2, ?, ?)`
    ).run('space-park', '/tmp/ws-park', 'Park Space', 'space-park', Date.now(), Date.now());
    const taskRepo = new SpaceTaskRepository(db);
    const task = taskRepo.createTask({
      spaceId: 'space-park',
      title: 'Park me',
      description: '',
      status: 'in_progress',
      taskAgentSessionId: 'sess-agent',
    });
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const agent = makeFakeSession({ statusSequence: ['processing', 'idle'] });
    const live = makeFakeSession({ statusSequence: ['processing', 'idle'] });
    const stale = makeFakeSession({ statusSequence: ['completed'] });
    registerSession(manager, task.id, 'sess-agent', agent.session);
    registerSession(manager, task.id, 'sess-live', live.session);
    registerSession(manager, task.id, 'sess-stale', stale.session);

    const config: SpaceRuntimeConfig = {
      db,
      spaceManager: new SpaceManager(db),
      spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
      spaceWorkflowManager: new SpaceWorkflowManager(new SpaceWorkflowRepository(db)),
      workflowRunRepo: new SpaceWorkflowRunRepository(db),
      taskRepo,
      nodeExecutionRepo: new NodeExecutionRepository(db),
      internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
      taskAgentManager: manager,
    };
    const runtime = new SpaceRuntime(config);

    const updated = await runtime.parkStoppedWorkflowTask('space-park', task.id);

    expect(updated?.status).toBe('stopped');
    expect(taskRepo.getTask(task.id)?.status).toBe('stopped');
    expect(agent.calls.interrupts).toBe(1);
    expect(live.calls.interrupts).toBe(1);
    expect(agent.calls.terminations).toBe(0);
    expect(live.calls.terminations).toBe(0);
    expect(sessionManager.unregisterCalls.sort()).toEqual(['sess-agent', 'sess-live']);
    expect(stale.calls.interrupts).toBe(1);
    const internals = internalsOf(manager);
    expect(internals.agentSessionIndex.size).toBe(0);
    expect(internals.subSessions.has(task.id)).toBe(false);
    db.close();
  });
});
