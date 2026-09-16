import type { NodeExecution, SpaceTask } from '@hyperneo/shared';
import { parseAddress } from '../../../../messaging/src/address.ts';
import type { ActorResolver } from '../../../../messaging/src/contracts.ts';
import type { ActorRef } from '../../../../messaging/src/types.ts';
import { normalizeAgentNameToken } from '../messaging/agent-handle.ts';
import { formatAgentMessage, type AgentMessageLevel } from '../messaging/envelope.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../agents/worker-long-horizon-mapper.ts';
import type { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../session-resolution/target.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import { jsonResult, type ToolResult } from '../space/tools/tool-result.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';

export type TaskRoutingTargetResolution =
  | { kind: 'task-worker'; exec: NodeExecution }
  | { kind: 'long-horizon-agent'; actor: ActorRef }
  | { kind: 'ambiguous'; actors: ActorRef[]; exec?: NodeExecution }
  | { kind: 'no-match' };

export function resolveNodeExecution(
  executions: NodeExecution[],
  selector: string
): NodeExecution | null {
  const trimmed = selector.trim();
  if (!trimmed) return null;
  const byId = executions.find((exec) => exec.id === trimmed);
  if (byId) return byId;

  const targetName = normalizeAgentNameToken(trimmed);
  const byName = executions.filter(
    (exec) => normalizeAgentNameToken(exec.agentName) === targetName
  );
  return byName.at(-1) ?? null;
}

export function resolveWorkerTargetExecution(
  executions: NodeExecution[],
  workflowRunId: string,
  workflowNodeNameById: Map<string, string>,
  target: string
): NodeExecution | null {
  const address = parseAddress(target);
  if (address.kind !== 'worker' || !address.agentName) return null;
  if (address.workflowRunId && address.workflowRunId !== workflowRunId) return null;
  let nodeName: string;
  let agentName: string;
  try {
    nodeName = decodeURIComponent(address.nodeId);
    agentName = decodeURIComponent(address.agentName);
  } catch {
    return null;
  }
  const matches = executions.filter(
    (exec) =>
      normalizeAgentNameToken(exec.agentName) === normalizeAgentNameToken(agentName) &&
      (workflowNodeNameById.get(exec.workflowNodeId) === nodeName ||
        exec.workflowNodeId === nodeName)
  );
  return matches.at(-1) ?? null;
}

export async function resolveHandleForTaskRouting(
  target: string,
  taskExecutions: NodeExecution[],
  spaceId: string,
  workflowRunId: string,
  messageResolver?: ActorResolver,
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository
): Promise<TaskRoutingTargetResolution> {
  const address = parseAddress(target);
  if (address.kind !== 'handle') return { kind: 'no-match' };

  const handle = `@${address.handle}`;
  const canonicalHandle = `@${normalizeAgentNameToken(address.handle)}`;
  const canonicalHandleToken = (value: string) => normalizeAgentNameToken(value).replace(/^@/, '');
  const handlesEquivalent = (actorHandle: string) =>
    canonicalHandleToken(actorHandle) === canonicalHandleToken(handle);
  const taskWorker =
    taskExecutions
      .filter(
        (exec) =>
          exec.workflowRunId === workflowRunId &&
          normalizeAgentNameToken(exec.agentName) === normalizeAgentNameToken(address.handle)
      )
      .at(-1) ?? null;
  const actors = messageResolver
    ? (
        await messageResolver.resolveTargets({
          messageId: `msg_probe_${Date.now()}`,
          spaceId,
          senderActorId: 'system:routing-validation',
          targets: [canonicalHandle],
          body: '',
          kind: 'message',
          workflowRunId,
          createdAt: Date.now(),
        })
      ).resolved
        .map((resolved) => resolved.actor)
        .filter((actor) => actor.handle !== undefined && handlesEquivalent(actor.handle))
    : [];
  const longHorizonActors = actors.filter((actor) => {
    if (actor.actorId.startsWith('system:')) return true;
    if (!actor.actorId.startsWith('agent:')) return false;
    if (!longHorizonAgentRepo) return true;
    const agentId = decodeURIComponent(actor.actorId.slice('agent:'.length));
    const unifiedAgent = longHorizonAgentRepo.getById(agentId);
    if (unifiedAgent?.spaceId !== spaceId) return false;
    return unifiedAgent.templateKey !== MIGRATED_WORKER_TEMPLATE_KEY;
  });

  if (taskWorker && longHorizonActors.length === 0)
    return { kind: 'task-worker', exec: taskWorker };
  if (taskWorker || longHorizonActors.length > 1)
    return { kind: 'ambiguous', actors: longHorizonActors, exec: taskWorker ?? undefined };
  if (longHorizonActors.length === 1)
    return { kind: 'long-horizon-agent', actor: longHorizonActors[0] };
  return { kind: 'no-match' };
}

export function describeTaskExecution(exec: NodeExecution): string {
  return `workflow node "${exec.agentName}" (${exec.id})`;
}

export function describeActor(actor: ActorRef): string {
  return `${actor.handle ?? actor.actorId} (${actor.actorId})`;
}

export function describeAmbiguousTargetActors(actors: ActorRef[], exec?: NodeExecution): string {
  return [
    ...actors.map((actor) => `- ${describeActor(actor)}`),
    ...(exec ? [`- ${describeTaskExecution(exec)}`] : []),
  ].join('\n');
}

export interface TaskWorkerDeliveryConfig {
  taskAgentManager: TaskAgentManager;
  nodeExecutionRepo: Pick<NodeExecutionRepository, 'getById'>;
  ensureTargetSession?: (target: SessionTarget) => Promise<EnsureSessionOutcome>;
  activateNode?: (runId: string, nodeId: string) => Promise<void>;
  mySessionId?: string;
  outboundSenderLevel: AgentMessageLevel;
  outboundSenderDisplayName: string;
  outboundReplyTargetHandle: string | null;
}

export interface TaskWorkerDeliveryCtx {
  task: SpaceTask;
  workflowRunId: string;
  resolved: NodeExecution;
  message: string;
  sessionSelector?: string;
  audit: (outcome: string, extra?: Record<string, unknown>) => void;
  doorOutcome?: EnsureSessionOutcome;
  result?: ToolResult;
}

export function createDeliverTaskWorkerMessagePipeline(
  config: TaskWorkerDeliveryConfig
): (ctx: TaskWorkerDeliveryCtx) => Promise<TaskWorkerDeliveryCtx> {
  const doorTargetFor = (ctx: TaskWorkerDeliveryCtx, waitCapMs?: number): SessionTarget => {
    if (ctx.sessionSelector !== undefined) {
      return { kind: 'session', sessionId: ctx.sessionSelector };
    }
    return {
      kind: 'worker',
      taskId: ctx.task.id,
      agentName: ctx.resolved.agentName,
      workflowNodeId: ctx.resolved.workflowNodeId,
      ...(waitCapMs !== undefined ? { waitCapMs } : {}),
    };
  };

  const nodeAgentEnvelopeFor = (ctx: TaskWorkerDeliveryCtx): string =>
    formatAgentMessage({
      fromLevel: config.outboundSenderLevel,
      fromAgentName: config.outboundSenderDisplayName,
      toLevel: 'node-agent',
      body: ctx.message,
      taskId: ctx.task.id,
      taskNumber: ctx.task.taskNumber,
      nodeId: ctx.resolved.agentName,
      replyToSessionId: config.mySessionId,
      replyTargetHandle: config.outboundReplyTargetHandle,
    });

  const nodeSessionDeliveredResult = (
    ctx: TaskWorkerDeliveryCtx,
    sessionId: string,
    sdkMessageId: string,
    activated: boolean
  ): ToolResult => {
    ctx.audit('delivered', {
      target: 'node',
      node_id: ctx.resolved.id,
      agent_name: ctx.resolved.agentName,
      node_execution_id: ctx.resolved.id,
      delivered_session_id: sessionId,
      sdk_message_id: sdkMessageId,
    });
    return jsonResult({
      success: true,
      task_id: ctx.task.id,
      target: 'node',
      node_execution_id: ctx.resolved.id,
      agent_name: ctx.resolved.agentName,
      delivered_session_id: sessionId,
      sdk_message_id: sdkMessageId,
      activated,
    });
  };

  const tryInjectNodeSession = async (
    ctx: TaskWorkerDeliveryCtx,
    sessionId: string,
    activated: boolean
  ): Promise<ToolResult | undefined> => {
    try {
      const sdkMessageId = await config.taskAgentManager.injectSubSessionMessage(
        sessionId,
        nodeAgentEnvelopeFor(ctx),
        true
      );
      return nodeSessionDeliveredResult(ctx, sessionId, sdkMessageId, activated);
    } catch {
      return undefined;
    }
  };

  const injectNodeSessionOrReport = async (
    ctx: TaskWorkerDeliveryCtx,
    sessionId: string,
    activated: boolean
  ): Promise<ToolResult> => {
    try {
      const sdkMessageId = await config.taskAgentManager.injectSubSessionMessage(
        sessionId,
        nodeAgentEnvelopeFor(ctx),
        true
      );
      return nodeSessionDeliveredResult(ctx, sessionId, sdkMessageId, activated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.audit('error', {
        target: 'node',
        node_id: ctx.resolved.id,
        agent_name: ctx.resolved.agentName,
        reason: message,
      });
      return jsonResult({
        success: false,
        error: `Failed to inject message into node "${ctx.resolved.agentName}": ${message}`,
      });
    }
  };

  const reportActivatedWithoutLiveSession = (ctx: TaskWorkerDeliveryCtx): ToolResult => {
    ctx.audit('activated', {
      target: 'node',
      node_id: ctx.resolved.id,
      agent_name: ctx.resolved.agentName,
      node_execution_id: ctx.resolved.id,
      reason: 'no_live_session_after_activation',
    });
    return jsonResult({
      success: false,
      task_id: ctx.task.id,
      target: 'node',
      node_execution_id: ctx.resolved.id,
      agent_name: ctx.resolved.agentName,
      delivered_session_id: null,
      sdk_message_id: null,
      activated: true,
      delivered: false,
      error:
        `Node "${ctx.resolved.agentName}" was activated but does not yet have a live session; ` +
        `the message was not delivered. Retry after the node starts.`,
    });
  };

  const resolveWorkerDoorStage = async (
    ctx: TaskWorkerDeliveryCtx
  ): Promise<TaskWorkerDeliveryCtx> => {
    if (!config.ensureTargetSession) return ctx;
    return { ...ctx, doorOutcome: await config.ensureTargetSession(doorTargetFor(ctx, 0)) };
  };

  const routeWorkerDoorStage = async (
    ctx: TaskWorkerDeliveryCtx
  ): Promise<TaskWorkerDeliveryCtx> => {
    const outcome = ctx.doorOutcome;
    if (outcome === undefined) return ctx;
    if (outcome.kind === 'resolved') {
      const delivered = await tryInjectNodeSession(ctx, outcome.sessionId, outcome.created);
      return delivered === undefined ? ctx : { ...ctx, result: delivered };
    }
    if (ctx.sessionSelector !== undefined) return ctx;
    if (
      outcome.reason === 'post_approval_pending' ||
      outcome.reason === 'restore_timeout' ||
      outcome.reason === 'spawn_timeout' ||
      (outcome.reason === 'activation_timeout' && ctx.resolved.agentSessionId === null)
    ) {
      return { ...ctx, result: reportActivatedWithoutLiveSession(ctx) };
    }
    if (
      outcome.reason !== 'task_terminal' &&
      outcome.reason !== 'session_resolution_unavailable' &&
      outcome.reason !== 'activation_timeout'
    ) {
      ctx.audit('error', {
        target: 'node',
        node_id: ctx.resolved.id,
        agent_name: ctx.resolved.agentName,
        reason: outcome.reason,
      });
      return {
        ...ctx,
        result: jsonResult({
          success: false,
          error: `Failed to activate node "${ctx.resolved.agentName}": ${outcome.reason}`,
        }),
      };
    }
    return ctx;
  };

  const injectExecutionRowSessionStage = async (
    ctx: TaskWorkerDeliveryCtx
  ): Promise<TaskWorkerDeliveryCtx> => {
    if (ctx.doorOutcome?.kind === 'resolved') return ctx;
    if (ctx.resolved.agentSessionId === null) return ctx;
    const delivered = await tryInjectNodeSession(ctx, ctx.resolved.agentSessionId, false);
    return delivered === undefined ? ctx : { ...ctx, result: delivered };
  };

  const activateNodeStage = async (ctx: TaskWorkerDeliveryCtx): Promise<TaskWorkerDeliveryCtx> => {
    if (!config.activateNode) {
      ctx.audit('failed', {
        target: 'node',
        node_id: ctx.resolved.id,
        agent_name: ctx.resolved.agentName,
        reason: 'activation_callback_missing',
      });
      return {
        ...ctx,
        result: jsonResult({
          success: false,
          error: `Node "${ctx.resolved.agentName}" has no live session and no activation callback is configured.`,
        }),
      };
    }
    try {
      await config.activateNode(ctx.workflowRunId, ctx.resolved.workflowNodeId);
      return ctx;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.audit('error', {
        target: 'node',
        node_id: ctx.resolved.id,
        agent_name: ctx.resolved.agentName,
        reason: message,
      });
      return {
        ...ctx,
        result: jsonResult({
          success: false,
          error: `Failed to activate node "${ctx.resolved.agentName}": ${message}`,
        }),
      };
    }
  };

  const deliverRefreshedSessionStage = async (
    ctx: TaskWorkerDeliveryCtx
  ): Promise<TaskWorkerDeliveryCtx> => {
    const refreshedExecution = config.nodeExecutionRepo.getById(ctx.resolved.id);
    const sessionIdAfter = refreshedExecution?.agentSessionId ?? null;
    if (sessionIdAfter === null) return ctx;
    return { ...ctx, result: await injectNodeSessionOrReport(ctx, sessionIdAfter, true) };
  };

  const reportActivatedWithoutSessionStage = (
    ctx: TaskWorkerDeliveryCtx
  ): TaskWorkerDeliveryCtx => ({ ...ctx, result: reportActivatedWithoutLiveSession(ctx) });

  const workerDeliverySettled = (ctx?: TaskWorkerDeliveryCtx): boolean =>
    ctx !== undefined && ctx.result !== undefined;

  return (
    superpipe<{ settled: typeof workerDeliverySettled }>({
      settled: workerDeliverySettled,
    })('deliver-task-worker-message') as PipelineAPI
  )
    .input(['ctx'])
    .pipe(resolveWorkerDoorStage, 'ctx', 'ctx')
    .pipe('!settled', 'ctx')
    .pipe(routeWorkerDoorStage, 'ctx', 'ctx')
    .pipe('!settled', 'ctx')
    .pipe(injectExecutionRowSessionStage, 'ctx', 'ctx')
    .pipe('!settled', 'ctx')
    .pipe(activateNodeStage, 'ctx', 'ctx')
    .pipe('!settled', 'ctx')
    .pipe(deliverRefreshedSessionStage, 'ctx', 'ctx')
    .pipe('!settled', 'ctx')
    .pipe(reportActivatedWithoutSessionStage, 'ctx', 'ctx')
    .endAsync('ctx') as (ctx: TaskWorkerDeliveryCtx) => Promise<TaskWorkerDeliveryCtx>;
}
