/**
 * Workflow Hook Engine v2 — see `docs/features/workflow-hooks-v2.md`.
 *
 * Two layers: a {@link HookBinding} places a hook (by id) on a workflow route;
 * the hook itself is a built-in (from `@hyperneo/extensions-hooks`, loaded via
 * {@link resolveHook}) or a per-workflow custom script. The engine resolves the
 * bindings matching an MCP action, runs them in `order`, and honors each hook's
 * returned {@link HookReturn}:
 *
 *   - `continue` — proceed (optionally applying `payload` to the action params);
 *   - `stop` — block the action and end the chain;
 *   - `retry` — end the chain and re-run after engine-managed backoff.
 *
 * Hooks own their side effects: a hook performs them inside `run` by calling
 * {@link HookContext} methods (`recordState` / `writeArtifact` /
 * `queueFollowUp`). The engine collects those and applies them; the return only
 * signals flow. Follow-ups dispatch only when the chain ultimately delivers.
 */

import type {
  CustomHook,
  HookAction,
  HookArtifact,
  HookArtifactInput,
  HookBinding,
  HookContext,
  HookFlow,
  HookReturn,
  HookUserState,
  SpaceWorkflow,
  WorkflowRunArtifact,
  WorkflowRunStatus,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import { parseAddress } from '../../../../../messaging/src/address';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import { Logger } from '../../logger';
import {
  CreateStandaloneTaskSchema,
  SaveArtifactSchema,
  SendMessageSchema,
} from '../tools/node-agent-tool-schemas';
import {
  ApproveTaskSchema,
  MarkCompleteSchema,
  SubmitForApprovalSchema,
} from '../tools/task-agent-tool-schemas';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ChannelResolver } from './channel-resolver';
import { LEGACY_GUARD_HOOK_ID, ROUTING_UNAVAILABLE_HOOK_ID } from '../hook-reserved-ids';
import { isBuiltInHook, resolveHook } from './hook-registry';
import {
  GH_INFRA_ERROR_PREFIX,
  samePrLink,
  VALIDATED_PR_ARTIFACT_KEY,
} from '@hyperneo/extensions-hooks';
import { collectWithMaxBuffer, MAX_BUFFER_BYTES, parseJsonStdout } from './script-utils';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Metadata about the current action, passed by the tool handler wrapper. */
export interface HookActionMeta {
  sessionId: string;
  agentName: string;
  nodeId: string;
  taskId: string;
  targetNode?: string;
}

/** Record of a single hook execution (for audit + persistence). */
export interface HookExecutionRecord {
  hookId: string;
  flow: HookFlow;
  reason?: string;
  timestamp: number;
}

/** An artifact a hook asked the engine to write via `ctx.writeArtifact`. */
export interface HookArtifactWrite extends HookArtifactInput {}

/** Outcome of running the hook chain for a single MCP action. */
export interface HookActionOutcome {
  /** The chain's final decision. */
  decision: 'deliver' | 'stop' | 'retry';
  /** Final params after any `continue`-payload patches (or original). */
  finalParams: Record<string, unknown>;
  /** Follow-up send_messages to dispatch (only on `deliver`). */
  followUpRequests: Array<{ targetNode: string; message: string }>;
  /** Hook-local state accumulations to persist (always applied). */
  stateUpdates: Array<{ hookId: string; state: Record<string, unknown> }>;
  /** Per-hook execution log. */
  executionLog: HookExecutionRecord[];
  /** Normalized user-visible state for banners/debug UI. */
  userState: HookUserState;
  /** Hook id that caused a `stop` / `retry`, if any. */
  blockingHookId?: string;
  /** Backoff hint surfaced from a `retry`. */
  retryAfterMs?: number;
  /**
   * One-shot approval consumptions the chain DEFERRED to delivery. Returned
   * to the caller (the wrapper) instead of applied here: they must run only
   * after the wrapper's fail-closed pre-delivery prerequisites (decision
   * persistence, queued-record clear) succeed — consuming inside the engine
   * and failing later in the wrapper would lose the one-shot approval for a
   * delivery that never reached the protected handler.
   */
  pendingApprovalConsumes?: Array<{ hookId: string; approvedAt: unknown }>;
}

/** Dependencies for the workflow hook engine. */
export interface WorkflowHookEngineConfig {
  workflow: SpaceWorkflow;
  workflowRunId: string;
  workflowRunCreatedAt?: number;
  nodeExecutionRepo: NodeExecutionRepository;
  artifactRepo?: WorkflowRunArtifactRepository;
  hookStateRepo: WorkflowHookStateRepository;
  workspacePath?: string;
  getWorkflowRunStatus?: (runId: string) => WorkflowRunStatus | undefined;
  getTaskStatus?: (taskId: string) => string | undefined;
  getSourceNodeExecutionStatus?: (meta: HookActionMeta) => string | undefined;
  /** Resolves the authorized reply-session id for a sending agent (mirrors
   * the router's replyRoutingLookup) — used to authorize '@session:' array
   * entries, which the router hard-returns when they are not the recorded
   * reply target. */
  replyRoutingLookup?: (fromAgentName: string) => string | null | undefined;
  /** Whether the given workflow node currently has a LIVE sub-session
   * (mirrors the message resolver's active-preferred role delivery: when
   * any holder of a role is active, only active holders receive it). When
   * provided, '@role:' targets suppress inactive holders' gates; absent
   * (tests, other constructors) the topology-only behavior applies. */
  roleHolderActiveLookup?: (nodeId: string, agentName: string) => boolean;
  notifySourceSession?: (sessionId: string, message: string) => Promise<void>;
  onHookStateUpdated?: (
    hookId: string,
    hookState: import('@hyperneo/shared').HookStateSnapshot
  ) => void;
}

/** Sentinel thrown by binding resolution when the ROUTING store is
 * unreadable — caught at the top of executeAction and mapped to an
 * override-ineligible infrastructure stop. */
class INFRASTRUCTURE_ROUTING_STOP extends Error {}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const log = new Logger('workflow-hook-engine');

/** Maximum follow-up execution latency budget (30 seconds default). */
const DEFAULT_FOLLOW_UP_TIMEOUT_MS = 30_000;

/** Default delay for queued retryable hook actions when a hook omits retryAfterMs. */
const DEFAULT_RETRY_AFTER_MS = 30_000;

/** Bounds for an untrusted custom-script retry delay (clamped before scheduling). */
const MIN_SCRIPT_RETRY_MS = 1_000;
const MAX_SCRIPT_RETRY_MS = 86_400_000;

/**
 * Ceilings on hook retries. Past these a retrying hook converts to a terminal
 * stop (the run is not wedged forever on e.g. a PR left OPEN indefinitely).
 * ATTEMPTS bounds agent-driven retries (no timer; ~2880 manual attempts);
 * ELAPSED bounds timer-driven retries, whose exponential backoff raises the
 * cadence far above the 30s default — an attempt count alone would leave a
 * queued pr_merged/Codex gate pending for months. 7 days of cumulative
 * retrying; cancellation on task/run completion is the primary backstop.
 */
const MAX_RETRY_ATTEMPTS = 2880;
const MAX_RETRY_ELAPSED_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum bytes for an artifact data payload injected into a script hook env. */
const MAX_ARTIFACT_DATA_BYTES = 16_384;

/** Aggregate byte budget for HYPERNEO_CURRENT_ARTIFACTS_JSON (see buildScriptEnv). */
const MAX_ARTIFACTS_ENV_BYTES = 65_536;

/** Maximum bytes for a param `data` field before it is redacted in hook env. */
const MAX_PARAM_DATA_BYTES = 4096;

/** Maximum items in an array before truncation in hook env params. */
const MAX_ARRAY_ITEMS = 100;

/** Maximum keys in an object before truncation in hook env params. */
const MAX_OBJECT_KEYS = 50;

/** Maximum bytes for the serialized params JSON injected into hook env. */
const MAX_PARAMS_JSON_BYTES = 32_768;

/** Default timeout for custom hook scripts (30 seconds). */
const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;

/**
 * Grace period for stdout/stderr collection after the script's parent shell
 * exits — a background child inheriting the pipes gets this long to close them
 * before the streams are cancelled (see runCustomHookScript).
 */
const SCRIPT_EXIT_GRACE_MS = 2_000;

const METHOD_PARAM_SCHEMAS: Record<string, import('zod').ZodType<unknown>> = {
  send_message: SendMessageSchema,
  save_artifact: SaveArtifactSchema,
  create_standalone_task: CreateStandaloneTaskSchema,
  approve_task: ApproveTaskSchema,
  submit_for_approval: SubmitForApprovalSchema,
  mark_complete: MarkCompleteSchema,
};

const VALID_FLOWS = new Set<HookFlow>(['continue', 'stop', 'retry']);

/**
 * Prefix marking a stop as an execution/infrastructure FAILURE rather than a
 * hook decision — thrown built-ins, script timeouts, non-zero exits, malformed
 * stdout, spawn failures, unknown interpreters. These are
 * override-INELIGIBLE: the gate never completed, so a human approval must not
 * deliver through them.
 */
const HOOK_EXEC_ERROR_PREFIX = '__hook_exec_error__: ';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Module-level retry queue (persists across the run; replayed on restart)
// ---------------------------------------------------------------------------

export const QUEUED_RETRYABLE_ACTION_STATE_KEY = '__queuedRetryableActions';
const RETRYABLE_ACTION_CANCEL_STATUSES = new Set<WorkflowRunStatus>(['done', 'cancelled']);

interface QueuedRetryableHookAction {
  actionKey: string;
  hookId: string;
  methodName: string;
  args: Record<string, unknown>;
  meta: HookActionMeta;
  isFollowUp: boolean;
  nextRetryAt: number;
  retryAfterMs: number;
  queuedAt: number;
}

interface PendingRetryableHookAction {
  actionKey: string;
  delayMs: number;
  methodName: string;
  args: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<AnyToolResult>;
  engine: WorkflowHookEngine;
  handlers: Record<string, (...args: unknown[]) => Promise<AnyToolResult> | AnyToolResult>;
  meta: HookActionMeta;
  isFollowUp: boolean;
}

