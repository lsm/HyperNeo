/**
 * HandoffExecutor — the reusable runtime operation for formal workflow ownership
 * transfer via the handoff contract (task #923).
 *
 * A first-class `handoff({ target, summary, data? })` (see `HandoffOperation`)
 * differs from a generic `send_message`: a handoff target MUST resolve to a
 * declared outbound `HandoffTransition` on the sender's node, and a successful
 * handoff completes the sender's execution round (round completion is the
 * caller's responsibility — see the note below).
 *
 * This operation owns the transition-specific pipeline and reuses the existing
 * authorization/delivery primitives rather than duplicating them:
 *
 *   1. Validate task/run state (terminal runs reject handoffs).
 *   2. Resolve the sender's node + the declared transition (`resolveHandoffTransition`).
 *   3. Resolve target node(s) + agent slot(s) from the transition target; reject
 *      self-targets and `data` keys the transition declares no shape for.
 *   4. Authorize the declared channel topology (`ChannelResolver`) — when channels
 *      are declared, the source→target delivery must be permitted, mirroring
 *      `send_message`. Open topology (no channels) permits all handoffs.
 *   5. Enforce cyclic transition `maxCycles` (`HandoffCycleRepository`): an
 *      atomic reservation BEFORE the hook, so hook side effects never run on a
 *      guaranteed-to-fail attempt; the reservation is refunded whenever the
 *      handoff isn't taken (hook block/failure or no delivery).
 *   6. Execute the transition's hook validator (`HookExecutor`) — the sole
 *      authorization primitive now that the legacy gate subsystem is gone.
 *   7. Activate or reuse the target worker session (`activateTargetSession`) and
 *      deliver the existing peer-message shape (`formatAgentMessage`), queueing
 *      when the target session is not yet live.
 *   8. Return a structured `delivered` / `queued` / `blocked` / `failed` result.
 *
 * Reuse, not duplication: the hook engine, channel authorization, and target
 * activation are the SAME primitives `send_message` and the channel router use.
 * Only the transition-specific resolve/cycle/hook-binding logic is new — it
 * lives here.
 *
 * Scope (initial phase): this delivers the EXISTING peer-message envelope.
 * Authoritative fresh-turn packet construction (and the sender round-completion
 * that accompanies a delivered handoff) is a later task; this operation returns
 * a result the caller interprets as "the handoff was taken — complete the
 * sender's round". It does not alter generic `send_message` semantics.
 */

import type {
  HandoffOperation,
  HandoffTransition,
  NodeExecutionStatus,
  SpaceWorkflow,
  WorkflowHook,
  WorkflowHookResult,
  WorkflowNode,
} from '@hyperneo/shared';
import {
  HANDOFF_TARGET_WILDCARD,
  resolveHandoffTransition,
  resolveNodeAgents,
} from '@hyperneo/shared';
import type { HandoffCycleRepository } from '../../../storage/repositories/handoff-cycle-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import { Logger } from '../../logger';
import { formatAgentMessage } from '../agent-message-envelope';
import { ChannelResolver } from './channel-resolver';
import type { HookExecutor, HookExecutorContext } from './hook-executor';

const log = new Logger('handoff-executor');

/**
 * Default cycle cap for a cyclic transition that omits `maxCycles` — mirrors
 * the default cyclic channels use (`WorkflowChannel.maxCycles ?? 5`) so a valid
 * custom workflow can't run an unbounded agent loop.
 */
const DEFAULT_HANDOFF_MAX_CYCLES = 5;

/**
 * Lifetime of a QUEUED handoff (target session not yet active). Far longer than
 * the 60s peer-message default so a formal ownership transfer survives slow
 * target activation (daemon restart, startup backlog, provider-cap delay)
 * instead of expiring after the sender's round is already complete.
 */
const HANDOFF_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum size (chars) of the handoff `summary` or the JSON-serialized `data`
 * payload — mirrors send_message's payload cap so a handoff can't inject an
 * oversized envelope into a target session.
 */
const HANDOFF_PAYLOAD_MAX_CHARS = 100_000;

/**
 * Sender-side execution statuses that authorize a handoff — the sender's
 * CURRENT round must still be open: `in_progress` (actively running),
 * `blocked` (paused mid-round, retryable), or `waiting_rebind` (orphaned
 * tool-result recovery — the handoff call may itself be the result being
 * recovered). Excluded: `idle`/`done` mark a FINISHED round
 * (`TERMINAL_NODE_EXECUTION_STATUSES` classifies `idle` as ended; a late tool
 * call from the completed round must not transfer ownership again —
 * reactivation starts a NEW round), `pending` is a spawn-retry row that can
 * retain the previous (dead) session id, and `cancelled` is gone.
 */
