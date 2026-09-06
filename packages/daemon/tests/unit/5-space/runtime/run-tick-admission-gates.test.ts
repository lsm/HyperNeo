import { describe, expect, test } from 'bun:test';
import type { NodeExecution } from '@hyperneo/shared';
import { selectTimedOutExecutions } from '../../../../src/lib/space/runtime/run-tick-admission-gates';

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