const pendingRetryableHookActions = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; options: PendingRetryableHookAction }
>();

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class WorkflowHookEngine {
  constructor(private readonly config: WorkflowHookEngineConfig) {}

  get workflowRunId(): string {
    return this.config.workflowRunId;
  }

  getRunStatus(): WorkflowRunStatus | undefined {
    return this.config.getWorkflowRunStatus?.(this.config.workflowRunId);
  }

  isRetryableActionCancelled(meta?: HookActionMeta): boolean {
    if (meta) {
      const taskStatus = this.config.getTaskStatus?.(meta.taskId);
      if (taskStatus === 'done' || taskStatus === 'cancelled' || taskStatus === 'archived') {
        return true;
      }
      const nodeExecutionStatus = this.config.getSourceNodeExecutionStatus?.(meta);
      if (nodeExecutionStatus === 'cancelled') {
        return true;
      }
    }
    const status = this.getRunStatus();
    return status !== undefined && RETRYABLE_ACTION_CANCEL_STATUSES.has(status);
  }

  async notifySourceSession(sessionId: string, message: string): Promise<void> {
    await this.config.notifySourceSession?.(sessionId, message);
  }

  /**
   * Re-arm queued retryable actions for a node session after (re)hydration.
   * Iterates the distinct hook ids across the workflow's bindings.
   */
  scheduleQueuedRetryableActions(
    handlersByMethod: Record<
      string,
      (...args: unknown[]) => Promise<AnyToolResult> | AnyToolResult
    >,
    ownerMeta: HookActionMeta
  ): void {
    for (const action of this.getQueuedRetryableActions()) {
      if (!sameRetryableActionOwner(action.meta, ownerMeta)) continue;
      if (this.isRetryableActionCancelled(action.meta)) {
        // Clear ONLY this action's key: the hook's durable map is shared
        // across owners — a whole-map clear would delete another session's
        // queued send (losing it if that owner has not rehydrated yet, or
        // across a later restart).
        this.clearQueuedRetryableAction(action.hookId, action.actionKey);
        continue;
      }
      const rawHandler = handlersByMethod[action.methodName];
      if (!rawHandler) continue;
      const handler = async (args: Record<string, unknown>) => await rawHandler(args);
      scheduleRetryableAction({
        actionKey: action.actionKey,
        delayMs: Math.max(0, action.nextRetryAt - Date.now()),
        methodName: action.methodName,
        args: action.args,
        handler,
        engine: this,
        handlers: handlersByMethod,
        meta: action.meta,
        isFollowUp: action.isFollowUp,
      });
    }
  }

  /** Current persisted retry count for a hook (for backoff bookkeeping). */
  getRetryCount(hookId: string): number {
    return this.config.hookStateRepo.get(this.config.workflowRunId, hookId)?.retryCount ?? 0;
  }

  clearQueuedRetryableAction(hookId: string, actionKey?: string): boolean {
    // Explicit delete paths, not a null in localState: deep-merge preserves
    // keys the patch omits (the cleared action would rehydrate after restart
    // and deliver again), while a null would collide with recordState's
    // contract (hooks may record null as a value). The delete physically
    // removes the key (bounded growth, no tombstones) and is merge-safe — a
    // sibling key queued before or after the clear survives either order.
    return this.persistStateUpdate(hookId, {
      localStateDeletePaths: [
        actionKey === undefined
          ? [QUEUED_RETRYABLE_ACTION_STATE_KEY]
          : [QUEUED_RETRYABLE_ACTION_STATE_KEY, actionKey],
      ],
    });
  }

  getQueuedRetryableAction(hookId: string): QueuedRetryableHookAction | undefined {
    // Scoped to the REQUESTED hook: a newer action under a DIFFERENT hook must
    // not shadow this hook's entry (getHookIdsWithQueuedAction depends on it).
    const state = this.config.hookStateRepo.get(this.config.workflowRunId, hookId)?.localState;
    const map = state?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
    if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined;
    let newest: QueuedRetryableHookAction | undefined;
    for (const value of Object.values(map as Record<string, unknown>)) {
      if (!isQueuedRetryableHookAction(value)) continue;
      if (!newest || value.queuedAt >= newest.queuedAt) newest = value;
    }
    return newest;
  }

  getQueuedRetryableActions(): QueuedRetryableHookAction[] {
    const hookIds = new Set((this.config.workflow.hookBindings ?? []).map((b) => b.hookId));
    const out: QueuedRetryableHookAction[] = [];
    for (const hookId of hookIds) {
      const state = this.config.hookStateRepo.get(this.config.workflowRunId, hookId)?.localState;
      const map = state?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      for (const value of Object.values(map as Record<string, unknown>)) {
        if (isQueuedRetryableHookAction(value)) out.push(value);
      }
    }
    return out;
  }

  /** Raw per-action-key queued map for a hook (test/merge-site helper). */
  /**
   * Whether the hook still has durable queued actions OTHER than the given
   * key. The retry bookkeeping (count/cooldown/__firstRetryAt) lives on the
   * SHARED (run, hook) state row — resetting it on THIS action's
   * deliver/stop would clobber the ceiling/cooldown that sibling queued
   * actions on the same hook still depend on (their timers would fire early
   * and their ceilings never accumulate).
   */
  hasOtherQueuedActions(hookId: string, excludeActionKey: string): boolean {
    const map = this.getQueuedRetryableActionsMap(hookId);
    if (!map) return false;
    return Object.keys(map).some((k) => k !== excludeActionKey);
  }

  getQueuedRetryableActionsMap(hookId: string): Record<string, unknown> | undefined {
    const state = this.config.hookStateRepo.get(this.config.workflowRunId, hookId)?.localState;
    const raw = state?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  }

  getHookIdsWithQueuedAction(actionKey: string): string[] {
    return (this.config.workflow.hookBindings ?? [])
      .map((b) => b.hookId)
      .filter((hookId) => this.hookHasQueuedAction(hookId, actionKey));
  }

  /** True when ANY of the hook's queued entries (not just the newest) matches. */
  private hookHasQueuedAction(hookId: string, actionKey: string): boolean {
    const state = this.config.hookStateRepo.get(this.config.workflowRunId, hookId)?.localState;
    const map = state?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
    if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
    for (const value of Object.values(map as Record<string, unknown>)) {
      if (isQueuedRetryableHookAction(value) && value.actionKey === actionKey) return true;
    }
    return false;
  }

  /**
   * Clear the persisted queued actions matching an action key across every
   * binding's hook. Returns true when every clear landed; false means at
   * least one durable replay record survived (the deliver/stop paths fail or
   * stay armed on it).
   */
  clearQueuedRetryableActionsForKey(actionKey: string): boolean {
    let allCleared = true;
    for (const hookId of this.getHookIdsWithQueuedAction(actionKey)) {
      if (!this.clearQueuedRetryableAction(hookId, actionKey)) {
        // A failed clear leaves the persisted queued action in place — it
        // re-arms on rehydration and could replay an already-delivered action.
        log.warn(
          `Failed to clear queued retryable action for hook "${hookId}" (key ${actionKey}); ` +
            'it may replay after a restart.'
        );
        allCleared = false;
      }
    }
    return allCleared;
  }

  /**
   * Persist a single hook-local state patch (and optional last flow/reason)
   * through the repository, retrying on version conflict. Returns true on
   * success, false on persistent conflict or error.
   */
  persistStateUpdate(
    hookId: string,
    patch: {
      localState?: Record<string, unknown>;
      /** Key paths to physically delete from localState after the merge. */
      localStateDeletePaths?: string[][];
      lastFlow?: HookFlow;
      lastReason?: string | null;
      retryCount?: number;
      nextRetryAt?: number | null;
    }
  ): boolean {
    // updateWithRetry refreshes the expected version per attempt; the engine
    // adds the state-updated event on top.
    const result = this.config.hookStateRepo.updateWithRetry(
      this.config.workflowRunId,
      hookId,
      patch
    );
    if (result) {
      this.config.onHookStateUpdated?.(hookId, result);
      return true;
    }
    return false;
  }

  /**
   * Next retry bookkeeping for a hook: the incremented attempt count and the
   * cooldown deadline `retryAfterMs` from now. Used by the wrapper's
   * non-send_message retry path, where no engine timer paces the agent's
   * manual re-attempts — the persisted count is what makes MAX_RETRY_ATTEMPTS
   * eventually convert a retry loop to a terminal stop.
   */
  nextRetryBookkeeping(
    hookId: string,
    retryAfterMs: number
  ): {
    retryCount: number;
    nextRetryAt: number;
  } {
    const current =
      this.config.hookStateRepo.get(this.config.workflowRunId, hookId)?.retryCount ?? 0;
    return { retryCount: current + 1, nextRetryAt: Date.now() + retryAfterMs };
  }

  /**
   * Execute the hook chain for an MCP action.
   */
  async executeAction(
    methodName: string,
    params: Record<string, unknown>,
    meta: HookActionMeta
  ): Promise<HookActionOutcome> {
    let bindings: HookBinding[];
    try {
      bindings = this.resolveMatchingBindings(methodName, params, meta);
    } catch (err) {
      if (err instanceof INFRASTRUCTURE_ROUTING_STOP) {
        // Attribute the stop to the TRANSIENT routing id (distinct from the
        // PERMANENT legacy guard — the web banner synthesizes a
        // non-dismissible "Legacy workflow hooks" message for that id) so
        // the wrapper persists a state row and the banner surfaces the
        // outage. The row clears automatically on the next successful
        // routing evaluation (see the recovery block after resolution).
        return {
          decision: 'stop',
          finalParams: params,
          followUpRequests: [],
          stateUpdates: [],
          executionLog: [
            {
              hookId: ROUTING_UNAVAILABLE_HOOK_ID,
              flow: 'stop',
              reason: err.message,
              timestamp: Date.now(),
            },
          ],
          userState: {
            status: 'blocked',
            humanOverrideEligible: false,
            hookId: ROUTING_UNAVAILABLE_HOOK_ID,
            reason: err.message,
          },
        };
      }
      throw err;
    }

    // TRANSIENT-STATE RECOVERY: a prior action's routing-store failure left
    // a persistent __routing_unavailable__ stop; this action's routing
    // evaluation SUCCEEDED, so the outage is over — clear the stale row or
    // the web banner (synthesized from the state row) stays stuck on a
    // non-dismissible "routing unavailable" message forever. Cheap: one
    // read per action, written only when a stale stop exists.
    try {
      const staleRoutingStop = this.config.hookStateRepo.get(
        this.config.workflowRunId,
        ROUTING_UNAVAILABLE_HOOK_ID
      );
      if (staleRoutingStop?.lastFlow === 'stop') {
        this.persistStateUpdate(ROUTING_UNAVAILABLE_HOOK_ID, {
          lastFlow: 'continue',
          lastReason: null,
        });
      }
    } catch {
      // State store also unavailable — nothing to clear coherently.
    }

    // Identity of THIS action — the same fingerprint the wrapper stamps as
    // `__blockedActionKey` when the chain stops, and approveHook copies into
    // `__approvedActionKey`. An approval bypasses a stop ONLY when both
    // match: approvals are per (run, hook, ACTION), not per (run, hook), so
    // a DIFFERENT action reaching the same hook after the operator approved
    // a displayed stop cannot spend that override on its own violation.
    const actionIdentity = buildRetryableActionKey(methodName, params, meta);
    const approvalMatchesAction = (state: { localState: Record<string, unknown> }): boolean =>
      state.localState.humanApproved === true &&
      state.localState.__approvedActionKey === actionIdentity;

    // Overridden approvals whose consumption is DEFERRED until the chain
    // delivers: consuming an override the moment its hook passes forces the
    // operator to re-approve the SAME violation repeatedly when a LATER hook
    // on the route also stops (approve A → B stops → approve B → A stops
    // again...). An overridden approval stays armed until a chain actually
    // delivers, then all deferred consumptions are persisted at once.
    const deferredApprovalConsumes = new Map<string, { approvedAt: unknown }>();

    if (bindings.length === 0) {
      return {
        decision: 'deliver',
        finalParams: params,
        followUpRequests: [],
        stateUpdates: [],
        executionLog: [],
        userState: { status: 'allowed' },
      };
    }

    const sorted = this.sortBindings(bindings);
    const executionLog: HookExecutionRecord[] = [];
    const stateUpdates: Array<{ hookId: string; state: Record<string, unknown> }> = [];
    const artifacts: Array<{ hookId: string; artifact: HookArtifactWrite }> = [];
    const followUpRequests: Array<{ targetNode: string; message: string }> = [];
    let currentParams = { ...params };
    // The ctx artifact window is identical for every binding in this action —
    // compute it once instead of 2 SQL round-trips per binding. A read
    // failure blocks the whole chain (fail closed — see readArtifactsForCtx).
    const ctxArtifacts = this.readArtifactsForCtx();
    if (ctxArtifacts === null) {
      // Attribute the stop to the first matching binding so the wrapper has a
      // per-hook entry to persist/publish — otherwise listHookStates shows no
      // blocked hook and the task pane offers no banner for the failure.
      const attributedHookId = sorted[0]?.hookId;
      const reason =
        'Hook context could not be read (artifact store failure); the action is blocked ' +
        'rather than evaluated without the run’s recorded artifacts.';
      return {
        decision: 'stop',
        finalParams: params,
        followUpRequests: [],
        stateUpdates: [],
        executionLog: attributedHookId
          ? [
              {
                hookId: attributedHookId,
                flow: 'stop' as HookFlow,
                reason,
                timestamp: Date.now(),
              },
            ]
          : [],
        userState: {
          status: 'blocked',
          humanOverrideEligible: false,
          hookId: attributedHookId,
          reason,
        },
        blockingHookId: attributedHookId,
      };
    }

    type Terminal = {
      kind: 'stop';
      hookId: string;
      reason?: string;
      /** Infrastructure stop — not a hook decision, not human-overridable. */
      overrideIneligible?: boolean;
      /** Retry-ceiling stop — bookkeeping must SURVIVE the reset below. */
      retryCeilingReached?: boolean;
    } | null;
    let terminal: Terminal = null;
    let retry: { hookId: string; reason?: string; retryAfterMs?: number } | null = null;

    for (const binding of sorted) {
      const hookId = binding.hookId;

      // Retry-cooldown pre-check: if this hook is still in backoff from a prior
      // retry, re-issue retry without re-running the hook (avoids hammering a
      // rate-limited / pending-merge lookup on every manual attempt). The
      // ceiling is enforced HERE too: the hook-run branch's check never fires
      // on this path (the hook does not run), and for non-send_message methods
      // the agent drives every attempt through this pre-check — without a cap
      // here a perpetually-retrying gate (pr_merged on an OPEN PR, codex never
      // approving) loops forever while the count climbs unbounded.
      const hookState = this.config.hookStateRepo.get(this.config.workflowRunId, hookId);
      const nextRetryAt = hookState?.nextRetryAt;
      // CEILING-APPROVAL BYPASS: an action-matching approval on a terminal
      // ceiling cooldown skips the ENTIRE cooldown pre-check below — the
      // hook runs immediately and the post-hook override applies the
      // approval to the FRESH decision (bypassing the cooldown must not
      // mean skipping the gate: a ceiling reached through transient GitHub
      // failures would otherwise deliver with no successful evaluation and
      // none of the hook's side effects).
      const ceilingApprovalBypass =
        nextRetryAt !== undefined &&
        Date.now() < nextRetryAt &&
        hookState?.localState.__retryCeilingTerminal === true &&
        approvalMatchesAction(hookState);
      if (nextRetryAt !== undefined && Date.now() < nextRetryAt && !ceilingApprovalBypass) {
        const attempts = hookState?.retryCount ?? 0;
        const firstRetryAt =
          typeof hookState?.localState.__firstRetryAt === 'number'
            ? (hookState.localState.__firstRetryAt as number)
            : undefined;
        const elapsed = firstRetryAt !== undefined ? Date.now() - firstRetryAt : 0;
        if (
          hookState?.localState.__retryCeilingTerminal === true ||
          attempts >= MAX_RETRY_ATTEMPTS ||
          (firstRetryAt !== undefined && elapsed >= MAX_RETRY_ELAPSED_MS)
        ) {
          // (An action-matching approval never reaches here — the
          // ceilingApprovalBypass above skipped the whole cooldown block so
          // the hook runs and the post-hook override applies the approval.)
          terminal = {
            kind: 'stop',
            hookId,
            retryCeilingReached: true,
            reason: `Hook retry limit exceeded (${
              firstRetryAt !== undefined && elapsed >= MAX_RETRY_ELAPSED_MS
                ? 'elapsed time exceeded'
                : `${MAX_RETRY_ATTEMPTS} attempts`
            }): ${hookState?.lastReason ?? 'retrying'}`,
          };
          // Stamp the terminal marker NOW (not only in the wrapper's stop
          // path): any later ceiling check — this run or a reissued action —
          // must be immediately terminal rather than restarting the cycle.
          this.persistStateUpdate(hookId, {
            localState: { __retryCeilingTerminal: true },
          });
          executionLog.push({
            hookId,
            flow: 'stop',
            reason: terminal.reason,
            timestamp: Date.now(),
          });
          break;
        }
        const remaining = Math.max(0, nextRetryAt - Date.now());
        const reason = hookState?.lastReason ?? 'Retry backoff pending';
        retry = { hookId, reason, retryAfterMs: remaining };
        executionLog.push({ hookId, flow: 'retry', reason, timestamp: Date.now() });
        break;
      }

      const hook = resolveHook(hookId, this.config.workflow.customHooks);
      if (!hook) {
        // Override-INELIGIBLE stop: the gate never ran, so a human approval
        // recorded against the banner must not bypass it (the override check
        // below only runs once the hook resolves).
        // FAIL CLOSED: an unresolvable hook on a bound route means the gate
        // cannot run — typically a PINNED definition referencing a built-in
        // that the running registry no longer has (e.g. after a rollback).
        // Skipping would deliver the protected action without that binding's
        // enforcement; block instead so the operator sees it.
        log.error(
          `Binding references hook "${hookId}" (${binding.sourceNode}→${binding.targetNode} ${methodName}) but it is not registered; blocking the action (fail closed).`
        );
        terminal = {
          kind: 'stop',
          hookId,
          overrideIneligible: true,
          reason:
            `Hook "${hookId}" is bound to this route but not registered in this daemon ` +
            '(pinned definition referencing an unavailable hook?). The action is blocked ' +
            'rather than delivered without that gate.',
        };
        executionLog.push({
          hookId,
          flow: 'stop',
          reason: terminal.reason,
          timestamp: Date.now(),
        });
        break;
      }

      // A standing human REJECTION blocks before the hook runs (it can never
      // be satisfied). An APPROVAL is handled AFTER the hook runs — see the
      // stop handling below — so side-effecting gates (pr_ready's identity
      // stamp) still execute under an override instead of being skipped.
      if (hookState && hookState.localState.humanApproved === false) {
        const rawReason = hookState.localState.humanRejectionReason;
        const reason =
          typeof rawReason === 'string' && rawReason.trim().length > 0
            ? rawReason
            : 'Rejected by human';
        terminal = { kind: 'stop', hookId, reason };
        executionLog.push({ hookId, flow: 'stop', reason, timestamp: Date.now() });
        break;
      }
      const approvalPending = !!hookState && approvalMatchesAction(hookState);
      // Token identifying WHICH approval was observed (re-approvals stamp a
      // fresh humanApprovedAt): the delivery-time consume accepts only this
      // approval — a newer approval granted to a different action/violation
      // while this action ran its async hook must not be spent here.
      const approvalToken = { approvedAt: hookState?.localState.humanApprovedAt };

      const built = this.buildHookContext(binding, meta, ctxArtifacts);
      const action: HookAction = {
        method: methodName as HookAction['method'],
        params: this.boundParams(currentParams),
        rawParams: currentParams,
      };

      let ret: HookReturn;
      try {
        if (isBuiltInHook(hook)) {
          ret = await hook.run(action, built.ctx);
        } else {
          ret = await this.runCustomHookScript(hook, built.ctx, action);
        }
      } catch (err) {
        log.warn(`Hook "${hookId}" threw on ${methodName}: ${errorMessage(err)}`);
        // Override-INELIGIBLE: the hook failed to produce a decision, so an
        // approval must not convert this into a delivery (the gate never
        // completed). Track it via the execution-log reason so the wrapper
        // persists __overrideEligible=false.
        ret = { flow: 'stop', reason: HOOK_EXEC_ERROR_PREFIX + errorMessage(err) };
      }

      const flow: HookFlow = VALID_FLOWS.has(ret.flow) ? ret.flow : 'stop';
      executionLog.push({ hookId, flow, reason: ret.reason, timestamp: Date.now() });

      // Collect the hook's accumulated side effects (always — they are owned by
      // the hook and persist regardless of flow). State + artifacts apply on
      // every outcome; follow-ups only dispatch on deliver (see outcome below).
      if (Object.keys(built.recordedState).length > 0) {
        stateUpdates.push({ hookId, state: built.recordedState });
      }
      for (const artifact of built.writtenArtifacts) artifacts.push({ hookId, artifact });
      for (const followUp of built.queuedFollowUps) followUpRequests.push(followUp);

      if (flow === 'stop') {
        const execFailed =
          (typeof ret.reason === 'string' && ret.reason.startsWith(HOOK_EXEC_ERROR_PREFIX)) ||
          (typeof ret.reason === 'string' && ret.reason.startsWith(GH_INFRA_ERROR_PREFIX));
        if (execFailed) {
          // Infrastructure stop — not a hook decision, not overridable.
          terminal = {
            kind: 'stop',
            hookId,
            overrideIneligible: true,
            reason: `Hook "${hookId}" failed to complete on ${methodName} (${
              (ret.reason as string).slice(HOOK_EXEC_ERROR_PREFIX.length) || 'internal error'
            }); the action is blocked rather than delivered without a completed gate.`,
          };
          executionLog[executionLog.length - 1] = {
            hookId,
            flow: 'stop',
            reason: terminal.reason,
            timestamp: Date.now(),
          };
          break;
        }
        if (approvalPending) {
          // Human override: the hook RAN (side effects — e.g. pr_ready's
          // identity stamp — landed), and its stop DECISION is overridden for
          // this one action. The one-shot consumption is DEFERRED until the
          // chain delivers (see deferredApprovalConsumes): a later hook's
          // stop must not force the operator to re-approve this one.
          deferredApprovalConsumes.set(hookId, approvalToken);
          executionLog[executionLog.length - 1] = {
            hookId,
            flow: 'continue',
            reason: 'Human override: hook stop overridden by approval',
            timestamp: Date.now(),
          };
          continue;
        }
        terminal = { kind: 'stop', hookId, reason: ret.reason };
        break;
      }
      if (flow === 'retry') {
        // Retry ceiling: a perpetually-retrying hook (e.g. pr_merged on a PR left
        // OPEN indefinitely) would otherwise loop forever. Past the cap, convert
        // the retry to a terminal stop so the run isn't wedged and the source is
        // notified (the wrapper notifies on terminal blocks).
        const ceilingState = this.config.hookStateRepo.get(this.config.workflowRunId, hookId);
        const attempts = ceilingState?.retryCount ?? 0;
        const firstRetryAt =
          typeof ceilingState?.localState.__firstRetryAt === 'number'
            ? (ceilingState.localState.__firstRetryAt as number)
            : undefined;
        if (
          ceilingState?.localState.__retryCeilingTerminal === true ||
          attempts >= MAX_RETRY_ATTEMPTS ||
          (firstRetryAt !== undefined && Date.now() - firstRetryAt >= MAX_RETRY_ELAPSED_MS)
        ) {
          if (approvalPending) {
            // An operator approved the ceiling stop: let this action through
            // (the hook retried to its ceiling; the human is the recovery
            // path). Without this, every displayed approval would convert
            // back to the same terminal stop. The one-shot consumption is
            // DEFERRED until the chain delivers.
            deferredApprovalConsumes.set(hookId, approvalToken);
            executionLog[executionLog.length - 1] = {
              hookId,
              flow: 'continue',
              reason: 'Human override: retry-ceiling stop overridden by approval',
              timestamp: Date.now(),
            };
            continue;
          }
          const elapsedCapped =
            firstRetryAt !== undefined && Date.now() - firstRetryAt >= MAX_RETRY_ELAPSED_MS;
          terminal = {
            kind: 'stop',
            hookId,
            retryCeilingReached: true,
            reason: `Hook retry limit exceeded (${
              elapsedCapped ? 'elapsed time exceeded' : `${MAX_RETRY_ATTEMPTS} attempts`
            }): ${ret.reason ?? 'retrying'}`,
          };
          // See the cooldown-path ceiling: stamp the terminal marker now.
          this.persistStateUpdate(hookId, {
            localState: { __retryCeilingTerminal: true },
          });
          executionLog[executionLog.length - 1] = {
            hookId,
            flow: 'stop',
            reason: terminal.reason,
            timestamp: Date.now(),
          };
        } else {
          // An ordinary (non-ceiling) retry invalidates a pending approval,
          // exactly like a natural continue: otherwise the approval survives
          // into a LATER, different stop (or the ceiling override) and
          // bypasses a violation the operator never saw or approved.
          // Token-bound like the continue path: a mismatched token is a NEWER
          // approval belonging to another action — not this one's to clear —
          // so proceed to the retry; only a write conflict blocks.
          if (approvalPending) {
            const clearResult = this.config.hookStateRepo.consumeApprovalIfCurrent(
              this.config.workflowRunId,
              hookId,
              approvalToken
            );
            const cleared = clearResult !== 'conflict';
            if (!cleared) {
              log.warn(
                `Failed to clear human approval for hook "${hookId}" after a retry; blocking.`
              );
              terminal = {
                kind: 'stop',
                hookId,
                reason:
                  'Human approval could not be cleared after the hook asked to retry (state ' +
                  'conflict). The action is blocked — approve it again and retry.',
              };
              executionLog.push({
                hookId,
                flow: 'stop',
                reason: terminal.reason,
                timestamp: Date.now(),
              });
              break;
            }
          }
          retry = { hookId, reason: ret.reason, retryAfterMs: ret.retryAfterMs };
        }
        break;
      }

      // flow === 'continue' — the hook passed on its own. A PENDING approval
      // must still be consumed: otherwise it lingers and a later stop for a
      // NEW violation would ride the stale one-shot. Token-bound: a
      // token-MISMATCH means the observed approval was already consumed and
      // a NEWER approval (belonging to a different action) is now armed —
      // that approval is not this action's to clear, so PROCEED without
      // clearing. A write conflict still fails closed (same discipline as
      // the stop-override).
      if (approvalPending) {
        const consume = this.config.hookStateRepo.consumeApprovalIfCurrent(
          this.config.workflowRunId,
          hookId,
          approvalToken
        );
        const consumed = consume !== 'conflict';
        if (!consumed) {
          log.warn(
            `Failed to consume human approval for hook "${hookId}" after a natural continue; blocking.`
          );
          terminal = {
            kind: 'stop',
            hookId,
            reason:
              'Human approval could not be cleared after the hook passed (state conflict). ' +
              'The action is blocked — approve it again and retry.',
          };
          executionLog.push({
            hookId,
            flow: 'stop',
            reason: terminal.reason,
            timestamp: Date.now(),
          });
          break;
        }
      }

      // apply an optional payload patch.
      if (isRecord(ret.payload)) {
        const patch = { ...ret.payload };
        // Disallow routing-field patches to prevent target bypass.
        if (methodName === 'send_message' && 'target' in patch) {
          log.warn(`Hook "${hookId}" tried to patch send_message target; ignored.`);
          delete patch.target;
        }
        const patched = { ...currentParams, ...patch };
        const errors = this.validatePatchedParams(methodName, patched);
        if (errors.length > 0) {
          // Protocol failure (the hook emitted a schema-invalid payload), not
          // a policy decision — override-ineligible so a displayed approval
          // is not silently burned re-creating the same stop.
          terminal = {
            kind: 'stop',
            hookId,
            overrideIneligible: true,
            reason: `Patched params invalid: ${errors.join('; ')}`,
          };
          executionLog[executionLog.length - 1] = {
            hookId,
            flow: 'stop',
            reason: terminal.reason,
            timestamp: Date.now(),
          };
          break;
        }
        currentParams = patched;
      }
    }

    // Apply artifact side effects immediately (idempotent upserts). A FAILED
    // write must block a would-be delivery: the artifacts are the hook's own
    // side effects (pr_ready's stamp is the run's authoritative identity), so
    // delivering without them hands off on a decision basis that was never
    // persisted — downstream gates would lose identity binding. Stop/retry
    // outcomes keep best-effort semantics (a retry re-runs the hook and its
    // writes).
    let failedArtifactWrite: { hookId: string } | null = null;
    for (const { hookId, artifact } of artifacts) {
      if (!this.writeArtifact(artifact, meta) && !failedArtifactWrite) {
        failedArtifactWrite = { hookId };
      }
    }
    if (failedArtifactWrite && !terminal && !retry) {
      terminal = {
        kind: 'stop',
        hookId: failedArtifactWrite.hookId,
        reason:
          'Hook artifact persistence failed (artifact store error); the action is blocked ' +
          'rather than delivered without the hook’s recorded side effects.',
        // Infrastructure failure — an approval must not deliver without the
        // hook's side effects (e.g. pr_ready's identity stamp).
        overrideIneligible: true,
      };
      executionLog.push({
        hookId: failedArtifactWrite.hookId,
        flow: 'stop',
        reason: terminal.reason,
        timestamp: Date.now(),
      });
    }

    const sourceNode =
      this.config.workflow.nodes.find((n) => n.id === meta.nodeId)?.name ?? meta.agentName;
    const blockingBinding = sorted.find((b) => b.hookId === (terminal?.hookId ?? retry?.hookId));

    if (terminal) {
      // Stamp the stop with THIS action's identity: the approve RPC copies
      // it into __approvedActionKey, and the override gates above bypass a
      // stop only when both match — an approval is per (run, hook, ACTION),
      // so a different action reaching the same hook after the operator
      // approved a displayed stop cannot spend that override on its own
      // violation. Recorded via stateUpdates so it persists with the stop.
      // Also stamp the ROUTE that blocked (a hook bound to several routes
      // shares one state row; the banner must label the route that actually
      // stopped, not whichever binding the UI dedup happens to pick first).
      const blockingRoute =
        blockingBinding !== undefined
          ? { sourceNode: blockingBinding.sourceNode, targetNode: blockingBinding.targetNode }
          : undefined;
      const stampedUpdates = [...stateUpdates];
      const stampIdx = stampedUpdates.findIndex((u) => u.hookId === terminal.hookId);
      const stopStamp: Record<string, unknown> = {
        __blockedActionKey: actionIdentity,
        ...(blockingRoute !== undefined ? { __blockingRoute: blockingRoute } : {}),
      };
      if (stampIdx >= 0) {
        stampedUpdates[stampIdx] = {
          ...stampedUpdates[stampIdx],
          state: {
            ...stampedUpdates[stampIdx].state,
            ...stopStamp,
          },
        };
      } else {
        stampedUpdates.push({ hookId: terminal.hookId, state: stopStamp });
      }
      return {
        decision: 'stop',
        finalParams: currentParams,
        followUpRequests: [],
        stateUpdates: stampedUpdates,
        executionLog,
        userState: {
          status: 'blocked',
          humanOverrideEligible: terminal.overrideIneligible === true ? false : true,
          hookId: terminal.hookId,
          reason: terminal.reason,
          sourceNode,
          targetNode: blockingBinding?.targetNode,
        },
        blockingHookId: terminal.hookId,
      };
    }

    if (retry) {
      const retryAfterMs = retry.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
      return {
        decision: 'retry',
        finalParams: currentParams,
        followUpRequests: [],
        stateUpdates,
        executionLog,
        userState: {
          status: 'waiting_on_retry',
          hookId: retry.hookId,
          reason: retry.reason,
          retryAfterMs,
          sourceNode,
          targetNode: blockingBinding?.targetNode,
        },
        blockingHookId: retry.hookId,
        retryAfterMs,
      };
    }

    // The chain can DELIVER: hand the deferred approval consumptions to the
    // CALLER (the wrapper) — an overridden approval is one-shot per delivery,
    // and the consume must not run until every fail-closed pre-delivery
    // prerequisite (decision persistence, queued-record clear) has succeeded
    // and the protected handler is actually about to run. A failed consume
    // there — write conflict, no approval armed, or a TOKEN MISMATCH (the
    // observed approval was consumed and a NEWER approval granted to a
    // different action/violation while this chain ran its async hooks) —
    // blocks the delivery: delivering on the newer approval would spend an
    // approval intended for a different violation.
    return {
      decision: 'deliver',
      finalParams: currentParams,
      followUpRequests,
      stateUpdates,
      executionLog,
      userState: { status: 'allowed' },
      pendingApprovalConsumes:
        deferredApprovalConsumes.size > 0
          ? [...deferredApprovalConsumes].map(([hookId, token]) => ({
              hookId,
              approvedAt: token.approvedAt,
            }))
          : undefined,
    };
  }

  /**
   * Apply the delivery-time one-shot approval consumptions as ONE atomic
   * batch (called by the wrapper after its pre-delivery prerequisites
   * succeed): every token is validated before any approval is cleared, so a
   * later token mismatch cannot leave an earlier approval already spent —
   * either all clear or none does. Returns the repo's four-way outcome; the
   * CALLER blocks the delivery on anything but 'consumed'.
   */
  consumeApprovals(
    entries: Array<{ hookId: string; approvedAt: unknown }>
  ): 'consumed' | 'not-pending' | 'token-mismatch' | 'conflict' {
    return this.config.hookStateRepo.consumeApprovalsIfCurrentBatch(
      this.config.workflowRunId,
      entries
    );
  }

  /**
   * Write an artifact a hook requested via `ctx.writeArtifact`. Returns false
   * when the persist failed — the caller blocks a would-be delivery on it
   * (see executeAction).
   */
  private writeArtifact(artifact: HookArtifactWrite, meta: HookActionMeta): boolean {
    if (!this.config.artifactRepo) return true;
    try {
      // The run's validated-PR identity stamp is FIRST-writer-wins: two
      // overlapping pr_ready evaluations (same run, possibly different source
      // nodes) both read 'no identity yet' before either persists. The repo's
      // unique (run, NODE, type, key) constraint would otherwise let each
      // node stamp its own row, and getPrimaryLink would pick one — binding
      // downstream gates to whichever identity won the race. The atomic claim
      // makes the first stamp authoritative; a conflicting existing identity
      // rejects the write (the caller blocks delivery on it).
      if (artifact.artifactType === 'link' && artifact.artifactKey === VALIDATED_PR_ARTIFACT_KEY) {
        const claim = this.config.artifactRepo.claimIdentityStamp({
          id: generateUUID(),
          runId: this.config.workflowRunId,
          nodeId: artifact.nodeId ?? meta.nodeId,
          artifactType: artifact.artifactType,
          artifactKey: artifact.artifactKey,
          data: artifact.data,
        });
        if (claim.inserted) return true;
        const existingLink =
          typeof claim.existing?.data?.link === 'string'
            ? (claim.existing.data.link as string)
            : undefined;
        const incomingLink =
          typeof artifact.data.link === 'string' ? (artifact.data.link as string) : undefined;
        // Idempotent re-stamp of the SAME identity is a no-op success; a
        // CONFLICTING identity is rejected so the caller blocks delivery.
        // Compare by NORMALIZED PR identity (same as the hook's swap check):
        // an equivalent spelling (/files suffix, trailing slash, casing) is
        // the same PR, not a conflict. A VERIFIED replacement (the hook's
        // swap check confirmed the previously stamped PR is CLOSED and names
        // it in `replaces`) swaps atomically instead of conflicting forever.
        if (existingLink === undefined || incomingLink === undefined) return false;
        if (samePrLink(incomingLink, existingLink)) return true;
        const replaces =
          typeof artifact.data.replaces === 'string' ? artifact.data.replaces : undefined;
        if (replaces !== undefined && samePrLink(replaces, existingLink)) {
          return this.config.artifactRepo.replaceIdentityStamp({
            id: generateUUID(),
            runId: this.config.workflowRunId,
            nodeId: artifact.nodeId ?? meta.nodeId,
            artifactType: artifact.artifactType,
            artifactKey: artifact.artifactKey,
            data: artifact.data,
            // CAS on the PRIOR stamp this caller verified: a concurrent
            // replacement that already swapped it makes this one refuse (its
            // verification was of a stamp that is no longer authoritative),
            // so exactly one replacement wins and the run keeps a single PR
            // identity.
            expectedPriorId: claim.existing?.id,
          });
        }
        return false;
      }
      this.config.artifactRepo.upsert({
        id: generateUUID(),
        runId: this.config.workflowRunId,
        nodeId: artifact.nodeId ?? meta.nodeId,
        artifactType: artifact.artifactType,
        artifactKey: artifact.artifactKey,
        data: artifact.data,
      });
      return true;
    } catch (err) {
      log.warn(
        `Failed to write hook artifact (${artifact.artifactType}/${artifact.artifactKey}): ${errorMessage(err)}`
      );
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Binding resolution (KEEP: send_message target / channel / slot resolution)
  // -------------------------------------------------------------------------

  private resolveMatchingBindings(
    methodName: string,
    params: Record<string, unknown>,
    meta: HookActionMeta
  ): HookBinding[] {
    const workflow = this.config.workflow;
    if (!workflow?.hookBindings) return [];

    const nodeName = workflow.nodes.find((n) => n.id === meta.nodeId)?.name ?? meta.agentName;

    const slotToNodes = new Map<string, string[]>();
    // nodeSlots: node name → its declared agent slot names (for the slot
    // fallback the router uses when a plain node entry is translated to
    // @worker:<node>/<agent> — a slot-authored channel 'Coding → reviewer'
    // authorizes canSend(fromNode, agentName)).
    const nodeSlots = new Map<string, string[]>();
    for (const node of workflow.nodes) {
      const slots = (node.agents ?? []).map((a) => a.name);
      nodeSlots.set(node.name, slots);
      for (const agent of node.agents ?? []) {
        const arr = slotToNodes.get(agent.name) ?? [];
        if (!arr.includes(node.name)) {
          arr.push(node.name);
          slotToNodes.set(agent.name, arr);
        }
      }
    }

    const fromNode = nodeName;
    const nodeIdToName = new Map(workflow.nodes.map((n) => [n.id, n.name]));
    const nodeNameToId = new Map(workflow.nodes.map((n) => [n.name, n.id]));
    const nodeNames = new Set(workflow.nodes.map((n) => n.name));
    const resolver = new ChannelResolver(workflow.channels ?? []);
    // ADAPTER PARITY for bare-slot resolution ORDER: the adapter's
    // legacyBareTargetMatches prefers ACTOR matches — live worker executions
    // (nodeExecutionRepo.listByWorkflowRun, ORDER BY created_at ASC) — over
    // declaration-order agent matches, and RETURNS EARLY on the first
    // non-empty actor set (declaration-only declarers are EXCLUDED). The
    // router then delivers sequentially in that order and hard-returns at
    // the first unauthorized worker, so the sequential fan-out walks below
    // must see resolutions in the SAME order — declaration order here would
    // diverge whenever a later-declared node's execution was created first,
    // suppressing a gate for a handoff the router actually delivers
    // (fail-open of the whole boundary this engine builds).
    let executionsUnreadable = false;
    const slotExecutionNodes = new Map<string, string[]>();
    try {
      for (const exec of this.config.nodeExecutionRepo.listByWorkflowRun(
        this.config.workflowRunId
      )) {
        const nodeNameForExec = nodeIdToName.get(exec.workflowNodeId) ?? exec.workflowNodeId;
        const arr = slotExecutionNodes.get(exec.agentName) ?? [];
        if (!arr.includes(nodeNameForExec)) {
          arr.push(nodeNameForExec);
          slotExecutionNodes.set(exec.agentName, arr);
        }
      }
    } catch {
      executionsUnreadable = true;
    }

    if (executionsUnreadable) {
      // INFRASTRUCTURE STOP: the routing store is unreadable. The router's
      // own target translation reads the same repository and would fail the
      // send — but a side-effecting hook evaluated here against fallback
      // declaration-order routing could already have stamped the run's
      // immutable PR identity for an attempt that never delivers. Fail
      // closed BEFORE any hook runs (override-ineligible); the sentinel is
      // caught at the top of executeAction.
      throw new INFRASTRUCTURE_ROUTING_STOP(
        'Node execution store unreadable — hook routing cannot be resolved reliably; ' +
          'the action is blocked rather than evaluated against fallback routing data.'
      );
    }
    const actionTargets = new Set<string>();
    // Nodes whose requested resolution was NON-ROUTABLE (per-target, not
    // global: a mixed multicast's routable parts keep their gates).
    const nonRoutableResolvedNodes = new Set<string>();
    // Router parity: ordinary targets are authorized ONLY via
    // canSend(fromNodeName, resolvedNode) — never from the sender's AGENT
    // SLOT. A slot-authored channel ('coder → Review' with no 'Coding →
    // Review') authorizes nothing at the router, so it must not run a
    // side-effecting gate here either (pr_ready stamps the run's immutable
    // PR identity from an attempt the router then refuses to deliver).
    const isRoutableTarget = (targetNode: string): boolean =>
      nodeNames.has(targetNode) && resolver.canSend(fromNode, targetNode);
    // The router ALSO accepts a send addressed to a worker on an AGENT SLOT
    // the channel names (e.g. channel 'Coding → reviewer', send
    // '@worker:Review/reviewer') via resolver.canSend(fromNode, agentName).
    // Mirror that fallback EXACTLY — the router checks only
    // canSend(fromNodeName, agentName), never a reverse
    // canSend(agentName, nodeName): accepting the reverse here would run a
    // side-effecting gate (pr_ready can stamp the run's immutable PR
    // identity) on a send the router then refuses to deliver.
    // A worker address whose run id differs from THIS run (or that names no
    // agent) is a notFound MISS at the router: the entry delivers nothing but
    // the loop CONTINUES (agent-message-router.ts:432-435) — later entries
    // still deliver, so a miss must not become a sequential failure.
    const isForeignWorkerMiss = (rawTarget: string): boolean => {
      try {
        const addr = parseAddress(rawTarget);
        if (addr.kind !== 'worker') return false;
        if (!addr.agentName) return true;
        const entryRun = addr.workflowRunId;
        return entryRun !== undefined && entryRun !== this.config.workflowRunId;
      } catch {
        return false;
      }
    };
    const workerAgentOf = (rawTarget: string): string | undefined => {
      if (!rawTarget.startsWith('@worker:')) return undefined;
      try {
        const addr = parseAddress(rawTarget);
        if (addr.kind !== 'worker' || !addr.agentName) return undefined;
        // DECODE exactly as the router does (agent-message-router.ts decodes
        // before canSend): a canonical slot name like 'reviewer:lead' arrives
        // percent-encoded ('reviewer%3Alead'), and the slot-route check
        // against the encoded form fails — suppressing a binding whose gate
        // the router-authorized send must run.
        return decodeURIComponent(addr.agentName);
      } catch {
        return undefined;
      }
    };
    const isRoutableWorkerOnSlot = (
      workerAgentName: string | undefined,
      targetNode: string
    ): boolean =>
      nodeNames.has(targetNode) && !!workerAgentName && resolver.canSend(fromNode, workerAgentName);
    const isBuiltInInterLevelTarget = (targetValue: string): boolean =>
      targetValue.trim() === 'space-agent';

    if (methodName === 'send_message') {
      const target = params.target;
      if (typeof target === 'string') {
        if (target.trim() === '*') {
          // Router parity: '*' resolves against the SENDER NODE's permitted
          // targets only (agent-message-router.ts:750-752) — no slot union.
          // Match translateLegacyNodeTargets' '*' expansion EXACTLY: it
          // includes only nodes the sender reaches via canSend(fromNode,
          // node.name) (node-level), NOT slot-authored channels — those
          // yield no worker targets and the send is rejected. Expanding slot
          // routes here would run a side-effecting gate off a broadcast that
          // delivers nowhere.
          const permitted = workflow.nodes
            .filter((n) => resolver.canSend(fromNode, n.name))
            .map((n) => n.name);
          if (permitted.includes('*')) {
            for (const node of workflow.nodes) {
              actionTargets.add(node.name);
            }
          } else {
            for (const t of permitted) {
              for (const resolved of this.resolveTargetEntries(
                t,
                nodeIdToName,
                slotToNodes,
                nodeNames,
                slotExecutionNodes
              )) {
                actionTargets.add(resolved);
              }
            }
          }
        } else {
          const resolvedTargets = this.resolveTargetEntries(
            target,
            nodeIdToName,
            slotToNodes,
            nodeNames,
            slotExecutionNodes
          );
          for (const resolved of resolvedTargets) {
            actionTargets.add(resolved);
          }
          // Resolved-node routability criterion (mirrors the array branch):
          // only a resolution that IS a workflow node name can disqualify —
          // a generic address resolving to no node adds no targets and must
          // not suppress the gate (the router delivers it separately).
          const foreignWorkerMiss = target.startsWith('@worker:') && isForeignWorkerMiss(target);
          // A '@role:' string target resolving to a workflow node must be
          // channel-authorized (the role resolver only delivers to permitted
          // workers); an unauthorized role reaches no worker.
          // The role resolver authorizes via canSendToWorkerTarget: the
          // cross-product of {fromNode, fromAgentSlot} x {targetNode,
          // targetAgentSlot} — a slot-authored channel on EITHER side
          // authorizes. Mirroring only node-to-node routes would suppress
          // the binding for a slot-authored role send the router delivers.
          // The cross-product ({fromNode, fromAgentSlot} x {targetNode,
          // targetAgentSlot}) is the ROLE resolver's rule — apply it to role
          // targets only; for ordinary targets the router authorizes node
          // names alone (a from-SLOT channel authorizes nothing).
          // Per-resolved-NODE role routability: the role resolver filters
          // holders individually, so a shared slot/role name must not make
          // every resolving node routable when only one has an authorized
          // worker.
          const roleNodeRoutableBase = (r: string): boolean => {
            if (!nodeNames.has(r)) return false;
            const slots = nodeSlots.get(r) ?? [];
            return (
              isRoutableTarget(r) ||
              slots.some(
                (sl) => resolver.canSend(fromNode, sl) || resolver.canSend(meta.agentName, sl)
              ) ||
              resolver.canSend(meta.agentName, r)
            );
          };
          // RESOLVER PARITY: the message resolver delivers a role to ACTIVE
          // holders only when at least one is active — an inactive holder's
          // node never receives the message, so its gate must not run (a
          // side-effecting hook on an undelivered role send). Applied per
          // resolved-node against the same authorized-holder set.
          const roleActiveLookup = this.config.roleHolderActiveLookup;
          // The role's SLOT name scopes activity to the targeted agent: a
          // multi-agent node whose OTHER slot is live must not count as an
          // active holder of this role (the resolver delivers per-actor).
          const roleSlotName = target.startsWith('@role:')
            ? decodeURIComponent(target.slice(6))
            : target;
          const roleNodeRoutable = (r: string): boolean => {
            if (!roleActiveLookup) return roleNodeRoutableBase(r);
            const holders = resolvedTargets.filter((h) => roleNodeRoutableBase(h));
            const activeHolders = holders.filter(
              (h) => roleActiveLookup(nodeNameToId.get(h) ?? h, roleSlotName) === true
            );
            if (activeHolders.length > 0 && !activeHolders.includes(r)) return false;
            return roleNodeRoutableBase(r);
          };
          const roleUnauthorized =
            target.startsWith('@role:') && !resolvedTargets.some((r) => roleNodeRoutable(r));
          // SEQUENTIAL fan-out for plain translated targets: a bare slot
          // (or node) entry expands to one @worker per resolution IN ORDER,
          // and the router hard-returns at the first unauthorized worker —
          // resolutions AFTER the abort never receive the message, so their
          // gates are suppressed (mirroring the array branch's post-failure
          // semantics; without this, a valid later node's gate would run
          // side effects off an undelivered send).
          const plainFanout =
            !target.startsWith('@') &&
            !target.startsWith('#') &&
            target.trim() !== '*' &&
            !isBuiltInInterLevelTarget(target);
          let fanoutAborted = false;
          for (const resolved of resolvedTargets) {
            if (plainFanout && nodeNames.has(resolved) && fanoutAborted) {
              // The router already returned at an earlier node's worker —
              // this resolution was never reached.
              nonRoutableResolvedNodes.add(resolved);
              continue;
            }
            const workerSlotOk =
              !foreignWorkerMiss &&
              target.startsWith('@worker:') &&
              isRoutableWorkerOnSlot(workerAgentOf(target), resolved);
            // The node-agent MCP path translates a bare slot target like
            // 'reviewer' to @worker:<node>/reviewer, which the router
            // authorizes via canSend(fromNode, agentName) for a channel
            // authored to the SLOT (e.g. 'Coding → reviewer'). Mirror that
            // bare-slot authorization (the entry string is the slot name) so
            // a slot-only-authored route is not mis-read as non-routable.
            // The node-agent MCP path translates a bare slot OR node target
            // to @worker:<node>/<agent> for every agent of the resolved node;
            // the router authorizes via canSend(fromNode, agentName) for a
            // slot-authored channel (e.g. 'Coding → reviewer'). Authorize
            // when the entry string OR any slot of the resolved node
            // satisfies canSend — otherwise a node-name entry ('Review')
            // under a slot-only-authored channel is mis-read as non-routable.
            const nodeSlotNames = nodeSlots.get(resolved) ?? [];
            // A plain entry is either a NODE target (expansion = every agent
            // in declaration order; the router authorizes via the FIRST
            // declared slot's channel) or a BARE SLOT target (expansion =
            // ONLY the named slot — legacyBareTargetMatches does not include
            // the node's other slots, so the first-slot rule must NOT
            // authorize a named non-first slot the router would reject).
            const isPlainNodeTarget = nodeNames.has(target);
            const bareSlotOk =
              !target.startsWith('@') &&
              !target.startsWith('#') &&
              target.trim() !== '*' &&
              (resolver.canSend(fromNode, target) ||
                (isPlainNodeTarget &&
                  // First DECLARED slot only — the router aborts at the first
                  // unauthorized worker in expansion order, so a later slot's
                  // channel does not reach the node.
                  nodeSlotNames.length > 0 &&
                  resolver.canSend(fromNode, nodeSlotNames[0])));
            if (
              nodeNames.has(resolved) &&
              !isBuiltInInterLevelTarget(target) &&
              (roleUnauthorized ||
                foreignWorkerMiss ||
                (!target.startsWith('@role:') &&
                  !workerSlotOk &&
                  !bareSlotOk &&
                  !isRoutableTarget(resolved)) ||
                (target.startsWith('@role:') && !roleNodeRoutable(resolved)))
            ) {
              nonRoutableResolvedNodes.add(resolved);
              // A plain fan-out node that fails its own delivery ABORTS the
              // router at its worker — every LATER resolution of this same
              // target never receives the message either.
              if (
                plainFanout &&
                !roleUnauthorized &&
                !foreignWorkerMiss &&
                !target.startsWith('@role:')
              ) {
                fanoutAborted = true;
              }
            }
          }
        }
      } else if (Array.isArray(target)) {
        // The node-agent MCP path TRANSLATES every entry before the router
        // (messaging-adapter.translateLegacyNodeTargets): a plain node/slot
        // name becomes @worker addresses (fan-out), '*' expands to the
        // sender's permitted worker targets, a generic address passes
        // through, and a plain entry matching nothing makes the translation
        // reject the WHOLE send. The router's generic path then delivers
        // SEQUENTIALLY — each authorized entry delivers before the next is
        // inspected, returning at the first unauthorized @worker entry. So
        // gates follow entry order: pre-failure entries keep theirs; the
        // failing entry and everything after it is suppressed; a plain
        // untranslatable entry refuses the whole send (nothing may run a
        // side-effecting gate off a send the router never delivers).
        let sequentialBlocked = false;
        let wholeSendRefused = false;
        const arrayResolvedNodes = new Set<string>();
        const postFailureNodes = new Set<string>();
        for (const t of target) {
          if (typeof t !== 'string') {
            // A non-string entry contributes no resolvable node target — the
            // schema layer rejects it, and it must not suppress the gates on
            // the valid parts of the multicast.
            continue;
          }
          if (t.trim() === '*') {
            // Expand to the sender node's NODE-LEVEL permitted targets only
            // (canSend(fromNode, node.name)) — translateLegacyNodeTarget
            // honors slot routes inconsistently and yields no worker targets
            // for a slot-only-authored channel, so the send is rejected;
            // expanding slot routes here would run a gate off an undelivered
            // broadcast.
            for (const pt of workflow.nodes
              .filter((n) => resolver.canSend(fromNode, n.name))
              .map((n) => n.name)) {
              for (const resolved of this.resolveTargetEntries(
                pt,
                nodeIdToName,
                slotToNodes,
                nodeNames,
                slotExecutionNodes
              )) {
                actionTargets.add(resolved);
                if (nodeNames.has(resolved)) {
                  if (arrayResolvedNodes.has(resolved)) continue;
                  if (sequentialBlocked || wholeSendRefused) postFailureNodes.add(resolved);
                  else arrayResolvedNodes.add(resolved);
                }
              }
            }
            continue;
          }
          const resolvedTargets = this.resolveTargetEntries(
            t,
            nodeIdToName,
            slotToNodes,
            nodeNames,
            slotExecutionNodes
          );
          // Delivered BEFORE this entry: nodes a PRIOR entry already delivered
          // keep their gate even if THIS entry fails (the router dedupes and
          // delivered them first). Nodes first collected in this very
          // iteration are NOT protected — this entry is their only delivery.
          const deliveredBefore = new Set(arrayResolvedNodes);
          for (const resolved of resolvedTargets) {
            actionTargets.add(resolved);
            if (nodeNames.has(resolved)) {
              if (arrayResolvedNodes.has(resolved)) continue;
              if (sequentialBlocked || wholeSendRefused) postFailureNodes.add(resolved);
              else arrayResolvedNodes.add(resolved);
            }
          }
          if (wholeSendRefused || sequentialBlocked) continue;
          if (isBuiltInInterLevelTarget(t)) continue;
          const isAddress = parsesAsAddress(t);
          const isWorker = t.startsWith('@worker:');
          // A '#' channel address unconditionally hard-returns the router
          // loop (agent-message-router.ts:421-430) before anything after it
          // delivers — model it as a sequential failure point.
          if (t.startsWith('#')) {
            sequentialBlocked = true;
            for (const resolved of resolvedTargets) {
              if (nodeNames.has(resolved) && !arrayResolvedNodes.has(resolved)) {
                postFailureNodes.add(resolved);
              }
            }
            continue;
          }
          if (t.startsWith('@session:')) {
            const sessionId = t.slice('@session:'.length);
            const authorizedReply = this.config.replyRoutingLookup?.(meta.agentName);
            if (authorizedReply !== sessionId) {
              // The router hard-returns when the session is not the recorded
              // reply target — later entries never deliver. An
              // earlier-delivered node keeps its gate (mirroring the
              // entry-level failure guard structurally).
              sequentialBlocked = true;
              for (const resolved of resolvedTargets) {
                if (nodeNames.has(resolved) && !arrayResolvedNodes.has(resolved)) {
                  postFailureNodes.add(resolved);
                }
              }
            }
            continue;
          }
          // A '@role:' target resolving to workflow nodes must be
          // channel-authorized: the role resolver only delivers to workers
          // the topology permits (canSendToWorker), so an unauthorized role
          // reaches no worker — its node is non-routable (suppressed without
          // aborting later entries; role delivery is not a sequential abort).
          if (t.startsWith('@role:')) {
            // Per-NODE authorization: only nodes with an authorized worker
            // receive the role message; unauthorized resolutions are
            // suppressed individually (a shared slot name must not authorize
            // every node that declares it).
            const roleActiveLookup = this.config.roleHolderActiveLookup;
            const nodeAuthorizedRole = (resolved: string): boolean => {
              const slots = nodeSlots.get(resolved) ?? [];
              return (
                isRoutableTarget(resolved) ||
                slots.some(
                  (sl) => resolver.canSend(fromNode, sl) || resolver.canSend(meta.agentName, sl)
                ) ||
                resolver.canSend(meta.agentName, resolved)
              );
            };
            const authorizedHolders = resolvedTargets.filter(
              (r) => nodeNames.has(r) && nodeAuthorizedRole(r)
            );
            // RESOLVER PARITY (active-preferred role delivery): when any
            // authorized holder has a live sub-session, only active holders
            // receive the message — suppress the inactive ones' gates.
            const roleSlotName = decodeURIComponent(t.slice(6));
            const activeHolders = roleActiveLookup
              ? authorizedHolders.filter(
                  (r) => roleActiveLookup(nodeNameToId.get(r) ?? r, roleSlotName) === true
                )
              : authorizedHolders;
            const roleDeliverable =
              activeHolders.length > 0 ? new Set(activeHolders) : new Set(authorizedHolders);
            for (const resolved of resolvedTargets) {
              if (!nodeNames.has(resolved)) continue;
              if (!roleDeliverable.has(resolved)) {
                arrayResolvedNodes.delete(resolved);
                nonRoutableResolvedNodes.add(resolved);
              }
            }
            continue;
          }
          // A generic non-worker address (@handle/@coordinator) is delivered
          // separately per entry and does not abort the loop — no
          // authorization, no block.
          if (isAddress && !isWorker) continue;
          // Foreign-run / agent-less worker miss: the router skips the entry
          // (notFound) without aborting — later entries keep their gates.
          if (isWorker && isForeignWorkerMiss(t)) continue;
          // Authorization (mirrors the router's worker check):
          // canSend(fromNode, resolvedNode) OR canSend(fromNode, agentSlot).
          // For a @worker entry the slot is the decoded agent name; for a
          // PLAIN entry the adapter expands it to @worker:<node>/<agent> for
          // EVERY agent of the resolved node, and the router authorizes via
          // canSend(fromNode, agentName) — so authorize when ANY slot of the
          // resolved node (or the entry string itself as a slot) satisfies
          // canSend. This mirrors the string branch's bareSlotOk for the
          // array path (round-53 fixed the string branch only).
          // Worker expansion order matters for plain NODE entries: the adapter
          // expands the node to one @worker per agent in DECLARATION order and
          // the router aborts at the FIRST unauthorized worker — the node
          // receives the message only when its first declared slot (or the
          // entry string itself, for a bare slot) is authorized.
          // authorized: the node receives the message (its first declared
          // slot — or the entry/bare-slot string — is authorized, or a
          // node-level route exists). suffixAborts: the node's LATER slots
          // include an unauthorized worker — the adapter expands every slot
          // and the router aborts there, so no entry AFTER this node ever
          // delivers (this node itself still does).
          // PER-NODE tracking: a plain entry (typically a bare slot shared by
          // several nodes) expands to one worker per node IN ORDER, and the
          // router hard-returns at the first unauthorized worker — nodes
          // after the abort (and the aborting node itself, if its own worker
          // never delivered) must have their gates suppressed individually,
          // while nodes the router reached first keep theirs.
          let authorized = false;
          let suffixAborts = false;
          const undeliveredNodes = new Set<string>();
          let entryAborted = false;
          for (const r of resolvedTargets) {
            if (!nodeNames.has(r)) continue;
            if (entryAborted) {
              // The router already returned at an earlier node's worker —
              // this resolution was never reached.
              undeliveredNodes.add(r);
              continue;
            }
            let nodeDelivered = false;
            let nodeAborted = false;
            if (isRoutableTarget(r)) {
              nodeDelivered = true;
            } else if (isWorker) {
              const agent = workerAgentOf(t);
              if (agent !== undefined && resolver.canSend(fromNode, agent)) nodeDelivered = true;
              else nodeAborted = true;
            } else {
              const slots = nodeSlots.get(r) ?? [];
              if (resolver.canSend(fromNode, t) && !nodeNames.has(t)) {
                nodeDelivered = true;
              } else {
                // Plain NODE entry: the adapter expands the node's slots in
                // declaration order; walk them with the first-slot rule.
                // BARE SLOT entry: the adapter expands ONLY the named slot
                // (legacyBareTargetMatches never includes the node's other
                // slots) — authorize against that slot alone, never the
                // node's first-declared one.
                const orderedSlots = nodeNames.has(t) ? slots : [t];
                for (let si = 0; si < orderedSlots.length; si++) {
                  const slotOk = resolver.canSend(fromNode, orderedSlots[si]);
                  if (si === 0 && slotOk) nodeDelivered = true;
                  if (!slotOk) {
                    // An unauthorized slot after a delivered one: the router
                    // aborts here — later ARRAY entries never deliver.
                    nodeAborted = true;
                    break;
                  }
                }
              }
            }
            if (nodeDelivered) authorized = true;
            if (nodeAborted) {
              // The router returns at this node's unauthorized worker: the
              // node keeps its gate only if an earlier slot already
              // delivered to it.
              suffixAborts = true;
              entryAborted = true;
              if (!nodeDelivered) undeliveredNodes.add(r);
            }
          }
          const resolvable = resolvedTargets.some((r) => nodeNames.has(r));
          if (!isAddress && !resolvable) {
            // Plain entry matching no node/slot: the MCP translation rejects
            // the whole send before the router — nothing may deliver.
            wholeSendRefused = true;
          } else if (!authorized) {
            // Sequential failure point: this entry and every later one never
            // deliver (the router returns here). A node with an EARLIER
            // delivered occurrence keeps its gate — the failing duplicate
            // ('@worker:Review/bad' after '@worker:Review/good' delivered)
            // must not retroactively suppress it.
            sequentialBlocked = true;
            for (const resolved of resolvedTargets) {
              if (nodeNames.has(resolved) && !deliveredBefore.has(resolved)) {
                postFailureNodes.add(resolved);
              }
            }
          } else if (suffixAborts && authorized) {
            // This entry delivered to at least one node but an unauthorized
            // worker aborted the router — entries AFTER this entry never
            // deliver. The aborting NODE ITSELF keeps its gate only when its
            // own worker delivered first; otherwise (a shared bare slot
            // resolving to an unauthorized node) it is suppressed
            // individually.
            sequentialBlocked = true;
            for (const undelivered of undeliveredNodes) {
              if (!deliveredBefore.has(undelivered)) postFailureNodes.add(undelivered);
            }
          }
        }
        // Post-failure nodes (never delivered) are suppressed. Under
        // wholeSendRefused the MCP TRANSLATION rejected the send before the
        // router ran, so NOTHING delivered — even nodes collected before the
        // refusing entry are suppressed (the delivered-occurrence protection
        // applies only to sequential router failures, not to pre-router
        // refusals).
        for (const resolved of postFailureNodes) {
          nonRoutableResolvedNodes.add(resolved);
        }
        if (wholeSendRefused) {
          for (const resolved of arrayResolvedNodes) {
            nonRoutableResolvedNodes.add(resolved);
          }
        }
      }
    }

    return workflow.hookBindings.filter((binding) => {
      if (!binding.enabled) return false;
      if (binding.method !== methodName) return false;

      if (binding.sourceNode !== nodeName) return false;

      if (binding.targetNode) {
        if (methodName !== 'send_message') return false;
        if (nonRoutableResolvedNodes.has(binding.targetNode)) return false;
        if (!actionTargets.has(binding.targetNode)) return false;
      }

      if (!binding.authorizedCallers || binding.authorizedCallers.length === 0) {
        // Fail-open-by-skip is silent and looks like a missing gate: surface
        // it so a mis-authored binding is debuggable.
        log.warn(
          `Hook binding "${binding.hookId}" on ${binding.sourceNode} ${methodName} has no ` +
            'authorizedCallers and can never match; it is ignored.'
        );
        return false;
      }

      return binding.authorizedCallers.some((caller) => {
        if (caller.sourceNode !== nodeName) return false;
        if (!caller.agentSlots || caller.agentSlots.length === 0) return true;
        return caller.agentSlots.includes(meta.agentName);
      });
    });
  }

  private sortBindings(bindings: HookBinding[]): HookBinding[] {
    return [...bindings].sort((a, b) => {
      const orderA = a.order ?? 0;
      const orderB = b.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.hookId.localeCompare(b.hookId);
    });
  }

  // -------------------------------------------------------------------------
  // HookContext
  // -------------------------------------------------------------------------

  /**
   * Build the daemon-implemented {@link HookContext} for a binding, plus the
   * accumulators its side-effecting methods populate. A fresh context per
   * binding run keeps each hook's effects isolated.
   */
  private buildHookContext(
    binding: HookBinding,
    meta: HookActionMeta,
    artifacts: Array<{ nodeId: string; artifact: HookArtifact }>
  ): {
    ctx: HookContext;
    recordedState: Record<string, unknown>;
    queuedFollowUps: Array<{ targetNode: string; message: string }>;
    writtenArtifacts: HookArtifactWrite[];
  } {
    const workflow = this.config.workflow;
    const nodeName = workflow.nodes.find((n) => n.id === meta.nodeId)?.name ?? meta.agentName;
    const recordedState: Record<string, unknown> = {};
    const queuedFollowUps: Array<{ targetNode: string; message: string }> = [];
    const writtenArtifacts: HookArtifactWrite[] = [];

    const hookState = this.config.hookStateRepo.ensure(
      this.config.workflowRunId,
      binding.hookId,
      {}
    );

    const ctx: HookContext = {
      runId: this.config.workflowRunId,
      workspacePath: this.config.workspacePath ?? '',
      taskId: meta.taskId,
      taskStatus: this.config.getTaskStatus?.(meta.taskId),
      runStartedAt: this.config.workflowRunCreatedAt,
      sourceNode: nodeName,
      targetNode: binding.targetNode ?? meta.targetNode,
      readState: (key: string) => hookState.localState[key],
      recordState: (key: string, value: unknown) => {
        recordedState[key] = value;
      },
      queueFollowUp: (targetNode: string, message: string) => {
        queuedFollowUps.push({ targetNode, message });
      },
      writeArtifact: (artifact: HookArtifactInput) => {
        writtenArtifacts.push(artifact);
        // Side effects must compose within one action: a later binding in the
        // same chain sees this write even though the persisted upsert lands
        // after the loop. Mirror the repo's (run, NODE, type, key) upsert key
        // exactly — replace only the row for THIS node (a same-type/key row on
        // another node is a distinct persisted row and must survive), in place
        // so "oldest stamp wins" readers (getPrimaryLink) keep the earliest
        // identity; a new (node, type, key) is appended.
        const nodeId = artifact.nodeId ?? meta.nodeId;
        const ctxArtifact: HookArtifact = {
          artifactType: artifact.artifactType,
          artifactKey: artifact.artifactKey,
          data: artifact.data,
        };
        const idx = artifacts.findIndex(
          (a) =>
            a.nodeId === nodeId &&
            a.artifact.artifactType === artifact.artifactType &&
            a.artifact.artifactKey === artifact.artifactKey
        );
        if (idx >= 0) {
          artifacts[idx] = { nodeId, artifact: ctxArtifact };
        } else {
          artifacts.push({ nodeId, artifact: ctxArtifact });
        }
      },
      readArtifacts: () => artifacts.map((entry) => entry.artifact),
      // REPO-BACKED fresh read for hooks verifying a durable fact mid-chain:
      // the snapshot above predates the chain, so it cannot observe a
      // concurrent write (e.g. a pr_ready identity replacement landing while
      // this hook awaits GitHub). Unreadable persistence throws — the engine
      // maps a hook exception to an override-ineligible execution stop.
      refreshArtifacts: () => {
        const fresh = this.readArtifactsForCtx();
        if (fresh === null) {
          throw new Error('artifact store unreadable during refreshArtifacts');
        }
        return fresh.map((entry) => entry.artifact);
      },
    };

    return { ctx, recordedState, queuedFollowUps, writtenArtifacts };
  }

  private readArtifactsForCtx(): Array<{ nodeId: string; artifact: HookArtifact }> | null {
    try {
      // Freshest 50 for general context, PLUS every engine-reserved
      // (`__`-prefixed key) artifact — a busy run can accumulate >50 artifacts
      // and push a reserved stamp (e.g. a hook-stamped identity another hook
      // binds to) out of the bounded window. Generic on the reserved namespace;
      // the engine names no domain keys.
      const repo = this.config.artifactRepo;
      const recent = repo?.listRecentByRun(this.config.workflowRunId, 50) ?? [];
      const recentPartial = repo?.lastReadWasPartial === true;
      const seenKeys = new Set(recent.map((a) => `${a.nodeId}:${a.artifactType}:${a.artifactKey}`));
      // Reserved (`__`-prefixed) stamps OUTSIDE the bounded window, fetched
      // SQL-side via a key-prefix filter instead of loading every link
      // artifact on the hot path.
      const reservedRows = repo?.listByRun(this.config.workflowRunId, {
        artifactType: 'link',
        artifactKeyPrefix: '__',
        limit: 200,
      });
      // A corrupt row in EITHER read means the snapshot may be missing data
      // (potentially the reserved identity stamp) — fail closed rather than
      // evaluate against partial state.
      const reservedPartial = repo ? repo.lastReadWasPartial : false;
      if (recentPartial || reservedPartial) {
        throw new Error('artifact read was partial (corrupt row data)');
      }
      const reservedOutsideWindow = (reservedRows ?? []).filter(
        (a) => !seenKeys.has(`${a.nodeId}:${a.artifactType}:${a.artifactKey}`)
      );
      // Merge each reserved key's rows (from BOTH the recent window and the
      // out-of-window fetch — a re-upsert bumps updatedAt and can pull the
      // oldest stamp back into the freshest-50 while newer stamps of the same
      // key stay outside) into ONE globally creation-ordered group, newest
      // first, appended after the non-reserved rows. "Oldest stamp wins"
      // readers (getPrimaryLink takes the LAST match) must find the globally
      // earliest stamp of each reserved key last; concatenating recent and
      // reserved blocks separately would instead hand them whichever block
      // happened to sit later and swap the identity.
      const reservedByKey = new Map<string, WorkflowRunArtifact[]>();
      for (const row of recent) {
        if (!row.artifactKey.startsWith('__')) continue;
        const key = `${row.artifactType}:${row.artifactKey}`;
        const list = reservedByKey.get(key) ?? [];
        list.push(row);
        reservedByKey.set(key, list);
      }
      for (const row of reservedOutsideWindow) {
        const key = `${row.artifactType}:${row.artifactKey}`;
        const list = reservedByKey.get(key) ?? [];
        list.push(row);
        reservedByKey.set(key, list);
      }
      const reservedOrdered = [...reservedByKey.values()]
        .map((rows) => rows.sort((a, b) => b.createdAt - a.createdAt))
        .flat();
      const recentNonReserved = recent.filter((a) => !a.artifactKey.startsWith('__'));
      return [...recentNonReserved, ...reservedOrdered].map((a: WorkflowRunArtifact) => ({
        nodeId: a.nodeId,
        artifact: {
          artifactType: a.artifactType,
          artifactKey: a.artifactKey,
          data: this.boundArtifactData(a.data) as Record<string, unknown>,
        },
      }));
    } catch (err) {
      // An artifact-read failure must NOT masquerade as an artifact-free run:
      // hooks like pr_ready treat "no stamped identity" as "nothing to bind
      // to", and a handoff could then overwrite the run's reserved identity.
      // Null signals the caller to block the action instead.
      log.warn(
        `Failed to read hook-context artifacts for run ${this.config.workflowRunId}: ${errorMessage(err)}`
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Custom (script) hook execution — unsandboxed
  // -------------------------------------------------------------------------

  /**
   * Run a custom bash-script hook. Built-in hooks are trusted in-process code
   * (full daemon env); custom scripts are user-authored bash and get a
   * RESTRICTED env — an allow-list without the daemon's credentials (spec §3:
   * the script sandbox stays; see buildScriptEnv).
   *
   * CONTRACT: custom scripts are STATELESS flow decisions. Their only bridge
   * to the run is the read-only snapshot env (params, artifacts, run/node/
   * task identity), and stdout is consumed as flow metadata only — `flow`,
   * `reason`, `payload`, `retryAfterMs`; every other field (including
   * `result`) is logged and ignored. There is deliberately no bridge to the
   * HookContext side-effecting methods (readState/recordState/
   * queueFollowUp/writeArtifact): bash cannot call the injected JS functions,
   * and state snapshots would invite lost-update bugs. Hooks that need side
   * effects must be built-ins; a bounded script side-effect protocol is a
   * tracked follow-up (see docs/features/workflow-hooks-v2.md §3).
   *
   * A non-zero exit, timeout, or malformed stdout is a `stop` with the error
   * as the reason.
   */
  private async runCustomHookScript(
    hook: CustomHook,
    ctx: HookContext,
    action: HookAction
  ): Promise<HookReturn> {
    const spec = hook.run;
    if (spec.interpreter !== 'bash') {
      return {
        flow: 'stop',
        reason: HOOK_EXEC_ERROR_PREFIX + `Unknown interpreter: ${spec.interpreter}`,
      };
    }
    const timeoutMs = spec.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    const args = ['bash', '-c', spec.source];
    // Isolated scratch HOME: the daemon's real home holds disk-backed
    // credentials (~/.claude/.credentials.json, gh/SSH config) that
    // user-authored bash must not read. Removed after the script (and its
    // process group) terminate.
    const isolatedHome = mkdtempSync(join(tmpdir(), 'hyperneo-hook-'));
    const env = this.buildScriptEnv(ctx, action, isolatedHome);

    // Spawned via node:child_process with `detached: true` so the script gets
    // its OWN process group — the whole group can then be signaled, which is
    // the only reliable way to reap background children the script spawned
    // (Bun.spawn has no detached/group support). The group is killed both on
    // timeout AND after a normal parent exit: a hook's contract is to finish
    // within timeoutMs; lingering children are leaks, not features.
    interface ScriptProcess {
      stdout: ReadableStream<Uint8Array> | null;
      stderr: ReadableStream<Uint8Array> | null;
      exited: Promise<number>;
      killProcessGroup: () => void;
    }
    let proc: ScriptProcess;
    // Everything below runs under a finally that removes the isolated HOME —
    // every early return must clean it up.
    try {
      let child;
      try {
        child = nodeSpawn(args[0], args.slice(1), {
          cwd: ctx.workspacePath || undefined,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return {
          flow: 'stop',
          reason: HOOK_EXEC_ERROR_PREFIX + `Failed to spawn bash: ${errorMessage(err)}`,
        };
      }
      proc = {
        stdout: child.stdout ? (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>) : null,
        stderr: child.stderr ? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>) : null,
        exited: new Promise<number>((resolve) => {
          child.on('exit', (code) => resolve(code ?? -1));
          // A spawn failure (e.g. missing binary) fires 'error' and may not
          // fire 'exit' — resolve rather than leave the promise pending, or
          // the kill timer and collectors below would leak.
          child.on('error', () => resolve(-1));
        }),
        killProcessGroup: () => {
          // Negative pid signals the process GROUP (the detached child is its
          // leader); fall back to the child alone if the group is already gone.
          if (typeof child.pid === 'number') {
            try {
              process.kill(-child.pid, 'SIGKILL');
              return;
            } catch {
              /* group already reaped */
            }
          }
          try {
            child.kill('SIGKILL');
          } catch {
            /* already exited */
          }
        },
      };

      const controller = new AbortController();
      let killed = false;
      // A script may spawn a BACKGROUND process that inherits stdout/stderr and
      // outlives the parent shell. Waiting for the pipes to close would then
      // block this hook indefinitely (past timeoutMs) and leak the child, so the
      // collectors get a short grace period after the parent exits before the
      // streams are cancelled: the parent's own output is already buffered by
      // then, and an inherited pipe held open by a straggler can't wedge the
      // action.
      const collectStdout = collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES, controller.signal);
      const collectStderr = collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES, controller.signal);
      const collected = Promise.all([collectStdout, collectStderr]);
      const exit = await (async () => {
        const killTimer = setTimeout(() => {
          killed = true;
          proc.killProcessGroup();
        }, timeoutMs);
        try {
          const code = await proc.exited;
          if (!killed) {
            // Grace the collectors past the parent's exit, then cancel: the
            // parent's output is buffered; a straggler child holding an
            // inherited pipe cannot wedge the action. The timer handle is
            // captured and cleared when `collected` wins the race (the common
            // case) — an uncleared handle would leak one orphaned 2s timer per
            // hook run (same cleanup discipline as killTimer and the follow-up
            // dispatch timeout's .finally()).
            let graceTimer: ReturnType<typeof setTimeout> | undefined;
            const graceDone = new Promise<void>((resolve) => {
              graceTimer = setTimeout(resolve, SCRIPT_EXIT_GRACE_MS);
            });
            try {
              await Promise.race([collected, graceDone]);
            } finally {
              if (graceTimer !== undefined) clearTimeout(graceTimer);
            }
          }
          controller.abort(); // idempotent; releases any blocked collector
          // Reap the process group unconditionally: on timeout the group kill
          // has already run, and on a normal exit this terminates any background
          // children the script left behind (they cannot outlive the hook).
          proc.killProcessGroup();
          return { code, timedOut: killed };
        } finally {
          // If proc.exited rejects (or any step above throws), the kill timer
          // must not leak and the collectors must be released — without this,
          // the awaited `collected` below would hang forever.
          clearTimeout(killTimer);
          controller.abort();
          proc.killProcessGroup();
        }
      })();
      const [stdoutResult, stderrResult] = await collected;

      if (exit.timedOut) {
        return {
          flow: 'stop',
          reason: HOOK_EXEC_ERROR_PREFIX + `script timed out after ${timeoutMs}ms`,
        };
      }
      if (exit.code !== 0) {
        const stderrText = stderrResult.text.trim();
        return {
          flow: 'stop',
          reason:
            HOOK_EXEC_ERROR_PREFIX + (stderrText || `Hook script exited with code ${exit.code}`),
        };
      }

      const parsed = parseJsonStdout(stdoutResult.text);
      if (!parsed) {
        return {
          flow: 'stop',
          reason: HOOK_EXEC_ERROR_PREFIX + 'script produced empty or non-JSON stdout',
        };
      }
      const flow = parsed.flow;
      if (typeof flow !== 'string' || !VALID_FLOWS.has(flow as HookFlow)) {
        return {
          flow: 'stop',
          reason:
            HOOK_EXEC_ERROR_PREFIX +
            `Hook script returned unrecognized flow: ${JSON.stringify(flow)}`,
        };
      }
      const ret: HookReturn = { flow: flow as HookFlow };
      if (typeof parsed.reason === 'string') ret.reason = parsed.reason;
      if (isRecord(parsed.payload)) ret.payload = parsed.payload;
      if (typeof parsed.retryAfterMs === 'number') {
        // Clamp untrusted script retry delays to a sane range so a malformed
        // (negative / non-finite / huge) value can't spin a rapid replay loop or
        // starve the timer. Out-of-range values fall back to the engine default.
        const requested = parsed.retryAfterMs;
        if (
          Number.isFinite(requested) &&
          requested >= MIN_SCRIPT_RETRY_MS &&
          requested <= MAX_SCRIPT_RETRY_MS
        ) {
          ret.retryAfterMs = requested;
        }
      }
      ret.result = parsed.result;
      return ret;
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }

  /**
   * Base environment variables a custom script needs to RUN (shell, locale,
   * temp dir) — an allow-list, not a deny-list: user-authored bash must not
   * receive the daemon's live credentials (provider API keys, keychain-promoted
   * OAuth tokens, GH tokens). HOME is NOT forwarded: the daemon's real home
   * carries disk-backed credentials (~/.claude/.credentials.json, gh config,
   * SSH keys), so scripts get an isolated temporary HOME (see
   * runCustomHookScript) — a script that shells out to `gh` therefore fails
   * auth (terminal, exit 4) rather than silently using the daemon's identity.
   * Non-token `GH_HOST`/`GH_PATH` are admitted for host routing only. The
   * spec's script sandbox (§3) stays.
   */
  private static readonly SCRIPT_ENV_ALLOW = new Set([
    'PATH',
    'USER',
    'SHELL',
    'TMPDIR',
    'LANG',
    'TERM',
    'TZ',
  ]);

  private buildScriptEnv(
    ctx: HookContext,
    action: HookAction,
    isolatedHome: string
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (WorkflowHookEngine.SCRIPT_ENV_ALLOW.has(key) || key.startsWith('LC_')) {
        env[key] = value;
        continue;
      }
      if (key === 'GH_HOST' || key === 'GH_PATH') {
        env[key] = value;
      }
      // Everything else is dropped — including HOME/XDG_CONFIG_HOME and ALL
      // inherited HYPERNEO_* variables: the daemon's HYPERNEO_ namespace
      // carries secrets (e.g. HYPERNEO_PROVIDER_CREDENTIAL_KEY, the AES key
      // encrypting every stored provider credential). The script's HYPERNEO_*
      // CONTRACT vars are set explicitly below, never inherited.
    }
    env.HOME = isolatedHome;
    env.HYPERNEO_WORKFLOW_RUN_ID = ctx.runId;
    env.HYPERNEO_WORKSPACE_PATH = ctx.workspacePath;
    env.HYPERNEO_METHOD_NAME = action.method;
    env.HYPERNEO_NODE_ID =
      this.config.workflow.nodes.find((n) => n.name === ctx.sourceNode)?.id ?? '';
    env.HYPERNEO_NODE_NAME = ctx.sourceNode;
    env.HYPERNEO_TASK_ID = ctx.taskId;
    if (ctx.taskStatus) env.HYPERNEO_TASK_STATUS = ctx.taskStatus;
    if (ctx.targetNode) env.HYPERNEO_TARGET_NODE = ctx.targetNode;
    if (typeof ctx.runStartedAt === 'number' && Number.isFinite(ctx.runStartedAt)) {
      env.HYPERNEO_WORKFLOW_START_ISO = new Date(ctx.runStartedAt).toISOString();
    }
    try {
      env.HYPERNEO_PARAMS_JSON = JSON.stringify(action.params);
    } catch {
      env.HYPERNEO_PARAMS_JSON = '{}';
    }
    // Aggregate budget: each artifact is individually bounded, but up to 50
    // of them in ONE env entry can exceed execve's per-entry/total limits
    // (E2BIG fails the whole spawn). Serialize until the budget is spent and
    // drop the rest — the env window is informational for scripts.
    try {
      const artifacts = ctx.readArtifacts();
      const encoder = new TextEncoder();
      const kept: HookArtifact[] = [];
      let bytes = 2; // '[]'
      for (const artifact of artifacts) {
        // Measure ENCODED bytes, not string length: execve limits apply to
        // UTF-8 bytes, and UTF-16 code-unit counts under-measure multibyte
        // (CJK/emoji) content.
        const entryBytes = encoder.encode(JSON.stringify(artifact)).length;
        if (bytes + entryBytes + 1 > MAX_ARTIFACTS_ENV_BYTES && kept.length > 0) break;
        kept.push(artifact);
        bytes += entryBytes + 1;
      }
      env.HYPERNEO_CURRENT_ARTIFACTS_JSON = JSON.stringify(kept);
    } catch {
      env.HYPERNEO_CURRENT_ARTIFACTS_JSON = '[]';
    }
    return env;
  }

  // -------------------------------------------------------------------------
  // Bounding helpers (for script-hook env serialization)
  // -------------------------------------------------------------------------

  private boundParams(params: Record<string, unknown>): Record<string, unknown> {
    const clone = { ...params };
    if (clone.data !== undefined) {
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(clone.data)).length;
        if (bytes > MAX_PARAM_DATA_BYTES) {
          clone.data = '[truncated: large data field omitted from hook env]';
        }
      } catch {
        clone.data = '[truncated: non-serializable data field]';
      }
    }
    for (const key of Object.keys(clone)) {
      clone[key] = this.boundValue(clone[key]);
    }
    try {
      const totalBytes = new TextEncoder().encode(JSON.stringify(clone)).length;
      if (totalBytes > MAX_PARAMS_JSON_BYTES) {
        return { _truncated: `params exceed ${MAX_PARAMS_JSON_BYTES} bytes` };
      }
    } catch {
      return { _truncated: 'params are non-serializable' };
    }
    return clone;
  }

  private boundValue(value: unknown): unknown {
    if (typeof value === 'string' && value.length > 4096) {
      return value.slice(0, 4096) + '...[truncated]';
    }
    if (Array.isArray(value)) {
      const arr = value.map((item) => this.boundValue(item));
      if (arr.length > MAX_ARRAY_ITEMS) {
        return [...arr.slice(0, MAX_ARRAY_ITEMS), '[truncated: array exceeds 100 items]'];
      }
      return arr;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const entries = Object.entries(record);
      if (entries.length > MAX_OBJECT_KEYS) {
        const out: Record<string, unknown> = {};
        for (let i = 0; i < MAX_OBJECT_KEYS; i++) {
          const [k, v] = entries[i];
          out[k] = this.boundValue(v);
        }
        out._truncated = 'object exceeds 50 keys';
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of entries) {
        out[k] = this.boundValue(v);
      }
      return out;
    }
    return value;
  }

  private boundArtifactData(data: unknown): unknown {
    if (data === null || typeof data !== 'object') return data;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
      if (bytes <= MAX_ARTIFACT_DATA_BYTES) return data;
    } catch {
      // Fall through to truncated placeholder on serialization failure.
    }
    return `[truncated: artifact data exceeds ${MAX_ARTIFACT_DATA_BYTES} bytes]`;
  }

  private validatePatchedParams(methodName: string, params: Record<string, unknown>): string[] {
    const schema = METHOD_PARAM_SCHEMAS[methodName];
    if (!schema) return [];
    const result = schema.safeParse(params);
    if (!result.success) {
      return result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'params';
        return `${path}: ${issue.message}`;
      });
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Target resolution helpers (KEEP)
  // -------------------------------------------------------------------------

  private resolveTargetEntries(
    target: string,
    nodeIdToName: Map<string, string>,
    slotToNodes: Map<string, string[]>,
    nodeNames: Set<string>,
    slotExecutionNodes?: Map<string, string[]>
  ): string[] {
    const trimmed = target.trim();
    if (nodeIdToName.has(trimmed)) {
      return [nodeIdToName.get(trimmed)!];
    }
    if (nodeNames.has(trimmed)) {
      return [trimmed];
    }
    // ADAPTER PARITY: live executions for the slot win outright (creation
    // order, declaration-only declarers excluded) — mirroring
    // legacyBareTargetMatches's actorMatches early return.
    const executionMatches = slotExecutionNodes?.get(trimmed);
    if (executionMatches && executionMatches.length > 0) {
      return [...executionMatches];
    }
    const slotMatches = slotToNodes.get(trimmed);
    if (slotMatches) {
      return [...slotMatches];
    }
    if (trimmed.startsWith('@worker:')) {
      try {
        const addr = parseAddress(trimmed);
        if (addr.kind === 'worker') {
          const decoded = decodeURIComponent(addr.nodeId);
          if (nodeIdToName.has(decoded)) {
            return [nodeIdToName.get(decoded)!];
          }
          const slotMatches = slotToNodes.get(decoded);
          if (slotMatches) {
            return [...slotMatches];
          }
          return [decoded];
        }
      } catch {
        // fall through to raw target
      }
    }
    if (trimmed.startsWith('@role:')) {
      const role = trimmed.slice(6);
      const actorRolePrefix = 'actor-role:';
      if (role.startsWith(actorRolePrefix)) {
        const actorRoleValue = decodeURIComponent(role.slice(actorRolePrefix.length));
        if (nodeIdToName.has(actorRoleValue)) {
          return [nodeIdToName.get(actorRoleValue)!];
        }
        const actorRoleSlotMatches = slotToNodes.get(actorRoleValue);
        if (actorRoleSlotMatches) {
          return [...actorRoleSlotMatches];
        }
        return [actorRoleValue];
      }
      if (nodeIdToName.has(role)) {
        return [nodeIdToName.get(role)!];
      }
      const roleSlotMatches = slotToNodes.get(role);
      if (roleSlotMatches) {
        return [...roleSlotMatches];
      }
      return [role];
    }
    return [trimmed];
  }
}

// ---------------------------------------------------------------------------
// Queued-retryable-action helpers
// ---------------------------------------------------------------------------

function isQueuedRetryableHookAction(value: unknown): value is QueuedRetryableHookAction {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.actionKey === 'string' &&
    typeof record.hookId === 'string' &&
    typeof record.methodName === 'string' &&
    !!record.args &&
    typeof record.args === 'object' &&
    isHookActionMeta(record.meta) &&
    typeof record.isFollowUp === 'boolean' &&
    typeof record.nextRetryAt === 'number' &&
    typeof record.retryAfterMs === 'number' &&
    typeof record.queuedAt === 'number'
  );
}