const SENDER_ACTIVE_STATUSES: ReadonlySet<NodeExecutionStatus> = new Set([
  'in_progress',
  'blocked',
  'waiting_rebind',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lifecycle stage at which a handoff resolved. Surfaced for diagnostics. */
export type HandoffStage =
  | 'resolve_run'
  | 'resolve_source'
  | 'resolve_transition'
  | 'resolve_target'
  | 'authorize_channel'
  | 'cycle_limit'
  | 'hook'
  | 'deliver'
  | 'unexpected';

/**
 * Internal typed error thrown by the gate/hook/delivery helpers when an
 * underlying call (DB read/write, gate script, hook validator) throws
 * unexpectedly. {@link HandoffExecutor.execute} catches it (and any other
 * throw) and maps it to a structured `failed` result so the operation never
 * throws to its caller.
 */
class HandoffExecutionError extends Error {
  constructor(
    readonly stage: HandoffStage,
    message: string
  ) {
    super(message);
    this.name = 'HandoffExecutionError';
  }
}

export type HandoffExecutionStatus = 'delivered' | 'queued' | 'blocked' | 'failed';

export interface HandoffHookOutcome {
  hookId: string;
  result: WorkflowHookResult;
  /**
   * Whether this hook's result blocks the handoff. Side-effect-classified hooks
   * never block (the shared hook engine records their block/retryable_block
   * results without blocking — only validation hooks gate the action), so a
   * transition bound to a side-effect hook keeps that non-blocking behavior on
   * the handoff path.
   */
  blocks: boolean;
}

export interface HandoffExecutionResult {
  status: HandoffExecutionStatus;
  /** The transition the handoff resolved to (omitted when resolution failed). */
  transition?: HandoffTransition;
  /** Target node names the handoff resolved to. */
  targetNodes: string[];
  /** Target agent slots delivery was attempted for. */
  targetSlots: string[];
  delivered: Array<{ agentName: string; sessionId: string }>;
  queued: Array<{ agentName: string; messageId: string }>;
  /** Human-readable reason for a blocked/failed outcome. */
  reason?: string;
  /** Stage that produced the outcome. */
  stage?: HandoffStage;
  /** Hook outcome when a transition validator ran. */
  hook?: HandoffHookOutcome;
  /** Suggested backoff when blocked by a retryable hook (retryable_block). */
  retryAfterMs?: number;
}

export interface HandoffExecutorConfig {
  /** Run-state validation. */
  workflowRunRepo: SpaceWorkflowRunRepository;
  /** The workflow definition for this run (nodes/hooks/channels/transitions). */
  workflow: SpaceWorkflow;
  /** Per-transition cycle counters (enforce cyclic maxCycles). */
  handoffCycleRepo: HandoffCycleRepository;
  /** Node execution rows (target session discovery). */
  nodeExecutionRepo: NodeExecutionRepository;

  workflowRunId: string;
  spaceId: string;
  taskId?: string;
  taskNumber?: number | null;
  /**
   * The run's workspace path (the task worktree). Passed into hook context so
   * hook validators/script hooks resolve the correct repository (built-ins like
   * `pr_ready` run `gh` here; script hooks use it as spawn cwd).
   */
  workspacePath?: string;

  /** Hook validator engine. Required for transitions that bind a hookId. */
  hookExecutor?: HookExecutor;

  /**
   * The owning task's current status (e.g. 'approved'), and the run's frozen
   * reviewed-PR URL. Both are REQUIRED for transition-bound validators that
   * gate on task phase + frozen identity (e.g. `pr_ready`'s post-approval
   * branch binds a supplied pr_url to the frozen one — without `taskStatus`
   * that branch is skipped, letting a handoff redirect approval authority to a
   * different PR). Mirror what WorkflowHookEngine injects into hook context.
   */
  getTaskStatus?: () => string | undefined;
  getFrozenPrUrl?: () => string | undefined;

  /** node name → agent slot names (fan-out / slot→node resolution). */
  nodeGroups?: Record<string, string[]>;
  /** node id → node name (peer nodeName hydration after activation). */
  workflowNodeNameById?: Record<string, string>;

  /**
   * Existing target-activation callback (the SAME primitive send_message uses;
   * production wires `TaskAgentManager.activateTargetSessionsForMessage`, whose
   * `options.workflowNodeId` scopes session lookup/spawn to ONE node). Always
   * pass the pair's resolved node id: a valid workflow may reuse a slot name
   * across nodes, and activation by agent name alone could select (and spawn
   * into) the sibling node's identically named slot.
   */
  activateTargetSession?: (
    agentName: string,
    workflowNodeId?: string
  ) => Promise<Array<{ agentName: string; sessionId: string }>>;
  /** Injects the peer-message envelope into a live target session. */
  messageInjector: (sessionId: string, message: string) => Promise<void>;
  /** Persistent queue for declared-but-inactive targets (mirrors send_message). */
  pendingMessageRepo?: PendingAgentMessageRepository;
  /** Fired after a non-deduped enqueue (auto-resume backstop, mirrors send_message). */
  onMessageQueued?: (agentName: string) => void;
}

export interface HandoffExecutionParams {
  fromAgentName: string;
  fromSessionId: string;
  /** Source node id (the sender's node). */
  workflowNodeId: string;
  operation: HandoffOperation;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class HandoffExecutor {
  constructor(private readonly config: HandoffExecutorConfig) {}

  /**
   * Execute a first-class handoff operation. Never throws — every failure path
   * (expected or unexpected) returns a structured `blocked`/`failed` result.
   */
  async execute(params: HandoffExecutionParams): Promise<HandoffExecutionResult> {
    // Tracked across the try/catch so an unexpected throw after a cycle
    // reservation can refund it (a reserved-but-unconsumed cycle must not stick).
    let cycleReserved = false;
    let reservedKey = '';
    let reservedEpoch = 0;

    try {
      return await this.runHandoff(params, (reserved, key, epoch) => {
        cycleReserved = reserved;
        reservedKey = key;
        reservedEpoch = epoch;
      });
    } catch (err) {
      if (cycleReserved) this.refundCycle(this.config.workflowRunId, reservedKey, reservedEpoch);
      const stage = err instanceof HandoffExecutionError ? err.stage : 'unexpected';
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[HandoffExecutor] ${stage} failure: ${message}`);
      return this.failed(stage, `Handoff ${stage} failed: ${message}`);
    }
  }

  private async runHandoff(
    params: HandoffExecutionParams,
    trackReservation: (reserved: boolean, key: string, epoch: number) => void
  ): Promise<HandoffExecutionResult> {
    const { fromAgentName, fromSessionId, workflowNodeId, operation } = params;
    const { workflow, workflowRunId } = this.config;

    // 0. Bound the FINAL delivered body (summary + the pretty-printed data
    //    appendix), not each component separately — otherwise summary and data
    //    could each approach the cap and combine to ~2x it, injecting an
    //    oversized turn into every target session.
    const dataAppendixBody =
      operation.data && Object.keys(operation.data).length > 0
        ? `\n\n<structured-data>\n${JSON.stringify(operation.data, null, 2)}\n</structured-data>`
        : '';
    if (`${operation.summary}${dataAppendixBody}`.length > HANDOFF_PAYLOAD_MAX_CHARS) {
      return this.blocked(
        'resolve_run',
        `Handoff payload too large (limit ${HANDOFF_PAYLOAD_MAX_CHARS} chars).`
      );
    }

    // 1. Validate run state.
    const run = this.config.workflowRunRepo.getRun(workflowRunId);
    if (!run) {
      return this.failed('resolve_run', `Workflow run not found: ${workflowRunId}`);
    }
    if (run.status === 'done' || run.status === 'cancelled') {
      return this.blocked('resolve_run', `Cannot hand off: run is ${run.status}.`);
    }

    // 2. Resolve source node + transition.
    const sourceNode = workflow.nodes.find((n) => n.id === workflowNodeId);
    if (!sourceNode) {
      return this.failed('resolve_source', `Sender node not found: ${workflowNodeId}`);
    }
    const fromNodeName = sourceNode.name;

    // 2b. Bind the sender identity to an ACTIVE node execution before any
    //     transition or hook is resolved/authorized. A stale session that
    //     finishes a tool call after its execution ended — cancelled, or idle
    //     because its round already completed — or a caller supplying a
    //     mismatched (node, agent, session) triple must not transfer ownership
    //     under that node's transition/hook declarations. Only
    //     SENDER_ACTIVE_STATUSES authorize (see its doc).
    const senderExecutionLive = this.readLiveExecutions().some(
      (e) =>
        e.workflowNodeId === workflowNodeId &&
        e.agentName === fromAgentName &&
        e.agentSessionId === fromSessionId &&
        SENDER_ACTIVE_STATUSES.has(e.status as NodeExecutionStatus)
    );
    if (!senderExecutionLive) {
      return this.blocked(
        'resolve_source',
        `No active execution for "${fromAgentName}" (session ${fromSessionId}) on node "${fromNodeName}"; refusing to hand off on its behalf.`
      );
    }
    const resolved = resolveHandoffTransition(sourceNode.transitions, operation.target);
    if (!resolved.ok) {
      return this.blocked(
        'resolve_transition',
        reasonForResolveFailure(resolved.reason, operation.target, fromNodeName)
      );
    }
    const transition = resolved.transition;

    // 3. Resolve target node(s) + agent slot(s) as node-scoped pairs.
    const targets = resolveHandoffTargetSlots(workflow, sourceNode, transition);
    if (targets.pairs.length === 0) {
      return this.blocked(
        'resolve_target',
        `Handoff target "${operation.target}" resolves to no active agent slot.`
      );
    }
    // A self-targeted handoff (transition back to the sender's own node) would
    // queue back into the sender's live session and violate the contract that a
    // handoff ends the current round. The complete-then-reactivate path for
    // self-loops is deferred with the fresh-turn packet work; reject until then.
    if (targets.nodes.includes(fromNodeName)) {
      return this.blocked(
        'resolve_target',
        `Handoff target "${operation.target}" resolves to the sender's own node "${fromNodeName}"; self-targeted handoffs are not supported yet.`
      );
    }

    // 3b. Reject `data` keys the transition does not declare a shape for. The
    //     contract requires data keys to come from the bound hook's template
    //     fields; a transition with no hook accepts NO structured keys, and a
    //     transition WITH a hook only accepts the keys that hook declares (its
    //     `templateData` fields) — the hook's presence is not blanket approval,
    //     so recipients and validators never see undeclared structured fields.
    const dataKeys = operation.data ? Object.keys(operation.data) : [];
    if (dataKeys.length > 0) {
      const boundHook = transition.hookId
        ? (workflow.hooks ?? []).find((h) => h.id === transition.hookId)
        : undefined;
      const declaredFields = new Set(Object.keys(boundHook?.templateData ?? {}));
      const undeclared = dataKeys.filter((key) => !declaredFields.has(key));
      if (undeclared.length > 0) {
        const shape = [...declaredFields].join(', ') || 'none';
        return this.blocked(
          'resolve_target',
          `Transition "${transition.id}" does not declare handoff data field(s): ${undeclared.join(', ')} ` +
            `(declared by hook "${transition.hookId ?? 'none'}": ${shape}).`
        );
      }
    }

    // 4. Authorize the declared channel topology PER CONCRETE TARGET SLOT.
    //    Channels may be addressed by node OR slot name, so each pair must be
    //    reachable via its own slot name OR its containing node — not via a
    //    sibling slot's channel. This stops a node-targeted handoff from
    //    reaching slots whose only channel targets a different sibling.
    const unauthorized = this.unauthorizedTargetSlots(fromNodeName, fromAgentName, targets.pairs);
    if (unauthorized.length > 0) {
      const names = [...new Set(unauthorized.map((p) => `${p.node}/${p.slot}`))].join(', ');
      const resolver = new ChannelResolver(workflow.channels ?? []);
      return this.blocked(
        'authorize_channel',
        `Channel topology does not permit '${fromAgentName}' to hand off to: ${names}. ` +
          `Permitted targets: ${resolver.getPermittedTargets(fromNodeName).join(', ') || 'none'}.`
      );
    }

    // Encode both parts so a literal '/' inside a node/transition id can't
    // collide with the delimiter (transition ids are free-form strings).
    const transitionKey = `${encodeURIComponent(sourceNode.id)}/${encodeURIComponent(transition.id)}`;
    const cyclic = isCyclicHandoff(workflow, fromNodeName, targets.nodes);
    // A cyclic transition is always capped. When the workflow omits `maxCycles`,
    // apply the same default (5) cyclic channels use — otherwise a valid custom
    // workflow could run an unbounded agent loop.
    const maxCycles = cyclic
      ? (transition.maxCycles ?? DEFAULT_HANDOFF_MAX_CYCLES)
      : transition.maxCycles;
    const cycleLimited = cyclic;
    // Epoch captured at reservation time so a refund only undoes THIS
    // reservation (a human-touch reset bumps the epoch, invalidating older ones).
    let reservedEpoch = 0;

    // 5. Reserve a cycle for cyclic transitions BEFORE the hook runs. The
    //    atomic UPSERT both checks the cap and reserves in one step, so two
    //    concurrent handoffs cannot both pass a read-only check and then run
    //    their hook side effects when only one cycle remains — a
    //    side-effect-classified hook script may mutate external state, and it
    //    must never run for a handoff that is guaranteed to be rejected. The
    //    reservation is refunded whenever the handoff isn't taken (hook
    //    block/failure, terminal run recheck, or no delivery), so a blocked or
    //    failed attempt does not consume a cycle.
    if (cycleLimited) {
      let reservation: { reserved: boolean; epoch: number };
      try {
        reservation = this.config.handoffCycleRepo.increment(
          workflowRunId,
          transitionKey,
          maxCycles!
        );
      } catch (err) {
        throw new HandoffExecutionError(
          'cycle_limit',
          `Cycle reservation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (!reservation.reserved) {
        return {
          status: 'blocked',
          stage: 'cycle_limit',
          transition,
          targetNodes: targets.nodes,
          targetSlots: targets.slots,
          delivered: [],
          queued: [],
          reason: `Cyclic handoff "${transition.id}" from "${fromNodeName}" has reached its maxCycles cap (${maxCycles}).`,
        };
      }
      reservedEpoch = reservation.epoch;
      trackReservation(true, transitionKey, reservedEpoch);
    }

    // 6. Execute the transition's hook validator (the sole authorization
    //    primitive now that the legacy gate subsystem is gone). A hook may
    //    block, retryable-block, or allow the handoff; a blocking hook is not
    //    taken, so its cycle reservation is refunded.
    let hookOutcome: HandoffHookOutcome | undefined;
    if (transition.hookId) {
      hookOutcome = await this.runHook({
        sourceNode,
        fromNodeName,
        fromAgentName,
        fromSessionId,
        hookId: transition.hookId,
        targetNodeNames: targets.nodes,
        operation,
      });
      if (hookOutcome.blocks) {
        if (cycleLimited) this.refundCycle(workflowRunId, transitionKey, reservedEpoch);
        trackReservation(false, '', 0);
        return {
          status: 'blocked',
          stage: 'hook',
          transition,
          targetNodes: targets.nodes,
          targetSlots: targets.slots,
          delivered: [],
          queued: [],
          reason:
            ('reason' in hookOutcome.result ? hookOutcome.result.reason : undefined) ??
            `Hook "${transition.hookId}" blocked the handoff.`,
          hook: hookOutcome,
          retryAfterMs:
            hookOutcome.result.type === 'retryable_block'
              ? hookOutcome.result.retryAfterMs
              : undefined,
        };
      }
    }

    // 7. Activate or reuse the target worker session(s) + deliver the peer message.
    //    Re-check run state first: a hook can await an external check for tens
    //    of seconds, and the run may have been cancelled meanwhile. A terminal
    //    run must not receive the handoff (and the cycle reservation is refunded
    //    by the caller's catch/path below).
    const rerun = this.config.workflowRunRepo.getRun(workflowRunId);
    if (rerun && (rerun.status === 'done' || rerun.status === 'cancelled')) {
      if (cycleLimited) this.refundCycle(workflowRunId, transitionKey, reservedEpoch);
      trackReservation(false, '', 0);
      return this.blocked(
        'resolve_run',
        `Cannot hand off: run became ${rerun.status} during validation.`
      );
    }

    const delivery = await this.deliver({
      fromAgentName,
      fromSessionId,
      targets: targets.pairs,
      broadcast: operation.target === HANDOFF_TARGET_WILDCARD,
      summary: operation.summary,
      data: operation.data,
    });

    // 8. Refund the reservation when the handoff was NOT taken. "Taken" means a
    //    NEW delivery or a NEW enqueue this call — a DEDUPED enqueue (same
    //    message already pending from a prior attempt) does not charge a cycle;
    //    the prior attempt already accounted for it. An INCOMPLETE BROADCAST is
    //    not accepted (it fails below), so it is not taken and its reservation
    //    is refunded even though some recipients received a message.
    const reached = delivery.delivered.length + delivery.queued.length + delivery.dedupedCount;
    const broadcastIncomplete =
      operation.target === HANDOFF_TARGET_WILDCARD && reached < targets.slots.length;
    const taken =
      !broadcastIncomplete && (delivery.delivered.length > 0 || delivery.queued.length > 0);
    if (cycleLimited && !taken) {
      this.refundCycle(workflowRunId, transitionKey, reservedEpoch);
    }
    trackReservation(false, '', 0);

    // 8b. Dispatch a follow-up the transition hook emitted (emit_follow_up).
    //     The shared hook engine collects these results and dispatches them;
    //     on the handoff path the follow-up message is delivered directly to
    //     its target node through the SAME delivery machinery (activation /
    //     inject / durable queue), BEFORE a successful result is reported. A
    //     follow-up is a side effect — its failure never gates the handoff —
    //     and it does not re-run transition hooks (depth capped at 1, like the
    //     engine's handler pipeline).
    if (
      taken &&
      hookOutcome &&
      hookOutcome.result.type === 'emit_follow_up' &&
      hookOutcome.result.targetNode &&
      hookOutcome.result.message
    ) {
      await this.dispatchFollowUp({
        fromNodeName,
        fromAgentName,
        fromSessionId,
        targetNode: hookOutcome.result.targetNode,
        message: hookOutcome.result.message,
      });
    }

    // Aggregate the delivery outcome into the handoff status. A delivered
    // handoff (≥1 live session received it) wins over a queued one; queued (new
    // or already-pending deduped) wins over a total delivery failure.
    // A BROADCAST handoff transfers ownership to every other node, so it is
    // only accepted when ALL recipients are reached — a partial broadcast
    // (some recipients unreachable) is a failure even if some delivered.
    if (broadcastIncomplete) {
      return {
        status: 'failed',
        stage: 'deliver',
        transition,
        targetNodes: targets.nodes,
        targetSlots: targets.slots,
        delivered: delivery.delivered,
        queued: delivery.queued,
        reason: `Broadcast handoff reached ${reached}/${targets.slots.length} recipient slot(s); a broadcast requires all recipients to be reachable.`,
        hook: hookOutcome,
      };
    }
    if (delivery.delivered.length > 0) {
      return {
        status: 'delivered',
        stage: 'deliver',
        transition,
        targetNodes: targets.nodes,
        targetSlots: targets.slots,
        delivered: delivery.delivered,
        queued: delivery.queued,
        // Surface partial-delivery diagnostics (e.g. a broadcast target that
        // was unreachable) even on an otherwise-delivered handoff.
        reason: delivery.reason,
        hook: hookOutcome,
      };
    }
    if (delivery.queued.length > 0 || delivery.dedupedCount > 0) {
      return {
        status: 'queued',
        stage: 'deliver',
        transition,
        targetNodes: targets.nodes,
        targetSlots: targets.slots,
        delivered: [],
        queued: delivery.queued,
        reason:
          delivery.queued.length === 0
            ? `Handoff already pending for ${delivery.dedupedCount} target(s); no new cycle charged.`
            : delivery.reason,
        hook: hookOutcome,
      };
    }
    return {
      status: 'failed',
      stage: 'deliver',
      transition,
      targetNodes: targets.nodes,
      targetSlots: targets.slots,
      delivered: [],
      queued: [],
      reason: delivery.reason ?? 'Handoff delivery failed: no live or queueable target.',
      hook: hookOutcome,
    };
  }

  /** Best-effort cycle refund; never throws (logged on failure). */
  private refundCycle(runId: string, transitionKey: string, reservedEpoch: number): void {
    if (!transitionKey) return;
    try {
      this.config.handoffCycleRepo.decrement(runId, transitionKey, reservedEpoch);
    } catch (err) {
      log.warn(
        `[HandoffExecutor] cycle refund failed for "${transitionKey}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Hook validator (the sole authorization primitive; mirrors the validation
  // classification hooks run before send)
  // -------------------------------------------------------------------------

  private async runHook(args: {
    sourceNode: WorkflowNode;
    fromNodeName: string;
    fromAgentName: string;
    fromSessionId: string;
    hookId: string;
    targetNodeNames: string[];
    operation: HandoffOperation;
  }): Promise<HandoffHookOutcome> {
    const {
      sourceNode,
      fromNodeName,
      fromAgentName,
      fromSessionId,
      hookId,
      targetNodeNames,
      operation,
    } = args;
    const hook = (this.config.workflow.hooks ?? []).find((h) => h.id === hookId);
    if (!hook) {
      return {
        hookId,
        result: { type: 'block', reason: `Transition references unknown hook "${hookId}".` },
        blocks: true,
      };
    }
    if (!this.config.hookExecutor) {
      return {
        hookId,
        result: {
          type: 'block',
          reason: `Hook "${hookId}" is bound to this transition but no hook executor is configured.`,
        },
        blocks: true,
      };
    }
    // Enforce the same caller-authorization WorkflowHookEngine applies before
    // invoking a hook: enabled, not human-only, source-node match, optional
    // target-node match, and a matching authorizedCaller entry (empty/absent
    // fails closed). Without this, an agent-triggered transition could run a
    // hook that was not authorized for it.
    const authReason = hookAuthorizationReason(hook, fromNodeName, fromAgentName, targetNodeNames);
    if (authReason) {
      return { hookId, result: { type: 'block', reason: authReason }, blocks: true };
    }

    const context: HookExecutorContext = {
      // Carry the run's actual workspace so hook validators (e.g. pr_ready's
      // `gh`) and script hooks (spawn cwd) resolve the task worktree, not the
      // daemon's cwd.
      workspacePath: this.config.workspacePath ?? '',
      runId: this.config.workflowRunId,
      hookId,
      methodName: 'handoff',
      params: {
        target: operation.target,
        summary: operation.summary,
        data: operation.data ?? {},
        targetNodes: targetNodeNames,
      },
      // Built-in validators read (rawParams ?? params).data — populate rawParams
      // with the full payload (including data) so they see the supplied fields
      // (e.g. pr_url) instead of only the sender identity.
      rawParams: {
        target: operation.target,
        summary: operation.summary,
        data: operation.data ?? {},
        targetNodes: targetNodeNames,
        fromAgentName,
        fromNodeName,
      },
      nodeId: sourceNode.id,
      nodeName: fromNodeName,
      sessionId: fromSessionId,
      taskId: this.config.taskId ?? '',
      // Prefer the hook's own declared targetNode (what the author intended the
      // validator to act on); fall back to the handoff's first target.
      targetNode: hook.targetNode ?? targetNodeNames[0],
      hookLocalState: {},
      // Task phase + frozen reviewed-PR identity — required so phase-gated
      // validators (e.g. pr_ready's post-approval frozen-PR binding) run on the
      // handoff path instead of silently skipping their security check.
      taskStatus: this.config.getTaskStatus?.(),
      frozenPrUrl: this.config.getFrozenPrUrl?.(),
      currentArtifacts: [],
      permittedExternalLookups: [],
      templateData: hook.templateData,
    };

    try {
      const { result } = await this.config.hookExecutor.execute(hook, context);
      // Side-effect hooks don't gate the action (the shared hook engine records
      // their block/retryable_block results without blocking); only validation
      // hooks block the handoff.
      const isSideEffect = (hook.classification ?? 'validation') === 'side_effect';
      const blocks =
        !isSideEffect && (result.type === 'block' || result.type === 'retryable_block');
      return { hookId, result, blocks };
    } catch (err) {
      if (err instanceof HandoffExecutionError) throw err;
      throw new HandoffExecutionError(
        'hook',
        `Hook "${hookId}" execution failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Target activation + peer-message delivery (reuses existing primitives)
  // -------------------------------------------------------------------------

  /**
   * Target pairs the declared channel topology does NOT permit the sender to
   * reach — per concrete target slot (slot name OR containing node), mirroring
   * send_message authorization. Open topology (no channels) permits all.
   */
  private unauthorizedTargetSlots(
    fromNodeName: string,
    fromAgentName: string,
    pairs: HandoffTargetSlot[]
  ): HandoffTargetSlot[] {
    const resolver = new ChannelResolver(this.config.workflow.channels ?? []);
    if (resolver.isEmpty()) return [];
    const fromAliases = [fromNodeName, fromAgentName];
    return pairs.filter(
      ({ slot, node }) =>
        !fromAliases.some((from) => resolver.canSend(from, slot) || resolver.canSend(from, node))
    );
  }

  /**
   * Best-effort delivery of an `emit_follow_up` result from a transition
   * hook: resolve the hook's target node to its agent slots and run them
   * through the same {@link deliver} pipeline the handoff itself uses
   * (activation / inject / durable queue). Never throws and never blocks the
   * handoff — a follow-up is a side effect (mirrors the shared hook engine,
   * where follow-ups don't gate the action that emitted them).
   */
  private async dispatchFollowUp(args: {
    fromNodeName: string;
    fromAgentName: string;
    fromSessionId: string;
    targetNode: string;
    message: string;
  }): Promise<void> {
    const { fromNodeName, fromAgentName, fromSessionId, targetNode, message } = args;
    try {
      const node = this.config.workflow.nodes.find(
        (n) => n.name === targetNode || n.id === targetNode
      );
      if (!node) {
        log.warn(
          `[HandoffExecutor] follow-up target node "${targetNode}" not found; dropping follow-up.`
        );
        return;
      }
      const slots = safeResolveAgents(node);
      if (slots.length === 0) return;
      const pairs = slots.map((slot) => ({ slot: slot.name, node: node.name }));
      // Follow-ups go through the SAME per-slot channel authorization as the
      // handoff itself — a hook must not bypass the declared messaging
      // topology to reach a node the sender cannot message (the shared hook
      // engine dispatches follow-ups through the authorized send path).
      const authorized = pairs.filter(
        (pair) => this.unauthorizedTargetSlots(fromNodeName, fromAgentName, [pair]).length === 0
      );
      const dropped = pairs.length - authorized.length;
      if (dropped > 0) {
        log.warn(
          `[HandoffExecutor] dropping ${dropped} follow-up target slot(s) on "${targetNode}" not permitted by channel topology.`
        );
      }
      if (authorized.length === 0) return;
      const outcome = await this.deliver({
        fromAgentName,
        fromSessionId,
        targets: authorized,
        broadcast: false,
        summary: message,
      });
      const reached = outcome.delivered.length + outcome.queued.length;
      if (reached === 0) {
        log.warn(
          `[HandoffExecutor] follow-up to "${targetNode}" reached no live or queueable target: ${outcome.reason ?? 'unknown reason'}`
        );
      }
    } catch (err) {
      log.warn(
        `[HandoffExecutor] follow-up dispatch to "${targetNode}" failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async deliver(args: {
    fromAgentName: string;
    fromSessionId: string;
    targets: HandoffTargetSlot[];
    broadcast: boolean;
    summary: string;
    data?: Record<string, unknown>;
  }): Promise<{
    delivered: Array<{ agentName: string; sessionId: string }>;
    queued: Array<{ agentName: string; messageId: string }>;
    dedupedCount: number;
    reason?: string;
  }> {
    const { fromAgentName, fromSessionId, targets, broadcast, summary, data } = args;
    const { workflowRunId, spaceId, taskId, taskNumber } = this.config;
    const dataAppendix =
      data && Object.keys(data).length > 0
        ? `\n\n<structured-data>\n${JSON.stringify(data, null, 2)}\n</structured-data>`
        : '';
    const envelope = () =>
      formatAgentMessage({
        fromLevel: 'node-agent',
        fromAgentName,
        toLevel: 'node-agent',
        body: `${summary}${dataAppendix}`,
        taskId,
        taskNumber,
        nodeId: fromAgentName,
      });

    const nodeNameToId = new Map(this.config.workflow.nodes.map((n) => [n.name, n.id]));
    let executions = this.readLiveExecutions();
    // Node-scoped live-session lookup: match the slot AND its containing node,
    // so a shared slot name in two nodes isn't confused between them.
    const sessionsFor = (slot: string, nodeName: string) => {
      const nodeId = nodeNameToId.get(nodeName);
      return executions.filter(
        (e) =>
          e.agentName === slot &&
          (nodeId === undefined || e.workflowNodeId === nodeId) &&
          // Select any execution with a non-null agentSessionId, like
          // send_message — but exclude `cancelled` AND `pending`: a cancelled
          // execution retains a dead, non-null agentSessionId, and a
          // spawn-retry `pending` row can too (the production session lookup in
          // task-agent-manager.ts excludes both for the same reason). Selecting
          // either would inject into a dead session instead of letting
          // activation spawn a replacement. `waiting_rebind` (orphaned-tool-
          // result recovery) and `idle` keep LIVE sessions and are admitted.
          e.agentSessionId &&
          e.agentSessionId !== fromSessionId &&
          e.status !== 'cancelled' &&
          e.status !== 'pending'
      );
    };
    const repo = this.config.pendingMessageRepo;
    const queueable = !!(repo && spaceId);

    // Broadcast atomicity: every recipient must have a durable delivery path
    // (a live session OR a queue) BEFORE any recipient is exposed to the
    // handoff. Otherwise a reachable recipient could start acting as owner
    // while the sender sees a failure and retries, producing duplicate work.
    if (broadcast) {
      const unreachable = targets.filter(
        ({ slot, node }) => sessionsFor(slot, node).length === 0 && !queueable
      );
      if (unreachable.length > 0) {
        return {
          delivered: [],
          queued: [],
          dedupedCount: 0,
          reason: `Broadcast requires all ${targets.length} recipient(s) reachable; not reachable: ${unreachable.map((p) => `${p.node}/${p.slot}`).join(', ')}.`,
        };
      }
    }

    const delivered: Array<{ agentName: string; sessionId: string }> = [];
    const queued: Array<{ agentName: string; messageId: string }> = [];
    let dedupedCount = 0;
    const notFound: string[] = [];

    for (const { slot, node } of targets) {
      // Activate the target worker session (reuse if already live). This is the
      // SAME activation primitive send_message uses; it is intentionally
      // separate from hook validation. The resolved node id scopes activation:
      // a valid workflow may reuse a slot name across nodes, and activation by
      // agent name alone could select the sibling node's identically named slot.
      const nodeId = nodeNameToId.get(node);
      let sessions = sessionsFor(slot, node).map((e) => ({ sessionId: e.agentSessionId! }));
      if (sessions.length === 0 && this.config.activateTargetSession) {
        try {
          const activated = await this.config.activateTargetSession(slot, nodeId);
          executions = this.readLiveExecutions();
          sessions = sessionsFor(slot, node).map((e) => ({ sessionId: e.agentSessionId! }));
          // send_message parity: merge sessions the callback reports as live
          // even when their node_executions row is not yet observable — a
          // just-activated target must be injected, not needlessly queued or
          // reported failed. Dedupe against the reread so a row that IS
          // observable isn't injected twice, and REJECT a reported session
          // whose observable row belongs to a different node: activation is
          // scoped to `nodeId` above, so a sibling-node row means the callback
          // resolved by agent name and must not receive this node's handoff.
          const seen = new Set(sessions.map((s) => s.sessionId));
          const nodeBySession = new Map(
            executions
              .filter((e) => e.agentSessionId)
              .map((e) => [e.agentSessionId!, e.workflowNodeId] as const)
          );
          for (const s of activated) {
            if (!s.sessionId || s.agentName !== slot || s.sessionId === fromSessionId) continue;
            const observedNode = nodeBySession.get(s.sessionId);
            if (nodeId !== undefined && observedNode !== undefined && observedNode !== nodeId) {
              log.warn(
                `[HandoffExecutor] activation returned session ${s.sessionId} for "${slot}" on node ${observedNode}; expected node ${nodeId} — skipping.`
              );
              continue;
            }
            if (!seen.has(s.sessionId)) {
              seen.add(s.sessionId);
              sessions.push({ sessionId: s.sessionId });
            }
          }
        } catch (err) {
          log.warn(
            `[HandoffExecutor] failed to activate target "${slot}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (sessions.length > 0) {
        const message = envelope();
        for (const session of sessions) {
          try {
            await this.config.messageInjector(session.sessionId, message);
            delivered.push({ agentName: slot, sessionId: session.sessionId });
          } catch (err) {
            log.warn(
              `[HandoffExecutor] inject failed for "${slot}": ${err instanceof Error ? err.message : String(err)}`
            );
            notFound.push(slot);
          }
        }
        continue;
      }

      // No live session — queue for later delivery if a persistent queue is
      // configured (mirrors send_message's declared-but-inactive path). A
      // DEDUPED enqueue (same message already pending from a prior attempt) is
      // tracked separately: the message is still queued (status), but it does
      // NOT count as a newly-taken handoff for cycle accounting — the prior
      // attempt already charged (or refunded) the cycle.
      if (repo) {
        const rawMessage = envelope();
        try {
          const { record, deduped } = repo.enqueue({
            workflowRunId,
            spaceId,
            taskId: taskId ?? null,
            sourceAgentName: fromAgentName,
            targetKind: 'node_agent',
            targetAgentName: slot,
            // Persist the resolved destination node so the queued row is
            // node-scoped: flushPendingMessagesForTarget treats a null node as
            // legacy and drains it for ANY same-named slot, which would let a
            // sibling slot in another node consume this node's handoff.
            workflowNodeId: nodeNameToId.get(node) ?? null,
            message: rawMessage,
            idempotencyKey: JSON.stringify([fromSessionId, node, slot, rawMessage]),
            // A formal handoff transfers ownership; a queued handoff must survive
            // slow target activation (daemon restart, startup backlog, provider-
            // cap delay) — not expire after the 60s message default, which would
            // lose the handoff after the sender's round is already complete.
            ttlMs: HANDOFF_QUEUE_TTL_MS,
            maxAttempts: 3,
          });
          if (deduped) {
            dedupedCount += 1;
          } else {
            queued.push({ agentName: slot, messageId: record.id });
            this.config.onMessageQueued?.(slot);
          }
        } catch (err) {
          log.warn(
            `[HandoffExecutor] failed to queue for "${slot}": ${err instanceof Error ? err.message : String(err)}`
          );
          notFound.push(slot);
        }
      } else {
        notFound.push(slot);
      }
    }

    const reason =
      notFound.length > 0 && delivered.length === 0 && queued.length === 0
        ? `Could not deliver handoff to: ${notFound.join(', ')}.`
        : notFound.length > 0
          ? `Partial delivery — not reachable: ${notFound.join(', ')}.`
          : undefined;
    return { delivered, queued, dedupedCount, reason };
  }

  /**
   * Read the run's node executions, wrapping the DB read so a failure maps to a
   * structured `failed` result (via {@link HandoffExecutionError}) rather than
   * escaping execute().
   */
  private readLiveExecutions() {
    try {
      return this.config.nodeExecutionRepo.listByWorkflowRun(this.config.workflowRunId);
    } catch (err) {
      if (err instanceof HandoffExecutionError) throw err;
      throw new HandoffExecutionError(
        'deliver',
        `Target session lookup failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private blocked(stage: HandoffStage, reason: string): HandoffExecutionResult {
    return {
      status: 'blocked',
      stage,
      targetNodes: [],
      targetSlots: [],
      delivered: [],
      queued: [],
      reason,
    };
  }

  private failed(stage: HandoffStage, reason: string): HandoffExecutionResult {
    return {
      status: 'failed',
      stage,
      targetNodes: [],
      targetSlots: [],
      delivered: [],
      queued: [],
      reason,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A concrete handoff destination: an agent slot within a specific node. */
export interface HandoffTargetSlot {
  slot: string;
  node: string;
}

/**
 * Resolve a transition's target to concrete node-scoped `{slot, node}` pairs
 * the runtime must authorize, activate, and deliver to.
 *
 * - `'*'` (broadcast) → every slot in every node except the sender's.
 * - node name → every slot in that node.
 * - agent slot name → the (unique) node declaring that slot, just that slot.
 *
 * Returning pairs (not parallel arrays) keeps each slot bound to its node, so
 * authorization and delivery are per-slot and node-scoped — a sibling slot in
 * the same node isn't authorized or reached by a channel that targets only one
 * slot, and a shared slot name across two nodes isn't confused between them.
 */
export function resolveHandoffTargetSlots(
  workflow: SpaceWorkflow,
  sourceNode: WorkflowNode,
  transition: HandoffTransition
): { pairs: HandoffTargetSlot[]; nodes: string[]; slots: string[] } {
  const allNodeNames = workflow.nodes.map((n) => n.name);
  const slotToNode = buildSlotToNodeMap(workflow);
  const seenNodes = new Set<string>();
  const pairs: HandoffTargetSlot[] = [];
  const add = (slot: string, node: string) => {
    pairs.push({ slot, node });
    seenNodes.add(node);
  };

  if (transition.target === HANDOFF_TARGET_WILDCARD) {
    for (const node of workflow.nodes) {
      if (node.id === sourceNode.id) continue; // broadcast excludes the sender
      for (const agent of safeResolveAgents(node)) add(agent.name, node.name);
    }
  } else if (allNodeNames.includes(transition.target)) {
    // Node-name target → every slot in the node.
    const node = workflow.nodes.find((n) => n.name === transition.target)!;
    for (const agent of safeResolveAgents(node)) add(agent.name, node.name);
  } else {
    // Agent-slot target → the single node declaring that slot.
    const nodeName = slotToNode.get(transition.target);
    if (nodeName) add(transition.target, nodeName);
  }

  return { pairs, nodes: [...seenNodes], slots: pairs.map((p) => p.slot) };
}

/**
 * Whether taking `transition` (from `fromNodeName` toward `targetNodeNames`)
 * closes a loop in the control-flow graph — i.e. it hands ownership BACKWARD
 * (to an earlier-or-equal node in the `nodes` array, the same topological
 * order `isChannelCyclic` uses) and the target can reach the source via
 * directed HANDOFF TRANSITION edges (messaging channels are excluded; see
 * {@link buildNodeGraph}). Forward edges are never cyclic. Cyclicity is
 * inferred from topology at runtime (not stored); only cyclic transitions are
 * subject to `maxCycles`.
 */
export function isCyclicHandoff(
  workflow: SpaceWorkflow,
  fromNodeName: string,
  targetNodeNames: string[]
): boolean {
  const allNodeNames = new Set(workflow.nodes.map((n) => n.name));
  const adjacency = buildNodeGraph(workflow, allNodeNames);
  const canReach = (start: string, goal: string): boolean => {
    if (start === goal) return true;
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const next of adjacency.get(current) ?? []) {
        if (next === goal) return true;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  };
  // Node order convention (same as `isChannelCyclic`): position in the
  // `nodes` array is topological order. A handoff is cyclic only when it
  // moves ownership BACKWARD (to an earlier-or-equal node) and the target
  // can route back to the source via transition edges. A FORWARD edge is
  // never cyclic, even when a back-edge exists elsewhere in the loop —
  // otherwise A→B in A→B→A would be capped at the default while the
  // back-edge B→A (the edge that actually loops) carries the configured
  // maxCycles.
  const order = new Map(workflow.nodes.map((n, index) => [n.name, index] as const));
  const fromOrder = order.get(fromNodeName) ?? Number.MAX_SAFE_INTEGER;
  return targetNodeNames.some((target) => {
    if (target === fromNodeName) return true; // self-loop
    const toOrder = order.get(target) ?? Number.MAX_SAFE_INTEGER;
    if (toOrder > fromOrder) return false; // forward edge — never cyclic
    return canReach(target, fromNodeName);
  });
}

/**
 * Build node-name → node-name directed CONTROL-FLOW edges from handoff
 * transitions only. Messaging channels (`WorkflowChannel`) are deliberately
 * excluded: a discussion channel B→A must not make a forward transition A→B
 * look cyclic, since ownership can only return to A through another handoff
 * transition, not a peer message.
 */
function buildNodeGraph(
  workflow: SpaceWorkflow,
  allNodeNames: Set<string>
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    if (!allNodeNames.has(from) || !allNodeNames.has(to)) return;
    const set = adjacency.get(from) ?? new Set<string>();
    set.add(to);
    adjacency.set(from, set);
  };

  const slotToNode = buildSlotToNodeMap(workflow);
  const resolveTargetNodes = (target: string): string[] => {
    if (target === HANDOFF_TARGET_WILDCARD) return [...allNodeNames];
    if (allNodeNames.has(target)) return [target];
    const node = slotToNode.get(target);
    return node ? [node] : [];
  };

  for (const node of workflow.nodes) {
    for (const transition of node.transitions ?? []) {
      for (const to of resolveTargetNodes(transition.target)) {
        addEdge(node.name, to);
      }
    }
  }

  return adjacency;
}

function buildSlotToNodeMap(workflow: SpaceWorkflow): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of workflow.nodes) {
    for (const agent of safeResolveAgents(node)) {
      // First-declared node wins (validation rejects ambiguous slot names, so a
      // validated workflow never has a slot in two nodes).
      if (!map.has(agent.name)) map.set(agent.name, node.name);
    }
  }
  return map;
}

function safeResolveAgents(node: WorkflowNode): { name: string }[] {
  try {
    return resolveNodeAgents(node).map((a) => ({ name: a.name }));
  } catch {
    return [];
  }
}

/**
 * Caller-authorization for a transition-bound hook, mirroring the checks
 * `WorkflowHookEngine` applies: enabled, not human-only, source-node match,
 * optional target-node match, and a matching `authorizedCallers` entry (empty/
 * absent fails closed). Returns a block reason when unauthorized, else undefined.
 */
function hookAuthorizationReason(
  hook: WorkflowHook,
  fromNodeName: string,
  fromAgentName: string,
  targetNodeNames: string[]
): string | undefined {
  if (!hook.enabled) return `Hook "${hook.id}" is disabled.`;
  if (hook.humanOnly) {
    return `Hook "${hook.id}" is human-only and cannot run from an agent handoff.`;
  }
  if (hook.sourceNode !== fromNodeName) {
    return `Hook "${hook.id}" sourceNode "${hook.sourceNode}" does not match handoff source "${fromNodeName}".`;
  }
  if (hook.targetNode && !targetNodeNames.includes(hook.targetNode)) {
    return `Hook "${hook.id}" targetNode "${hook.targetNode}" is not a target of this handoff.`;
  }
  if (!hook.authorizedCallers || hook.authorizedCallers.length === 0) {
    return `Hook "${hook.id}" has no authorizedCallers; agent handoffs fail closed.`;
  }
  const allowed = hook.authorizedCallers.some((caller) => {
    if (caller.sourceNode !== fromNodeName) return false;
    if (!caller.agentSlots || caller.agentSlots.length === 0) return true;
    return caller.agentSlots.includes(fromAgentName);
  });
  if (!allowed) {
    return `Agent "${fromAgentName}" is not an authorized caller for hook "${hook.id}".`;
  }
  return undefined;
}

function reasonForResolveFailure(
  reason: 'no_transitions' | 'unknown_target' | 'ambiguous',
  target: string,
  fromNodeName: string
): string {
  switch (reason) {
    case 'no_transitions':
      return `Node "${fromNodeName}" declares no outbound handoff transitions.`;
    case 'unknown_target':
      return `No outbound handoff transition on "${fromNodeName}" targets "${target}".`;
    case 'ambiguous':
      return `Handoff target "${target}" is ambiguous on "${fromNodeName}".`;
  }
}
