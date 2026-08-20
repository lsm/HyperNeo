import { describe, expect, test } from 'bun:test';
import type { NodeExecution, NodeExecutionStatus, SpaceTaskStatus } from '@hyperneo/shared';
import {
  classifySpawnFailure,
  decideSpawnAdmission,
  hasDriveableExecution,
  isCanonicalTaskTerminalForSpawn,
  isParkedAwaitingApproval,
  selectPromotablePendingExecutions,
} from '../../../../src/lib/space/runtime/run-spawn-decisions';

function makeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'execution-1',
    workflowRunId: 'run-1',
    workflowNodeId: 'node-1',
    agentName: 'coder',
    agentId: null,
    agentSessionId: 'session-1',
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: 100,
    completedAt: null,
    updatedAt: 1,
    lastActivityAt: null,
    ...overrides,
  };
}

function makeSpawnPending(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return makeExecution({ status: 'pending', agentSessionId: null, ...overrides });
}

describe('isCanonicalTaskTerminalForSpawn', () => {
  const terminal: SpaceTaskStatus[] = ['done', 'cancelled', 'archived', 'stopped'];
  const nonTerminal: SpaceTaskStatus[] = [
    'draft',
    'open',
    'in_progress',
    'review',
    'approved',
    'blocked',
    'rate_limited',
    'usage_limited',
  ];

  for (const status of terminal) {
    test(`treats ${status} as terminal for spawn`, () => {
      expect(isCanonicalTaskTerminalForSpawn(status)).toBe(true);
    });
  }

  for (const status of nonTerminal) {
    test(`treats ${status} as non-terminal for spawn`, () => {
      expect(isCanonicalTaskTerminalForSpawn(status)).toBe(false);
    });
  }

  test('differs from the settlement terminal set: keeps stopped, drops blocked', () => {
    expect(isCanonicalTaskTerminalForSpawn('stopped')).toBe(true);
    expect(isCanonicalTaskTerminalForSpawn('blocked')).toBe(false);
  });
});

describe('isParkedAwaitingApproval', () => {
  const parkedExecution = makeSpawnPending({ startedAt: 100, agentSessionId: null });

  for (const status of ['review', 'approved'] as const) {
    test(`parks a ${status} task with a started pending execution without a session`, () => {
      expect(isParkedAwaitingApproval(status, [parkedExecution])).toBe(true);
    });
  }

  const otherStatuses: SpaceTaskStatus[] = [
    'draft',
    'open',
    'in_progress',
    'done',
    'cancelled',
    'archived',
    'blocked',
    'rate_limited',
    'usage_limited',
    'stopped',
  ];

  for (const status of otherStatuses) {
    test(`does not park a ${status} task even with a matching pending execution`, () => {
      expect(isParkedAwaitingApproval(status, [parkedExecution])).toBe(false);
    });
  }

  test('does not park when the pending execution never started', () => {
    const notStarted = makeSpawnPending({ startedAt: null, agentSessionId: null });
    expect(isParkedAwaitingApproval('review', [notStarted])).toBe(false);
  });

  test('does not park when the pending execution already has a session', () => {
    const hasSession = makeSpawnPending({ startedAt: 100, agentSessionId: 'session-1' });
    expect(isParkedAwaitingApproval('review', [hasSession])).toBe(false);
  });

  test('does not park when there are no pending executions', () => {
    expect(isParkedAwaitingApproval('review', [])).toBe(false);
  });

  test('parks when at least one pending execution matches among non-matching peers', () => {
    const notStarted = makeSpawnPending({ id: 'not-started', startedAt: null });
    const withSession = makeSpawnPending({ id: 'with-session', agentSessionId: 'session-1' });
    expect(isParkedAwaitingApproval('approved', [notStarted, withSession, parkedExecution])).toBe(
      true
    );
  });
});

