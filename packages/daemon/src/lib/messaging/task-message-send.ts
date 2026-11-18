import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { ActorResolver } from '../../../../messaging/src/contracts.ts';
import type { ActorRef, MessageRecord } from '../../../../messaging/src/types.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { defineOperation } from '../operations/registry.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../session-resolution/target.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { TaskWorkerMessageInjector } from '../tasks/task-message-delivery.ts';
import { resolveOutboundSender, type OutboundSender } from './outbound-sender-identity.ts';
import { deliverToAgent, deliverToWorker } from './task-message-send-delivery.ts';
import {
  locateTask,
  resolveMessageTarget,
  resolveWorkflow,
  type ResolvedMessageTarget,
} from './task-message-send-target.ts';

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
  taskAgentManager: TaskWorkerMessageInjector;
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

type Admission = { sender: OutboundSender; task: SpaceTask; workflow: SpaceWorkflow | null };
type Rejection = { reason: TaskMessageSendResult };

function reject(input: TaskMessageSendInput, error: string, taskId?: string): Rejection {
  return {
    reason: { success: false, task_id: taskId ?? ('taskId' in input ? input.taskId : ''), error },
  };
}

function admitSender(input: TaskMessageSendInput, caller: OperationCaller) {
  const sender = resolveOutboundSender(caller);
  return 'reason' in sender
    ? reject(input, SENDER_IDENTITY_UNAVAILABLE_ERROR)
    : { value: sender.value };
}

function admitTask(
  sender: OutboundSender,
  input: TaskMessageSendInput,
  deps: TaskMessageSendDependencies
): { value: { sender: OutboundSender; task: SpaceTask } } | Rejection {
  const located = locateTask(input, deps);
  return 'reason' in located
    ? reject(input, located.reason)
    : { value: { sender, task: located.value } };
}

function admitWorkflow(
  admission: { sender: OutboundSender; task: SpaceTask },
  input: TaskMessageSendInput,
  deps: TaskMessageSendDependencies
): { value: Admission } | Rejection {
  const { task } = admission;
  if (!input.target && !input.nodeId) {
    return reject(
      input,
      'Target agent is required. Use node_id or target to specify a recipient.',
      task.id
    );
  }
  const workflow = resolveWorkflow(task, deps);
  return 'reason' in workflow
    ? reject(input, workflow.reason, task.id)
    : { value: { ...admission, workflow: workflow.value.workflow } };
}

async function admitTarget(
  admission: Admission,
  input: TaskMessageSendInput,
  executions: NodeExecution[],
  deps: TaskMessageSendDependencies
): Promise<{ value: Admission & { target: ResolvedMessageTarget } } | Rejection> {
  try {
    const target = await resolveMessageTarget(
      input,
      admission.task,
      admission.workflow,
      executions,
      deps
    );
    return 'reason' in target
      ? reject(input, target.reason, admission.task.id)
      : { value: { ...admission, target: target.value } };
  } catch (err) {
    return reject(input, err instanceof Error ? err.message : String(err), admission.task.id);
  }
}

async function deliverMessage(
  admission: Admission & { target: ResolvedMessageTarget },
  input: TaskMessageSendInput,
  deps: TaskMessageSendDependencies
): Promise<TaskMessageSendResult> {
  const { sender, task, workflow, target } = admission;
  try {
    if (target.kind === 'agent') {
      return await deliverToAgent(input, sender, task, target.genericTarget, deps);
    }
    deps.replyRoutingRegistry?.set(task.id, sender.sessionId, target.resolved.agentName);
    return await deliverToWorker(
      input,
      sender,
      task,
      workflow,
      target.resolved,
      target.sessionSelector,
      deps
    );
  } catch (err) {
    return {
      success: false,
      task_id: task.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function createSendTaskMessageOperation(deps: TaskMessageSendDependencies) {
  const send = (superpipe({ deps })('task.message.send') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitSender, ['input', 'caller'], 'result:outcome')
    .pipe(admitTask, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(admitWorkflow, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(
      (admission: Admission) => deps.listNodeExecutions(admission.task.workflowRunId!),
      ['outcome'],
      'executions'
    )
    .pipe(admitTarget, ['outcome', 'input', 'executions', 'deps'], 'result:outcome')
    .pipe(deliverMessage, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: TaskMessageSendInput,
    caller: OperationCaller
  ) => Promise<TaskMessageSendResult>;
  return defineOperation({
    name: 'task.message.send',
    description:
      'Send a message to a workflow node agent or long-horizon agent on a task, resolving the target by node_id, @handle, @role, @worker, or @session. The node is activated automatically if it has no live session. Sender attribution and the reply route are taken from the calling session, so only Space agent sessions can send.',
    inputSchema: TaskMessageSendInputSchema,
    resultSchema: TaskMessageSendResultSchema,
    execute: send,
  });
}
