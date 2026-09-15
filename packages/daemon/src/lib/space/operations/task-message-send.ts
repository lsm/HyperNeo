import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { z } from 'zod';
import { parseAddress, type ParsedAddress } from '../../../../../messaging/src/address.ts';
import type { ActorResolver } from '../../../../../messaging/src/contracts.ts';
import type {
  ActorRef,
  DeliveryRecord,
  MessageRecord,
} from '../../../../../messaging/src/types.ts';
import type { OperationCaller } from '../../operations/registry.ts';
import { defineOperation } from '../../operations/registry.ts';
import { normalizeAgentNameToken } from '../agent-handle.ts';
import { formatAgentMessage, type AgentMessageLevel } from '../agent-message-envelope.ts';
import {
  createDeliverTaskWorkerMessagePipeline,
  describeActor,
  describeAmbiguousTargetActors,
  describeTaskExecution,
  resolveHandleForTaskRouting,
  resolveNodeExecution,
  resolveWorkerTargetExecution,
  type TaskRoutingTargetResolution,
} from '../actions/task-message-delivery.ts';
import { SpaceDeliveryFacade, translateTaskMessageTarget } from '../messaging-adapter.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../../session-resolution/target.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { TaskAgentManager } from '../runtime/task-agent-manager.ts';
import type { ToolResult } from '../tools/tool-result.ts';

const SenderLevelSchema = z.enum([
  'long-horizon-agent',
  'task-agent',
  'node-agent',
  'session-agent',
]);

const TaskMessageByIdSchema = z
  .object({
    spaceId: z.string().min(1),
    taskId: z.string().min(1),
    message: z.string().min(1).max(100_000),
    nodeId: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    mySessionId: z.string().min(1).optional(),
    outboundSenderLevel: SenderLevelSchema,
    outboundSenderDisplayName: z.string().min(1),
    outboundReplyTargetHandle: z.string().nullable().optional(),
  })
  .strict();

const TaskMessageByNumberSchema = z
  .object({
    spaceId: z.string().min(1),
    taskNumber: z.number().int().positive(),
    message: z.string().min(1).max(100_000),
    nodeId: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    mySessionId: z.string().min(1).optional(),
    outboundSenderLevel: SenderLevelSchema,
    outboundSenderDisplayName: z.string().min(1),
    outboundReplyTargetHandle: z.string().nullable().optional(),
  })
  .strict();

export const TaskMessageSendInputSchema = z.union([
  TaskMessageByIdSchema,
  TaskMessageByNumberSchema,
]);