function isHookActionMeta(value: unknown): value is HookActionMeta {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === 'string' &&
    typeof record.agentName === 'string' &&
    typeof record.nodeId === 'string' &&
    typeof record.taskId === 'string' &&
    (record.targetNode === undefined || typeof record.targetNode === 'string')
  );
}

/** Whether a target entry parses as a generic/worker address (the router's
 * generic dispatch precondition — see the array-multicast branch). */
function parsesAsAddress(value: string): boolean {
  try {
    parseAddress(value);
    return true;
  } catch {
    return false;
  }
}

function sameRetryableActionOwner(left: HookActionMeta, right: HookActionMeta): boolean {
  // The sessionId match is RELAXED to a same-agent-same-node check: when a
  // worker cannot be rehydrated its execution is reset and respawned with a
  // NEW session id while the task, node, and agent slot are unchanged — the
  // old in-memory timer is gone after restart, no future session matches
  // the persisted meta.sessionId, and an exact-owner check would orphan the
  // durable action forever (neither replayed nor cleared). Any live session
  // of the SAME (task, node, agent) is the action's legitimate owner.
  return (
    left.agentName === right.agentName &&
    left.nodeId === right.nodeId &&
    left.taskId === right.taskId
  );
}

/**
 * Recursively canonicalize a value for identity comparison: object keys are
 * sorted (stable across insertion orders) and arrays keep their order. Two
 * semantically identical tool calls must produce the SAME action identity —
 * an agent reissuing an approved blocked action with differently ordered
 * object fields would otherwise get a different key, and the one-shot
 * approval would refuse the override.
 */
function canonicalizeActionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeActionValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalizeActionValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function buildRetryableActionKey(
  methodName: string,
  args: Record<string, unknown>,
  meta: HookActionMeta
): string {
  return JSON.stringify({
    runScopedTaskId: meta.taskId,
    nodeId: meta.nodeId,
    sessionId: meta.sessionId,
    agentName: meta.agentName,
    methodName,
    args: canonicalizeActionValue(args),
  });
}

/** Backoff ceiling for the retry timer path (see scheduleRetryableAction). */
const MAX_RETRY_BACKOFF_MS = 3_600_000;

/**
 * Re-arm delay when a terminal replay's durable queued-record clear failed:
 * the re-armed entry is the in-memory dedupe guard (and the settlement
 * retry), not a pacing mechanism — long enough not to spam the source
 * session with terminal notifications while the state store is down.
 */
const TERMINAL_CLEAR_REARM_MS = 5 * 60_000;

/**
 * Exponential backoff with jitter for timer-driven hook retries: base *
 * 2^min(attempts, 6) capped at 1h, then ±25% jitter. The base comes from the
 * hook's retryAfterMs (or the engine default), so GitHub-advertised
 * rate-limit delays are still respected as a floor.
 */
/** Exported for tests: the retry-backoff delay computation. */
export function backoffDelayMs(baseMs: number, attempts: number): number {
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_RETRY_AFTER_MS;
  const exponent = Math.min(Math.max(attempts, 0), 6);
  const scaled = Math.min(safeBase * 2 ** exponent, MAX_RETRY_BACKOFF_MS);
  // NONNEGATIVE jitter only: symmetric ±25% could schedule the first retry
  // 25% BELOW the requested floor — e.g. a GitHub rate-limit reset hint of
  // 60s firing another API call at 45s while the limit is still active,
  // burning another retry attempt. The delay never drops under safeBase.
  const jitter = scaled * 0.25;
  return Math.round(Math.min(scaled + Math.random() * jitter, MAX_RETRY_BACKOFF_MS));
}

