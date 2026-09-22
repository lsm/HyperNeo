import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { z } from 'zod';
import type { ActorResolver } from '../../../../messaging/src/contracts.ts';
import type { ActorRef, MessageRecord } from '../../../../messaging/src/types.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { defineOperation } from '../operations/registry.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../session-resolution/target.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';
import { resolveOutboundSender } from './outbound-sender-identity.ts';
import { deliverToAgent, deliverToWorker } from './task-message-send-delivery.ts';
import { locateTask, resolveMessageTarget, resolveWorkflow } from './task-message-send-target.ts';

export const SENDER_IDENTITY_UNAVAILABLE_ERROR =
  'Sender identity is unavailable — only Space agent sessions can send task messages.';

const TaskMessageByIdSchema = z
  .object({
    spaceId: z.string().min(1),
    taskId: z.string().min(1),
    message: z.string().min(1).max(100_000),
    nodeId: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
  })
  .strict();

const TaskMessageByNumberSchema = z
  .object({
    spaceId: z.string().min(1),
    taskNumber: z.number().int().positive(),
    message: z.string().min(1).max(100_000),
    nodeId: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
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
  messageResolverFactory?: (
    spaceId: string,
    context?: { workflowRunId?: string; nodeId?: string; agentName?: string }
  ) => ActorResolver | undefined;
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

export async function sendTaskMessage(
  input: TaskMessageSendInput,
  caller: OperationCaller,
  deps: TaskMessageSendDependencies
): Promise<TaskMessageSendResult> {
  const sender = resolveOutboundSender(caller);
  if ('reason' in sender) {
    return {
      success: false,
      task_id: 'taskId' in input ? input.taskId : '',
      error: SENDER_IDENTITY_UNAVAILABLE_ERROR,
    };
  }

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
      return await deliverToAgent(
        input,
        sender.value,
        task,
        targetOutcome.value.genericTarget,
        deps
      );
    }

    deps.replyRoutingRegistry?.set(
      task.id,
      sender.value.sessionId,
      targetOutcome.value.resolved.agentName
    );

    return await deliverToWorker(
      input,
      sender.value,
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
      'Send a message to a workflow node agent or long-horizon agent on a task, resolving the target by node_id, @handle, @role, @worker, or @session. The node is activated automatically if it has no live session. Sender attribution and the reply route are taken from the calling session, so only Space agent sessions can send.',
    inputSchema: TaskMessageSendInputSchema,
    resultSchema: TaskMessageSendResultSchema,
    execute: (input, caller) => sendTaskMessage(input, caller, deps),
  });
}
