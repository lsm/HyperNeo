import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import type { DeliveryRecord, MessageRecord } from '../../../../messaging/src/types.ts';
import { createDeliverTaskWorkerMessagePipeline } from '../space/actions/task-message-delivery.ts';
import type { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';
import type { ToolResult } from '../space/tools/tool-result.ts';
import { SpaceDeliveryFacade } from './delivery-facade.ts';
import { formatAgentMessage, type AgentMessageLevel } from './envelope.ts';
import { resolveActorResolver } from './task-message-send-target.ts';
import type {
  TaskMessageSendDependencies,
  TaskMessageSendInput,
  TaskMessageSendResult,
} from './task-message-send.ts';

function parsePipelineResult(toolResult: ToolResult): TaskMessageSendResult {
  try {
    return JSON.parse(toolResult.content[0]!.text) as TaskMessageSendResult;
  } catch {
    return { success: false, task_id: '', error: 'Malformed delivery result' };
  }
}

export async function deliverToWorker(
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

export async function deliverToAgent(
  input: TaskMessageSendInput,
  task: SpaceTask,
  genericTarget: string,
  deps: TaskMessageSendDependencies
): Promise<TaskMessageSendResult> {
  const messageRecord = buildAgentMessageRecord(input, task, genericTarget);
  const messageResolver = resolveActorResolver(
    input.spaceId,
    { workflowRunId: task.workflowRunId!, nodeId: input.nodeId },
    deps
  );
  if (!messageResolver) {
    return { success: false, task_id: task.id, error: 'Actor resolver is not available.' };
  }
  const routed = await new SpaceDeliveryFacade({
    resolver: messageResolver,
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
