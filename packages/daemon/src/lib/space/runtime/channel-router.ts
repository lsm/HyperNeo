/**
 * ChannelRouter — message delivery with lazy node activation.
 *
 * Handles all message delivery within a workflow run:
 * - Within-node DMs (same node, agent-to-agent)
 * - Cross-node DMs (target resolved by agent name)
 * - Fan-out (target resolved by node name → all agents in that node)
 *
 * Action-level policy (validation, blocking, patching) is enforced by workflow
 * hooks at the MCP-action boundary before `send_message` reaches the router;
 * channels themselves are always open subject to topology and rate-based
 * dead-loop detection on cyclic channels.
 *
 * Lazy node activation:
 * - activateNode() is idempotent: if active node_executions already exist for
 *   the node, activation is a no-op.
 * - For cyclic re-entry, terminal node_executions are reset to `pending`.
 * - No session group creation — that is the responsibility of TaskAgentManager.
 *   ChannelRouter only mutates node_executions and cycle state.
 */

import type { SpaceTask, SpaceWorkflow, WorkflowChannel, WorkflowNode } from '@hyperneo/shared';
import { resolveNodeAgents, isChannelCyclic } from '@hyperneo/shared';
import type { NodeExecution } from '@hyperneo/shared';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import {
  DEAD_LOOP_THRESHOLD,
  DEAD_LOOP_WINDOW_MS,
} from '../../../storage/repositories/channel-cycle-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import {
  isReservedWorkflowAgentName,
  type SpaceWorkflowManager,
} from '../managers/space-workflow-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../managers/node-execution-manager';
import type {
  InternalEventBus,
  DaemonInternalEventMap,
  InternalEventPayload,
} from '../../internal-event-bus';
import { Logger } from '../../logger';
import {
  MissingWorkflowAgentError,
  PermanentSpawnError,
  findMissingNodeAgentReferences,
  formatMissingAgentReference,
  validateExecutionAgainstWorkflow,
} from './workflow-node-execution-validation';

const log = new Logger('channel-router');

// ---------------------------------------------------------------------------
// Delivery readiness result types
// ---------------------------------------------------------------------------

/** Result of a channel delivery readiness check. */
export interface GateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Internal event shape published by `ChannelRouter` when a terminal workflow
 * run is reopened. Kept private to this module — external consumers should
 * subscribe to `space.workflowRun.reopened` on `InternalEventBus` instead.
 */
interface WorkflowRunReopenedEvent {
  kind: 'workflow_run_reopened';
  spaceId: string;
  runId: string;
  fromStatus: 'done' | 'cancelled' | 'blocked';
  reason: string;
  by: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Return value from deliverMessage().
 * Callers can inspect `activatedTasks` to know whether a lazy activation occurred.
 */
export interface DeliveredMessage {
  /** Workflow run ID */
  runId: string;
  /** Agent name of the sending agent */
  fromRole: string;
  /**
   * Agent name of the receiving agent, or node name for fan-out deliveries.
   * When isFanOut is true this is the node name, not an individual agent name.
   */
  toRole: string;
  /** The message content */
  message: string;
  /** Node ID of the target agent */
  targetNodeId: string;
  /**
   * True when the delivery targeted a node name (fan-out to all agents in the
   * node) rather than a specific agent name (point-to-point DM).
   */
  isFanOut: boolean;
  /**
   * Tasks created by lazy activation, or undefined when the node was already active.
   * An empty array is never returned — either undefined (already active) or ≥1 tasks.
   */
  activatedTasks?: SpaceTask[];
}

// ---------------------------------------------------------------------------
// ActivationError
// ---------------------------------------------------------------------------

/**
 * Thrown by activateNode() for unrecoverable problems such as a missing run
 * or workflow, a node that does not exist, or an attempted activation on a
 * run whose parent task has been archived.
 *
 * Also thrown by deliverMessage() when a cyclic channel trips the rate-based
 * dead-loop detector (a runaway tight ping-pong between two agents).
 */
export class ActivationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ActivationError';
  }
}

/**
 * Error message used when the parent task has been archived. Archive is the
 * only tombstone — `done` and `cancelled` runs remain reopenable until the
 * task is archived.
 */
