import { describe, expect, test } from 'bun:test';
import {
  allowsWriteBesideActiveRun,
  classifyRequest,
  decideSpaceTaskTransition,
  rejectUnsupportedRequest,
  requireBlockReasonOnlyWithBlocked,
  requireResultOnlyWithDone,
  requireTableTransition,
  routeRuntimeAction,
  type SpaceTaskTransitionDecision,
  type SpaceTaskTransitionDecisionInput,
  stampApproval,
} from '../../../../src/lib/tasks/transition-decision';
import type { TaskUpdateRouting } from '../../../../src/lib/space/tools/task-transition-routing';

type Case = [string, SpaceTaskTransitionDecisionInput, SpaceTaskTransitionDecision];

const base = {
  taskId: 't1',
  hasResult: false,
  hasBlockReason: false,
  hasReviewReason: false,
  workflowRunId: null,
  runActive: false,
  approvalSource: null,
};

const cases: Case[] = [
  [
    'a human close keeps the agent attribution that approved the task',
    {
      ...base,
      approvalSource: 'agent',
      currentStatus: 'approved',
      requestedStatus: 'done',
      callerSource: 'rpc',
    },
    { action: 'write', approvalSource: undefined, allowActiveRun: false },
  ],
  [
    'a human close stamps human when nothing approved the task yet',
    {
      ...base,
      currentStatus: 'review',
      requestedStatus: 'done',
      callerSource: 'rpc',
    },
    { action: 'write', approvalSource: 'human', allowActiveRun: false },
  ],
  [
    'a block reason accompanying a move to blocked is accepted',
    {
      ...base,
      hasBlockReason: true,
      currentStatus: 'in_progress',
      requestedStatus: 'blocked',
      callerSource: 'rpc',
    },
    { action: 'write', approvalSource: undefined, allowActiveRun: false },
  ],
  [
    'a block reason accompanying any other status is rejected',
    {
      ...base,
      hasBlockReason: true,
      currentStatus: 'open',
      requestedStatus: 'in_progress',
      callerSource: 'rpc',
    },
    { action: 'reject', result: 'block_reason_requires_blocked' },
  ],
  [
    'review to done via rpc caller writes with human approval',
    { ...base, currentStatus: 'review', requestedStatus: 'done', callerSource: 'rpc' },
    { action: 'write', approvalSource: 'human', allowActiveRun: false },
  ],
  [
    'review to done via mcp caller is invalid',
    { ...base, currentStatus: 'review', requestedStatus: 'done', callerSource: 'mcp' },
    { action: 'reject', result: 'invalid_transition' },
  ],
  [
    'approved to done via rpc caller writes with human approval',
    { ...base, currentStatus: 'approved', requestedStatus: 'done', callerSource: 'rpc' },
    { action: 'write', approvalSource: 'human', allowActiveRun: false },
  ],
  [
    'approved to done via mcp caller routes to the completion stage',
    { ...base, currentStatus: 'approved', requestedStatus: 'done', callerSource: 'mcp' },
    { action: 'runtime', executor: 'complete_task', approvalSource: undefined },
  ],
  [
    'approved to done via internal caller routes to the completion stage',
    { ...base, currentStatus: 'approved', requestedStatus: 'done', callerSource: 'internal' },
    { action: 'runtime', executor: 'complete_task', approvalSource: undefined },
  ],
  [
    'approved to done via mcp reaches the completion stage before the stop executor takes the live run',
    {
      ...base,
      currentStatus: 'approved',
      requestedStatus: 'done',
      workflowRunId: 'run-1',
      runActive: true,
      callerSource: 'mcp',
    },
    { action: 'runtime', executor: 'complete_task', approvalSource: undefined },
  ],
  [
    'requesting review routes to the checkpoint stage for rpc',
    { ...base, currentStatus: 'open', requestedStatus: 'review', callerSource: 'rpc' },
    { action: 'runtime', executor: 'submit_review', approvalSource: undefined },
  ],
  [
    'requesting review routes to the checkpoint stage for mcp',
    { ...base, currentStatus: 'open', requestedStatus: 'review', callerSource: 'mcp' },
    { action: 'runtime', executor: 'submit_review', approvalSource: undefined },
  ],
  [
    'a task already in review still routes to the checkpoint stage',
    { ...base, currentStatus: 'review', requestedStatus: 'review', callerSource: 'rpc' },
    { action: 'runtime', executor: 'submit_review', approvalSource: undefined },
  ],
  [
    'a reviewReason outside a review transition is rejected',
    {
      ...base,
      currentStatus: 'open',
      requestedStatus: 'in_progress',
      hasReviewReason: true,
      callerSource: 'rpc',
    },
    { action: 'reject', result: 'review_reason_requires_review' },
  ],
  [
    'directly requesting approved is unsupported for rpc',
    { ...base, currentStatus: 'open', requestedStatus: 'approved', callerSource: 'rpc' },
    { action: 'reject', result: 'unsupported_status' },
  ],
  [
    'directly requesting approved is unsupported for mcp',
    { ...base, currentStatus: 'open', requestedStatus: 'approved', callerSource: 'mcp' },
    { action: 'reject', result: 'unsupported_status' },
  ],
  [
    'directly requesting rate_limited is unsupported for rpc',
    { ...base, currentStatus: 'open', requestedStatus: 'rate_limited', callerSource: 'rpc' },
    { action: 'reject', result: 'unsupported_status' },
  ],
  [
    'directly requesting rate_limited is unsupported for mcp',
    { ...base, currentStatus: 'open', requestedStatus: 'rate_limited', callerSource: 'mcp' },
    { action: 'reject', result: 'unsupported_status' },
  ],
  [
    'directly requesting usage_limited is unsupported for rpc',
    { ...base, currentStatus: 'open', requestedStatus: 'usage_limited', callerSource: 'rpc' },
    { action: 'reject', result: 'unsupported_status' },
  ],
  [
    'directly requesting usage_limited is unsupported for mcp',
    { ...base, currentStatus: 'open', requestedStatus: 'usage_limited', callerSource: 'mcp' },
    { action: 'reject', result: 'unsupported_status' },
  ],
  [
    'archiving with an active workflow run keeps its own reject reason',
    {
      ...base,
      currentStatus: 'open',
      requestedStatus: 'archived',
      workflowRunId: 'run-1',
      runActive: true,
      callerSource: 'rpc',
    },
    { action: 'reject', result: 'archive_active_run' },
  ],
  [
    'archiving with an inactive workflow run writes',
    {
      ...base,
      currentStatus: 'open',
      requestedStatus: 'archived',
      workflowRunId: 'run-1',
      runActive: false,
      callerSource: 'rpc',
    },
    { action: 'write', approvalSource: undefined, allowActiveRun: false },
  ],
  [
    'a workflow task moving from in_progress to open needs the stop executor',
    {
      ...base,
      currentStatus: 'in_progress',
      requestedStatus: 'open',
      workflowRunId: 'run-1',
      callerSource: 'rpc',
    },
    { action: 'runtime', executor: 'stop_for_status' },
  ],
  [
    'a workflow task moving from blocked to open needs the recovery executor',
    {
      ...base,
      currentStatus: 'blocked',
      requestedStatus: 'open',
      workflowRunId: 'run-1',
      callerSource: 'rpc',
    },
    { action: 'runtime', executor: 'recover_transition' },
  ],
  [
    'a workflow task moving from in_progress to stopped needs the park executor',
    {
      ...base,
      currentStatus: 'in_progress',
      requestedStatus: 'stopped',
      workflowRunId: 'run-1',
      callerSource: 'rpc',
    },
    { action: 'runtime', executor: 'park_stopped' },
  ],
  [
    'a result with a non-done status is rejected',
    {
      ...base,
      currentStatus: 'open',
      requestedStatus: 'in_progress',
      hasResult: true,
      callerSource: 'rpc',
    },
    { action: 'reject', result: 'result_requires_done' },
  ],
  [
    'a workflow task requesting stopped from a status that cannot reach it is invalid',
    {
      ...base,
      currentStatus: 'open',
      requestedStatus: 'stopped',
      workflowRunId: 'run-1',
      callerSource: 'rpc',
    },
    { action: 'reject', result: 'invalid_transition' },
  ],
  [
    'a workflow task carrying a non-done result before a runtime stop is rejected first',
    {
      ...base,
      currentStatus: 'in_progress',
      requestedStatus: 'open',
      workflowRunId: 'run-1',
      hasResult: true,
      callerSource: 'rpc',
    },
    { action: 'reject', result: 'result_requires_done' },
  ],
  [
    'a table-invalid transition is rejected',
    { ...base, currentStatus: 'draft', requestedStatus: 'in_progress', callerSource: 'rpc' },
    { action: 'reject', result: 'invalid_transition' },
  ],
  [
    'requesting cancelled routes to the cancel stage',
    { ...base, currentStatus: 'in_progress', requestedStatus: 'cancelled', callerSource: 'rpc' },
    { action: 'runtime', executor: 'cancel_task', approvalSource: undefined },
  ],
  [
    'a task already cancelled still routes to the cancel stage',
    { ...base, currentStatus: 'cancelled', requestedStatus: 'cancelled', callerSource: 'rpc' },
    { action: 'runtime', executor: 'cancel_task', approvalSource: undefined },
  ],
  [
    'requesting the current status is rejected',
    { ...base, currentStatus: 'open', requestedStatus: 'open', callerSource: 'rpc' },
    { action: 'reject', result: 'invalid_transition' },
  ],
  [
    'a plain forward transition writes without approval',
    { ...base, currentStatus: 'open', requestedStatus: 'in_progress', callerSource: 'rpc' },
    { action: 'write', approvalSource: undefined, allowActiveRun: false },
  ],
];

