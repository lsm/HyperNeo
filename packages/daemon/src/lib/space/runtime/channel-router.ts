/**
 * ChannelRouter — message delivery with gate enforcement and lazy node activation.
 *
 * Handles all message delivery within a workflow run:
 * - Within-node DMs (same node, agent-to-agent)
 * - Cross-node DMs (target resolved by agent name)
 * - Fan-out (target resolved by node name → all agents in that node)
 *
 * Gate enforcement:
 *    When a WorkflowChannel has a `gateId`, the corresponding Gate entity is
 *    loaded from `workflow.gates`, its runtime data is fetched from `gate_data`
 *    via `GateDataRepository`, and `evaluateGate()` is called.
 *    Channels without `gateId` are always open.
 *
 * `onGateDataChanged(runId, gateId)`:
 *    Called by agents (via MCP write_gate) whenever gate data changes.
 *    Re-evaluates all channels that reference the changed gate. If a previously
 *    blocked channel is now open and its target node has no active executions,
 *    the node is lazily activated.
 *
 * `resetOnCycle`:
 *    When a cyclic channel is traversed, gates with `resetOnCycle: true` in the
 *    workflow have their data reset to defaults in `gate_data`. This operation
 *    is performed in the same SQLite transaction as the per-channel cycle increment.
 *
 * Lazy node activation:
 * - activateNode() is idempotent: if active node_executions already exist for
 *   the node, activation is a no-op.
 * - For cyclic re-entry, terminal node_executions are reset to `pending`.
 * - No session group creation — that is the responsibility of TaskAgentManager.
 *   ChannelRouter only mutates node_executions and gate/cycle state.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
  SpaceAutonomyLevel,
  SpaceTask,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowNode,
} from '@neokai/shared';
import { resolveNodeAgents, isChannelCyclic, computeGateDefaults } from '@neokai/shared';
import type { NodeExecution } from '@neokai/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { GateOpenStateRepository } from '../../../storage/repositories/gate-open-state-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import {
  isReservedWorkflowAgentName,
  type SpaceWorkflowManager,
} from '../managers/space-workflow-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../managers/node-execution-manager';
import { evaluateGate, type GateEvalResult, type GateScriptExecutorFn } from './gate-evaluator';
import type { GateScriptContext } from './gate-script-executor';
import { executeGateScript } from './gate-script-executor';
import { getBuiltInGateScript } from '../workflows/built-in-workflows';
import { getEffectiveGate } from './gate-features';
import type {
  InternalEventBus,
  DaemonInternalEventMap,
  InternalEventPayload,
} from '../../internal-event-bus';
import { Logger } from '../../logger';
import {
  PermanentSpawnError,
  validateExecutionAgainstWorkflow,
} from './workflow-node-execution-validation';

const log = new Logger('channel-router');

// ---------------------------------------------------------------------------
// Gate result types (formerly in channel-gate-evaluator.ts)
// ---------------------------------------------------------------------------

/** Result of a gate evaluation check. */
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

/**
 * Thrown when a gate blocks message delivery on a channel.
 * Callers can inspect `gateIdentifier` to identify the blocking gate.
 */
export class ChannelGateBlockedError extends Error {
  constructor(
    message: string,
    public readonly gateIdentifier: string
  ) {
    super(message);
    this.name = 'ChannelGateBlockedError';
  }
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
 * Also thrown by deliverMessage() when the iteration cap is exceeded on a
 * cyclic channel (an unrecoverable limit — not a retryable gate block).
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
   * Gate data repository for reading/writing gate runtime data.
   * Required when workflows use the new separated Channel+Gate architecture
   * (WorkflowChannel.gateId). Optional for legacy-only workflows.
   */
  gateDataRepo?: GateDataRepository;
  /**
   * Gate open state repository for persisting the gate-open cache across
   * daemon restarts. When provided, gate-open state is read from and written
   * to SQLite instead of the in-memory Map. When omitted, the in-memory Map
   * is used (suitable for tests and standalone contexts).
   */
  gateOpenStateRepo?: GateOpenStateRepository;
  /**
   * Channel cycle repository for per-channel iteration tracking.
   * Required when workflows contain cyclic (backward) channels.
   */
  channelCycleRepo?: ChannelCycleRepository;
  /**
   * Raw SQLite database handle.
   * When provided, gate data resets and cycle counter increments on cyclic
   * channels are performed in a single atomic transaction (`db.transaction()`).
   * When omitted, operations are performed sequentially (still safe for most
   * single-process use cases but not ACID-atomic on crash).
   */
  db?: BunDatabase;
  /**
   * Workspace root path for script execution (used as cwd and
   * injected as `NEOKAI_WORKSPACE_PATH` into script environments).
   * When omitted, script-based gates are evaluated without a workspace
   * context (scripts that depend on filesystem access will fail).
   */
  workspacePath?: string;
  /**
   * Global concurrency cap for script-based gate evaluations.
   * When multiple gates with scripts are evaluated concurrently, only this
   * many scripts run at a time; others wait in a FIFO queue.
   * Gates without scripts bypass the semaphore entirely.
   * @default 4
   */
  maxConcurrentScripts?: number;
  /**
   * Resolves the space's autonomy level for a given space ID.
   * Used by gate auto-approval: when `gate.requiredLevel` is set and
   * `spaceLevel >= requiredLevel`, the gate is auto-approved after
   * script validation passes.
   * When omitted, gate auto-approval is disabled (gates with `requiredLevel`
   * always require manual approval).
   */
  getSpaceAutonomyLevel?: (spaceId: string) => Promise<SpaceAutonomyLevel>;
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
  /**
   * Called when a gate is actively waiting for human approval (gate data was
   * written, but the gate is still not open because `approved` has not been set).
   * Allows the caller to transition the canonical task to `review` status so the
   * task appears in the correct group in the UI.
   *
   * Only invoked for external-approval gates (gates with an `approved` field whose
   * `writers` array is empty). Not invoked when the gate opens, when it's blocked
   * by a script failure, or when it has no external-approval field.
   */
  onGatePendingApproval?: (runId: string, gateId: string) => Promise<void>;
  /**
   * Optional callback that resolves the current PR URL for a workflow run.
   * Injected into gate script environments as `PR_URL` so feature scripts
   * (e.g. codex reaction checks) can access the PR even when the gate's
   * own data does not contain `pr_url`.
   */
  getPrUrlForRun?: (runId: string) => string;
}

