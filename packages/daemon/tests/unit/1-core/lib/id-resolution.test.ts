import { describe, test, expect } from 'bun:test';
import { resolveGoalId, type GoalRepoForResolve } from '../../../../src/lib/id-resolution';
import type { RoomGoal } from '@hyperneo/shared';

const ROOM_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const GOAL_UUID = 'f1e2d3c4-b5a6-4789-a123-456789abcdef';

function makeGoalRepo(goal: RoomGoal | null): GoalRepoForResolve {
  return {
    getGoalByShortId: (_roomId: string, _shortId: string) => goal,
  };
}

const stubGoal = { id: GOAL_UUID } as RoomGoal;

describe('resolveGoalId', () => {
  test('returns UUID directly without DB lookup', () => {
    const repo = makeGoalRepo(null);
    expect(resolveGoalId(GOAL_UUID, ROOM_ID, repo)).toBe(GOAL_UUID);
  });

  test('resolves short ID to UUID', () => {
    const repo = makeGoalRepo(stubGoal);
    expect(resolveGoalId('g-5', ROOM_ID, repo)).toBe(GOAL_UUID);
  });

  test('throws when short ID not found', () => {
    const repo = makeGoalRepo(null);
    expect(() => resolveGoalId('g-9999', ROOM_ID, repo)).toThrow('Goal not found: g-9999');
  });

  test('calls getGoalByShortId with correct roomId and shortId', () => {
    let calledWith: { roomId: string; shortId: string } | null = null;
    const repo: GoalRepoForResolve = {
      getGoalByShortId: (roomId, shortId) => {
        calledWith = { roomId, shortId };
        return stubGoal;
      },
    };
    resolveGoalId('g-3', ROOM_ID, repo);
    expect(calledWith).toEqual({ roomId: ROOM_ID, shortId: 'g-3' });
  });

  test('does not call getGoalByShortId for UUID input', () => {
    let called = false;
    const repo: GoalRepoForResolve = {
      getGoalByShortId: () => {
        called = true;
        return null;
      },
    };
    resolveGoalId(GOAL_UUID, ROOM_ID, repo);
    expect(called).toBe(false);
  });
});
