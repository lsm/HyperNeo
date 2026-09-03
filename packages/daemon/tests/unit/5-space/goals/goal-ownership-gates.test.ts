import { describe, expect, test } from 'bun:test';
import { decideGoalOwnershipMutationAdmission } from '../../../../src/lib/space/goals/goal-ownership-gates';

describe('decideGoalOwnershipMutationAdmission', () => {
  test('allows a human invocation without a session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ isDefaultAgent: false, hasSession: false })
    ).toEqual({ action: 'allow' });
  });

  test('allows the default agent session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ isDefaultAgent: true, hasSession: true })
    ).toEqual({ action: 'allow' });
  });

  test('denies a long-term agent even with a display name of coordinator', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ isDefaultAgent: false, hasSession: true })
    ).toMatchObject({ action: 'deny', reason: 'not_coordinator_or_human' });
  });
});
