import { describe, expect, test } from 'bun:test';
import type { NodeExecution, SpaceTaskStatus } from '@hyperneo/shared';
import {
  type CompletionSummaryInput,
  isSettlementTerminal,
  isTaskAlreadyResolved,
  mapFinalTaskStatus,
  resolveCompletionSummaries,
  resolveQuiesceSourceNodeId,
  resolveSpawnedPostApprovalSession,
  selectSiblingsToQuiesce,
} from '../../../../src/lib/space/runtime/run-completion-settlement';

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

function makeSummaryInput(overrides: Partial<CompletionSummaryInput> = {}): CompletionSummaryInput {
  return {
    summaryFromArtifact: null,
    computedSummary: null,
    existingResult: null,
    reportedSummary: null,
    ...overrides,
  };
}

describe('resolveCompletionSummaries', () => {
  const cases: Array<{
    name: string;
    input: Partial<CompletionSummaryInput>;
    expected: { nextTaskResult: string | null; nextReportedSummary: string | null };
  }> = [
    {
      name: 'prefers the artifact summary over every other source',
      input: {
        summaryFromArtifact: 'artifact',
        computedSummary: 'computed',
        existingResult: 'existing',
        reportedSummary: 'reported',
      },
      expected: { nextTaskResult: 'artifact', nextReportedSummary: 'artifact' },
    },
    {
      name: 'falls back to the computed summary',
      input: {
        computedSummary: 'computed',
        existingResult: 'existing',
        reportedSummary: 'reported',
      },
      expected: { nextTaskResult: 'computed', nextReportedSummary: 'computed' },
    },
    {
      name: 'falls back to the existing result for nextTaskResult only',
      input: { existingResult: 'existing', reportedSummary: 'reported' },
      expected: { nextTaskResult: 'existing', nextReportedSummary: 'reported' },
    },
    {
      name: 'lets a reported-only summary fall through to both outputs',
      input: { reportedSummary: 'reported' },
      expected: { nextTaskResult: 'reported', nextReportedSummary: 'reported' },
    },
    {
      name: 'resolves to null when every source is missing',
      input: {},
      expected: { nextTaskResult: null, nextReportedSummary: null },
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(resolveCompletionSummaries(makeSummaryInput(input))).toEqual(expected);
    });
  }
});

describe('isTaskAlreadyResolved', () => {
  const resolved: SpaceTaskStatus[] = ['done', 'review', 'cancelled', 'approved', 'blocked'];
  const unresolved: SpaceTaskStatus[] = [
    'draft',
    'open',
    'in_progress',
    'archived',
    'rate_limited',
    'usage_limited',
    'stopped',
  ];

  for (const status of resolved) {
    test(`treats ${status} as resolved`, () => {
      expect(isTaskAlreadyResolved(status)).toBe(true);
    });
  }

  for (const status of unresolved) {
    test(`treats ${status} as unresolved`, () => {
      expect(isTaskAlreadyResolved(status)).toBe(false);
    });
  }
});

describe('mapFinalTaskStatus', () => {
  const cases: Array<{
    dispatchMode: 'no-route' | 'spawn' | 'already-routed' | 'skipped';
    currentStatus: SpaceTaskStatus;
    expected: SpaceTaskStatus;
  }> = [
    { dispatchMode: 'no-route', currentStatus: 'in_progress', expected: 'done' },
    { dispatchMode: 'no-route', currentStatus: 'open', expected: 'done' },
    { dispatchMode: 'skipped', currentStatus: 'in_progress', expected: 'in_progress' },
    { dispatchMode: 'skipped', currentStatus: 'open', expected: 'open' },
    { dispatchMode: 'skipped', currentStatus: 'stopped', expected: 'stopped' },
    { dispatchMode: 'spawn', currentStatus: 'in_progress', expected: 'approved' },
    { dispatchMode: 'already-routed', currentStatus: 'open', expected: 'approved' },
  ];

  for (const { dispatchMode, currentStatus, expected } of cases) {
    test(`${dispatchMode} with ${currentStatus} maps to ${expected}`, () => {
      expect(mapFinalTaskStatus(dispatchMode, currentStatus)).toBe(expected);
    });
  }
});

describe('resolveSpawnedPostApprovalSession', () => {
  test('returns the session for a spawned dispatch', () => {
    expect(resolveSpawnedPostApprovalSession('spawn', 'session-1')).toBe('session-1');
  });

  test('returns the session for an already-routed dispatch', () => {
    expect(resolveSpawnedPostApprovalSession('already-routed', 'session-2')).toBe('session-2');
  });

  test('returns undefined for a no-route dispatch', () => {
    expect(resolveSpawnedPostApprovalSession('no-route', 'session-1')).toBeUndefined();
  });

  test('returns undefined for a skipped dispatch', () => {
    expect(resolveSpawnedPostApprovalSession('skipped', 'session-1')).toBeUndefined();
  });

  test('returns undefined when the dispatch carries no session', () => {
    expect(resolveSpawnedPostApprovalSession('spawn', undefined)).toBeUndefined();
  });
});

