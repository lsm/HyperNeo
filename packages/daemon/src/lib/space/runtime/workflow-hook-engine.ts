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
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { HookExecutor, HookExecutorContext } from './hook-executor';
import { ChannelResolver } from './channel-resolver';
import { Logger } from '../../logger';
import { parseAddress } from '../../../../../messaging/src/address';
import {
  SendMessageSchema,
  SaveArtifactSchema,
  CreateStandaloneTaskSchema,
} from '../tools/node-agent-tool-schemas';
import {
  ApproveTaskSchema,
  SubmitForApprovalSchema,
  MarkCompleteSchema,
} from '../tools/task-agent-tool-schemas';

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
  /** Follow-up actions to dispatch, if any. */
  followUpRequests: Array<{ targetNode: string; message: string }>;
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
  workflowRunRepo: SpaceWorkflowRunRepository;
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

/** Maximum bytes for an artifact data payload injected into hook context. */
const MAX_ARTIFACT_DATA_BYTES = 16_384;

/** Maximum bytes for a param `data` field before it is redacted in hook env. */
const MAX_PARAM_DATA_BYTES = 4096;

/** Maximum bytes for hook-local state serialized into the script env. */
const MAX_HOOK_LOCAL_STATE_BYTES = 8192;

/** Maximum items in an array before truncation in hook env params. */
const MAX_ARRAY_ITEMS = 100;

/** Maximum keys in an object before truncation in hook env params. */
const MAX_OBJECT_KEYS = 50;

/** Maximum bytes for the serialized params JSON injected into hook env. */
const MAX_PARAMS_JSON_BYTES = 32_768;

/** Maximum bytes for the entire serialized artifacts array injected into hook env. */
const MAX_ARTIFACTS_ARRAY_BYTES = 65_536;

