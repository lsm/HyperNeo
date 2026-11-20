import { expect, test } from 'vitest';
import { admitTaskMember } from '../../../../src/lib/tasks/list-task-members.ts';

test.each([
  [true, { value: 'task-1' }],
  [false, { reason: null }],
])('task roster admission with access=%s', (allowed, outcome) => {
  expect(admitTaskMember('task-1', allowed)).toEqual(outcome);
});
