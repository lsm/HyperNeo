/**
 * Workflow Hook Engine
 *
 * Receives structured action context before selected node-agent MCP handlers
 * execute. Snapshots matching enabled hooks, sorts by classification then order
 * then id, and executes them serially in a single action-scoped pipeline.
 *
 * Hook result precedence:
 *   - validation `block` stops the chain and blocks the action
 *   - validation `retryable_block` stops the chain and blocks (retryable)
 *   - `block` takes precedence over `retryable_block`
 *   - side-effect failures are recorded but do not block
 *   - multiple `patch_params` apply sequentially
 *   - `emit_follow_up` dispatches through the handler pipeline (depth capped at 1)
 *   - `record_state` persists hook-local state
 */

import type {
  WorkflowHook,
  WorkflowHookResult,
  WorkflowHookUserState,
  SpaceWorkflow,
  WorkflowRunArtifact,
} from '@neokai/shared';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository';
import type { HookExecutor, HookExecutorContext } from './hook-executor';
import { ChannelResolver } from './channel-resolver';
import { Logger } from '../../logger';

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

/** Outcome of running the hook chain for a single MCP action. */
export interface HookActionOutcome {
  /** The most significant decision from the hook chain. */
  decision:
    | 'allow'
    | 'block'
    | 'retryable_block'
    | 'patch_params'
    | 'emit_follow_up'
    | 'record_state';
  /** Final params after all patch_params applied (or original if none). */
  finalParams: Record<string, unknown>;
  /** Follow-up action to dispatch, if any. */
  followUpRequest?: { targetNode: string; message: string };
  /** State updates to persist. */
  stateUpdates: Array<{ hookId: string; state: Record<string, unknown> }>;
  /** Normalized user-visible state for banners/debug UI. */
  userState: WorkflowHookUserState;
  /** Per-hook execution log for auditing. */
  executionLog: HookExecutionRecord[];
  /** The hook ID that caused a block, if any. */
  blockedByHookId?: string;
}

/** Record of a single hook execution. */
export interface HookExecutionRecord {
  hookId: string;
  classification: 'validation' | 'side_effect';
  result: WorkflowHookResult;
  timestamp: number;
}