function scheduleRetryableAction(options: PendingRetryableHookAction): void {
  if (pendingRetryableHookActions.has(options.actionKey)) return;

  const timer = setTimeout(() => {
    pendingRetryableHookActions.delete(options.actionKey);
    void replayRetryableAction(options).catch((err) => {
      log.warn(
        `Retryable hook action retry failed for ${options.methodName}: ${errorMessage(err)}`
      );
    });
  }, options.delayMs);

  pendingRetryableHookActions.set(options.actionKey, { timer, options });
}

export function clearRetryableHookActionTimer(actionKey: string): void {
  const pending = pendingRetryableHookActions.get(actionKey);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRetryableHookActions.delete(actionKey);
}

/** Test seam: whether an in-memory retry timer entry exists for a key. */
export function isQueuedRetryableActionForTests(actionKey: string): boolean {
  return pendingRetryableHookActions.has(actionKey);
}

export function triggerRetryableHookAction(actionKey: string): boolean {
  const pending = pendingRetryableHookActions.get(actionKey);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRetryableHookActions.delete(actionKey);
  void replayRetryableAction(pending.options).catch((err) => {
    log.warn(
      `Manual retryable hook action retry failed for ${pending.options.methodName}: ${errorMessage(err)}`
    );
  });
  return true;
}

