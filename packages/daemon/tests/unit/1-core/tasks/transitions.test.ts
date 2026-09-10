import { describe, expect, test } from 'bun:test';
import {
  VALID_TASK_TRANSITIONS,
  isValidTaskTransition,
  assertValidTaskTransition,
} from '../../../../src/lib/tasks/transitions';
import {
  VALID_SPACE_TASK_TRANSITIONS,
  isValidSpaceTaskTransition,
  assertValidSpaceTaskTransition,
} from '../../../../src/lib/space/managers/space-task-manager';
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
    ['done', 'open', false],
    ['draft', 'done', false],
  ] as [
    TaskLifecycleStatus,
    TaskLifecycleStatus,
    boolean,
  ][])('preserves %s to %s = %s', (from, to, allowed) => {
    expect(isValidTaskTransition(from, to)).toBe(allowed);
    if (allowed) expect(() => assertValidTaskTransition(from, to)).not.toThrow();
    else expect(() => assertValidTaskTransition(from, to)).toThrow('Invalid status transition');
  });

  test('preserves the diagnostic including allowed transitions in their original order', () => {
    expect(() => assertValidTaskTransition('done', 'open')).toThrow(
      "Invalid status transition from 'done' to 'open'. Allowed: in_progress, archived"
    );
    expect(() => assertValidTaskTransition('archived', 'open')).toThrow(
      "Invalid status transition from 'archived' to 'open'. Allowed: none"
    );
  });
});
