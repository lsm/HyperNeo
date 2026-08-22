import { describe, expect, test } from 'bun:test';
import { decideGoalOwnershipMutationAdmission } from '../../../../src/lib/space/goals/goal-ownership-gates';

describe('decideGoalOwnershipMutationAdmission', () => {
  test('allows a coordinator agent invocation without a session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ callerRole: undefined, hasSession: false })
    ).toEqual({ action: 'allow' });
  });

  test('allows a coordinator session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ callerRole: 'coordinator', hasSession: true })
    ).toEqual({ action: 'allow' });
  });

  test('denies a long-term agent even with a display name of coordinator', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ callerRole: 'long_term_agent', hasSession: true })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });

  test('denies an ad-hoc member session (not proof of human operator)', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ callerRole: 'ad_hoc_member', hasSession: true })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });

  test('denies a workflow worker', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ callerRole: 'workflow_worker', hasSession: true })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });

  test('denies a legacy task agent', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ callerRole: 'legacy_task_agent', hasSession: true })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });

  test('denies an outside-space session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ callerRole: 'outside_space', hasSession: true })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });
});
