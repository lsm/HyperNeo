import { describe, expect, test } from 'bun:test';
import {
  decideClaimAdmission,
  type ClaimAdmissionInput,
} from '../../../../src/lib/space/goals/claim-admission-gates';

function input(overrides: Partial<ClaimAdmissionInput> = {}): ClaimAdmissionInput {
  return {
    actorAgentId: 'owner-1',
    ownerAgentIds: ['owner-1'],
    coordinatorAgentId: 'coordinator-1',
    coordinatorIsFallback: false,
    humanAdmissionAllowed: false,
    notificationStatus: 'pending',
    notificationGoalId: 'goal-1',
    notificationTaskId: 'task-1',
    claimedGoalId: 'goal-1',
    claimedTaskId: 'task-1',
    mutatesGoalState: true,
    observedGoalRevision: 1,
    currentGoalRevision: 1,
    ...overrides,
  };
}

describe('decideClaimAdmission', () => {
  describe('authorized gate', () => {
    test('admits the current primary owner', () => {
      expect(decideClaimAdmission(input())).toEqual({ action: 'admit' });
    });

    test('admits the coordinator when it is the resolved fallback', () => {
      expect(
        decideClaimAdmission(
          input({ actorAgentId: 'coordinator-1', ownerAgentIds: [], coordinatorIsFallback: true })
        )
      ).toEqual({ action: 'admit' });
    });

    test('denies the coordinator while an active owner exists', () => {
      expect(decideClaimAdmission(input({ actorAgentId: 'coordinator-1' }))).toEqual({
        action: 'deny',
        reason: 'unauthorized',
      });
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
    test('denies a stale resubmission with an older observed revision', () => {
      expect(decideClaimAdmission(input({ observedGoalRevision: 0 }))).toEqual({
        action: 'deny',
        reason: 'stale_revision',
      });
    });

    test('denies a claim observed against a newer goal snapshot', () => {
      expect(decideClaimAdmission(input({ observedGoalRevision: 2 }))).toEqual({
        action: 'deny',
        reason: 'stale_revision',
      });
    });

    test('skips the CAS for terminal-only dispositions that do not mutate goal state', () => {
      expect(
        decideClaimAdmission(input({ observedGoalRevision: 0, mutatesGoalState: false }))
      ).toEqual({ action: 'admit' });
    });
  });

  describe('first-denial-wins ordering', () => {
    test('unauthorized takes precedence over a stale revision', () => {
      expect(
        decideClaimAdmission(input({ actorAgentId: 'some-other-agent', observedGoalRevision: 0 }))
      ).toEqual({ action: 'deny', reason: 'unauthorized' });
    });

    test('superseded takes precedence over an identity mismatch', () => {
      expect(
        decideClaimAdmission(input({ notificationStatus: 'superseded', claimedGoalId: 'goal-2' }))
      ).toEqual({ action: 'deny', reason: 'superseded' });
    });

    test('identity mismatch takes precedence over a stale revision', () => {
      expect(
        decideClaimAdmission(input({ claimedGoalId: 'goal-2', observedGoalRevision: 0 }))
      ).toEqual({ action: 'deny', reason: 'identity_mismatch' });
    });
  });
});
