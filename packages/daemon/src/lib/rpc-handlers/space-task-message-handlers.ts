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
 * Minimal interface for resetting per-channel cycle state on a workflow run.
 * Implemented by `ChannelCycleRepository.resetAllForRun`, which clears the
 * rate-window event history for the run (lifting any active dead-loop block).
 *
 * Extracted so the RPC handler stays decoupled from the concrete repository
 * class and can be unit-tested with a lightweight mock.
 */
export interface ChannelCycleResetter {
  /**
   * Clear cyclic-channel dead-loop state for every channel in `runId`.
   * Returns the number of event rows deleted (0 is valid — nothing to reset).
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
   *
   * `deliveryMode` ('defer') is forwarded from `space.task.sendMessage` so a
   * human message can be persisted as `deferred` and replayed at the next idle
   * boundary instead of steering the current turn. This interface declares only
   * the params this handler uses; the real `TaskAgentManager.injectSubSessionMessage`
   * additionally accepts `inputKindOverride` and `messageId`.
   */
  injectSubSessionMessage?(
    subSessionId: string,
    message: string,
    isSyntheticMessage?: boolean,
    images?: MessageImage[],
    deliveryMode?: 'immediate' | 'defer'
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
   * Check whether a specific workflow node declares an agent slot. Used for
   * pre-enqueue validation so a row scoped to an obsolete nodeId (the agent
   * moved to another node) is rejected before it's persisted.
   */
  isAgentDeclaredOnNode?(taskId: string, workflowNodeId: string, agentName: string): boolean;
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
  /**
   * Optional: resolve the persisted post-approval worker session (e.g. the
   * `merger`) for a task. The worker is an execution-less node agent — it has a
   * session but no node_executions row — so it is invisible to execution-based
   * matching. Used by `space.task.sendMessage` to route human replies to it.
   * Returns `null` when the task has no spawned post-approval worker.
   */
  getPostApprovalWorkerSession?(
    taskId: string,
    hintSessionId?: string
  ): { sessionId: string; agentName: string; nodeId?: string | null } | null;
  /**
   * Optional: restore a persisted post-approval worker session to memory on
   * demand. The worker has no node_executions row, so it cannot be rehydrated
   * by the normal path after a daemon restart; this brings it back so a human
   * reply reaches it instead of failing with "Sub-session not found". Returns
   * the session id on success (restored or already live), or null if it cannot
   * be restored.
   */
  restorePostApprovalWorkerSession?(taskId: string, hintSessionId?: string): Promise<string | null>;
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
    /** Persisted workflow node ID the message targets (scopes the drain). */
    workflowNodeId?: string | null;
    idempotencyKey?: string | null;
    /**
     * Persisted delivery mode replayed on flush so a deferred ("queue for next
     * turn") human message to a not-yet-live agent defers after spawn instead
     * of defaulting to immediate and steering the kickoff turn.
     */
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
  pendingMessageQueue?: PendingAgentMessageQueue,
  handoffCycleResetter?: ChannelCycleResetter
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
    if (!workflowRunId) return;
    if (!channelCycleResetter && !handoffCycleResetter) return;
    try {
      // Reset both cycle stores so the "consecutive autonomous cycles without
      // human oversight" cap (channel AND handoff transitions) clears together
      // whenever the run regains human attention.
      const channelRows = channelCycleResetter?.resetAllForRun(workflowRunId) ?? 0;
      const handoffRows = handoffCycleResetter?.resetAllForRun(workflowRunId) ?? 0;
      const rowsReset = channelRows + handoffRows;
      log.info(
        `workflow.cycles.reset: runId=${workflowRunId} reason=human_touch taskId=${taskId} rowsReset=${rowsReset} (channels=${channelRows} handoffs=${handoffRows})`
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
    /**
     * Delivery hint forwarded to `injectSubSessionMessage` so a human message
     * can be deferred to the next idle boundary instead of steering the current
     * turn. `undefined` falls back to the inject default (`'immediate'`).
     */
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

    // Post-approval worker (e.g. the merger) is an execution-less node agent:
    // it has a live session but no node_executions row, so the execution-based
    // matching below cannot resolve it and would throw "Workflow agent not
    // found: agent". Resolve it from the canonical persisted link
    // (space_tasks.post_approval_session_id) and deliver directly when the
    // reply targets it. The agent-name shortcut is gated on the absence of an
    // explicit session/execution id so a target that disambiguated by execution
    // is never misrouted onto the worker just because it shares the slot name.
    const postApproval =
      taskAgentManager.getPostApprovalWorkerSession?.(taskId, target.sessionId) ?? null;
    if (postApproval) {
      // When the caller pinned a node (canvas click), the worker shortcut may
      // only fire when the worker actually belongs to that node — otherwise a
      // send to a DIFFERENT, unstarted node reusing the worker's agent name
      // would be injected into the worker session instead of lazy-activating
      // that node's own agent. Legacy (pre-provenance) workers get a
      // route-derived nodeId in getPostApprovalWorkerSession, so this is an
      // exact match — a node-scoped send to a sibling node falls through to
      // lazy activation rather than misrouting into the worker.
      const nodeOk = !target.workflowNodeId || postApproval.nodeId === target.workflowNodeId;
      const matchesPostApproval =
        nodeOk &&
        ((!!target.sessionId && target.sessionId === postApproval.sessionId) ||
          (!target.sessionId &&
            !target.nodeExecutionId &&
            !!target.agentName &&
            target.agentName === postApproval.agentName));
      if (matchesPostApproval) {
        // Deliver into the live worker session. If it is not in memory (e.g.
        // after a daemon restart — the worker has no node_executions row to
        // rehydrate from), restore it on demand and retry before giving up.
        // We deliberately do NOT fall back to the text-only pending queue: the
        // post-approval router only re-dispatches on a fresh approval, so a
        // queued reply would expire undelivered while the RPC reported success.
        // Restoring (or failing honestly) keeps the contract truthful.
        const deliver = async (sid: string) =>
          taskAgentManager.injectSubSessionMessage!(sid, message, false, images, deliveryMode);
        try {
          await deliver(postApproval.sessionId);
          return { ok: true, routedTo: [postApproval.agentName] };
        } catch (err) {
          const notFound = err instanceof Error && /Sub-session not found/.test(err.message);
          if (!notFound || !taskAgentManager.restorePostApprovalWorkerSession) throw err;
          // Restore the SAME worker the reply targeted (postApproval.sessionId
          // — already validated, possibly an explicitly-selected older one) so
          // the restart fallback doesn't collapse to the most-recent worker.
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

    const executions = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId).filter(
      (e) =>
        e.status !== 'cancelled' &&
        // A pending row may retain a dead agentSessionId from
        // resetWorkflowNodeExecutionForSpawnRetry — don't deliver into it.
        e.status !== 'pending'
    );

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
      // When the caller PINNED a sessionId (overlay opened a specific session),
      // it is the delivery promise: the execution it pointed at must exist.
      // If the session was rebound to another execution/agent (W1→W2), do NOT
      // fall back to agentName lazy-activation — that would inject into the
      // replacement session while the user still views the pinned one. Fail the
      // send instead so the overlay surfaces the stale pin.
      if (target.sessionId) {
        throw new Error(
          `Session ${target.sessionId} is no longer attached to a workflow node execution for this task. ` +
            `Close and reopen the agent overlay to refresh it.`
        );
      }
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
            const refreshed = nodeExecutionRepo!.listByWorkflowRun(task.workflowRunId!).filter(
              (e) =>
                e.status !== 'cancelled' &&
                // Exclude only pending rows that RETAIN a dead agentSessionId
                // (spawn retry); sessionless pending rows are valid queue
                // targets and must stay eligible.
                !(e.status === 'pending' && e.agentSessionId)
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
        // Surface both spawned (execution-backed) and workflow-declared agent
        // slots in the diagnostic — declared-but-inactive peers (e.g. a
        // downstream node not yet activated, or the execution-less post-approval
        // worker) are legitimate targets even without an execution row, so
        // listing only execution names misleads the user into thinking they
        // cannot be reached.
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
      const refreshed = nodeExecutionRepo.listByWorkflowRun(task.workflowRunId).filter(
        (e) =>
          e.status !== 'cancelled' &&
          // Exclude only pending rows that RETAIN a dead agentSessionId (spawn
          // retry); sessionless pending rows are valid queue targets.
          !(e.status === 'pending' && e.agentSessionId)
      );
      // Re-apply the same strict matching logic used above (exact
      // nodeExecutionId match when provided, agentName otherwise), including
      // the workflowNodeId scope so a same-name live execution on another node
      // can't capture the clicked node's freshly-activated session.
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

    // Direct delivery: at least one target has a live session.
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
      /**
       * `'defer'` persists the message as `deferred` for replay at the next idle
       * boundary (handled by `injectSubSessionMessage`); omitted / `'immediate'`
       * delivers/steers now. Reuses the already-shipped sub-session defer
       * machinery — no new delivery semantics here.
       */
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
    // Validate deliveryMode at the RPC boundary — the cast above trusts the
    // shape, but a non-TS caller can pass an arbitrary string. Mirrors the
    // `message.send` guard in session-handlers.ts. Fail-safe downstream (only
    // `=== 'defer'` matters), but rejected explicitly for a clear error.
    if (
      params.deliveryMode !== undefined &&
      params.deliveryMode !== 'immediate' &&
      params.deliveryMode !== 'defer'
    ) {
      throw new Error('Invalid deliveryMode');
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
      // Exclude cancelled (truly terminal) AND pending-with-retained-session
      // (spawn-retry dead session) — injecting into a pending row's dead
      // agentSessionId would resurrect a session still eligible to spawn a
      // replacement. Idle and blocked agents are reachable.
      const activeAgents = executions.filter(
        (e) => e.agentSessionId !== null && e.status !== 'cancelled' && e.status !== 'pending'
      );

      const routedTo: string[] = [];
      const notFound: string[] = [];

      // The execution-less post-approval worker (e.g. `merger`) is reachable by
      // @mention even though it has no node_executions row. Resolve it once and
      // match mentions against it when no execution-backed agent matches.
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
        // Worker first (consistent with the explicit-target path): a slot name
        // shared by an old non-cancelled execution and the current post-approval
        // worker must route to the worker, not rehydrate the stale execution.
        if (postApproval && postApproval.agentName.toLowerCase() === mention.toLowerCase()) {
          try {
            await injectInto(postApproval.sessionId);
            routedTo.push(mention);
            continue;
          } catch (err) {
            // Only the rehydration gap (worker not in memory after a restart)
            // triggers a restore. Any other delivery failure (terminal session,
            // provider/runtime error) must propagate honestly — the name WAS
            // resolved, so masking it as `notFound` (or hiding it behind a
            // partial-success multi-mention result) is wrong. Mirrors the
            // explicit-target path.
            const isRehydrateGap =
              err instanceof Error &&
              /Sub-session not found/.test(err.message) &&
              taskAgentManager.restorePostApprovalWorkerSession;
            if (!isRehydrateGap) throw err;
            // Restore the targeted worker (postApproval.sessionId) so the
            // resolve-vs-restore window can't pick a different worker.
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
          // Inject into all matching sessions in parallel (independent operations)
          await Promise.all(matches.map((exec) => injectInto(exec.agentSessionId!)));
          routedTo.push(mention);
          continue;
        }
        notFound.push(mention);
      }

      if (routedTo.length === 0) {
        // No mentions resolved — throw with available agent names. Include the
        // post-approval worker (a reachable execution-less target) and any
        // workflow-declared slots so the diagnostic is not misleading.
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
      // Per-draft nonce from the client: a retry of the same draft shares it
      // (dedup), while distinct identical-text drafts get separate rows.
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
    // Pre-enqueue validation: if a specific node is targeted, verify it
    // declares this agent so a row scoped to an obsolete nodeId (the agent
    // moved to another node) is rejected before it's persisted and stranded.
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
        // Stable idempotency key so a retry of the SAME draft after a transient
        // activation failure dedups instead of inserting a duplicate pending row
        // (which the agent would later receive N times). Keyed on the client
        // nonce when present (falling back to a task/agent/node/message hash) so
        // distinct identical-text drafts don't coalesce.
        idempotencyKey: params.clientMessageId
          ? `human:${params.taskId}:${params.agentName}:${params.workflowNodeId ?? ''}:${params.clientMessageId}`
          : `human:${params.taskId}:${params.agentName}:${params.workflowNodeId ?? ''}:${params.message}`,
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

    // If activation failed, surface an error but do NOT markFailed the queued
    // row — ensureWorkflowNodeActivationForAgent returns false for BOTH a
    // non-declaring node AND a transient activateNode/spawn error (bare catch),
    // so terminalizing would permanently lose retryable messages. The row
    // stays pending for recovery/TTL; the user gets the thrown error.
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
