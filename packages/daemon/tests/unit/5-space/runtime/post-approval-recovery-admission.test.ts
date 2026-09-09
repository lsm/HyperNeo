import { describe, expect, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import {
  gateTaskEligibility,
  loadAdmissionFacts,
  type PostApprovalRecoveryAdmissionCtx,
  type PostApprovalRecoveryAdmissionDeps,
  runPostApprovalRecoveryAdmission,
} from '../../../../src/lib/space/runtime/post-approval-recovery-admission.ts';

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    status: 'approved',
    postApprovalSessionId: null,
    postApprovalBlockedReason: null,
    approvedAt: Date.now() - 300_000,
  } as SpaceTask;
}

function makeDeps(
  overrides: Partial<PostApprovalRecoveryAdmissionDeps> = {}
): PostApprovalRecoveryAdmissionDeps {
  return {
    isDispatchDead: () => false,
    isUnrecordedStale: () => true,
    cadencePending: () => false,
    markCadence: () => {},
    recoveryInFlight: () => false,
    hasLeasedClaim: () => false,
    isReviveBypassed: () => false,
    adoptBypassed: () => false,
    revive: async () => 'revived',
    adopt: async () => false,
    clearBypass: () => {},
    ...overrides,
  };
}

function makeCtx(
  deps: PostApprovalRecoveryAdmissionDeps = makeDeps(),
  overrides: Partial<PostApprovalRecoveryAdmissionCtx> = {}
): PostApprovalRecoveryAdmissionCtx {
  return {
    ...deps,
    task: makeTask(),
    generation: 3,
    now: Date.now(),
    dispatchDead: false,
    unrecordedStale: true,
    reviveBypassed: false,
    result: null,
    ...overrides,
  };
}

describe('post-approval recovery admission — stage gates', () => {
  test('loadAdmissionFacts computes dead, stale, and revive-bypass facts from deps', () => {
    const deps = makeDeps({
      isDispatchDead: () => true,
      isUnrecordedStale: () => false,
      isReviveBypassed: () => true,
    });
    const ctx = loadAdmissionFacts(makeCtx(deps));
    expect(ctx.dispatchDead).toBe(true);
    expect(ctx.unrecordedStale).toBe(false);
    expect(ctx.reviveBypassed).toBe(true);
    expect(ctx.result).toBeNull();
  });

  test('gateTaskEligibility halts ineligible tasks before cadence mutation', () => {
    const deps = makeDeps({ isUnrecordedStale: () => false });
    let cadenceMarked = false;
    deps.markCadence = () => {
      cadenceMarked = true;
    };
    const gated = gateTaskEligibility(
      makeCtx(deps, { dispatchDead: false, unrecordedStale: false })
    );
    expect(gated.result).toEqual({ reason: 'task-not-eligible' });
    expect(cadenceMarked).toBe(false);
  });

  test('gateTaskEligibility marks cadence then defers on pending cadence, in-flight, and lease', () => {
    const cadenceHalted = gateTaskEligibility(makeCtx(makeDeps({ cadencePending: () => true })));
    expect(cadenceHalted.result).toEqual({ reason: 'retry-cadence-pending' });

    const inFlightHalted = gateTaskEligibility(makeCtx(makeDeps({ recoveryInFlight: () => true })));
    expect(inFlightHalted.result).toEqual({ reason: 'recovery-in-flight' });

    const leasedHalted = gateTaskEligibility(makeCtx(makeDeps({ hasLeasedClaim: () => true })));
    expect(leasedHalted.result).toEqual({ reason: 'dispatch-claim-leased' });
  });
});

describe('post-approval recovery admission — pipeline routing', () => {
  test('routes a stale unrecorded approval through adoption to redispatch', async () => {
    const adoptedTasks: string[] = [];
    const outcome = await runPostApprovalRecoveryAdmission({
      ...makeDeps({
        adopt: async (task) => {
          adoptedTasks.push(task.id);
          return false;
        },
      }),
      task: makeTask(),
      generation: 1,
      now: Date.now(),
    });
    expect(adoptedTasks).toEqual(['task-1']);
    expect(outcome).toEqual({ value: { action: 'redispatch', task: expect.anything() } });
  });

  test('halts after a successful adoption without redispatching', async () => {
    const outcome = await runPostApprovalRecoveryAdmission({
      ...makeDeps({ adopt: async () => true }),
      task: makeTask(),
      generation: 1,
      now: Date.now(),
    });
    expect(outcome).toEqual({ reason: 'orphan-adopted' });
  });

  test('halts after a successful revival without adoption', async () => {
    const outcome = await runPostApprovalRecoveryAdmission({
      ...makeDeps({
        isDispatchDead: () => true,
        revive: async () => 'revived',
      }),
      task: makeTask({ postApprovalSessionId: 'session:dead' }),
      generation: 1,
      now: Date.now(),
    });
    expect(outcome).toEqual({ reason: 'worker-revived' });
  });

  test('a revive that must replace falls through to adoption', async () => {
    const adoptCalled: string[] = [];
    const outcome = await runPostApprovalRecoveryAdmission({
      ...makeDeps({
        isDispatchDead: () => true,
        revive: async () => 'replace',
        adopt: async (task) => {
          adoptCalled.push(task.id);
          return true;
        },
      }),
      task: makeTask({ postApprovalSessionId: null }),
      generation: 1,
      now: Date.now(),
    });
    expect(adoptCalled).toEqual(['task-1']);
    expect(outcome).toEqual({ reason: 'orphan-adopted' });
  });

  test('a recovery timeout halts admission', async () => {
    const outcome = await runPostApprovalRecoveryAdmission({
      ...makeDeps({
        isDispatchDead: () => true,
        revive: async () => 'timeout',
      }),
      task: makeTask({ postApprovalSessionId: 'session:dead' }),
      generation: 1,
      now: Date.now(),
    });
    expect(outcome).toEqual({ reason: 'recovery-await-timeout' });
  });
});