describe('isSettlementTerminal', () => {
  const terminal: SpaceTaskStatus[] = ['done', 'cancelled', 'blocked', 'approved'];
  const nonTerminal: SpaceTaskStatus[] = [
    'review',
    'draft',
    'open',
    'in_progress',
    'archived',
    'rate_limited',
    'usage_limited',
    'stopped',
  ];

  for (const status of terminal) {
    test(`treats ${status} as terminal`, () => {
      expect(isSettlementTerminal(status)).toBe(true);
    });
  }

  for (const status of nonTerminal) {
    test(`treats ${status} as non-terminal`, () => {
      expect(isSettlementTerminal(status)).toBe(false);
    });
  }
});

describe('resolveQuiesceSourceNodeId', () => {
  test('prefers the post-approval source node', () => {
    expect(
      resolveQuiesceSourceNodeId(
        { postApprovalSourceNodeId: 'node-a', pendingCompletionSubmittedByNodeId: 'node-b' },
        'node-end'
      )
    ).toBe('node-a');
  });

  test('falls back to the pending-completion submitter node', () => {
    expect(
      resolveQuiesceSourceNodeId(
        { postApprovalSourceNodeId: null, pendingCompletionSubmittedByNodeId: 'node-b' },
        'node-end'
      )
    ).toBe('node-b');
  });

  test('treats an undefined post-approval source as missing', () => {
    expect(
      resolveQuiesceSourceNodeId(
        { postApprovalSourceNodeId: undefined, pendingCompletionSubmittedByNodeId: 'node-b' },
        'node-end'
      )
    ).toBe('node-b');
  });

  test('falls back to the workflow end node', () => {
    expect(
      resolveQuiesceSourceNodeId(
        { postApprovalSourceNodeId: null, pendingCompletionSubmittedByNodeId: null },
        'node-end'
      )
    ).toBe('node-end');
  });

  test('resolves to null when every source is missing', () => {
    expect(
      resolveQuiesceSourceNodeId(
        { postApprovalSourceNodeId: null, pendingCompletionSubmittedByNodeId: undefined },
        undefined
      )
    ).toBe(null);
  });
});

describe('selectSiblingsToQuiesce', () => {
  test('excludes executions without an agent session', () => {
    const noSession = makeExecution({ id: 'no-session', agentSessionId: null });
    expect(selectSiblingsToQuiesce([noSession], undefined, null)).toEqual([]);
  });

  test('excludes the spawned post-approval session', () => {
    const spawned = makeExecution({ id: 'spawned', agentSessionId: 'spawned' });
    const sibling = makeExecution({ id: 'sibling', agentSessionId: 'session-1' });
    expect(selectSiblingsToQuiesce([spawned, sibling], 'spawned', null)).toEqual([sibling]);
  });

  test('excludes executions on the source node when sourceNodeId is set', () => {
    const sameNode = makeExecution({ id: 'same-node', workflowNodeId: 'node-src' });
    const otherNode = makeExecution({ id: 'other-node', workflowNodeId: 'node-other' });
    expect(selectSiblingsToQuiesce([sameNode, otherNode], undefined, 'node-src')).toEqual([
      otherNode,
    ]);
  });

  test('with a null sourceNodeId excludes only the spawned session', () => {
    const noSession = makeExecution({ id: 'no-session', agentSessionId: null });
    const spawned = makeExecution({ id: 'spawned', agentSessionId: 'spawned' });
    const siblingA = makeExecution({ id: 'sibling-a', workflowNodeId: 'node-a' });
    const siblingB = makeExecution({ id: 'sibling-b', workflowNodeId: 'node-b' });
    expect(
      selectSiblingsToQuiesce([noSession, spawned, siblingA, siblingB], 'spawned', null)
    ).toEqual([siblingA, siblingB]);
  });

  test('with an undefined sourceNodeId excludes only the spawned session', () => {
    const noSession = makeExecution({ id: 'no-session', agentSessionId: null });
    const spawned = makeExecution({ id: 'spawned', agentSessionId: 'spawned' });
    const siblingA = makeExecution({ id: 'sibling-a', workflowNodeId: 'node-a' });
    expect(selectSiblingsToQuiesce([noSession, spawned, siblingA], 'spawned', undefined)).toEqual([
      siblingA,
    ]);
  });

  test('excludes executions that are not in progress', () => {
    const pending = makeExecution({ id: 'pending', status: 'pending' });
    const idle = makeExecution({ id: 'idle', status: 'idle' });
    const waitingRebind = makeExecution({ id: 'rebind', status: 'waiting_rebind' });
    const blocked = makeExecution({ id: 'blocked', status: 'blocked' });
    const cancelled = makeExecution({ id: 'cancelled', status: 'cancelled' });
    expect(
      selectSiblingsToQuiesce([pending, idle, waitingRebind, blocked, cancelled], undefined, null)
    ).toEqual([]);
  });

  test('combines every exclusion in one pass', () => {
    const idle = makeExecution({ id: 'idle', status: 'idle' });
    const noSession = makeExecution({ id: 'no-session', agentSessionId: null });
    const spawned = makeExecution({
      id: 'spawned',
      agentSessionId: 'spawn-session',
      workflowNodeId: 'node-src',
    });
    const sourceNodePeer = makeExecution({ id: 'source-peer', workflowNodeId: 'node-src' });
    const quiesceable = makeExecution({ id: 'quiesceable', workflowNodeId: 'node-other' });
    expect(
      selectSiblingsToQuiesce(
        [idle, noSession, spawned, sourceNodePeer, quiesceable],
        'spawn-session',
        'node-src'
      )
    ).toEqual([quiesceable]);
  });
});
