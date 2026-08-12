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
 *   3. Resolve target node(s) + agent slot(s) from the transition target.
 *   4. Authorize the declared channel topology (`ChannelResolver`) — when channels
 *      are declared, the source→target delivery must be permitted, mirroring
 *      `send_message`. Open topology (no channels) permits all handoffs.
 *   5. Enforce cyclic transition `maxCycles` (`HandoffCycleRepository`).
 *   6. Authorize + commit the transition's declared gate fields (`GateDataRepository`
 *      + `evaluateGate`), rejecting `data` keys outside the gate's writable shape.
 *   7. Execute the transition's hook validator (`HookExecutor`).
 *   8. Activate or reuse the target worker session (`activateTargetSession`) and
 *      deliver the existing peer-message shape (`formatAgentMessage`), queueing
 *      when the target session is not yet live.
 *   9. Return a structured `delivered` / `queued` / `blocked` / `failed` result.
 *
 * Reuse, not duplication: gate evaluation, the hook engine, channel
 * authorization, and target activation are the SAME primitives `send_message`
 * and the channel router use. Only the transition-specific resolve/cycle/gate-
 * binding/hook-binding logic is new — it lives here.
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
  WorkflowHook,
  WorkflowHookResult,
  WorkflowNode,
} from '@hyperneo/shared';
import {
  HANDOFF_TARGET_WILDCARD,
  resolveHandoffTransition,
  resolveNodeAgents,
} from '@hyperneo/shared';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { HandoffCycleRepository } from '../../../storage/repositories/handoff-cycle-repository';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import { Logger } from '../../logger';
import { normalizeAgentNameToken } from '../agent-handle';
import { formatAgentMessage } from '../agent-message-envelope';
import { ChannelResolver } from './channel-resolver';
import { evaluateGate, type GateScriptExecutorFn } from './gate-evaluator';
import { getEffectiveGate } from './gate-features';
import type { GateScriptContext } from './gate-script-executor';
import type { HookExecutor, HookExecutorContext } from './hook-executor';

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

export interface HandoffGateOutcome {
  gateId: string;
  open: boolean;
  reason?: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
}

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
  /** Gate outcome when a transition gate was committed/evaluated. */
  gate?: HandoffGateOutcome;
  /** Hook outcome when a transition validator ran. */
  hook?: HandoffHookOutcome;
  /** True when blocked by an upstream rate-limit (defer retry past retryAfterMs). */
  rateLimited?: boolean;
  retryAfterMs?: number;
}

export interface HandoffExecutorConfig {
  /** Run-state validation. */
  workflowRunRepo: SpaceWorkflowRunRepository;
  /** The workflow definition for this run (nodes/gates/hooks/channels/transitions). */
  workflow: SpaceWorkflow;
  /** Gate data store (commit declared gate fields). */
  gateDataRepo: GateDataRepository;
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
  /** Gate script executor + context (for scripted gates), mirroring send_message. */
  scriptExecutor?: GateScriptExecutorFn;
  scriptContext?: Omit<GateScriptContext, 'gateId' | 'gateData' | 'gateDataUpdatedIso'>;

  /**
   * Current space autonomy level. Gate field writes use the same two-path
   * authorization as send_message: explicit writers (any match) bypass autonomy;
   * fields with no writers require `spaceLevel >= gate.requiredLevel`.
   */
  getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;

  /**
   * Sender name aliases (agent name, node name, …) normalized for gate-field
   * writer matching. Mirrors the alias set node-agent-tools builds per session.
   */
  agentNameAliases?: Set<string>;

  /** node name → agent slot names (fan-out / slot→node resolution). */
  nodeGroups?: Record<string, string[]>;
  /** node id → node name (peer nodeName hydration after activation). */
  workflowNodeNameById?: Record<string, string>;

  /** Existing target-activation callback (the SAME primitive send_message uses). */
  activateTargetSession?: (
    agentName: string
  ) => Promise<Array<{ agentName: string; sessionId: string }>>;
  /** Injects the peer-message envelope into a live target session. */
  messageInjector: (sessionId: string, message: string) => Promise<void>;
  /** Persistent queue for declared-but-inactive targets (mirrors send_message). */
  pendingMessageRepo?: PendingAgentMessageRepository;
  /** Fired after a non-deduped enqueue (auto-resume backstop, mirrors send_message). */
  onMessageQueued?: (agentName: string) => void;

