/**
 * Space Task Message RPC Handlers
 *
 * RPC handlers for human ↔ task agent message routing:
 * - space.task.sendMessage — inject a human message into a task's node agent sessions
 * - space.task.activateNodeAgent — lazy-activate a workflow node agent
 */

import type { MessageHub, MessageImage } from '@hyperneo/shared';
import { parseAddress } from '../../../../messaging/src/address';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import { Logger } from '../logger';

const log = new Logger('space-task-message-handlers');

/**
 * Minimal interface for resetting per-channel cycle counters on a workflow run.
 * Implemented by `ChannelCycleRepository.resetAllForRun`.
 *
 * Extracted so the RPC handler stays decoupled from the concrete repository
 * class and can be unit-tested with a lightweight mock.
 */
export interface ChannelCycleResetter {
  /**
   * Zero out `count` for every `channel_cycles` row belonging to `runId`.
   * Returns the number of rows updated.
   */
  resetAllForRun(runId: string): number;
}

/**
 * Extract @AgentName mentions from message text.
 * Matches patterns like @Coder, @code-reviewer, @planner_1
 * Returns a deduplicated list of mentioned agent names (preserving first occurrence order).
 * Names must start with a letter; digits, hyphens, underscores are allowed subsequently.
 */
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

/**
 * Minimal interface for NodeExecution lookup.
 * Allows the handler to resolve @mention targets without depending on the concrete repository class.
 */
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

/**
 * Minimal interface for interacting with the Task Agent manager.
 * Decouples RPC handlers from the concrete TaskAgentManager class.
 */
export interface TaskAgentManagerInterface {
  /**
   * Optional: inject a message directly into a node agent sub-session by its session ID.
   * Required for @mention routing to specific agents.
   */
  injectSubSessionMessage?(
    subSessionId: string,
    message: string,
    isSyntheticMessage?: boolean,
    images?: MessageImage[]
  ): Promise<string | void>;
  /**
   * Optional: lazy-activate a workflow-declared node agent for a given task.
   *
   * Used by `space.task.activateNodeAgent` so the web UI can spawn a
   * not-started workflow peer (e.g. clicking "Reviewer (Not started)" in
   * the agent dropdown) without going through the Task Agent first.
   *
   * Returns true when the agent's workflow node was activated (or already
   * active), false otherwise (unknown agent, missing workflow, etc.).
   */
  ensureWorkflowNodeActivationForAgent?(
    taskId: string,
    agentName: string,
    options?: { reopenReason?: string; reopenBy?: string; workflowNodeId?: string }
  ): Promise<boolean>;
  /**
   * Optional: list all workflow-declared agent names for a task. Used to
   * validate `space.task.activateNodeAgent` requests before invoking
   * `ensureWorkflowNodeActivationForAgent`.
   */
  getWorkflowDeclaredAgentNamesForTask?(taskId: string): string[];
  /**
   * Optional: look up a live sub-session by agent name within a task. Used
   * by `space.task.activateNodeAgent` to short-circuit when the target is
   * already spawned and to return its sessionId to the caller.
   *
   * `workflowNodeId` scopes the lookup to a specific node so that, when two
   * nodes reuse the same agent slot name, only the clicked node's session is
   * returned (otherwise the first matching session would short-circuit and
   * hijack the activation).
   */
  getSubSessionByAgentName?(
    taskId: string,
    agentName: string,
    workflowNodeId?: string
  ): Promise<{ session: { id: string } } | null>;
}

/**
 * Minimal interface for the pending-message queue used by
 * `space.task.activateNodeAgent` to persist a first-message payload from the
 * web client until the lazily-spawned target session drains the queue.
 */
export interface PendingAgentMessageQueue {
  enqueue(input: {
    workflowRunId: string;
    spaceId: string;
    taskId: string;
    sourceAgentName?: string;
    targetKind: 'node_agent' | 'space_agent';
    targetAgentName: string;
    message: string;
    idempotencyKey?: string | null;
  }): { record: { id: string }; deduped: boolean };
}

type SpaceTaskMessageTarget =
  | { kind: 'node_agent'; agentName: string; nodeExecutionId?: string; workflowNodeId?: string }
  | { kind: 'node_agent'; nodeExecutionId: string; agentName?: string; workflowNodeId?: string }
  | { kind: 'generic'; target: string };