export const TaskMessageSendResultSchema = z
  .object({
    success: z.boolean(),
    task_id: z.string(),
    target: z.enum(['node', 'agent', 'session']).optional(),
    node_execution_id: z.string().optional(),
    agent_name: z.string().optional(),
    delivered_session_id: z.string().nullable().optional(),
    sdk_message_id: z.string().nullable().optional(),
    activated: z.boolean().optional(),
    delivered: z.boolean().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type TaskMessageSendInput = z.infer<typeof TaskMessageSendInputSchema>;
export type TaskMessageSendResult = z.infer<typeof TaskMessageSendResultSchema>;

export interface TaskMessageSendDependencies {
  getTask: (taskId: string) => SpaceTask | null;
  getTaskByNumber: (spaceId: string, taskNumber: number) => SpaceTask | null;
  getWorkflowRun: (
    workflowRunId: string
  ) => { workflowId: string; definitionVersion: string | null } | null;
  getWorkflowForRun: (run: {
    workflowId: string;
    definitionVersion: string | null;
  }) => SpaceWorkflow | null;
  listNodeExecutions: (workflowRunId: string) => NodeExecution[];
  getNodeExecutionById: (executionId: string) => NodeExecution | null;
  ensureTargetSession: (target: SessionTarget) => Promise<EnsureSessionOutcome>;
  activateNode: (runId: string, nodeId: string) => Promise<void>;
  taskAgentManager: Pick<TaskAgentManager, 'injectSubSessionMessage'>;
  messageResolver?: ActorResolver;
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  longTermAgentDelivery?: {
    deliverToSession?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
    queueForActivation?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
  };
  replyRoutingRegistry?: {
    set: (taskId: string, sessionId: string, agentName?: string | null) => void;
  };
  audit?: (outcome: string, extra?: Record<string, unknown>) => void;
}

type ResolvedMessageTarget =
  | { kind: 'worker'; resolved: NodeExecution; sessionSelector?: string }
  | { kind: 'agent'; genericTarget: string };

function locateTask(
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

function resolveWorkflow(
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

function parseTargetAddress(trimmedTarget: string): { value: ParsedAddress } | { reason: string } {
  try {
    return { value: parseAddress(trimmedTarget) };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveMessageTarget(
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
    handleResolution = await resolveHandleForTaskRouting(
      trimmedTarget,
      executions,
      input.spaceId,
      task.workflowRunId!,
      deps.messageResolver,
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
    if (!deps.messageResolver || !deps.longTermAgentDelivery) {
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
    return { value: { kind: 'worker', resolved } };
  }

  if (address.kind === 'session') {
    const resolved = executions.find((exec) => exec.agentSessionId === address.sessionId) ?? null;
    if (!resolved) {
      return {
        reason: `Node not found for task ${task.id}: "${genericTarget}". Expected an execution UUID, agent name, @worker target, or task agent @session target.`,
      };
    }
    return { value: { kind: 'worker', resolved, sessionSelector: address.sessionId } };
  }

  return { reason: `Generic target ${genericTarget} is not routable from this tool.` };
}

function parsePipelineResult(toolResult: ToolResult): TaskMessageSendResult {
  try {
    return JSON.parse(toolResult.content[0]!.text) as TaskMessageSendResult;
  } catch {
    return { success: false, task_id: '', error: 'Malformed delivery result' };
  }
}

async function deliverToWorker(
  input: TaskMessageSendInput,
  task: SpaceTask,
  workflow: SpaceWorkflow | null,
  resolved: NodeExecution,
  sessionSelector: string | undefined,
  deps: TaskMessageSendDependencies
): Promise<TaskMessageSendResult> {
  const audit = deps.audit ?? (() => {});
  const pipeline = createDeliverTaskWorkerMessagePipeline({
    taskAgentManager: deps.taskAgentManager as TaskAgentManager,
    nodeExecutionRepo: { getById: deps.getNodeExecutionById },
    ensureTargetSession: deps.ensureTargetSession,
    activateNode: deps.activateNode,
    mySessionId: input.mySessionId,
    outboundSenderLevel: input.outboundSenderLevel as AgentMessageLevel,
    outboundSenderDisplayName: input.outboundSenderDisplayName,
    outboundReplyTargetHandle: input.outboundReplyTargetHandle ?? null,
  });

  const ctx = await pipeline({
    task,
    workflowRunId: task.workflowRunId!,
    resolved,
    message: input.message,
    ...(sessionSelector ? { sessionSelector } : {}),
    audit,
  });

  if (!ctx.result) {
    return {
      success: false,
      task_id: task.id,
      error: `Node "${resolved.agentName}" has no live session and could not be activated.`,
    };
  }

  return parsePipelineResult(ctx.result);
}

function buildAgentMessageRecord(
  input: TaskMessageSendInput,
  task: SpaceTask,
  genericTarget: string
): MessageRecord {
  return {
    messageId: `msg_space_tool_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    spaceId: input.spaceId,
    senderActorId: input.mySessionId ? `session:${input.mySessionId}` : 'system:runtime',
    targets: [genericTarget],
    body: formatAgentMessage({
      fromLevel: input.outboundSenderLevel as AgentMessageLevel,
      fromAgentName: input.outboundSenderDisplayName,
      toLevel: 'long-horizon-agent',
      body: input.message,
      taskId: task.id,
      taskNumber: task.taskNumber,
      replyToSessionId: input.mySessionId,
      replyTargetHandle: input.outboundReplyTargetHandle ?? null,
    }),
    kind: 'message',
    workflowRunId: task.workflowRunId!,
    taskId: task.id,
    createdAt: Date.now(),
  };
}

function summarizeAgentDelivery(deliveries: DeliveryRecord[]): {
  firstDelivered: DeliveryRecord | undefined;
  deliveredOrQueued: boolean;
} {
  const firstDelivered = deliveries.find((delivery) => delivery.state === 'delivered');
  const deliveredOrQueued = deliveries.some((delivery) =>
    ['delivered', 'queued'].includes(delivery.state)
  );
  return { firstDelivered, deliveredOrQueued };
}

async function deliverToAgent(
  input: TaskMessageSendInput,
  task: SpaceTask,
  genericTarget: string,
  deps: TaskMessageSendDependencies
): Promise<TaskMessageSendResult> {
  const messageRecord = buildAgentMessageRecord(input, task, genericTarget);
  const routed = await new SpaceDeliveryFacade({
    resolver: deps.messageResolver!,
    deliverToSession: deps.longTermAgentDelivery!.deliverToSession!,
    queueForActivation: deps.longTermAgentDelivery!.queueForActivation!,
  }).routeMessage(messageRecord);

  const { firstDelivered, deliveredOrQueued } = summarizeAgentDelivery(routed.deliveries);
  const outcome = firstDelivered ? 'delivered' : deliveredOrQueued ? 'queued' : 'failed';

  deps.audit?.(outcome, {
    target: 'agent',
    agent_name: genericTarget,
    delivered_session_id: firstDelivered?.deliveredSessionId ?? null,
  });

  return {
    success: deliveredOrQueued,
    task_id: task.id,
    target: 'agent',
    deliveries: routed.deliveries,
    delivered_session_id: firstDelivered?.deliveredSessionId ?? null,
  };
}

export async function sendTaskMessage(
  input: TaskMessageSendInput,
  _caller: OperationCaller,
  deps: TaskMessageSendDependencies
): Promise<TaskMessageSendResult> {
  const located = locateTask(input, deps);
  if ('reason' in located) {
    return {
      success: false,
      task_id: 'taskId' in input ? input.taskId : '',
      error: located.reason,
    };
  }
  const task = located.value;

  if (!input.target && !input.nodeId) {
    return {
      success: false,
      task_id: task.id,
      error: 'Target agent is required. Use node_id or target to specify a recipient.',
    };
  }

  const workflowOutcome = resolveWorkflow(task, deps);
  if ('reason' in workflowOutcome) {
    return { success: false, task_id: task.id, error: workflowOutcome.reason };
  }

  const { workflow } = workflowOutcome.value;
  const allExecutions = deps.listNodeExecutions(task.workflowRunId!);

  try {
    const targetOutcome = await resolveMessageTarget(input, task, workflow, allExecutions, deps);
    if ('reason' in targetOutcome) {
      return { success: false, task_id: task.id, error: targetOutcome.reason };
    }

    if (targetOutcome.value.kind === 'agent') {
      return await deliverToAgent(input, task, targetOutcome.value.genericTarget, deps);
    }

    if (deps.replyRoutingRegistry && input.mySessionId) {
      deps.replyRoutingRegistry.set(
        task.id,
        input.mySessionId,
        targetOutcome.value.resolved.agentName
      );
    }

    return await deliverToWorker(
      input,
      task,
      workflow,
      targetOutcome.value.resolved,
      targetOutcome.value.sessionSelector,
      deps
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, task_id: task.id, error: message };
  }
}

export function createSendTaskMessageOperation(deps: TaskMessageSendDependencies) {
  return defineOperation({
    name: 'task.message.send',
    description:
      'Send a message to a workflow node agent or long-horizon agent on a task, resolving the target by node_id, @handle, @role, @worker, or @session. The node is activated automatically if it has no live session.',
    inputSchema: TaskMessageSendInputSchema,
    resultSchema: TaskMessageSendResultSchema,
    execute: (input, caller) => sendTaskMessage(input, caller, deps),
  });
}
