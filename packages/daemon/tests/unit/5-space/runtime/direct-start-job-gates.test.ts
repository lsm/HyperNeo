import { describe, expect, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import type { DirectTaskAttempt } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  decideStartFollowUp,
  decideStartRequeue,
  requireLinkedStart,
  requireStartNotFinished,
} from '../../../../src/lib/tasks/direct-start-jobs';
import { directTaskStartIdentity } from '../../../../src/lib/tasks/start-direct-task';
import { DIRECT_TASK_PARK_BUDGET } from '../../../../src/lib/tasks/park-budget';

const input = { taskId: 't1', requestKey: 'k' };
const attemptId = directTaskStartIdentity(input).attemptId;
const attempt = (extra: Partial<DirectTaskAttempt> = {}) =>
  ({
    id: attemptId,
    taskId: 't1',
    sessionId: 'w',
    phase: 'reserved',
    ...extra,
  }) as DirectTaskAttempt;
const request = { input, jobId: 'j1', lifecycleGeneration: 4 };
const superseded = { reason: { started: false as const, reason: 'superseded' } };

describe('requireLinkedStart', () => {
  type Evidence = Parameters<typeof requireLinkedStart>[0];
  const evidence = (extra: Partial<Evidence> = {}): Evidence => ({
    attemptId,
    request,
    attempt: attempt(),
    activeId: attemptId,
    ...extra,
  });

  test('rejects an unlinked job', () => {
    expect(requireLinkedStart(evidence({ attemptId: null }), { id: 'j1' })).toEqual({
      reason: { started: false as const, reason: 'unlinked_job' },
    });
  });

  test.each([
    ['no start request', { request: null }],
    ['no attempt', { attempt: null }],
    ['another task', { attempt: attempt({ taskId: 't2' }) }],
    ['another attempt identity', { attempt: attempt({ id: 'other' }), activeId: 'other' }],
    ['a replaced active attempt', { activeId: 'other' }],
  ] as const)('supersedes %s', (_label, extra) => {
    expect(requireLinkedStart(evidence(extra), { id: 'j1' })).toEqual(superseded);
  });

  test('supersedes a request owned by another job and links a current one', () => {
    expect(requireLinkedStart(evidence(), { id: 'j2' })).toEqual(superseded);
    expect(requireLinkedStart(evidence(), { id: 'j1' })).toEqual({
      value: { request, attempt: attempt() },
    });
  });
});

describe('requireStartNotFinished', () => {
  test('finishes a started attempt and passes a pending one on', () => {
    const started = { started: true as const, attempt: attempt() };
    expect(requireStartNotFinished(started)).toEqual({ reason: started });
    const pending = { started: false as const, reason: 'awaiting_capacity' };
    expect(requireStartNotFinished(pending)).toEqual({ value: pending });
  });
});

describe('decideStartFollowUp', () => {
  type Evidence = Parameters<typeof decideStartFollowUp>[0];
  const linked = { request, attempt: attempt() };
  const evidence = (extra: Partial<Evidence> = {}): Evidence => ({
    current: attempt(),
    task: { id: 't1', status: 'open', workflowRunId: null, archivedAt: null } as SpaceTask,
    spaceActive: true,
    lifecycleGeneration: 4,
    retiring: false,
    stopRequested: false,
    ...extra,
  });
  const retire = (current: DirectTaskAttempt) => ({
    value: { kind: 'retire' as const, current },
  });

  test('supersedes when another attempt is current', () => {
    expect(decideStartFollowUp(evidence({ current: null }), linked)).toEqual(superseded);
  });

  test.each([
    ['a missing task', { task: null }],
    ['an inactive Space', { spaceActive: false }],
    ['a moved lifecycle generation', { lifecycleGeneration: 5 }],
    ['a retiring stop', { retiring: true }],
  ] as const)('retires a reserved attempt on %s', (_label, extra) => {
    expect(decideStartFollowUp(evidence(extra), linked)).toEqual(retire(attempt()));
  });

  test('supersedes a running attempt that should retire, or any requested stop', () => {
    const running = attempt({ phase: 'running' });
    expect(decideStartFollowUp(evidence({ current: running, retiring: true }), linked)).toEqual(
      superseded
    );
    expect(decideStartFollowUp(evidence({ stopRequested: true }), linked)).toEqual(superseded);
  });

  test('requeues a live reservation without cleanup', () => {
    expect(decideStartFollowUp(evidence(), linked)).toEqual({
      value: { kind: 'requeue' as const, cleanup: false },
    });
  });
});

describe('decideStartRequeue', () => {
  const job = (payload: Record<string, unknown> = {}) =>
    ({ id: 'j1', claimToken: 'c', payload }) as unknown as Job;
  const requeue = { kind: 'requeue' as const, cleanup: false };

  test('waits on activation waits and parks anything else', () => {
    expect(
      decideStartRequeue(job(), { started: false, reason: 'awaiting_capacity' }, requeue, 100)
    ).toEqual({ kind: 'wait', claimToken: 'c', runAt: 30_100 });
    expect(decideStartRequeue(job(), { started: false, reason: 'busy' }, requeue, 100)).toEqual({
      kind: 'park',
      claimToken: 'c',
      runAt: 30_100,
      parked: 'direct_start_not_ready',
    });
  });

  test('parks an unverified cleanup even on an activation wait', () => {
    expect(
      decideStartRequeue(
        job(),
        { started: false, reason: 'awaiting_capacity' },
        { kind: 'requeue', cleanup: true },
        0
      )
    ).toMatchObject({ kind: 'park', parked: 'direct_start_cleanup_unverified' });
  });

  test('throws without a claim token or once the park budget is spent', () => {
    const result = { started: false as const, reason: 'busy' };
    expect(() =>
      decideStartRequeue({ ...job(), claimToken: null } as unknown as Job, result, requeue, 0)
    ).toThrow('Direct start remains unavailable: busy');
    expect(() =>
      decideStartRequeue(job({ __parkCount: DIRECT_TASK_PARK_BUDGET.maxParks }), result, requeue, 0)
    ).toThrow('park_count_exceeded');
  });
});
