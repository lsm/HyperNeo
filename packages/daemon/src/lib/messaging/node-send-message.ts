import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { HookActionMeta } from '../hooks/hook-engine.ts';
import { wrapHandlerWithHooks } from '../hooks/hook-engine.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { jsonResult, type ToolResult } from '../space/tools/tool-result.ts';
import type { AgentMessageResult } from './routing-gates.ts';
import {
  admitNodeCaller,
  type NodeMessagingContext,
  type NodeMessagingDependencies,
  NodeContextRejectionSchema,
  requireActiveNodeSession,
  resolveNodeContext,
} from './node-messaging-context.ts';
import { translateLegacyNodeTargets } from './space-adapter.ts';

const inputSchema = z
  .object({
    target: z
      .union([z.string(), z.array(z.string())])
      .describe(
        "Delivery target: agent name (DM), node name (fan-out), array of agent names (multicast), or '*' (broadcast to all permitted targets)"
      ),
    message: z.string().min(1).describe('The message content to send to the target peer(s)'),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        'Optional structured data payload. Passed through to the target agent and available to send_message hooks.'
      )
      .optional(),
  })
  .strict();

export type NodeSendMessageInput = z.infer<typeof inputSchema>;

const DeliveredTargetSchema = z.object({ agentName: z.string(), sessionId: z.string() });
const QueuedTargetSchema = z.object({ agentName: z.string(), messageId: z.string() });
const FailedTargetSchema = z.object({
  agentName: z.string(),
  sessionId: z.string(),
  error: z.string(),
});

const hookAnnotation = {
  hookStatus: z.string().optional(),
  hookLabel: z.string().optional(),
  hookMethod: z.string().optional(),
  hookReason: z.string().optional(),
  hookRemediation: z.string().optional(),
  sourceNode: z.string().optional(),
};

const DeliveredSchema = z.object({
  success: z.literal(true),
  delivered: z.array(DeliveredTargetSchema),
  queued: z.array(QueuedTargetSchema).optional(),
  notFoundAgentNames: z.array(z.string()).optional(),
  message: z.string(),
});

const PartialSchema = z.object({
  success: z.literal('partial'),
  delivered: z.array(DeliveredTargetSchema),
  failed: z.array(FailedTargetSchema),
  queued: z.array(QueuedTargetSchema).optional(),
  notFoundAgentNames: z.array(z.string()).optional(),
  unauthorizedAgentNames: z.array(z.string()).optional(),
  permittedTargets: z.array(z.string()).optional(),
  reason: z.string().optional(),
  message: z.string(),
});

const HookHeldSchema = z.object({
  success: z.literal(true),
  queued: z.boolean(),
  cancelled: z.boolean().optional(),
  retryable: z.boolean(),
  retryAfterMs: z.number().optional(),
  message: z.string(),
  ...hookAnnotation,
});

const FailedSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  retryable: z.boolean().optional(),
  retryAfterMs: z.number().optional(),
  delivered: z.array(DeliveredTargetSchema).optional(),
  failed: z.array(FailedTargetSchema).optional(),
  queued: z.array(QueuedTargetSchema).optional(),
  notFoundAgentNames: z.array(z.string()).optional(),
  unauthorizedAgentNames: z.array(z.string()).optional(),
  permittedTargets: z.array(z.string()).optional(),
  ...hookAnnotation,
});

const resultSchema = z.union([
  DeliveredSchema,
  PartialSchema,
  HookHeldSchema,
  FailedSchema,
  NodeContextRejectionSchema,
]);

type Result = z.infer<typeof resultSchema>;