test.each(cases)('%s', (_name, input, expected) => {
  expect(decideSpaceTaskTransition(input)).toEqual(expected);
});

const setStatus: TaskUpdateRouting = {
  action: 'set_status',
  auditParamsShape: 'transition',
  emitTaskUpdated: 'always',
};
const fieldsOnly: TaskUpdateRouting = {
  action: 'fields_only',
  auditParamsShape: 'fields_only',
  emitTaskUpdated: 'always',
};
const rejectLimitedDirect: TaskUpdateRouting = {
  action: 'reject',
  reason: 'limited_direct',
  message: 'm',
};
const rejectReviewToDone: TaskUpdateRouting = {
  action: 'reject',
  reason: 'review_to_done',
  message: 'm',
};
const rejectArchiveActiveRun: TaskUpdateRouting = {
  action: 'reject',
  reason: 'archive_active_run',
  message: 'm',
};
const parkStopped: TaskUpdateRouting = {
  action: 'park_stopped',
  auditParamsShape: 'transition',
  emitTaskUpdated: 'only_with_field_updates',
};

const stopForStatus: TaskUpdateRouting = {
  action: 'stop_for_status',
  auditParamsShape: 'transition',
  emitTaskUpdated: 'never',
};

describe('classifyRequest', () => {
  test.each([
    ['open to in_progress classifies as set_status', 'open', 'in_progress', 'set_status'],
    ['requesting review classifies as submit_review', 'open', 'review', 'submit_review'],
    ['review to review also classifies as submit_review', 'review', 'review', 'submit_review'],
    ['same status classifies as fields_only', 'open', 'open', 'fields_only'],
  ] as const)('%s', (_name, currentStatus, requestedStatus, expectedAction) => {
    const routing = classifyRequest({
      ...base,
      currentStatus,
      requestedStatus,
      callerSource: 'rpc',
    });
    expect(routing.action).toBe(expectedAction);
  });
});

