import { describe, expect, test } from 'bun:test';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import {
  applyGoalUpdateEffect,
  formatMarkCompleteResult,
  requireGoalExists,
  requireGoalServiceForUpdate,
  requireTaskGoalLink,
  runMarkCompleteOperation,
  type MarkCompleteOperationDeps,
} from '../../../../src/lib/space/actions/mark-complete-operation.ts';

const TASK_ID = 'task-1';
const SESSION_ID = 'session-1';
const SPACE_ID = 'space-1';

function makeDeps(overrides: Partial<MarkCompleteOperationDeps> = {}): MarkCompleteOperationDeps {
  return {
    taskId: TASK_ID,
    mySessionId: SESSION_ID,
    invoke: async () => ({ kind: 'completed', value: { accepted: true, task: {} } }),
    ...overrides,
  };
}

describe('requireGoalServiceForUpdate', () => {
  test('no goal_update passes through with a null value', () => {
    expect(requireGoalServiceForUpdate({}, makeDeps())).toEqual({ value: null });
  });

  test('goal_update without a goal service rejects with the legacy message', () => {
    const outcome = requireGoalServiceForUpdate({ goal_update: { summary: 'x' } }, makeDeps());
    expect(outcome).toMatchObject({
      reason: {
        content: [
          {
            text: JSON.stringify({
              success: false,
              error: 'Goal update is not available in this context.',
            }),
          },
        ],
      },
    });
  });

  test('goal_update with a goal service present forwards the update as the value', () => {
    const deps = makeDeps({
      goalService: { getGoal: () => null, updateGoal: () => ({}) as never },
    });
    const update = { summary: 'x' };
    expect(requireGoalServiceForUpdate({ goal_update: update }, deps)).toEqual({ value: update });
  });
});

describe('requireTaskGoalLink', () => {
  test('a null update passes through unchanged', () => {
    expect(requireTaskGoalLink(null, makeDeps())).toEqual({ value: null });
  });

  test('a task with no linked goal rejects with the legacy message', () => {
    const deps = makeDeps({
      taskRepo: { getTask: () => ({ goalId: null, spaceId: SPACE_ID }) as never },
    });
    const outcome = requireTaskGoalLink({ summary: 'x' }, deps);
    expect(outcome).toMatchObject({
      reason: {
        content: [
          {
            text: JSON.stringify({
              success: false,
              error: 'Cannot apply goal_update: this task is not linked to a goal.',
            }),
          },
        ],
      },
    });
  });

  test('a task linked to a goal carries the goal and space id forward', () => {
    const deps = makeDeps({
      taskRepo: { getTask: () => ({ goalId: 'goal-1', spaceId: SPACE_ID }) as never },
    });
    const update = { summary: 'x' };
    expect(requireTaskGoalLink(update, deps)).toEqual({
      value: { goalId: 'goal-1', spaceId: SPACE_ID, update },
    });
  });
});

describe('requireGoalExists', () => {
  test('a null pending update passes through unchanged', () => {
    expect(requireGoalExists(null, makeDeps())).toEqual({ value: null });
  });

  test('a missing goal rejects with the legacy message', () => {
    const deps = makeDeps({
      goalService: { getGoal: () => null, updateGoal: () => ({}) as never },
    });
    const outcome = requireGoalExists(
      { goalId: 'goal-missing', spaceId: SPACE_ID, update: {} },
      deps
    );
    expect(outcome).toMatchObject({
      reason: {
        content: [
          { text: JSON.stringify({ success: false, error: 'Goal not found: goal-missing' }) },
        ],
      },
    });
  });

  test('a goal in a different space rejects as not found', () => {
    const deps = makeDeps({
      goalService: {
        getGoal: () => ({ id: 'goal-1', spaceId: 'other-space' }) as never,
        updateGoal: () => ({}) as never,
      },
    });
    const outcome = requireGoalExists({ goalId: 'goal-1', spaceId: SPACE_ID, update: {} }, deps);
    expect(
      JSON.parse((outcome as { reason: { content: [{ text: string }] } }).reason.content[0].text)
    ).toEqual({
      success: false,
      error: 'Goal not found: goal-1',
    });
  });

  test('a matching goal resolves the target', () => {
    const deps = makeDeps({
      goalService: {
        getGoal: () => ({ id: 'goal-1', spaceId: SPACE_ID }) as never,
        updateGoal: () => ({}) as never,
      },
    });
    const update = { summary: 'x' };
    expect(requireGoalExists({ goalId: 'goal-1', spaceId: SPACE_ID, update }, deps)).toEqual({
      value: { goalId: 'goal-1', spaceId: SPACE_ID, update },
    });
  });
});

