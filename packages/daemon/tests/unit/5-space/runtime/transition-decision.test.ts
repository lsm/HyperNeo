import { expect, test } from 'bun:test';
import {
  decideSpaceTaskTransition,
  type SpaceTaskTransitionDecision,
  type SpaceTaskTransitionDecisionInput,
} from '../../../../src/lib/space/operations/transition-decision';

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
