import { describe, expect, test } from 'bun:test';
import type { AgentProcessingState } from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { StagedRunOutcome } from '../../../../src/lib/space/runtime/staged-run';
import type { VerifiedStopFlowDeps } from '../../../../src/lib/space/runtime/verified-stop-flow';
import { runVerifiedStopFlow } from '../../../../src/lib/space/runtime/verified-stop-flow';

const SESSION_ID = 'sess-1';

interface FakeSessionOptions {
  missing?: boolean;
  statusSequence?: string[];
  interruptErrors?: unknown[];
  interruptGate?: Promise<void>;
  livePids?: number[];
  interruptInProgress?: boolean;
  terminateError?: unknown;
  onTerminate?: (fixture: FlowFixture) => void;
  failUnregister?: boolean;
  processingStatusError?: unknown;
}

interface FlowCalls {
  interrupts: number;
  terminates: number;
  settles: number;
  pidReads: number;
  unregisters: string[];
  detaches: string[];
  warns: string[];
}

interface FlowFixture {
  calls: FlowCalls;
  events: string[];
  setStatus(status: string): void;
  clearPids(): void;
  run(): Promise<StagedRunOutcome>;
}

function makeFlowFixture(options: FakeSessionOptions = {}): FlowFixture {
  const statusSequence = options.statusSequence ?? ['processing', 'idle'];
  let statusIndex = 0;
  let livePids = [...(options.livePids ?? [])];
  const session = { token: 'session' } as unknown as AgentSession;
  const calls: FlowCalls = {
    interrupts: 0,
    terminates: 0,
    settles: 0,
    pidReads: 0,
    unregisters: [],
    detaches: [],
    warns: [],
  };
  const events: string[] = [];
  const fixture: FlowFixture = {
    calls,
    events,
    setStatus(status: string) {
      statusSequence[statusIndex] = status;
    },
    clearPids() {
      livePids = [];
    },
    run: () => runVerifiedStopFlow(deps, SESSION_ID),
  };
  const warn = (message: string): void => {
    const kind = message.includes('retrying once')
      ? 'warn-retry'
      : message.includes('escalating to tracked process termination')
        ? 'warn-escalate'
        : 'warn-unregister-missing';
    calls.warns.push(kind);
    events.push(kind);
  };
  const deps: VerifiedStopFlowDeps = {
    claimSession: () => {
      events.push('claim');
      return options.missing === true ? null : session;
    },
    stopSessionStrict: async () => {
      calls.interrupts += 1;
      events.push(`interrupt-${calls.interrupts}`);
      if (options.interruptGate) await options.interruptGate;
      const err = options.interruptErrors?.[calls.interrupts - 1];
      if (err !== undefined) throw err;
      if (statusIndex < statusSequence.length - 1) {
        statusIndex += 1;
      }
    },
    readProcessingStatus: () => {
      events.push('status-read');
      if (options.processingStatusError !== undefined) throw options.processingStatusError;
      return statusSequence[statusIndex] as AgentProcessingState['status'];
    },
    isInterruptInProgress: () => {
      events.push('in-progress-check');
      return options.interruptInProgress === true;
    },
    awaitProcessExitSettle: async () => {
      calls.settles += 1;
      events.push('settle');
    },
    readLivePids: () => {
      calls.pidReads += 1;
      events.push('read-pids');
      return [...livePids];
    },
    terminateTrackedProcesses: () => {
      calls.terminates += 1;
      events.push('terminate');
      options.onTerminate?.(fixture);
      if (options.terminateError !== undefined) throw options.terminateError;
    },
    unregisterSession: async (sessionId: string) => {
      events.push('unregister');
      calls.unregisters.push(sessionId);
      if (options.failUnregister) throw new Error('unregister rejected');
    },
    detachSessionBookkeeping: (sessionId: string) => {
      events.push('detach');
      calls.detaches.push(sessionId);
    },
    warn: (message: string) => warn(message),
  };
  return fixture;
}

