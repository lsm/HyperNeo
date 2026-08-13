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
 *   3. Resolve target node/slot PAIRS from the transition target, carrying the
 *      node id so delivery is node-scoped (a shared slot name across nodes can't
 *      leak — see {@link resolveHandoffTargets}).
 *   4. Authorize the declared channel topology (`ChannelResolver`) — when channels
 *      are declared, the source→target delivery must be permitted, mirroring
 *      `send_message`. Open topology (no channels) permits all handoffs.
 *   5. Enforce cyclic transition `maxCycles` (`HandoffCycleRepository`).
 *   6. Execute the transition's declared hook validator through
 *      `WorkflowHookEngine.runDeclaredHook` (NOT `HookExecutor` directly), so the
 *      validator gets the SAME rich context (taskStatus / frozenPrUrl /
 *      hookLocalState / permittedExternalLookups / artifacts / templateData) and
 *      patch_params / pr_ready-identity handling as a send_message hook. A
 *      successful `patch_params` (e.g. pr_ready discovering `data.pr_url`) is
 *      applied to the payload before delivery.
 *   7. Activate or reuse the target worker session (`activateTargetSession`,
 *      node-scoped) and deliver the existing peer-message shape
 *      (`formatAgentMessage`), queueing (node-scoped) when the target session is
 *      not yet live.
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
  SpaceWorkflow,
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
import type { HookActionMeta, HookActionOutcome, WorkflowHookEngine } from './workflow-hook-engine';

