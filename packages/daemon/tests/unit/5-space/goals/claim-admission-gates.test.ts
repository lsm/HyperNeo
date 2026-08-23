import { describe, expect, test } from 'bun:test';
import {
  decideClaimAdmission,
  type ClaimAdmissionInput,
} from '../../../../src/lib/space/goals/claim-admission-gates';

function input(overrides: Partial<ClaimAdmissionInput> = {}): ClaimAdmissionInput {
  return {
    actorAgentId: 'owner-1',
    authorizedAgentIds: ['owner-1'],
    humanAdmissionAllowed: false,
    notificationStatus: 'pending',
    notificationGoalId: 'goal-1',
    notificationTaskId: 'task-1',
    notificationGoalRevision: 1,
    claimedGoalId: 'goal-1',
    claimedTaskId: 'task-1',
    mutatesGoalState: true,
    isResubmission: false,
    observedGoalRevision: null,
    currentGoalRevision: 1,
    ...overrides,
  };
}

describe('decideClaimAdmission', () => {
  describe('authorized gate', () => {
    test('admits the resolved primary owner', () => {
      expect(decideClaimAdmission(input())).toEqual({ action: 'admit' });
    });

    test('admits the coordinator when it is the resolved recipient', () => {
      expect(
        decideClaimAdmission(
          input({ actorAgentId: 'coordinator-1', authorizedAgentIds: ['coordinator-1'] })
        )
      ).toEqual({ action: 'admit' });
    });

    test('denies a stale non-primary owner that is not the resolved identity', () => {
      expect(
        decideClaimAdmission(input({ actorAgentId: 'owner-2', authorizedAgentIds: ['owner-1'] }))
      ).toEqual({ action: 'deny', reason: 'unauthorized' });
    });

    test('admits a human operator when human admission is allowed', () => {
      expect(
        decideClaimAdmission(input({ actorAgentId: null, humanAdmissionAllowed: true }))
      ).toEqual({ action: 'admit' });
    });

    test('denies a human operator when human admission is not allowed', () => {
      expect(decideClaimAdmission(input({ actorAgentId: null }))).toEqual({
        action: 'deny',
        reason: 'unauthorized',
      });
    });

    test('denies an unrelated agent', () => {
      expect(decideClaimAdmission(input({ actorAgentId: 'some-other-agent' }))).toEqual({
        action: 'deny',
        reason: 'unauthorized',
      });
    });
  });

  describe('unsuperseded gate', () => {
    test('denies a superseded notification', () => {
      expect(decideClaimAdmission(input({ notificationStatus: 'superseded' }))).toEqual({
        action: 'deny',
        reason: 'superseded',
      });
    });

    test('denies an acknowledged notification', () => {
      expect(decideClaimAdmission(input({ notificationStatus: 'acknowledged' }))).toEqual({
        action: 'deny',
        reason: 'superseded',
      });
    });

    test('denies a rejected notification', () => {
      expect(decideClaimAdmission(input({ notificationStatus: 'rejected' }))).toEqual({
        action: 'deny',
        reason: 'superseded',
      });
    });
  });

  describe('identity-bound gate', () => {
    test('denies a claim for a different goal than the notification binds', () => {
      expect(decideClaimAdmission(input({ claimedGoalId: 'goal-2' }))).toEqual({
        action: 'deny',
        reason: 'identity_mismatch',
      });
    });

    test('denies a claim for a different task than the notification binds', () => {
      expect(decideClaimAdmission(input({ claimedTaskId: 'task-2' }))).toEqual({
        action: 'deny',
        reason: 'identity_mismatch',
      });
    });
  });

  describe('revision-match gate', () => {
    test('admits an initial claim whose notification revision matches the current goal', () => {
      expect(decideClaimAdmission(input())).toEqual({ action: 'admit' });
    });

    test('denies an initial claim based on a stale notification revision', () => {
      expect(
        decideClaimAdmission(input({ notificationGoalRevision: 0, currentGoalRevision: 1 }))
      ).toEqual({ action: 'deny', reason: 'stale_revision' });
    });

    test('ignores a caller-supplied revision on an initial claim', () => {
      expect(
        decideClaimAdmission(
          input({
            notificationGoalRevision: 0,
            currentGoalRevision: 1,
            observedGoalRevision: 1,
          })
        )
      ).toEqual({ action: 'deny', reason: 'stale_revision' });
    });

    test('denies a stale resubmission with an older observed revision', () => {
      expect(
        decideClaimAdmission(input({ isResubmission: true, observedGoalRevision: 0 }))
      ).toEqual({ action: 'deny', reason: 'stale_revision' });
    });

    test('admits a resubmission whose observed revision still matches', () => {
      expect(
        decideClaimAdmission(input({ isResubmission: true, observedGoalRevision: 1 }))
      ).toEqual({ action: 'admit' });
    });

    test('denies a resubmission observed against a newer goal snapshot', () => {
      expect(
        decideClaimAdmission(input({ isResubmission: true, observedGoalRevision: 2 }))
      ).toEqual({ action: 'deny', reason: 'stale_revision' });
    });

    test('skips the CAS for terminal-only dispositions that do not mutate goal state', () => {
      expect(
        decideClaimAdmission(
          input({ isResubmission: true, observedGoalRevision: 0, mutatesGoalState: false })
        )
      ).toEqual({ action: 'admit' });
    });
  });

  describe('first-denial-wins ordering', () => {
    test('unauthorized takes precedence over a stale revision', () => {
      expect(
        decideClaimAdmission(
          input({ actorAgentId: 'some-other-agent', isResubmission: true, observedGoalRevision: 0 })
        )
      ).toEqual({ action: 'deny', reason: 'unauthorized' });
    });

    test('superseded takes precedence over an identity mismatch', () => {
      expect(
        decideClaimAdmission(input({ notificationStatus: 'superseded', claimedGoalId: 'goal-2' }))
      ).toEqual({ action: 'deny', reason: 'superseded' });
    });

    test('identity mismatch takes precedence over a stale revision', () => {
      expect(
        decideClaimAdmission(
          input({ claimedGoalId: 'goal-2', isResubmission: true, observedGoalRevision: 0 })
        )
      ).toEqual({ action: 'deny', reason: 'identity_mismatch' });
    });
  });
});
