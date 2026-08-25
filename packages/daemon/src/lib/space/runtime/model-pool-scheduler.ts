import { modelPoolEntryKey, pickModelPoolEntry } from '@hyperneo/shared';
import type { SpaceTask, SpaceWorkerAgent, WorkflowNodeAgent } from '@hyperneo/shared';
import { TransientSpawnError } from './workflow-node-execution-validation.ts';

const SPAWN_GRACE_MS = 15_000;

export interface ModelPoolAssignment {
  spaceId: string;
  taskId: string;
  model: string;
  assignedAt: number;
}

export type ModelPoolAssignmentMap = Map<string, ModelPoolAssignment>;

export function isPoolSessionActive(
  assignment: ModelPoolAssignment,
  sessionStatus: string | undefined,
  now: number
): boolean {
  if (sessionStatus === 'processing' || sessionStatus === 'queued') return true;
  if (sessionStatus === undefined) return false;
  return now - assignment.assignedAt < SPAWN_GRACE_MS;
}

export function countRunningModels(input: {
  assignments: ModelPoolAssignmentMap;
  spaceId: string;
  getSessionStatus: (sessionId: string) => string | undefined;
  now: number;
}): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [sessionId, assignment] of input.assignments) {
    if (assignment.spaceId !== input.spaceId) continue;
    const sessionStatus = input.getSessionStatus(sessionId);
    if (!isPoolSessionActive(assignment, sessionStatus, input.now)) {
      input.assignments.delete(sessionId);
      continue;
    }
    const key = modelPoolEntryKey(assignment);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function applyModelPoolToSlot(input: {
  slot: WorkflowNodeAgent;
  task: Pick<SpaceTask, 'workflowModelOverrides'>;
  node: { id: string };
  agent: SpaceWorkerAgent;
  spaceId: string;
  assignments: ModelPoolAssignmentMap;
  getSessionStatus: (sessionId: string) => string | undefined;
  now: number;
}): WorkflowNodeAgent {
  const overrideKey = `${input.node.id}:${input.slot.name}`;
  if (input.slot.model || input.task.workflowModelOverrides?.[overrideKey]) {
    return input.slot;
  }
  const pool = input.agent.modelPool;
  if (!pool || pool.length === 0) {
    return input.slot;
  }
  const runningCounts = countRunningModels({
    assignments: input.assignments,
    spaceId: input.spaceId,
    getSessionStatus: input.getSessionStatus,
    now: input.now,
  });
  const entry = pickModelPoolEntry(pool, runningCounts);
  if (!entry) {
    throw new TransientSpawnError(
      `Model pool for agent "${input.agent.name}" is at capacity in space ${input.spaceId} ` +
        `(${pool.map((candidate) => candidate.model).join(', ')}) — deferring spawn`
    );
  }
  return { ...input.slot, model: entry.model };
}
