import type { MessageHub, MessageImage } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { parseAddress } from '../../../../messaging/src/address.ts';
import type { Database } from '../../storage/database.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../session-resolution/target.ts';

const log = new Logger('space-task-message-handlers');

export interface ChannelCycleResetter {
  resetAllForRun(runId: string): number;
}

export function parseMentions(text: string): string[] {
  const mentionRegex = /@([A-Za-z][A-Za-z0-9_-]*)/g;
  const seen = new Set<string>();
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    const name = match[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      matches.push(name);
    }
  }
  return matches;
}

export interface NodeExecutionLookup {
  listByWorkflowRun(workflowRunId: string): Array<{
    id?: string;
    workflowNodeId?: string;
    agentName: string;
    agentSessionId: string | null;
    status: string;
  }>;
}

type ResolvedTaskMessageTarget = {
  agentName?: string;
  nodeExecutionId?: string;
  sessionId?: string;
  workflowNodeId?: string;
};

type NodeAgentRouteResult = {
  ok: true;
  routedTo: string[];
  delivered?: false;
  activated?: true;
  queued?: true;
};

type NodeAgentWorkerTarget = {
  agentName: string;
  workflowNodeId?: string;
};

type NodeAgentRouteOutcome = {
  worker: NodeAgentWorkerTarget;
  outcome: EnsureSessionOutcome;
};

type NodeAgentRouteContext = {
  task: ReturnType<SpaceTaskRepository['getTask']>;
  taskId: string;
  message: string;
  target: ResolvedTaskMessageTarget;
  images?: MessageImage[];
  deliveryMode?: 'immediate' | 'defer';
  workflowRunId?: string;
  executions?: ReturnType<NodeExecutionLookup['listByWorkflowRun']>;
  declared?: string[];
  postApproval?: ReturnType<NonNullable<TaskAgentManagerInterface['getPostApprovalWorkerSession']>>;
  workerTargets?: NodeAgentWorkerTarget[];
  outcomes?: NodeAgentRouteOutcome[];
  resolved?: Array<
    NodeAgentRouteOutcome & {
      outcome: Extract<EnsureSessionOutcome, { kind: 'resolved' }>;
    }
  >;
  unresolved?: Array<
    NodeAgentRouteOutcome & {
      outcome: Extract<EnsureSessionOutcome, { kind: 'unresolved' }>;
    }
  >;
  result?: NodeAgentRouteResult;
  sessionAgentName?: string;
  queued?: boolean;
};

export interface TaskAgentManagerInterface {
  injectSubSessionMessage?(
    subSessionId: string,
    message: string,
    isSyntheticMessage?: boolean,
    images?: MessageImage[],
    deliveryMode?: 'immediate' | 'defer'
  ): Promise<string | void>;
  ensureWorkflowNodeActivationForAgent?(
    taskId: string,
    agentName: string,
    options?: { reopenReason?: string; reopenBy?: string; workflowNodeId?: string }
  ): Promise<boolean>;
  getWorkflowDeclaredAgentNamesForTask?(taskId: string): string[];
  isAgentDeclaredOnNode?(taskId: string, workflowNodeId: string, agentName: string): boolean;
  getSubSessionByAgentName?(
    taskId: string,
    agentName: string,
    workflowNodeId?: string
  ): Promise<{ session: { id: string } } | null>;
  flushPendingMessagesForTarget?(
    workflowRunId: string,
    targetAgentName: string,
    sessionId: string
  ): Promise<void>;
  getPostApprovalWorkerSession?(
    taskId: string,
    hintSessionId?: string
  ): { sessionId: string; agentName: string; nodeId?: string | null } | null;
  restorePostApprovalWorkerSession?(taskId: string, hintSessionId?: string): Promise<string | null>;
}

export type SessionEnsurer = (target: SessionTarget) => Promise<EnsureSessionOutcome>;

export interface PendingAgentMessageQueue {
  enqueue(input: {
    workflowRunId: string;
    spaceId: string;
    taskId: string;
    sourceAgentName?: string;
    targetKind: 'node_agent' | 'space_agent';
    targetAgentName: string;
    message: string;
    workflowNodeId?: string | null;
    idempotencyKey?: string | null;
    deliveryMode?: 'immediate' | 'defer';
  }): { record: { id: string }; deduped: boolean };
  markFailed?(id: string, error: string): unknown;
  getById?(id: string): { status: string; lastError?: string | null } | null;
}

