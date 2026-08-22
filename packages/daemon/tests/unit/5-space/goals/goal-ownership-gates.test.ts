import { describe, expect, test } from 'bun:test';
import { decideGoalOwnershipMutationAdmission } from '../../../../src/lib/space/goals/goal-ownership-gates';

describe('decideGoalOwnershipMutationAdmission', () => {
  test('allows the coordinator agent (no session)', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ callerRole: undefined, isCoordinatorAgent: true })
    ).toEqual({ action: 'allow' });
  });

  test('allows a coordinator session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ callerRole: 'coordinator', isCoordinatorAgent: true })
    ).toEqual({ action: 'allow' });
  });

  test('allows an ad-hoc member (explicit human) session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({
        callerRole: 'ad_hoc_member',
        isCoordinatorAgent: false,
      })
    ).toEqual({ action: 'allow' });
  });

  test('denies a workflow worker', () => {
    expect(
      decideGoalOwnershipMutationAdmission({
        callerRole: 'workflow_worker',
        isCoordinatorAgent: false,
      })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });

  test('denies a long-term agent', () => {
    expect(
      decideGoalOwnershipMutationAdmission({
        callerRole: 'long_term_agent',
        isCoordinatorAgent: false,
      })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });

  test('denies a legacy task agent', () => {
    expect(
      decideGoalOwnershipMutationAdmission({
        callerRole: 'legacy_task_agent',
        isCoordinatorAgent: false,
      })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });

  test('denies an outside-space session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({
        callerRole: 'outside_space',
        isCoordinatorAgent: false,
      })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });
});
