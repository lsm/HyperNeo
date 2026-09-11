import { expect, test } from 'bun:test';
import type { SpaceTask, SpaceTaskStatus } from '@hyperneo/shared';
import {
  prepareSpaceTaskStatusUpdate,
  isTerminalTaskStatus,
} from '../../../../src/lib/space/managers/task-status-preparation';

function task(status: SpaceTaskStatus, extra: Partial<SpaceTask> = {}): SpaceTask {
  return Object.freeze({ id: 'task', spaceId: 'space', status, ...extra }) as SpaceTask;
}

test('blocking uses explicit result and block reason without mutating input', () => {
  const source = task('in_progress', { result: 'previous', reportedSummary: 'summary' });
  const options = Object.freeze({ result: 'failure', blockReason: 'dependency' as const });
  expect(prepareSpaceTaskStatusUpdate(source, 'blocked', options, 123)).toEqual({
    updates: { status: 'blocked', result: 'failure', blockReason: 'dependency' },
    reopened: false,
  });
  expect(source.result).toBe('previous');
});

test('summary promotion and null suppression preserve existing outcome policy', () => {
  const source = task('in_progress', { reportedSummary: 'summary' });
  expect(prepareSpaceTaskStatusUpdate(source, 'done', undefined, 123).updates).toEqual({
    status: 'done',
    result: 'summary',
  });
  expect(
    prepareSpaceTaskStatusUpdate(source, 'done', { reportedSummary: null }, 123).updates
  ).toEqual({ status: 'done', reportedSummary: null });
  expect(
    prepareSpaceTaskStatusUpdate(
      task('blocked', { result: 'old', reportedSummary: null }),
      'done',
      undefined,
      123
    ).updates
  ).toMatchObject({ result: null, blockReason: null });
});

test('review approval stamps clock and clears only appropriate checkpoint fields', () => {
  const prepared = prepareSpaceTaskStatusUpdate(
    task('review'),
    'approved',
    { approvalSource: 'human', approvalReason: 'accepted' },
    123
  );
  expect(prepared.updates).toEqual({
    status: 'approved',
    approvalSource: 'human',
    approvalReason: 'accepted',
    approvedAt: 123,
    pendingCheckpointType: null,
    pendingCompletionSubmittedByNodeId: null,
    pendingCompletionSubmittedAt: null,
    pendingCompletionReason: null,
  });
  expect(prepareSpaceTaskStatusUpdate(task('review'), 'stopped', undefined, 123).updates).toEqual({
    status: 'stopped',
  });
});

test('approved completion preserves approval metadata unless overridden and clears routed pointers', () => {
  expect(prepareSpaceTaskStatusUpdate(task('approved'), 'done', undefined, 123).updates).toEqual({
    status: 'done',
    postApprovalSessionId: null,
    postApprovalStartedAt: null,
    postApprovalBlockedReason: null,
    postApprovalSourceNodeId: null,
  });
  expect(
    prepareSpaceTaskStatusUpdate(task('approved'), 'done', { approvalReason: 'updated' }, 123)
      .updates
  ).toHaveProperty('approvalReason', 'updated');
  expect(
    prepareSpaceTaskStatusUpdate(task('review'), 'done', undefined, 123).updates
  ).toMatchObject({
    approvalSource: null,
    approvalReason: null,
    approvedAt: 123,
    postApprovalSourceNodeId: null,
  });
});

test.each(['blocked', 'cancelled', 'done'] as const)(
  'reopening %s resets outcome, approval and routed fields',
  (status) => {
    const prepared = prepareSpaceTaskStatusUpdate(task(status), 'open', undefined, 123);
    expect(prepared.reopened).toBe(true);
    expect(prepared.updates).toEqual({
      status: 'open',
      result: null,
      reportedSummary: null,
      blockReason: null,
      approvalSource: null,
      approvalReason: null,
      approvedAt: null,
      postApprovalSourceNodeId: null,
      postApprovalSessionId: null,
      postApprovalStartedAt: null,
      postApprovalBlockedReason: null,
      startedAt: null,
    });
  }
);

test('stopped recovery clears its report without inventing terminal-reopen fields', () => {
  expect(prepareSpaceTaskStatusUpdate(task('stopped'), 'in_progress', undefined, 123)).toEqual({
    updates: {
      status: 'in_progress',
      reportedStatus: null,
      reportedSummary: null,
      result: null,
      blockReason: null,
    },
    reopened: false,
  });
  expect(
    prepareSpaceTaskStatusUpdate(task('blocked'), 'stopped', undefined, 123).updates
  ).not.toHaveProperty('blockReason');
});

test('terminal classification retains blocked and excludes review and stopped', () => {
  expect(
    ['done', 'blocked', 'cancelled', 'archived'].map((status) =>
      isTerminalTaskStatus(status as SpaceTaskStatus)
    )
  ).toEqual([true, true, true, true]);
  expect(isTerminalTaskStatus('review')).toBe(false);
  expect(isTerminalTaskStatus('stopped')).toBe(false);
});