/** Dependencies for the workflow hook engine. */
export interface WorkflowHookEngineConfig {
  workflow: SpaceWorkflow;
  workflowRunId: string;
  nodeExecutionRepo: NodeExecutionRepository;
  artifactRepo?: WorkflowRunArtifactRepository;
  hookStateRepo: WorkflowHookStateRepository;
  hookExecutor: HookExecutor;
  workspacePath?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const log = new Logger('workflow-hook-engine');

/** Whitelisted MCP methods that may be used for follow-up actions. */
const FOLLOW_UP_METHODS = new Set(['send_message']);

/** Maximum follow-up execution latency budget (30 seconds default). */
const DEFAULT_FOLLOW_UP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class WorkflowHookEngine {
  constructor(private readonly config: WorkflowHookEngineConfig) {}

  /**
   * Persist a single hook-local state update (and optional last result) through
   * the repository. Returns true on success, false on version conflict or error.
   */
  persistStateUpdate(
    hookId: string,
    state: Record<string, unknown>,
    lastResult?: WorkflowHookResult
  ): boolean {
    try {
      const repoState = this.config.hookStateRepo.get(this.config.workflowRunId, hookId);
      const result = this.config.hookStateRepo.update(this.config.workflowRunId, hookId, {
        expectedVersion: repoState?.version ?? 0,
        localState: state,
        lastResult,
      });
      return result !== null;
    } catch {
      return false;
    }
  }

  /**
   * Execute the hook chain for an MCP action.
   *
   * @param methodName  The MCP method being invoked (e.g. 'send_message')
   * @param params      The raw params passed to the method
   * @param meta        Caller identity metadata
   * @returns           HookActionOutcome with decision, patched params, and user state
   */
  async executeAction(
    methodName: string,
    params: Record<string, unknown>,
    meta: HookActionMeta
  ): Promise<HookActionOutcome> {
    const hooks = this.resolveMatchingHooks(methodName, params, meta);

    if (hooks.length === 0) {
      return {
        decision: 'allow',
        finalParams: params,
        stateUpdates: [],
        userState: { status: 'allowed' },
        executionLog: [],
      };
    }

    const sortedHooks = this.sortHooks(hooks);
    const executionLog: HookExecutionRecord[] = [];
    const originalParams = { ...params };
    let currentParams = originalParams;
    let followUpRequest: { targetNode: string; message: string } | undefined;
    const stateUpdates: Array<{ hookId: string; state: Record<string, unknown> }> = [];
    let blockedByValidation: {
      hookId: string;
      result: WorkflowHookResult;
      isRetryable: boolean;
    } | null = null;

    for (const hook of sortedHooks) {
      // If a validation hook already returned non-retryable block, skip everything
      if (blockedByValidation?.isRetryable === false) {
        break;
      }
      // If a validation hook returned retryable_block, skip remaining side-effects
      // but allow later validation hooks to run (so block can override retryable_block)
      if (blockedByValidation && (hook.classification ?? 'validation') === 'side_effect') {
        break;
      }

      const context = await this.buildExecutorContext(hook, methodName, currentParams, meta);

      let result: WorkflowHookResult;
      try {
        const execResult = await this.config.hookExecutor.execute(hook, context);
        result = execResult.result;
      } catch (err) {
        log.warn(
          `Hook executor threw for hook "${hook.id}" on ${methodName}: ${err instanceof Error ? err.message : String(err)}`
        );
        result = {
          type: 'block',
          reason: 'Hook executor internal error',
        };
      }

      executionLog.push({
        hookId: hook.id,
        classification: hook.classification ?? 'validation',
        result,
        timestamp: Date.now(),
      });

      // Process result
      switch (result.type) {
        case 'allow':
          break;

        case 'block':
          if ((hook.classification ?? 'validation') === 'validation') {
            blockedByValidation = { hookId: hook.id, result, isRetryable: false };
          }
          // side_effect block is recorded but does not stop
          break;

        case 'retryable_block':
          if ((hook.classification ?? 'validation') === 'validation') {
            // block takes precedence over retryable_block
            if (!blockedByValidation) {
              blockedByValidation = { hookId: hook.id, result, isRetryable: true };
            }
          }
          break;

        case 'patch_params': {
          const classification = hook.classification ?? 'validation';
          if (classification === 'side_effect') {
            log.warn(
              `Hook "${hook.id}" returned patch_params but is a side_effect; patch ignored.`
            );
            break;
          }
          if (result.patch && typeof result.patch === 'object') {
            currentParams = { ...currentParams, ...result.patch };
          }
          break;
        }

        case 'emit_follow_up':
          if (result.targetNode && result.message) {
            followUpRequest = { targetNode: result.targetNode, message: result.message };
          }
          break;

        case 'record_state':
          if (result.state && typeof result.state === 'object') {
            stateUpdates.push({ hookId: hook.id, state: result.state as Record<string, unknown> });
          }
          break;
      }
    }

    // Determine final decision
    if (blockedByValidation) {
      const hook = sortedHooks.find((h) => h.id === blockedByValidation!.hookId)!;
      const isRetryable = blockedByValidation.isRetryable;
      const result = blockedByValidation.result;

      return {
        decision: isRetryable ? 'retryable_block' : 'block',
        finalParams: currentParams,
        stateUpdates,
        userState: this.buildBlockUserState(hook, methodName, result, isRetryable, meta),
        executionLog,
        blockedByHookId: hook.id,
      };
    }

    // Determine the most significant non-block decision
    const hasPatch = !this.shallowEqual(params, currentParams);
    const hasFollowUp = !!followUpRequest;
    const hasState = stateUpdates.length > 0;

    let decision: HookActionOutcome['decision'] = 'allow';
    if (hasPatch) decision = 'patch_params';
    else if (hasFollowUp) decision = 'emit_follow_up';
    else if (hasState) decision = 'record_state';

    return {
      decision,
      finalParams: currentParams,
      followUpRequest,
      stateUpdates,
      userState: this.buildAllowUserState(
        decision,
        methodName,
        originalParams,
        currentParams,
        followUpRequest,
        stateUpdates,
        executionLog
      ),
      executionLog,
    };
  }

  // -------------------------------------------------------------------------
  // Hook resolution
  // -------------------------------------------------------------------------

  private resolveMatchingHooks(
    methodName: string,
    params: Record<string, unknown>,
    meta: HookActionMeta
  ): WorkflowHook[] {
    const workflow = this.config.workflow;
    if (!workflow?.hooks) return [];

    const nodeName = workflow.nodes.find((n) => n.id === meta.nodeId)?.name ?? meta.agentName;

    // Build slot-to-node translation map so agent names resolve to node names
    const slotToNode = new Map<string, string>();
    for (const node of workflow.nodes) {
      for (const agent of node.agents ?? []) {
        if (!slotToNode.has(agent.name)) {
          slotToNode.set(agent.name, node.name);
        }
      }
    }

    const fromNode = slotToNode.get(meta.agentName) ?? nodeName;
    const resolver = new ChannelResolver(workflow.channels ?? []);

    // Resolve action target(s) for send_message
    const actionTargets = new Set<string>();
    if (methodName === 'send_message') {
      const target = params.target;
      if (typeof target === 'string') {
        if (target === '*') {
          const permitted = resolver.getPermittedTargets(fromNode);
          if (permitted.includes('*')) {
            for (const node of workflow.nodes) {
              actionTargets.add(node.name);
            }
          } else {
            for (const t of permitted) {
              actionTargets.add(t);
            }
          }
        } else {
          actionTargets.add(slotToNode.get(target) ?? target);
        }
      } else if (Array.isArray(target)) {
        for (const t of target) {
          if (typeof t !== 'string') continue;
          if (t === '*') {
            const permitted = resolver.getPermittedTargets(fromNode);
            if (permitted.includes('*')) {
              for (const node of workflow.nodes) {
                actionTargets.add(node.name);
              }
            } else {
              for (const pt of permitted) {
                actionTargets.add(pt);
              }
            }
          } else {
            actionTargets.add(slotToNode.get(t) ?? t);
          }
        }
      }
    }

    return workflow.hooks.filter((hook) => {
      if (!hook.enabled) return false;
      if (hook.method !== methodName) return false;

      // Match sourceNode — either the node name or agent name
      if (hook.sourceNode !== nodeName && hook.sourceNode !== meta.agentName) return false;

      // Match targetNode when declared — skip if action target does not match
      if (hook.targetNode) {
        if (methodName === 'send_message' && actionTargets.size > 0) {
          if (!actionTargets.has(hook.targetNode)) return false;
        }
      }

      // Authorized callers check
      if (hook.humanOnly) return false; // agent MCP sessions cannot trigger human-only hooks
      if (!hook.authorizedCallers || hook.authorizedCallers.length === 0) return false;

      return hook.authorizedCallers.some((caller) => {
        if (caller.sourceNode !== nodeName && caller.sourceNode !== meta.agentName) return false;
        if (!caller.agentSlots || caller.agentSlots.length === 0) return true;
        return caller.agentSlots.includes(meta.agentName);
      });
    });
  }

  private sortHooks(hooks: WorkflowHook[]): WorkflowHook[] {
    return [...hooks].sort((a, b) => {
      const aClass = a.classification ?? 'validation';
      const bClass = b.classification ?? 'validation';
      // Validation hooks first
      if (aClass !== bClass) {
        return aClass === 'validation' ? -1 : 1;
      }
      // Then by order (lower first)
      const orderA = a.order ?? 0;
      const orderB = b.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      // Then by id for determinism
      return a.id.localeCompare(b.id);
    });
  }

  // -------------------------------------------------------------------------
  // Context building
  // -------------------------------------------------------------------------

  private async buildExecutorContext(
    hook: WorkflowHook,
    methodName: string,
    params: Record<string, unknown>,
    meta: HookActionMeta
  ): Promise<HookExecutorContext> {
    const workflow = this.config.workflow;
    const nodeName = workflow?.nodes.find((n) => n.id === meta.nodeId)?.name ?? meta.agentName;

    // Load hook-local state
    const hookState = this.config.hookStateRepo.ensure(
      this.config.workflowRunId,
      hook.id,
      hook.localState?.defaults ?? {}
    );

    // Load current artifacts — bounded to last 50 to avoid oversized env
    let currentArtifacts: WorkflowRunArtifact[] = [];
    try {
      const all = this.config.artifactRepo?.listByRun(this.config.workflowRunId) ?? [];
      currentArtifacts = all.slice(-50);
    } catch {
      // best effort
    }

    const permittedExternalLookups: string[] =
      hook.validator.kind === 'script' ? (hook.validator.externalLookups ?? []) : [];

    return {
      workspacePath: this.config.workspacePath ?? '',
      runId: this.config.workflowRunId,
      hookId: hook.id,
      methodName,
      params,
      nodeId: meta.nodeId,
      nodeName,
      sessionId: meta.sessionId,
      taskId: meta.taskId,
      targetNode: hook.targetNode ?? meta.targetNode,
      hookLocalState: hookState.localState,
      currentArtifacts: currentArtifacts.map((a) => ({
        id: a.id,
        nodeId: a.nodeId,
        type: a.artifactType,
        key: a.artifactKey,
        data: a.data,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
      permittedExternalLookups,
    };
  }

  // -------------------------------------------------------------------------
  // User state builders
  // -------------------------------------------------------------------------

  private buildBlockUserState(
    hook: WorkflowHook,
    methodName: string,
    result: WorkflowHookResult,
    isRetryable: boolean,
    _meta: HookActionMeta
  ): WorkflowHookUserState {
    const base: WorkflowHookUserState = {
      status: isRetryable ? 'waiting_on_hook_retry' : 'blocked_by_hook',
      hookId: hook.id,
      hookLabel: hook.label ?? hook.id,
      method: methodName,
      sourceNode: hook.sourceNode,
      targetNode: hook.targetNode,
    };

    if (result.type === 'block' || result.type === 'retryable_block') {
      base.reason = result.reason;
      base.remediation = result.message;
      if (result.type === 'retryable_block' && result.retryAfterMs !== undefined) {
        base.retryAfterMs = result.retryAfterMs;
      }
    }

    return base;
  }

  private buildAllowUserState(
    decision: HookActionOutcome['decision'],
    methodName: string,
    originalParams: Record<string, unknown>,
    finalParams: Record<string, unknown>,
    followUpRequest: { targetNode: string; message: string } | undefined,
    _stateUpdates: Array<{ hookId: string; state: Record<string, unknown> }>,
    _executionLog: HookExecutionRecord[]
  ): WorkflowHookUserState {
    const base: WorkflowHookUserState = {
      status:
        decision === 'patch_params'
          ? 'patched'
          : decision === 'emit_follow_up'
            ? 'follow_up_emitted'
            : decision === 'record_state'
              ? 'state_recorded'
              : 'allowed',
      method: methodName,
    };

    if (decision === 'patch_params') {
      base.patchedKeys = Object.keys(finalParams).filter(
        (k) => !(k in originalParams) || finalParams[k] !== originalParams[k]
      );
    }

    if (followUpRequest) {
      base.emittedActionIds = [followUpRequest.targetNode];
    }

    return base;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (a[key] !== b[key]) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Handler wrapper
// ---------------------------------------------------------------------------

/** Symbol stored on wrapped handlers to retrieve the original unwrapped function. */
const RAW_HANDLER = Symbol('rawHandler');

/** Helper to build a typed ToolResult from inline hook responses. */
function hookResult(
  data: Record<string, unknown>,
  isError = false
): import('../tools/tool-result').ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError };
}

type AnyToolResult = import('../tools/tool-result').ToolResult;

type WrappedHandler<T extends Record<string, unknown>> = ((args: T) => Promise<AnyToolResult>) & {
  [RAW_HANDLER]?: (args: T) => Promise<AnyToolResult>;
};

/**
 * Wrap an MCP tool handler with the workflow hook engine.
 *
 * @param methodName      The MCP method name (e.g. 'send_message')
 * @param handler         The original handler function
 * @param engine          The hook engine (undefined = pass-through)
 * @param handlers        The full handler map for follow-up dispatch
 * @param meta            Caller identity metadata
 * @param isFollowUp      Whether this call is itself a follow-up action
 * @returns               A wrapped handler that runs hooks before the original
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
    const outcome = await engine.executeAction(methodName, args as Record<string, unknown>, meta);

    // Batch persist hook state updates and execution results.
    // Each hook gets at most one repo write to avoid version conflicts.
    const updatesByHook = new Map<
      string,
      { state: Record<string, unknown>; result?: WorkflowHookResult }
    >();
    for (const update of outcome.stateUpdates) {
      updatesByHook.set(update.hookId, { state: update.state });
    }
    for (const record of outcome.executionLog) {
      const existing = updatesByHook.get(record.hookId);
      if (existing) {
        existing.result = record.result;
      } else {
        updatesByHook.set(record.hookId, { state: {}, result: record.result });
      }
    }
    for (const [hookId, { state, result }] of updatesByHook) {
      const ok = engine.persistStateUpdate(hookId, state, result);
      if (!ok) {
        log.warn(
          `Failed to persist hook state/result for ${hookId}: version conflict or repo error`
        );
      }
    }

    // Handle block
    if (outcome.decision === 'block') {
      return hookResult(
        {
          success: false,
          error: outcome.userState.reason ?? 'Action blocked by hook.',
          hookStatus: outcome.userState.status,
          hookLabel: outcome.userState.hookLabel,
          hookMethod: outcome.userState.method,
          hookReason: outcome.userState.reason,
          hookRemediation: outcome.userState.remediation,
          sourceNode: outcome.userState.sourceNode,
        },
        true
      );
    }

    // Handle retryable block
    if (outcome.decision === 'retryable_block') {
      return hookResult(
        {
          success: false,
          error: outcome.userState.reason ?? 'Action blocked by hook (retryable).',
          retryable: true,
          retryAfterMs: outcome.userState.retryAfterMs,
          hookStatus: outcome.userState.status,
          hookLabel: outcome.userState.hookLabel,
          hookMethod: outcome.userState.method,
          hookReason: outcome.userState.reason,
          hookRemediation: outcome.userState.remediation,
          sourceNode: outcome.userState.sourceNode,
        },
        true
      );
    }

    // Skip nested follow-up emission — only one level of follow-up is allowed
    const nestedFollowUpSuppressed = outcome.followUpRequest && isFollowUp;
    if (nestedFollowUpSuppressed) {
      log.warn('Nested follow-up emission suppressed during follow-up dispatch.');
    }

    // Handle follow-up dispatch
    if (outcome.followUpRequest && !nestedFollowUpSuppressed) {
      const followUpMethod = 'send_message';
      if (!FOLLOW_UP_METHODS.has(followUpMethod)) {
        return hookResult(
          {
            success: false,
            error: `Follow-up method "${followUpMethod}" is not whitelisted.`,
          },
          true
        );
      }

      const followUpHandler = handlers[followUpMethod];
      if (!followUpHandler) {
        return hookResult(
          {
            success: false,
            error: `Follow-up handler "${followUpMethod}" not found.`,
          },
          true
        );
      }

      // Unwrap if the handler was already wrapped to avoid double-wrapping
      const rawFollowUpHandler =
        ((followUpHandler as unknown as WrappedHandler<Record<string, unknown>>)[RAW_HANDLER] as
          | ((args: Record<string, unknown>) => Promise<AnyToolResult>)
          | undefined) ?? followUpHandler;

      // Dispatch follow-up through the wrapped pipeline with timeout
      const followUpPromise = wrapHandlerWithHooks(
        followUpMethod,
        rawFollowUpHandler as (args: Record<string, unknown>) => Promise<AnyToolResult>,
        engine,
        handlers,
        { ...meta, targetNode: outcome.followUpRequest.targetNode },
        true
      )({
        target: outcome.followUpRequest.targetNode,
        message: outcome.followUpRequest.message,
      } as unknown as Record<string, unknown>);

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('Follow-up dispatch timed out')),
          DEFAULT_FOLLOW_UP_TIMEOUT_MS
        );
      });

      try {
        await Promise.race([followUpPromise, timeoutPromise]);
      } catch (err) {
        log.warn(
          `Follow-up dispatch timed out or failed: ${err instanceof Error ? err.message : String(err)}`
        );
        // Task says "continues only after the follow-up action succeeds or fails"
        // So we continue regardless, but we log the failure.
      }
    }

    // Call original handler with final (potentially patched) params
    return handler(outcome.finalParams as T);
  };

  (wrapped as unknown as WrappedHandler<T>)[RAW_HANDLER] = handler;
  return wrapped;
}
