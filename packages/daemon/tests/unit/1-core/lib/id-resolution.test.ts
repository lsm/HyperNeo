import { describe, test, expect } from 'bun:test';
import {
  resolveTaskId,
  resolveGoalId,
  type TaskRepoForResolve,
  type GoalRepoForResolve,
} from '../../../../src/lib/id-resolution';
import type { NeoTask, RoomGoal } from '@hyperneo/shared';

const ROOM_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TASK_UUID = 'd8a578c6-d3cb-4c84-926b-958cbd433d32';
const GOAL_UUID = 'f1e2d3c4-b5a6-4789-a123-456789abcdef';

function makeTaskRepo(task: NeoTask | null): TaskRepoForResolve {
  return {
    getTaskByShortId: (_roomId: string, _shortId: string) => task,
  };
}

function makeGoalRepo(goal: RoomGoal | null): GoalRepoForResolve {
  return {
    getGoalByShortId: (_roomId: string, _shortId: string) => goal,
  };
}

const stubTask = { id: TASK_UUID } as NeoTask;
const stubGoal = { id: GOAL_UUID } as RoomGoal;

describe('resolveTaskId', () => {
  test('returns UUID directly without DB lookup', () => {
    const repo = makeTaskRepo(null);
    expect(resolveTaskId(TASK_UUID, ROOM_ID, repo)).toBe(TASK_UUID);
  });

  test('resolves short ID to UUID', () => {
    const repo = makeTaskRepo(stubTask);
    expect(resolveTaskId('t-42', ROOM_ID, repo)).toBe(TASK_UUID);
  });

  test('throws when short ID not found', () => {
    const repo = makeTaskRepo(null);
    expect(() => resolveTaskId('t-9999', ROOM_ID, repo)).toThrow('Task not found: t-9999');
  });

  test('calls getTaskByShortId with correct roomId and shortId', () => {
    let calledWith: { roomId: string; shortId: string } | null = null;
    const repo: TaskRepoForResolve = {
      getTaskByShortId: (roomId, shortId) => {
        calledWith = { roomId, shortId };
        return stubTask;
      },
    };
    resolveTaskId('t-7', ROOM_ID, repo);
    expect(calledWith).toEqual({ roomId: ROOM_ID, shortId: 't-7' });
  });

  test('does not call getTaskByShortId for UUID input', () => {
    let called = false;
    const repo: TaskRepoForResolve = {
      getTaskByShortId: () => {
        called = true;
        return null;
      },
    };
    resolveTaskId(TASK_UUID, ROOM_ID, repo);
    expect(called).toBe(false);
  });
});

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
