import { describe, expect, test } from 'bun:test';
import { decideGoalOwnershipMutationAdmission } from '../../../../src/lib/space/goals/goal-ownership-gates';

describe('decideGoalOwnershipMutationAdmission', () => {
  test('allows a human invocation without a session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ hasSpaceAuthority: false, hasSession: false })
    ).toEqual({ action: 'allow' });
  });

  test('allows a Space agent session', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ hasSpaceAuthority: true, hasSession: true })
    ).toEqual({ action: 'allow' });
  });

  test('denies a session without Space authority', () => {
    expect(
      decideGoalOwnershipMutationAdmission({ hasSpaceAuthority: false, hasSession: true })
    ).toMatchObject({ action: 'deny', reason: 'not_space_agent_or_human' });
  });
});