describe('rejectUnsupportedRequest', () => {
  test.each([
    [
      'fields_only rejects as invalid_transition',
      fieldsOnly,
      'rpc',
      { reason: { action: 'reject', result: 'invalid_transition' } },
    ],
    [
      'a reject reason with no mapping is unsupported',
      rejectLimitedDirect,
      'rpc',
      { reason: { action: 'reject', result: 'unsupported_status' } },
    ],
    [
      'archive_active_run survives instead of flattening to unsupported_status',
      rejectArchiveActiveRun,
      'rpc',
      { reason: { action: 'reject', result: 'archive_active_run' } },
    ],
    [
      'review_to_done via mcp is invalid_transition',
      rejectReviewToDone,
      'mcp',
      { reason: { action: 'reject', result: 'invalid_transition' } },
    ],
    [
      'review_to_done via rpc is invalid_transition once routing has allowed it',
      rejectReviewToDone,
      'rpc',
      { reason: { action: 'reject', result: 'invalid_transition' } },
    ],
    ['a non-reject routing passes through', setStatus, 'rpc', { value: setStatus }],
  ] as const)('%s', (_name, routing, _callerSource, expected) => {
    expect(rejectUnsupportedRequest(routing)).toEqual(expected);
  });
});

describe('requireResultOnlyWithDone', () => {
  test.each([
    ['a result with a non-done status is rejected', true, 'in_progress', 'reason'],
    ['a result with a done status passes through', true, 'done', 'value'],
    ['no result passes through', false, 'in_progress', 'value'],
  ] as const)('%s', (_name, hasResult, requestedStatus, expected) => {
    const gate = requireResultOnlyWithDone(setStatus, {
      ...base,
      currentStatus: 'open',
      requestedStatus,
      hasResult,
      callerSource: 'rpc',
    });
    expect(gate).toEqual(
      expected === 'value'
        ? { value: setStatus }
        : { reason: { action: 'reject', result: 'result_requires_done' } }
    );
  });
});

