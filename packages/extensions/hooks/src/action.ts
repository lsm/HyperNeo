import type { HookAction } from '@hyperneo/shared/types/workflow-hooks';

/** Read the `data` object off an action (prefers rawParams, falls back to bounded params). */
export function dataOf(action: HookAction): Record<string, unknown> | undefined {
  const data = action.rawParams?.data ?? action.params.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

/** Read a string field from the action's `data` object. */
export function readDataString(action: HookAction, key: string): string | undefined {
  const value = dataOf(action)?.[key];
  return typeof value === 'string' ? value : undefined;
}