export const ARCHIVED_TASK_ERROR_MESSAGE = 'This task is archived — create a new task to continue.';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ChannelRouterConfig {
  /** Task repository for creating and querying SpaceTask records */
  taskRepo: SpaceTaskRepository;
  /** Workflow run repository for reading run metadata */
  workflowRunRepo: SpaceWorkflowRunRepository;
  /** Workflow manager for loading workflow definitions */
  workflowManager: SpaceWorkflowManager;
  /** Agent manager for resolving agent roles → task types */
  agentManager: SpaceAgentManager;
  /**
   * Node execution repository for creating node_execution records.
   * activateNode() creates a node_execution record for each SpaceTask,
   * enabling CompletionDetector to track workflow completion.
   */
  nodeExecutionRepo: NodeExecutionRepository;
  /**
   * Channel cycle repository for per-channel iteration tracking.
   * Required when workflows contain cyclic (backward) channels.
   */
  channelCycleRepo?: ChannelCycleRepository;
  /**
   * Optional liveness probe for an agent session ID.
   *
   * Used during cyclic re-entry: when an existing terminal node_execution is
   * found, the router would normally preserve its `agentSessionId` so the
   * same in-memory agent session is reused (preserving conversation history).
   * If this callback is provided and returns `false`, the session is treated
   * as unrecoverable and the execution falls back to fresh-spawn semantics
   * (`agentSessionId` cleared, status reset to `pending`).
   *
   * When omitted, the router always preserves `agentSessionId` on cyclic
   * re-entry — appropriate for tests and contexts without a TaskAgentManager.
   */
  isSessionAlive?: (sessionId: string) => boolean;
  /**
   * Optional resolver for the live post-approval merger session of a run.
   *
   * The merger sub-session is spawned by `TaskAgentManager.spawnPostApprovalSubSession`
   * WITHOUT a `node_execution` row, so `getActiveTasksForNode` always reports the
   * Post-Approval node as inactive. Without this callback, `deliverMessage`'s lazy
   * `activateNode` step would create a pending `node_execution` for the node and the
   * tick loop would spawn a DUPLICATE merger — two sessions racing the same PR.
   *
   * When provided and it returns a session that `isSessionAlive` confirms live,
   * activation is SKIPPED for a target node that declares a post-approval route
   * (the merger node); the caller (`AgentMessageRouter`) delivers to the existing
   * session instead. Returning undefined (or a dead id) falls through to normal
   * activation, so a merger that died mid-wait can be re-activated.
   */
  findPostApprovalSessionId?: (runId: string) => string | undefined;
  /**
   * Optional NON-LAZY in-memory liveness probe for the post-approval merger
   * session. Unlike {@link isSessionAlive} (which lazy-loads a persisted session
   * via SessionManager and can return a false positive after a daemon restart,
   * when the merger has no NodeExecution to rehydrate from), this returns true
   * ONLY when the session is present in the in-memory sub-session index — i.e.
   * actually injectable. Used by `resolveLivePostApprovalSession` so the
   * skip-activation guard does not fire on a persisted-but-unrehydrated session
   * (which would then crash `injectSubSessionMessage`: "Sub-session not found").
   */
  isPostApprovalSessionInMemory?: (sessionId: string) => boolean;
  /**
   * Optional cancellation hook for live agent sessions when activation discovers
   * the backing node execution is permanently invalid and must be detached.
   */
  cancelSessionById?: (sessionId: string) => void;
  /**
   * Optional InternalEventBus for publishing typed domain events such as
   * `space.workflowRun.reopened`. When omitted, the router silently skips
   * event emission — appropriate for tests and other standalone uses.
   *
   * Failures from `publish()` are caught and logged; bus errors never
   * propagate into message delivery / activation paths.
   */
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
}

// ---------------------------------------------------------------------------
// ChannelRouter
// ---------------------------------------------------------------------------

export class ChannelRouter {
  constructor(private readonly config: ChannelRouterConfig) {}

  /**
   * Per-(run, channel) timestamp of the most recent dead-loop notification
   * emitted from this router instance. Suppresses duplicate UI notifications
   * when a blocked agent retries `send_message` repeatedly within the same
   * window. Transient (in-memory); the router is rebuilt per agent session.
   */
  private readonly deadLoopNotifiedAt = new Map<string, number>();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Lazily activate a workflow node by ensuring pending node_execution rows
   * exist (or are reset) for every declared node agent.
   *
   * Archive is the only tombstone:
   * - If the parent task's `archivedAt` is set → throws `ActivationError`.
   * - If the run is `done` / `cancelled` but the task is NOT archived → the
   *   run is auto-reopened back to `in_progress` and a `workflow_run_reopened`
   *   event is emitted before activation proceeds.
   *
   * An optional `reopenReason` / `reopenBy` lets the caller describe who
   * triggered the reopen (peer agent name, user id). When
   * omitted, a generic `'activation'` attribution is used.
   *
   * No per-node SpaceTask rows are created.
   */
  async activateNode(
    runId: string,
    nodeId: string,
    options?: {
      reopenReason?: string;
      reopenBy?: string;
      allowTerminalReopen?: boolean;
      /**
       * When set, this is a slot-targeted activation (e.g. lazy-activating one
       * unstarted agent in a partially-active multi-agent node). The idempotency
       * short-circuit then only fires when THAT slot already has an execution;
       * otherwise we fall through to createOrIgnore so the missing slot is
       * created instead of being skipped because a sibling slot is active.
       */
      targetAgentName?: string;
    }
  ): Promise<SpaceTask[]> {
    // ── 1. Load the run ────────────────────────────────────────────────────
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) {
      throw new ActivationError(`Run not found: ${runId}`);
    }