  /** Domain profile hook fired after a gate-data commit (mirrors send_message). */
  onGateDataCommitted?: (params: {
    runId: string;
    nodeId: string;
    gateId: string;
    gateData: Record<string, unknown>;
    committedData: Record<string, unknown>;
    messageData?: Record<string, unknown>;
  }) => Promise<void> | void;
  /** Resolves the run's primary link URL (e.g. PR URL) for scripted gates. */
  resolvePrimaryLinkUrl?: (runId: string) => string;
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

    // 3. Resolve target node(s) + agent slot(s).
    const targets = resolveHandoffTargetSlots(workflow, sourceNode, transition);
    if (targets.slots.length === 0) {
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
    //     contract requires data keys to come from the bound gate's writable
    //     fields or the hook's template fields; a transition with neither a
    //     gate nor a hook accepts NO structured keys (gate-bound keys are
    //     validated against the gate in commitGate below).
    const dataKeys = operation.data ? Object.keys(operation.data) : [];
    if (dataKeys.length > 0 && !transition.gateId && !transition.hookId) {
      return this.blocked(
        'resolve_target',
        `Transition "${transition.id}" declares no gate or hook, so it accepts no handoff data keys (got: ${dataKeys.join(', ')}).`
      );
    }

    // 4. Authorize the declared channel topology (when declared).
    const resolver = new ChannelResolver(workflow.channels ?? []);
    if (!resolver.isEmpty()) {
      const unauthorized = targets.nodes.filter(
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

    const transitionKey = `${sourceNode.id}/${transition.id}`;
    const cyclic = isCyclicHandoff(workflow, fromNodeName, targets.nodes);
    const maxCycles = transition.maxCycles;
    const cycleLimited = cyclic && typeof maxCycles === 'number' && maxCycles > 0;

    // 4b. Read-only cycle cap check BEFORE gate/hook side effects. A cyclic
    //     transition already at its cap must not persist gate data or run hook
    //     validators/scripts on a guaranteed-to-fail retry. The atomic
    //     reservation still happens right before delivery (step 7) to close the
    //     TOCTOU.
    if (
      cycleLimited &&
      this.config.handoffCycleRepo.isCapReached(workflowRunId, transitionKey, maxCycles!)
    ) {
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

    // 5. Authorize + commit the transition's declared gate fields.
    let gateOutcome: HandoffGateOutcome | undefined;
    if (transition.gateId) {
      gateOutcome = await this.commitGate({
        sourceNode,
        fromNodeName,
        fromAgentName,
        gateId: transition.gateId,
        data: operation.data,
      });
      if (!gateOutcome.open) {
        return {
          status: 'blocked',
          stage: 'gate',
          transition,
          targetNodes: targets.nodes,
          targetSlots: targets.slots,
          delivered: [],
          queued: [],
          reason: gateOutcome.reason ?? `Gate "${transition.gateId}" blocked the handoff.`,
          gate: gateOutcome,
          rateLimited: gateOutcome.rateLimited,
          retryAfterMs: gateOutcome.retryAfterMs,
        };
      }
    }

    // 6. Execute the transition's hook validator.
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
      const resultType = hookOutcome.result.type;
      if (resultType === 'block' || resultType === 'retryable_block') {
        return {
          status: 'blocked',
          stage: 'hook',
          transition,
          targetNodes: targets.nodes,
          targetSlots: targets.slots,
          delivered: [],
          queued: [],
          reason: hookOutcome.result.reason ?? `Hook "${transition.hookId}" blocked the handoff.`,
          gate: gateOutcome,
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
          targetNodes: targets.nodes,
          targetSlots: targets.slots,
          delivered: [],
          queued: [],
          reason: `Cyclic handoff "${transition.id}" from "${fromNodeName}" has reached its maxCycles cap (${maxCycles}).`,
          gate: gateOutcome,
          hook: hookOutcome,
        };
      }
      trackReservation(true, transitionKey);
    }

    // 8. Activate or reuse the target worker session(s) + deliver the peer message.
    //    Re-check run state first: a hook/gate can await an external check for
    //    tens of seconds, and the run may have been cancelled meanwhile. A
    //    terminal run must not receive the handoff (and the cycle reservation is
    //    refunded by the caller's catch/path below).
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
      targetSlots: targets.slots,
      summary: operation.summary,
      data: operation.data,
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
        targetNodes: targets.nodes,
        targetSlots: targets.slots,
        delivered: delivery.delivered,
        queued: delivery.queued,
        // Surface partial-delivery diagnostics (e.g. a broadcast target that
        // was unreachable) even on an otherwise-delivered handoff.
        reason: delivery.reason,
        gate: gateOutcome,
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
        gate: gateOutcome,
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
      gate: gateOutcome,
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
  // Gate commit (mirrors send_message's gated-channel gate-write path)
  // -------------------------------------------------------------------------

  private async commitGate(args: {
    sourceNode: WorkflowNode;
    fromNodeName: string;
    fromAgentName: string;
    gateId: string;
    data?: Record<string, unknown>;
  }): Promise<HandoffGateOutcome> {
    const { sourceNode, fromNodeName, gateId, data } = args;
    const workflow = this.config.workflow;
    const gateDef = (workflow.gates ?? []).find((g) => g.id === gateId);
    if (!gateDef) {
      return {
        gateId,
        open: false,
        reason: `Transition references unknown gate "${gateId}".`,
      };
    }

    const supplied = data ?? {};
    const fieldMap = new Map((gateDef.fields ?? []).map((f) => [f.name, f]));

    // Contract: `data` keys must be in the gate's writable shape. Keys outside
    // it (unknown, or not writable by this sender) are rejected — not silently
    // dropped as in send_message. A handoff is a formal operation; an
    // ill-shaped payload must surface, not half-commit.
    const aliases = this.senderAliases(args.fromAgentName, fromNodeName);
    const effectiveRequiredLevel = gateDef.requiredLevel ?? 5;
    const spaceLevel = this.config.getSpaceAutonomyLevel
      ? await this.config.getSpaceAutonomyLevel(this.config.spaceId)
      : 0;
    const authorizedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(supplied)) {
      const fieldDef = fieldMap.get(key);
      if (!fieldDef) {
        return {
          gateId,
          open: false,
          reason: `Gate "${gateId}" has no field "${key}"; handoff data keys must match the gate's declared fields.`,
        };
      }
      const fieldAllowed = isFieldWritableBy(
        fieldDef,
        aliases,
        spaceLevel,
        effectiveRequiredLevel,
        !!this.config.getSpaceAutonomyLevel
      );
      if (!fieldAllowed) {
        return {
          gateId,
          open: false,
          reason: `Agent "${args.fromAgentName}" is not authorized to write gate field "${key}" on gate "${gateId}".`,
        };
      }
      authorizedData[key] = value;
    }

    // Commit the authorized write (if any), then evaluate. Deep-merge map-type
    // fields atomically (per-writer entries must not clobber one another),
    // identical to the send_message path. When the agent supplied no data we
    // skip the write but still evaluate — a gate already opened by a prior write
    // (e.g. human approval) must let the handoff proceed. The merge/eval calls
    // are wrapped so a DB or gate-script throw maps to a structured `failed`
    // result rather than escaping execute().
    try {
      const mapFields = new Set<string>();
      for (const key of Object.keys(authorizedData)) {
        const fieldDef = fieldMap.get(key);
        if (fieldDef?.type === 'map') mapFields.add(key);
      }
      const hasAuthorizedWrite = Object.keys(authorizedData).length > 0;
      const partial: Record<string, unknown> = { ...authorizedData, approvalSource: 'agent' };
      // Capture the merge return (its updatedAt) so we don't re-read the row.
      const mergedRecord = hasAuthorizedWrite
        ? mapFields.size > 0
          ? this.config.gateDataRepo.mergeWithMapFields(
              this.config.workflowRunId,
              gateId,
              partial,
              mapFields
            )
          : this.config.gateDataRepo.merge(this.config.workflowRunId, gateId, partial)
        : this.config.gateDataRepo.get(this.config.workflowRunId, gateId);
      const gateData = mergedRecord?.data ?? {};
      const gateDataUpdatedIso = mergedRecord
        ? new Date(mergedRecord.updatedAt).toISOString()
        : undefined;

      const freshPrUrl = this.config.resolvePrimaryLinkUrl?.(this.config.workflowRunId) ?? '';
      const evalResult = await evaluateGate(
        getEffectiveGate(gateDef, workflow, fromNodeName),
        gateData,
        this.config.scriptExecutor,
        this.config.scriptContext
          ? {
              ...this.config.scriptContext,
              gateId,
              gateData,
              gateDataUpdatedIso,
              prUrl: freshPrUrl || this.config.scriptContext.prUrl,
            }
          : undefined
      );

      // Domain profile side-artifact hook (mirrors send_message). Only fired when
      // the agent actually committed a write.
      if (hasAuthorizedWrite && this.config.onGateDataCommitted) {
        try {
          await this.config.onGateDataCommitted({
            runId: this.config.workflowRunId,
            nodeId: sourceNode.id,
            gateId,
            gateData,
            committedData: authorizedData,
            messageData: data,
          });
        } catch (err) {
          log.warn(
            `onGateDataCommitted failed for gate "${gateId}" in run "${this.config.workflowRunId}":`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      return {
        gateId,
        open: evalResult.open,
        reason: evalResult.reason,
        rateLimited: evalResult.rateLimited,
        retryAfterMs: evalResult.retryAfterMs,
      };
    } catch (err) {
      if (err instanceof HandoffExecutionError) throw err;
      throw new HandoffExecutionError(
        'gate',
        `Gate "${gateId}" evaluation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Hook validator (mirrors the validation classification hooks run before send)
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
      };
    }
    if (!this.config.hookExecutor) {
      return {
        hookId,
        result: {
          type: 'block',
          reason: `Hook "${hookId}" is bound to this transition but no hook executor is configured.`,
        },
      };
    }
    // Enforce the same caller-authorization WorkflowHookEngine applies before
    // invoking a hook: enabled, not human-only, source-node match, optional
    // target-node match, and a matching authorizedCaller entry (empty/absent
    // fails closed). Without this, an agent-triggered transition could run a
    // hook that was not authorized for it.
    const authReason = hookAuthorizationReason(hook, fromNodeName, fromAgentName, targetNodeNames);
    if (authReason) {
      return { hookId, result: { type: 'block', reason: authReason } };
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
      targetNode: targetNodeNames[0],
      hookLocalState: {},
      currentArtifacts: [],
      permittedExternalLookups: [],
    };

    try {
      const { result } = await this.config.hookExecutor.execute(hook, context);
      return { hookId, result };
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

  private async deliver(args: {
    fromAgentName: string;
    fromSessionId: string;
    targetSlots: string[];
    summary: string;
    data?: Record<string, unknown>;
  }): Promise<{
    delivered: Array<{ agentName: string; sessionId: string }>;
    queued: Array<{ agentName: string; messageId: string }>;
    dedupedCount: number;
    reason?: string;
  }> {
    const { fromAgentName, fromSessionId, targetSlots, summary, data } = args;
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
    // only after an activation actually spawns a session (avoids the per-slot
    // N+1 the prior liveSessionsFor-per-call shape had in the broadcast loop).
    let executions = this.readLiveExecutions();
    const sessionsFor = (agentName: string) =>
      executions.filter(
        (e) =>
          e.agentName === agentName &&
          e.agentSessionId &&
          e.agentSessionId !== fromSessionId &&
          // Exclude stale executions: a pending/cancelled row can retain a dead
          // agentSessionId (e.g. after a spawn retry); injecting into it would
          // skip activation and hit a failed session. Mirrors the production
          // activation path's status filter.
          e.status !== 'pending' &&
          e.status !== 'cancelled'
      );

    for (const agentName of targetSlots) {
      // Activate the target worker session (reuse if already live). This is the
      // SAME activation primitive send_message uses; it is intentionally
      // separate from gate evaluation.
      let sessions = sessionsFor(agentName);
      if (sessions.length === 0 && this.config.activateTargetSession) {
        try {
          await this.config.activateTargetSession(agentName);
          executions = this.readLiveExecutions();
          sessions = sessionsFor(agentName);
        } catch (err) {
          log.warn(
            `[HandoffExecutor] failed to activate target "${agentName}": ${err instanceof Error ? err.message : String(err)}`
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
      // configured (mirrors send_message's declared-but-inactive path). A
      // DEDUPED enqueue (same message already pending from a prior attempt) is
      // tracked separately: the message is still queued (status), but it does
      // NOT count as a newly-taken handoff for cycle accounting — the prior
      // attempt already charged (or refunded) the cycle.
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
            message: rawMessage,
            idempotencyKey: JSON.stringify([fromSessionId, agentName, rawMessage]),
            ttlMs: 60_000,
            maxAttempts: 3,
          });
          if (deduped) {
            dedupedCount += 1;
          } else {
            queued.push({ agentName, messageId: record.id });
            this.config.onMessageQueued?.(agentName);
          }
        } catch (err) {
          log.warn(
            `[HandoffExecutor] failed to queue for "${agentName}": ${err instanceof Error ? err.message : String(err)}`
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

  private senderAliases(fromAgentName: string, fromNodeName: string): Set<string> {
    const base = this.config.agentNameAliases
      ? [fromAgentName, fromNodeName, ...this.config.agentNameAliases]
      : [fromAgentName, fromNodeName];
    return new Set(
      base.map((value) => normalizeAgentNameToken(value)).filter((value) => value.length > 0)
    );
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
 * Resolve a transition's target to the concrete node name(s) and agent slot(s)
 * the runtime must activate/deliver to.
 *
 * - `'*'` (broadcast) → every node except the sender's, and every slot in them.
 * - node name → that node and all its slots.
 * - agent slot name → the (unique) node declaring that slot, and just that slot.
 *
 * Validation guarantees a named target resolves to exactly one destination, so
 * the slot-name branch selects a single node.
 */
export function resolveHandoffTargetSlots(
  workflow: SpaceWorkflow,
  sourceNode: WorkflowNode,
  transition: HandoffTransition
): { nodes: string[]; slots: string[] } {
  const allNodeNames = workflow.nodes.map((n) => n.name);
  const slotToNode = buildSlotToNodeMap(workflow);

  if (transition.target === HANDOFF_TARGET_WILDCARD) {
    const nodes: string[] = [];
    const slots: string[] = [];
    for (const node of workflow.nodes) {
      if (node.id === sourceNode.id) continue; // broadcast excludes the sender
      nodes.push(node.name);
      for (const agent of safeResolveAgents(node)) slots.push(agent.name);
    }
    return { nodes, slots };
  }

  // Node-name target → fan out to every slot in the node.
  if (allNodeNames.includes(transition.target)) {
    const node = workflow.nodes.find((n) => n.name === transition.target)!;
    return { nodes: [node.name], slots: safeResolveAgents(node).map((a) => a.name) };
  }

  // Agent-slot target → the single node declaring that slot.
  const nodeName = slotToNode.get(transition.target);
  if (nodeName) {
    return { nodes: [nodeName], slots: [transition.target] };
  }

  return { nodes: [], slots: [] };
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

/** Per-field two-path gate write authorization (mirrors send_message). */
function isFieldWritableBy(
  field: { writers: string[] },
  aliases: Set<string>,
  spaceLevel: number,
  requiredLevel: number,
  autonomyConfigured: boolean
): boolean {
  if (field.writers.length > 0) {
    return field.writers.some((writer) => {
      const normalized = normalizeAgentNameToken(writer);
      return normalized === '*' || aliases.has(normalized);
    });
  }
  // Autonomy path: no explicit writers → require sufficient space autonomy.
  return autonomyConfigured ? spaceLevel >= requiredLevel : false;
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
