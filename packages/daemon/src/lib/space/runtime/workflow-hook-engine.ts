import type {
  WorkflowHook,
  WorkflowHookResult,
  WorkflowHookUserState,
  SpaceWorkflow,
  WorkflowRunArtifact,
  WorkflowRunStatus,
  WorkflowHookStateSnapshot,
} from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository';
import type { HookExecutor, HookExecutorContext } from './hook-executor';
import { ChannelResolver } from './channel-resolver';
import { isConnectorsLayerEnabled } from './connectors/connector';
import { getBuiltInConnectorDeps } from './connectors/production';
import { isRateLimitError } from './rate-limit-detector';
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

export interface HookActionMeta {
  sessionId: string;
  agentName: string;
  nodeId: string;
  taskId: string;
  targetNode?: string;
}

export interface HookActionOutcome {
  decision:
    | 'allow'
    | 'block'
    | 'retryable_block'
    | 'patch_params'
    | 'emit_follow_up'
    | 'record_state';
  finalParams: Record<string, unknown>;
  followUpRequests: Array<{ targetNode: string; message: string }>;
  stateUpdates: Array<{ hookId: string; state: Record<string, unknown> }>;
  userState: WorkflowHookUserState;
  executionLog: HookExecutionRecord[];
  blockedByHookId?: string;
}

export interface HookExecutionRecord {
  hookId: string;
  classification: 'validation' | 'side_effect';
  result: WorkflowHookResult;
  timestamp: number;
}

export const PR_READY_VALIDATED_IDENTITY_HOOK_ID = '__pr_ready_validated_identity__';

export interface WorkflowHookEngineConfig {
  workflow: SpaceWorkflow;
  workflowRunId: string;
  workflowRunCreatedAt?: number;
  nodeExecutionRepo: NodeExecutionRepository;
  artifactRepo?: WorkflowRunArtifactRepository;
  hookStateRepo: WorkflowHookStateRepository;
  hookExecutor: HookExecutor;
  workspacePath?: string;
  getWorkflowRunStatus?: (runId: string) => WorkflowRunStatus | undefined;
  getTaskStatus?: (taskId: string) => string | undefined;
  getSourceNodeExecutionStatus?: (meta: HookActionMeta) => string | undefined;
  notifySourceSession?: (sessionId: string, message: string) => Promise<void>;
  onHookStateUpdated?: (hookId: string, hookState: WorkflowHookStateSnapshot) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const log = new Logger('workflow-hook-engine');

const FOLLOW_UP_METHODS = new Set(['send_message']);

const DEFAULT_FOLLOW_UP_TIMEOUT_MS = 30_000;

const DEFAULT_RETRYABLE_ACTION_DELAY_MS = 30_000;

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

const MAX_ARTIFACT_DATA_BYTES = 16_384;

const MAX_PARAM_DATA_BYTES = 4096;

const MAX_HOOK_LOCAL_STATE_BYTES = 8192;

const MAX_ARRAY_ITEMS = 100;

const MAX_OBJECT_KEYS = 50;

const MAX_PARAMS_JSON_BYTES = 32_768;

const MAX_ARTIFACTS_ARRAY_BYTES = 65_536;

const METHOD_PARAM_SCHEMAS: Record<string, import('zod').ZodType<unknown>> = {
  send_message: SendMessageSchema,
  save_artifact: SaveArtifactSchema,
  create_standalone_task: CreateStandaloneTaskSchema,
  approve_task: ApproveTaskSchema,
  submit_for_approval: SubmitForApprovalSchema,
  mark_complete: MarkCompleteSchema,
};

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

  persistQueuedRetryableAction(action: QueuedRetryableHookAction): boolean {
    return this.persistStateUpdate(action.hookId, {
      [QUEUED_RETRYABLE_ACTION_STATE_KEY]: action,
    });
  }

  clearQueuedRetryableAction(hookId: string): boolean {
    return this.persistStateUpdate(hookId, {
      [QUEUED_RETRYABLE_ACTION_STATE_KEY]: null,
    });
  }

  getQueuedRetryableAction(hookId: string): QueuedRetryableHookAction | undefined {
    const state = this.config.hookStateRepo.get(this.config.workflowRunId, hookId)?.localState;
    const value = state?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
    if (!isQueuedRetryableHookAction(value)) return undefined;
    return value;
  }