    // Archive check — the only hard block. Done/cancelled are reopenable
    // as long as the parent task has not been archived.
    if (this.isParentTaskArchived(runId)) {
      throw new ActivationError(ARCHIVED_TASK_ERROR_MESSAGE);
    }

    // Terminal run states are tombstones for passive activation sources.
    // Only explicit live sends or manual recovery paths may opt into reopening.
    if (run.status === 'done' || run.status === 'cancelled') {
      if (!options?.allowTerminalReopen) {
        throw new ActivationError(
          `Run ${runId} is ${run.status} — create a new task or use an explicit resume action.`
        );
      }
      await this.reopenRun(
        run.id,
        run.status,
        run.spaceId,
        options?.reopenReason ??
          `inbound activation of node "${nodeId}" on run in status "${run.status}"`,
        options?.reopenBy ?? 'activation'
      );
    }

    // ── 2. Idempotency check — return when node already has active executions ─────
    const existingTasks = this.getActiveTasksForNode(runId, nodeId);
    if (existingTasks.length > 0) {
      // Slot-targeted activation: only short-circuit when the TARGET slot
      // already has an execution. Without this, a partially-active multi-agent
      // node (slot A active, slot B unstarted) would skip createOrIgnore for B
      // and the caller's refresh would find no B execution.
      const targetAgentName = options?.targetAgentName;
      if (!targetAgentName) return existingTasks;
      // Only short-circuit on a NON-terminal execution for the target slot —
      // a terminal row (cancelled/waiting_rebind) still needs the
      // terminal-reactivation loop below, which a sibling-active short-circuit
      // would skip.
      const targetSlotExists = this.config.nodeExecutionRepo
        .listByNode(runId, nodeId)
        .some(
          (e) => e.agentName === targetAgentName && !TERMINAL_NODE_EXECUTION_STATUSES.has(e.status)
        );
      if (targetSlotExists) return existingTasks;
      // Target slot is missing (or terminal) — fall through to createOrIgnore.
    }

