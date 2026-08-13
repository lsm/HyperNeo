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
import { isBuiltInHook, resolveHook } from './hook-registry';
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
  notifySourceSession?: (sessionId: string, message: string) => Promise<void>;
  onHookStateUpdated?: (
    hookId: string,
    hookState: import('@hyperneo/shared').HookStateSnapshot
  ) => void;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Module-level retry queue (persists across the run; replayed on restart)
// ---------------------------------------------------------------------------

export const QUEUED_RETRYABLE_ACTION_STATE_KEY = '__queuedRetryableAction';
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
        this.clearQueuedRetryableAction(action.hookId);
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

  clearQueuedRetryableAction(hookId: string): boolean {
    return this.persistStateUpdate(hookId, {
      localState: { [QUEUED_RETRYABLE_ACTION_STATE_KEY]: null },
    });
  }

  getQueuedRetryableAction(hookId: string): QueuedRetryableHookAction | undefined {
    const state = this.config.hookStateRepo.get(this.config.workflowRunId, hookId)?.localState;
    const value = state?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
    if (!isQueuedRetryableHookAction(value)) return undefined;
    return value;
  }

  getQueuedRetryableActions(): QueuedRetryableHookAction[] {
    const hookIds = new Set((this.config.workflow.hookBindings ?? []).map((b) => b.hookId));
    return [...hookIds]
      .map((hookId) => this.getQueuedRetryableAction(hookId))
      .filter((action): action is QueuedRetryableHookAction => action !== undefined);
  }

  /**
   * Clear the persisted queued actions matching an action key. Returns true
   * when every clear landed; false means at least one durable replay record
   * survived (the deliver path fails closed on it).
   */
  clearQueuedRetryableActionsForKey(actionKey: string): boolean {
    let allCleared = true;
    for (const hookId of this.getHookIdsWithQueuedAction(actionKey)) {
      if (!this.clearQueuedRetryableAction(hookId)) {
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

  clearQueuedRetryableActionsForOwner(hookIds: Iterable<string>, meta: HookActionMeta): string[] {
    const clearedActionKeys: string[] = [];
    for (const hookId of hookIds) {
      const queued = this.getQueuedRetryableAction(hookId);
      if (!queued || !sameRetryableActionOwner(queued.meta, meta)) continue;
      if (!this.clearQueuedRetryableAction(hookId)) {
        // Do NOT report the key as cleared: the caller cancels the in-memory
        // timer per returned key, and a persistently-queued action that was
        // reported cleared would replay after a restart with no timer left
        // to deduplicate it.
        log.warn(
          `Failed to clear queued retryable action for hook "${hookId}"; ` +
            'it may replay after a restart.'
        );
        continue;
      }
      clearedActionKeys.push(queued.actionKey);
    }
    return clearedActionKeys;
  }

  getHookIdsWithQueuedAction(actionKey: string): string[] {
    return (this.config.workflow.hookBindings ?? [])
      .map((b) => b.hookId)
      .filter((hookId) => this.getQueuedRetryableAction(hookId)?.actionKey === actionKey);
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
    const bindings = this.resolveMatchingBindings(methodName, params, meta);

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
      if (nextRetryAt !== undefined && Date.now() < nextRetryAt) {
        const attempts = hookState?.retryCount ?? 0;
        const firstRetryAt =
          typeof hookState?.localState.__firstRetryAt === 'number'
            ? (hookState.localState.__firstRetryAt as number)
            : undefined;
        const elapsed = firstRetryAt !== undefined ? Date.now() - firstRetryAt : 0;
        if (
          attempts >= MAX_RETRY_ATTEMPTS ||
          (firstRetryAt !== undefined && elapsed >= MAX_RETRY_ELAPSED_MS)
        ) {
          terminal = {
            kind: 'stop',
            hookId,
            reason: `Hook retry limit exceeded (${
              firstRetryAt !== undefined && elapsed >= MAX_RETRY_ELAPSED_MS
                ? 'elapsed time exceeded'
                : `${MAX_RETRY_ATTEMPTS} attempts`
            }): ${hookState?.lastReason ?? 'retrying'}`,
          };
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
      const approvalPending = hookState?.localState.humanApproved === true;

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
        ret = { flow: 'stop', reason: '__hook_internal_error__' };
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
        const hookThrew = ret.reason === '__hook_internal_error__';
        if (hookThrew) {
          // Infrastructure stop — not a hook decision, not overridable.
          terminal = {
            kind: 'stop',
            hookId,
            overrideIneligible: true,
            reason: `Hook "${hookId}" failed internally on ${methodName}; the action is blocked rather than delivered without a completed gate.`,
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
          // this one action. Consume the one-shot approval first (undefined
          // values drop under JSON serialization); if the consume-write loses
          // a version race, fail closed and let the operator re-approve.
          const consumed = this.persistStateUpdate(hookId, {
            localState: {
              humanApproved: undefined,
              humanApprovedAt: undefined,
              humanRejectionReason: undefined,
            },
          });
          if (!consumed) {
            log.warn(
              `Failed to consume human approval for hook "${hookId}" (state write conflict); blocking.`
            );
            terminal = {
              kind: 'stop',
              hookId,
              reason:
                'Human approval could not be recorded (state conflict). The hook still applies — ' +
                'approve it again and retry.',
            };
            executionLog.push({
              hookId,
              flow: 'stop',
              reason: terminal.reason,
              timestamp: Date.now(),
            });
            break;
          }
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
          attempts >= MAX_RETRY_ATTEMPTS ||
          (firstRetryAt !== undefined && Date.now() - firstRetryAt >= MAX_RETRY_ELAPSED_MS)
        ) {
          terminal = {
            kind: 'stop',
            hookId,
            reason: `Hook retry limit exceeded (${MAX_RETRY_ATTEMPTS} attempts): ${ret.reason ?? 'retrying'}`,
          };
          executionLog[executionLog.length - 1] = {
            hookId,
            flow: 'stop',
            reason: terminal.reason,
            timestamp: Date.now(),
          };
        } else {
          retry = { hookId, reason: ret.reason, retryAfterMs: ret.retryAfterMs };
        }
        break;
      }

      // flow === 'continue' — apply an optional payload patch.
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
          terminal = {
            kind: 'stop',
            hookId,
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
      return {
        decision: 'stop',
        finalParams: currentParams,
        followUpRequests: [],
        stateUpdates,
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

    return {
      decision: 'deliver',
      finalParams: currentParams,
      followUpRequests,
      stateUpdates,
      executionLog,
      userState: { status: 'allowed' },
    };
  }

  /**
   * Write an artifact a hook requested via `ctx.writeArtifact`. Returns false
   * when the persist failed — the caller blocks a would-be delivery on it
   * (see executeAction).
   */
  private writeArtifact(artifact: HookArtifactWrite, meta: HookActionMeta): boolean {
    if (!this.config.artifactRepo) return true;
    try {
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
    for (const node of workflow.nodes) {
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
    const nodeNames = new Set(workflow.nodes.map((n) => n.name));
    const resolver = new ChannelResolver(workflow.channels ?? []);

    const actionTargets = new Set<string>();
    let allRequestedTargetsRoutable = true;
    const isRoutableTarget = (targetNode: string): boolean =>
      nodeNames.has(targetNode) &&
      (resolver.canSend(fromNode, targetNode) || resolver.canSend(meta.agentName, targetNode));
    const isBuiltInInterLevelTarget = (targetValue: string): boolean =>
      targetValue.trim() === 'space-agent';

    if (methodName === 'send_message') {
      const target = params.target;
      if (typeof target === 'string') {
        if (target.trim() === '*') {
          const permittedNode = resolver.getPermittedTargets(fromNode);
          const permittedSlot = resolver.getPermittedTargets(meta.agentName);
          const permitted = [...new Set([...permittedNode, ...permittedSlot])];
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
                nodeNames
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
            nodeNames
          );
          for (const resolved of resolvedTargets) {
            actionTargets.add(resolved);
          }
          // Resolved-node routability criterion (mirrors the array branch):
          // only a resolution that IS a workflow node name can disqualify —
          // a generic address resolving to no node adds no targets and must
          // not suppress the gate (the router delivers it separately).
          if (
            resolvedTargets.some(
              (resolved) =>
                nodeNames.has(resolved) &&
                !isBuiltInInterLevelTarget(target) &&
                !isRoutableTarget(resolved)
            )
          ) {
            allRequestedTargetsRoutable = false;
          }
        }
      } else if (Array.isArray(target)) {
        for (const t of target) {
          if (typeof t !== 'string') {
            // A non-string entry contributes no resolvable node target — the
            // schema layer rejects it, and it must not suppress the gates on
            // the valid parts of the multicast.
            continue;
          }
          if (t.trim() === '*') {
            const permittedNode = resolver.getPermittedTargets(fromNode);
            const permittedSlot = resolver.getPermittedTargets(meta.agentName);
            const permitted = [...new Set([...permittedNode, ...permittedSlot])];
            if (permitted.includes('*')) {
              for (const node of workflow.nodes) {
                actionTargets.add(node.name);
              }
            } else {
              for (const pt of permitted) {
                for (const resolved of this.resolveTargetEntries(
                  pt,
                  nodeIdToName,
                  slotToNodes,
                  nodeNames
                )) {
                  actionTargets.add(resolved);
                }
              }
            }
          } else {
            const resolvedTargets = this.resolveTargetEntries(
              t,
              nodeIdToName,
              slotToNodes,
              nodeNames
            );
            for (const resolved of resolvedTargets) {
              actionTargets.add(resolved);
            }
            // Only a requested target that RESOLVES to a non-routable
            // WORKFLOW NODE disqualifies target-scoped bindings (the ambiguity
            // the guard exists for). Generic addresses (e.g. '@coordinator')
            // fall through resolveTargetEntries as their raw string — they
            // name no node, the router delivers them separately, and they
            // must not suppress the gate on the node-addressed part of a
            // mixed multicast.
            if (
              resolvedTargets.some(
                (resolved) =>
                  nodeNames.has(resolved) &&
                  !isBuiltInInterLevelTarget(t) &&
                  !isRoutableTarget(resolved)
              )
            ) {
              allRequestedTargetsRoutable = false;
            }
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
        if (!allRequestedTargetsRoutable) return false;
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
      const seenKeys = new Set(recent.map((a) => `${a.nodeId}:${a.artifactType}:${a.artifactKey}`));
      // Reserved (`__`-prefixed) stamps OUTSIDE the bounded window, fetched
      // SQL-side via a key-prefix filter instead of loading every link
      // artifact on the hot path.
      const reservedOutsideWindow = (
        repo?.listByRun(this.config.workflowRunId, {
          artifactType: 'link',
          artifactKeyPrefix: '__',
          limit: 200,
        }) ?? []
      ).filter((a) => !seenKeys.has(`${a.nodeId}:${a.artifactType}:${a.artifactKey}`));
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
   * The script reads context via `HYPERNEO_*` env vars and emits a
   * {@link HookReturn} JSON on stdout. A non-zero exit, timeout, or malformed
   * stdout is a `stop` with the error as the reason.
   */
  private async runCustomHookScript(
    hook: CustomHook,
    ctx: HookContext,
    action: HookAction
  ): Promise<HookReturn> {
    const spec = hook.run;
    if (spec.interpreter !== 'bash') {
      return { flow: 'stop', reason: `Unknown interpreter: ${spec.interpreter}` };
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
        return { flow: 'stop', reason: `Failed to spawn bash: ${errorMessage(err)}` };
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
        return { flow: 'stop', reason: `Hook script timed out after ${timeoutMs}ms` };
      }
      if (exit.code !== 0) {
        const stderrText = stderrResult.text.trim();
        return { flow: 'stop', reason: stderrText || `Hook script exited with code ${exit.code}` };
      }

      const parsed = parseJsonStdout(stdoutResult.text);
      if (!parsed) {
        return { flow: 'stop', reason: 'Hook script produced empty or non-JSON stdout' };
      }
      const flow = parsed.flow;
      if (typeof flow !== 'string' || !VALID_FLOWS.has(flow as HookFlow)) {
        return {
          flow: 'stop',
          reason: `Hook script returned unrecognized flow: ${JSON.stringify(flow)}`,
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
    nodeNames: Set<string>
  ): string[] {
    const trimmed = target.trim();
    if (nodeIdToName.has(trimmed)) {
      return [nodeIdToName.get(trimmed)!];
    }
    if (nodeNames.has(trimmed)) {
      return [trimmed];
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

function sameRetryableActionOwner(left: HookActionMeta, right: HookActionMeta): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.agentName === right.agentName &&
    left.nodeId === right.nodeId &&
    left.taskId === right.taskId
  );
}

function buildRetryableActionKey(
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
    args,
  });
}

/** Backoff ceiling for the retry timer path (see scheduleRetryableAction). */
const MAX_RETRY_BACKOFF_MS = 3_600_000;

/**
 * Exponential backoff with jitter for timer-driven hook retries: base *
 * 2^min(attempts, 6) capped at 1h, then ±25% jitter. The base comes from the
 * hook's retryAfterMs (or the engine default), so GitHub-advertised
 * rate-limit delays are still respected as a floor.
 */
function backoffDelayMs(baseMs: number, attempts: number): number {
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : DEFAULT_RETRY_AFTER_MS;
  const exponent = Math.min(Math.max(attempts, 0), 6);
  const scaled = Math.min(safeBase * 2 ** exponent, MAX_RETRY_BACKOFF_MS);
  const jitter = scaled * 0.25;
  return Math.round(scaled + (Math.random() * 2 - 1) * jitter);
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
      options.engine.clearQueuedRetryableActionsForKey(options.actionKey);
      clearRetryableHookActionTimer(options.actionKey);
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
    override async executeAction(): Promise<HookActionOutcome> {
      return {
        decision: 'stop',
        finalParams: {},
        followUpRequests: [],
        stateUpdates: [],
        executionLog: [],
        userState: { status: 'blocked', reason, humanOverrideEligible: false },
        blockingHookId: '__legacy_hooks__',
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

    // stop — clear queued retries for this action/owner.
    if (outcome.decision === 'stop') {
      if (outcome.blockingHookId) {
        for (const queuedActionKey of engine.clearQueuedRetryableActionsForOwner(
          [outcome.blockingHookId],
          meta
        )) {
          clearRetryableHookActionTimer(queuedActionKey);
        }
      }
      // If this action's durable replay record survived the clear, KEEP the
      // in-memory timer: it is the only thing preventing the rehydrated
      // record from replaying an action already reported terminally blocked.
      // (Removing the timer while the record persists would let a restart
      // re-run it; the timer's replay re-evaluates the now-terminal gate.)
      if (engine.clearQueuedRetryableActionsForKey(actionKey)) {
        clearRetryableHookActionTimer(actionKey);
      }

      for (const [hookId, patch] of byHook) {
        patch.retryCount = 0;
        patch.nextRetryAt = null;
        patch.localState.__firstRetryAt = undefined; // fresh cycle on re-block
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
        // Clear a prior queued action for the same hook so its timer is reaped
        // before we record the new one (a hook queues at most one action).
        if (blockingId) {
          const existingQueued = engine.getQueuedRetryableAction(blockingId);
          if (existingQueued) clearRetryableHookActionTimer(existingQueued.actionKey);
        }

        if (engine.isRetryableActionCancelled(meta)) {
          engine.clearQueuedRetryableActionsForKey(actionKey);
          clearRetryableHookActionTimer(actionKey);
          for (const [hookId, patch] of byHook) {
            patch.retryCount = 0;
            patch.nextRetryAt = null;
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
            patch.localState[QUEUED_RETRYABLE_ACTION_STATE_KEY] = {
              actionKey,
              hookId: blockingId,
              methodName,
              args: args as Record<string, unknown>,
              meta,
              isFollowUp,
              nextRetryAt: now + delayMs,
              retryAfterMs,
              queuedAt: now,
            };
          } else {
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
    for (const [hookId, patch] of byHook) {
      patch.retryCount = 0;
      patch.nextRetryAt = null;
      patch.localState.__firstRetryAt = undefined; // fresh cycle on re-block
      if (!engine.persistStateUpdate(hookId, patch)) {
        log.warn(`Failed to persist hook state for ${hookId} on deliver`);
      }
    }

    const successfulHookIds = outcome.executionLog.map((record) => record.hookId);
    for (const queuedActionKey of engine.clearQueuedRetryableActionsForOwner(
      successfulHookIds,
      meta
    )) {
      clearRetryableHookActionTimer(queuedActionKey);
    }
    // Fail closed when THIS action's durable replay record cannot be removed:
    // delivering while the persisted __queuedRetryableAction survives would
    // replay the already-delivered action after a restart.
    if (!engine.clearQueuedRetryableActionsForKey(actionKey)) {
      clearRetryableHookActionTimer(actionKey);
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