describe('runVerifiedStopFlow ladder', () => {
  test('happy path: one interrupt, down verdict, detach then unregister, no escalation', async () => {
    const fixture = makeFlowFixture();
    await expect(fixture.run()).resolves.toEqual({
      status: 'completed',
      result: { sessionId: SESSION_ID, stopped: true },
    });
    expect(fixture.calls.interrupts).toBe(1);
    expect(fixture.calls.terminates).toBe(0);
    expect(fixture.calls.warns).toEqual([]);
    expect(fixture.calls.detaches).toEqual([SESSION_ID]);
    expect(fixture.calls.unregisters).toEqual([SESSION_ID]);
    expect(fixture.events).toEqual([
      'claim',
      'interrupt-1',
      'status-read',
      'in-progress-check',
      'settle',
      'read-pids',
      'detach',
      'unregister',
    ]);
  });

  test('a missing session skips the ladder, unregisters, and never detaches', async () => {
    const fixture = makeFlowFixture({ missing: true });
    await expect(fixture.run()).resolves.toEqual({
      status: 'completed',
      result: {
        sessionId: SESSION_ID,
        stopped: true,
        detail: 'no in-memory session; unregistered',
      },
    });
    expect(fixture.calls.interrupts).toBe(0);
    expect(fixture.calls.detaches).toEqual([]);
    expect(fixture.calls.unregisters).toEqual([SESSION_ID]);
    expect(fixture.events).toEqual(['claim', 'unregister']);
  });

  test('a missing-session unregister failure only warns and keeps the stopped verdict', async () => {
    const fixture = makeFlowFixture({ missing: true, failUnregister: true });
    await expect(fixture.run()).resolves.toEqual({
      status: 'completed',
      result: {
        sessionId: SESSION_ID,
        stopped: true,
        detail: 'no in-memory session; unregistered',
      },
    });
    expect(fixture.calls.warns).toEqual(['warn-unregister-missing']);
  });

  test('a failed first verification retries the interrupt once and notes the rescue', async () => {
    const fixture = makeFlowFixture({ statusSequence: ['processing', 'processing', 'idle'] });
    await expect(fixture.run()).resolves.toEqual({
      status: 'completed',
      result: {
        sessionId: SESSION_ID,
        stopped: true,
        detail: 'first interrupt did not land; stopped on retry',
      },
    });
    expect(fixture.calls.interrupts).toBe(2);
    expect(fixture.calls.terminates).toBe(0);
    expect(fixture.calls.warns).toEqual(['warn-retry']);
  });

  test('a strict interrupt failure is noted and recovered when the retry lands', async () => {
    const fixture = makeFlowFixture({
      statusSequence: ['processing', 'idle'],
      interruptErrors: [new Error('boom')],
    });
    const outcome = await fixture.run();
    expect(outcome.status).toBe('completed');
    const result = outcome.result as { stopped: boolean; detail?: string };
    expect(result.stopped).toBe(true);
    expect(result.detail).toBe(
      'interrupt failed: boom; first interrupt did not land; stopped on retry'
    );
    expect(fixture.calls.interrupts).toBe(2);
  });

  test('a retry interrupt failure is noted before the escalation note', async () => {
    const fixture = makeFlowFixture({
      statusSequence: ['processing'],
      interruptErrors: [undefined, new Error('retry boom')],
      onTerminate: (f) => f.setStatus('idle'),
    });
    const outcome = await fixture.run();
    expect(outcome.status).toBe('completed');
    const result = outcome.result as { stopped: boolean; detail?: string };
    expect(result.stopped).toBe(true);
    expect(result.detail).toBe(
      "retry interrupt failed: retry boom; escalated after verification failure (processing state 'processing')"
    );
    expect(fixture.calls.terminates).toBe(1);
  });

  test('escalates to tracked termination and reports the leak when still alive', async () => {
    const fixture = makeFlowFixture({ statusSequence: ['processing'] });
    const outcome = await fixture.run();
    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual({
      sessionId: SESSION_ID,
      stopped: false,
      detail:
        "escalated after verification failure (processing state 'processing'); " +
        "still alive: processing state 'processing'",
    });
    expect(fixture.calls.interrupts).toBe(2);
    expect(fixture.calls.terminates).toBe(1);
    expect(fixture.calls.warns).toEqual(['warn-retry', 'warn-escalate']);
    expect(fixture.calls.detaches).toEqual([SESSION_ID]);
    expect(fixture.calls.unregisters).toEqual([SESSION_ID]);
  });

  test('a successful escalation reports stopped with the escalation note', async () => {
    const fixture = makeFlowFixture({
      statusSequence: ['processing'],
      onTerminate: (f) => f.setStatus('idle'),
    });
    const outcome = await fixture.run();
    expect(outcome.status).toBe('completed');
    const result = outcome.result as { stopped: boolean; detail?: string };
    expect(result.stopped).toBe(true);
    expect(result.detail).toBe(
      "escalated after verification failure (processing state 'processing')"
    );
  });

  test('an escalation failure is noted and the leak verdict stays last', async () => {
    const fixture = makeFlowFixture({
      statusSequence: ['processing'],
      terminateError: new Error('kill boom'),
    });
    const outcome = await fixture.run();
    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual({
      sessionId: SESSION_ID,
      stopped: false,
      detail:
        "escalated after verification failure (processing state 'processing'); " +
        "escalation failed: kill boom; still alive: processing state 'processing'",
    });
  });

  test('a lingering live pid escalates and a clean termination reports stopped', async () => {
    const fixture = makeFlowFixture({
      statusSequence: ['processing', 'idle'],
      livePids: [4242],
      onTerminate: (f) => f.clearPids(),
    });
    const outcome = await fixture.run();
    expect(outcome.status).toBe('completed');
    const result = outcome.result as { stopped: boolean; detail?: string };
    expect(result.stopped).toBe(true);
    expect(result.detail).toBe(
      'escalated after verification failure (live SDK process pid(s) 4242)'
    );
    expect(fixture.calls.terminates).toBe(1);
  });

  test('the processing state is checked before the interrupt-in-progress flag', async () => {
    const fixture = makeFlowFixture({ statusSequence: ['processing'], interruptInProgress: true });
    const outcome = await fixture.run();
    expect(outcome.status).toBe('completed');
    const result = outcome.result as { stopped: boolean; detail?: string };
    expect(result.stopped).toBe(false);
    expect(result.detail).toContain("still alive: processing state 'processing'");
    expect(result.detail).not.toContain('interrupt still in progress');
    expect(fixture.events).not.toContain('in-progress-check');
  });

  test('an in-progress interrupt is not down and escalates with its own reason', async () => {
    const fixture = makeFlowFixture({ statusSequence: ['idle'], interruptInProgress: true });
    const outcome = await fixture.run();
    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual({
      sessionId: SESSION_ID,
      stopped: false,
      detail:
        'escalated after verification failure (interrupt still in progress); ' +
        'still alive: interrupt still in progress',
    });
    expect(fixture.calls.interrupts).toBe(2);
    expect(fixture.calls.terminates).toBe(1);
  });

  test('the process-exit settle await runs before the live-pid read', async () => {
    const fixture = makeFlowFixture({ statusSequence: ['processing', 'idle'] });
    await fixture.run();
    const settleAt = fixture.events.indexOf('settle');
    const pidReadAt = fixture.events.indexOf('read-pids');
    expect(settleAt).toBeGreaterThanOrEqual(0);
    expect(pidReadAt).toBeGreaterThan(settleAt);
  });

  test('a settle await is skipped while an interrupt is still in progress', async () => {
    const fixture = makeFlowFixture({ statusSequence: ['idle'], interruptInProgress: true });
    await fixture.run();
    expect(fixture.calls.settles).toBe(0);
    expect(fixture.calls.pidReads).toBe(0);
  });

  test('a final unregister failure is noted but keeps the stop verdict', async () => {
    const fixture = makeFlowFixture({ failUnregister: true });
    await expect(fixture.run()).resolves.toEqual({
      status: 'completed',
      result: {
        sessionId: SESSION_ID,
        stopped: true,
        detail: 'unregister failed: unregister rejected',
      },
    });
    expect(fixture.calls.detaches).toEqual([SESSION_ID]);
  });

  test('a throwing verification read fails the pass with the stage named', async () => {
    const fixture = makeFlowFixture({ processingStatusError: new Error('status blew up') });
    const outcome = await fixture.run();
    expect(outcome.status).toBe('error');
    expect(outcome.stage).toBe('verify-after-interrupt');
    expect((outcome.error as Error).message).toBe('status blew up');
    expect(outcome.unwind).toEqual([]);
    expect(fixture.calls.interrupts).toBe(1);
    expect(fixture.calls.detaches).toEqual([]);
    expect(fixture.calls.unregisters).toEqual([]);
  });
});

