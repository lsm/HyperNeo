import { describe, expect, test } from 'bun:test';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import {
  planStandaloneTaskTransition as decide,
  STANDALONE_TASK_STATUSES,
  type StandaloneTaskStatus,
} from '../../../../src/lib/tasks/standalone-lifecycle';
import { isValidTaskTransition } from '../../../../src/lib/tasks/transitions';

const task: TaskCore = {
  id: 'task',
  title: 'Work',
  description: '',
  status: 'open',
  priority: 'normal',
  labels: [],
  dependsOn: [],
  result: null,
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  completedAt: null,
  archivedAt: null,
};

function planStandaloneTaskTransition(...args: Parameters<typeof decide>) {
  const result = decide(...args);
  if (typeof result === 'string') throw new Error(result);
  return result;
}

describe('standalone lifecycle decisions', () => {
  test('starts, blocks and completes manual work without mutating the source task', () => {
    const started = planStandaloneTaskTransition(task, { status: 'in_progress' }, 10);
    expect(started).toEqual({
      status: 'in_progress',
      startedAt: 10,
      completedAt: null,
      archivedAt: null,
      result: null,
      updatedAt: 10,
    });
    const blocked = planStandaloneTaskTransition(
      { ...task, ...started },
      { status: 'blocked' },
      20
    );
    expect(blocked).toMatchObject({ startedAt: 10, completedAt: null });
    const done = planStandaloneTaskTransition(
      { ...task, ...blocked },
      { status: 'done', result: 'Finished' },
      30
    );
    expect(done).toEqual({
      status: 'done',
      startedAt: 10,
      completedAt: 30,
      archivedAt: null,
      result: 'Finished',
      updatedAt: 30,
    });
    expect(task.status).toBe('open');
    expect(task.startedAt).toBeNull();
  });

  test('cancels and reopens work while clearing stale completion state', () => {
    const cancelled = planStandaloneTaskTransition(
      { ...task, result: 'Old', startedAt: 5 },
      { status: 'cancelled' },
      10
    );
    expect(cancelled.completedAt).toBe(10);
    const reopened = planStandaloneTaskTransition(
      { ...task, ...cancelled },
      { status: 'open' },
      20
    );
    expect(reopened).toMatchObject({ startedAt: null, completedAt: null, result: null });
    const restarted = planStandaloneTaskTransition(
      { ...task, status: 'done', completedAt: 10, result: 'Old' },
      { status: 'in_progress' },
      30
    );
    expect(restarted).toMatchObject({ startedAt: 30, completedAt: null, result: null });
  });

  test('archives completed work without losing its result or timestamps', () => {
    const archived = planStandaloneTaskTransition(
      { ...task, status: 'done', startedAt: 5, completedAt: 10, result: 'Done' },
      { status: 'archived' },
      20
    );
    expect(archived).toEqual({
      status: 'archived',
      startedAt: 5,
      completedAt: 10,
      archivedAt: 20,
      result: 'Done',
      updatedAt: 20,
    });
  });

  test('uses existing transition relationships within the manual state subset', () => {
    for (const from of STANDALONE_TASK_STATUSES) {
      for (const to of STANDALONE_TASK_STATUSES) {
        const plan = () =>
          planStandaloneTaskTransition({ ...task, status: from }, { status: to }, 10);
        if (isValidTaskTransition(from, to)) expect(plan().status).toBe(to);
        else
          expect(decide({ ...task, status: from }, { status: to }, 10)).toBe('invalid_transition');
      }
    }
  });

  test.each(['draft', 'review', 'approved', 'rate_limited', 'usage_limited', 'stopped'] as const)(
    'rejects runtime or workflow state %s',
    (status) => {
      expect(decide({ ...task, status }, { status: 'open' }, 10)).toBe('unsupported_status');
      expect(decide(task, { status: status as StandaloneTaskStatus }, 10)).toBe(
        'unsupported_status'
      );
    }
  );

  test('accepts an empty completion result but rejects result edits on other transitions', () => {
    expect(planStandaloneTaskTransition(task, { status: 'done', result: '' }, 10).result).toBe('');
    expect(decide(task, { status: 'blocked', result: 'No' }, 10)).toBe('result_requires_done');
  });
});