export function clearAllRetryableHookActionTimers(): void {
  for (const pending of pendingRetryableHookActions.values()) {
    clearTimeout(pending.timer);
  }
  pendingRetryableHookActions.clear();
}

async function replayRetryableAction(options: PendingRetryableHookAction): Promise<void> {
  if (options.engine.isRetryableActionCancelled(options.meta)) {
    options.engine.clearQueuedRetryableActionsForKey(options.actionKey);
    clearRetryableHookActionTimer(options.actionKey);
    return;
  }

  const retryHandler = wrapHandlerWithHooks(
    options.methodName,
    options.handler,
    options.engine,
    options.handlers,
    options.meta,
    options.isFollowUp
  );
  const result = await retryHandler(options.args);
  const failure = getToolResultFailure(result);
  if (failure && !failure.retryable) {
    try {
      await options.engine.notifySourceSession(
        options.meta.sessionId,
        `Queued ${options.methodName} retry failed: ${failure.message}`
      );
    } catch (err) {
      log.warn(
        `Failed to notify source session for queued ${options.methodName} retry failure: ${errorMessage(err)}`
      );
    } finally {
      // A failed final clear leaves the DURABLE record: do not also drop the
      // in-memory dedupe — remove the timer only when the record is gone, so
      // a restart cannot replay an action already reported terminally blocked.
      if (options.engine.clearQueuedRetryableActionsForKey(options.actionKey)) {
        clearRetryableHookActionTimer(options.actionKey);
      } else {
        // The fire-time delete already consumed this action's pending entry,
        // so a failed clear must RE-ARM it: without the entry, rehydration
        // would see the surviving durable record, re-schedule it, and replay
        // an action already reported terminally blocked. The re-armed replay
        // re-evaluates the gate and retries the clear once the state store
        // recovers.
        scheduleRetryableAction({ ...options, delayMs: TERMINAL_CLEAR_REARM_MS });
      }
    }
  }
}

