import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { parseAddress, type ParsedAddress } from '../../../../messaging/src/address.ts';
import type { ActorResolver } from '../../../../messaging/src/contracts.ts';
import {
  describeActor,
  describeAmbiguousTargetActors,
  describeTaskExecution,
  resolveHandleForTaskRouting,
  resolveNodeExecution,
  resolveWorkerTargetExecution,
  type TaskRoutingTargetResolution,
} from '../tasks/task-message-delivery.ts';
import { normalizeAgentNameToken } from './agent-handle.ts';
import { translateTaskMessageTarget } from './target-translation.ts';
import type { TaskMessageSendDependencies, TaskMessageSendInput } from './task-message-send.ts';

export type ResolvedMessageTarget =
  | { kind: 'worker'; resolved: NodeExecution; sessionSelector?: string }
  | { kind: 'agent'; genericTarget: string };

export function locateTask(
  input: TaskMessageSendInput,
  deps: TaskMessageSendDependencies
): { value: SpaceTask } | { reason: string } {
  const task =
    'taskId' in input
      ? deps.getTask(input.taskId)
      : deps.getTaskByNumber(input.spaceId, input.taskNumber);
  if (!task) {
    return {
      reason:
        'taskId' in input
          ? `Task not found: ${input.taskId}`
          : `Task not found in this space with task_number=${input.taskNumber}`,
    };
  }
  if (task.spaceId !== input.spaceId) {
    return { reason: `Task ${task.id} does not belong to this space.` };
  }
  if (task.status === 'archived') {
    return { reason: `Task ${task.id} is archived — create a new task.` };
  }
  return { value: task };
}

export function resolveWorkflow(
  task: SpaceTask,
  deps: TaskMessageSendDependencies
):
  | {
      value: {
        run: { workflowId: string; definitionVersion: string | null };
        workflow: SpaceWorkflow | null;
      };
    }
  | { reason: string } {
  if (!task.workflowRunId) {
    return { reason: `Task ${task.id} has no workflow run — cannot target workflow workers.` };
  }
  const run = deps.getWorkflowRun(task.workflowRunId);
  if (!run) {
    return { reason: `Workflow run not found: ${task.workflowRunId}` };
  }
  const workflow = deps.getWorkflowForRun(run);
  return { value: { run, workflow } };
}

function workflowNodeNameById(workflow: SpaceWorkflow | null): Map<string, string> {
  return new Map((workflow?.nodes ?? []).map((node) => [node.id, node.name] as const));
}

export function resolveActorResolver(
  spaceId: string,
  context: { workflowRunId?: string; nodeId?: string; agentName?: string },
  deps: TaskMessageSendDependencies
): ActorResolver | undefined {
  return deps.messageResolver ?? deps.messageResolverFactory?.(spaceId, context);
}

