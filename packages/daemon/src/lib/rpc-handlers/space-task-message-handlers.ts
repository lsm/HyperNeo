import type { MessageHub, MessageImage } from '@hyperneo/shared';
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
      const activated = taskAgentManager.ensureWorkflowNodeActivationForAgent
        ? await taskAgentManager.ensureWorkflowNodeActivationForAgent(
            target.taskId,
            target.agentName,
            target.workflowNodeId ? { workflowNodeId: target.workflowNodeId } : undefined
          )
        : false;
      return activated
        ? { kind: 'unresolved', reason: 'activation_timeout' }
        : { kind: 'unresolved', reason: 'activate_failed' };
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
    workflowNodeId?: string
  ): Promise<EnsureSessionOutcome> {
    return resolveTargetSession({
      kind: 'worker',
      taskId,
      agentName,
      ...(workflowNodeId ? { workflowNodeId } : {}),
      waitCapMs: 0,
    });
  }

  async function routeToNodeAgents(
    task: ReturnType<SpaceTaskRepository['getTask']>,
    taskId: string,
    message: string,
    target: ResolvedTaskMessageTarget,
    images?: MessageImage[],
    deliveryMode?: 'immediate' | 'defer'
  ): Promise<{
    ok: true;
    routedTo: string[];
    delivered?: false;
    activated?: true;
    queued?: true;
  }> {
    if (!task?.workflowRunId) {
      throw new Error(`Task ${taskId} has no workflow run — cannot target workflow agents.`);
    }
    if (!nodeExecutionRepo || !taskAgentManager.injectSubSessionMessage) {
      throw new Error('Workflow agent targeting is unavailable on this daemon.');
    }

    const executions = nodeExecutionRepo
      .listByWorkflowRun(task.workflowRunId)
      .filter((execution) => execution.status !== 'cancelled' && execution.status !== 'pending');
    const declared = taskAgentManager.getWorkflowDeclaredAgentNamesForTask?.(taskId) ?? [];
    const postApproval =
      taskAgentManager.getPostApprovalWorkerSession?.(taskId, target.sessionId) ?? null;

    if (target.sessionId) {
      let outcome = await resolveTargetSession({ kind: 'session', sessionId: target.sessionId });
      let agentName =
        executions.find((execution) => execution.agentSessionId === target.sessionId)?.agentName ??
        postApproval?.agentName;
      if (
        outcome.kind === 'unresolved' &&
        postApproval?.sessionId === target.sessionId &&
        (!target.workflowNodeId || postApproval.nodeId === target.workflowNodeId)
      ) {
        agentName = postApproval.agentName;
        outcome = await ensureWorker(
          taskId,
          postApproval.agentName,
          postApproval.nodeId ?? undefined
        );
      }
      if (outcome.kind === 'unresolved' || !agentName) {
        throw new Error(
          `Session ${target.sessionId} is no longer attached to a workflow node execution for this task. ` +
            'Close and reopen the agent overlay to refresh it.'
        );
      }
      await injectResolvedSession(
        taskId,
        outcome.sessionId,
        agentName,
        message,
        images,
        deliveryMode
      );
      return { ok: true, routedTo: [agentName] };
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
    const workerTargets = [
      ...matchingExecutions.map((execution) => ({
        agentName: execution.agentName,
        workflowNodeId: execution.workflowNodeId,
      })),
      ...(matchesPostApproval
        ? [{ agentName: postApproval.agentName, workflowNodeId: postApproval.nodeId ?? undefined }]
        : []),
    ].filter(
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

    const outcomes = await Promise.all(
      workerTargets.map(async (worker) => ({
        worker,
        outcome: await ensureWorker(taskId, worker.agentName, worker.workflowNodeId),
      }))
    );
    const resolved = outcomes.filter(
      (
        item
      ): item is typeof item & { outcome: Extract<EnsureSessionOutcome, { kind: 'resolved' }> } =>
        item.outcome.kind === 'resolved'
    );
    await Promise.all(
      resolved.map(({ worker, outcome }) =>
        injectResolvedSession(
          taskId,
          outcome.sessionId,
          worker.agentName,
          message,
          images,
          deliveryMode
        )
      )
    );

    const unresolved = outcomes.filter((item) => item.outcome.kind === 'unresolved');
    const activated = outcomes.some((item) =>
      item.outcome.kind === 'resolved'
        ? item.outcome.created
        : item.outcome.reason === 'activation_timeout'
    );
    if (unresolved.length === 0) {
      return {
        ok: true,
        routedTo: [...new Set(resolved.map(({ worker }) => worker.agentName))],
        ...(activated ? { activated: true as const } : {}),
      };
    }

    if (images && images.length > 0) {
      throw new Error(
        'Cannot send images to an agent that is still starting. Wait for the agent to come online and try again.'
      );
    }
    if (pendingMessageQueue) {
      for (const { worker } of unresolved) {
        pendingMessageQueue.enqueue({
          workflowRunId: task.workflowRunId,
          spaceId: task.spaceId,
          taskId,
          sourceAgentName: 'human',
          targetKind: 'node_agent',
          targetAgentName: worker.agentName,
          message,
          workflowNodeId: worker.workflowNodeId,
          ...(deliveryMode ? { deliveryMode } : {}),
        });
      }
    }
    return {
      ok: true,
      routedTo: [...new Set(outcomes.map(({ worker }) => worker.agentName))],
      ...(activated ? { activated: true as const } : {}),
      delivered: false,
      ...(pendingMessageQueue ? { queued: true as const } : {}),
    };
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

      for (const mention of mentions) {
        if (postApproval && postApproval.agentName.toLowerCase() === mention.toLowerCase()) {
          const outcome = await ensureWorker(
            params.taskId,
            postApproval.agentName,
            postApproval.nodeId ?? undefined
          );
          if (outcome.kind === 'resolved') {
            await injectResolvedSession(
              params.taskId,
              outcome.sessionId,
              postApproval.agentName,
              params.message,
              images,
              params.deliveryMode
            );
            routedTo.push(mention);
            continue;
          }
          throw new Error(
            `Post-approval worker "${postApproval.agentName}" is not live and could not be restored (session ${postApproval.sessionId}). Retry once the worker is back online.`
          );
        }
        const matches = activeAgents.filter(
          (e) => e.agentName.toLowerCase() === mention.toLowerCase()
        );
        if (matches.length > 0) {
          const workerTargets = matches.filter(
            (match, index, all) =>
              all.findIndex((candidate) => candidate.workflowNodeId === match.workflowNodeId) ===
              index
          );
          const outcomes = await Promise.all(
            workerTargets.map((match) =>
              ensureWorker(params.taskId, match.agentName, match.workflowNodeId)
            )
          );
          const resolved = outcomes.filter(
            (outcome): outcome is Extract<EnsureSessionOutcome, { kind: 'resolved' }> =>
              outcome.kind === 'resolved'
          );
          if (resolved.length > 0) {
            await Promise.all(
              resolved.map((outcome) =>
                injectResolvedSession(
                  params.taskId,
                  outcome.sessionId,
                  mention,
                  params.message,
                  images,
                  params.deliveryMode
                )
              )
            );
            routedTo.push(mention);
            continue;
          }
        }
        notFound.push(mention);
      }

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

    const outcome = await ensureWorker(params.taskId, params.agentName, params.workflowNodeId);
    if (outcome.kind === 'resolved') {
      if (params.message) {
        await injectResolvedSession(
          params.taskId,
          outcome.sessionId,
          params.agentName,
          `[Message from human]: ${params.message}`
        );
        log.info(
          `space.task.activateNodeAgent: delivered message to session ${outcome.sessionId} ` +
            `(agent=${params.agentName}, task=${params.taskId})`
        );
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

    if (outcome.reason !== 'activation_timeout') {
      throw new Error(
        `Could not activate "${params.agentName}"` +
          (params.workflowNodeId ? ` on node ${params.workflowNodeId}` : '') +
          '. The node may not declare this agent, or activation is temporarily unavailable.'
      );
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
