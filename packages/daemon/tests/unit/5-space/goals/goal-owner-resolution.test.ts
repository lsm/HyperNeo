import { describe, expect, test } from 'bun:test';
import {
  decideGoalOwnerResolution,
  type GoalOwnerCandidate,
  type GoalOwnerResolutionInput,
} from '../../../../src/lib/space/goals/goal-owner-resolution';

const active = { state: 'active' } as const;
const missing = { state: 'missing' } as const;
const paused = { state: 'paused' } as const;
const disabled = { state: 'disabled' } as const;
const archived = { state: 'archived' } as const;

function owner(agentId: string, createdAt: number): GoalOwnerCandidate {
  return { agentId, relationship: 'owner', createdAt };
}

function input(overrides: Partial<GoalOwnerResolutionInput> = {}): GoalOwnerResolutionInput {
  return {
    candidates: [],
    agentStates: {},
    coordinatorAgentId: 'coordinator-1',
    ...overrides,
  };
}

describe('decideGoalOwnerResolution', () => {
  test('resolves a single active primary owner', () => {
    const result = decideGoalOwnerResolution(
      input({ candidates: [owner('agent-a', 100)], agentStates: { 'agent-a': active } })
    );
    expect(result).toEqual({
      action: 'resolved',
      owner: owner('agent-a', 100),
      conflicts: [],
    });
  });

  test('prefers owner relationship over manager/watcher candidates', () => {
    const result = decideGoalOwnerResolution(
      input({
        candidates: [
          { agentId: 'agent-w', relationship: 'watcher', createdAt: 50 },
          { agentId: 'agent-m', relationship: 'manager', createdAt: 75 },
          { agentId: 'agent-o', relationship: 'owner', createdAt: 100 },
        ],
        agentStates: { 'agent-o': active, 'agent-w': active, 'agent-m': active },
      })
    );
    expect(result).toEqual({
      action: 'resolved',
      owner: owner('agent-o', 100),
      conflicts: [],
    });
  });

  test('degrades when the owner agent is paused', () => {
    const result = decideGoalOwnerResolution(
      input({ candidates: [owner('agent-a', 100)], agentStates: { 'agent-a': paused } })
    );
    expect(result).toEqual({
      action: 'degraded',
      reason: 'paused',
      owner: owner('agent-a', 100),
      conflicts: [],
    });
  });

  test('degrades when the owner agent is disabled', () => {
    const result = decideGoalOwnerResolution(
      input({ candidates: [owner('agent-a', 100)], agentStates: { 'agent-a': disabled } })
    );
    expect(result).toEqual({
      action: 'degraded',
      reason: 'disabled',
      owner: owner('agent-a', 100),
      conflicts: [],
    });
  });

  test('degrades when the owner agent is archived', () => {
    const result = decideGoalOwnerResolution(
      input({ candidates: [owner('agent-a', 100)], agentStates: { 'agent-a': archived } })
    );
    expect(result).toEqual({
      action: 'degraded',
      reason: 'archived',
      owner: owner('agent-a', 100),
      conflicts: [],
    });
  });

  test('degrades when the owner agent is missing from the snapshot', () => {
    const result = decideGoalOwnerResolution(
      input({ candidates: [owner('agent-a', 100)], agentStates: {} })
    );
    expect(result).toEqual({
      action: 'degraded',
      reason: 'missing',
      owner: owner('agent-a', 100),
      conflicts: [],
    });
  });

  test('falls back to the coordinator when there is no owner row', () => {
    const result = decideGoalOwnerResolution(input({ candidates: [] }));
    expect(result).toEqual({ action: 'coordinator_fallback' });
  });

  test('falls back to the coordinator when only non-owner relationships exist', () => {
    const result = decideGoalOwnerResolution(
      input({
        candidates: [{ agentId: 'agent-w', relationship: 'watcher', createdAt: 50 }],
        agentStates: { 'agent-w': active },
      })
    );
    expect(result).toEqual({ action: 'coordinator_fallback' });
  });

  test('resolves duplicate owners deterministically to the earliest assignment', () => {
    const result = decideGoalOwnerResolution(
      input({
        candidates: [owner('agent-late', 200), owner('agent-early', 100)],
        agentStates: { 'agent-late': active, 'agent-early': active },
      })
    );
    expect(result).toEqual({
      action: 'resolved',
      owner: owner('agent-early', 100),
      conflicts: [owner('agent-late', 200)],
    });
  });

  test('breaks duplicate-owner ties deterministically by agent id', () => {
    const result = decideGoalOwnerResolution(
      input({
        candidates: [owner('agent-z', 100), owner('agent-a', 100)],
        agentStates: { 'agent-z': active, 'agent-a': active },
      })
    );
    expect(result).toEqual({
      action: 'resolved',
      owner: owner('agent-a', 100),
      conflicts: [owner('agent-z', 100)],
    });
  });

  test('degraded duplicates keep the earliest owner and expose the losers', () => {
    const result = decideGoalOwnerResolution(
      input({
        candidates: [owner('agent-late', 200), owner('agent-early', 100)],
        agentStates: { 'agent-late': active, 'agent-early': paused },
      })
    );
    expect(result).toEqual({
      action: 'degraded',
      reason: 'paused',
      owner: owner('agent-early', 100),
      conflicts: [owner('agent-late', 200)],
    });
  });

  test('is deterministic given the same snapshot', () => {
    const snapshot: GoalOwnerResolutionInput = input({
      candidates: [owner('agent-b', 150), owner('agent-a', 120), owner('agent-c', 120)],
      agentStates: { 'agent-a': active, 'agent-b': paused, 'agent-c': active },
    });
    const first = decideGoalOwnerResolution(snapshot);
    const second = decideGoalOwnerResolution(snapshot);
    expect(second).toEqual(first);
  });

  test('ignores agent state entries for agents with no candidate', () => {
    const result = decideGoalOwnerResolution(
      input({
        candidates: [owner('agent-a', 100)],
        agentStates: { ghost: active, 'agent-a': active },
      })
    );
    expect(result).toEqual({
      action: 'resolved',
      owner: owner('agent-a', 100),
      conflicts: [],
    });
  });
});