function getToolResultFailure(
  result: AnyToolResult
): { message: string; retryable: boolean } | undefined {
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (!text) {
    return result.isError ? { message: 'tool returned an error', retryable: false } : undefined;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return result.isError ? { message: text, retryable: false } : undefined;
  }

  if (!data || typeof data !== 'object') {
    return result.isError ? { message: text, retryable: false } : undefined;
  }

  const record = data as Record<string, unknown>;
  const success = record.success;
  const retryable = record.retryable === true;
  if (success === false || result.isError) {
    const message =
      typeof record.error === 'string'
        ? record.error
        : typeof record.message === 'string'
          ? record.message
          : text;
    return { message, retryable };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Handler wrapper
// ---------------------------------------------------------------------------

const RAW_HANDLER = Symbol('rawHandler');

type WrappedHandler<T extends Record<string, unknown>> = ((args: T) => Promise<AnyToolResult>) & {
  [RAW_HANDLER]?: (args: T) => Promise<AnyToolResult>;
};

function hookResult(
  data: Record<string, unknown>,
  isError = false
): import('../tools/tool-result').ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError };
}

type AnyToolResult = import('../tools/tool-result').ToolResult;

/**
 * Fail-closed engine for a run pinned before the hooks-v2 cutover whose
 * immutable definition carries the LEGACY `hooks` array (and no v2
 * `hookBindings`). The v2 engine only enforces bindings — resuming such a run
 * ungated would silently bypass every legacy PR-ready/review gate. Per the
 * locked hard-cut there is no legacy translation, so every hookable action
 * stops with instructions to re-create the hooks as v2 bindings instead of
 * executing without enforcement.
 */
export function createLegacyHookGuardEngine(
  config: WorkflowHookEngineConfig,
  reason: string
): WorkflowHookEngine {
  return new (class extends WorkflowHookEngine {
    override async executeAction(_methodName: string): Promise<HookActionOutcome> {
      return {
        decision: 'stop',
        finalParams: {},
        followUpRequests: [],
        stateUpdates: [],
        // Attribute the stop to the synthetic legacy-guard "hook" so the
        // wrapper persists a state row (lastFlow stop, override-ineligible)
        // and the task pane's hook banner can surface the cutover block with
        // its remediation instead of only a bare tool error.
        executionLog: [
          { hookId: LEGACY_GUARD_HOOK_ID, flow: 'stop', reason, timestamp: Date.now() },
        ],
        userState: {
          status: 'blocked',
          reason,
          humanOverrideEligible: false,
          hookId: LEGACY_GUARD_HOOK_ID,
        },
        blockingHookId: LEGACY_GUARD_HOOK_ID,
      };
    }
  })(config);
}

/**
 * Wrap an MCP tool handler with the workflow hook engine. Runs the hook chain
 * before the original handler; persists hook state + side effects; handles
 * stop / retry / deliver; dispatches follow-ups on deliver.
 */
