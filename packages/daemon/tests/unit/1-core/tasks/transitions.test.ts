import { assertQueuedTaskRetryTransition } from '../../../../src/lib/tasks/transitions';
import { describe, expect, test } from 'bun:test';
import { isDirectOutcomeStatus, isDirectRerunStatus } from '@hyperneo/shared';
import {
  VALID_TASK_TRANSITIONS,
  isValidTaskTransition,
  assertValidTaskTransition,
} from '../../../../src/lib/tasks/transitions';
import {
  VALID_SPACE_TASK_TRANSITIONS,
  isValidSpaceTaskTransition,
  assertValidSpaceTaskTransition,
} from '../../../../src/lib/tasks/task-manager';
import type { TaskLifecycleStatus } from '@hyperneo/shared/types/task-core';

describe('task transition policy', () => {
  test('keeps Space exports as the same table and functions', () => {
    expect(VALID_SPACE_TASK_TRANSITIONS).toBe(VALID_TASK_TRANSITIONS);
    expect(isValidSpaceTaskTransition).toBe(isValidTaskTransition);
    expect(assertValidSpaceTaskTransition).toBe(assertValidTaskTransition);
  });

  test.each([
    ['draft', 'open', true],
    ['open', 'in_progress', true],
    ['review', 'approved', true],
    ['approved', 'done', true],
    ['done', 'in_progress', true],
    ['rate_limited', 'usage_limited', true],
    ['stopped', 'open', true],
    ['archived', 'open', false],
    ['done', 'open', true],
    ['draft', 'done', true],
    ['archived', 'done', false],
  ] as [TaskLifecycleStatus, TaskLifecycleStatus, boolean][])(
    'preserves %s to %s = %s',
    (from, to, allowed) => {
      expect(isValidTaskTransition(from, to)).toBe(allowed);
      if (allowed) expect(() => assertValidTaskTransition(from, to)).not.toThrow();
      else expect(() => assertValidTaskTransition(from, to)).toThrow('Invalid status transition');
    }
  );

  test('preserves the diagnostic including allowed transitions in their original order', () => {
    expect(() => assertValidTaskTransition('done', 'blocked')).toThrow(
      "Invalid status transition from 'done' to 'blocked'. Allowed: open, in_progress, cancelled, archived"
    );
    expect(() => assertValidTaskTransition('archived', 'open')).toThrow(
      "Invalid status transition from 'archived' to 'open'. Allowed: none"
    );
  });
});

test('every status except archived can move to done, cancelled, and archived', () => {
  const statuses = Object.keys(VALID_TASK_TRANSITIONS) as TaskLifecycleStatus[];
  for (const from of statuses.filter((status) => status !== 'archived')) {
    for (const to of ['done', 'cancelled', 'archived'] as const) {
      if (from !== to)
        expect([from, to, isValidTaskTransition(from, to)]).toEqual([from, to, true]);
    }
  }
  expect(VALID_TASK_TRANSITIONS.archived).toEqual([]);
});

test('review can queue a guarded task retry without enabling generic review-to-open writes', () => {
  expect(isValidTaskTransition('review', 'open')).toBe(false);
  expect(() => assertQueuedTaskRetryTransition('review')).not.toThrow();
  expect(() => assertQueuedTaskRetryTransition('archived')).toThrow();
});

describe('isDirectOutcomeStatus', () => {
  test.each([
    ['review', true],
    ['done', true],
    ['blocked', true],
    ['cancelled', true],
    ['stopped', true],
    ['archived', true],
    ['open', false],
    ['in_progress', false],
    ['approved', false],
  ])('%s → %s', (status, expected) => {
    expect(isDirectOutcomeStatus(status)).toBe(expected);
  });
});

describe('isDirectRerunStatus', () => {
  test.each([
    ['blocked', true],
    ['cancelled', true],
    ['stopped', true],
    ['done', false],
    ['open', false],
    ['review', false],
  ] as const)('%s → %s', (status, expected) => {
    expect(isDirectRerunStatus(status)).toBe(expected);
  });
});
