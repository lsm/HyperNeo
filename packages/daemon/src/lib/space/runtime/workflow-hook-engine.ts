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
 * Ceiling on hook retries. Past this a retrying hook converts to a terminal
 * stop (the run is not wedged forever on e.g. a PR left OPEN indefinitely).
 * ~24h at the 30s default cadence; cancellation on task/run completion is the
 * primary backstop.
 */
const MAX_RETRY_ATTEMPTS = 2880;

/** Maximum bytes for an artifact data payload injected into a script hook env. */
const MAX_ARTIFACT_DATA_BYTES = 16_384;

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

  clearQueuedRetryableActionsForKey(actionKey: string): void {
    for (const hookId of this.getHookIdsWithQueuedAction(actionKey)) {
      this.clearQueuedRetryableAction(hookId);
    }
  }

  clearQueuedRetryableActionsForOwner(hookIds: Iterable<string>, meta: HookActionMeta): string[] {
    const clearedActionKeys: string[] = [];
    for (const hookId of hookIds) {
      const queued = this.getQueuedRetryableAction(hookId);
      if (!queued || !sameRetryableActionOwner(queued.meta, meta)) continue;
      this.clearQueuedRetryableAction(hookId);
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
    const artifacts: HookArtifactWrite[] = [];
    const followUpRequests: Array<{ targetNode: string; message: string }> = [];
    let currentParams = { ...params };
    // The ctx artifact window is identical for every binding in this action —
    // compute it once instead of 2 SQL round-trips per binding.
    const ctxArtifacts = this.readArtifactsForCtx();

    type Terminal = { kind: 'stop'; hookId: string; reason?: string } | null;
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
        if (attempts >= MAX_RETRY_ATTEMPTS) {
          terminal = {
            kind: 'stop',
            hookId,
            reason: `Hook retry limit exceeded (${MAX_RETRY_ATTEMPTS} attempts): ${
              hookState?.lastReason ?? 'retrying'
            }`,
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

      // Human override (approveHook RPC): an approval permits the NEXT attempt
      // through this hook — the flag is consumed on use so later actions are
      // gated again. A rejection is a standing block until a human approves.
      // The agent re-issues the blocked action itself; approval does not replay
      // it. NOTE: state is keyed (runId, hookId), so on a hook bound to
      // multiple routes the override skips every binding of that hook for one
      // action — same shared-key limitation as retry state (see step-7 tests).
      if (hookState && hookState.localState.humanApproved !== undefined) {
        if (hookState.localState.humanApproved !== true) {
          const rawReason = hookState.localState.humanRejectionReason;
          const reason =
            typeof rawReason === 'string' && rawReason.trim().length > 0
              ? rawReason
              : 'Rejected by human';
          terminal = { kind: 'stop', hookId, reason };
          executionLog.push({ hookId, flow: 'stop', reason, timestamp: Date.now() });
          break;
        }
        // Consume the one-shot approval (undefined values are dropped by JSON
        // serialization, clearing the keys under the repo's deep-merge). The
        // consume-write must land BEFORE the gate is skipped: if it loses a
        // version race (concurrent retry-timer fire or a second approveHook),
        // the persisted flag would still be set and every later action would
        // skip the hook — a one-shot approval silently becoming a standing
        // bypass. Fail closed instead and let the operator re-approve.
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
        executionLog.push({
          hookId,
          flow: 'continue',
          reason: 'Human override: hook skipped by approval',
          timestamp: Date.now(),
        });
        continue;
      }

      const hook = resolveHook(hookId, this.config.workflow.customHooks);
      if (!hook) {
        log.warn(
          `Binding references hook "${hookId}" (${binding.sourceNode}→${binding.targetNode} ${methodName}) but it is not registered; skipping.`
        );
        continue;
      }

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
        ret = { flow: 'stop', reason: 'Hook internal error' };
      }

      const flow: HookFlow = VALID_FLOWS.has(ret.flow) ? ret.flow : 'stop';
      executionLog.push({ hookId, flow, reason: ret.reason, timestamp: Date.now() });

      // Collect the hook's accumulated side effects (always — they are owned by
      // the hook and persist regardless of flow). State + artifacts apply on
      // every outcome; follow-ups only dispatch on deliver (see outcome below).
      if (Object.keys(built.recordedState).length > 0) {
        stateUpdates.push({ hookId, state: built.recordedState });
      }
      for (const artifact of built.writtenArtifacts) artifacts.push(artifact);
      for (const followUp of built.queuedFollowUps) followUpRequests.push(followUp);

      if (flow === 'stop') {
        terminal = { kind: 'stop', hookId, reason: ret.reason };
        break;
      }
      if (flow === 'retry') {
        // Retry ceiling: a perpetually-retrying hook (e.g. pr_merged on a PR left
        // OPEN indefinitely) would otherwise loop forever. Past the cap, convert
        // the retry to a terminal stop so the run isn't wedged and the source is
        // notified (the wrapper notifies on terminal blocks).
        const attempts =
          this.config.hookStateRepo.get(this.config.workflowRunId, hookId)?.retryCount ?? 0;
        if (attempts >= MAX_RETRY_ATTEMPTS) {
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

    // Apply artifact side effects immediately (idempotent upserts).
    for (const artifact of artifacts) {
      this.writeArtifact(artifact, meta);
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

  /** Write an artifact a hook requested via `ctx.writeArtifact`. */
  private writeArtifact(artifact: HookArtifactWrite, meta: HookActionMeta): void {
    if (!this.config.artifactRepo) return;
    try {
      this.config.artifactRepo.upsert({
        id: generateUUID(),
        runId: this.config.workflowRunId,
        nodeId: artifact.nodeId ?? meta.nodeId,
        artifactType: artifact.artifactType,
        artifactKey: artifact.artifactKey,
        data: artifact.data,
      });
    } catch (err) {
      log.warn(
        `Failed to write hook artifact (${artifact.artifactType}/${artifact.artifactKey}): ${errorMessage(err)}`
      );
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
    const hasValidAddressTarget = (targetValue: string): boolean => {
      const trimmed = targetValue.trim();
      if (isBuiltInInterLevelTarget(trimmed)) return true;
      if (!trimmed.startsWith('@')) return true;
      try {
        const address = parseAddress(trimmed);
        if (address.kind === 'worker') {
          return (
            (address.workflowRunId === undefined ||
              address.workflowRunId === this.config.workflowRunId) &&
            !!address.agentName
          );
        }
        if (address.kind === 'role') {
          return address.role.startsWith('actor-role:');
        }
        return false;
      } catch {
        return false;
      }
    };

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
          if (!hasValidAddressTarget(target)) {
            allRequestedTargetsRoutable = false;
          }
        }
      } else if (Array.isArray(target)) {
        for (const t of target) {
          if (typeof t !== 'string') {
            allRequestedTargetsRoutable = false;
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
            if (
              (!isBuiltInInterLevelTarget(t) && !hasValidAddressTarget(t)) ||
              resolvedTargets.some(
                (resolved) => !isBuiltInInterLevelTarget(t) && !isRoutableTarget(resolved)
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

      if (!binding.authorizedCallers || binding.authorizedCallers.length === 0) return false;

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
    artifacts: HookArtifact[]
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
        // after the loop. Mirror the repo's (run, node, type, key) upsert
        // semantics on the ctx snapshot — replace an existing same-key entry
        // in place (preserving its position, so "oldest stamp wins" readers
        // like getPrimaryLink keep the earliest identity) instead of appending
        // a duplicate.
        const ctxArtifact: HookArtifact = {
          artifactType: artifact.artifactType,
          artifactKey: artifact.artifactKey,
          data: artifact.data,
        };
        const idx = artifacts.findIndex(
          (a) => a.artifactType === artifact.artifactType && a.artifactKey === artifact.artifactKey
        );
        if (idx >= 0) {
          artifacts[idx] = ctxArtifact;
        } else {
          artifacts.push(ctxArtifact);
        }
      },
      readArtifacts: () => artifacts,
    };

    return { ctx, recordedState, queuedFollowUps, writtenArtifacts };
  }

  private readArtifactsForCtx(): HookArtifact[] {
    try {
      // Freshest 50 for general context, PLUS every engine-reserved
      // (`__`-prefixed key) artifact — a busy run can accumulate >50 artifacts
      // and push a reserved stamp (e.g. a hook-stamped identity another hook
      // binds to) out of the bounded window. Generic on the reserved namespace;
      // the engine names no domain keys.
      const repo = this.config.artifactRepo;
      const recent = repo?.listRecentByRun(this.config.workflowRunId, 50) ?? [];
      const seenKeys = new Set(recent.map((a) => `${a.nodeId}:${a.artifactType}:${a.artifactKey}`));
      // Reserved (`__`-prefixed) stamps, bounded SQL-side via a key-prefix
      // filter instead of loading every link artifact on the hot path. Reversed
      // to NEWEST-first: the ctx window is freshest-first throughout, and
      // "oldest stamp wins" readers (getPrimaryLink takes the LAST match) must
      // find the earliest reserved stamp last — listByRun's ascending creation
      // order would otherwise hand them the newest stamp and swap the identity.
      const reserved = (
        repo?.listByRun(this.config.workflowRunId, {
          artifactType: 'link',
          artifactKeyPrefix: '__',
        }) ?? []
      )
        .filter((a) => !seenKeys.has(`${a.nodeId}:${a.artifactType}:${a.artifactKey}`))
        .reverse();
      return [...recent, ...reserved].map((a: WorkflowRunArtifact) => ({
        artifactType: a.artifactType,
        artifactKey: a.artifactKey,
        data: this.boundArtifactData(a.data) as Record<string, unknown>,
      }));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Custom (script) hook execution — unsandboxed
  // -------------------------------------------------------------------------

  /**
   * Run a custom bash-script hook. Unsandboxed (built-in hooks are trusted
   * in-process code; a sandbox around scripts was theater — see spec §3/§10).
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
    const env = this.buildScriptEnv(ctx, action);

    let proc;
    try {
      proc = Bun.spawn(args, {
        cwd: ctx.workspacePath || undefined,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      return { flow: 'stop', reason: `Failed to spawn bash: ${errorMessage(err)}` };
    }

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
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, timeoutMs);
      const code = await proc.exited;
      clearTimeout(killTimer);
      if (!killed) {
        // Grace the collectors past the parent's exit, then cancel: the
        // parent's output is buffered; a straggler child holding an inherited
        // pipe cannot wedge the action.
        const graceDone = new Promise<void>((resolve) => {
          setTimeout(resolve, SCRIPT_EXIT_GRACE_MS);
        });
        await Promise.race([collected, graceDone]);
      }
      controller.abort(); // idempotent; releases any blocked collector
      return { code, timedOut: killed };
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
  }

  private buildScriptEnv(ctx: HookContext, action: HookAction): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
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
    try {
      env.HYPERNEO_CURRENT_ARTIFACTS_JSON = JSON.stringify(ctx.readArtifacts());
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
 * Wrap an MCP tool handler with the workflow hook engine. Runs the hook chain
 * before the original handler; persists hook state + side effects; handles
 * stop / retry / deliver; dispatches follow-ups on deliver.
 */
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
        userState: { status: 'blocked', reason },
        blockingHookId: '__legacy_hooks__',
      };
    }
  })(config);
}

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

    for (const record of outcome.executionLog) {
      const entry = ensure(record.hookId);
      entry.lastFlow = record.flow;
      // Persist an explicit clear when the decision carries no reason —
      // otherwise the banner would keep the PREVIOUS decision's remediation
      // (e.g. "Retry requested by human" over a later reasonless script stop).
      entry.lastReason = record.reason ?? null;
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
      engine.clearQueuedRetryableActionsForKey(actionKey);
      clearRetryableHookActionTimer(actionKey);

      for (const [hookId, patch] of byHook) {
        patch.retryCount = 0;
        patch.nextRetryAt = null;
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
        for (const [hookId, patch] of byHook) {
          if (hookId === blockingId) {
            patch.retryCount = engine.getRetryCount(hookId) + 1;
            patch.nextRetryAt = now + retryAfterMs;
            patch.localState[QUEUED_RETRYABLE_ACTION_STATE_KEY] = {
              actionKey,
              hookId: blockingId,
              methodName,
              args: args as Record<string, unknown>,
              meta,
              isFollowUp,
              nextRetryAt: now + retryAfterMs,
              retryAfterMs,
              queuedAt: now,
            };
          } else {
            patch.retryCount = 0;
            patch.nextRetryAt = null;
          }
          if (!engine.persistStateUpdate(hookId, patch)) {
            log.warn(`Failed to persist hook state for ${hookId} on retry`);
          }
        }

        scheduleRetryableAction({
          actionKey,
          delayMs: retryAfterMs,
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
      for (const [hookId, patch] of byHook) {
        if (hookId === blockingHookId) {
          Object.assign(patch, engine.nextRetryBookkeeping(hookId, retryAfterMs));
        } else {
          patch.retryCount = 0;
          patch.nextRetryAt = null;
        }
        if (!engine.persistStateUpdate(hookId, patch)) {
          log.warn(`Failed to persist hook state for ${hookId} on retry`);
        }
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
    engine.clearQueuedRetryableActionsForKey(actionKey);
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