/**
 * Register RPC handlers for human ↔ Task Agent message routing.
 *
 * Separate from `setupSpaceTaskHandlers` because it requires a live
 * `TaskAgentManager` instance, which is created after `SpaceRuntimeService`.
 *
 * Handlers:
 *   space.task.sendMessage  — inject a human message into a Task Agent session
 *   space.task.getMessages  — paginated snapshot of messages from a Task Agent session
 */
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

  /**
   * Best-effort: failure to reset must not fail the RPC, since the reset is an
   * observability/safety-cap side-effect rather than part of the message delivery
   * contract. The emit is suppressed when no rows changed to avoid waking
   * subscribers for a no-op.
   */
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
    images?: MessageImage[]
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
      .filter((e) => e.status !== 'cancelled');

    // When nodeExecutionId is provided, require an exact match — the user
    // disambiguated by execution, so falling back to agentName broadens the
    // match to every execution sharing the same name across all nodes.
    // agentName-only matching is only used when nodeExecutionId is absent.
    // `workflowNodeId` (set from a canvas node click) further scopes the
    // agentName match to the clicked node, so two nodes reusing a slot name
    // never cross-resolve.
    const inClickedNode = (e: { workflowNodeId?: string }) =>
      target.workflowNodeId ? e.workflowNodeId === target.workflowNodeId : true;
    const matches = target.sessionId
      ? executions.filter((e) => e.agentSessionId === target.sessionId)
      : target.nodeExecutionId
        ? executions.filter((e) => e.id === target.nodeExecutionId)
        : executions.filter(
            (e) =>
              !!target.agentName &&
              e.agentName.toLowerCase() === target.agentName!.toLowerCase() &&
              inClickedNode(e)
          );

    if (matches.length === 0) {
      // No existing execution row for this agent. If the agent is declared
      // in the workflow (e.g. a downstream node not yet activated), attempt
      // lazy activation so the user's message triggers the agent spawn.
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
              .filter((e) => e.status !== 'cancelled');
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
        const available = [...new Set(executions.map((e) => e.agentName))].sort();
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
        .filter((e) => e.status !== 'cancelled');
      // Re-apply the same strict matching logic used above (exact
      // nodeExecutionId match when provided, agentName otherwise), including
      // the workflowNodeId scope so a same-name live execution on another node
      // can't capture the clicked node's freshly-activated session.
      const refreshedMatches = target.sessionId
        ? refreshed.filter((e) => e.agentSessionId === target.sessionId)
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

    // Direct delivery: at least one target has a live session.
    if (deliverable.length > 0) {
      await Promise.all(
        deliverable.map((exec) =>
          taskAgentManager.injectSubSessionMessage!(exec.agentSessionId!, message, false, images)
        )
      );
      return {
        ok: true,
        routedTo: [...new Set(deliverable.map((e) => e.agentName))],
        ...(activated ? { activated: true as const } : {}),
      };
    }

    // No live session after activation — persist the message to the
    // pending-message queue so it is delivered when the session spawns.
    // This prevents the user's message from being silently dropped.
    //
    // Limitation: the pending-message queue stores text only. If the user
    // attached images to a message destined for a not-yet-live agent, fail
    // loudly rather than silently dropping the attachments — the caller can
    // retry once the agent is online.
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

    // No queue available — signal that the message could not be delivered.
    // The client is responsible for surfacing this to the user.
    return {
      ok: true,
      routedTo: [...new Set(matches.map((e) => e.agentName))],
      ...(activated ? { activated: true as const } : {}),
      delivered: false,
    };
  }

  // ─── space.task.sendMessage ─────────────────────────────────────────────────
  messageHub.onRequest('space.task.sendMessage', async (data) => {
    const params = data as {
      spaceId: string;
      taskId: string;
      message: string;
      images?: MessageImage[];
      target?: SpaceTaskMessageTarget | null;
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
    // Defensive: collapse `images: []` (which the web client may send) to
    // undefined so downstream code can use `images && images.length > 0`
    // uniformly without re-checking the array length.
    const images =
      Array.isArray(params.images) && params.images.length > 0 ? params.images : undefined;

    // Validate task exists and belongs to the given space
    const task = taskRepo.getTask(params.taskId);
    if (!task) {
      throw new Error(`Task not found: ${params.taskId}`);
    }
    if (task.spaceId !== params.spaceId) {
      throw new Error(`Task not found: ${params.taskId}`);
    }

    if (params.target?.kind === 'node_agent' || params.target?.kind === 'generic') {
      const target =
        params.target.kind === 'generic'
          ? resolveGenericTarget(task, params.target.target)
          : params.target;
      const result = await routeToNodeAgents(task, params.taskId, params.message, target, images);
      log.info(
        `space.task.sendMessage: explicit target routing to [${result.routedTo.join(', ')}] for task ${params.taskId}`
      );
      await resetChannelCyclesOnHumanTouch(task.workflowRunId, params.taskId);
      return result;
    }

    // ── @mention routing ──────────────────────────────────────────────────────
    // If the message contains @AgentName patterns AND the task is linked to a
    // workflow run, route directly to the matched node agent sessions.
    const mentions = parseMentions(params.message);

    if (
      mentions.length > 0 &&
      task.workflowRunId &&
      nodeExecutionRepo &&
      taskAgentManager.injectSubSessionMessage
    ) {
      const executions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
      // Exclude only cancelled agents — they are truly terminal and will never process
      // messages. Idle agents (waiting for input), blocked agents (waiting on dependencies),
      // and pending agents are all reachable and should receive @mention messages.
      const activeAgents = executions.filter(
        (e) => e.agentSessionId !== null && e.status !== 'cancelled'
      );

      const routedTo: string[] = [];
      const notFound: string[] = [];

      for (const mention of mentions) {
        const matches = activeAgents.filter(
          (e) => e.agentName.toLowerCase() === mention.toLowerCase()
        );
        if (matches.length === 0) {
          notFound.push(mention);
        } else {
          // Inject into all matching sessions in parallel (independent operations)
          await Promise.all(
            matches.map((exec) =>
              taskAgentManager.injectSubSessionMessage!(
                exec.agentSessionId!,
                params.message,
                false,
                images
              )
            )
          );
          routedTo.push(mention);
        }
      }

      if (routedTo.length === 0) {
        // No mentions resolved — throw with available agent names
        const available = [...new Set(activeAgents.map((e) => e.agentName))].sort();
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
    // ── end @mention routing ───────────────────────────────────────────────────

    // No @mentions and no explicit target: require a target.
    throw new Error(
      'Target agent is required. Use @mention to specify a target agent, or select a target from the agent list.'
    );
  });

  // ─── space.task.activateNodeAgent ───────────────────────────────────────────
  // Lazy-activate a workflow-declared node agent on demand. Used by the web UI
  // when the user clicks a "(Not started)" peer in the task agent dropdown:
  // the click triggers this RPC, which creates the underlying node_execution
  // row (if missing), spawns the sub-session via the SpaceRuntime tick loop,
  // and (optionally) queues a first message so the spawned session receives
  // the user's prompt as soon as it comes online.
  //
  // Returns the live session ID when one already exists, otherwise indicates
  // that activation has been kicked off — the web client can then watch
  // `space.task.activity` for the new session via the existing live-query
  // subscription.
  messageHub.onRequest('space.task.activateNodeAgent', async (data) => {
    const params = data as {
      spaceId: string;
      taskId: string;
      agentName: string;
      message?: string;
      // Persisted workflow node ID the activation was triggered from (e.g. a
      // canvas node click). Disambiguates two nodes that reuse the same agent
      // slot name so the backend activates the exact clicked node.
      workflowNodeId?: string;
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

    const workflowRunId = task.workflowRunId;

    // Validate the requested agent is actually declared by the workflow.
    // Without this guard, a typo would silently no-op (the helper returns
    // `false` for unknown names) and the user would never see an error.
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

    // Short-circuit when the target is already spawned: skip activation,
    // inject the message directly into the live session (if any), and
    // return its sessionId so the caller hydrates the overlay immediately.
    // `workflowNodeId` scopes the lookup so a same-name session on a
    // different node never short-circuits the clicked node's activation.
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
      // Live session, no message — just acknowledge.
      return {
        ok: true,
        agentName: params.agentName,
        sessionId: liveSession.session.id,
        activated: false,
        queued: false,
      };
    }

    // No live session. Optionally queue the message so the future spawn
    // drains it via `flushPendingMessagesForTarget`.
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
      });
      queuedMessageId = record.id;
    }

    // Fire the activation kick. Idempotent — `channelRouter.activateNode`
    // returns existing tasks early if the node already has active executions.
    // `workflowNodeId` targets the exact clicked node when multiple nodes
    // reuse the same agent slot name.
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
