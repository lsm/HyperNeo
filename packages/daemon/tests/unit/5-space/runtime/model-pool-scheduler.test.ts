import { describe, expect, test } from 'bun:test';
import type {
  NodeExecution,
  SpaceTask,
  SpaceWorkerAgent,
  WorkflowNodeAgent,
} from '@hyperneo/shared';
import {
  applyModelPoolToSlot,
  commitModelPoolAssignment,
  countRunningModels,
  isPoolSessionActive,
  type ModelPoolAssignment,
  modelPoolReservationKey,
  releaseModelPoolReservation,
  reserveModelPoolSlot,
} from '../../../../src/lib/space/runtime/model-pool-scheduler';

const NOW = 1_000_000;

function makeAssignment(overrides: Partial<ModelPoolAssignment> = {}): ModelPoolAssignment {
  return {
    spaceId: 'space-1',
    taskId: 'task-1',
    model: 'sonnet',
    assignedAt: NOW,
    ...overrides,
  };
}

function makeAgent(pool?: SpaceWorkerAgent['modelPool']): SpaceWorkerAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    name: 'Coder',
    handle: 'coder',
    customPrompt: null,
    modelPool: pool,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const slot: WorkflowNodeAgent = { agentId: 'agent-1', name: 'coder' };
const task = {} as SpaceTask;
const node = { id: 'node-1' };

const pool = [
  { model: 'sonnet', maxConcurrent: 2, weight: 100 },
  { model: 'glm-5', maxConcurrent: 5, weight: 0 },
];

function apply(
  overrides: Partial<Parameters<typeof applyModelPoolToSlot>[0]> = {}
): ReturnType<typeof applyModelPoolToSlot> {
  return applyModelPoolToSlot({
    slot,
    task,
    node,
    agent: makeAgent(pool),
    spaceId: 'space-1',
    assignments: new Map(),
    getSessionStatus: () => 'processing',
    now: NOW,
    ...overrides,
  });
}

describe('isPoolSessionActive', () => {
  test('counts processing and queued sessions', () => {
    const assignment = makeAssignment({ assignedAt: NOW - 60_000 });
    expect(isPoolSessionActive(assignment, 'processing', NOW)).toBe(true);
    expect(isPoolSessionActive(assignment, 'queued', NOW)).toBe(true);
  });

  test('idle session only counts inside the spawn grace window', () => {
    const fresh = makeAssignment({ assignedAt: NOW - 1_000 });
    const stale = makeAssignment({ assignedAt: NOW - 60_000 });
    expect(isPoolSessionActive(fresh, 'idle', NOW)).toBe(true);
    expect(isPoolSessionActive(stale, 'idle', NOW)).toBe(false);
  });

  test('pending reservations always count', () => {
    const pending = makeAssignment({ pending: true, assignedAt: NOW - 60_000 });
    expect(isPoolSessionActive(pending, undefined, NOW)).toBe(true);
  });

  test('missing session never counts once no longer pending', () => {
    const fresh = makeAssignment({ assignedAt: NOW - 1_000 });
    expect(isPoolSessionActive(fresh, undefined, NOW)).toBe(false);
  });
});

test('countRunningModels purges dead sessions and groups by model', () => {
  const assignments = new Map<string, ModelPoolAssignment>([
    ['s1', makeAssignment()],
    ['s2', makeAssignment({ taskId: 'task-2' })],
    ['s3', makeAssignment({ model: 'glm-5' })],
    ['s4', makeAssignment({ spaceId: 'space-2' })],
    ['dead', makeAssignment({ taskId: 'task-3', assignedAt: NOW - 60_000 })],
  ]);
  const counts = countRunningModels({
    assignments,
    spaceId: 'space-1',
    getSessionStatus: (sessionId) =>
      sessionId === 'dead' || sessionId === 's4' ? 'idle' : 'processing',
    now: NOW,
  });
  expect(counts).toEqual({ sonnet: 2, 'glm-5': 1 });
  expect(assignments.has('dead')).toBe(false);
  expect(assignments.has('s4')).toBe(true);
});

test('pool picks a model with capacity and stamps it on the slot', () => {
  expect(apply()).toEqual({ slot: { ...slot, model: 'sonnet' }, model: 'sonnet' });
});

test('pool preserves the provider captured per entry', () => {
  const withProvider = [{ model: 'sonnet', provider: 'copilot', maxConcurrent: 2, weight: 10 }];
  expect(apply({ agent: makeAgent(withProvider) })).toEqual({
    slot: { ...slot, model: 'sonnet' },
    model: 'sonnet',
    provider: 'copilot',
  });
});

test('slot model override skips the pool entirely', () => {
  expect(apply({ slot: { ...slot, model: 'kimi-k3[1m]' } })).toEqual({
    slot: { ...slot, model: 'kimi-k3[1m]' },
    model: 'kimi-k3[1m]',
  });
});

test('task workflowModelOverrides skip the pool entirely', () => {
  const overridden = {
    workflowModelOverrides: { 'node-1:coder': 'kimi-k3[1m]' },
  } as unknown as SpaceTask;
  expect(apply({ task: overridden })).toEqual({ slot, model: '' });
});

test('agent without a pool keeps the slot unchanged', () => {
  expect(apply({ agent: makeAgent(undefined) })).toEqual({ slot, model: '' });
});

test('pool at capacity defers instead of throwing', () => {
  const assignments = new Map<string, ModelPoolAssignment>([
    ['s1', makeAssignment()],
    ['s2', makeAssignment({ taskId: 'task-2' })],
  ]);
  expect(apply({ assignments })).toEqual({ deferred: true });
});

describe('reservation lifecycle', () => {
  const execution = { id: 'exec-1' } as NodeExecution;

  test('reserve commits and releases atomically', () => {
    const assignments = new Map<string, ModelPoolAssignment>();
    reserveModelPoolSlot(assignments, execution, {
      spaceId: 'space-1',
      taskId: 'task-1',
      model: 'sonnet',
    });
    const key = modelPoolReservationKey(execution.id);
    expect(assignments.get(key)).toMatchObject({ pending: true, model: 'sonnet' });

    commitModelPoolAssignment(assignments, execution, 'session-9', {
      spaceId: 'space-1',
      taskId: 'task-1',
      model: 'sonnet',
    });
    expect(assignments.has(key)).toBe(false);
    expect(assignments.get('session-9')).toMatchObject({ model: 'sonnet' });
    expect(assignments.get('session-9')?.pending).toBeUndefined();

    releaseModelPoolReservation(assignments, execution);
    expect(assignments.size).toBe(1);
  });

  test('pending reservations hold capacity against concurrent spawns', () => {
    const assignments = new Map<string, ModelPoolAssignment>();
    reserveModelPoolSlot(assignments, { id: 'exec-1' } as NodeExecution, {
      spaceId: 'space-1',
      taskId: 'task-1',
      model: 'sonnet',
    });
    const counts = countRunningModels({
      assignments,
      spaceId: 'space-1',
      getSessionStatus: () => undefined,
      now: NOW,
    });
    expect(counts).toEqual({ sonnet: 1 });
    expect(apply({ assignments })).toEqual({ deferred: true });
  });
});