const log = new Logger('handoff-executor');

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
  | 'gate'
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
   * The run's workspace path (the task worktree). Passed into the hook engine
   * so hook validators/script hooks resolve the correct repository (built-ins
   * like `pr_ready` run `gh` here; script hooks use it as spawn cwd).
   */
  workspacePath?: string;

  /**
   * Workflow hook engine. A transition that binds a hookId is validated through
   * this engine (runDeclaredHook) rather than HookExecutor directly, so the
   * transition's validator gets the SAME rich context (taskStatus / frozenPrUrl
   * / hookLocalState / permittedExternalLookups / artifacts / templateData) and
   * patch_params / pr_ready-identity handling as a send_message hook.
   */
  hookEngine?: WorkflowHookEngine;

  /** node name → agent slot names (fan-out / slot→node resolution). */
  nodeGroups?: Record<string, string[]>;
  /** node id → node name (peer nodeName hydration after activation). */
  workflowNodeNameById?: Record<string, string>;

  /**
   * Existing target-activation callback (the SAME primitive send_message uses).
   * Carries the resolved target node id so activation, lookup, and enqueue can
   * be scoped by node — a shared slot name across two nodes must not leak.
   */
  activateTargetSession?: (
    agentName: string,
    workflowNodeId?: string
  ) => Promise<Array<{ agentName: string; sessionId: string }>>;
  /** Injects the peer-message envelope into a live target session. */
  messageInjector: (sessionId: string, message: string) => Promise<void>;
  /** Persistent queue for declared-but-inactive targets (mirrors send_message). */
  pendingMessageRepo?: PendingAgentMessageRepository;
  /**
   * Fired after a non-deduped enqueue (auto-resume backstop, mirrors
   * send_message). Carries the resolved node id so the resume/activation is
   * node-scoped (a shared slot name across nodes must not resume the wrong one).
   */
  onMessageQueued?: (agentName: string, workflowNodeId?: string) => void;
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

    try {
      return await this.runHandoff(params, (reserved, key) => {
        cycleReserved = reserved;
        reservedKey = key;
      });
    } catch (err) {
      if (cycleReserved) this.refundCycle(this.config.workflowRunId, reservedKey);
      const stage = err instanceof HandoffExecutionError ? err.stage : 'unexpected';
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[HandoffExecutor] ${stage} failure: ${message}`);
      return this.failed(stage, `Handoff ${stage} failed: ${message}`);
    }
  }

  private async runHandoff(
    params: HandoffExecutionParams,
    trackReservation: (reserved: boolean, key: string) => void
  ): Promise<HandoffExecutionResult> {
    const { fromAgentName, fromSessionId, workflowNodeId, operation } = params;
    const { workflow, workflowRunId } = this.config;

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
    const resolved = resolveHandoffTransition(sourceNode.transitions, operation.target);
    if (!resolved.ok) {
      return this.blocked(
        'resolve_transition',
        reasonForResolveFailure(resolved.reason, operation.target, fromNodeName)
      );
    }
    const transition = resolved.transition;

    // 3. Resolve target node(s) + agent slot(s) as node/slot PAIRS. Carrying
    //    the resolved node id through delivery scopes activation, live-session
    //    lookup, and enqueue by node so a shared slot name across two nodes
    //    can't leak — a handoff to one node must not deliver to (or be drained
    //    by) the same-named slot in another node.
    const targets = resolveHandoffTargets(workflow, sourceNode, transition);
    if (targets.length === 0) {
      return this.blocked(
        'resolve_target',
        `Handoff target "${operation.target}" resolves to no active agent slot.`
      );
    }
    const targetNodeNames = uniqueStrings(targets.map((t) => t.nodeName));
    const targetSlots = targets.map((t) => t.slot);
    // A self-targeted handoff (transition back to the sender's own node) would
    // queue back into the sender's live session and violate the contract that a
    // handoff ends the current round. The complete-then-reactivate path for
    // self-loops is deferred with the fresh-turn packet work; reject until then.
    if (targetNodeNames.includes(fromNodeName)) {
      return this.blocked(
        'resolve_target',
        `Handoff target "${operation.target}" resolves to the sender's own node "${fromNodeName}"; self-targeted handoffs are not supported yet.`
      );
    }

    // 3b. Reject `data` keys the transition does not declare a shape for. The
    //     contract requires data keys to come from the bound hook's template
    //     fields; a transition with no hook accepts NO structured keys.
    const dataKeys = operation.data ? Object.keys(operation.data) : [];
    if (dataKeys.length > 0 && !transition.hookId) {
      return this.blocked(
        'resolve_target',
        `Transition "${transition.id}" declares no hook, so it accepts no handoff data keys (got: ${dataKeys.join(', ')}).`
      );
    }

    // 4. Authorize the declared channel topology (when declared).
    const resolver = new ChannelResolver(workflow.channels ?? []);
    if (!resolver.isEmpty()) {
      const unauthorized = targetNodeNames.filter(
        (nodeName) => !resolver.canSend(fromNodeName, nodeName)
      );
      if (unauthorized.length > 0) {
        return this.blocked(
          'authorize_channel',
          `Channel topology does not permit '${fromAgentName}' to hand off to: ${unauthorized.join(', ')}. ` +
            `Permitted targets: ${resolver.getPermittedTargets(fromNodeName).join(', ') || 'none'}.`
        );
      }
    }

    // Encode both parts so a literal '/' inside a node/transition id can't
    // collide with the delimiter (transition ids are free-form strings).
    const transitionKey = `${encodeURIComponent(sourceNode.id)}/${encodeURIComponent(transition.id)}`;
    const cyclic = isCyclicHandoff(workflow, fromNodeName, targetNodeNames);
    const maxCycles = transition.maxCycles;
    const cycleLimited = cyclic && typeof maxCycles === 'number' && maxCycles > 0;

    // 4b. Read-only cycle cap check BEFORE the hook side effect. A cyclic
    //     transition already at its cap must not run its hook validator on a
    //     guaranteed-to-fail retry. The atomic reservation still happens right
    //     before delivery (step 6) to close the TOCTOU.
    if (
      cycleLimited &&
      this.config.handoffCycleRepo.isCapReached(workflowRunId, transitionKey, maxCycles!)
    ) {
      return {
        status: 'blocked',
        stage: 'cycle_limit',
        transition,
        targetNodes: targetNodeNames,
        targetSlots,
        delivered: [],
        queued: [],
        reason: `Cyclic handoff "${transition.id}" from "${fromNodeName}" has reached its maxCycles cap (${maxCycles}).`,
      };
    }

    // 5. Execute the transition's hook validator through WorkflowHookEngine
    //    (the sole authorization primitive now that the legacy gate subsystem
    //    is gone). A hook may block, retryable-block, allow, or patch the
    //    payload (e.g. pr_ready discovers data.pr_url); a successful patch is
    //    applied to the payload before delivery.
    let hookOutcome: HandoffHookOutcome | undefined;
    let deliveredOperation = operation;
    if (transition.hookId) {
      const hookRun = await this.runHook({
        sourceNode,
        fromAgentName,
        fromSessionId,
        hookId: transition.hookId,
        targetNodeNames,
        operation,
      });
      hookOutcome = hookRun.outcome;
      deliveredOperation = hookRun.patchedOperation;
      const resultType = hookOutcome.result.type;
      if (resultType === 'block' || resultType === 'retryable_block') {
        return {
          status: 'blocked',
          stage: 'hook',
          transition,
          targetNodes: targetNodeNames,
          targetSlots,
          delivered: [],
          queued: [],
          reason: hookOutcome.result.reason ?? `Hook "${transition.hookId}" blocked the handoff.`,
          hook: hookOutcome,
          retryAfterMs:
            resultType === 'retryable_block' ? hookOutcome.result.retryAfterMs : undefined,
        };
      }
    }

    // 7. Reserve a cycle for cyclic transitions BEFORE delivery. The atomic
    //    UPSERT both checks the cap and reserves in one step, closing the
    //    check-then-increment race two concurrent handoffs would otherwise have.
    //    If delivery ultimately reaches no live or queueable target, the
    //    reservation is refunded (step 9) so a failed attempt does not consume a
    //    cycle — leaving the cap for the attempt that succeeds once the target
    //    wakes up.
    if (cycleLimited) {
      let reserved: boolean;
      try {
        reserved = this.config.handoffCycleRepo.increment(workflowRunId, transitionKey, maxCycles!);
      } catch (err) {
        throw new HandoffExecutionError(
          'cycle_limit',
          `Cycle reservation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (!reserved) {
        return {
          status: 'blocked',
          stage: 'cycle_limit',
          transition,
          targetNodes: targetNodeNames,
          targetSlots,
          delivered: [],
          queued: [],
          reason: `Cyclic handoff "${transition.id}" from "${fromNodeName}" has reached its maxCycles cap (${maxCycles}).`,
          hook: hookOutcome,
        };
      }
      trackReservation(true, transitionKey);
    }

    // 6. Activate or reuse the target worker session(s) + deliver the peer message.
    //    Re-check run state first: a hook can await an external check for tens
    //    of seconds, and the run may have been cancelled meanwhile. A terminal
    //    run must not receive the handoff (and the cycle reservation is refunded
    //    by the caller's catch/path below).
    const rerun = this.config.workflowRunRepo.getRun(workflowRunId);
    if (rerun && (rerun.status === 'done' || rerun.status === 'cancelled')) {
      if (cycleLimited) this.refundCycle(workflowRunId, transitionKey);
      trackReservation(false, '');
      return this.blocked(
        'resolve_run',
        `Cannot hand off: run became ${rerun.status} during validation.`
      );
    }

    const delivery = await this.deliver({
      fromAgentName,
      fromSessionId,
      targets,
      summary: deliveredOperation.summary,
      data: deliveredOperation.data,
    });

    // 9. Refund the reservation when the handoff was NOT taken. "Taken" means a
    //    NEW delivery or a NEW enqueue this call — a DEDUPED enqueue (same
    //    message already pending from a prior attempt) does not charge a cycle;
    //    the prior attempt already accounted for it.
    const taken = delivery.delivered.length > 0 || delivery.queued.length > 0;
    if (cycleLimited && !taken) {
      this.refundCycle(workflowRunId, transitionKey);
    }
    trackReservation(false, '');

    // Aggregate the delivery outcome into the handoff status. A delivered
    // handoff (≥1 live session received it) wins over a queued one; queued (new
    // or already-pending deduped) wins over a total delivery failure.
    if (delivery.delivered.length > 0) {
      return {
        status: 'delivered',
        stage: 'deliver',
        transition,
        targetNodes: targetNodeNames,
        targetSlots,
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
        targetNodes: targetNodeNames,
        targetSlots,
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
      targetNodes: targetNodeNames,
      targetSlots,
      delivered: [],
      queued: [],
      reason: delivery.reason ?? 'Handoff delivery failed: no live or queueable target.',
      hook: hookOutcome,
    };
  }

  /** Best-effort cycle refund; never throws (logged on failure). */
  private refundCycle(runId: string, transitionKey: string): void {
    if (!transitionKey) return;
    try {
      this.config.handoffCycleRepo.decrement(runId, transitionKey);
    } catch (err) {
      log.warn(
        `[HandoffExecutor] cycle refund failed for "${transitionKey}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Hook validator — routed through WorkflowHookEngine so the transition's
  // declared validator gets the SAME context + patch_params / pr_ready-identity
  // / connector-auth handling as a send_message hook (not HookExecutor direct).
  // -------------------------------------------------------------------------

  private async runHook(args: {
    sourceNode: WorkflowNode;
    fromAgentName: string;
    fromSessionId: string;
    hookId: string;
    targetNodeNames: string[];
    operation: HandoffOperation;
  }): Promise<{ outcome: HandoffHookOutcome; patchedOperation: HandoffOperation }> {
    const { sourceNode, fromAgentName, fromSessionId, hookId, targetNodeNames, operation } = args;
    if (!this.config.hookEngine) {
      return {
        outcome: {
          hookId,
          result: {
            type: 'block',
            reason: `Hook "${hookId}" is bound to this transition but no hook engine is configured.`,
          },
        },
        patchedOperation: operation,
      };
    }

    const meta: HookActionMeta = {
      sessionId: fromSessionId,
      agentName: fromAgentName,
      nodeId: sourceNode.id,
      taskId: this.config.taskId ?? '',
      targetNode: targetNodeNames[0],
    };
    // The engine builds the full validator context (workspacePath, taskStatus,
    // frozenPrUrl, hookLocalState, currentArtifacts, permittedExternalLookups,
    // templateData), authorizes the declared hook, applies any patch_params,
    // stamps the pr_ready frozen identity, and returns the reduced outcome.
    const params = {
      target: operation.target,
      summary: operation.summary,
      data: operation.data ?? {},
      targetNodes: targetNodeNames,
      // Built-in validators read (rawParams ?? params).data — carry the sender
      // identity under rawParams-only keys so a pr_ready / post_approval_only
      // validator sees both the payload (data.pr_url) and who is handshaking.
      fromAgentName,
      fromNodeName: sourceNode.name,
    };

    let hookOutcome: HookActionOutcome;
    try {
      hookOutcome = await this.config.hookEngine.runDeclaredHook(hookId, 'handoff', params, meta);
    } catch (err) {
      if (err instanceof HandoffExecutionError) throw err;
      throw new HandoffExecutionError(
        'hook',
        `Hook "${hookId}" execution failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Persist hook state + last-result (retry counters, pr_ready identity) —
    // runDeclaredHook runs outside the MCP wrapper, so the executor owns the
    // post-action persist the wrapper normally performs.
    this.config.hookEngine.persistHookOutcome(hookOutcome);

    const result: WorkflowHookResult =
      hookOutcome.executionLog[0]?.result ??
      ({ type: 'block', reason: `Hook "${hookId}" produced no result.` } as WorkflowHookResult);

    // Apply a successful patch to the handoff payload before delivery. pr_ready
    // returns patch_params when it discovers the PR (the sender omitted
    // data.pr_url); the engine merged the patch into finalParams, preserving
    // the sender's other data keys (extractDataRecord) and adding pr_url. The
    // engine strips any `target` patch, so finalParams.target is unchanged.
    const fp = hookOutcome.finalParams;
    const mergedData = isRecord(fp.data) ? { ...operation.data, ...fp.data } : operation.data;
    const patchedOperation: HandoffOperation = {
      target: typeof fp.target === 'string' ? fp.target : operation.target,
      summary: typeof fp.summary === 'string' ? fp.summary : operation.summary,
      data: mergedData,
    };

    return { outcome: { hookId, result }, patchedOperation };
  }

  // -------------------------------------------------------------------------
  // Target activation + peer-message delivery (reuses existing primitives)
  // -------------------------------------------------------------------------

  private async deliver(args: {
    fromAgentName: string;
    fromSessionId: string;
    /** Resolved node/slot pairs — delivery is scoped by node id (see runHandoff). */
    targets: HandoffTarget[];
    summary: string;
    data?: Record<string, unknown>;
  }): Promise<{
    delivered: Array<{ agentName: string; sessionId: string }>;
    queued: Array<{ agentName: string; messageId: string }>;
    dedupedCount: number;
    reason?: string;
  }> {
    const { fromAgentName, fromSessionId, targets, summary, data } = args;
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

    const delivered: Array<{ agentName: string; sessionId: string }> = [];
    const queued: Array<{ agentName: string; messageId: string }> = [];
    let dedupedCount = 0;
    const notFound: string[] = [];

    // Hoist the execution read: listByWorkflowRun once up front, then once more
    // only after an activation actually spawns a session (avoids the per-target
    // N+1 a per-call read would cause in the broadcast loop).
    let executions = this.readLiveExecutions();
    // Match a target by BOTH slot name AND resolved node id, so two nodes that
    // reuse a slot name don't select each other's live session. Without the
    // node-id filter, a handoff to node A's "reviewer" would inject into node
    // B's "reviewer" session when both are live.
    const sessionsFor = (agentName: string, workflowNodeId: string) =>
      executions.filter(
        (e) =>
          e.agentName === agentName &&
          e.workflowNodeId === workflowNodeId &&
          e.agentSessionId &&
          e.agentSessionId !== fromSessionId &&
          // Only treat genuinely-live execution statuses as having a usable
          // session. pending/cancelled/done/blocked/waiting_rebind rows may
          // retain a dead agentSessionId (spawn retry, terminal, etc.);
          // selecting them would inject into a dead session instead of letting
          // activation spawn/reactivate a live one. idle agents keep live
          // sessions (see space-runtime-idle-not-terminal).
          (e.status === 'in_progress' || e.status === 'idle')
      );

    for (const target of targets) {
      const { slot: agentName, nodeId } = target;
      // Activate the target worker session (reuse if already live). The node id
      // scopes activation so a shared slot name resolves to THIS node's session.
      // This is the SAME activation primitive send_message uses.
      let sessions = sessionsFor(agentName, nodeId);
      if (sessions.length === 0 && this.config.activateTargetSession) {
        try {
          await this.config.activateTargetSession(agentName, nodeId);
          executions = this.readLiveExecutions();
          sessions = sessionsFor(agentName, nodeId);
        } catch (err) {
          log.warn(
            `[HandoffExecutor] failed to activate target "${agentName}" on node "${nodeId}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (sessions.length > 0) {
        const message = envelope();
        for (const session of sessions) {
          try {
            await this.config.messageInjector(session.agentSessionId!, message);
            delivered.push({ agentName, sessionId: session.agentSessionId! });
          } catch (err) {
            log.warn(
              `[HandoffExecutor] inject failed for "${agentName}": ${err instanceof Error ? err.message : String(err)}`
            );
            notFound.push(agentName);
          }
        }
        continue;
      }

      // No live session — queue for later delivery if a persistent queue is
      // configured (mirrors send_message's declared-but-inactive path). The
      // node id is persisted on the row so the queue drain
      // (flushPendingMessagesForTarget) only delivers it to THIS node's session
      // and the idempotency key is node-scoped so two same-named slots across
      // nodes don't dedupe each other. A DEDUPED enqueue (same message already
      // pending from a prior attempt) is tracked separately: the message is
      // still queued (status), but it does NOT count as a newly-taken handoff
      // for cycle accounting — the prior attempt already charged (or refunded)
      // the cycle.
      if (this.config.pendingMessageRepo && spaceId) {
        const rawMessage = envelope();
        try {
          const { record, deduped } = this.config.pendingMessageRepo.enqueue({
            workflowRunId,
            spaceId,
            taskId: taskId ?? null,
            sourceAgentName: fromAgentName,
            targetKind: 'node_agent',
            targetAgentName: agentName,
            workflowNodeId: nodeId,
            message: rawMessage,
            idempotencyKey: JSON.stringify([fromSessionId, nodeId, agentName, rawMessage]),
            ttlMs: 60_000,
            maxAttempts: 3,
          });
          if (deduped) {
            dedupedCount += 1;
          } else {
            queued.push({ agentName, messageId: record.id });
            this.config.onMessageQueued?.(agentName, nodeId);
          }
        } catch (err) {
          log.warn(
            `[HandoffExecutor] failed to queue for "${agentName}" on node "${nodeId}": ${err instanceof Error ? err.message : String(err)}`
          );
          notFound.push(agentName);
        }
      } else {
        notFound.push(agentName);
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

/**
 * A resolved handoff destination: the concrete agent slot plus the node that
 * declares it. The node id travels through delivery so activation, live-session
 * lookup, and queue enqueue/drain are all scoped by node — a slot name reused
 * across two nodes cannot leak from one to the other.
 */
export interface HandoffTarget {
  nodeId: string;
  nodeName: string;
  slot: string;
}

/**
 * Resolve a transition's target to the concrete node/slot pairs the runtime
 * must activate/deliver to.
 *
 * - `'*'` (broadcast) → every node except the sender's, and every slot in them.
 * - node name → that node and all its slots.
 * - agent slot name → the (unique) node declaring that slot, and just that slot.
 *
 * Validation guarantees a named target resolves to exactly one destination, so
 * the slot-name branch selects a single node.
 */
export function resolveHandoffTargets(
  workflow: SpaceWorkflow,
  sourceNode: WorkflowNode,
  transition: HandoffTransition
): HandoffTarget[] {
  const allNodeNames = workflow.nodes.map((n) => n.name);
  const slotToNode = buildSlotToNodeMap(workflow);

  if (transition.target === HANDOFF_TARGET_WILDCARD) {
    const targets: HandoffTarget[] = [];
    for (const node of workflow.nodes) {
      if (node.id === sourceNode.id) continue; // broadcast excludes the sender
      for (const agent of safeResolveAgents(node)) {
        targets.push({ nodeId: node.id, nodeName: node.name, slot: agent.name });
      }
    }
    return targets;
  }

  // Node-name target → fan out to every slot in the node.
  if (allNodeNames.includes(transition.target)) {
    const node = workflow.nodes.find((n) => n.name === transition.target)!;
    return safeResolveAgents(node).map((agent) => ({
      nodeId: node.id,
      nodeName: node.name,
      slot: agent.name,
    }));
  }

  // Agent-slot target → the single node declaring that slot (first-declared
  // wins; validation rejects ambiguous slot names).
  const nodeName = slotToNode.get(transition.target);
  if (nodeName) {
    const node = workflow.nodes.find((n) => n.name === nodeName);
    if (node) return [{ nodeId: node.id, nodeName, slot: transition.target }];
  }

  return [];
}

/**
 * Whether taking `transition` (from `fromNodeName` toward `targetNodeNames`)
 * closes a loop in the workflow graph — i.e. a target node is the source itself
 * or can reach the source via directed channel/transition edges. Cyclicity is
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
  // A self-handoff or a target that can route back to the source is cyclic.
  return targetNodeNames.some(
    (target) => target === fromNodeName || canReach(target, fromNodeName)
  );
}

/** Build node-name → node-name directed edges from channels + transitions. */
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

  for (const channel of workflow.channels ?? []) {
    const froms = channel.from === HANDOFF_TARGET_WILDCARD ? [...allNodeNames] : [channel.from];
    const toList = Array.isArray(channel.to) ? channel.to : [channel.to];
    for (const from of froms) {
      for (const to of toList) {
        for (const resolved of resolveTargetNodes(to)) addEdge(from, resolved);
      }
    }
  }

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

/** De-duplicate a string list preserving first-seen order. */
function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Narrow an unknown value to a plain record (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