// ---------------------------------------------------------------------------
// ChannelRouter
// ---------------------------------------------------------------------------

/** Default concurrency cap for script-based gate evaluations. */
const DEFAULT_MAX_CONCURRENT_SCRIPTS = 4;

export class ChannelRouter {
  /**
   * Global concurrency semaphore for script-based gate evaluations.
   * Only gates with scripts acquire the semaphore; field-only gates bypass it.
   */
  private readonly scriptSemaphore: { acquired: number; max: number; waiters: Array<() => void> };

  /**
   * Per-gate evaluation coalescing cache, keyed by `"${runId}:${gateId}"`.
   * Multiple concurrent callers evaluating the same gate share one in-flight
   * promise. After the in-flight evaluation resolves, each coalesced caller
   * re-evaluates directly (via `doEvaluateGate`) to ensure fresh data.
   * The key format prevents cross-run state leakage.
   */
  private readonly gateEvaluations = new Map<string, Promise<GateEvalResult>>();

  /**
   * Fallback in-memory cache for gate-open state when `gateOpenStateRepo`
   * is not provided. Stores `workflow.updatedAt` for staleness detection.
   *
   * When `gateOpenStateRepo` is set, this field is unused — the repository
   * persists state across daemon restarts.
   */
  private readonly openedGates = new Map<string, number>();