describe('applyGoalUpdateEffect', () => {
  test('does nothing without a goal target', async () => {
    const calls: unknown[] = [];
    const deps = makeDeps({
      goalService: {
        getGoal: () => null,
        updateGoal: (...args: unknown[]) => (calls.push(args), {}) as never,
      },
    });
    const outcome: OperationOutcome = { kind: 'completed', value: { accepted: true } };
    expect(await applyGoalUpdateEffect(outcome, null, deps)).toBeNull();
    expect(calls).toEqual([]);
  });

  test('does nothing when the completion was not accepted', async () => {
    const calls: unknown[] = [];
    const deps = makeDeps({
      goalService: {
        getGoal: () => null,
        updateGoal: (...args: unknown[]) => (calls.push(args), {}) as never,
      },
    });
    const outcome: OperationOutcome = {
      kind: 'completed',
      value: { accepted: false, reason: 'x' },
    };
    const target = { goalId: 'goal-1', spaceId: SPACE_ID, update: {} };
    expect(await applyGoalUpdateEffect(outcome, target, deps)).toBeNull();
    expect(calls).toEqual([]);
  });

  test('does nothing when the operation failed outright', async () => {
    const calls: unknown[] = [];
    const deps = makeDeps({
      goalService: {
        getGoal: () => null,
        updateGoal: (...args: unknown[]) => (calls.push(args), {}) as never,
      },
    });
    const outcome: OperationOutcome = { kind: 'failed', code: 'execution_failed', message: 'x' };
    const target = { goalId: 'goal-1', spaceId: SPACE_ID, update: {} };
    expect(await applyGoalUpdateEffect(outcome, target, deps)).toBeNull();
    expect(calls).toEqual([]);
  });

  test('applies the update with workflow-node attribution on an accepted completion', async () => {
    const calls: Array<{ goalId: string; params: unknown; context: unknown }> = [];
    const deps = makeDeps({
      goalService: {
        getGoal: () => null,
        updateGoal: (goalId: string, params: unknown, context: unknown) => {
          calls.push({ goalId, params, context });
          return {} as never;
        },
      },
    });
    const outcome: OperationOutcome = { kind: 'completed', value: { accepted: true } };
    const target = {
      goalId: 'goal-1',
      spaceId: SPACE_ID,
      update: { summary: 'Shipped', progress: 80 },
    };
    expect(await applyGoalUpdateEffect(outcome, target, deps)).toBeNull();
    expect(calls).toEqual([
      {
        goalId: 'goal-1',
        params: { summary: 'Shipped', progress: 80, metrics: undefined, nextSteps: undefined },
        context: { source: 'workflow_node_agent', sourceTaskId: TASK_ID },
      },
    ]);
  });

  test('a thrown update failure is reported, not thrown', async () => {
    const deps = makeDeps({
      goalService: {
        getGoal: () => null,
        updateGoal: () => {
          throw new Error('goal db locked');
        },
      },
    });
    const outcome: OperationOutcome = { kind: 'completed', value: { accepted: true } };
    const target = { goalId: 'goal-1', spaceId: SPACE_ID, update: {} };
    expect(await applyGoalUpdateEffect(outcome, target, deps)).toBe('goal db locked');
  });
});