  getQueuedRetryableActions(): QueuedRetryableHookAction[] {
    return (this.config.workflow.hooks ?? [])
      .map((hook) => this.getQueuedRetryableAction(hook.id))
      .filter((action): action is QueuedRetryableHookAction => action !== undefined);
  }

  clearQueuedRetryableActionsForKey(actionKey: string): void {
    for (const hook of this.getHooksWithQueuedAction(actionKey)) {
      this.clearQueuedRetryableAction(hook.id);
    }
  }

  clearQueuedRetryableActionForHook(hookId: string): QueuedRetryableHookAction | undefined {
    const queued = this.getQueuedRetryableAction(hookId);
    this.clearQueuedRetryableAction(hookId);
    return queued;
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

  getHooksWithQueuedAction(actionKey: string): WorkflowHook[] {
    return (this.config.workflow.hooks ?? []).filter(
      (hook) => this.getQueuedRetryableAction(hook.id)?.actionKey === actionKey
    );
  }

  persistStateUpdate(
    hookId: string,
    state: Record<string, unknown>,
    lastResult?: WorkflowHookResult
  ): boolean {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const repoState =
          this.config.hookStateRepo.get(this.config.workflowRunId, hookId) ??
          this.config.hookStateRepo.ensure(this.config.workflowRunId, hookId);
        const result = this.config.hookStateRepo.update(this.config.workflowRunId, hookId, {
          expectedVersion: repoState.version,
          localState: state,
          lastResult,
        });
        if (result) {
          this.config.onHookStateUpdated?.(hookId, result);
          return true;
        }
      } catch {}
    }
    return false;
  }

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
      if (blockedByValidation?.isRetryable === false) {
        break;
      }
      if (blockedByValidation && (hook.classification ?? 'validation') === 'side_effect') {
        break;
      }

      if ((hook.classification ?? 'validation') === 'validation') {
        const hookState = this.config.hookStateRepo.get(this.config.workflowRunId, hook.id);
        const maxAttempts = hook.retry?.maxAttempts ?? 0;
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
        const shouldEnforceRetryBackoff = Boolean(
          hook.retry ||
            (lastResult?.type === 'retryable_block' &&
              typeof lastResult.retryAfterMs === 'number' &&
              isRateLimitError(lastResult.reason ?? ''))
        );
        if (shouldEnforceRetryBackoff && nextRetryAt !== undefined && Date.now() < nextRetryAt) {
          const remainingRetryAfterMs = Math.max(0, nextRetryAt - Date.now());
          const result: WorkflowHookResult =
            lastResult?.type === 'retryable_block'
              ? { ...lastResult, retryAfterMs: remainingRetryAfterMs }
              : {
                  type: 'retryable_block',
                  reason: 'Retry backoff pending',
                  retryAfterMs: remainingRetryAfterMs,
                };
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

      switch (result.type) {
        case 'allow':
          if (
            methodName === 'send_message' &&
            hook.validator.kind === 'built_in' &&
            hook.validator.id === 'pr_ready'
          ) {
            const prUrl = extractPrUrlFromParams(currentParams);
            if (prUrl) {
              stateUpdates.push({ hookId: hook.id, state: { pr_url: prUrl } });
              stateUpdates.push({
                hookId: PR_READY_VALIDATED_IDENTITY_HOOK_ID,
                state: { pr_url: prUrl },
              });
            }
          }
          break;

        case 'block':
          if (
            result.data &&
            typeof result.data === 'object' &&
            hook.id !== PR_READY_VALIDATED_IDENTITY_HOOK_ID
          ) {
            stateUpdates.push({ hookId: hook.id, state: result.data as Record<string, unknown> });
          }
          if ((hook.classification ?? 'validation') === 'validation') {
            blockedByValidation = { hookId: hook.id, result, isRetryable: false };
          }
          break;

        case 'retryable_block': {
          if ((hook.classification ?? 'validation') === 'validation') {
            if (!blockedByValidation) {
              const retryConfig = hook.retry;
              const maxAttempts = retryConfig?.maxAttempts ?? 0;
              const hookState = this.config.hookStateRepo.get(this.config.workflowRunId, hook.id);
              const currentRetryCount = hookState?.retryCount ?? 0;
              const nextRetryAt = hookState?.nextRetryAt;

              if (maxAttempts > 0 && currentRetryCount >= maxAttempts) {
                blockedByValidation = { hookId: hook.id, result, isRetryable: false };
              } else if (nextRetryAt !== undefined && Date.now() < nextRetryAt) {
                blockedByValidation = { hookId: hook.id, result, isRetryable: true };
              } else {
                blockedByValidation = { hookId: hook.id, result, isRetryable: true };
                const delayMs = result.retryAfterMs ?? retryConfig?.delayMs ?? 0;
                const backoffMultiplier = result.retryAfterMs
                  ? 1
                  : (retryConfig?.backoffMultiplier ?? 1);
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
                  } catch {}
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
              if (
                methodName === 'send_message' &&
                hook.validator.kind === 'built_in' &&
                hook.validator.id === 'pr_ready'
              ) {
                const prUrl = extractPrUrlFromParams(currentParams);
                if (prUrl) {
                  stateUpdates.push({ hookId: hook.id, state: { pr_url: prUrl } });
                  stateUpdates.push({
                    hookId: PR_READY_VALIDATED_IDENTITY_HOOK_ID,
                    state: { pr_url: prUrl },
                  });
                }
              }
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
          if (
            result.state &&
            typeof result.state === 'object' &&
            hook.id !== PR_READY_VALIDATED_IDENTITY_HOOK_ID
          ) {
            stateUpdates.push({ hookId: hook.id, state: result.state as Record<string, unknown> });
          }
          if (isRecord(result.stateForHook)) {
            for (const [hookId, state] of Object.entries(result.stateForHook)) {
              if (hookId === PR_READY_VALIDATED_IDENTITY_HOOK_ID) continue;
              if (isRecord(state)) stateUpdates.push({ hookId, state });
            }
          }
          break;
      }

      if (result.type !== 'retryable_block') {
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
          } catch {}
        }
        if (!updateOk) {
          log.warn(`Failed to reset retry state for hook "${hook.id}" after 3 attempts`);
        }
      }
    }

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

  private resolveMatchingHooks(
    methodName: string,
    params: Record<string, unknown>,
    meta: HookActionMeta
  ): WorkflowHook[] {
    const workflow = this.config.workflow;
    if (!workflow?.hooks) return [];

    const nodeName = workflow.nodes.find((n) => n.id === meta.nodeId)?.name ?? meta.agentName;

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

    return workflow.hooks.filter((hook) => {
      if (!hook.enabled) return false;
      if (hook.method !== methodName) return false;

      if (hook.sourceNode !== nodeName) return false;

      if (hook.targetNode) {
        if (methodName !== 'send_message') return false;
        if (!allRequestedTargetsRoutable) return false;
        if (!actionTargets.has(hook.targetNode)) return false;
      }

      if (hook.humanOnly) return false;
      if (!hook.authorizedCallers || hook.authorizedCallers.length === 0) return false;

      return hook.authorizedCallers.some((caller) => {
        if (caller.sourceNode !== nodeName) return false;
        if (!caller.agentSlots || caller.agentSlots.length === 0) return true;
        return caller.agentSlots.includes(meta.agentName);
      });
    });
  }

  private sortHooks(hooks: WorkflowHook[]): WorkflowHook[] {
    return [...hooks].sort((a, b) => {
      const aClass = a.classification ?? 'validation';
      const bClass = b.classification ?? 'validation';
      if (aClass !== bClass) {
        return aClass === 'validation' ? -1 : 1;
      }
      const orderA = a.order ?? 0;
      const orderB = b.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    });
  }

  private resolveFrozenPrUrl(): string | undefined {
    try {
      const st = this.config.hookStateRepo.get(
        this.config.workflowRunId,
        PR_READY_VALIDATED_IDENTITY_HOOK_ID
      );
      const url =
        st && typeof st.localState?.pr_url === 'string' ? (st.localState.pr_url as string) : '';
      return url || undefined;
    } catch {
      return undefined;
    }
  }

  private async buildExecutorContext(
    hook: WorkflowHook,
    methodName: string,
    params: Record<string, unknown>,
    meta: HookActionMeta
  ): Promise<HookExecutorContext> {
    const workflow = this.config.workflow;
    const nodeName = workflow?.nodes.find((n) => n.id === meta.nodeId)?.name ?? meta.agentName;

    const hookState = this.config.hookStateRepo.ensure(
      this.config.workflowRunId,
      hook.id,
      hook.localState?.defaults ?? {}
    );

    let hookLocalState = hookState.localState;
    if (hook.localState?.recentResultRef) {
      const ref = hook.localState.recentResultRef;
      const refState = this.config.hookStateRepo.get(this.config.workflowRunId, ref.hookId);
      if (refState?.lastResult !== undefined) {
        hookLocalState = { ...hookLocalState, [ref.key]: refState.lastResult };
      }
    }

    let currentArtifacts: WorkflowRunArtifact[] = [];
    try {
      const all = this.config.artifactRepo?.listByRun(this.config.workflowRunId) ?? [];
      currentArtifacts = all
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50);
    } catch {}

    const permittedExternalLookups: string[] =
      hook.validator.kind === 'script'
        ? (hook.validator.externalLookups ?? [])
        : isConnectorsLayerEnabled()
          ? [...getBuiltInConnectorDeps(hook.validator.id)]
          : hook.validator.id === 'pr_ready'
            ? ['github']
            : [];

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

    return {
      workspacePath: this.config.workspacePath ?? '',
      runId: this.config.workflowRunId,
      hookId: hook.id,
      workflowRunCreatedAt: this.config.workflowRunCreatedAt,
      methodName,
      params: this.boundParams(params),
      rawParams: params,
      nodeId: meta.nodeId,
      nodeName,
      sessionId: meta.sessionId,
      taskId: meta.taskId,
      taskStatus: this.config.getTaskStatus?.(meta.taskId),
      targetNode: hook.targetNode ?? meta.targetNode,
      hookLocalState: this.boundHookLocalState(hookLocalState),
      frozenPrUrl: this.resolveFrozenPrUrl(),
      currentArtifacts: mappedArtifacts,
      permittedExternalLookups,
      templateData: hook.templateData,
    };
  }

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
    } catch {}
    return `[truncated: artifact data exceeds ${MAX_ARTIFACT_DATA_BYTES} bytes]`;
  }

  private boundHookLocalState(state: Record<string, unknown>): Record<string, unknown> {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(state)).length;
      if (bytes <= MAX_HOOK_LOCAL_STATE_BYTES) return state;
    } catch {}
    return { _truncated: `hook local state exceeds ${MAX_HOOK_LOCAL_STATE_BYTES} bytes` };
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
      if (result.type === 'retryable_block') {
        base.retryAfterMs =
          result.retryAfterMs ?? hook.retry?.delayMs ?? DEFAULT_RETRYABLE_ACTION_DELAY_MS;
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
      } catch {}
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