export function wrapHandlerWithHooks<T extends Record<string, unknown>>(
  methodName: string,
  handler: (args: T) => Promise<AnyToolResult>,
  engine: WorkflowHookEngine | undefined,
  handlers: Record<string, (...args: unknown[]) => Promise<AnyToolResult> | AnyToolResult>,
  meta: HookActionMeta,
  isFollowUp = false
) {
  if (!engine) return handler;

  const wrapped = async (args: T) => {
    const actionKey = buildRetryableActionKey(methodName, args as Record<string, unknown>, meta);
    const outcome = await engine.executeAction(methodName, args as Record<string, unknown>, meta);

    // Consolidate per-hook persistence: localState (recordState + queued-action
    // key on retry), lastFlow/lastReason, retryCount/nextRetryAt. One write per
    // hook avoids version races between engine and wrapper.
    const byHook = new Map<
      string,
      {
        localState: Record<string, unknown>;
        lastFlow?: HookFlow;
        lastReason?: string | null;
        retryCount?: number;
        nextRetryAt?: number | null;
      }
    >();
    const ensure = (hookId: string) => {
      let entry = byHook.get(hookId);
      if (!entry) {
        entry = { localState: {} };
        byHook.set(hookId, entry);
      }
      return entry;
    };

    const overrideEligible = outcome.userState.humanOverrideEligible !== false;
    for (const record of outcome.executionLog) {
      const entry = ensure(record.hookId);
      entry.lastFlow = record.flow;
      // Persist an explicit clear when the decision carries no reason —
      // otherwise the banner would keep the PREVIOUS decision's remediation
      // (e.g. "Retry requested by human" over a later reasonless script stop).
      entry.lastReason = record.reason ?? null;
      // Engine-reserved: whether a subsequent block of this hook is a HOOK
      // DECISION (human may override) or a fail-closed/infrastructure stop
      // (banner must not offer Approve). The outcome's userState carries the
      // verdict (overrideIneligible terminals map to false); infrastructure
      // stops that push executionLog records (unresolved hook, artifact
      // write) stamp false so a stale eligible flag cannot linger.
      entry.localState.__overrideEligible = overrideEligible;
    }
    for (const update of outcome.stateUpdates) {
      const entry = ensure(update.hookId);
      entry.localState = { ...entry.localState, ...update.state };
    }

    // stop — clear THIS action's queued retry only (per-action scope, matching
    // the deliver path): a terminal decision for one send must not tombstone a
    // sibling send from the same source merely sharing the hook's cooldown.
    if (outcome.decision === 'stop') {
      // If this action's durable replay record survived the clear, KEEP the
      // in-memory timer: it is the only thing preventing the rehydrated
      // record from replaying an action already reported terminally blocked.
      // (Removing the timer while the record persists would let a restart
      // re-run it; the timer's replay re-evaluates the now-terminal gate.)
      if (engine.clearQueuedRetryableActionsForKey(actionKey)) {
        clearRetryableHookActionTimer(actionKey);
      }

      const ceilingHookIds = new Set(
        outcome.executionLog
          .filter((record) => record.reason?.includes('retry limit exceeded'))
          .map((record) => record.hookId)
      );
      for (const [hookId, patch] of byHook) {
        if (ceilingHookIds.has(hookId)) {
          // Ceiling-generated stop: PRESERVE the retry bookkeeping and stamp a
          // terminal marker — resetting would let a reissued action start a
          // fresh 7-day cycle (repeat indefinitely); the marker makes any
          // subsequent ceiling check immediately terminal again.
          patch.localState.__retryCeilingTerminal = true;
        } else if (!engine.hasOtherQueuedActions(hookId, actionKey)) {
          // Reset only when no sibling action is still queued on this hook —
          // their durable records (cleared of THIS action's key above) keep
          // depending on the shared count/cooldown.
          patch.retryCount = 0;
          patch.nextRetryAt = null;
          patch.localState.__firstRetryAt = undefined; // fresh cycle on re-block
        }
        if (!engine.persistStateUpdate(hookId, patch)) {
          log.warn(`Failed to persist hook state for ${hookId} on stop`);
        }
      }

      return hookResult(
        {
          success: false,
          error: outcome.userState.reason ?? 'Action blocked by hook.',
          hookStatus: outcome.userState.status,
          hookId: outcome.userState.hookId,
          hookReason: outcome.userState.reason,
          sourceNode: outcome.userState.sourceNode,
          targetNode: outcome.userState.targetNode,
        },
        true
      );
    }

    // retry — queue the action (send_message) or surface a retryable error.
    if (outcome.decision === 'retry') {
      const retryAfterMs = outcome.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
      const blockingId = outcome.blockingHookId;

      if (methodName === 'send_message') {
        // A hook's durable record holds ONE queued action. When the hook
        // re-blocks the SAME action, the prior timer must be replaced with a
        // fresh one at the new backoff — but the reap is DEFERRED until the
        // replacement patch persists: if the persist fails the durable record
        // survives, and cancelling the timer first would leave an accepted
        // send with no in-memory retry (lost until a manual attempt or daemon
        // restart). A different action key means a second gated send while the
        // first is pending — leave its timer alone.
        // Test the EXACT action key against the hook's queued map (not the
        // newest entry, which getQueuedRetryableAction returns): a hook with
        // multiple queued sends must reap the reissued action's timer —
        // otherwise scheduleRetryableAction sees the stale timer, refuses the
        // replacement, and the old timer fires early into the cooldown path.
        const existingActionKeyToReap =
          blockingId &&
          (
            engine.getQueuedRetryableActionsMap(blockingId)?.[actionKey] as
              | { actionKey?: string }
              | undefined
          )?.actionKey === actionKey
            ? actionKey
            : undefined;

        if (engine.isRetryableActionCancelled(meta)) {
          engine.clearQueuedRetryableActionsForKey(actionKey);
          clearRetryableHookActionTimer(actionKey);
          for (const [hookId, patch] of byHook) {
            if (!engine.hasOtherQueuedActions(hookId, actionKey)) {
              patch.retryCount = 0;
              patch.nextRetryAt = null;
              patch.localState.__firstRetryAt = undefined; // fresh cycle on re-block
            }
            engine.persistStateUpdate(hookId, patch);
          }
          return hookResult({
            success: true,
            queued: false,
            cancelled: true,
            retryable: false,
            hookStatus: outcome.userState.status,
            hookId: outcome.userState.hookId,
            hookReason: outcome.userState.reason,
            sourceNode: outcome.userState.sourceNode,
            targetNode: outcome.userState.targetNode,
            message: 'Queued action cancelled because task or workflow run is no longer active.',
          });
        }

        const now = Date.now();
        // Compute the backoff ONCE and use the SAME deadline everywhere: the
        // scheduled timer, the persisted cooldown (nextRetryAt — which the
        // cooldown pre-check and rehydration read), and the queued action's
        // replay time. Persisting the raw base deadline would let a manual
        // resend (or a restart) bypass the exponential backoff.
        const blockingAttempts = engine.getRetryCount(blockingId ?? '');
        const delayMs = backoffDelayMs(retryAfterMs, blockingAttempts);
        for (const [hookId, patch] of byHook) {
          if (hookId === blockingId) {
            patch.retryCount = blockingAttempts + 1;
            patch.nextRetryAt = now + delayMs;
            // Stamp the FIRST retry time once — the elapsed ceiling for
            // timer-driven retries reads it.
            if (blockingAttempts === 0) patch.localState.__firstRetryAt = now;
            // Patch ONLY this action's entry: spreading a snapshot of the
            // whole map would resurrect a sibling key that a concurrent
            // write cleared between the read and this persist (deep-merge
            // applies the patch to the CURRENT stored map, so unrelated
            // entries survive without being named).
            patch.localState[QUEUED_RETRYABLE_ACTION_STATE_KEY] = {
              [actionKey]: {
                actionKey,
                hookId: blockingId,
                methodName,
                args: args as Record<string, unknown>,
                meta,
                isFollowUp,
                nextRetryAt: now + delayMs,
                retryAfterMs,
                queuedAt: now,
              },
            };
          } else if (!engine.hasOtherQueuedActions(hookId, actionKey)) {
            // Reset only when no sibling action is still queued on this
            // hook — an earlier hook's queued action (this retry came from a
            // LATER binding) keeps depending on the shared count/cooldown.
            patch.retryCount = 0;
            patch.nextRetryAt = null;
            patch.localState.__firstRetryAt = undefined;
          }
          if (!engine.persistStateUpdate(hookId, patch)) {
            if (hookId === blockingId) {
              // The blocking hook's queued record (including the durable
              // __queuedRetryableAction and the retry count that drives
              // backoff/ceiling) did not persist: advertising a durable
              // queued retry would be a lie a restart exposes (the action is
              // lost) and defeats the ceiling. Fail closed instead.
              log.error(`Failed to persist queued retry state for hook "${hookId}"; blocking.`);
              return hookResult(
                {
                  success: false,
                  error:
                    'Hook retry could not be persisted (state write failed); the action is ' +
                    'blocked — retry it again.',
                  // NOT marked retryable: a timer-driven replay that lands here
                  // has already had its timer consumed, and replayRetryableAction
                  // only notifies/cleans non-retryable failures — a retryable
                  // marker would stall the action silently until restart.
                  hookStatus: outcome.userState.status,
                  hookId: outcome.userState.hookId,
                  hookReason: outcome.userState.reason,
                },
                true
              );
            }
            log.warn(`Failed to persist hook state for ${hookId} on retry`);
          }
        }

        // Persist succeeded — now safe to reap the prior timer (the
        // replacement durable record is in place). scheduleRetryableAction
        // installs a fresh timer at the new backoff.
        if (existingActionKeyToReap) {
          clearRetryableHookActionTimer(existingActionKeyToReap);
        }
        scheduleRetryableAction({
          actionKey,
          delayMs, // same computed backoff that was persisted above
          methodName,
          args,
          handler: handler as (args: Record<string, unknown>) => Promise<AnyToolResult>,
          engine,
          handlers,
          meta,
          isFollowUp,
        });

        return hookResult({
          success: true,
          queued: true,
          retryable: true,
          retryAfterMs,
          hookStatus: outcome.userState.status,
          hookId: outcome.userState.hookId,
          hookReason: outcome.userState.reason,
          sourceNode: outcome.userState.sourceNode,
          targetNode: outcome.userState.targetNode,
          message:
            outcome.userState.reason ??
            `Action queued until hook "${outcome.userState.hookId ?? 'unknown'}" allows it.`,
        });
      }

      // Non-send_message retry: surface a retryable error to the agent. Unlike
      // the queued send_message path there is no engine timer, so the BLOCKING
      // hook's bookkeeping must persist here — increment the count and keep a
      // cooldown — or repeated manual attempts hit GitHub immediately forever
      // and MAX_RETRY_ATTEMPTS never observes a nonzero count.
      const blockingHookId = outcome.blockingHookId;
      let blockingPersistFailed = false;
      for (const [hookId, patch] of byHook) {
        if (hookId === blockingHookId) {
          Object.assign(patch, engine.nextRetryBookkeeping(hookId, retryAfterMs));
          if (engine.getRetryCount(hookId) === 0) patch.localState.__firstRetryAt = Date.now();
        } else {
          patch.retryCount = 0;
          patch.nextRetryAt = null;
        }
        if (!engine.persistStateUpdate(hookId, patch)) {
          // The agent drives retries on this path with no engine timer: an
          // unpersisted count/cooldown means immediate re-attempts with no
          // backoff and a ceiling that never fires. Advertise a blocking
          // state error instead of a plain retryable one (mirroring the
          // queued send_message path).
          if (hookId === blockingHookId) blockingPersistFailed = true;
          log.warn(`Failed to persist hook state for ${hookId} on retry`);
        }
      }
      if (blockingPersistFailed) {
        log.error(`Failed to persist retry bookkeeping for hook "${blockingHookId}"; blocking.`);
        return hookResult(
          {
            success: false,
            error:
              'Hook retry bookkeeping could not be persisted (state write failed); the ' +
              'action is blocked — retry it again.',
            hookStatus: outcome.userState.status,
            hookId: outcome.userState.hookId,
            hookReason: outcome.userState.reason,
            sourceNode: outcome.userState.sourceNode,
            targetNode: outcome.userState.targetNode,
          },
          true
        );
      }
      return hookResult(
        {
          success: false,
          error: outcome.userState.reason ?? 'Action blocked by hook (retryable).',
          retryable: true,
          retryAfterMs,
          hookStatus: outcome.userState.status,
          hookId: outcome.userState.hookId,
          hookReason: outcome.userState.reason,
          sourceNode: outcome.userState.sourceNode,
          targetNode: outcome.userState.targetNode,
        },
        true
      );
    }

    // deliver — clear queued retries, dispatch follow-ups, call handler.
    // Fail closed BEFORE the queue clear and the handler call: the patch
    // carries the hook's recorded state (recordState) and the decision record
    // (lastFlow/lastReason). Delivering with it unpersisted would report a
    // successful action whose owned side effect was lost — a later readState()
    // sees stale state and can repeat a one-shot effect or decide from the
    // pre-action snapshot. Blocking here also leaves THIS action's queued
    // replay record (if any) intact, so the engine timer re-evaluates the
    // gate once the state store recovers.
    let deliverPersistFailed = false;
    for (const [hookId, patch] of byHook) {
      // SHARED-STATE GUARD: the retry bookkeeping lives on the (run, hook)
      // row shared by every action gated on this hook. THIS action
      // delivered, but sibling actions still queued on the hook (their
      // durable records survive this delivery) keep relying on the count /
      // cooldown / ceiling cycle — resetting it here would fire their timers
      // early and destroy their ceiling accumulation. Reset only when this
      // was the last queued action.
      if (!engine.hasOtherQueuedActions(hookId, actionKey)) {
        patch.retryCount = 0;
        patch.nextRetryAt = null;
        patch.localState.__firstRetryAt = undefined; // fresh cycle on re-block
      }
      if (!engine.persistStateUpdate(hookId, patch)) {
        deliverPersistFailed = true;
        log.warn(`Failed to persist hook state for ${hookId} on deliver`);
      }
    }
    if (deliverPersistFailed) {
      log.error('Failed to persist hook decision state before delivery; blocking.');
      return hookResult(
        {
          success: false,
          error:
            'Hook state could not be persisted before delivery (state write failed); the ' +
            'action is blocked — retry it. The hook decision and its recorded state must be ' +
            'durable before the protected action runs.',
          hookStatus: 'blocked',
          hookId: outcome.userState.hookId,
          hookReason: outcome.userState.reason,
        },
        true
      );
    }

    // NOTE: no owner-wide clear here — queued actions are per-action-key now,
    // and clearing by OWNER would abandon a sibling send's independent entry.
    // THIS action's record is cleared by key below.
    // Fail closed when THIS action's durable replay record cannot be removed:
    // delivering while the persisted __queuedRetryableAction survives would
    // replay the already-delivered action after a restart.
    if (!engine.clearQueuedRetryableActionsForKey(actionKey)) {
      // KEEP the in-memory timer: the durable record survived, and unlike
      // the timer-driven replay path nothing here would re-arm it — the
      // queued send must keep retrying. The timer's replay re-evaluates the
      // gate and retries the clear once the state store recovers.
      return hookResult(
        {
          success: false,
          error:
            'Hook retry queue could not be cleared (state persist failed); the action is blocked ' +
            'rather than delivered with a pending replay record.',
          hookStatus: 'blocked',
          hookId: outcome.userState.hookId,
          hookReason: outcome.userState.reason,
        },
        true
      );
    }
    clearRetryableHookActionTimer(actionKey);

    // One-shot approval consumptions the chain deferred to delivery. They run
    // HERE — after every fail-closed pre-delivery prerequisite (decision
    // persistence, queued-record clear) has succeeded, so the approval is
    // spent only when the protected handler is actually about to run. A
    // failed consume — write conflict, approval no longer armed, or a token
    // mismatch (a NEWER approval granted to a different action mid-chain) —
    // blocks: delivering would spend an approval intended for another
    // violation.
    if (outcome.pendingApprovalConsumes && outcome.pendingApprovalConsumes.length > 0) {
      const consumed = engine.consumeApprovals(
        outcome.pendingApprovalConsumes.map(({ hookId, approvedAt }) => ({
          hookId,
          approvedAt,
        }))
      );
      if (consumed !== 'consumed') {
        log.warn(
          `Failed to consume human approval(s) ${outcome.pendingApprovalConsumes.map((e) => e.hookId).join(', ')} at delivery (${consumed}); blocking.`
        );
        // Diagnose the failure mode instead of a blanket "state conflict":
        // conflict = the write raced; not-pending/token-mismatch = the
        // approval is gone or was replaced by a newer one mid-chain.
        const consumeDiagnosis =
          consumed === 'conflict'
            ? 'state conflict'
            : consumed === 'token-mismatch'
              ? 'the approval was replaced by a newer one while the hooks ran'
              : 'the approval is no longer armed';
        return hookResult(
          {
            success: false,
            error:
              `Human approval could not be recorded (${consumeDiagnosis}). The hook still applies — ` +
              'approve it again and retry.',
            hookStatus: 'blocked',
            hookId: outcome.pendingApprovalConsumes[0]?.hookId,
            hookReason: 'Human approval could not be recorded (state conflict).',
          },
          true
        );
      }
    }

    if (outcome.followUpRequests.length > 0 && isFollowUp) {
      log.warn('Nested follow-up emission suppressed during follow-up dispatch.');
    }

    if (outcome.followUpRequests.length > 0 && !isFollowUp) {
      const followUpMethod = 'send_message';
      const followUpHandler = handlers[followUpMethod];
      if (followUpHandler) {
        const rawFollowUpHandler =
          ((followUpHandler as unknown as WrappedHandler<Record<string, unknown>>)[RAW_HANDLER] as
            | ((args: Record<string, unknown>) => Promise<AnyToolResult>)
            | undefined) ?? followUpHandler;

        const followUpPromises = outcome.followUpRequests.map((req) => {
          const dispatchPromise = wrapHandlerWithHooks(
            followUpMethod,
            rawFollowUpHandler as (args: Record<string, unknown>) => Promise<AnyToolResult>,
            engine,
            handlers,
            { ...meta, targetNode: req.targetNode },
            true
          )({
            target: req.targetNode,
            message: req.message,
          } as unknown as Record<string, unknown>);

          // Race a timeout, but CLEAR the timer when the dispatch settles first —
          // otherwise the orphaned timer rejects the already-settled promise ~30s
          // later with nothing awaiting it (unhandled rejection on every fast
          // dispatch).
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Follow-up dispatch timed out')),
              DEFAULT_FOLLOW_UP_TIMEOUT_MS
            );
          });
          return Promise.race([dispatchPromise, timeoutPromise]).finally(() => {
            if (timer !== undefined) clearTimeout(timer);
          });
        });

        try {
          await Promise.all(followUpPromises);
        } catch (err) {
          log.warn(`Follow-up dispatch failed: ${errorMessage(err)}`);
        }
      }
    }

    return handler(outcome.finalParams as T);
  };

  (wrapped as unknown as WrappedHandler<T>)[RAW_HANDLER] = handler;
  return wrapped;
}