describe('formatMarkCompleteResult', () => {
  test('a failed outcome formats as an isError tool result', () => {
    const outcome: OperationOutcome = { kind: 'failed', code: 'execution_failed', message: 'boom' };
    const result = formatMarkCompleteResult(outcome, null);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: 'execution_failed',
      message: 'boom',
    });
  });

  test('a completed outcome without a goal-update error passes the value through unchanged', () => {
    const outcome: OperationOutcome = {
      kind: 'completed',
      value: { accepted: true, task: { id: TASK_ID } },
    };
    const result = formatMarkCompleteResult(outcome, null);
    expect(JSON.parse(result.content[0].text)).toEqual({ accepted: true, task: { id: TASK_ID } });
  });

  test('a completed outcome with a goal-update error reports it alongside success', () => {
    const outcome: OperationOutcome = {
      kind: 'completed',
      value: { accepted: true, task: { id: TASK_ID } },
    };
    const result = formatMarkCompleteResult(outcome, 'goal db locked');
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      accepted: true,
      task: { id: TASK_ID },
      goalUpdateError: 'goal db locked',
    });
  });
});

describe('runMarkCompleteOperation', () => {
  test('invokes the operation with the deps task id, ignoring any other params', async () => {
    const calls: Array<{ input: unknown; caller: unknown }> = [];
    const deps = makeDeps({
      invoke: async (input, caller) => {
        calls.push({ input, caller });
        return { kind: 'completed', value: { accepted: true, task: { id: TASK_ID } } };
      },
    });
    await runMarkCompleteOperation({}, deps);
    expect(calls).toEqual([
      { input: { taskId: TASK_ID }, caller: { source: 'mcp', sessionId: SESSION_ID } },
    ]);
  });

  test('an accepted completion applies the goal update through the goal service', async () => {
    const updateCalls: unknown[] = [];
    const deps = makeDeps({
      taskRepo: { getTask: () => ({ goalId: 'goal-1', spaceId: SPACE_ID }) as never },
      goalService: {
        getGoal: () => ({ id: 'goal-1', spaceId: SPACE_ID }) as never,
        updateGoal: (...args: unknown[]) => (updateCalls.push(args), {}) as never,
      },
      invoke: async () => ({ kind: 'completed', value: { accepted: true, task: { id: TASK_ID } } }),
    });
    const result = await runMarkCompleteOperation({ goal_update: { summary: 'Shipped' } }, deps);
    expect(JSON.parse(result.content[0].text)).toEqual({ accepted: true, task: { id: TASK_ID } });
    expect(updateCalls).toHaveLength(1);
  });

  test('a goal validation failure rejects with the existing message and never invokes the operation', async () => {
    let invoked = false;
    const deps = makeDeps({
      taskRepo: { getTask: () => ({ goalId: null, spaceId: SPACE_ID }) as never },
      goalService: { getGoal: () => null, updateGoal: () => ({}) as never },
      invoke: async () => {
        invoked = true;
        return { kind: 'completed', value: { accepted: true, task: {} } };
      },
    });
    const result = await runMarkCompleteOperation({ goal_update: { summary: 'x' } }, deps);
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: 'Cannot apply goal_update: this task is not linked to a goal.',
    });
    expect(invoked).toBe(false);
  });

  test('a goal-update failure after an accepted completion is reported in the result, not thrown', async () => {
    const deps = makeDeps({
      taskRepo: { getTask: () => ({ goalId: 'goal-1', spaceId: SPACE_ID }) as never },
      goalService: {
        getGoal: () => ({ id: 'goal-1', spaceId: SPACE_ID }) as never,
        updateGoal: () => {
          throw new Error('goal db locked');
        },
      },
      invoke: async () => ({ kind: 'completed', value: { accepted: true, task: { id: TASK_ID } } }),
    });
    const result = await runMarkCompleteOperation({ goal_update: { summary: 'Shipped' } }, deps);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      accepted: true,
      task: { id: TASK_ID },
      goalUpdateError: 'goal db locked',
    });
  });
});
