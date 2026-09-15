import type { NodeExecution, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { z } from 'zod';
import { parseAddress } from '../../../../../messaging/src/address.ts';
import type { OperationCaller } from '../../operations/registry.ts';
import { defineOperation } from '../../operations/registry.ts';
import type { AgentMessageLevel } from '../agent-message-envelope.ts';
import {
  createDeliverTaskWorkerMessagePipeline,
  resolveWorkerTargetExecution,
} from '../actions/task-message-delivery.ts';
import { translateTaskMessageTarget } from '../messaging-adapter.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../../session-resolution/target.ts';
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
  audit?: (outcome: string, extra?: Record<string, unknown>) => void;
}

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

function resolveWorkerTarget(
  input: TaskMessageSendInput,
  task: SpaceTask,
  workflow: SpaceWorkflow | null,
  executions: NodeExecution[]
):
  | {
      value: { resolved: NodeExecution; sessionSelector?: string };
    }
  | { reason: string } {
  const allExecutions = executions;
  const genericTarget = translateTaskMessageTarget(
    { target: input.target, nodeId: input.nodeId },
    { workflowRunId: task.workflowRunId!, nodeExecutions: allExecutions, workflow }
  );
  const address = parseAddress(genericTarget);

  if (address.kind === 'worker') {
    const resolved = resolveWorkerTargetExecution(
      allExecutions,
      task.workflowRunId!,
      workflowNodeNameById(workflow),
      genericTarget
    );
    if (!resolved) {
      return {
        reason: `Node not found for task ${task.id}: "${genericTarget}". Expected an execution UUID, agent name, @worker target, or task agent @session target.`,
      };
    }
    return { value: { resolved } };
  }

  if (address.kind === 'session') {
    const resolved =
      allExecutions.find((exec) => exec.agentSessionId === address.sessionId) ?? null;
    if (!resolved) {
      return {
        reason: `Node not found for task ${task.id}: "${genericTarget}". Expected an execution UUID, agent name, @worker target, or task agent @session target.`,
      };
    }
    return { value: { resolved, sessionSelector: address.sessionId } };
  }

  if (address.kind === 'handle' || address.kind === 'role') {
    return {
      reason: `Target "${genericTarget}" is a long-horizon agent target and is not supported by the worker-only task message operation.`,
    };
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
    const targetOutcome = resolveWorkerTarget(input, task, workflow, allExecutions);
    if ('reason' in targetOutcome) {
      return { success: false, task_id: task.id, error: targetOutcome.reason };
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
      'Send a message to a workflow node agent on a task, resolving the target by node_id, @worker address, or @session task-agent session. The node is activated automatically if it has no live session.',
    inputSchema: TaskMessageSendInputSchema,
    resultSchema: TaskMessageSendResultSchema,
    execute: (input, caller) => sendTaskMessage(input, caller, deps),
  });
}