type SpaceTaskMessageTarget =
  | {
      kind: 'node_agent';
      agentName: string;
      nodeExecutionId?: string;
      workflowNodeId?: string;
      sessionId?: string;
    }
  | {
      kind: 'node_agent';
      nodeExecutionId: string;
      agentName?: string;
      workflowNodeId?: string;
      sessionId?: string;
    }
  | { kind: 'generic'; target: string };

export function setupSpaceTaskMessageHandlers(
  messageHub: MessageHub,
  taskAgentManager: TaskAgentManagerInterface,
  db: Database,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  nodeExecutionRepo?: NodeExecutionLookup,
  channelCycleResetter?: ChannelCycleResetter,
  activateNode?: (runId: string, nodeId: string) => Promise<void>,
  pendingMessageQueue?: PendingAgentMessageQueue,
  ensureTargetSession?: SessionEnsurer
): void {
  const taskRepo = new SpaceTaskRepository(db.getDatabase());
  const resolveTargetSession: SessionEnsurer =
    ensureTargetSession ??
    (async (target) => {
      if (target.kind === 'session') {
        return { kind: 'resolved', sessionId: target.sessionId, created: false };
      }
      if (target.kind !== 'worker') return { kind: 'unresolved', reason: 'not_found' };
      const postApproval = taskAgentManager.getPostApprovalWorkerSession?.(target.taskId) ?? null;
      if (
        postApproval &&
        postApproval.agentName === target.agentName &&
        (!target.workflowNodeId || postApproval.nodeId === target.workflowNodeId)
      ) {
        return { kind: 'resolved', sessionId: postApproval.sessionId, created: false };
      }
      const task = taskRepo.getTask(target.taskId);
      const matches = task?.workflowRunId
        ? (nodeExecutionRepo?.listByWorkflowRun(task.workflowRunId) ?? []).filter(
            (execution) =>
              execution.agentName === target.agentName &&
              (!target.workflowNodeId || execution.workflowNodeId === target.workflowNodeId)
          )
        : [];
      const live = matches.filter((execution) => execution.agentSessionId).at(-1);
      if (live?.agentSessionId) {
        return { kind: 'resolved', sessionId: live.agentSessionId, created: false };
      }
      const nodeIds = [...new Set(matches.flatMap((execution) => execution.workflowNodeId ?? []))];
      const workflowRunId = task?.workflowRunId;
      if (workflowRunId && activateNode && nodeIds.length > 0) {
        await Promise.all(nodeIds.map((nodeId) => activateNode(workflowRunId, nodeId)));
        const refreshed = nodeExecutionRepo
          ?.listByWorkflowRun(workflowRunId)
          .filter(
            (execution) =>
              execution.agentName === target.agentName &&
              (!target.workflowNodeId || execution.workflowNodeId === target.workflowNodeId)
          )
          .filter((execution) => execution.agentSessionId)
          .at(-1);
        if (refreshed?.agentSessionId) {
          return { kind: 'resolved', sessionId: refreshed.agentSessionId, created: true };
        }
        return { kind: 'unresolved', reason: 'activation_timeout' };
      }
      if (!taskAgentManager.ensureWorkflowNodeActivationForAgent) {
        return { kind: 'unresolved', reason: 'activate_failed' };
      }
      const activated = await taskAgentManager.ensureWorkflowNodeActivationForAgent(
        target.taskId,
        target.agentName,
        target.workflowNodeId ? { workflowNodeId: target.workflowNodeId } : undefined
      );
      if (!activated) return { kind: 'unresolved', reason: 'activate_failed' };
      const refreshed = task?.workflowRunId
        ? (nodeExecutionRepo?.listByWorkflowRun(task.workflowRunId) ?? [])
            .filter(
              (execution) =>
                execution.agentName === target.agentName &&
                (!target.workflowNodeId || execution.workflowNodeId === target.workflowNodeId)
            )
            .filter((execution) => execution.agentSessionId)
            .at(-1)
        : undefined;
      return refreshed?.agentSessionId
        ? { kind: 'resolved', sessionId: refreshed.agentSessionId, created: true }
        : { kind: 'unresolved', reason: 'activation_timeout' };
    });

  async function resetChannelCyclesOnHumanTouch(
    workflowRunId: string | null | undefined,
    taskId: string
  ): Promise<void> {
    if (!channelCycleResetter || !workflowRunId) return;
    try {
      const rowsReset = channelCycleResetter.resetAllForRun(workflowRunId);
      log.info(
        `workflow.cycles.reset: runId=${workflowRunId} reason=human_touch taskId=${taskId} rowsReset=${rowsReset}`
      );
      if (rowsReset > 0) {
        await internalEventBus.publish('space.workflowRun.cyclesReset', {
          sessionId: 'global',
          runId: workflowRunId,
          reason: 'human_touch',
          taskId,
          rowsReset,
        });
      }
    } catch (err) {
      log.warn(
        `workflow.cycles.reset: failed to reset cycles for task ${taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  function resolveGenericTarget(
    task: ReturnType<SpaceTaskRepository['getTask']>,
    target: string
  ): ResolvedTaskMessageTarget {
    const address = parseAddress(target);
    if (address.kind === 'session') return { sessionId: address.sessionId };
    if (address.kind !== 'worker' || !address.agentName) {
      throw new Error(
        `Generic target ${target} is not routable from this RPC. Use @worker:<node>/<agent> or @session:<task-agent-session>.`
      );
    }
    if (!task?.workflowRunId || !nodeExecutionRepo) {
      throw new Error(
        `Task ${task?.id ?? 'unknown'} has no workflow run — cannot target workflow agents.`
      );
    }
    if (address.workflowRunId && address.workflowRunId !== task.workflowRunId) {
      throw new Error(
        `Worker target ${target} belongs to workflow run ${address.workflowRunId}, not task run ${task.workflowRunId}.`
      );
    }
    let nodeName: string;
    let agentName: string;
    try {
      nodeName = decodeURIComponent(address.nodeId);
      agentName = decodeURIComponent(address.agentName);
    } catch (err) {
      throw new Error(
        `Invalid worker target ${target}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const executions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
    const nodeNameMatches = (workflowNodeId?: string) => {
      if (!workflowNodeId) return false;
      return workflowNodeId === nodeName || workflowNodeId.toLowerCase() === nodeName.toLowerCase();
    };
    const matches = executions.filter(
      (exec) =>
        exec.agentName.toLowerCase() === agentName.toLowerCase() &&
        nodeNameMatches(exec.workflowNodeId)
    );
    const match = matches.at(-1);
    if (!match?.id) {
      throw new Error(`Workflow worker not found for target ${target}.`);
    }
    return { nodeExecutionId: match.id, agentName: match.agentName };
  }

  async function injectResolvedSession(
    taskId: string,
    sessionId: string,
    agentName: string,
    message: string,
    images?: MessageImage[],
    deliveryMode?: 'immediate' | 'defer'
  ): Promise<void> {
    const inject = taskAgentManager.injectSubSessionMessage;
    if (!inject) throw new Error('Workflow agent targeting is unavailable on this daemon.');
    try {
      await inject(sessionId, message, false, images, deliveryMode);
    } catch (err) {
      const postApproval =
        taskAgentManager.getPostApprovalWorkerSession?.(taskId, sessionId) ?? null;
      const canRestore =
        err instanceof Error &&
        /Sub-session not found/.test(err.message) &&
        postApproval?.sessionId === sessionId &&
        taskAgentManager.restorePostApprovalWorkerSession;
      if (!canRestore) throw err;
      const restored = await taskAgentManager.restorePostApprovalWorkerSession?.(taskId, sessionId);
      if (!restored) {
        throw new Error(
          `Post-approval worker "${agentName}" is not live and could not be restored (session ${sessionId}). Retry once the worker is back online.`
        );
      }
      await inject(restored, message, false, images, deliveryMode);
    }
  }

  async function ensureWorker(
    taskId: string,
    agentName: string,
    workflowNodeId?: string,
    reopen?: { reopenReason: string; reopenBy: string }
  ): Promise<EnsureSessionOutcome> {
    return resolveTargetSession({
      kind: 'worker',
      taskId,
      agentName,
      ...(workflowNodeId ? { workflowNodeId } : {}),
      ...(reopen ?? {}),
      waitCapMs: 0,
    });
  }

  function classifyNodeAgentRoute(ctx: NodeAgentRouteContext): NodeAgentRouteContext {
    if (!ctx.task?.workflowRunId) {
      throw new Error(`Task ${ctx.taskId} has no workflow run — cannot target workflow agents.`);
    }
    if (!nodeExecutionRepo || !taskAgentManager.injectSubSessionMessage) {
      throw new Error('Workflow agent targeting is unavailable on this daemon.');
    }
    return {
      ...ctx,
      workflowRunId: ctx.task.workflowRunId,
      executions: nodeExecutionRepo
        .listByWorkflowRun(ctx.task.workflowRunId)
        .filter((execution) => execution.status !== 'cancelled'),
      declared: taskAgentManager.getWorkflowDeclaredAgentNamesForTask?.(ctx.taskId) ?? [],
      postApproval:
        taskAgentManager.getPostApprovalWorkerSession?.(ctx.taskId, ctx.target.sessionId) ?? null,
    };
  }

  function selectNodeAgentTargets(ctx: NodeAgentRouteContext): NodeAgentRouteContext {
    const target = ctx.target;
    const executions = ctx.executions!;
    const declared = ctx.declared!;
    const postApproval = ctx.postApproval ?? null;

    if (target.sessionId) {
      const attachedExecution = executions.find(
        (execution) =>
          execution.agentSessionId === target.sessionId &&
          (!target.workflowNodeId || execution.workflowNodeId === target.workflowNodeId)
      );
      const sessionAgentName =
        attachedExecution?.agentName ??
        (!target.workflowNodeId || postApproval?.nodeId === target.workflowNodeId
          ? postApproval?.agentName
          : undefined);
      return { ...ctx, sessionAgentName };
    }

    const exactExecution = target.nodeExecutionId
      ? executions.find((execution) => execution.id === target.nodeExecutionId)
      : undefined;
    if (target.nodeExecutionId && !exactExecution) {
      const available = [...new Set([...executions.map((e) => e.agentName), ...declared])].sort();
      throw new Error(
        `Workflow agent not found: ${target.nodeExecutionId}. Available agents: ${available.length > 0 ? available.join(', ') : 'none'}`
      );
    }

    const normalizedName = target.agentName?.toLowerCase();
    const matchingExecutions = exactExecution
      ? [exactExecution]
      : executions.filter(
          (execution) =>
            normalizedName !== undefined &&
            execution.agentName.toLowerCase() === normalizedName &&
            (!target.workflowNodeId || execution.workflowNodeId === target.workflowNodeId)
        );
    const matchesPostApproval =
      !target.nodeExecutionId &&
      normalizedName !== undefined &&
      postApproval?.agentName.toLowerCase() === normalizedName &&
      (!target.workflowNodeId || postApproval.nodeId === target.workflowNodeId);
    const workerTargets = (
      matchesPostApproval
        ? [
            {
              agentName: postApproval.agentName,
              workflowNodeId: postApproval.nodeId ?? undefined,
            },
          ]
        : matchingExecutions.map((execution) => ({
            agentName: execution.agentName,
            workflowNodeId: execution.workflowNodeId,
          }))
    ).filter(
      (worker, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.agentName === worker.agentName &&
            candidate.workflowNodeId === worker.workflowNodeId
        ) === index
    );

    if (workerTargets.length === 0 && target.agentName) {
      const declaredName = declared.find((name) => name.toLowerCase() === normalizedName);
      if (declaredName) {
        workerTargets.push({ agentName: declaredName, workflowNodeId: target.workflowNodeId });
      } else {
        const available = [...new Set([...executions.map((e) => e.agentName), ...declared])].sort();
        throw new Error(
          `Workflow agent not found: ${target.agentName}. Available agents: ${available.length > 0 ? available.join(', ') : 'none'}`
        );
      }
    }

    return { ...ctx, workerTargets };
  }

  async function resolveNodeAgentTargets(
    ctx: NodeAgentRouteContext
  ): Promise<NodeAgentRouteContext> {
    const target = ctx.target;
    if (target.sessionId) {
      let outcome = await resolveTargetSession({ kind: 'session', sessionId: target.sessionId });
      const postApproval = ctx.postApproval ?? null;
      if (
        outcome.kind === 'unresolved' &&
        postApproval?.sessionId === target.sessionId &&
        (!target.workflowNodeId || postApproval.nodeId === target.workflowNodeId)
      ) {
        outcome = await ensureWorker(
          ctx.taskId,
          postApproval.agentName,
          postApproval.nodeId ?? undefined
        );
      }
      const worker = {
        agentName: ctx.sessionAgentName ?? '',
        workflowNodeId: target.workflowNodeId,
      };
      return { ...ctx, outcomes: [{ worker, outcome }] };
    }

    const outcomes = await Promise.all(
      ctx.workerTargets!.map(async (worker) => ({
        worker,
        outcome: await ensureWorker(ctx.taskId, worker.agentName, worker.workflowNodeId),
      }))
    );
    return { ...ctx, outcomes };
  }

  function rejectUnroutableNodeAgentTargets(ctx: NodeAgentRouteContext): NodeAgentRouteContext {
    const outcomes = ctx.outcomes!;
    const target = ctx.target;
    const resolved = outcomes.filter(
      (
        item
      ): item is typeof item & { outcome: Extract<EnsureSessionOutcome, { kind: 'resolved' }> } =>
        item.outcome.kind === 'resolved'
    );
    const unresolved = outcomes.filter(
      (
        item
      ): item is typeof item & {
        outcome: Extract<EnsureSessionOutcome, { kind: 'unresolved' }>;
      } => item.outcome.kind === 'unresolved'
    );

    if (target.sessionId && (unresolved.length > 0 || !ctx.sessionAgentName)) {
      throw new Error(
        `Session ${target.sessionId} is no longer attached to a workflow node execution for this task. ` +
          'Close and reopen the agent overlay to refresh it.'
      );
    }
    const rejected = unresolved.find(
      (item) =>
        item.outcome.reason !== 'activation_timeout' &&
        item.outcome.reason !== 'post_approval_pending' &&
        item.outcome.reason !== 'restore_timeout' &&
        item.outcome.reason !== 'spawn_timeout' &&
        item.outcome.reason !== 'activate_failed'
    );
    if (rejected) {
      throw new Error(
        `Could not resolve workflow agent "${rejected.worker.agentName}": ${rejected.outcome.reason}`
      );
    }
    if (unresolved.length > 0 && ctx.images && ctx.images.length > 0) {
      throw new Error(
        'Cannot send images to an agent that is still starting. Wait for the agent to come online and try again.'
      );
    }
    return { ...ctx, resolved, unresolved };
  }

  async function injectNodeAgentMessages(
    ctx: NodeAgentRouteContext
  ): Promise<NodeAgentRouteContext> {
    await Promise.all(
      ctx.resolved!.map(({ worker, outcome }) =>
        injectResolvedSession(
          ctx.taskId,
          outcome.sessionId,
          worker.agentName,
          ctx.message,
          ctx.images,
          ctx.deliveryMode
        )
      )
    );
    return ctx;
  }

  function queueUnresolvedNodeAgentMessages(ctx: NodeAgentRouteContext): NodeAgentRouteContext {
    if (!pendingMessageQueue || ctx.unresolved!.length === 0) return ctx;
    for (const { worker } of ctx.unresolved!) {
      pendingMessageQueue.enqueue({
        workflowRunId: ctx.workflowRunId!,
        spaceId: ctx.task!.spaceId,
        taskId: ctx.taskId,
        sourceAgentName: 'human',
        targetKind: 'node_agent',
        targetAgentName: worker.agentName,
        message: ctx.message,
        workflowNodeId: worker.workflowNodeId,
        ...(ctx.deliveryMode ? { deliveryMode: ctx.deliveryMode } : {}),
      });
    }
    return { ...ctx, queued: true };
  }

  function settleNodeAgentRoute(ctx: NodeAgentRouteContext): NodeAgentRouteContext {
    const outcomes = ctx.outcomes!;
    const unresolved = ctx.unresolved!;
    const resolved = ctx.resolved!;
    const activated =
      !ctx.target.sessionId &&
      outcomes.some((item) =>
        item.outcome.kind === 'resolved'
          ? item.outcome.created
          : item.outcome.reason === 'activation_timeout'
      );
    const routedTo = [
      ...new Set(
        (unresolved.length === 0 ? resolved : outcomes).map(({ worker }) => worker.agentName)
      ),
    ];
    const result: NodeAgentRouteResult =
      unresolved.length === 0
        ? {
            ok: true,
            routedTo,
            ...(activated ? { activated: true } : {}),
          }
        : {
            ok: true,
            routedTo,
            ...(activated ? { activated: true } : {}),
            delivered: false,
            ...(ctx.queued ? { queued: true } : {}),
          };
    return { ...ctx, result };
  }

  const runRouteToNodeAgents = (
    superpipe({
      hasResult: (ctx: NodeAgentRouteContext) => ctx.result !== undefined,
    })('route-to-node-agents') as PipelineAPI
  )
    .input(['ctx'])
    .pipe(classifyNodeAgentRoute, 'ctx', 'ctx')
    .pipe('!hasResult', 'ctx')
    .pipe(selectNodeAgentTargets, 'ctx', 'ctx')
    .pipe('!hasResult', 'ctx')
    .pipe(resolveNodeAgentTargets, 'ctx', 'ctx')
    .pipe('!hasResult', 'ctx')
    .pipe(rejectUnroutableNodeAgentTargets, 'ctx', 'ctx')
    .pipe('!hasResult', 'ctx')
    .pipe(injectNodeAgentMessages, 'ctx', 'ctx')
    .pipe('!hasResult', 'ctx')
    .pipe(queueUnresolvedNodeAgentMessages, 'ctx', 'ctx')
    .pipe('!hasResult', 'ctx')
    .pipe(settleNodeAgentRoute, 'ctx', 'ctx')
    .endAsync('ctx') as (ctx: NodeAgentRouteContext) => Promise<NodeAgentRouteContext>;

  async function routeToNodeAgents(
    task: ReturnType<SpaceTaskRepository['getTask']>,
    taskId: string,
    message: string,
    target: ResolvedTaskMessageTarget,
    images?: MessageImage[],
    deliveryMode?: 'immediate' | 'defer'
  ): Promise<NodeAgentRouteResult> {
    const ctx = await runRouteToNodeAgents({ task, taskId, message, target, images, deliveryMode });
    return ctx.result!;
  }

  messageHub.onRequest('space.task.sendMessage', async (data) => {
    const params = data as {
      spaceId: string;
      taskId: string;
      message: string;
      images?: MessageImage[];
      target?: SpaceTaskMessageTarget | null;
      deliveryMode?: 'immediate' | 'defer';
    };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }
    if (!params.taskId) {
      throw new Error('taskId is required');
    }
    if (!params.message || params.message.trim() === '') {
      throw new Error('message is required');
    }
    if (params.message.length > 100_000) {
      throw new Error('Message is too long (max 100,000 characters)');
    }
    if (
      params.deliveryMode !== undefined &&
      params.deliveryMode !== 'immediate' &&
      params.deliveryMode !== 'defer'
    ) {
      throw new Error('Invalid deliveryMode');
    }
    const images =
      Array.isArray(params.images) && params.images.length > 0 ? params.images : undefined;

    const task = taskRepo.getTask(params.taskId);
    if (!task) {
      throw new Error(`Task not found: ${params.taskId}`);
    }
    if (task.spaceId !== params.spaceId) {
      throw new Error(`Task not found: ${params.taskId}`);
    }
    if (task.status === 'stopped') {
      throw new Error(`Task ${params.taskId} is stopped — resume it before sending messages`);
    }

    if (params.target?.kind === 'node_agent' || params.target?.kind === 'generic') {
      if (
        params.target.kind === 'node_agent' &&
        !params.target.sessionId &&
        !params.target.nodeExecutionId &&
        (!params.target.agentName || params.target.agentName.trim() === '')
      ) {
        throw new Error('Node-agent target requires agentName, nodeExecutionId, or sessionId');
      }
      const target =
        params.target.kind === 'generic'
          ? resolveGenericTarget(task, params.target.target)
          : params.target;
      const result = await routeToNodeAgents(
        task,
        params.taskId,
        params.message,
        target,
        images,
        params.deliveryMode
      );
      log.info(
        `space.task.sendMessage: explicit target routing to [${result.routedTo.join(', ')}] for task ${params.taskId}`
      );
      await resetChannelCyclesOnHumanTouch(task.workflowRunId, params.taskId);
      return result;
    }

    const mentions = parseMentions(params.message);

    if (
      mentions.length > 0 &&
      task.workflowRunId &&
      nodeExecutionRepo &&
      taskAgentManager.injectSubSessionMessage
    ) {
      const executions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
      const activeAgents = executions.filter(
        (e) => e.agentSessionId !== null && e.status !== 'cancelled' && e.status !== 'pending'
      );

      const routedTo: string[] = [];
      const notFound: string[] = [];

      const postApproval = taskAgentManager.getPostApprovalWorkerSession?.(params.taskId) ?? null;

      const deliveries: Array<{ mention: string; agentName: string; sessionId: string }> = [];
      for (const mention of mentions) {
        if (postApproval && postApproval.agentName.toLowerCase() === mention.toLowerCase()) {
          let outcome = await resolveTargetSession({
            kind: 'session',
            sessionId: postApproval.sessionId,
          });
          if (outcome.kind === 'unresolved') {
            outcome = await ensureWorker(
              params.taskId,
              postApproval.agentName,
              postApproval.nodeId ?? undefined
            );
          }
          if (outcome.kind !== 'resolved') {
            throw new Error(
              `Post-approval worker "${postApproval.agentName}" is not live and could not be restored (session ${postApproval.sessionId}). Retry once the worker is back online.`
            );
          }
          deliveries.push({
            mention,
            agentName: postApproval.agentName,
            sessionId: outcome.sessionId,
          });
          routedTo.push(mention);
          continue;
        }
        const matches = activeAgents.filter(
          (e) => e.agentName.toLowerCase() === mention.toLowerCase()
        );
        if (matches.length > 0) {
          const sessionIds = matches.flatMap((match) => match.agentSessionId ?? []);
          const outcomes = await Promise.all(
            sessionIds.map((sessionId) => resolveTargetSession({ kind: 'session', sessionId }))
          );
          const resolved = outcomes.filter(
            (outcome): outcome is Extract<EnsureSessionOutcome, { kind: 'resolved' }> =>
              outcome.kind === 'resolved'
          );
          if (resolved.length !== outcomes.length) {
            throw new Error(`@mention target is no longer live: ${mention}`);
          }
          if (resolved.length > 0) {
            deliveries.push(
              ...resolved.map((outcome) => ({
                mention,
                agentName: mention,
                sessionId: outcome.sessionId,
              }))
            );
            routedTo.push(mention);
            continue;
          }
        }
        notFound.push(mention);
      }
      await Promise.all(
        deliveries.map((delivery) =>
          injectResolvedSession(
            params.taskId,
            delivery.sessionId,
            delivery.agentName,
            params.message,
            images,
            params.deliveryMode
          )
        )
      );

      if (routedTo.length === 0) {
        const execNames = activeAgents.map((e) => e.agentName);
        const declared =
          taskAgentManager.getWorkflowDeclaredAgentNamesForTask?.(params.taskId) ?? [];
        const available = [
          ...new Set([
            ...execNames,
            ...declared,
            ...(postApproval ? [postApproval.agentName] : []),
          ]),
        ].sort();
        throw new Error(
          `@mention not found: ${notFound.join(', ')}. Available agents: ${available.length > 0 ? available.join(', ') : 'none'}`
        );
      }

      log.info(
        `space.task.sendMessage: @mention routing to [${routedTo.join(', ')}] for task ${params.taskId}`
      );

      await resetChannelCyclesOnHumanTouch(task.workflowRunId, params.taskId);

      return {
        ok: true,
        routedTo,
        ...(notFound.length > 0 ? { notFound } : {}),
      };
    }

    throw new Error(
      'Target agent is required. Use @mention to specify a target agent, or select a target from the agent list.'
    );
  });

  messageHub.onRequest('space.task.activateNodeAgent', async (data) => {
    const params = data as {
      spaceId: string;
      taskId: string;
      agentName: string;
      message?: string;
      workflowNodeId?: string;
      clientMessageId?: string;
    };

    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.taskId) throw new Error('taskId is required');
    if (!params.agentName || params.agentName.trim() === '') {
      throw new Error('agentName is required');
    }
    if (params.message !== undefined) {
      if (typeof params.message !== 'string') {
        throw new Error('message must be a string');
      }
      if (params.message.length > 100_000) {
        throw new Error('Message is too long (max 100,000 characters)');
      }
    }

    const task = taskRepo.getTask(params.taskId);
    if (!task) {
      throw new Error(`Task not found: ${params.taskId}`);
    }
    if (task.spaceId !== params.spaceId) {
      throw new Error(`Task not found: ${params.taskId}`);
    }
    if (!task.workflowRunId) {
      throw new Error(`Task ${params.taskId} has no associated workflow run`);
    }
    if (task.status === 'archived') {
      throw new Error(`Task ${params.taskId} is archived and cannot activate agents`);
    }
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new Error(
        `Task ${params.taskId} is ${task.status} — activateNodeAgent requires an active task`
      );
    }
    if (task.status === 'stopped') {
      throw new Error(`Task ${params.taskId} is stopped — resume it before activating agents`);
    }

    const workflowRunId = task.workflowRunId;

    const declaredNames =
      taskAgentManager.getWorkflowDeclaredAgentNamesForTask?.(params.taskId) ?? [];
    if (!declaredNames.includes(params.agentName)) {
      throw new Error(
        `Agent "${params.agentName}" is not declared in this task's workflow. ` +
          (declaredNames.length > 0
            ? `Declared agents: ${declaredNames.join(', ')}.`
            : 'No agents are declared for this task.')
      );
    }

    if (params.workflowNodeId && taskAgentManager.isAgentDeclaredOnNode) {
      if (
        !taskAgentManager.isAgentDeclaredOnNode(
          params.taskId,
          params.workflowNodeId,
          params.agentName
        )
      ) {
        throw new Error(
          `Node ${params.workflowNodeId} does not declare agent "${params.agentName}"`
        );
      }
    }

    let queuedMessageId: string | null = null;
    if (params.message && pendingMessageQueue) {
      const { record } = pendingMessageQueue.enqueue({
        workflowRunId,
        spaceId: params.spaceId,
        taskId: params.taskId,
        sourceAgentName: 'human',
        targetKind: 'node_agent',
        targetAgentName: params.agentName,
        message: params.message,
        workflowNodeId: params.workflowNodeId,
        idempotencyKey: params.clientMessageId
          ? `human:${params.taskId}:${params.agentName}:${params.workflowNodeId ?? ''}:${params.clientMessageId}`
          : `human:${params.taskId}:${params.agentName}:${params.workflowNodeId ?? ''}:${params.message}`,
      });
      queuedMessageId = record.id;
    }

    const outcome = await ensureWorker(params.taskId, params.agentName, params.workflowNodeId, {
      reopenReason: `web client lazy activation of "${params.agentName}"`,
      reopenBy: 'web-client',
    });
    const queueableReasons = new Set([
      'activation_timeout',
      'post_approval_pending',
      'restore_timeout',
      'spawn_timeout',
    ]);
    if (
      outcome.kind === 'unresolved' &&
      !queueableReasons.has(outcome.reason) &&
      queuedMessageId !== null
    ) {
      pendingMessageQueue?.markFailed?.(queuedMessageId, outcome.reason);
    }
    if (outcome.kind === 'resolved') {
      const canDrainQueuedMessage =
        queuedMessageId !== null &&
        taskAgentManager.flushPendingMessagesForTarget !== undefined &&
        pendingMessageQueue?.getById !== undefined;
      if (params.message && canDrainQueuedMessage && queuedMessageId !== null) {
        await taskAgentManager.flushPendingMessagesForTarget!(
          workflowRunId,
          params.agentName,
          outcome.sessionId
        );
        const queuedRecord = pendingMessageQueue!.getById!(queuedMessageId);
        if (queuedRecord?.status !== 'delivered') {
          throw new Error(
            `Queued message ${queuedMessageId} was not delivered to "${params.agentName}": ${queuedRecord?.lastError ?? queuedRecord?.status ?? 'delivery status unavailable'}`
          );
        }
        log.info(
          `space.task.activateNodeAgent: delivered queued message to session ${outcome.sessionId} ` +
            `(agent=${params.agentName}, task=${params.taskId})`
        );
      } else if (params.message) {
        await injectResolvedSession(
          params.taskId,
          outcome.sessionId,
          params.agentName,
          `[Message from human]: ${params.message}`
        );
        if (queuedMessageId !== null) {
          pendingMessageQueue?.markFailed?.(queuedMessageId, 'delivered directly');
        }
        log.info(
          `space.task.activateNodeAgent: delivered message to session ${outcome.sessionId} ` +
            `(agent=${params.agentName}, task=${params.taskId})`
        );
      }
      if (outcome.created || params.message) {
        await resetChannelCyclesOnHumanTouch(workflowRunId, params.taskId);
      }
      return {
        ok: true,
        agentName: params.agentName,
        sessionId: outcome.sessionId,
        activated: outcome.created,
        queued: false,
      };
    }

    if (!queueableReasons.has(outcome.reason)) {
      throw new Error(
        `Could not activate "${params.agentName}"` +
          (params.workflowNodeId ? ` on node ${params.workflowNodeId}` : '') +
          '. The node may not declare this agent, or activation is temporarily unavailable.'
      );
    }

    log.info(
      `space.task.activateNodeAgent: agent=${params.agentName} task=${params.taskId} ` +
        `node=${params.workflowNodeId ?? 'any'} activated=true queuedMessageId=${queuedMessageId ?? 'none'}`
    );

    await resetChannelCyclesOnHumanTouch(workflowRunId, params.taskId);

    return {
      ok: true,
      agentName: params.agentName,
      sessionId: null,
      activated: true,
      queued: queuedMessageId !== null,
      ...(queuedMessageId !== null ? { queuedMessageId } : {}),
    };
  });
}