export function translateNodeTargets(
  context: NodeMessagingContext,
  nodeExecutionRepo: NodeMessagingDependencies['nodeExecutionRepo'],
  target: string | string[]
): { value: string | string[] } | { reason: string } {
  const { runtime, workflowRunId, workflowNodeId, agentName } = context;
  if (!runtime.workflow) return { value: target };
  try {
    const translated = translateLegacyNodeTargets(target, {
      spaceId: runtime.spaceId,
      workflowRunId,
      workflowNodeId,
      agentName,
      workflow: runtime.workflow,
      actors: nodeExecutionRepo.listByWorkflowRun(workflowRunId).map((execution) => ({
        actorId: `worker:${[workflowRunId, execution.workflowNodeId, execution.agentName].map(encodeURIComponent).join(':')}`,
        kind: 'worker' as const,
        spaceId: runtime.spaceId,
        status: execution.agentSessionId ? ('active' as const) : ('inactive' as const),
      })),
      replyRoutingLookup: runtime.replyRoutingLookup,
    });
    if (translated.length === 0) return { value: target };
    return { value: translated.length === 1 ? translated[0] : translated };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

export function renderFailure(result: AgentMessageResult): Record<string, unknown> {
  return {
    success: false,
    error: result.reason ?? 'Message delivery failed.',
    delivered: result.delivered.length > 0 ? result.delivered : undefined,
    failed: result.failed.length > 0 ? result.failed : undefined,
    queued: result.queued,
    unauthorizedAgentNames: result.unauthorizedAgentNames,
    permittedTargets: result.permittedTargets,
    notFoundAgentNames: result.notFoundAgentNames,
  };
}

export function renderPartial(result: AgentMessageResult): Record<string, unknown> {
  const summaryParts: string[] = [];
  if (result.delivered.length > 0) {
    summaryParts.push(
      `delivered to ${result.delivered.length} peer(s): ` +
        result.delivered.map((target) => target.agentName).join(', ')
    );
  }
  if (result.queued && result.queued.length > 0) {
    summaryParts.push(
      `queued for ${result.queued.length} peer(s): ` +
        result.queued.map((target) => target.agentName).join(', ')
    );
  }
  if (result.failed.length > 0) {
    summaryParts.push(`failed for ${result.failed.length} peer(s)`);
  }
  if (result.notFoundAgentNames && result.notFoundAgentNames.length > 0) {
    summaryParts.push(`not found: ${result.notFoundAgentNames.join(', ')}`);
  }
  return {
    success: 'partial',
    delivered: result.delivered,
    failed: result.failed,
    queued: result.queued,
    notFoundAgentNames: result.notFoundAgentNames,
    ...(result.unauthorizedAgentNames
      ? { unauthorizedAgentNames: result.unauthorizedAgentNames }
      : {}),
    ...(result.permittedTargets ? { permittedTargets: result.permittedTargets } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    message:
      `Message ${summaryParts.join('; ')}.` + (result.reason ? ` Reason: ${result.reason}` : ''),
  };
}

export function renderDelivered(result: AgentMessageResult): Record<string, unknown> {
  const summaryParts: string[] = [];
  if (result.delivered.length > 0) {
    summaryParts.push(
      `delivered to ${result.delivered.length} peer(s): ` +
        result.delivered.map((target) => `${target.agentName} (${target.sessionId})`).join(', ')
    );
  }
  if (result.queued && result.queued.length > 0) {
    summaryParts.push(
      `queued for durable delivery to ${result.queued.length} peer(s): ` +
        result.queued.map((target) => target.agentName).join(', ')
    );
  }
  return {
    success: true,
    delivered: result.delivered,
    queued: result.queued,
    notFoundAgentNames: result.notFoundAgentNames,
    message: summaryParts.length > 0 ? `Message ${summaryParts.join('; ')}.` : 'No action.',
  };
}

export function renderAgentMessageResult(result: AgentMessageResult): ToolResult {
  if (!result.success) return jsonResult(renderFailure(result));
  if (result.success === 'partial') return jsonResult(renderPartial(result));
  return jsonResult(renderDelivered(result));
}

export function nodeSendMessageHookMeta(context: NodeMessagingContext): HookActionMeta {
  return {
    sessionId: context.sessionId,
    agentName: context.agentName,
    nodeId: context.workflowNodeId,
    taskId: context.runtime.taskId,
  };
}

export function deliverNodeAgentMessage(
  context: NodeMessagingContext,
  nodeExecutionRepo: NodeMessagingDependencies['nodeExecutionRepo']
): (args: NodeSendMessageInput) => Promise<ToolResult> {
  return async (args) => {
    const routed = translateNodeTargets(context, nodeExecutionRepo, args.target);
    if ('reason' in routed) return jsonResult({ success: false, error: routed.reason });
    const result = await context.runtime.agentMessageRouter.deliverMessage({
      fromAgentName: context.agentName,
      fromSessionId: context.sessionId,
      target: routed.value,
      message: args.message,
      data: args.data,
    });
    return renderAgentMessageResult(result);
  };
}

export function bindNodeSendMessage(
  context: NodeMessagingContext,
  nodeExecutionRepo: NodeMessagingDependencies['nodeExecutionRepo']
): (args: NodeSendMessageInput) => Promise<ToolResult> {
  const raw = deliverNodeAgentMessage(context, nodeExecutionRepo);
  const handlers = { send_message: raw as (...args: unknown[]) => Promise<ToolResult> };
  return wrapHandlerWithHooks(
    'send_message',
    raw,
    context.runtime.hookEngine,
    handlers,
    nodeSendMessageHookMeta(context)
  );
}

export function decodeNodeSendMessageResult(result: ToolResult): Result {
  const text = result.content?.[0]?.text;
  let parsed: unknown = null;
  try {
    parsed = typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const validated = resultSchema.safeParse(parsed);
  if (validated.success) return validated.data;
  return {
    success: false,
    error: typeof text === 'string' ? text : 'send_message returned an unreadable result',
  };
}

async function runNodeSendMessage(
  context: NodeMessagingContext,
  deps: NodeMessagingDependencies,
  input: NodeSendMessageInput
): Promise<Result> {
  return decodeNodeSendMessageResult(
    await bindNodeSendMessage(context, deps.nodeExecutionRepo)(input)
  );
}

const SEND_MESSAGE_DESCRIPTION =
  'Send a DM by agent name, fan out by node name, multicast by array, or broadcast with "*"; validates against channel topology. The sender identity — agent name, session, task, workflow run and node — is resolved from the calling node-agent session, never from input, and only workflow worker sessions with an active session are admitted. Workflow send_message hooks run around the delivery and may patch, block, queue or emit follow-ups. Rejects not_a_node_agent when the caller is not a live node-agent session and node_caller_denied when the caller is not an active workflow worker in the run Space.';

export function createNodeSendMessageOperation(deps: NodeMessagingDependencies) {
  const run = (superpipe({ deps })('node-send-message') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitNodeCaller, 'caller', 'result:outcome')
    .pipe(resolveNodeContext, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(requireActiveNodeSession, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(runNodeSendMessage, ['outcome', 'deps', 'input'], 'outcome')
    .endAsync('outcome') as (
    input: NodeSendMessageInput,
    caller: OperationCaller
  ) => Promise<Result>;
  return defineOperation({
    name: 'send_message',
    policy: { safetyClass: 'mutate', roles: ['workflow_worker'] },
    description: SEND_MESSAGE_DESCRIPTION,
    inputSchema,
    resultSchema,
    execute: (input, caller) => run(input, caller),
  });
}
