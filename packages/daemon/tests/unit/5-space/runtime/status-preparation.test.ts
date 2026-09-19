import { expect, test } from 'bun:test';
import type { SpaceTask, SpaceTaskStatus } from '@hyperneo/shared';
import {
  prepareSpaceTaskStatusUpdate,
  isTerminalTaskStatus,
} from '../../../../src/lib/tasks/status-preparation';
import { VALID_TASK_TRANSITIONS } from '../../../../src/lib/tasks/transitions';

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
      reportedStatus: null,
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

test('leaving approved clears post-approval bookkeeping', () => {
  const source = task('approved', {
    postApprovalSessionId: 'session-1',
    postApprovalStartedAt: 500,
    postApprovalBlockedReason: 'dispatcher down',
  });
  for (const next of ['done', 'in_progress', 'cancelled'] as SpaceTaskStatus[]) {
    expect(prepareSpaceTaskStatusUpdate(source, next, undefined, 123).updates).toMatchObject({
      postApprovalSessionId: null,
      postApprovalStartedAt: null,
      postApprovalBlockedReason: null,
      postApprovalSourceNodeId: null,
    });
  }
  expect(source.postApprovalSessionId).toBe('session-1');
});

test('staying in approved leaves post-approval bookkeeping alone', () => {
  const source = task('approved', { postApprovalSessionId: 'session-1' });
  const updates = prepareSpaceTaskStatusUpdate(source, 'approved', undefined, 123).updates;
  expect(updates).not.toHaveProperty('postApprovalSessionId');
});

test('rejecting a review task clears the report that would re-signal completion', () => {
  const rejected = prepareSpaceTaskStatusUpdate(
    task('review', { reportedStatus: 'done', reportedSummary: 'agent said done' }),
    'in_progress',
    undefined,
    123
  );
  expect(rejected.updates).toMatchObject({
    status: 'in_progress',
    reportedStatus: null,
    reportedSummary: null,
  });
});

test('every reopen the transition table allows clears reportedStatus', () => {
  const NOT_A_REOPEN: SpaceTaskStatus[] = ['draft', 'open', 'rate_limited', 'usage_limited'];
  const pairs = Object.entries(VALID_TASK_TRANSITIONS).flatMap(([from, targets]) =>
    NOT_A_REOPEN.includes(from as SpaceTaskStatus)
      ? []
      : targets
          .filter((to) => to === 'open' || to === 'in_progress')
          .map((to) => [from as SpaceTaskStatus, to as SpaceTaskStatus] as const)
  );
  expect(pairs.length).toBeGreaterThan(0);
  for (const [from, to] of pairs) {
    const prepared = prepareSpaceTaskStatusUpdate(
      task(from, { reportedStatus: 'done' }),
      to,
      undefined,
      123
    );
    expect({ from, to, reportedStatus: prepared.updates.reportedStatus }).toEqual({
      from,
      to,
      reportedStatus: null,
    });
  }
});

test('resuming from a rate or usage limit keeps the report it was paused with', () => {
  for (const from of ['rate_limited', 'usage_limited'] as const) {
    const prepared = prepareSpaceTaskStatusUpdate(
      task(from, { reportedStatus: 'done' }),
      'in_progress',
      undefined,
      123
    );
    expect(prepared.updates).not.toHaveProperty('reportedStatus');
  }
});
