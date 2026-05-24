import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@neokai/shared';
import { resolveNodeAgents } from '@neokai/shared';

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
}
