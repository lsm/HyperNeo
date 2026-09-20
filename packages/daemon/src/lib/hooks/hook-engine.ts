import type {
  WorkflowHook,
  WorkflowHookResult,
  WorkflowHookStateSnapshot,
  WorkflowHookUserState,
} from '@hyperneo/shared';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { WorkflowHookStateRepository } from '../../storage/repositories/workflow-hook-state-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository.ts';
import { Logger } from '../logger.ts';
import { invokeOperation } from '../operations/invoke.ts';
import type { OperationCaller, OperationRegistry } from '../operations/registry.ts';
import { isRateLimitError } from '../session/rate-limit-detector.ts';
import { jsonResult } from '../space/tools/tool-result.ts';
import { scheduleRetryableAction } from './hook-binding.ts';
import type { HookExecutor } from './hook-executor.ts';
import {
  buildExecutorContext,
  PR_READY_VALIDATED_IDENTITY_HOOK_ID,
} from './hook-executor-context.ts';
import { shallowEqual, validatePatchedParams } from './hook-param-bounds.ts';
import { buildAllowUserState, buildBlockUserState } from './hook-user-state.ts';

const MAX_RESTORED_OPERATION_FAILURES = 3;

export {
  clearAllRetryableHookActionTimers,
  hasPendingRetryableHookAction,
  triggerRetryableHookAction,
  wrapHandlerWithHooks,
} from './hook-binding.ts';
export { PR_READY_VALIDATED_IDENTITY_HOOK_ID } from './hook-executor-context.ts';

export interface HookActionMeta {
  sessionId: string;
  agentName: string;
  nodeId: string;
  taskId: string;
  targetNode?: string;
}

export interface HookAddressing {
  readonly scopeId: string;
  listHooks(): WorkflowHook[];
  resolveCandidates(
    methodName: string,
    params: Record<string, unknown>,
    meta: HookActionMeta
  ): WorkflowHook[];
  resolveSourceName(meta: HookActionMeta): string;
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

export interface HookEngineConfig {
  addressing: HookAddressing;
  workflowRunCreatedAt?: number;
  nodeExecutionRepo: NodeExecutionRepository;
  artifactRepo?: WorkflowRunArtifactRepository;
  hookStateRepo: WorkflowHookStateRepository;
  hookExecutor: HookExecutor;
  workspacePath?: string;
  getScopeStatus?: (scopeId: string) => string | undefined;
  getTaskStatus?: (taskId: string) => string | undefined;
  getSourceNodeExecutionStatus?: (meta: HookActionMeta) => string | undefined;
  notifySourceSession?: (sessionId: string, message: string) => Promise<void>;
  onHookStateUpdated?: (hookId: string, hookState: WorkflowHookStateSnapshot) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const log = new Logger('hook-engine');

export const QUEUED_RETRYABLE_ACTION_STATE_KEY = '__queuedRetryableAction';
const RETRYABLE_ACTION_CANCEL_STATUSES = new Set(['done', 'cancelled']);

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

export class HookEngine {
  constructor(private readonly config: HookEngineConfig) {}

  get scopeId(): string {
    return this.config.addressing.scopeId;
  }

  getScopeStatus(): string | undefined {
    return this.config.getScopeStatus?.(this.config.addressing.scopeId);
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
    const status = this.getScopeStatus();
    return status !== undefined && RETRYABLE_ACTION_CANCEL_STATUSES.has(status);
  }

  async notifySourceSession(sessionId: string, message: string): Promise<void> {
    await this.config.notifySourceSession?.(sessionId, message);
  }

