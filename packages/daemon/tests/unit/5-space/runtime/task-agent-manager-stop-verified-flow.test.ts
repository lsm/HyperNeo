import { Database as BunDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

interface FakeInterruptOptions {
  skipDeferredReplay?: boolean;
  preserveDeliveryJobs?: boolean;
}

interface FakeSessionCalls {
  interrupts: number;
  cleanups: number;
  terminations: number;
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
}

function makeFakeSession(options: FakeSessionOptions = {}): FakeSessionController {
  const statusSequence = options.statusSequence ?? ['processing', 'idle'];
  let statusIndex = 0;
  let livePids = [...(options.livePids ?? [])];
  const calls: FakeSessionCalls = {
    interrupts: 0,
    cleanups: 0,
    terminations: 0,
    terminateOptions: [],
    interruptOptions: [],
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
      if (options.cleanupError !== undefined) throw options.cleanupError;
    },
    getProcessingState: () => {
      if (options.processingStateError !== undefined) throw options.processingStateError;
      return { status: statusSequence[statusIndex] };
    },
    isInterruptInProgress: () => options.interruptInProgress === true,
    getTrackedAgentRootPidsSplit: () => ({ live: [...livePids], exited: [] }),
    terminateTrackedAgentProcesses: (opts?: { forceDelayMs?: number }) => {
      calls.terminations++;
      calls.terminateOptions.push(opts);
      options.onTerminate?.(controller);
      if (options.terminateError !== undefined) throw options.terminateError;
    },
  } as unknown as AgentSession;
  return controller;
}