const RAW_HANDLER = Symbol('rawHandler');

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

function extractPrUrlFromParams(params: Record<string, unknown>): string | undefined {
  const data = params.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    typeof (data as Record<string, unknown>).pr_url === 'string'
  ) {
    return (data as Record<string, unknown>).pr_url as string;
  }
  return undefined;
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

function scheduleRetryableAction<T extends Record<string, unknown>>(options: {
  actionKey: string;
  delayMs: number;
  methodName: string;
  args: T;
  handler: (args: T) => Promise<AnyToolResult>;
  engine: WorkflowHookEngine;
  handlers: Record<string, (...args: unknown[]) => Promise<AnyToolResult> | AnyToolResult>;
  meta: HookActionMeta;
  isFollowUp: boolean;
}): void {
  if (pendingRetryableHookActions.has(options.actionKey)) return;

  const timer = setTimeout(() => {
    pendingRetryableHookActions.delete(options.actionKey);
    void replayRetryableAction(options).catch((err) => {
      log.warn(
        `Retryable hook action retry failed for ${options.methodName}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }, options.delayMs);

  pendingRetryableHookActions.set(options.actionKey, {
    timer,
    options: {
      ...options,
      args: options.args,
      handler: async (args) => options.handler(args as T),
    },
  });
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
      `Manual retryable hook action retry failed for ${pending.options.methodName}: ${err instanceof Error ? err.message : String(err)}`
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

async function replayRetryableAction<T extends Record<string, unknown>>(options: {
  actionKey: string;
  methodName: string;
  args: T;
  handler: (args: T) => Promise<AnyToolResult>;
  engine: WorkflowHookEngine;
  handlers: Record<string, (...args: unknown[]) => Promise<AnyToolResult> | AnyToolResult>;
  meta: HookActionMeta;
  isFollowUp: boolean;
}): Promise<void> {
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
        `Failed to notify source session for queued ${options.methodName} retry failure: ${err instanceof Error ? err.message : String(err)}`
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

    if (outcome.decision === 'block') {
      if (outcome.blockedByHookId) {
        for (const queuedActionKey of engine.clearQueuedRetryableActionsForOwner(
          [outcome.blockedByHookId],
          meta
        )) {
          clearRetryableHookActionTimer(queuedActionKey);
        }
      }
      engine.clearQueuedRetryableActionsForKey(actionKey);
      clearRetryableHookActionTimer(actionKey);
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

    if (outcome.decision === 'retryable_block') {
      const retryAfterMs = outcome.userState.retryAfterMs ?? DEFAULT_RETRYABLE_ACTION_DELAY_MS;
      if (methodName === 'send_message') {
        if (outcome.blockedByHookId) {
          const existingQueued = engine.clearQueuedRetryableActionForHook(outcome.blockedByHookId);
          if (existingQueued) clearRetryableHookActionTimer(existingQueued.actionKey);
          const now = Date.now();
          const persisted = engine.persistQueuedRetryableAction({
            actionKey,
            hookId: outcome.blockedByHookId,
            methodName,
            args: args as Record<string, unknown>,
            meta,
            isFollowUp,
            nextRetryAt: now + retryAfterMs,
            retryAfterMs,
            queuedAt: now,
          });
          if (!persisted) {
            log.warn(
              `Failed to persist queued retryable hook action for ${methodName}: ${outcome.blockedByHookId}`
            );
          }
        }
        if (engine.isRetryableActionCancelled(meta)) {
          engine.clearQueuedRetryableActionsForKey(actionKey);
          clearRetryableHookActionTimer(actionKey);
          return hookResult({
            success: true,
            queued: false,
            cancelled: true,
            retryable: false,
            hookStatus: outcome.userState.status,
            hookLabel: outcome.userState.hookLabel,
            hookMethod: outcome.userState.method,
            hookReason: outcome.userState.reason,
            hookRemediation: outcome.userState.remediation,
            sourceNode: outcome.userState.sourceNode,
            message: 'Queued action cancelled because task or workflow run is no longer active.',
          });
        }
        scheduleRetryableAction({
          actionKey,
          delayMs: retryAfterMs,
          methodName,
          args,
          handler,
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
          hookLabel: outcome.userState.hookLabel,
          hookMethod: outcome.userState.method,
          hookReason: outcome.userState.reason,
          hookRemediation: outcome.userState.remediation,
          sourceNode: outcome.userState.sourceNode,
          message:
            outcome.userState.reason ??
            `Action queued until hook "${outcome.userState.hookLabel ?? outcome.blockedByHookId ?? 'unknown'}" allows it.`,
        });
      }
      return hookResult(
        {
          success: false,
          error: outcome.userState.reason ?? 'Action blocked by hook (retryable).',
          retryable: true,
          retryAfterMs,
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

    const successfulHookIds = outcome.executionLog.map((record) => record.hookId);
    for (const queuedActionKey of engine.clearQueuedRetryableActionsForOwner(
      successfulHookIds,
      meta
    )) {
      clearRetryableHookActionTimer(queuedActionKey);
    }
    engine.clearQueuedRetryableActionsForKey(actionKey);
    clearRetryableHookActionTimer(actionKey);

    const nestedFollowUpSuppressed = outcome.followUpRequests.length > 0 && isFollowUp;
    if (nestedFollowUpSuppressed) {
      log.warn('Nested follow-up emission suppressed during follow-up dispatch.');
    }

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

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('Follow-up dispatch timed out')),
            DEFAULT_FOLLOW_UP_TIMEOUT_MS
          );
        });

        return Promise.race([dispatchPromise, timeoutPromise]);
      });

      try {
        await Promise.all(followUpPromises);
      } catch (err) {
        log.warn(
          `Follow-up dispatch timed out or failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return handler(outcome.finalParams as T);
  };

  (wrapped as unknown as WrappedHandler<T>)[RAW_HANDLER] = handler;
  return wrapped;
}
