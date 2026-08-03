import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { isRateOrUsageLimited, resolveNodeAgents } from '@hyperneo/shared';

export type ExecutionWorkflowValidationResult =
  | { valid: true }
  | { valid: false; reason: string; permanent: true };

export class PermanentSpawnError extends Error {
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = 'PermanentSpawnError';
  }
}

export function isPermanentSpawnError(err: unknown): err is PermanentSpawnError {
  return err instanceof PermanentSpawnError;
}

/**
 * A spawn that should be *deferred* (not attempted now), not treated as a crash
 * or a permanent failure. Used for a task paused on a rate/usage cap: the
 * runtime leaves the execution `pending` and re-attempts on a later tick once
 * `recoverRateLimitedTasks` restores the task. Throwing `PermanentSpawnError`
 * instead would cancel + unregister the execution, so a transient cooldown would
 * permanently remove the target agent.
 */
export class TransientSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientSpawnError';
  }
}

export function isTransientSpawnError(err: unknown): err is TransientSpawnError {
  return err instanceof TransientSpawnError;
}

export function validateExecutionAgainstWorkflow(
  execution: NodeExecution,
  workflow: SpaceWorkflow | null | undefined
): ExecutionWorkflowValidationResult {
  if (!workflow) {
    return {
      valid: false,
      reason: `Workflow for execution ${execution.id} no longer exists`,
      permanent: true,
    };
  }

  const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
  if (!node) {
    return {
      valid: false,
      reason: `Workflow node ${execution.workflowNodeId} no longer exists in workflow definition`,
      permanent: true,
    };
  }

  let nodeAgents: ReturnType<typeof resolveNodeAgents>;
  try {
    nodeAgents = resolveNodeAgents(node);
  } catch (err) {
    return {
      valid: false,
      reason: `Workflow node ${execution.workflowNodeId} has invalid agent configuration: ${err instanceof Error ? err.message : String(err)}`,
      permanent: true,
    };
  }

  const slot = nodeAgents.find((agentSlot) => agentSlot.name === execution.agentName);
  if (!slot?.agentId) {
    return {
      valid: false,
      reason: `Agent slot ${execution.agentName} no longer exists on workflow node ${execution.workflowNodeId}`,
      permanent: true,
    };
  }
  if (execution.agentId && slot.agentId !== execution.agentId) {
    return {
      valid: false,
      reason: `Agent slot ${execution.agentName} on workflow node ${execution.workflowNodeId} now references agent ${slot.agentId} instead of ${execution.agentId}`,
      permanent: true,
    };
  }

  return { valid: true };
}

export function assertExecutionValidAgainstWorkflow(
  execution: NodeExecution,
  workflow: SpaceWorkflow | null | undefined
): void {
  const validation = validateExecutionAgainstWorkflow(execution, workflow);
  if (!validation.valid) throw new PermanentSpawnError(validation.reason);
}

export function validateTaskAllowsSpawn(task: SpaceTask): void {
  if (task.status === 'archived' || task.status === 'cancelled') {
    throw new PermanentSpawnError(
      `Task ${task.id} is ${task.status}; workflow node execution cannot be spawned`
    );
  }
  // A task paused on a rate/usage cap is in a cooldown — its worker must not be
  // spawned (or re-spawned) until recoverRateLimitedTasks restores it. This
  // gates the out-of-band activation path (external-event / peer-handoff
  // spawns via activateTargetSessionsForMessage), which bypasses the tick loop's
  // paused-task guard in processRunTick.
  if (isRateOrUsageLimited(task.status)) {
    // Transient (NOT permanent): the runtime leaves the execution `pending` and
    // re-attempts on a later tick once recoverRateLimitedTasks restores the
    // task. A PermanentSpawnError here would cancel + unregister the execution,
    // so a transient cooldown would permanently remove the target agent.
    throw new TransientSpawnError(
      `Task ${task.id} is ${task.status} (paused on a rate/usage cap); deferring spawn until the cap resets`
    );
  }
}