describe('decideSpawnAdmission', () => {
  const parkedExecution = makeSpawnPending({ startedAt: 100, agentSessionId: null });

  test('returns noPendingExecutions when the run has nothing pending', () => {
    expect(
      decideSpawnAdmission({
        pendingExecutionCount: 0,
        canonicalTaskStatus: 'in_progress',
        pendingExecutions: [],
        hasSpace: true,
      })
    ).toEqual({ action: 'noPendingExecutions' });
  });

  test('noPendingExecutions wins even for a terminal task without a space', () => {
    expect(
      decideSpawnAdmission({
        pendingExecutionCount: 0,
        canonicalTaskStatus: 'done',
        pendingExecutions: [],
        hasSpace: false,
      })
    ).toEqual({ action: 'noPendingExecutions' });
  });

  for (const status of ['done', 'cancelled', 'archived', 'stopped'] as const) {
    test(`skips spawn for terminal task status ${status}`, () => {
      expect(
        decideSpawnAdmission({
          pendingExecutionCount: 2,
          canonicalTaskStatus: status,
          pendingExecutions: [makeSpawnPending()],
          hasSpace: true,
        })
      ).toEqual({ action: 'skipSpawn', reason: 'canonical_task_terminal' });
    });
  }

  test('terminal beats parked even when both hold and the space is missing', () => {
    expect(
      decideSpawnAdmission({
        pendingExecutionCount: 1,
        canonicalTaskStatus: 'cancelled',
        pendingExecutions: [parkedExecution],
        hasSpace: false,
      })
    ).toEqual({ action: 'skipSpawn', reason: 'canonical_task_terminal' });
  });

  for (const status of ['review', 'approved'] as const) {
    test(`skips spawn for a parked ${status} task`, () => {
      expect(
        decideSpawnAdmission({
          pendingExecutionCount: 1,
          canonicalTaskStatus: status,
          pendingExecutions: [parkedExecution],
          hasSpace: true,
        })
      ).toEqual({ action: 'skipSpawn', reason: 'parked_awaiting_approval' });
    });
  }

  test('parked beats space-missing', () => {
    expect(
      decideSpawnAdmission({
        pendingExecutionCount: 1,
        canonicalTaskStatus: 'review',
        pendingExecutions: [parkedExecution],
        hasSpace: false,
      })
    ).toEqual({ action: 'skipSpawn', reason: 'parked_awaiting_approval' });
  });

  test('a review task without a parkable execution falls through to space-missing', () => {
    expect(
      decideSpawnAdmission({
        pendingExecutionCount: 1,
        canonicalTaskStatus: 'review',
        pendingExecutions: [makeSpawnPending({ startedAt: null })],
        hasSpace: false,
      })
    ).toEqual({ action: 'skipSpawn', reason: 'space_missing' });
  });

  test('skips spawn when the space is missing and nothing else holds', () => {
    expect(
      decideSpawnAdmission({
        pendingExecutionCount: 3,
        canonicalTaskStatus: 'in_progress',
        pendingExecutions: [makeSpawnPending()],
        hasSpace: false,
      })
    ).toEqual({ action: 'skipSpawn', reason: 'space_missing' });
  });

  test('spawns for a non-terminal task with pending executions and a space', () => {
    expect(
      decideSpawnAdmission({
        pendingExecutionCount: 2,
        canonicalTaskStatus: 'open',
        pendingExecutions: [makeSpawnPending(), makeSpawnPending()],
        hasSpace: true,
      })
    ).toEqual({ action: 'spawn' });
  });

  test('spawns for a blocked task because blocked is not terminal for spawn', () => {
    expect(
      decideSpawnAdmission({
        pendingExecutionCount: 1,
        canonicalTaskStatus: 'blocked',
        pendingExecutions: [makeSpawnPending()],
        hasSpace: true,
      })
    ).toEqual({ action: 'spawn' });
  });
});

