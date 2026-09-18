import type { WorkflowHookResult } from '@hyperneo/shared';

const VALID_RESULT_TYPES = new Set([
  'allow',
  'block',
  'retryable_block',
  'patch_params',
  'emit_follow_up',
  'record_state',
]);
const MAX_HOOK_RESULT_BYTES = 65_536;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function validateWorkflowHookResult(result: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(result)) return [`result: expected object, got ${typeof result}`];
  if (jsonByteLength(result) > MAX_HOOK_RESULT_BYTES) {
    errors.push(`result: must be at most ${MAX_HOOK_RESULT_BYTES} bytes`);
  }
  if (typeof result.type !== 'string' || !VALID_RESULT_TYPES.has(result.type)) {
    errors.push(
      `result.type: expected bounded hook result type, got ${JSON.stringify(result.type)}`
    );
    return errors;
  }
  if (result.message !== undefined && typeof result.message !== 'string') {
    errors.push('result.message: expected string');
  }
  switch (result.type as WorkflowHookResult['type']) {
    case 'allow':
      break;
    case 'block':
    case 'retryable_block':
      if (typeof result.reason !== 'string' || result.reason.trim().length === 0) {
        errors.push('result.reason: expected non-empty string');
      }
      if (result.type === 'retryable_block' && result.retryAfterMs !== undefined) {
        if (typeof result.retryAfterMs !== 'number' || result.retryAfterMs <= 0) {
          errors.push('result.retryAfterMs: expected positive number');
        }
      }
      break;
    case 'patch_params':
      if (!isRecord(result.patch)) errors.push('result.patch: expected object');
      break;
    case 'emit_follow_up':
      if (typeof result.targetNode !== 'string' || result.targetNode.trim().length === 0) {
        errors.push('result.targetNode: expected non-empty node name');
      }
      if (typeof result.message !== 'string' || result.message.trim().length === 0) {
        errors.push('result.message: expected non-empty string');
      }
      break;
    case 'record_state':
      if (!isRecord(result.state) && !isRecord(result.stateForHook)) {
        errors.push('result.state or result.stateForHook: expected object');
      }
      if (result.stateForHook !== undefined && !isRecord(result.stateForHook)) {
        errors.push('result.stateForHook: expected object');
      }
      break;
  }
  if (result.data !== undefined && !isRecord(result.data))
    errors.push('result.data: expected object');
  return errors;
}
