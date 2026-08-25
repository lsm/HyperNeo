import { describe, expect, test } from 'bun:test';
import type { SpaceTask, SpaceWorkerAgent, WorkflowNodeAgent } from '@hyperneo/shared';
import {
  applyModelPoolToSlot,
  countRunningModels,
  isPoolSessionActive,
  type ModelPoolAssignment,
} from '../../../../src/lib/space/runtime/model-pool-scheduler';
import { isTransientSpawnError } from '../../../../src/lib/space/runtime/workflow-node-execution-validation';

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
): WorkflowNodeAgent {
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

  test('missing session never counts', () => {
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
  expect(apply().model).toBe('sonnet');
});

test('slot model override skips the pool entirely', () => {
  expect(apply({ slot: { ...slot, model: 'kimi-k3[1m]' } }).model).toBe('kimi-k3[1m]');
});

test('task workflowModelOverrides skip the pool entirely', () => {
  const overridden = {
    workflowModelOverrides: { 'node-1:coder': 'kimi-k3[1m]' },
  } as unknown as SpaceTask;
  expect(apply({ task: overridden })).toEqual(slot);
});

test('agent without a pool keeps the slot unchanged', () => {
  const untouched = apply({ agent: makeAgent(undefined) });
  expect(untouched).toEqual(slot);
});

test('pool at capacity raises a transient spawn error so the tick defers', () => {
  const assignments = new Map<string, ModelPoolAssignment>([
    ['s1', makeAssignment()],
    ['s2', makeAssignment({ taskId: 'task-2' })],
  ]);
  let raised: unknown = null;
  try {
    apply({ assignments });
  } catch (err) {
    raised = err;
  }
  expect(isTransientSpawnError(raised)).toBe(true);
  expect((raised as Error).message).toContain('at capacity');
});