const METHOD_PARAM_SCHEMAS: Record<string, import('zod').ZodType<unknown>> = {
  send_message: SendMessageSchema,
  save_artifact: SaveArtifactSchema,
  create_standalone_task: CreateStandaloneTaskSchema,
  approve_task: ApproveTaskSchema,
  submit_for_approval: SubmitForApprovalSchema,
  mark_complete: MarkCompleteSchema,
};

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
    const { hooks, missingChannelHooks } = this.resolveMatchingHooks(methodName, params, meta);

    // Fail closed when a hook-managed channel declares hookIds but no matching
    // hooks resolve (disabled, missing, or misconfigured).
    if (missingChannelHooks) {
      return {
        decision: 'block',
        finalParams: params,
        followUpRequests: [],
        stateUpdates: [],
        userState: {
          status: 'blocked_by_hook',
          reason:
            'Channel declares hookIds but no matching hooks were found. Action blocked (fail closed).',
        },
        executionLog: [],
      };
    }

    if (hooks.length === 0) {
      return {
        decision: 'allow',
        finalParams: params,
        followUpRequests: [],
        stateUpdates: [],
        userState: { status: 'allowed' },
        executionLog: [],
      };
    }

    const sortedHooks = this.sortHooks(hooks);
    const executionLog: HookExecutionRecord[] = [];
    const originalParams = { ...params };
    let currentParams = originalParams;
    const followUpRequests: Array<{ targetNode: string; message: string }> = [];
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

      // Pre-check retry backoff / limit for validation hooks so we don't waste
      // executor runs while a retryable_block cooldown is active.
      if ((hook.classification ?? 'validation') === 'validation' && hook.retry) {
        const hookState = this.config.hookStateRepo.get(this.config.workflowRunId, hook.id);
        const maxAttempts = hook.retry.maxAttempts ?? 0;
        const currentRetryCount = hookState?.retryCount ?? 0;
        const lastResult = hookState?.lastResult;

        if (maxAttempts > 0 && currentRetryCount >= maxAttempts) {
          const reason =
            lastResult?.type === 'retryable_block' ? lastResult.reason : 'Retry limit exceeded';
          blockedByValidation = {
            hookId: hook.id,
            result: { type: 'block', reason: reason ?? 'Retry limit exceeded' },
            isRetryable: false,
          };
          executionLog.push({
            hookId: hook.id,
            classification: 'validation',
            result: blockedByValidation.result,
            timestamp: Date.now(),
          });
          continue;
        }

        const nextRetryAt = hookState?.nextRetryAt;
        if (nextRetryAt !== undefined && Date.now() < nextRetryAt) {
          const result: WorkflowHookResult =
            lastResult?.type === 'retryable_block'
              ? lastResult
              : { type: 'retryable_block', reason: 'Retry backoff pending' };
          blockedByValidation = { hookId: hook.id, result, isRetryable: true };
          executionLog.push({
            hookId: hook.id,
            classification: 'validation',
            result,
            timestamp: Date.now(),
          });
          continue;
        }
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

        case 'retryable_block': {
          if ((hook.classification ?? 'validation') === 'validation') {
            // block takes precedence over retryable_block
            if (!blockedByValidation) {
              const retryConfig = hook.retry;
              const maxAttempts = retryConfig?.maxAttempts ?? 0;
              const hookState = this.config.hookStateRepo.get(this.config.workflowRunId, hook.id);
              const currentRetryCount = hookState?.retryCount ?? 0;
              const nextRetryAt = hookState?.nextRetryAt;

              if (maxAttempts > 0 && currentRetryCount >= maxAttempts) {
                blockedByValidation = { hookId: hook.id, result, isRetryable: false };
              } else if (nextRetryAt !== undefined && Date.now() < nextRetryAt) {
                // Delay has not elapsed — remain retryable without consuming another attempt.
                blockedByValidation = { hookId: hook.id, result, isRetryable: true };
              } else {
                blockedByValidation = { hookId: hook.id, result, isRetryable: true };
                const delayMs = retryConfig?.delayMs ?? 0;
                const backoffMultiplier = retryConfig?.backoffMultiplier ?? 1;
                let updateOk = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                  const currentState = this.config.hookStateRepo.get(
                    this.config.workflowRunId,
                    hook.id
                  );
                  const nextRetryAt =
                    Date.now() +
                    delayMs * Math.pow(backoffMultiplier, currentState?.retryCount ?? 0);
                  try {
                    const updateResult = this.config.hookStateRepo.update(
                      this.config.workflowRunId,
                      hook.id,
                      {
                        expectedVersion: currentState?.version ?? 0,
                        retryCount: (currentState?.retryCount ?? 0) + 1,
                        nextRetryAt,
                      }
                    );
                    if (updateResult !== null) {
                      updateOk = true;
                      break;
                    }
                  } catch {
                    // retry on version conflict or error
                  }
                }
                if (!updateOk) {
                  log.warn(`Failed to persist retry state for hook "${hook.id}" after 3 attempts`);
                }
              }
            }
          }
          break;
        }

        case 'patch_params': {
          const classification = hook.classification ?? 'validation';
          if (classification === 'side_effect') {
            log.warn(
              `Hook "${hook.id}" returned patch_params but is a side_effect; patch ignored.`
            );
            break;
          }
          if (result.patch && typeof result.patch === 'object') {
            const patch = { ...result.patch };
            // Disallow routing field patches to prevent target bypass
            if (methodName === 'send_message' && 'target' in patch) {
              log.warn(
                `Hook "${hook.id}" tried to patch send_message target; target change ignored.`
              );
              delete patch.target;
            }
            const patchedParams = { ...currentParams, ...patch };
            const validationErrors = this.validatePatchedParams(methodName, patchedParams);
            if (validationErrors.length > 0) {
              blockedByValidation = {
                hookId: hook.id,
                result: {
                  type: 'block',
                  reason: `Patched params invalid: ${validationErrors.join('; ')}`,
                },
                isRetryable: false,
              };
            } else {
              currentParams = patchedParams;
            }
          }
          break;
        }

        case 'emit_follow_up':
          if (result.targetNode && result.message) {
            followUpRequests.push({ targetNode: result.targetNode, message: result.message });
          }
          break;

        case 'record_state':
          if (result.state && typeof result.state === 'object') {
            stateUpdates.push({ hookId: hook.id, state: result.state as Record<string, unknown> });
          }
          break;
      }

      // Reset retry metadata when the hook does not return a retryable_block,
      // so later unrelated actions start with a fresh attempt budget.
      if (hook.retry && result.type !== 'retryable_block') {
        let updateOk = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const currentState = this.config.hookStateRepo.get(this.config.workflowRunId, hook.id);
          try {
            const updateResult = this.config.hookStateRepo.update(
              this.config.workflowRunId,
              hook.id,
              {
                expectedVersion: currentState?.version ?? 0,
                retryCount: 0,
                nextRetryAt: null,
              }
            );
            if (updateResult !== null) {
              updateOk = true;
              break;
            }
          } catch {
            // retry on version conflict or error
          }
        }
        if (!updateOk) {
          log.warn(`Failed to reset retry state for hook "${hook.id}" after 3 attempts`);
        }
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
        followUpRequests: [],
        stateUpdates,
        userState: this.buildBlockUserState(hook, methodName, result, isRetryable, meta),
        executionLog,
        blockedByHookId: hook.id,
      };
    }

    // Determine the most significant non-block decision
    const hasPatch = !this.shallowEqual(params, currentParams);
    const hasFollowUp = followUpRequests.length > 0;
    const hasState = stateUpdates.length > 0;

    let decision: HookActionOutcome['decision'] = 'allow';
    if (hasPatch) decision = 'patch_params';
    else if (hasFollowUp) decision = 'emit_follow_up';
    else if (hasState) decision = 'record_state';

    return {
      decision,
      finalParams: currentParams,
      followUpRequests,
      stateUpdates,
      userState: this.buildAllowUserState(
        decision,
        methodName,
        originalParams,
        currentParams,
        followUpRequests,
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
  ): { hooks: WorkflowHook[]; missingChannelHooks: boolean } {
    const workflow = this.config.workflow;
    if (!workflow?.hooks) return { hooks: [], missingChannelHooks: false };

    const nodeName = workflow.nodes.find((n) => n.id === meta.nodeId)?.name ?? meta.agentName;

    // Build slot-to-nodes map so duplicate slot names across nodes are preserved
    const slotToNodes = new Map<string, string[]>();
    for (const node of workflow.nodes) {
      for (const agent of node.agents ?? []) {
        const arr = slotToNodes.get(agent.name) ?? [];
        if (!arr.includes(node.name)) {
          arr.push(node.name);
        }
        slotToNodes.set(agent.name, arr);
      }
    }

    const fromNode = nodeName;
    const nodeIdToName = new Map(workflow.nodes.map((n) => [n.id, n.name]));
    const nodeNames = new Set(workflow.nodes.map((n) => n.name));
    const resolver = new ChannelResolver(workflow.channels ?? []);

    // Resolve action target(s) for send_message
    const actionTargets = new Set<string>();
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
          for (const resolved of this.resolveTargetEntries(
            target,
            nodeIdToName,
            slotToNodes,
            nodeNames
          )) {
            actionTargets.add(resolved);
          }
        }
      } else if (Array.isArray(target)) {
        for (const t of target) {
          if (typeof t !== 'string') continue;
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
      }
    }

    // For send_message, intersect resolved hooks with the hookIds declared on
    // the matching workflow channels. If any matched channel has hookIds, only
    // hooks in that set are authoritative for this action.
    const channelHookIds = new Set<string>();
    let hasChannelHookIds = false;
    if (methodName === 'send_message' && actionTargets.size > 0) {
      for (const ch of workflow.channels ?? []) {
        const fromMatches = ch.from === fromNode || ch.from === meta.agentName || ch.from === '*';
        if (!fromMatches) continue;
        const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
        const toMatches = toList.some((t) => t === '*' || actionTargets.has(t));
        if (!toMatches) continue;
        if (ch.hookIds && ch.hookIds.length > 0) {
          hasChannelHookIds = true;
          for (const hid of ch.hookIds) {
            channelHookIds.add(hid);
          }
        }
      }
    }

    const matchedHooks = workflow.hooks.filter((hook) => {
      if (!hook.enabled) return false;
      if (hook.method !== methodName) return false;

      // Match sourceNode — must be the current workflow node name
      if (hook.sourceNode !== nodeName) return false;

      // Match targetNode when declared — non-send_message methods have no action
      // target to compare, so a hook with targetNode on those methods is skipped.
      if (hook.targetNode) {
        if (methodName !== 'send_message') return false;
        if (actionTargets.size > 0 && !actionTargets.has(hook.targetNode)) return false;
      }

      // Authorized callers check
      if (hook.humanOnly) return false; // agent MCP sessions cannot trigger human-only hooks
      if (!hook.authorizedCallers || hook.authorizedCallers.length === 0) return false;

      // Channel hookIds are the authoritative binding when present
      if (hasChannelHookIds && !channelHookIds.has(hook.id)) return false;

      return hook.authorizedCallers.some((caller) => {
        if (caller.sourceNode !== nodeName) return false;
        if (!caller.agentSlots || caller.agentSlots.length === 0) return true;
        return caller.agentSlots.includes(meta.agentName);
      });
    });

    const missingChannelHooks = hasChannelHookIds && matchedHooks.length === 0;
    return { hooks: matchedHooks, missingChannelHooks };
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

    // Resolve recentResultRef from referenced hook state
    let hookLocalState = hookState.localState;
    if (hook.localState?.recentResultRef) {
      const ref = hook.localState.recentResultRef;
      const refState = this.config.hookStateRepo.get(this.config.workflowRunId, ref.hookId);
      if (refState?.lastResult !== undefined) {
        hookLocalState = { ...hookLocalState, [ref.key]: refState.lastResult };
      }
    }

    // Load current artifacts — most recently updated first, capped at 50
    let currentArtifacts: WorkflowRunArtifact[] = [];
    try {
      const all = this.config.artifactRepo?.listByRun(this.config.workflowRunId) ?? [];
      currentArtifacts = all
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50);
    } catch {
      // best effort
    }

    const permittedExternalLookups: string[] =
      hook.validator.kind === 'script' ? (hook.validator.externalLookups ?? []) : [];

    // Build mapped artifacts with a total-byte budget to avoid exceeding OS env limits.
    const mappedArtifacts: Array<{
      id: string;
      nodeId: string;
      type: string;
      key: string;
      data: unknown;
      createdAt: number;
      updatedAt: number;
    }> = [];
    for (const a of currentArtifacts) {
      const item = {
        id: a.id,
        nodeId: a.nodeId,
        type: a.artifactType,
        key: a.artifactKey,
        data: this.boundArtifactData(a.data),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
      const candidate = [...mappedArtifacts, item];
      const bytes = new TextEncoder().encode(JSON.stringify(candidate)).length;
      if (bytes > MAX_ARTIFACTS_ARRAY_BYTES) break;
      mappedArtifacts.push(item);
    }

    const run = this.config.workflowRunRepo.getRun(this.config.workflowRunId);
    const workflowStartIso = run ? new Date(run.createdAt).toISOString() : undefined;

    return {
      workspacePath: this.config.workspacePath ?? '',
      runId: this.config.workflowRunId,
      hookId: hook.id,
      methodName,
      params: this.boundParams(params),
      nodeId: meta.nodeId,
      nodeName,
      sessionId: meta.sessionId,
      taskId: meta.taskId,
      targetNode: hook.targetNode ?? meta.targetNode,
      hookLocalState: this.boundHookLocalState(hookLocalState),
      currentArtifacts: mappedArtifacts,
      permittedExternalLookups,
      templateData: hook.templateData,
      workflowStartIso,
    };
  }

  /**
   * Return a bounded projection of action params to avoid oversized env.
   * Large `data` fields are replaced with a placeholder; long messages truncated.
   */
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
    // Fail-safe: if the total serialized params still exceed the budget,
    // replace the whole object with a placeholder so Bun.spawn doesn't fail.
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

  /**
   * Recursively bound values before serializing into hook env vars.
   * Strings longer than 4096 chars are truncated; objects and arrays
   * are traversed deeply.
   */
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

  /**
   * Bound artifact data payloads to avoid oversized hook env vars.
   * Values that exceed the byte budget are replaced with a placeholder.
   */
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

  /**
   * Bound hook-local state before serializing into script env vars.
   * Replaces the whole state with a placeholder when it exceeds the byte budget.
   */
  private boundHookLocalState(state: Record<string, unknown>): Record<string, unknown> {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(state)).length;
      if (bytes <= MAX_HOOK_LOCAL_STATE_BYTES) return state;
    } catch {
      // Fall through to placeholder on serialization failure.
    }
    return { _truncated: `hook local state exceeds ${MAX_HOOK_LOCAL_STATE_BYTES} bytes` };
  }

  /**
   * Re-validate patched params against the MCP method schema.
   * Returns human-readable validation errors, or an empty array when valid.
   */
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
    followUpRequests: Array<{ targetNode: string; message: string }>,
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

    if (followUpRequests.length > 0) {
      base.emittedActionIds = followUpRequests.map((r) => r.targetNode);
    }

    return base;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a raw target string into one or more node names.
   *
   * Handles:
   *   - node IDs → node name
   *   - agent slot names → all matching node names (duplicate slots across nodes)
   *   - @worker: addresses → decoded node segment
   *   - bare node names / raw strings → returned as-is
   *
   * Target strings are trimmed before resolution.
   */
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
    // Prefer exact workflow node names over slot aliases
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
      // Decode actor-role:<nodeId|agentName> form used by the messaging adapter
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
        // Return the decoded value directly (may be a raw node name)
        return [actorRoleValue];
      }
      if (nodeIdToName.has(role)) {
        return [nodeIdToName.get(role)!];
      }
      const roleSlotMatches = slotToNodes.get(role);
      if (roleSlotMatches) {
        return [...roleSlotMatches];
      }
      // Raw role may be a workflow node name
      return [role];
    }
    return [trimmed];
  }

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
    const nestedFollowUpSuppressed = outcome.followUpRequests.length > 0 && isFollowUp;
    if (nestedFollowUpSuppressed) {
      log.warn('Nested follow-up emission suppressed during follow-up dispatch.');
    }

    // Handle follow-up dispatch
    if (outcome.followUpRequests.length > 0 && !nestedFollowUpSuppressed) {
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

      // Dispatch all follow-ups concurrently through the wrapped pipeline with timeout
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

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Follow-up dispatch timed out')),
            DEFAULT_FOLLOW_UP_TIMEOUT_MS
          );
        });

        return Promise.race([dispatchPromise, timeoutPromise]).finally(() => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
        });
      });

      try {
        await Promise.all(followUpPromises);
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
