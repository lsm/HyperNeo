import type {
  NodeExecution,
  NodeExecutionStatus,
  SpaceTask,
  SpaceTaskStatus,
  SpaceWorkflow,
  WorkflowNode,
} from '@hyperneo/shared';
import { isRateOrUsageLimited, resolveNodeAgents } from '@hyperneo/shared';

export type ExecutionWorkflowValidationResult =
  | { valid: true }
  | { valid: false; reason: string; permanent: true };

export const SPAWN_BINDABLE_EXECUTION_STATUSES: readonly NodeExecutionStatus[] = [
  'pending',
  'in_progress',
  'idle',
  'waiting_rebind',
];

export const SPAWN_RESERVABLE_TASK_STATUSES: readonly SpaceTaskStatus[] = [
  'draft',
  'open',
  'in_progress',
  'review',
  'approved',
  'blocked',
];

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

export class TransientSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientSpawnError';
  }
}

export function isTransientSpawnError(err: unknown): err is TransientSpawnError {
  return err instanceof TransientSpawnError;
}

export class SpawnSupersededError extends Error {
  readonly executionId: string;
  readonly stage: string | null;

  constructor(executionId: string, stage: string | null) {
    super(
      `Spawn for execution ${executionId} superseded at stage ${stage ?? 'unknown'} — a concurrent writer moved the guarded row first; skipping for this call`
    );
    this.name = 'SpawnSupersededError';
    this.executionId = executionId;
    this.stage = stage;
  }
}

export function isSpawnSupersededError(err: unknown): err is SpawnSupersededError {
  return err instanceof SpawnSupersededError;
}

export interface MissingNodeAgentReference {
  agentName: string;
  agentId: string;
}

export function findMissingNodeAgentReferences(
  node: WorkflowNode,
  agentExists: (agentId: string) => boolean,
  options?: { slotNames?: ReadonlySet<string> }
): MissingNodeAgentReference[] {
  let agents: ReturnType<typeof resolveNodeAgents>;
  try {
    agents = resolveNodeAgents(node);
  } catch {
    return [];
  }
  const slotFilter = options?.slotNames;
  const missing: MissingNodeAgentReference[] = [];
  for (const agent of agents) {
    if (slotFilter && !slotFilter.has(agent.name)) continue;
    if (agent.agentId && !agentExists(agent.agentId)) {
      missing.push({ agentName: agent.name, agentId: agent.agentId });
    }
  }
  return missing;
}

export class MissingWorkflowAgentError extends PermanentSpawnError {
  readonly reference: MissingNodeAgentReference;

  constructor(message: string, reference: MissingNodeAgentReference) {
    super(message);
    this.name = 'MissingWorkflowAgentError';
    this.reference = reference;
  }
}

export function isMissingWorkflowAgentError(err: unknown): err is MissingWorkflowAgentError {
  return err instanceof MissingWorkflowAgentError;
}

export function formatMissingAgentReference(params: {
  runId: string;
  nodeLabel: string;
  agentName: string;
  agentId: string;
}): string {
  return (
    `Workflow run "${params.runId}" cannot activate node "${params.nodeLabel}": ` +
    `agent slot "${params.agentName}" references agent "${params.agentId}", ` +
    `which no longer exists in this Space. This run resolves a workflow ` +
    `definition pinned at creation time, so editing the workflow or recreating ` +
    `the agent (a new id) will not repair it; create a new run from a corrected ` +
    `workflow.`
  );
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
  if (isRateOrUsageLimited(task.status)) {
    throw new TransientSpawnError(
      `Task ${task.id} is ${task.status} (paused on a rate/usage cap); deferring spawn until the cap resets`
    );
  }
}
