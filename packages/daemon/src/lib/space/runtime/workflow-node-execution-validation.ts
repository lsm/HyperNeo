import type { NodeExecution, SpaceTask, SpaceWorkflow, WorkflowNode } from '@hyperneo/shared';
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

// ============================================================================
// Stale / missing custom-agent reference validation
// ============================================================================
//
// `node_executions.agent_id` carries `FOREIGN KEY … REFERENCES space_agents(id)
// ON DELETE SET NULL`. That ON DELETE SET NULL only rewrites EXISTING rows when
// an agent is deleted; INSERTing a new row whose `agent_id` points at a deleted
// agent still raises `SQLITE_CONSTRAINT_FOREIGNKEY` (and `INSERT OR IGNORE` does
// NOT suppress foreign-key failures). Workflow definitions persist agent ids, so
// a run pinned to a definition that references a since-deleted custom agent would
// otherwise leak that raw SQLite error every time a downstream node is activated.
//
// The helpers below let the shared node-activation paths (channel activation and
// restart recovery) validate configured agent references up front and surface an
// actionable error instead. Built-in/worker slots that validly use `agentId =
// null` are intentionally preserved — only non-null references are checked, and a
// missing required agent is never silently nulled.

/**
 * A configured workflow-node agent slot whose `agentId` no longer resolves to a
 * `space_agents` row.
 */
export interface MissingNodeAgentReference {
  agentName: string;
  agentId: string;
}

/**
 * Returns the configured agent slots on `node` whose `agentId` no longer exists
 * (according to `agentExists`). Slots with `agentId === null` (built-in/worker
 * agents that carry no FK reference) are always valid and never reported.
 *
 * Returns an empty array when every slot resolves, including when the node has
 * only null-agentId slots. A `resolveNodeAgents` failure (e.g. a node with no
 * agents) is deliberately swallowed here — that malformation is reported by
 * {@link validateExecutionAgainstWorkflow} / the activation callers, and a
 * second error from this helper would mask the actionable one.
 */
export function findMissingNodeAgentReferences(
  node: WorkflowNode,
  agentExists: (agentId: string) => boolean
): MissingNodeAgentReference[] {
  let agents: ReturnType<typeof resolveNodeAgents>;
  try {
    agents = resolveNodeAgents(node);
  } catch {
    return [];
  }
  const missing: MissingNodeAgentReference[] = [];
  for (const agent of agents) {
    if (agent.agentId && !agentExists(agent.agentId)) {
      missing.push({ agentName: agent.name, agentId: agent.agentId });
    }
  }
  return missing;
}

/**
 * Permanent spawn failure caused by a workflow slot referencing a custom agent
 * that no longer exists in the Space. Extends {@link PermanentSpawnError} so the
 * existing spawn-error handling treats it as terminal (no retry storm). Carries
 * the offending reference so callers can build a targeted diagnostic.
 */
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

/**
 * Build the actionable diagnostic for a stale agent reference. Includes the run
 * id, target node, agent name, and stale agent id so an operator can locate and
 * repair the broken reference without grepping logs for a raw SQLite exception.
 */
export function formatMissingAgentReference(params: {
  runId: string;
  /** Node name when available, otherwise the node id. */
  nodeLabel: string;
  agentName: string;
  agentId: string;
}): string {
  return (
    `Workflow run "${params.runId}" cannot activate node "${params.nodeLabel}": ` +
    `agent slot "${params.agentName}" references agent "${params.agentId}", ` +
    `which no longer exists in this Space. Recreate the agent or update the ` +
    `workflow definition to reference a valid agent before continuing.`
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