describe('runVerifiedStopFlow microtask profile', () => {
  test('claim, the presence decision, and the interrupt start before the first await boundary', async () => {
    let releaseInterrupt: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    const fixture = makeFlowFixture({ interruptGate: gate });
    const promise = fixture.run();
    expect(fixture.events).toEqual(['claim', 'interrupt-1']);
    releaseInterrupt!();
    const outcome = await promise;
    expect(outcome.status).toBe('completed');
  });

  test('a queued microtask observer runs between the interrupt and its verification', async () => {
    const order: string[] = [];
    const deps: VerifiedStopFlowDeps = {
      claimSession: () => {
        order.push('claim');
        return { token: 'session' } as unknown as AgentSession;
      },
      stopSessionStrict: async () => {
        order.push('interrupt');
      },
      readProcessingStatus: () => {
        order.push('status-read');
        return 'idle' as AgentProcessingState['status'];
      },
      isInterruptInProgress: () => false,
      awaitProcessExitSettle: async () => {
        order.push('settle');
      },
      readLivePids: () => [],
      terminateTrackedProcesses: () => {
        order.push('terminate');
      },
      unregisterSession: async () => {
        order.push('unregister');
      },
      detachSessionBookkeeping: () => {
        order.push('detach');
      },
      warn: () => {
        order.push('warn');
      },
    };
    const promise = runVerifiedStopFlow(deps, SESSION_ID);
    queueMicrotask(() => order.push('observer'));
    await promise;
    expect(order).toEqual([
      'claim',
      'interrupt',
      'observer',
      'status-read',
      'settle',
      'detach',
      'unregister',
    ]);
  });
});