function makeSessionManager(options: { events?: string[]; failUnregisterFor?: string[] } = {}) {
  const cached = new Map<string, AgentSession>();
  const unregisterCalls: string[] = [];
  return {
    cached,
    unregisterCalls,
    getCachedSession: (sessionId: string) => cached.get(sessionId) ?? null,
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
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TaskAgentManager.stopSessionVerifiedViaFlow', () => {
  test('happy path: interrupts once, verifies down, detaches, and unregisters', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing', 'idle'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const result = await manager.stopSessionVerifiedViaFlow('sess-1');

    expect(fake.calls.interrupts).toBe(1);
    expect(fake.calls.cleanups).toBeGreaterThanOrEqual(1);
    expect(fake.calls.terminations).toBe(0);
    expect(fake.calls.interruptOptions).toEqual([{ skipDeferredReplay: true }]);
    expect(result).toEqual({ sessionId: 'sess-1', stopped: true });

    const internals = internalsOf(manager);
    expect(internals.agentSessionIndex.has('sess-1')).toBe(false);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(false);
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
    expect(internals.cancellingSessions.has('sess-1')).toBe(false);
  });

  test('a missing session reports stopped and still unregisters', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);

    const result = await manager.stopSessionVerifiedViaFlow('ghost-session');

    expect(result).toEqual({
      sessionId: 'ghost-session',
      stopped: true,
      detail: 'no in-memory session; unregistered',
    });
    expect(sessionManager.unregisterCalls).toEqual(['ghost-session']);
  });

  test('a missing session keeps the stopped verdict when its unregister rejects', async () => {
    const sessionManager = makeSessionManager({ failUnregisterFor: ['ghost'] });
    const manager = makeManager(sessionManager);

    const result = await manager.stopSessionVerifiedViaFlow('ghost');

    expect(result).toEqual({
      sessionId: 'ghost',
      stopped: true,
      detail: 'no in-memory session; unregistered',
    });
  });

  test('retries the interrupt once when the first attempt fails to land', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing', 'processing', 'idle'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const result = await manager.stopSessionVerifiedViaFlow('sess-1');

    expect(fake.calls.interrupts).toBe(2);
    expect(fake.calls.terminations).toBe(0);
    expect(result).toEqual({
      sessionId: 'sess-1',
      stopped: true,
      detail: 'first interrupt did not land; stopped on retry',
    });
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
  });

  test('surfaces a strict stop error and recovers when the retry lands', async () => {
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      interruptErrors: [new Error('boom')],
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const result = await manager.stopSessionVerifiedViaFlow('sess-1');

    expect(fake.calls.interrupts).toBe(2);
    expect(result.stopped).toBe(true);
    expect(result.detail).toContain('interrupt failed: ');
    expect(result.detail).toContain('boom');
    expect(result.detail).toContain('stopped on retry');
  });

  test('escalates with the 2000ms force delay and reports the leak when still alive', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const result = await manager.stopSessionVerifiedViaFlow('sess-1');

    expect(fake.calls.interrupts).toBe(2);
    expect(fake.calls.terminations).toBe(1);
    expect(fake.calls.terminateOptions[0]?.forceDelayMs).toBe(2000);
    expect(result).toEqual({
      sessionId: 'sess-1',
      stopped: false,
      detail:
        "escalated after verification failure (processing state 'processing'); " +
        "still alive: processing state 'processing'",
    });

    const internals = internalsOf(manager);
    expect(internals.agentSessionIndex.has('sess-1')).toBe(false);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(false);
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
  });

  test('reports stopped when escalation terminates the surviving process', async () => {
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession({
      statusSequence: ['processing'],
      onTerminate: (controller) => controller.setStatus('idle'),
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const result = await manager.stopSessionVerifiedViaFlow('sess-1');

    expect(fake.calls.terminations).toBe(1);
    expect(result.stopped).toBe(true);
    expect(result.detail).toContain('escalated after verification failure');
  });

  test('verifies no live SDK process remains and escalates when one lingers', async () => {
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession({
      statusSequence: ['processing', 'idle'],
      livePids: [4242],
      onTerminate: (controller) => controller.clearPids(),
    });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const result = await manager.stopSessionVerifiedViaFlow('sess-1');

    expect(fake.calls.interrupts).toBe(2);
    expect(fake.calls.terminations).toBe(1);
    expect(result.stopped).toBe(true);
    expect(result.detail).toContain('live SDK process pid(s) 4242');
  });

  test('keeps the stop verdict when the final unregister rejects', async () => {
    const sessionManager = makeSessionManager({ failUnregisterFor: ['sess-1'] });
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing', 'idle'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const result = await manager.stopSessionVerifiedViaFlow('sess-1');

    expect(result).toEqual({
      sessionId: 'sess-1',
      stopped: true,
      detail: 'unregister failed: unregister rejected',
    });
  });

  test('detaches the listener and completion callback before unregistering', async () => {
    const events: string[] = [];
    const sessionManager = makeSessionManager({ events });
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['processing', 'idle'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);
    const internals = internalsOf(manager);
    internals.sessionListeners.set('sess-1', () => events.push('listener-unsub'));
    internals.completionCallbacks.set('sess-1', () => {});

    await manager.stopSessionVerifiedViaFlow('sess-1');

    expect(events).toEqual(['listener-unsub', 'unregister']);
    expect(internals.sessionListeners.has('sess-1')).toBe(false);
    expect(internals.completionCallbacks.has('sess-1')).toBe(false);
  });

  test('holds the cancelling guard while the interrupt is in flight and clears it after', async () => {
    const manager = makeManager(makeSessionManager());
    let releaseInterrupt: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const fake = makeFakeSession({ statusSequence: ['processing', 'idle'], interruptGate: gate });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const promise = manager.stopSessionVerifiedViaFlow('sess-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(internalsOf(manager).cancellingSessions.has('sess-1')).toBe(true);

    releaseInterrupt();
    const result = await promise;
    expect(result).toEqual({ sessionId: 'sess-1', stopped: true });
    expect(internalsOf(manager).cancellingSessions.has('sess-1')).toBe(false);
  });

  test('evicts the session from the index synchronously with the flow start', async () => {
    const manager = makeManager(makeSessionManager());
    let releaseInterrupt: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const fake = makeFakeSession({ statusSequence: ['processing', 'idle'], interruptGate: gate });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const promise = manager.stopSessionVerifiedViaFlow('sess-1');
    await Promise.resolve();
    await Promise.resolve();
    const internals = internalsOf(manager);
    expect(internals.agentSessionIndex.has('sess-1')).toBe(false);
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(true);

    releaseInterrupt();
    await promise;
    expect(internals.subSessions.get('task-1')?.has('sess-1')).toBe(false);
  });

  test('waits for the tracked process exit before checking live pids', async () => {
    const manager = makeManager(makeSessionManager());
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
    const promise = manager.stopSessionVerifiedViaFlow('sess-1').then((result) => {
      settled = true;
      return result;
    });
    await tick();
    expect(settled).toBe(false);
    expect(fake.calls.interrupts).toBe(1);
    expect(fake.calls.terminations).toBe(0);

    fake.clearPids();
    releaseExit();
    const result = await promise;
    expect(settled).toBe(true);
    expect(result).toEqual({ sessionId: 'sess-1', stopped: true });
    expect(fake.calls.terminations).toBe(0);
  });

  test('propagates a verification crash and still clears the cancelling guard', async () => {
    const manager = makeManager(makeSessionManager());
    const fake = makeFakeSession({ processingStateError: new Error('status blew up') });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    await expect(manager.stopSessionVerifiedViaFlow('sess-1')).rejects.toThrow('status blew up');
    expect(fake.calls.interrupts).toBe(1);
    expect(internalsOf(manager).cancellingSessions.has('sess-1')).toBe(false);
  });

  test('treats an interrupted processing state as down after one interrupt', async () => {
    const sessionManager = makeSessionManager();
    const manager = makeManager(sessionManager);
    const fake = makeFakeSession({ statusSequence: ['interrupted'] });
    registerSession(manager, 'task-1', 'sess-1', fake.session);

    const result = await manager.stopSessionVerifiedViaFlow('sess-1');

    expect(fake.calls.interrupts).toBe(1);
    expect(fake.calls.terminations).toBe(0);
    expect(result).toEqual({ sessionId: 'sess-1', stopped: true });
    expect(sessionManager.unregisterCalls).toEqual(['sess-1']);
  });
});
