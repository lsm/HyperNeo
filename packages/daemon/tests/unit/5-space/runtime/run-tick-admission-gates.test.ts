import { describe, expect, test } from 'bun:test';
import type { NodeExecution } from '@hyperneo/shared';
import {
  decideRunTickAdmission,
  type RunTickAdmissionInput,
  selectTimedOutExecutions,
} from '../../../../src/lib/space/runtime/run-tick-admission-gates';

function makeAdmissionInput(overrides: Partial<RunTickAdmissionInput> = {}): RunTickAdmissionInput {
  return {
    runStatus: 'in_progress',
    hasExecutorMeta: true,
    runTaskCount: 1,
    hasCanonicalTask: true,
    hasEndNodeId: true,
    canonicalTaskStatus: 'in_progress',
    executionCount: 1,
    runIsComplete: false,
    hasBlockedExecution: false,
    firstBlockedResult: null,
    availableTaskSlots: 1,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'execution-1',
    workflowRunId: 'run-1',
    workflowNodeId: 'node-1',
    agentName: 'coder',
    agentId: null,
    agentSessionId: null,
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

describe('decideRunTickAdmission', () => {
  const cases: Array<{
    name: string;
    input: Partial<RunTickAdmissionInput>;
    expected: ReturnType<typeof decideRunTickAdmission>;
  }> = [
    {
      name: 'skips a missing run',
      input: { runStatus: null },
      expected: { action: 'skip', reason: 'missing_run' },
    },
    {
      name: 'clears a cancelled run',
      input: { runStatus: 'cancelled' },
      expected: { action: 'clearFinishedRun' },
    },
    {
      name: 'clears a succeeded run',
      input: { runStatus: 'done' },
      expected: { action: 'clearFinishedRun' },
    },
    {
      name: 'recovers a waiting run',
      input: { runStatus: 'blocked' },
      expected: { action: 'recoverWaitingRun' },
    },
    {
      name: 'skips without executor metadata',
      input: { hasExecutorMeta: false },
      expected: { action: 'skip', reason: 'no_executor_meta' },
    },
    {
      name: 'skips without run tasks',
      input: { runTaskCount: 0 },
      expected: { action: 'skip', reason: 'no_run_tasks' },
    },
    {
      name: 'skips without a canonical task',
      input: { hasCanonicalTask: false },
      expected: { action: 'skip', reason: 'no_canonical_task' },
    },
    {
      name: 'blocks a workflow without an end node',
      input: { hasEndNodeId: false },
      expected: { action: 'blockInvalidWorkflow' },
    },
    {
      name: 'skips a rate-limited task',
      input: { canonicalTaskStatus: 'rate_limited' },
      expected: { action: 'skip', reason: 'rate_or_usage_limited' },
    },
    {
      name: 'skips a usage-limited task',
      input: { canonicalTaskStatus: 'usage_limited' },
      expected: { action: 'skip', reason: 'rate_or_usage_limited' },
    },
    {
      name: 'skips a stopped task',
      input: { canonicalTaskStatus: 'stopped' },
      expected: { action: 'skip', reason: 'task_stopped' },
    },
    {
      name: 'skips without executions',
      input: { executionCount: 0 },
      expected: { action: 'skip', reason: 'no_executions' },
    },
    {
      name: 'blocks on a blocked execution',
      input: { hasBlockedExecution: true, firstBlockedResult: 'Needs review' },
      expected: { action: 'blockOnBlockedExecutions', blockedReason: 'Needs review' },
    },
    {
      name: 'uses the default blocked reason',
      input: { hasBlockedExecution: true },
      expected: {
        action: 'blockOnBlockedExecutions',
        blockedReason: 'One or more workflow agents are blocked',
      },
    },
    {
      name: 'defers an open task without slots',
      input: { canonicalTaskStatus: 'open', availableTaskSlots: 0 },
      expected: { action: 'deferNoAvailableSlots' },
    },
    {
      name: 'proceeds otherwise',
      input: {},
      expected: { action: 'proceed' },
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(decideRunTickAdmission(makeAdmissionInput(input))).toEqual(expected);
    });
  }

  test('finished run wins over waiting and metadata checks', () => {
    expect(
      decideRunTickAdmission(
        makeAdmissionInput({
          runStatus: 'done',
          hasExecutorMeta: false,
          runTaskCount: 0,
          hasCanonicalTask: false,
        })
      )
    ).toEqual({ action: 'clearFinishedRun' });
  });

  test('waiting run wins over metadata checks', () => {
    expect(
      decideRunTickAdmission(
        makeAdmissionInput({
          runStatus: 'blocked',
          hasExecutorMeta: false,
          runTaskCount: 0,
          hasCanonicalTask: false,
        })
      )
    ).toEqual({ action: 'recoverWaitingRun' });
  });

  test('blocked execution wins over the slot gate', () => {
    expect(
      decideRunTickAdmission(
        makeAdmissionInput({
          canonicalTaskStatus: 'open',
          hasBlockedExecution: true,
          firstBlockedResult: 'Agent blocked',
          availableTaskSlots: 0,
        })
      )
    ).toEqual({ action: 'blockOnBlockedExecutions', blockedReason: 'Agent blocked' });
  });

  test('completed run ignores blocked executions', () => {
    expect(
      decideRunTickAdmission(
        makeAdmissionInput({
          runIsComplete: true,
          hasBlockedExecution: true,
          firstBlockedResult: 'Stale failure',
        })
      )
    ).toEqual({ action: 'proceed' });
  });

  test('slot gate only applies to open tasks', () => {
    expect(
      decideRunTickAdmission(
        makeAdmissionInput({ canonicalTaskStatus: 'in_progress', availableTaskSlots: 0 })
      )
    ).toEqual({ action: 'proceed' });
  });
});

describe('selectTimedOutExecutions', () => {
  test('returns no timeouts when timeout is undefined', () => {
    const execution = makeExecution({ startedAt: 1 });
    expect(selectTimedOutExecutions([execution], undefined, 1_000)).toEqual({
      timedOutExecutions: [],
      maxElapsedMs: 0,
    });
  });

  test('excludes an execution exactly at the threshold', () => {
    const execution = makeExecution({ startedAt: 500 });
    expect(selectTimedOutExecutions([execution], 500, 1_000)).toEqual({
      timedOutExecutions: [],
      maxElapsedMs: 0,
    });
  });

  test('excludes an execution without a start time', () => {
    const execution = makeExecution({ startedAt: null });
    expect(selectTimedOutExecutions([execution], 500, 1_000)).toEqual({
      timedOutExecutions: [],
      maxElapsedMs: 0,
    });
  });

  test('selects only overdue in-progress executions and reports maximum elapsed time', () => {
    const oldest = makeExecution({ id: 'oldest', startedAt: 100 });
    const newer = makeExecution({ id: 'newer', startedAt: 300 });
    const pending = makeExecution({ id: 'pending', status: 'pending', startedAt: 1 });
    const atThreshold = makeExecution({ id: 'threshold', startedAt: 500 });

    expect(selectTimedOutExecutions([newer, pending, atThreshold, oldest], 500, 1_000)).toEqual({
      timedOutExecutions: [newer, oldest],
      maxElapsedMs: 900,
    });
  });
});