    // ── 3. Resolve the workflow and node ───────────────────────────────────
    const workflow = this.config.workflowManager.getWorkflowForRun(run);
    if (!workflow) {
      throw new ActivationError(`Workflow not found: ${run.workflowId}`);
    }
    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new ActivationError(`Node "${nodeId}" not found in workflow "${run.workflowId}"`);
    }

    // ── 4. Resolve agent slots and ensure pending executions ───────────────
    let agents: ReturnType<typeof resolveNodeAgents>;
    try {
      agents = resolveNodeAgents(node);
    } catch (err) {
      throw new ActivationError(
        `Cannot resolve agents for node "${nodeId}": ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    // Validate configured custom-agent references BEFORE creating any execution.
    // A slot whose agentId points at a deleted space_agents row would otherwise
    // make the createOrIgnore below raise SQLITE_CONSTRAINT_FOREIGNKEY (INSERT
    // OR IGNORE does not suppress foreign-key failures). Built-in/worker slots
    // that validly use agentId=null are preserved — only non-null references are
    // checked, and a missing required agent is surfaced as an actionable error
    // rather than silently nulled. For slot-targeted activation
    // (`ensureWorkflowNodeActivationForAgent`), restrict the check to the
    // requested slot so a stale SIBLING slot does not prevent bringing the valid
    // target slot online.
    const targetAgentName = options?.targetAgentName;
    const missingAgent = findMissingNodeAgentReferences(
      node,
      (id) => this.config.agentManager.getById(id) !== null,
      targetAgentName ? { slotNames: new Set([targetAgentName]) } : undefined
    );
    if (missingAgent.length > 0) {
      const first = missingAgent[0];
      throw new MissingWorkflowAgentError(
        formatMissingAgentReference({
          runId,
          nodeLabel: node.name,
          agentName: first.agentName,
          agentId: first.agentId,
        }),
        first
      );
    }

    const existingExecutions = this.config.nodeExecutionRepo.listByNode(runId, nodeId);
    const existingByAgentName = new Map(
      existingExecutions.map((execution) => [execution.agentName, execution])
    );

    for (const agentEntry of agents) {
      // Slot-targeted activation (ensureWorkflowNodeActivationForAgent): only
      // create/reactivate the requested slot, never its siblings. Without this,
      // targeting one missing/terminal slot in a partially-active multi-agent
      // node would createOrIgnore every other missing/terminal sibling too,
      // spawning agents the caller never selected.
      if (options?.targetAgentName && agentEntry.name !== options.targetAgentName) continue;
      const agentName = agentEntry.name;
      const existing = existingByAgentName.get(agentName);
      if (existing) {
        const validation = validateExecutionAgainstWorkflow(existing, workflow);
        if (!validation.valid) {
          if (existing.agentSessionId) {
            this.config.cancelSessionById?.(existing.agentSessionId);
          }
          this.config.nodeExecutionRepo.update(existing.id, {
            status: 'cancelled',
            result: validation.reason,
            completedAt: Date.now(),
          });
          log.warn(
            `ChannelRouter: cancelled stale workflow node execution ${existing.id}: ${validation.reason}`
          );
          throw new PermanentSpawnError(validation.reason);
        }

        // Re-activation path for cyclic channels.
        //
        // Default: preserve `agentSessionId` and flip status to `in_progress`,
        // so the same live agent session continues across cycles with full
        // conversation history. Inbound messages routed by AgentMessageRouter
        // will then deliver to the existing session via injectSubSessionMessage.
        //
        // Fallback: if `isSessionAlive` reports the session is no longer live
        // (daemon restart, manual cleanup, crash), reset to `pending` so the
        // tick loop respawns a fresh session. agentSessionId is normally stable
        // once assigned, but the clean-recovery resets (space-stop parking,
        // passed rate-cap reset) deliberately clear it; either way spawn code
        // detects pending status to create a new session.
        if (TERMINAL_NODE_EXECUTION_STATUSES.has(existing.status)) {
          const sessionId = existing.agentSessionId;
          const probe = this.config.isSessionAlive;
          // Preserve the session when an id exists and either no probe is
          // configured (test/no-runtime context) or the probe says it's alive.
          const sessionAlive = sessionId !== null && (!probe || probe(sessionId));
          if (sessionAlive) {
            this.config.nodeExecutionRepo.update(existing.id, {
              status: 'in_progress',
            });
          } else {
            this.config.nodeExecutionRepo.update(existing.id, {
              status: 'pending',
              result: null,
              startedAt: null,
              completedAt: null,
            });
          }
        }
        continue;
      }
      if (isReservedWorkflowAgentName(agentName)) {
        throw new ActivationError(`Agent name "${agentName}" is reserved for a built-in agent`);
      }
      this.config.nodeExecutionRepo.createOrIgnore({
        workflowRunId: runId,
        workflowNodeId: nodeId,
        agentName,
        agentId: agentEntry.agentId ?? null,
        status: 'pending',
      });
    }

    const canonicalTask = this.getCanonicalTaskForRun(runId);
    return canonicalTask ? [canonicalTask] : [];
  }

  /**
   * Check whether delivery of a message from `fromRole` to `toTarget` is currently
   * permitted — without performing any delivery or state mutations.
   *
   * Evaluation order:
   * 1. **Open topology** — when no channel is declared for the pair, delivery is
   *    always allowed (no restriction).
   * 2. **Dead-loop (rate) check** — for cyclic channels, blocks when the rolling
   *    per-channel traversal rate has reached the dead-loop threshold.
   *
   * @param runId     - Workflow run ID
   * @param fromRole  - Sending agent name
   * @param toTarget  - Receiving agent name, or node name for fan-out
   * @returns GateResult — `{ allowed: true }` or `{ allowed: false, reason }` when blocked
   * @throws ActivationError when the run or workflow is not found
   */
  async canDeliver(runId: string, fromRole: string, toTarget: string): Promise<GateResult> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) throw new ActivationError(`Run not found: ${runId}`);

    const workflow = this.config.workflowManager.getWorkflowForRun(run);
    if (!workflow) throw new ActivationError(`Workflow not found: ${run.workflowId}`);

    const match = this.findMatchingWorkflowChannel(workflow, fromRole, toTarget);
    if (!match) {
      // Open topology — no declared channel for this pair; delivery is unrestricted
      return { allowed: true };
    }
    const { index } = match;

    const channelIsCyclic = this.isChannelCyclicByIndex(index, workflow);

    // ── Rate-based dead-loop check ───────────────────────────────────────
    if (channelIsCyclic && this.isDeadLoopReached(runId, index)) {
      return { allowed: false, reason: this.deadLoopReason(fromRole, toTarget) };
    }

    return { allowed: true };
  }

  /**
   * Returns non-terminal NodeExecution records for a given (runId, nodeId) pair.
   *
   * Unlike `getActiveTasksForNode()` (which queries SpaceTask records), this
   * method queries the `node_executions` table directly for workflow-internal
   * state. Used by external consumers (e.g. SpaceRuntime) that need to inspect
   * node execution status without going through SpaceTask.
   *
   * "Active" means the execution has not reached a terminal status
   * (done, cancelled).
   */
  getActiveExecutionsForNode(runId: string, nodeId: string): NodeExecution[] {
    return this.config.nodeExecutionRepo
      .listByNode(runId, nodeId)
      .filter((e) => !TERMINAL_NODE_EXECUTION_STATUSES.has(e.status));
  }

  /**
   * Resolve the post-approval merger session for a run, but ONLY when it is
   * live. The merger sub-session has no `node_execution` row, so callers cannot
   * detect it via `getActiveTasksForNode`; this bridges that gap for
   * `deliverMessage`'s lazy-activation step (see step 4). Returns undefined when
   * no probe is wired, no id is recorded, or the recorded id is no longer alive
   * — in all those cases the caller falls through to normal `activateNode`.
   */
  private resolveLivePostApprovalSession(runId: string): string | undefined {
    const sessionId = this.config.findPostApprovalSessionId?.(runId);
    if (!sessionId) return undefined;
    // Prefer the non-lazy in-memory probe: the lazy isSessionAlive can report a
    // persisted-but-unrehydrated merger as alive after a daemon restart (the
    // merger has no NodeExecution, so it is not in the in-memory sub-session
    // index and injectSubSessionMessage would throw "Sub-session not found").
    // Fall back to isSessionAlive for contexts (tests) that wire only that.
    const probe = this.config.isPostApprovalSessionInMemory ?? this.config.isSessionAlive;
    return !probe || probe(sessionId) ? sessionId : undefined;
  }

  /**
   * Collect every dispatched post-approval route's targetAgent for a workflow
   * (node-level routes plus the legacy workflow-level route). A route may be
   * declared on one node while targeting an agent in ANOTHER node
   * (`post-approval-validator.ts` allows any declared `WorkflowNodeAgent`), so
   * the skip-activation guard must match the route's target AGENT, not the node
   * that owns the declaration.
   */
  private getPostApprovalTargetAgents(workflow: SpaceWorkflow): Set<string> {
    const agents = new Set<string>();
    for (const node of workflow.nodes) {
      const targetAgent = node.postApproval?.targetAgent;
      // Skip the legacy 'task-agent' target — PostApprovalRouter never dispatches
      // it, so no live merger session exists for it.
      if (targetAgent && targetAgent !== POST_APPROVAL_TASK_AGENT_TARGET) agents.add(targetAgent);
    }
    const legacy = workflow.postApproval?.targetAgent;
    if (legacy && legacy !== POST_APPROVAL_TASK_AGENT_TARGET) agents.add(legacy);
    return agents;
  }

  /**
   * Deliver a message from one agent to another (or to a node for fan-out)
   * within a workflow run.
   *
   * **Target resolution:**
   * - `toTarget` is an agent name → DM to the agent's node (lazy-activated
   *   if not already active)
   * - `toTarget` is a node name → fan-out to the node; all agent slots are
   *   activated (lazy-activated if not already active)
   *
   * **Cyclic tracking (rate-based dead-loop detection):**
   * - For cyclic channels, each successful delivery is recorded as a
   *   timestamped event.
   * - If the rolling per-channel traversal rate has reached the dead-loop
   *   threshold (a runaway tight ping-pong), throws `ActivationError` and
   *   surfaces a `workflowRun.deadLoop` event so the human sees the block.
   *   A genuine long review spread over hours never trips this.
   *
   * @param runId    - Workflow run ID
   * @param fromRole - Agent name of the sending agent (WorkflowNodeAgent.name)
   * @param toTarget - Agent name of the receiving agent, or node name for fan-out
   * @param message  - Message content to deliver
   * @returns DeliveredMessage descriptor; `activatedTasks` is set when the
   *   target node was lazily activated, undefined when it was already active
   * @throws ActivationError when the run, workflow, or target agent/node is not
   *   found, or a cyclic channel trips the rate-based dead-loop detector
   */
  async deliverMessage(
    runId: string,
    fromRole: string,
    toTarget: string,
    message: string
  ): Promise<DeliveredMessage> {
    // ── 1. Load the run and workflow ───────────────────────────────────────
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) {
      throw new ActivationError(`Run not found: ${runId}`);
    }

    // Archive is a hard tombstone: if every task on this run has been
    // archived, no inter-agent activity is permitted. Check this BEFORE
    // delivery so callers see the canonical archived-task error rather than
    // an activation failure (which would falsely suggest the work could resume).
    if (this.isParentTaskArchived(runId)) {
      throw new ActivationError(ARCHIVED_TASK_ERROR_MESSAGE);
    }

    const workflow = this.config.workflowManager.getWorkflowForRun(run);
    if (!workflow) {
      throw new ActivationError(`Workflow not found: ${run.workflowId}`);
    }

    const match = this.findMatchingWorkflowChannel(workflow, fromRole, toTarget);
    const channel = match?.channel;
    const channelIndex = match?.index ?? -1;
    const channelIsCyclic = match ? this.isChannelCyclicByIndex(channelIndex, workflow) : false;

    // ── 2. Target resolution: agent name → DM, node name → fan-out ────────
    // Target resolution itself is non-mutating — only `activateNode` below
    // creates pending node_executions.
    let targetNode = this.findNodeByAgentName(workflow, toTarget);
    let isFanOut = false;

    if (!targetNode) {
      // Try node name for fan-out delivery
      const byName = workflow.nodes.find((n) => n.name === toTarget);
      if (byName) {
        targetNode = byName;
        isFanOut = true;
      } else {
        throw new ActivationError(
          `No node found with agent name or node name "${toTarget}" in workflow "${run.workflowId}"`
        );
      }
    }

    // ── 3. Dead-loop gate (reserve the cyclic traversal before activation) ──
    // Rate-based detection rejects the send itself, so it is enforced before
    // any activation work. Unlike the retired lifetime cap, this only trips on
    // a runaway tight ping-pong — a long review spread over hours never will.
    // `reserveCycleEvent` prunes + counts + conditionally inserts in one
    // synchronous sequence, so two concurrent agent sessions sharing this
    // channel cannot both pass the threshold. The reservation is made before
    // (not after) activation so the gate is authoritative; on the rare path
    // where activation then fails, one extra reserved event biases safely
    // toward blocking and prunes out after the window.
    if (channelIsCyclic && channel) {
      const reservation = this.config.channelCycleRepo
        ? this.config.channelCycleRepo.reserveCycleEvent(runId, channelIndex)
        : { allowed: true, recentCount: 0 };
      if (!reservation.allowed) {
        // Surface the block to the human (UI) instead of failing silently,
        // then reject the send.
        await this.notifyDeadLoop(
          run.spaceId,
          runId,
          fromRole,
          toTarget,
          channelIndex,
          reservation.recentCount
        );
        throw new ActivationError(this.deadLoopReason(fromRole, toTarget));
      }
      // The channel is not in a dead loop right now, so it has recovered —
      // either the window aged out or a human touch cleared the history. Drop
      // any stale dedupe entry so a *new* loop after recovery surfaces a fresh
      // notification rather than being suppressed by the previous incident.
      this.deadLoopNotifiedAt.delete(`${runId}:${channelIndex}`);
    }

    // ── 4. Lazy activation ─────────────────────────────────────────────────
    const activeTasks = this.getActiveTasksForNode(runId, targetNode.id);
    let activatedTasks: SpaceTask[] | undefined;

    // The post-approval merger session has no node_execution row, so
    // `getActiveTasksForNode` always returns [] for it — the guard below would
    // otherwise `activateNode` and the tick loop would spawn a DUPLICATE merger.
    // Skip activation when the target node CONTAINS a dispatched post-approval
    // route's target agent (the route may be declared on a different node — see
    // `getPostApprovalTargetAgents`) AND a live merger session exists for the
    // run; the caller (AgentMessageRouter) injects into that existing session.
    // A dead/absent session falls through to normal activation so a merger that
    // died mid-wait can be re-activated.
    const postApprovalTargetAgents = this.getPostApprovalTargetAgents(workflow);
    const skipForLiveMerger =
      postApprovalTargetAgents.size > 0 &&
      !!this.resolveLivePostApprovalSession(runId) &&
      resolveNodeAgents(targetNode).some((agent) => postApprovalTargetAgents.has(agent.name));

    if (activeTasks.length === 0 && !skipForLiveMerger) {
      activatedTasks = await this.activateNode(runId, targetNode.id, {
        allowTerminalReopen: true,
        reopenBy: `agent:${fromRole}`,
        reopenReason: `peer send_message from "${fromRole}" to "${toTarget}"`,
      });
    }

    return {
      runId,
      fromRole,
      toRole: toTarget,
      message,
      targetNodeId: targetNode.id,
      isFanOut,
      activatedTasks,
    };
  }

  /**
   * Returns a non-empty array when the node currently has any active executions.
   *
   * The returned task array contains the canonical run task (single item), which
   * is used only as a compatibility envelope for existing callers.
   */
  private getActiveTasksForNode(runId: string, nodeId: string): SpaceTask[] {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) return [];
    const workflow = this.config.workflowManager.getWorkflowForRun(run);
    const node =
      workflow?.nodes.find((n) => n.id === nodeId) ??
      workflow?.nodes.find((n) => n.name === nodeId);
    if (!node) return [];

    const activeExecutions = this.config.nodeExecutionRepo
      .listByNode(runId, node.id)
      .filter((execution) => !TERMINAL_NODE_EXECUTION_STATUSES.has(execution.status));
    if (activeExecutions.length === 0) return [];

    const canonicalTask = this.getCanonicalTaskForRun(runId);
    return canonicalTask ? [canonicalTask] : [];
  }

  /**
   * Returns the canonical run task (one-task-per-run model).
   */
  private getCanonicalTaskForRun(runId: string): SpaceTask | null {
    const runTasks = this.config.taskRepo.listByWorkflowRun(runId);
    return runTasks[0] ?? null;
  }

  /**
   * Searches workflow nodes for the first node that has an agent slot with the
   * given agent name. Returns undefined when no node matches.
   */
  private findNodeByAgentName(workflow: SpaceWorkflow, role: string): WorkflowNode | undefined {
    for (const node of workflow.nodes) {
      try {
        const agents = resolveNodeAgents(node);
        if (agents.some((a) => a.name === role)) return node;
      } catch {
        // Skip malformed nodes (neither agentId nor agents defined)
      }
    }
    return undefined;
  }

  /**
   * Finds the first WorkflowChannel in the workflow that matches the given
   * fromRole → toTarget pair.
   *
   * Matching rules:
   * - `channel.from` may equal either the sender agent name or the sender
   *   node name (wildcard `'*'` matches any sender)
   * - `channel.to` may equal either the explicit target string or the target
   *   node name, or contain either in an array (wildcard `'*'` matches any target)
   *
   * `toTarget` may be either an agent name or a node name — the raw
   * WorkflowChannel declaration is not resolved; the caller is responsible for
   * knowing the target type.
   *
   * Returns undefined when no channel is found (open topology).
   */
  private findMatchingWorkflowChannel(
    workflow: SpaceWorkflow,
    fromRole: string,
    toTarget: string
  ): { channel: WorkflowChannel; index: number } | undefined {
    const fromNodeName = this.findNodeByAgentName(workflow, fromRole)?.name;
    const toNodeName =
      this.findNodeByAgentName(workflow, toTarget)?.name ??
      workflow.nodes.find((node) => node.name === toTarget)?.name;
    const channels = workflow.channels ?? [];
    const index = channels.findIndex((ch) => {
      // Match the from side
      if (ch.from !== '*' && ch.from !== fromRole && ch.from !== fromNodeName) return false;
      // Match the to side
      if (ch.to === '*' || ch.to === toTarget || (!!toNodeName && ch.to === toNodeName))
        return true;
      if (Array.isArray(ch.to)) {
        return ch.to.includes(toTarget) || (!!toNodeName && ch.to.includes(toNodeName));
      }
      return false;
    });
    return index >= 0 ? { channel: channels[index], index } : undefined;
  }

  /**
   * Determines if a channel at the given index is cyclic (backward in graph topology).
   */
  private isChannelCyclicByIndex(channelIndex: number, workflow: SpaceWorkflow): boolean {
    const channels = workflow.channels ?? [];
    return isChannelCyclic(channelIndex, channels, workflow.nodes);
  }

  /**
   * `true` when the cyclic channel is currently in a dead loop. Read-only check
   * for `canDeliver` (a non-mutating query). Delivery itself must gate via
   * `reserveCycleEvent` so the traversal is recorded atomically. Returns `false`
   * when no cycle repository is configured (dead-loop detection disabled).
   */
  private isDeadLoopReached(runId: string, channelIndex: number): boolean {
    if (!this.config.channelCycleRepo) return false;
    return this.config.channelCycleRepo.isDeadLoopReached(runId, channelIndex);
  }

  /**
   * Human-readable dead-loop block reason shared by `canDeliver` and
   * `deliverMessage`.
   */
  private deadLoopReason(fromRole: string, toTarget: string): string {
    const windowMin = Math.round(DEAD_LOOP_WINDOW_MS / 60000);
    return (
      `Cyclic channel from "${fromRole}" to "${toTarget}" is in a dead loop: ` +
      `${DEAD_LOOP_THRESHOLD} message round-trips within ${windowMin} minute(s). ` +
      `Spread the exchange out or break the loop.`
    );
  }

  /**
   * Publish a `space.workflowRun.deadLoop` event so the human sees the blocked
   * send in the UI (`SpaceAgentNotificationService` injects it into the Space
   * Agent session). Deduped per (run, channel) within the window so a retrying
   * agent does not spam the UI. No-op when no event bus is configured.
   *
   * The dedupe timestamp is recorded ONLY after a successful publish: if a
   * subscriber handler throws, `publish` rethrows, we swallow it here, and —
   * because we did not record dedupe — the next blocked send retries the
   * notification. Recording dedupe before the publish would silently drop the
   * block from the UI on any handler failure, which is exactly the silent
   * failure this surfacing exists to prevent.
   *
   * Note: `publish` is awaited (consistent with `reopenRun`'s `safeNotify`),
   * which couples `deliverMessage` to subscriber latency; a misbehaving handler
   * could delay the send. Migrating to fire-and-forget `publishAsync` is a
   * broader change that also affects `safeNotify` and is intentionally left out
   * of scope here.
   */
  private async notifyDeadLoop(
    spaceId: string,
    runId: string,
    fromRole: string,
    toTarget: string,
    channelIndex: number,
    recentCount: number
  ): Promise<void> {
    if (!this.config.internalEventBus) return;
    const key = `${runId}:${channelIndex}`;
    const now = Date.now();
    const last = this.deadLoopNotifiedAt.get(key);
    if (last !== undefined && now - last < DEAD_LOOP_WINDOW_MS) return;
    try {
      await this.config.internalEventBus.publish('space.workflowRun.deadLoop', {
        namespaceId: 'global',
        spaceId,
        runId,
        fromAgent: fromRole,
        toTarget,
        channelIndex,
        recentCount,
        threshold: DEAD_LOOP_THRESHOLD,
        windowMs: DEAD_LOOP_WINDOW_MS,
        reason: this.deadLoopReason(fromRole, toTarget),
        timestamp: new Date(now).toISOString(),
      } satisfies DaemonInternalEventMap['space.workflowRun.deadLoop'] & InternalEventPayload);
      // Record dedupe only after the publish succeeded — see method doc.
      this.deadLoopNotifiedAt.set(key, now);
    } catch {
      // Swallow — surfacing must not break the delivery path. Dedupe is NOT
      // recorded, so the next blocked send retries the notification.
    }
  }

  /**
   * Returns `true` when the run's parent task has been archived.
   *
   * Archive is the single authoritative tombstone for inter-agent activity.
   * `listByWorkflowRunIncludingArchived` is used so archived tasks remain
   * visible — `listByWorkflowRun` filters them out and would incorrectly
   * report "no tasks" (treated as not archived) for a run whose task was
   * the only one and has since been archived.
   *
   * Policy: the HyperNeo space runtime uses a one-task-per-run model. The run
   * is considered archived when every task associated with it has been
   * archived. A run with zero tasks is treated as not archived (archival
   * requires evidence of a tombstone, not absence of a task).
   */
  private isParentTaskArchived(runId: string): boolean {
    const tasks = this.config.taskRepo.listByWorkflowRunIncludingArchived(runId);
    if (tasks.length === 0) return false;
    return tasks.every((t) => t.archivedAt != null);
  }

  /**
   * Transition a run from a terminal status (`done`, `cancelled`, or `blocked`) back to
   * `in_progress` and emit a `workflow_run_reopened` notification.
   *
   * Callers should only invoke this after confirming the parent task has
   * NOT been archived (see `isParentTaskArchived`).
   */
  private async reopenRun(
    runId: string,
    fromStatus: 'done' | 'cancelled' | 'blocked',
    spaceId: string,
    reason: string,
    by: string
  ): Promise<void> {
    this.config.workflowRunRepo.transitionStatus(runId, 'in_progress');
    await this.safeNotify({
      kind: 'workflow_run_reopened',
      spaceId,
      runId,
      fromStatus,
      reason,
      by,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Publish a `workflow_run_reopened` event to the configured InternalEventBus.
   *
   * Errors are caught and swallowed so a faulty subscriber cannot break
   * message delivery or node activation. When no bus is configured (e.g. unit
   * tests), this is a no-op.
   */
  private async safeNotify(event: WorkflowRunReopenedEvent): Promise<void> {
    if (!this.config.internalEventBus) return;
    try {
      await this.config.internalEventBus.publish('space.workflowRun.reopened', {
        namespaceId: 'global',
        spaceId: event.spaceId,
        runId: event.runId,
        fromStatus: event.fromStatus,
        reason: event.reason,
        by: event.by,
        timestamp: event.timestamp,
      } satisfies DaemonInternalEventMap['space.workflowRun.reopened'] & InternalEventPayload);
    } catch {
      // Swallow — bus errors must not break message delivery.
    }
  }
}
