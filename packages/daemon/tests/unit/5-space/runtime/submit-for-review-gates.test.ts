import { describe, expect, test } from 'bun:test';
import type { NodeExecution, Session, SpaceTask } from '@hyperneo/shared';
import {
  requireDirectReviewSubmitter,
  requireDirectReviewTask,
  requireManagedSubmission,
  requireNoUnownedAttempt,
  requireSubmitterInSpace,
  submittingNodeId,
} from '../../../../src/lib/tasks/submit-for-review';
import type { DirectTaskAttempt } from '../../../../src/storage/repositories/direct-task-execution-repository';
import type { SpaceMcpSessionPolicyContext } from '../../../../src/lib/space/runtime/space-mcp-session-policy';

const policy = {} as SpaceMcpSessionPolicyContext;
const task = (extra: Partial<SpaceTask> = {}) =>
  ({ id: 't1', spaceId: 's1', status: 'in_progress', archivedAt: null, ...extra }) as SpaceTask;
const evidence = (t: SpaceTask | null, extra: Record<string, unknown> = {}) => ({
  task: t,
  hasActiveAttempt: false,
  frozenReview: false,
  callerSession: null,
  callerExecution: null,
  ...extra,
});
const rpc = { source: 'rpc' as const };
const mcp = { source: 'mcp' as const, sessionId: 'w' };

describe('requireManagedSubmission', () => {
  test('defers standalone and direct-owned tasks and rejects archived ones', () => {
    expect(requireManagedSubmission(evidence(null))).toEqual({ reason: null });
    expect(requireManagedSubmission(evidence(task({ spaceId: '' })))).toEqual({ reason: null });
    const owned = task({ taskAgentSessionId: 'w' });
    expect(requireManagedSubmission(evidence(owned, { hasActiveAttempt: true }))).toEqual({
      reason: null,
    });
    expect(requireManagedSubmission(evidence(owned, { frozenReview: true }))).toEqual({
      reason: null,
    });
    expect(requireManagedSubmission(evidence(task({ archivedAt: 1 })))).toEqual({
      reason: { accepted: false, reason: 'review_submission_unavailable' },
    });
    const open = task();
    expect(requireManagedSubmission(evidence(open, { hasActiveAttempt: true }))).toEqual({
      value: open,
    });
  });
});

describe('requireSubmitterInSpace', () => {
  test('admits RPC callers and denies agents without an active session', () => {
    const t = task();
    expect(requireSubmitterInSpace(t, evidence(t), rpc, policy)).toEqual({ value: t });
    expect(requireSubmitterInSpace(t, evidence(t), mcp, policy)).toEqual({
      reason: { accepted: false, reason: 'review_submission_denied' },
    });
  });
});

describe('requireNoUnownedAttempt', () => {
  test('rejects an active attempt only on a task without a workflow run', () => {
    const plain = task();
    expect(requireNoUnownedAttempt(plain, evidence(plain, { hasActiveAttempt: true }))).toEqual({
      reason: { accepted: false, reason: 'review_submission_unavailable' },
    });
    const workflow = task({ workflowRunId: 'r1' });
    expect(
      requireNoUnownedAttempt(workflow, evidence(workflow, { hasActiveAttempt: true }))
    ).toEqual({ value: workflow });
  });
});

describe('submittingNodeId', () => {
  test('names the calling node only when it belongs to the task run', () => {
    const t = task({ workflowRunId: 'r1' });
    const execution = (workflowRunId: string) =>
      ({ workflowRunId, workflowNodeId: 'n1' }) as NodeExecution;
    expect(submittingNodeId(t, evidence(t, { callerExecution: execution('r1') }))).toBe('n1');
    expect(submittingNodeId(t, evidence(t, { callerExecution: execution('r2') }))).toBeNull();
    expect(submittingNodeId(t, evidence(t))).toBeNull();
  });
});

describe('requireDirectReviewTask', () => {
  test('requires a live Space-free-of-workflow task with a worker session and a matching status', () => {
    const unavailable = {
      reason: { accepted: false as const, reason: 'direct_review_submission_unavailable' },
    };
    expect(requireDirectReviewTask(null, { taskId: 't1' })).toEqual(unavailable);
    expect(requireDirectReviewTask(task(), { taskId: 't1' })).toEqual(unavailable);
    expect(
      requireDirectReviewTask(task({ taskAgentSessionId: 'w', workflowRunId: 'r1' }), {
        taskId: 't1',
      })
    ).toEqual(unavailable);
    const t = task({ taskAgentSessionId: 'w' }) as SpaceTask & { taskAgentSessionId: string };
    expect(requireDirectReviewTask(t, { taskId: 't1', expectedStatus: 'open' })).toEqual({
      reason: { accepted: false as const, reason: 'invalid_transition' },
    });
    expect(requireDirectReviewTask(t, { taskId: 't1' })).toEqual({ value: t });
  });
});

describe('requireDirectReviewSubmitter', () => {
  const t = task({ taskAgentSessionId: 'w' }) as SpaceTask & { taskAgentSessionId: string };
  const attempt = {
    id: 'a1',
    sessionId: 'w',
    generation: 1,
    phase: 'running',
  } as DirectTaskAttempt;
  const direct = (extra: Record<string, unknown> = {}) => ({
    attempt,
    active: attempt,
    session: null,
    frozen: null,
    ...extra,
  });
  const target = {
    attemptId: 'a1',
    sessionId: 'w',
    generation: 1,
    status: 'review' as const,
    reviewReason: 'ready',
  };

  test('rejects a missing attempt and admits RPC callers', () => {
    expect(
      requireDirectReviewSubmitter(t, direct({ attempt: null }), { taskId: 't1' }, rpc)
    ).toEqual({
      reason: { accepted: false as const, reason: 'direct_review_submission_unavailable' },
    });
    expect(
      requireDirectReviewSubmitter(t, direct(), { taskId: 't1', reason: 'ready' }, rpc)
    ).toEqual({ value: target });
  });

  test('denies agents that are not the attempt worker, and replays a frozen same request', () => {
    const denied = {
      reason: { accepted: false as const, reason: 'direct_review_submission_denied' },
    };
    expect(
      requireDirectReviewSubmitter(
        t,
        direct(),
        { taskId: 't1' },
        {
          source: 'mcp',
          sessionId: 'other',
        }
      )
    ).toEqual(denied);
    expect(requireDirectReviewSubmitter(t, direct(), { taskId: 't1' }, mcp)).toEqual(denied);
    const worker = {
      id: 'w',
      type: 'worker',
      status: 'ended',
      context: { taskId: 't1', spaceId: 's1' },
    } as unknown as Session;
    expect(
      requireDirectReviewSubmitter(
        t,
        direct({ session: worker, frozen: { status: 'review', reviewReason: 'ready' } }),
        { taskId: 't1', reason: 'ready' },
        mcp
      )
    ).toEqual({ value: target });
  });
});