describe('selectPromotablePendingExecutions', () => {
  const preTickPendingIds = new Set(['execution-1', 'execution-2', 'execution-3']);
  const aliveSessionIds = new Set(['session-1', 'session-2']);

  test('promotes a pending pre-tick execution with an alive session', () => {
    const promotable = makeExecution({
      id: 'execution-1',
      status: 'pending',
      agentSessionId: 'session-1',
    });
    expect(
      selectPromotablePendingExecutions([promotable], preTickPendingIds, aliveSessionIds)
    ).toEqual([promotable]);
  });

  const exclusions: Array<{ name: string; execution: NodeExecution }> = [
    {
      name: 'excludes a non-pending execution',
      execution: makeExecution({ id: 'execution-2', status: 'in_progress' }),
    },
    {
      name: 'excludes an execution without an agent session',
      execution: makeExecution({ id: 'execution-2', status: 'pending', agentSessionId: null }),
    },
    {
      name: 'excludes an execution missing from the pre-tick snapshot',
      execution: makeExecution({ id: 'execution-9', status: 'pending' }),
    },
    {
      name: 'excludes an execution whose session is dead',
      execution: makeExecution({
        id: 'execution-3',
        status: 'pending',
        agentSessionId: 'session-x',
      }),
    },
  ];

  for (const { name, execution } of exclusions) {
    test(name, () => {
      expect(
        selectPromotablePendingExecutions([execution], preTickPendingIds, aliveSessionIds)
      ).toEqual([]);
    });
  }

  test('keeps only the qualifying executions in input order', () => {
    const dead = makeExecution({
      id: 'execution-3',
      status: 'pending',
      agentSessionId: 'session-x',
    });
    const promotableA = makeExecution({ id: 'execution-2', status: 'pending' });
    const notPreTick = makeExecution({ id: 'execution-9', status: 'pending' });
    const promotableB = makeExecution({ id: 'execution-1', status: 'pending' });
    expect(
      selectPromotablePendingExecutions(
        [dead, promotableA, notPreTick, promotableB],
        preTickPendingIds,
        aliveSessionIds
      )
    ).toEqual([promotableA, promotableB]);
  });

  test('returns nothing for an empty execution list', () => {
    expect(selectPromotablePendingExecutions([], preTickPendingIds, aliveSessionIds)).toEqual([]);
  });
});

describe('classifySpawnFailure', () => {
  const staleStatuses = ['cancelled', 'blocked', 'idle'] as const;
  const retryStatuses = ['pending', 'in_progress', 'waiting_rebind'] as const;

  test('a permanent error cancels the execution', () => {
    expect(
      classifySpawnFailure({
        isPermanent: true,
        isTransient: false,
        staleExecutionStatus: 'pending',
      })
    ).toBe('cancel_permanent');
  });

  test('a transient error defers the spawn', () => {
    expect(
      classifySpawnFailure({
        isPermanent: false,
        isTransient: true,
        staleExecutionStatus: 'pending',
      })
    ).toBe('defer_transient');
  });

  for (const status of staleStatuses) {
    test(`preserves a stale execution already ${status}`, () => {
      expect(
        classifySpawnFailure({
          isPermanent: false,
          isTransient: false,
          staleExecutionStatus: status,
        })
      ).toBe('preserve_stale_terminal');
    });
  }

  for (const status of retryStatuses) {
    test(`resets a stale ${status} execution for retry`, () => {
      expect(
        classifySpawnFailure({
          isPermanent: false,
          isTransient: false,
          staleExecutionStatus: status,
        })
      ).toBe('reset_retry');
    });
  }

  test('permanent beats transient and stale', () => {
    expect(
      classifySpawnFailure({
        isPermanent: true,
        isTransient: true,
        staleExecutionStatus: 'cancelled',
      })
    ).toBe('cancel_permanent');
  });

  test('transient beats a stale terminal status', () => {
    expect(
      classifySpawnFailure({
        isPermanent: false,
        isTransient: true,
        staleExecutionStatus: 'idle',
      })
    ).toBe('defer_transient');
  });
});

describe('hasDriveableExecution', () => {
  const driveable: NodeExecutionStatus[] = ['pending', 'in_progress', 'waiting_rebind', 'blocked'];
  const notDriveable: NodeExecutionStatus[] = ['idle', 'cancelled'];

  for (const status of driveable) {
    test(`treats ${status} as driveable`, () => {
      expect(hasDriveableExecution([makeExecution({ status })])).toBe(true);
    });
  }

  for (const status of notDriveable) {
    test(`treats ${status} as not driveable`, () => {
      expect(hasDriveableExecution([makeExecution({ status })])).toBe(false);
    });
  }

  test('returns false for an empty execution list', () => {
    expect(hasDriveableExecution([])).toBe(false);
  });

  test('one driveable execution among terminal peers is enough', () => {
    expect(
      hasDriveableExecution([
        makeExecution({ id: 'idle-1', status: 'idle' }),
        makeExecution({ id: 'cancelled-1', status: 'cancelled' }),
        makeExecution({ id: 'rebind-1', status: 'waiting_rebind' }),
      ])
    ).toBe(true);
  });
});
