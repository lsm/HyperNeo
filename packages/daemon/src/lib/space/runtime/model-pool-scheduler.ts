import { modelPoolEntryKey, pickModelPoolEntry } from '@hyperneo/shared';
import type {
  NodeExecution,
  SpaceTask,
  SpaceWorkerAgent,
  WorkflowNodeAgent,
} from '@hyperneo/shared';
import { TransientSpawnError } from './workflow-node-execution-validation.ts';

const SPAWN_GRACE_MS = 15_000;

export interface ModelPoolAssignment {
  spaceId: string;
  taskId: string;
  model: string;
  assignedAt: number;
  pending?: boolean;
}

export type ModelPoolAssignmentMap = Map<string, ModelPoolAssignment>;

export function modelPoolReservationKey(executionId: string): string {
  return `pending:${executionId}`;
}

export function isPoolSessionActive(
  assignment: ModelPoolAssignment,
  sessionStatus: string | undefined,
  now: number
): boolean {
  if (assignment.pending) return true;
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

export type ModelPoolApplication =
  | { slot: WorkflowNodeAgent; model: string; provider?: string }
  | { deferred: true };

export function applyModelPoolToSlot(input: {
  slot: WorkflowNodeAgent;
  task: Pick<SpaceTask, 'workflowModelOverrides'>;
  node: { id: string };
  agent: SpaceWorkerAgent;
  spaceId: string;
  assignments: ModelPoolAssignmentMap;
  getSessionStatus: (sessionId: string) => string | undefined;
  now: number;
}): ModelPoolApplication {
  const overrideKey = `${input.node.id}:${input.slot.name}`;
  if (input.slot.model || input.agent.model || input.task.workflowModelOverrides?.[overrideKey]) {
    return { slot: input.slot, model: input.slot.model ?? '' };
  }
  const pool = input.agent.modelPool;
  if (!pool || pool.length === 0) {
    return { slot: input.slot, model: input.slot.model ?? '' };
  }
  const runningCounts = countRunningModels({
    assignments: input.assignments,
    spaceId: input.spaceId,
    getSessionStatus: input.getSessionStatus,
    now: input.now,
  });
  const entry = pickModelPoolEntry(pool, runningCounts);
  if (!entry) {
    return { deferred: true };
  }
  return {
    slot: { ...input.slot, model: entry.model },
    model: entry.model,
    provider: entry.provider,
  };
}

export function reserveModelPoolSlot(
  assignments: ModelPoolAssignmentMap,
  execution: Pick<NodeExecution, 'id'>,
  assignment: Omit<ModelPoolAssignment, 'pending' | 'assignedAt'>
): void {
  assignments.set(modelPoolReservationKey(execution.id), {
    ...assignment,
    assignedAt: Date.now(),
    pending: true,
  });
}

export function activateModelPoolReservation(
  assignments: ModelPoolAssignmentMap,
  execution: Pick<NodeExecution, 'id'>,
  sessionId: string
): boolean {
  const key = modelPoolReservationKey(execution.id);
  const pending = assignments.get(key);
  if (!pending) return false;
  const activated = { ...pending, assignedAt: Date.now() };
  delete activated.pending;
  assignments.delete(key);
  assignments.set(sessionId, activated);
  return true;
}

export function releaseModelPoolReservation(
  assignments: ModelPoolAssignmentMap,
  execution: Pick<NodeExecution, 'id'>
): void {
  assignments.delete(modelPoolReservationKey(execution.id));
}

export function raiseModelPoolDeferred(agentName: string, spaceId: string): never {
  throw new TransientSpawnError(
    `Model pool for agent "${agentName}" is at capacity in space ${spaceId} — deferring spawn`
  );
}
