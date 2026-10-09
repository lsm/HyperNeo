import { describe, expect, test } from 'bun:test';
import type { Session, SpaceTask } from '@hyperneo/shared';
import {
  requireCancellerInSpace,
  requireDirectCanceller,
  requireDirectCancelTask,
  requireExpectedCancelStatus,
  requireManagedCancellation,
} from '../../../../src/lib/tasks/cancel-task';
import type { DirectTaskAttempt } from '../../../../src/storage/repositories/direct-task-execution-repository';
import type { SpaceMcpSessionPolicyContext } from '../../../../src/lib/space/runtime/space-mcp-session-policy';
import type { CancellationRoute } from '../../../../src/lib/tasks/cancel-route';

const policy = {} as SpaceMcpSessionPolicyContext;

const task = (extra: Partial<SpaceTask> = {}) =>
  ({ id: 't1', spaceId: 's1', status: 'open', archivedAt: null, ...extra }) as SpaceTask;
const rpc = { source: 'rpc' as const };
const mcp = { source: 'mcp' as const, sessionId: 'caller' };
const evidence = (t: SpaceTask | null, callerSession: Session | null = null) => ({
  task: t,
  callerSession,
});
const unavailable = { reason: { accepted: false, reason: 'cancellation_unavailable' } };

describe('requireManagedCancellation', () => {
  test.each([
    ['no task', null, { kind: 'plain' as const }, rpc, { reason: null }],
    ['a standalone task', task({ spaceId: '' }), null, rpc, { reason: null }],
    [
      'a direct route',
      task(),
      { kind: 'direct' as const, attempt: {} as DirectTaskAttempt },
      rpc,
      { reason: null },
    ],
    ['an archived task', task({ archivedAt: 1 }), { kind: 'plain' as const }, rpc, unavailable],
    [
      'a cancelled task',
      task({ status: 'cancelled' }),
      { kind: 'plain' as const },
      rpc,
      unavailable,
    ],
    ['done for an agent', task({ status: 'done' }), { kind: 'plain' as const }, mcp, unavailable],
  ] as Array<
    [string, SpaceTask | null, CancellationRoute | null, typeof rpc | typeof mcp, unknown]
  >)('rejects or defers %s', (_label, t, route, caller, expected) => {
    expect(requireManagedCancellation(evidence(t), route, caller)).toEqual(expected);
  });

  test('admits done for a person and an open plain or workflow task', () => {
    const done = task({ status: 'done' });
    expect(requireManagedCancellation(evidence(done), { kind: 'plain' }, rpc)).toEqual({
      value: done,
    });
    const open = task();
    expect(requireManagedCancellation(evidence(open), { kind: 'workflow' }, mcp)).toEqual({
      value: open,
    });
  });
});

describe('requireExpectedCancelStatus', () => {
  test('passes without an expected status or on a match, and rejects a mismatch', () => {
    const t = task();
    expect(requireExpectedCancelStatus(t, { taskId: 't1' })).toEqual({ value: t });
    expect(requireExpectedCancelStatus(t, { taskId: 't1', expectedStatus: 'open' })).toEqual({
      value: t,
    });
    expect(requireExpectedCancelStatus(t, { taskId: 't1', expectedStatus: 'in_progress' })).toEqual(
      { reason: { accepted: false, reason: 'invalid_transition' } }
    );
  });
});

describe('requireCancellerInSpace', () => {
  test('admits RPC callers and denies agents without an active session', () => {
    const t = task();
    expect(requireCancellerInSpace(t, evidence(t), rpc, policy, 'denied')).toEqual({ value: t });
    expect(requireCancellerInSpace(t, evidence(t), mcp, policy, 'denied')).toEqual({
      reason: { accepted: false, reason: 'denied' },
    });
    const ended = { id: 'caller', status: 'ended' } as unknown as Session;
    expect(requireCancellerInSpace(t, evidence(t, ended), mcp, policy, 'denied')).toEqual({
      reason: { accepted: false, reason: 'denied' },
    });
  });
});

describe('requireDirectCancelTask', () => {
  const directUnavailable = {
    reason: { accepted: false, reason: 'direct_cancellation_unavailable' },
  };
  test.each([
    ['no task', null],
    ['a standalone task', task({ spaceId: '', taskAgentSessionId: 'w' })],
    ['a workflow task', task({ workflowRunId: 'r1', taskAgentSessionId: 'w' })],
    ['a task without a worker session', task()],
    ['an archived task', task({ archivedAt: 1, taskAgentSessionId: 'w' })],
  ])('rejects %s', (_label, t) => {
    expect(requireDirectCancelTask(t)).toEqual(directUnavailable);
  });

  test('admits a Space task with a worker session', () => {
    const t = task({ taskAgentSessionId: 'w' });
    expect(requireDirectCancelTask(t)).toEqual({ value: t });
  });
});

describe('requireDirectCanceller', () => {
  const target = { attemptId: 'a1', sessionId: 'w', generation: 1, status: 'cancelled' as const };
  const t = task({ taskAgentSessionId: 'w' });
  test('rejects a missing attempt and admits RPC callers', () => {
    expect(requireDirectCanceller(t, null, evidence(t), rpc, policy)).toEqual({
      reason: { accepted: false, reason: 'direct_cancellation_unavailable' },
    });
    expect(
      requireDirectCanceller(t, { target, frozenStatus: null }, evidence(t), rpc, policy)
    ).toEqual({ value: target });
  });

  test('lets the worker repeat its own frozen cancel and denies other agents', () => {
    const worker = {
      id: 'w',
      type: 'worker',
      status: 'ended',
      context: { taskId: 't1', spaceId: 's1' },
    } as unknown as Session;
    expect(
      requireDirectCanceller(
        t,
        { target, frozenStatus: 'cancelled' },
        evidence(t, worker),
        mcp,
        policy
      )
    ).toEqual({ value: target });
    expect(
      requireDirectCanceller(t, { target, frozenStatus: null }, evidence(t, worker), mcp, policy)
    ).toEqual({ reason: { accepted: false, reason: 'direct_cancellation_denied' } });
  });
});
