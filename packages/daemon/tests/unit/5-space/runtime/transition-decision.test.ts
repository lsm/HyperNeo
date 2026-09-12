import { describe, expect, test } from 'bun:test';
import {
  classifyRequest,
  decideSpaceTaskTransition,
  rejectUnsupportedRequest,
  requireResultOnlyWithDone,
  requireTableTransition,
  routeRuntimeAction,
  type SpaceTaskTransitionDecision,
  type SpaceTaskTransitionDecisionInput,
  stampApproval,
} from '../../../../src/lib/space/operations/transition-decision';
import type { TaskUpdateRouting } from '../../../../src/lib/space/tools/task-transition-routing';

type Case = [string, SpaceTaskTransitionDecisionInput, SpaceTaskTransitionDecision];

const base = { taskId: 't1', hasResult: false, workflowRunId: null, runActive: false };

const cases: Case[] = [
  [
    'review to done via rpc caller writes with human approval',
    { ...base, currentStatus: 'review', requestedStatus: 'done', callerSource: 'rpc' },
    { action: 'write', approvalSource: 'human' },
  ],
  [
    'review to done via mcp caller is invalid',
    { ...base, currentStatus: 'review', requestedStatus: 'done', callerSource: 'mcp' },
    { action: 'reject', result: 'invalid_transition' },
  ],
  [
    'directly requesting review is unsupported for rpc',
    { ...base, currentStatus: 'open', requestedStatus: 'review', callerSource: 'rpc' },
    { action: 'reject', result: 'unsupported_status' },
  ],
  [
    'directly requesting review is unsupported for mcp',
    { ...base, currentStatus: 'open', requestedStatus: 'review', callerSource: 'mcp' },
    { action: 'reject', result: 'unsupported_status' },
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
    'archiving with an active workflow run is unsupported',
    {
      ...base,
      currentStatus: 'open',
      requestedStatus: 'archived',
      workflowRunId: 'run-1',
      runActive: true,
      callerSource: 'rpc',
    },
    { action: 'reject', result: 'unsupported_status' },
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
    { action: 'write', approvalSource: undefined },
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
    { ...base, currentStatus: 'done', requestedStatus: 'cancelled', callerSource: 'rpc' },
    { action: 'reject', result: 'invalid_transition' },
  ],
  [
    'requesting the current status is rejected',
    { ...base, currentStatus: 'open', requestedStatus: 'open', callerSource: 'rpc' },
    { action: 'reject', result: 'invalid_transition' },
  ],
  [
    'a plain forward transition writes without approval',
    { ...base, currentStatus: 'open', requestedStatus: 'in_progress', callerSource: 'rpc' },
    { action: 'write', approvalSource: undefined },
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
const rejectReviewDirect: TaskUpdateRouting = {
  action: 'reject',
  reason: 'review_direct',
  message: 'm',
};
const rejectReviewToDone: TaskUpdateRouting = {
  action: 'reject',
  reason: 'review_to_done',
  message: 'm',
};
const parkStopped: TaskUpdateRouting = {
  action: 'park_stopped',
  auditParamsShape: 'transition',
  emitTaskUpdated: 'only_with_field_updates',
};

describe('classifyRequest', () => {
  test.each([
    ['open to in_progress classifies as set_status', 'open', 'in_progress', 'set_status'],
    ['requesting review classifies as reject', 'open', 'review', 'reject'],
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
      'a non-review reject reason is unsupported',
      rejectReviewDirect,
      'rpc',
      { reason: { action: 'reject', result: 'unsupported_status' } },
    ],
    [
      'review_to_done via mcp is invalid_transition',
      rejectReviewToDone,
      'mcp',
      { reason: { action: 'reject', result: 'invalid_transition' } },
    ],
    [
      'review_to_done via rpc passes through',
      rejectReviewToDone,
      'rpc',
      { value: rejectReviewToDone },
    ],
    ['a non-reject routing passes through', setStatus, 'rpc', { value: setStatus }],
  ] as const)('%s', (_name, routing, callerSource, expected) => {
    const gate = rejectUnsupportedRequest(routing, {
      ...base,
      currentStatus: 'open',
      requestedStatus: 'open',
      callerSource,
    });
    expect(gate).toEqual(expected);
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

describe('routeRuntimeAction', () => {
  test('a runtime action becomes the runtime decision', () => {
    expect(routeRuntimeAction(parkStopped)).toEqual({
      reason: { action: 'runtime', executor: 'park_stopped' },
    });
  });
  test('a non-runtime action passes through', () => {
    expect(routeRuntimeAction(setStatus)).toEqual({ value: setStatus });
  });
});

describe('stampApproval', () => {
  test.each([
    ['review to done stamps human approval', 'review', 'done', 'human'],
    ['any other transition writes without approval', 'open', 'in_progress', undefined],
  ] as const)('%s', (_name, currentStatus, requestedStatus, approvalSource) => {
    const decision = stampApproval({
      ...base,
      currentStatus,
      requestedStatus,
      callerSource: 'rpc',
    });
    expect(decision).toEqual({ action: 'write', approvalSource });
  });
});
