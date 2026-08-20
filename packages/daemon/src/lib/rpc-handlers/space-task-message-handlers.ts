import type { MessageHub, MessageImage } from '@hyperneo/shared';
import { parseAddress } from '../../../../messaging/src/address';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import { Logger } from '../logger';

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
  pendingMessageQueue?: PendingAgentMessageQueue
): void {
  const taskRepo = new SpaceTaskRepository(db.getDatabase());

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

    const postApproval =
      taskAgentManager.getPostApprovalWorkerSession?.(taskId, target.sessionId) ?? null;
    if (postApproval) {
      const nodeOk = !target.workflowNodeId || postApproval.nodeId === target.workflowNodeId;
      const matchesPostApproval =
        nodeOk &&
        ((!!target.sessionId && target.sessionId === postApproval.sessionId) ||
          (!target.sessionId &&
            !target.nodeExecutionId &&
            !!target.agentName &&
            target.agentName === postApproval.agentName));
      if (matchesPostApproval) {
        const deliver = async (sid: string) =>
          taskAgentManager.injectSubSessionMessage!(sid, message, false, images, deliveryMode);
        try {
          await deliver(postApproval.sessionId);
          return { ok: true, routedTo: [postApproval.agentName] };
        } catch (err) {
          const notFound = err instanceof Error && /Sub-session not found/.test(err.message);
          if (!notFound || !taskAgentManager.restorePostApprovalWorkerSession) throw err;
          const restored = await taskAgentManager.restorePostApprovalWorkerSession(
            taskId,
            postApproval.sessionId
          );
          if (!restored) {
            throw new Error(
              `Post-approval worker "${postApproval.agentName}" is not live and could not be restored (session ${postApproval.sessionId}). Retry once the worker is back online.`
            );
          }
          await deliver(restored);
          return { ok: true, routedTo: [postApproval.agentName] };
        }
      }
    }

    const executions = nodeExecutionRepo
      .listByWorkflowRun(task.workflowRunId)
      .filter((e) => e.status !== 'cancelled' && e.status !== 'pending');

    const inClickedNode = (e: { workflowNodeId?: string }) =>
      target.workflowNodeId ? e.workflowNodeId === target.workflowNodeId : true;
    const matches = target.sessionId
      ? executions.filter((e) => e.agentSessionId === target.sessionId && inClickedNode(e))
      : target.nodeExecutionId
        ? executions.filter((e) => e.id === target.nodeExecutionId)
        : executions.filter(
            (e) =>
              !!target.agentName &&
              e.agentName.toLowerCase() === target.agentName!.toLowerCase() &&
              inClickedNode(e)
          );

    if (matches.length === 0) {
      if (target.sessionId) {
        throw new Error(
          `Session ${target.sessionId} is no longer attached to a workflow node execution for this task. ` +
            `Close and reopen the agent overlay to refresh it.`
        );
      }
      if (target.agentName && taskAgentManager.ensureWorkflowNodeActivationForAgent) {
        const declared = taskAgentManager.getWorkflowDeclaredAgentNamesForTask?.(taskId) ?? [];
        const normalizedName = target.agentName.toLowerCase();
        if (declared.some((n) => n.toLowerCase() === normalizedName)) {
          const didActivate = await taskAgentManager.ensureWorkflowNodeActivationForAgent(
            taskId,
            target.agentName,
            {
              reopenReason: 'human message to unstarted agent',
              ...(target.workflowNodeId ? { workflowNodeId: target.workflowNodeId } : {}),
            }
          );
          if (didActivate) {
            const refreshed = nodeExecutionRepo!
              .listByWorkflowRun(task.workflowRunId!)
              .filter(
                (e) => e.status !== 'cancelled' && !(e.status === 'pending' && e.agentSessionId)
              );
            const activatedMatches = refreshed.filter(
              (e) => e.agentName.toLowerCase() === normalizedName && inClickedNode(e)
            );
            if (activatedMatches.length > 0) {
              matches.push(...activatedMatches);
            }
          }
        }
      }

      if (matches.length === 0) {
        const execNames = executions.map((e) => e.agentName);
        const declared = taskAgentManager.getWorkflowDeclaredAgentNamesForTask?.(taskId) ?? [];
        const available = [...new Set([...execNames, ...declared])].sort();
        throw new Error(
          `Workflow agent not found: ${target.agentName ?? target.nodeExecutionId ?? target.sessionId ?? 'unknown'}. ` +
            `Available agents: ${available.length > 0 ? available.join(', ') : 'none'}`
        );
      }
    }

    let activated = false;
    let deliverable = matches.filter((e) => e.agentSessionId);
    const missingSessionNodeIds = [
      ...new Set(
        matches
          .filter((e) => !e.agentSessionId && e.workflowNodeId)
          .map((e) => e.workflowNodeId as string)
      ),
    ];

    if (deliverable.length === 0 && missingSessionNodeIds.length > 0 && activateNode) {
      await Promise.all(
        missingSessionNodeIds.map((nodeId) => activateNode(task.workflowRunId!, nodeId))
      );
      activated = true;
      const refreshed = nodeExecutionRepo
        .listByWorkflowRun(task.workflowRunId)
        .filter((e) => e.status !== 'cancelled' && !(e.status === 'pending' && e.agentSessionId));
      const refreshedMatches = target.sessionId
        ? refreshed.filter((e) => e.agentSessionId === target.sessionId && inClickedNode(e))
        : target.nodeExecutionId
          ? refreshed.filter((e) => e.id === target.nodeExecutionId)
          : refreshed.filter(
              (e) =>
                !!target.agentName &&
                e.agentName.toLowerCase() === target.agentName!.toLowerCase() &&
                inClickedNode(e)
            );
      deliverable = refreshedMatches.filter((e) => e.agentSessionId);
    }

    if (deliverable.length > 0) {
      await Promise.all(
        deliverable.map((exec) =>
          taskAgentManager.injectSubSessionMessage!(
            exec.agentSessionId!,
            message,
            false,
            images,
            deliveryMode
          )
        )
      );
      return {
        ok: true,
        routedTo: [...new Set(deliverable.map((e) => e.agentName))],
        ...(activated ? { activated: true as const } : {}),
      };
    }

    if (pendingMessageQueue) {
      if (images && images.length > 0) {
        throw new Error(
          'Cannot send images to an agent that is still starting. Wait for the agent to come online and try again.'
        );
      }
      const queuedNames: string[] = [];
      for (const exec of matches) {
        const { record } = pendingMessageQueue.enqueue({
          workflowRunId: task.workflowRunId!,
          spaceId: task.spaceId,
          taskId,
          sourceAgentName: 'human',
          targetKind: 'node_agent',
          targetAgentName: exec.agentName,
          message,
          workflowNodeId: exec.workflowNodeId ?? target.workflowNodeId,
          ...(deliveryMode ? { deliveryMode } : {}),
        });
        if (record) queuedNames.push(exec.agentName);
      }
      return {
        ok: true,
        routedTo: [...new Set(queuedNames)],
        ...(activated ? { activated: true as const } : {}),
        delivered: false,
        queued: true,
      };
    }

    return {
      ok: true,
      routedTo: [...new Set(matches.map((e) => e.agentName))],
      ...(activated ? { activated: true as const } : {}),
      delivered: false,
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
      const injectInto = (sid: string) =>
        taskAgentManager.injectSubSessionMessage!(
          sid,
          params.message,
          false,
          images,
          params.deliveryMode
        );

      for (const mention of mentions) {
        if (postApproval && postApproval.agentName.toLowerCase() === mention.toLowerCase()) {
          try {
            await injectInto(postApproval.sessionId);
            routedTo.push(mention);
            continue;
          } catch (err) {
            const isRehydrateGap =
              err instanceof Error &&
              /Sub-session not found/.test(err.message) &&
              taskAgentManager.restorePostApprovalWorkerSession;
            if (!isRehydrateGap) throw err;
            const restored = await taskAgentManager.restorePostApprovalWorkerSession!(
              params.taskId,
              postApproval.sessionId
            );
            if (!restored) {
              throw new Error(
                `Post-approval worker "${postApproval.agentName}" is not live and could not be restored (session ${postApproval.sessionId}). Retry once the worker is back online.`
              );
            }
            await injectInto(restored);
            routedTo.push(mention);
            continue;
          }
        }
        const matches = activeAgents.filter(
          (e) => e.agentName.toLowerCase() === mention.toLowerCase()
        );
        if (matches.length > 0) {
          await Promise.all(matches.map((exec) => injectInto(exec.agentSessionId!)));
          routedTo.push(mention);
          continue;
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

    const liveSession = taskAgentManager.getSubSessionByAgentName
      ? await taskAgentManager.getSubSessionByAgentName(
          params.taskId,
          params.agentName,
          params.workflowNodeId
        )
      : null;

    if (liveSession && params.message && taskAgentManager.injectSubSessionMessage) {
      const prefixed = `[Message from human]: ${params.message}`;
      await taskAgentManager.injectSubSessionMessage(liveSession.session.id, prefixed, false);
      log.info(
        `space.task.activateNodeAgent: delivered message to live session ${liveSession.session.id} ` +
          `(agent=${params.agentName}, task=${params.taskId})`
      );
      await resetChannelCyclesOnHumanTouch(workflowRunId, params.taskId);
      return {
        ok: true,
        agentName: params.agentName,
        sessionId: liveSession.session.id,
        activated: false,
        queued: false,
      };
    }

    if (liveSession) {
      return {
        ok: true,
        agentName: params.agentName,
        sessionId: liveSession.session.id,
        activated: false,
        queued: false,
      };
    }

    let queuedMessageId: string | null = null;
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

    const activated = taskAgentManager.ensureWorkflowNodeActivationForAgent
      ? await taskAgentManager.ensureWorkflowNodeActivationForAgent(
          params.taskId,
          params.agentName,
          {
            reopenReason: `web client lazy activation of "${params.agentName}"`,
            reopenBy: 'web-client',
            ...(params.workflowNodeId ? { workflowNodeId: params.workflowNodeId } : {}),
          }
        )
      : false;

    log.info(
      `space.task.activateNodeAgent: agent=${params.agentName} task=${params.taskId} ` +
        `node=${params.workflowNodeId ?? 'any'} activated=${activated} queuedMessageId=${queuedMessageId ?? 'none'}`
    );

    if (!activated) {
      throw new Error(
        `Could not activate "${params.agentName}"` +
          (params.workflowNodeId ? ` on node ${params.workflowNodeId}` : '') +
          '. The node may not declare this agent, or activation is temporarily unavailable.'
      );
    }

    await resetChannelCyclesOnHumanTouch(workflowRunId, params.taskId);

    return {
      ok: true,
      agentName: params.agentName,
      sessionId: null,
      activated,
      queued: queuedMessageId !== null,
      ...(queuedMessageId !== null ? { queuedMessageId } : {}),
    };
  });
}