function parseTargetAddress(trimmedTarget: string): { value: ParsedAddress } | { reason: string } {
  try {
    return { value: parseAddress(trimmedTarget) };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function resolveMessageTarget(
  input: TaskMessageSendInput,
  task: SpaceTask,
  workflow: SpaceWorkflow | null,
  executions: NodeExecution[],
  deps: TaskMessageSendDependencies
): Promise<{ value: ResolvedMessageTarget } | { reason: string }> {
  const trimmedTarget = input.target?.trim() ?? '';
  let targetAddress: ParsedAddress | null = null;

  if (trimmedTarget) {
    const addressOutcome = parseTargetAddress(trimmedTarget);
    if ('reason' in addressOutcome) {
      return { reason: addressOutcome.reason };
    }
    targetAddress = addressOutcome.value;
  }

  let handleResolution: TaskRoutingTargetResolution | null = null;
  if (targetAddress?.kind === 'handle') {
    const messageResolver = resolveActorResolver(
      input.spaceId,
      { workflowRunId: task.workflowRunId!, nodeId: input.nodeId },
      deps
    );
    handleResolution = await resolveHandleForTaskRouting(
      trimmedTarget,
      executions,
      input.spaceId,
      task.workflowRunId!,
      messageResolver,
      deps.longHorizonAgentRepo
    );
  }

  const nodeResolved = input.nodeId ? resolveNodeExecution(executions, input.nodeId) : null;

  if (handleResolution?.kind === 'long-horizon-agent' && targetAddress?.kind === 'handle') {
    if (nodeResolved) {
      return {
        reason:
          `target and node_id disagree for task #${task.taskNumber}:\n` +
          `  target: "${trimmedTarget}"  → ${describeActor(handleResolution.actor)}\n` +
          `  node_id: "${input.nodeId}"  → ${describeTaskExecution(nodeResolved)}\n` +
          `Pick one. node_id is preferred for workflow node routing.`,
      };
    }
    return {
      reason:
        `Ambiguous target "${trimmedTarget}" matched long-horizon agent "${handleResolution.actor.handle?.slice(1) ?? handleResolution.actor.actorId}" (${handleResolution.actor.actorId}), not a workflow node of task #${task.taskNumber}.\n` +
        `To target the workflow ${targetAddress.handle} node, use:\n` +
        `  - node_id: "${targetAddress.handle}"  (recommended)\n` +
        `  - target: "@worker:${task.workflowRunId}/${targetAddress.handle}/${targetAddress.handle}"\n` +
        `To target the long-horizon agent explicitly, omit task_id and call send_session_message instead.`,
    };
  }

  const matchesTargetHandle =
    nodeResolved !== null &&
    targetAddress !== null &&
    targetAddress.kind === 'handle' &&
    normalizeAgentNameToken(nodeResolved.agentName) ===
      normalizeAgentNameToken(targetAddress.handle);

  if (handleResolution?.kind === 'ambiguous' && !matchesTargetHandle) {
    return {
      reason:
        `Ambiguous target "${trimmedTarget}" for task #${task.taskNumber} matched multiple actors:\n` +
        `${describeAmbiguousTargetActors(handleResolution.actors, handleResolution.exec)}\n` +
        `Disambiguate with @worker: for workflow nodes or @session: for a specific session.`,
    };
  }

  let genericTarget: string;
  try {
    genericTarget = translateTaskMessageTarget(
      { target: trimmedTarget, nodeId: input.nodeId },
      { workflowRunId: task.workflowRunId!, nodeExecutions: executions, workflow }
    );
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }

  const workerExec =
    (matchesTargetHandle ? nodeResolved : null) ??
    (handleResolution?.kind === 'task-worker' ? handleResolution.exec : null);

  if (workerExec) {
    genericTarget = `@worker:${encodeURIComponent(task.workflowRunId!)}/${encodeURIComponent(workerExec.workflowNodeId)}/${encodeURIComponent(workerExec.agentName)}`;
  }

  const address = parseAddress(genericTarget);

  if (address.kind === 'handle' || address.kind === 'role') {
    const messageResolver = resolveActorResolver(
      input.spaceId,
      { workflowRunId: task.workflowRunId!, nodeId: input.nodeId },
      deps
    );
    if (!messageResolver || !deps.longTermAgentDelivery) {
      return { reason: 'Long-term agent messaging is not available in this context.' };
    }
    return { value: { kind: 'agent', genericTarget } };
  }

  if (address.kind === 'worker') {
    const resolved = resolveWorkerTargetExecution(
      executions,
      task.workflowRunId!,
      workflowNodeNameById(workflow),
      genericTarget
    );
    if (!resolved) {
      return {
        reason: `Node not found for task ${task.id}: "${genericTarget}". Expected an execution UUID, agent name, @worker target, or task agent @session target.`,
      };
    }
    if (nodeResolved && resolved.id !== nodeResolved.id) {
      return {
        reason:
          `target and node_id disagree for task #${task.taskNumber}:\n` +
          `  target: "${trimmedTarget}"  → ${describeTaskExecution(resolved)}\n` +
          `  node_id: "${input.nodeId}"  → ${describeTaskExecution(nodeResolved)}\n` +
          `Pick one. node_id is preferred for workflow node routing.`,
      };
    }
    return { value: { kind: 'worker', resolved } };
  }

  if (address.kind === 'session') {
    const resolved = executions.find((exec) => exec.agentSessionId === address.sessionId) ?? null;
    if (!resolved) {
      return {
        reason: `Node not found for task ${task.id}: "${genericTarget}". Expected an execution UUID, agent name, @worker target, or task agent @session target.`,
      };
    }
    if (nodeResolved && resolved.id !== nodeResolved.id) {
      return {
        reason:
          `target and node_id disagree for task #${task.taskNumber}:\n` +
          `  target: "${trimmedTarget}"  → ${describeTaskExecution(resolved)}\n` +
          `  node_id: "${input.nodeId}"  → ${describeTaskExecution(nodeResolved)}\n` +
          `Pick one. node_id is preferred for workflow node routing.`,
      };
    }
    return { value: { kind: 'worker', resolved, sessionSelector: address.sessionId } };
  }

  return { reason: `Generic target ${genericTarget} is not routable from this tool.` };
}