  scheduleQueuedRetryableOperations(
    registry: OperationRegistry,
    caller: OperationCaller,
    ownerMeta: HookActionMeta
  ): void {
    for (const action of this.getQueuedRetryableActions()) {
      if (!sameRetryableActionOwner(action.meta, ownerMeta)) continue;
      if (this.isRetryableActionCancelled(action.meta)) {
        this.clearQueuedRetryableAction(action.hookId);
        continue;
      }
      if (!registry.get(action.methodName)) continue;
      let executionFailureCount = 0;
      const handler = async (args: Record<string, unknown>) => {
        const outcome = await invokeOperation(registry, action.methodName, args, {
          ...caller,
          hookReplay: {
            targetNode: action.meta.targetNode,
            isFollowUp: action.isFollowUp,
          },
        });
        if (outcome.kind !== 'completed') {
          const retryable =
            outcome.code === 'execution_failed' &&
            ++executionFailureCount < MAX_RESTORED_OPERATION_FAILURES;
          return {
            ...jsonResult({
              success: false,
              error: outcome.message,
              retryable,
            }),
            isError: true,
          };
        }
        executionFailureCount = 0;
        if (typeof outcome.value === 'string') {
          return {
            ...jsonResult({ success: false, error: outcome.value, retryable: false }),
            isError: true,
          };
        }
        return jsonResult(outcome.value);
      };
      scheduleRetryableAction({
        actionKey: action.actionKey,
        delayMs: Math.max(0, action.nextRetryAt - Date.now()),
        retryDelayMs: action.retryAfterMs,
        methodName: action.methodName,
        args: action.args,
        handler,
        engine: this,
        handlers: {},
        meta: action.meta,
        isFollowUp: action.isFollowUp,
        handlerIncludesHooks: true,
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
    const state = this.config.hookStateRepo.get(this.config.addressing.scopeId, hookId)?.localState;
    const value = state?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
    if (!isQueuedRetryableHookAction(value)) return undefined;
    return value;
  }

  getQueuedRetryableActions(): QueuedRetryableHookAction[] {
    return this.config.addressing
      .listHooks()
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
    return this.config.addressing
      .listHooks()
      .filter((hook) => this.getQueuedRetryableAction(hook.id)?.actionKey === actionKey);
  }

  persistStateUpdate(
    hookId: string,
    state: Record<string, unknown>,
    lastResult?: WorkflowHookResult
  ): boolean {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const repoState =
          this.config.hookStateRepo.get(this.config.addressing.scopeId, hookId) ??
          this.config.hookStateRepo.ensure(this.config.addressing.scopeId, hookId);
        const result = this.config.hookStateRepo.update(this.config.addressing.scopeId, hookId, {
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
    const sortedHooks = this.config.addressing.resolveCandidates(methodName, params, meta);

    if (sortedHooks.length === 0) {
      return {
        decision: 'allow',
        finalParams: params,
        followUpRequests: [],
        stateUpdates: [],
        userState: { status: 'allowed' },
        executionLog: [],
      };
    }

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
        const hookState = this.config.hookStateRepo.get(this.config.addressing.scopeId, hook.id);
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

      const context = await buildExecutorContext(
        this.config,
        hook,
        methodName,
        currentParams,
        meta
      );

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
              const hookState = this.config.hookStateRepo.get(
                this.config.addressing.scopeId,
                hook.id
              );
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
                    this.config.addressing.scopeId,
                    hook.id
                  );
                  const nextRetryAt =
                    Date.now() + delayMs * backoffMultiplier ** (currentState?.retryCount ?? 0);
                  try {
                    const updateResult = this.config.hookStateRepo.update(
                      this.config.addressing.scopeId,
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
            const validationErrors = validatePatchedParams(methodName, patchedParams);
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
          const currentState = this.config.hookStateRepo.get(
            this.config.addressing.scopeId,
            hook.id
          );
          try {
            const updateResult = this.config.hookStateRepo.update(
              this.config.addressing.scopeId,
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
        userState: buildBlockUserState(hook, methodName, result, isRetryable, meta),
        executionLog,
        blockedByHookId: hook.id,
      };
    }

    const hasPatch = !shallowEqual(params, currentParams);
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
      userState: buildAllowUserState(
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
}

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