describe('requireBlockReasonOnlyWithBlocked', () => {
  test.each([
    ['a block reason with a non-blocked status is rejected', true, 'in_progress', 'reason'],
    ['a block reason with a blocked status passes through', true, 'blocked', 'value'],
    ['no block reason passes through', false, 'in_progress', 'value'],
  ] as const)('%s', (_name, hasBlockReason, requestedStatus, expected) => {
    const gate = requireBlockReasonOnlyWithBlocked(setStatus, {
      ...base,
      currentStatus: 'open',
      requestedStatus,
      hasBlockReason,
      callerSource: 'rpc',
    });
    expect(gate).toEqual(
      expected === 'value'
        ? { value: setStatus }
        : { reason: { action: 'reject', result: 'block_reason_requires_blocked' } }
    );
  });
});

describe('requireTableTransition', () => {
  test.each([
    ['a valid transition passes through', 'open', 'in_progress', 'value'],
    ['an invalid transition is rejected', 'done', 'cancelled', 'reason'],
  ] as const)('%s', (_name, currentStatus, requestedStatus, expected) => {
    const gate = requireTableTransition(setStatus, {
      ...base,
      currentStatus,
      requestedStatus,
      callerSource: 'rpc',
    });
    expect(gate).toEqual(
      expected === 'value'
        ? { value: setStatus }
        : { reason: { action: 'reject', result: 'invalid_transition' } }
    );
  });
});

describe('allowsWriteBesideActiveRun', () => {
  test.each([
    ['review to in_progress is a reopen', 'review', 'in_progress', true],
    ['approved to in_progress is a reopen', 'approved', 'in_progress', true],
    ['review to cancelled is not', 'review', 'cancelled', false],
    ['approved to cancelled is not', 'approved', 'cancelled', false],
    ['review to done is not', 'review', 'done', false],
  ] as const)('%s', (_name, currentStatus, requestedStatus, expected) => {
    expect(allowsWriteBesideActiveRun({ ...base, currentStatus, requestedStatus })).toBe(expected);
  });
});

describe('routeRuntimeAction', () => {
  test('a runtime action becomes the runtime decision', () => {
    expect(
      routeRuntimeAction(parkStopped, {
        ...base,
        currentStatus: 'open',
        requestedStatus: 'stopped',
      })
    ).toEqual({
      reason: { action: 'runtime', executor: 'park_stopped', approvalSource: undefined },
    });
  });
  test('a runtime action out of review into done stamps human approval', () => {
    expect(
      routeRuntimeAction(stopForStatus, {
        ...base,
        currentStatus: 'review',
        requestedStatus: 'done',
      })
    ).toEqual({
      reason: { action: 'runtime', executor: 'stop_for_status', approvalSource: 'human' },
    });
  });
  test('a runtime action out of approved into done stamps human approval', () => {
    expect(
      routeRuntimeAction(stopForStatus, {
        ...base,
        currentStatus: 'approved',
        requestedStatus: 'done',
      })
    ).toEqual({
      reason: { action: 'runtime', executor: 'stop_for_status', approvalSource: 'human' },
    });
  });
  test('a non-runtime action passes through', () => {
    expect(
      routeRuntimeAction(setStatus, { ...base, currentStatus: 'open', requestedStatus: 'done' })
    ).toEqual({ value: setStatus });
  });
});

describe('stampApproval', () => {
  test.each([
    ['review to done stamps human approval', 'review', 'done', 'human'],
    ['approved to done stamps human approval', 'approved', 'done', 'human'],
    ['any other transition writes without approval', 'open', 'in_progress', undefined],
  ] as const)('%s', (_name, currentStatus, requestedStatus, approvalSource) => {
    const decision = stampApproval({
      ...base,
      currentStatus,
      requestedStatus,
      callerSource: 'rpc',
    });
    expect(decision).toEqual({ action: 'write', approvalSource, allowActiveRun: false });
  });
});
