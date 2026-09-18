import type { WorkflowHook, WorkflowHookResult, WorkflowHookUserState } from '@hyperneo/shared';
import { DEFAULT_RETRYABLE_ACTION_DELAY_MS } from './hook-binding.ts';
import type { HookActionMeta, HookActionOutcome, HookExecutionRecord } from './hook-engine.ts';

export function buildBlockUserState(
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

export function buildAllowUserState(
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