  constructor(private readonly config: ChannelRouterConfig) {
    this.scriptSemaphore = {
      acquired: 0,
      max: config.maxConcurrentScripts ?? DEFAULT_MAX_CONCURRENT_SCRIPTS,
      waiters: [],
    };
  }

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
   * triggered the reopen (peer agent name, user id, or gate id). When
   * omitted, a generic `'activation'` attribution is used.
   *
   * No per-node SpaceTask rows are created.
   */
  async activateNode(
    runId: string,
    nodeId: string,
    options?: { reopenReason?: string; reopenBy?: string; allowTerminalReopen?: boolean }
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

    // Terminal run states are tombstones for passive activation sources (gate
    // cache refresh, hook/poll recovery). Only explicit live sends or manual
    // recovery paths may opt into reopening.
    if (run.status === 'done' || run.status === 'cancelled') {
      this.evictRunCache(runId);
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
      return existingTasks;
    }

    // ── 3. Resolve the workflow and node ───────────────────────────────────
    const workflow = this.config.workflowManager.getWorkflow(run.workflowId);
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

    const existingExecutions = this.config.nodeExecutionRepo.listByNode(runId, nodeId);
    const existingByAgentName = new Map(
      existingExecutions.map((execution) => [execution.agentName, execution])
    );

    for (const agentEntry of agents) {
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
        // tick loop respawns a fresh session. agentSessionId is write-once and
        // is never cleared; spawn code detects pending status to create a new session.
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
   * 2. **Cycle cap** — for cyclic channels, blocks when the per-channel cap is reached.
   * 3. **Gate condition** — evaluates the channel's gate via `evaluateGateById()`.
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

    // Evict gate-open cache for terminal runs so canDeliver returns accurate
    // results even when called before deliverMessage/onGateDataChanged.
    if (run.status === 'done' || run.status === 'cancelled' || run.status === 'blocked') {
      this.evictRunCache(runId);
    }

    const workflow = this.config.workflowManager.getWorkflow(run.workflowId);
    if (!workflow) throw new ActivationError(`Workflow not found: ${run.workflowId}`);

    const match = this.findMatchingWorkflowChannel(workflow, fromRole, toTarget);
    if (!match) {
      // Open topology — no declared channel for this pair; delivery is unrestricted
      return { allowed: true };
    }
    const { channel, index } = match;
    const gateSourceName = this.getChannelSourceName(workflow, channel, fromRole);

    const channelIsCyclic = this.isChannelCyclicByIndex(index, workflow);

    // ── Per-channel cycle cap check ──────────────────────────────────────
    if (channelIsCyclic) {
      const maxCycles = channel.maxCycles ?? 5;
      if (this.isCycleCapReached(runId, index, maxCycles)) {
        return {
          allowed: false,
          reason: `Cyclic channel from "${fromRole}" to "${toTarget}" has reached the maximum cycle count (${maxCycles}). Increase maxCycles to allow more cycles.`,
        };
      }
    }

    // ── Gate condition evaluation ────────────────────────────────────────
    // Cache optimization: skip re-evaluation when the gate was previously
    // opened (by a prior deliverMessage or onGateDataChanged), unless cyclic
    // with `resetOnCycle`. canDeliver does NOT write to the cache — it is a
    // non-mutating probe and must remain side-effect free so that a UI
    // readiness check cannot permanently cache a gate as open.
    if (channel.gateId) {
      const skipEval =
        this.isGateCachedOpen(runId, channel.gateId, workflow) &&
        !this.mustReevaluateGate(channel.gateId, channelIsCyclic, workflow, gateSourceName);

      if (skipEval) {
        return { allowed: true };
      }

      const gateResult = await this.evaluateGateById(
        runId,
        channel.gateId,
        workflow,
        gateSourceName
      );
      return { allowed: gateResult.open, reason: gateResult.reason };
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
   * Deliver a message from one agent to another (or to a node for fan-out)
   * within a workflow run.
   *
   * **Target resolution:**
   * - `toTarget` is an agent name → DM to the agent's node (lazy-activated
   *   if not already active)
   * - `toTarget` is a node name → fan-out to the node; all agent slots are
   *   activated (lazy-activated if not already active)
   *
   * **Gate evaluation:**
   * - Channels with `gateId`: `evaluateGate()` is called; gate data is loaded
   *   from `gate_data` via `GateDataRepository`.
   * - Channels without `gateId`: always open.
   * - Throws `ChannelGateBlockedError` when a gate blocks delivery.
   *
   * **Cyclic tracking:**
   * - For cyclic channels, the per-channel cycle counter is incremented after
   *   successful delivery. Gates with `resetOnCycle: true` are reset atomically.
   * - If the cycle cap has been reached, throws `ActivationError`.
   *
   * @param runId    - Workflow run ID
   * @param fromRole - Agent name of the sending agent (WorkflowNodeAgent.name)
   * @param toTarget - Agent name of the receiving agent, or node name for fan-out
   * @param message  - Message content to deliver
   * @returns DeliveredMessage descriptor; `activatedTasks` is set when the
   *   target node was lazily activated, undefined when it was already active
   * @throws ActivationError when the run, workflow, or target agent/node is not
   *   found, or the cyclic cap is exceeded
   * @throws ChannelGateBlockedError when a gate condition blocks delivery
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
    // gate evaluation so scripted gates do not run on tombstoned runs and
    // callers see the canonical archived-task error rather than a gate
    // closure (which would falsely suggest the work could resume once the
    // gate opens).
    if (this.isParentTaskArchived(runId)) {
      this.evictRunCache(runId);
      throw new ActivationError(ARCHIVED_TASK_ERROR_MESSAGE);
    }

    // Evict gate-open cache for terminal runs. This covers runs that completed
    // since the last call — the cache entries are no longer useful and would
    // otherwise persist until the router is GC'd. activateNode (below) handles
    // reopening and also evicts.
    if (run.status === 'done' || run.status === 'cancelled' || run.status === 'blocked') {
      this.evictRunCache(runId);
    }

    const workflow = this.config.workflowManager.getWorkflow(run.workflowId);
    if (!workflow) {
      throw new ActivationError(`Workflow not found: ${run.workflowId}`);
    }

    const match = this.findMatchingWorkflowChannel(workflow, fromRole, toTarget);
    const channel = match?.channel;
    const channelIndex = match?.index ?? -1;
    const gateSourceName = channel
      ? this.getChannelSourceName(workflow, channel, fromRole)
      : undefined;
    const channelIsCyclic = match ? this.isChannelCyclicByIndex(channelIndex, workflow) : false;

    // ── 2. Target resolution: agent name → DM, node name → fan-out ────────
    // Target resolution itself is non-mutating — only `activateNode` below
    // creates pending node_executions. For gated channels we evaluate the
    // gate BEFORE activating so blocked messages do not spawn the target
    // agent session prematurely. Once the gate opens (via
    // `onGateDataChanged` or a subsequent send), the target is activated
    // from the same code path.
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

    // Cycle caps reject the send itself, so they are enforced before activation.
    // Gates are evaluated later because they only block message content.
    if (channelIsCyclic && channel) {
      const maxCycles = channel.maxCycles ?? 5;
      if (this.isCycleCapReached(runId, channelIndex, maxCycles)) {
        throw new ActivationError(
          `Cyclic channel from "${fromRole}" to "${toTarget}" has reached the maximum cycle count (${maxCycles}). Increase maxCycles to allow more cycles.`
        );
      }
    }

    // ── 3. Gate evaluation (BEFORE activation) ───────────────────────────
    // Evaluate the channel's gate first when one exists. If the gate is
    // closed, throw without creating any pending node_executions for the
    // target — otherwise the tick loop would spawn agent sessions for
    // gates that have not yet opened (e.g. Task Dispatcher activating
    // before all 4 reviewers approve in plan-approval-gate).
    //
    // Cache optimization: once a gate has evaluated to `open: true`, skip
    // re-evaluation on subsequent messages. Exception: cyclic channels
    // whose gate has `resetOnCycle: true` must always re-evaluate because
    // their gate data is reset on each cycle traversal.
    if (channel?.gateId) {
      const skipEval =
        this.isGateCachedOpen(runId, channel.gateId, workflow) &&
        !this.mustReevaluateGate(channel.gateId, channelIsCyclic, workflow, gateSourceName);

      if (!skipEval) {
        const gateResult = await this.evaluateGateById(
          runId,
          channel.gateId,
          workflow,
          gateSourceName
        );
        if (gateResult.open) {
          this.cacheGateOpened(runId, channel.gateId, workflow);
        }
        if (!gateResult.open) {
          throw new ChannelGateBlockedError(
            gateResult.reason ??
              `Gate "${channel.gateId}" blocked delivery from "${fromRole}" to "${toTarget}"`,
            channel.gateId
          );
        }
      }
    }

    // ── 4. Lazy activation ─────────────────────────────────────────────────
    // Only reached when the channel is open (no gate, or gate eval passed).
    const activeTasks = this.getActiveTasksForNode(runId, targetNode.id);
    let activatedTasks: SpaceTask[] | undefined;

    if (activeTasks.length === 0) {
      activatedTasks = await this.activateNode(runId, targetNode.id, {
        allowTerminalReopen: true,
        reopenBy: `agent:${fromRole}`,
        reopenReason: `peer send_message from "${fromRole}" to "${toTarget}"`,
      });
    }

    // ── 5. Re-check gate AFTER activation ────────────────────────────────
    // `await this.activateNode(...)` yields to the event loop. A concurrent
    // `incrementAndResetCyclicChannel` (e.g. on a `resetOnCycle` gate) can
    // reset gate data during that await, transitioning the gate from open
    // → closed. Re-evaluate the gate here so a stale-gate race cannot let
    // the message proceed as if the channel were still open. The pre-
    // activation check (step 3) is still useful because it short-circuits
    // the common case without creating pending executions; this second
    // check is the correctness backstop.
    //
    // Cache optimization: same as step 3 — skip re-evaluation when the gate
    // was previously opened, unless cyclic with `resetOnCycle`.
    if (channel?.gateId) {
      const skipEval =
        this.isGateCachedOpen(runId, channel.gateId, workflow) &&
        !this.mustReevaluateGate(channel.gateId, channelIsCyclic, workflow, gateSourceName);

      if (!skipEval) {
        const postActivationGate = await this.evaluateGateById(
          runId,
          channel.gateId,
          workflow,
          gateSourceName
        );
        if (postActivationGate.open) {
          this.cacheGateOpened(runId, channel.gateId, workflow);
        }
        if (!postActivationGate.open) {
          throw new ChannelGateBlockedError(
            postActivationGate.reason ??
              `Gate "${channel.gateId}" closed during activation; blocking delivery from "${fromRole}" to "${toTarget}"`,
            channel.gateId
          );
        }
      }
    }

    // ── 6. Increment per-channel cycle count and reset cyclic gates ──────
    if (channelIsCyclic && channel) {
      this.incrementAndResetCyclicChannel(runId, channelIndex, channel.maxCycles ?? 5, workflow);
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
   * Called when gate data changes for a given gate (e.g., after an agent writes
   * to gate data via the `write_gate` MCP tool).
   *
   * Re-evaluates all channels in the workflow run that reference `gateId`. If the
   * gate is now open AND the channel's target node has no active tasks, the node
   * is lazily activated.
   *
   * This enables vote-counting gates: each agent write calls `onGateDataChanged()`,
   * and when enough votes accumulate to satisfy the condition, the target node is
   * automatically activated.
   *
   * When multiple channels share the same gate (e.g., three reviewer nodes all
   * gated by `code-pr-gate`), all target nodes are activated in parallel via
   * `Promise.allSettled()`. This ensures that reviewer1, reviewer2, and reviewer3
   * activate simultaneously rather than sequentially.
   *
   * @param runId  - Workflow run ID
   * @param gateId - ID of the gate whose data changed
   * @returns Array of newly activated SpaceTask records (may be empty)
   */
  async onGateDataChanged(runId: string, gateId: string): Promise<SpaceTask[]> {
    const run = this.config.workflowRunRepo.getRun(runId);
    if (!run) return [];

    // Archived tasks and terminal runs are tombstones for passive gate refresh.
    // Only explicit activation paths opt into terminal reopen.
    if (this.isParentTaskArchived(runId)) {
      this.evictRunCache(runId);
      return [];
    }

    // Evict gate-open cache for terminal runs. Same rationale as deliverMessage.
    if (run.status === 'done' || run.status === 'cancelled' || run.status === 'blocked') {
      this.evictRunCache(runId);
    }

    const workflow = this.config.workflowManager.getWorkflow(run.workflowId);
    if (!workflow) return [];

    if (!this.config.gateDataRepo) return [];

    // Find all channels in this workflow that reference this gate
    const channels = (workflow.channels ?? []).filter((ch) => ch.gateId === gateId);
    if (channels.length === 0) return [];

    // --- Auto-approval: pre-write approval data when the space's autonomy level meets or
    // exceeds the gate's required level, so the approval field passes on evaluation.
    // Missing requiredLevel defaults to 5 (maximum restriction) — agents can only
    // auto-approve a gate without an explicit requiredLevel when space autonomy is 5.
    // This runs only in onGateDataChanged (not on every deliverMessage/tryActivateChannels)
    // to avoid redundant async space lookups on hot paths.
    const gateDef = (workflow.gates ?? []).find((g) => g.id === gateId);
    if (gateDef && this.config.getSpaceAutonomyLevel) {
      const approvalData = this.buildAutoApprovalData(gateDef);
      if (approvalData) {
        const effectiveRequiredLevel = gateDef.requiredLevel ?? 5;
        const spaceLevel = await this.config.getSpaceAutonomyLevel(run.spaceId);
        if (spaceLevel >= effectiveRequiredLevel) {
          this.config.gateDataRepo.merge(runId, gateId, approvalData);
        }
      }
    }

    // Evaluate the gate per channel with source-scoped effective gate so that
    // dynamic features on wildcard channels are evaluated against concrete
    // source nodes instead of the literal '*'. With no sender attached to a
    // gate-data write, wildcard channels only open when the gate is open for
    // every possible source node.
    const openChannels: typeof channels = [];
    for (const ch of channels) {
      const sourceNames = this.getGateDataChangeSourceNames(workflow, ch);
      const results = await Promise.all(
        sourceNames.map((sourceName) => this.evaluateGateById(runId, gateId, workflow, sourceName))
      );
      if (results.every((result) => result.open)) {
        openChannels.push(ch);
      }
    }

    if (openChannels.length > 0) {
      this.cacheGateOpened(runId, gateId, workflow);
    }

    if (openChannels.length === 0) {
      // Notify caller when the gate is waiting for human approval. Only fires for
      // external-approval gates — those with an `approved` field with no declared
      // writers (i.e. only a human can set `approved: true`).
      if (this.config.onGatePendingApproval && gateDef) {
        const needsHuman = (gateDef.fields ?? []).some(
          (f) => f.name === 'approved' && Array.isArray(f.writers) && f.writers.length === 0
        );
        if (needsHuman) {
          void this.config.onGatePendingApproval(runId, gateId).catch((err) => {
            log.warn(
              `onGatePendingApproval failed for gate "${gateId}" in run "${runId}": ` +
                (err instanceof Error ? err.message : String(err))
            );
          });
        }
      }
      return [];
    }

    // Determine if any opened channels are cyclic — if so, enforce the
    // per-channel cap before activating any node (mirrors the guard in
    // deliverMessage). Only check channels that actually opened, so a closed
    // cyclic channel sharing the gate does not block activation of an open one.
    const allChannels = workflow.channels ?? [];
    for (const ch of openChannels) {
      const chIdx = allChannels.indexOf(ch);
      if (chIdx >= 0 && this.isChannelCyclicByIndex(chIdx, workflow)) {
        const maxCycles = ch.maxCycles ?? 5;
        if (this.isCycleCapReached(runId, chIdx, maxCycles)) {
          throw new ActivationError(
            `Cyclic channel via gate "${gateId}" (index ${chIdx}) has reached the maximum cycle count (${maxCycles}). Increase maxCycles to allow more cycles.`
          );
        }
      }
    }

    // Only increment cycle counters for cyclic channels that actually opened.
    let cyclicChannelMatch: { index: number; maxCycles: number } | null = null;
    for (const ch of openChannels) {
      const chIdx = allChannels.indexOf(ch);
      if (chIdx >= 0 && this.isChannelCyclicByIndex(chIdx, workflow)) {
        cyclicChannelMatch = { index: chIdx, maxCycles: ch.maxCycles ?? 5 };
      }
    }

    // Gate is open for at least one channel → collect unique node IDs that
    // need activation from the open channels only. Deduplicate before spawning
    // to avoid redundant activateNode() calls.
    const nodeIdsToActivate = new Set<string>();
    for (const channel of openChannels) {
      const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
      for (const target of targets) {
        // Resolve target: first by agent name, then by node name (fan-out)
        let targetNode = this.findNodeByAgentName(workflow, target);
        if (!targetNode) {
          targetNode = workflow.nodes.find((n) => n.name === target);
        }
        if (!targetNode) continue;

        // Only activate if no active tasks for this node
        const activeTasks = this.getActiveTasksForNode(runId, targetNode.id);
        if (activeTasks.length === 0) {
          nodeIdsToActivate.add(targetNode.id);
        }
      }
    }

    if (nodeIdsToActivate.size === 0) return [];

    // Activate all target nodes in parallel. When a shared gate controls multiple
    // independent nodes (e.g., code-pr-gate → reviewer1, reviewer2, reviewer3),
    // this ensures they all become active simultaneously rather than sequentially.
    const reopenOptions = {
      reopenReason: `gate "${gateId}" opened — re-activating target node(s)`,
      reopenBy: `gate:${gateId}`,
    };
    const results = await Promise.allSettled(
      [...nodeIdsToActivate].map((nodeId) => this.activateNode(runId, nodeId, reopenOptions))
    );

    const activatedTasks: SpaceTask[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        activatedTasks.push(...result.value);
      }
      // Rejected: run may have transitioned to terminal state between the
      // nodeIdsToActivate check above and the activation attempt — silently skip.
    }

    // For cyclic channels: increment the per-channel cycle counter and reset
    // gates with `resetOnCycle: true`. This mirrors the logic in deliverMessage and
    // ensures the QA→Coding feedback path (triggered via write_gate MCP tool →
    // onGateDataChanged) correctly resets reviewer votes and advances the cycle counter.
    if (cyclicChannelMatch && activatedTasks.length > 0) {
      this.incrementAndResetCyclicChannel(
        runId,
        cyclicChannelMatch.index,
        cyclicChannelMatch.maxCycles,
        workflow
      );
    }

    return activatedTasks;
  }

  // -------------------------------------------------------------------------
  // Gate-open cache helpers
  // -------------------------------------------------------------------------

  /**
   * Generate a fingerprint for gate-open cache invalidation.
   *
   * Combines workflow.updatedAt with a hash of the gate definition to create a
   * stronger fingerprint than just the millisecond timestamp. This ensures that
   * if a workflow is edited multiple times within the same millisecond (rapid
   * successive edits), the fingerprint still changes and the cache invalidates.
   *
   * Uses addition instead of bitwise shift to avoid 32-bit truncation issues in
   * JavaScript (bitwise ops are 32-bit, so `updatedAt << 32` would wrap around).
   *
   * @param workflow - The workflow containing the gate
   * @param gateId - The ID of the gate to fingerprint
   * @returns A number combining timestamp and gate definition hash
   */
  private generateGateFingerprint(workflow: SpaceWorkflow, gateId: string): number {
    // Find the gate definition
    const gateDef = (workflow.gates ?? []).find((g) => g.id === gateId);
    if (!gateDef) return workflow.updatedAt;

    // Create a simple hash from the gate definition JSON
    // This is a fast, non-cryptographic hash suitable for cache invalidation
    const gateJson = JSON.stringify(gateDef);
    let hash = 0;
    for (let i = 0; i < gateJson.length; i++) {
      hash = (hash << 5) - hash + gateJson.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Combine timestamp and hash using addition instead of bitwise shift
    // to avoid 32-bit truncation (JavaScript bitwise ops are 32-bit).
    // This creates a unique fingerprint that changes when either the workflow
    // is updated OR the gate definition is edited.
    return workflow.updatedAt + hash;
  }

  /** Build the cache key for a `(runId, gateId)` pair. */
  private gateOpenKey(runId: string, gateId: string): string {
    return `${runId}:${gateId}`;
  }

  /**
   * Returns true when the gate has previously evaluated to `open: true`
   * AND the workflow definition has not changed since the gate was cached.
   *
   * @param workflowUpdatedAt  The workflow's `updatedAt` timestamp. When the
   *   workflow is updated (e.g. gate conditions tightened), the timestamp
   *   changes and the cache entry is considered stale — the gate is
   *   re-evaluated against the new definition.
   */
  private isGateCachedOpen(runId: string, gateId: string, workflow: SpaceWorkflow): boolean {
    if (this.config.gateOpenStateRepo) {
      const state = this.config.gateOpenStateRepo.isOpen(runId, gateId);
      if (!state.open) return false;
      // Compare against a stronger fingerprint that combines workflow.updatedAt
      // with a hash of the gate definition, preventing cache hits after rapid edits
      const expectedFingerprint = this.generateGateFingerprint(workflow, gateId);
      if (state.workflowUpdatedAt !== undefined && state.workflowUpdatedAt !== expectedFingerprint)
        return false;
      return true;
    }
    // Fallback to in-memory Map when no repository is configured
    const cached = this.openedGates.get(this.gateOpenKey(runId, gateId));
    if (cached === undefined) return false;
    const expectedFingerprint = this.generateGateFingerprint(workflow, gateId);
    if (cached !== expectedFingerprint) return false;
    return true;
  }

  /**
   * Mark a gate as having been opened, storing a fingerprint for staleness checks.
   *
   * The fingerprint combines `workflow.updatedAt` with a hash of the gate
   * definition, ensuring cache invalidation on both workflow updates AND
   * gate definition edits (even rapid successive edits within the same millisecond).
   */
  private cacheGateOpened(runId: string, gateId: string, workflow: SpaceWorkflow): void {
    const fingerprint = this.generateGateFingerprint(workflow, gateId);
    if (this.config.gateOpenStateRepo) {
      this.config.gateOpenStateRepo.markOpened(runId, gateId, fingerprint);
      return;
    }
    // Fallback to in-memory Map when no repository is configured
    this.openedGates.set(this.gateOpenKey(runId, gateId), fingerprint);
  }

  /**
   * Returns true when a gate's cached open state should be *ignored* for a
   * given delivery context — i.e. the gate must be re-evaluated.
   *
   * This is the case when:
   * - The channel is cyclic AND the gate has `resetOnCycle: true`.
   *
   * For non-cyclic channels or cyclic channels whose gate does not reset,
   * the cached state is authoritative.
   */
  private getChannelSourceName(
    workflow: SpaceWorkflow,
    channel: WorkflowChannel,
    fromRole?: string
  ): string {
    if (channel.from !== '*') return channel.from;
    if (!fromRole) return channel.from;
    return this.findNodeByAgentName(workflow, fromRole)?.name ?? fromRole;
  }

  private getGateDataChangeSourceNames(
    workflow: SpaceWorkflow,
    channel: WorkflowChannel
  ): string[] {
    if (channel.from !== '*') return [channel.from];
    return workflow.nodes.map((node) => node.name);
  }

  private mustReevaluateGate(
    gateId: string,
    channelIsCyclic: boolean,
    workflow: SpaceWorkflow,
    sourceNodeName?: string
  ): boolean {
    // Check gate existence BEFORE the cyclic-channel shortcut — if the gate
    // definition was removed from the workflow (e.g. by a workflow edit),
    // force re-evaluation so the gate evaluator fails closed with
    // "Gate not found" instead of silently allowing delivery based on a
    // stale cache entry. This must apply to ALL channels, not just cyclic ones.
    const gateDef = (workflow.gates ?? []).find((g) => g.id === gateId);
    if (!gateDef) return true;

    // Gates with an effective script must always re-evaluate when:
    // - The workflow is template-backed (scripts can change via getBuiltInGateScript)
    // - OR the script is compiled from a registered feature (registry can change
    //   independently of workflow.updatedAt). Caching such gates would create a
    //   fail-open path where a once-open gate bypasses evaluation even after
    //   script updates or external state changes.
    const effectiveGateDef = getEffectiveGate(gateDef, workflow, sourceNodeName);
    if (effectiveGateDef.script && (workflow.templateName || !gateDef.script)) return true;

    if (!channelIsCyclic) return false;
    return gateDef.resetOnCycle === true;
  }

  /**
   * Evict all cached gate-open entries for a given run.
   *
   * Called automatically when `deliverMessage` or `onGateDataChanged` detects
   * that the run has reached a terminal status (done/cancelled), when the
   * parent task is archived, or when a terminal run is reopened via
   * `activateNode`.
   *
   * Without this, the in-memory `openedGates` set retains entries for
   * completed runs until the owning ChannelRouter instance is garbage-collected
   * (which happens when the node-agent session ends).
   */
  evictRunCache(runId: string): void {
    if (this.config.gateOpenStateRepo) {
      this.config.gateOpenStateRepo.clearOpenedByRun(runId);
      return;
    }
    // Fallback to in-memory Map when no repository is configured
    for (const [key] of this.openedGates) {
      if (key.startsWith(`${runId}:`)) {
        this.openedGates.delete(key);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Evaluates a gate by ID against its current runtime data from `gate_data`.
   *
   * Looks up the gate definition in `workflow.gates`, loads the runtime data from
   * `GateDataRepository`, and evaluates the condition.
   *
   * **Coalescing:** Multiple concurrent callers for the same `runId:gateId` share
   * one in-flight evaluation promise. After the in-flight evaluation completes,
   * each coalesced caller re-evaluates directly (`doEvaluateGate`) to ensure
   * fresh data — this avoids stale-result bugs when 3+ callers race on the same
   * key. The direct call bypasses coalescing to prevent infinite loops.
   *
   * **Concurrency:** Gates with scripts acquire the global semaphore (up to
   * `maxConcurrentScripts`). Field-only gates bypass the semaphore entirely.
   *
   * **Fallback behavior when `gateDataRepo` is absent or no DB record exists:**
   * Evaluates against the gate's default `data` (as declared in the workflow definition).
   * This means a gate can open on first evaluation if its default data satisfies the
   * condition — callers that use `gateId` channels should always provide `gateDataRepo`.
   *
   * Returns `{ open: false }` with a descriptive reason when:
   * - The gate is not found in `workflow.gates` (misconfiguration)
   * - The condition fails against the runtime (or default) data
   * - A script pre-check fails
   */
  private async evaluateGateById(
    runId: string,
    gateId: string,
    workflow: SpaceWorkflow,
    sourceNodeName?: string
  ): Promise<GateEvalResult> {
    // Include source in the in-flight key so that unflagged and flagged
    // sources do not share coalesced evaluations for the same gate.
    const key = sourceNodeName ? `${runId}:${gateId}:${sourceNodeName}` : `${runId}:${gateId}`;

    // Coalescing: if an evaluation is already in-flight, await it,
    // then re-evaluate directly to ensure fresh data. This avoids
    // stale-result bugs when 3+ callers race on the same key (where
    // a dirty-flag approach would let later callers return stale data
    // consumed by an earlier waiter).
    const inflight = this.gateEvaluations.get(key);
    if (inflight) {
      await inflight;
      // Re-evaluate directly (bypass coalescing to avoid infinite loops)
      return this.doEvaluateGate(runId, gateId, workflow, sourceNodeName);
    }

    // No in-flight evaluation — start a new one
    const evalPromise = this.doEvaluateGate(runId, gateId, workflow, sourceNodeName);
    this.gateEvaluations.set(key, evalPromise);

    try {
      return await evalPromise;
    } finally {
      this.gateEvaluations.delete(key);
    }
  }

  /**
   * Core gate evaluation logic with semaphore wrapping for script-based gates.
   *
   * - Field-only gates: evaluate synchronously (no semaphore overhead).
   * - Script gates: acquire semaphore → execute script → evaluate fields → release.
   */
  private async doEvaluateGate(
    runId: string,
    gateId: string,
    workflow: SpaceWorkflow,
    sourceNodeName?: string
  ): Promise<GateEvalResult> {
    const storedGateDef = (workflow.gates ?? []).find((g) => g.id === gateId);
    if (!storedGateDef) {
      return {
        open: false,
        reason: `Gate "${gateId}" not found in workflow "${workflow.id}" — channel is closed (misconfiguration)`,
      };
    }

    // When this workflow was seeded from a built-in template, always resolve the
    // gate script from the *current* template definition rather than the copy that
    // was baked in at seed time. This ensures that template script updates (bug
    // fixes, new fallback logic, etc.) take immediate effect for all running
    // workflow instances without requiring a resync.
    let gateDef = storedGateDef;
    if (workflow.templateName) {
      const liveScript = getBuiltInGateScript(workflow.templateName, gateId);
      if (liveScript && storedGateDef.script) {
        gateDef = { ...storedGateDef, script: liveScript };
      }
    }
    gateDef = getEffectiveGate(gateDef, workflow, sourceNodeName);

    // Load runtime data from DB; fall back to computed defaults from fields
    const record = this.config.gateDataRepo?.get(runId, gateId);
    const runtimeData = record?.data ?? computeGateDefaults(gateDef.fields ?? []);

    // Field-only gates skip the semaphore entirely
    if (!gateDef.script) {
      return evaluateGate(gateDef, runtimeData);
    }

    // Script-based gates acquire the semaphore and pass executor + context.
    // Inject workflow start time as ISO8601 so scripts that need to filter by
    // "since workflow start" (e.g. review-posted-gate) have a stable reference.
    const run = this.config.workflowRunRepo.getRun(runId);
    const workflowStartIso = run ? new Date(run.createdAt).toISOString() : undefined;

    const scriptExecutor: GateScriptExecutorFn = executeGateScript;
    const scriptContext: GateScriptContext = {
      workspacePath: this.config.workspacePath ?? process.cwd(),
      gateId,
      runId,
      gateData: runtimeData,
      workflowStartIso,
      gateDataUpdatedIso: record ? new Date(record.updatedAt).toISOString() : undefined,
      prUrl: this.config.getPrUrlForRun?.(runId),
    };

    return this.withScriptSemaphore(async () => {
      return evaluateGate(gateDef, runtimeData, scriptExecutor, scriptContext);
    });
  }

  /**
   * Builds auto-approval gate data for gates with requiredLevel.
   * Only generates data for boolean fields with `check: { op: '==', value: true }` —
   * these are the standard approval pattern. Complex fields (maps, counts) are not
   * auto-approved.
   *
   * Returns null if no fields can be auto-approved.
   */
  private buildAutoApprovalData(gateDef: {
    fields?: Array<{ name: string; type: string; check?: { op: string; value?: unknown } }>;
  }): Record<string, unknown> | null {
    const data: Record<string, unknown> = {};
    let hasApprovalField = false;

    for (const field of gateDef.fields ?? []) {
      if (field.type === 'boolean' && field.check?.op === '==' && field.check.value === true) {
        data[field.name] = true;
        hasApprovalField = true;
      }
    }

    return hasApprovalField ? data : null;
  }

  /**
   * Acquires the global script semaphore, runs `fn`, then releases.
   * If all slots are taken, the caller blocks until a slot is available.
   */
  private async withScriptSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    const sem = this.scriptSemaphore;
    if (sem.acquired < sem.max) {
      sem.acquired++;
      try {
        return await fn();
      } finally {
        this.releaseSemaphore();
      }
    }

    // All slots taken — wait in queue
    return new Promise<T>((resolve, reject) => {
      sem.waiters.push(() => {
        sem.acquired++;
        fn()
          .then(resolve, reject)
          .finally(() => this.releaseSemaphore());
      });
    });
  }

  /** Releases one semaphore slot and wakes the next waiter if any. */
  private releaseSemaphore(): void {
    const sem = this.scriptSemaphore;
    sem.acquired--;
    if (sem.waiters.length > 0) {
      const next = sem.waiters.shift()!;
      next();
    }
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
    const workflow = this.config.workflowManager.getWorkflow(run.workflowId);
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
   * Checks whether a cyclic channel has reached its per-channel cycle cap.
   */
  private isCycleCapReached(runId: string, channelIndex: number, maxCycles: number): boolean {
    if (!this.config.channelCycleRepo) return false;
    const record = this.config.channelCycleRepo.get(runId, channelIndex);
    return record ? record.count >= maxCycles : false;
  }

  /**
   * Atomically increments the per-channel cycle counter and resets gates
   * with `resetOnCycle: true`.
   *
   * When `db` is in config: runs both operations in a single SQLite transaction.
   * When `db` is absent: runs operations sequentially (safe for single-process).
   *
   * Throws `ActivationError` if the cycle cap was already reached at the time
   * of the atomic increment (concurrent TOCTOU race).
   */
  private incrementAndResetCyclicChannel(
    runId: string,
    channelIndex: number,
    maxCycles: number,
    workflow: SpaceWorkflow
  ): void {
    if (!this.config.channelCycleRepo) return;

    const cyclicGates = (workflow.gates ?? []).filter((g) => g.resetOnCycle);

    // Clear cached open state for all gates that are about to be reset,
    // so the next delivery re-evaluates them against the reset data.
    for (const gate of cyclicGates) {
      if (this.config.gateOpenStateRepo) {
        this.config.gateOpenStateRepo.clearOpened(runId, gate.id);
      } else {
        this.openedGates.delete(this.gateOpenKey(runId, gate.id));
      }
    }

    if (this.config.db && this.config.gateDataRepo && cyclicGates.length > 0) {
      const transaction = this.config.db.transaction(() => {
        for (const gate of cyclicGates) {
          this.config.gateDataRepo!.reset(runId, gate.id, computeGateDefaults(gate.fields ?? []));
        }
        return this.config.channelCycleRepo!.incrementCycleCount(runId, channelIndex, maxCycles);
      });
      const incremented = transaction();
      if (!incremented) {
        throw new ActivationError(
          `Cyclic channel (index ${channelIndex}) reached the maximum cycle count (${maxCycles}) during delivery.`
        );
      }
    } else {
      if (this.config.gateDataRepo) {
        for (const gate of cyclicGates) {
          this.config.gateDataRepo.reset(runId, gate.id, computeGateDefaults(gate.fields ?? []));
        }
      }
      const incremented = this.config.channelCycleRepo.incrementCycleCount(
        runId,
        channelIndex,
        maxCycles
      );
      if (!incremented) {
        throw new ActivationError(
          `Cyclic channel (index ${channelIndex}) reached the maximum cycle count (${maxCycles}) during delivery.`
        );
      }
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
   * Policy: the NeoKai space runtime uses a one-task-per-run model. The run
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
