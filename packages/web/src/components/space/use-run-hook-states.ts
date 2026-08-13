/**
 * useRunHookStates — subscribes to hook-state updates for a workflow run
 * and returns one evaluated HookBannerSummary per bound hook.
 *
 * Shared between SpaceTaskPane (deciding which single banner to render
 * via resolveActiveTaskBanner) and PendingHookBanner (rendering the
 * list of pending hooks). Extracted so both paths see the same hook-status
 * evaluation without racing each other with independent subscriptions
 * against the same run.
 *
 * Workflow Hooks v2: the workflow definition exposes `hookBindings` +
 * `customHooks`; the run emits `HookStateSnapshot` whose `lastFlow`
 * ('stop'|'retry'|'continue') drives the banner status.
 */

import { useEffect, useState } from 'preact/hooks';
import type { HookBinding, HookStateSnapshot } from '@hyperneo/shared';
import { connectionManager } from '../../lib/connection-manager';

export type HookBannerStatus = 'allowed' | 'blocked_by_hook' | 'waiting_on_hook_retry';

export interface HookBannerSummary {
  hookId: string;
  status: HookBannerStatus;
  label?: string;
  sourceNode?: string;
  targetNode?: string;
  method?: string;
  reason?: string;
  retryCount?: number;
  nextRetryAt?: number;
  /** Raw hook state — callers rendering details use this. */
  state: HookStateSnapshot;
}

/**
 * Evaluate the banner-relevant status for a single hook state + binding.
 *
 * v2 mapping of `lastFlow`:
 *   - 'stop'   → blocked_by_hook
 *   - 'retry'  → waiting_on_hook_retry
 *   - 'continue' or absent → allowed
 */
export function evaluateHookStatus(
  state: HookStateSnapshot,
  binding?: HookBinding
): HookBannerSummary {
  const lastFlow = state.lastFlow;
  const status: HookBannerStatus =
    lastFlow === 'stop'
      ? 'blocked_by_hook'
      : lastFlow === 'retry'
        ? 'waiting_on_hook_retry'
        : 'allowed';

  return {
    hookId: state.hookId,
    status,
    label: binding?.hookId ?? state.hookId,
    sourceNode: binding?.sourceNode,
    targetNode: binding?.targetNode,
    method: binding?.method,
    reason: state.lastReason,
    retryCount: state.retryCount,
    nextRetryAt: state.nextRetryAt,
    state,
  };
}

/**
 * Returns evaluated hook summaries for the given run, or undefined while
 * loading. Pass null/undefined for either arg to disable the hook —
 * it will always return undefined in that case.
 */
export function useRunHookStates(runId: string | null | undefined): {
  summaries: HookBannerSummary[] | undefined;
  fetchError: string | null;
  retry: () => void;
  /** True once the workflow definition contains hook bindings, even if none are pending. */
  hasHooks: boolean;
} {
  // Bindings come ONLY from the run-scoped listHookStates RPC, which the daemon
  // deliberately answers with the run's PINNED definition. Sourcing them from
  // the live workflow detail instead would let a mid-run edit (removed/renamed
  // binding) hide or mislabel a blocked hook for the pinned run.
  const [hookBindings, setHookBindings] = useState<HookBinding[]>([]);
  const [hookStateMap, setHookStateMap] = useState<Map<string, HookStateSnapshot> | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchAttempt, setFetchAttempt] = useState(0);

  useEffect(() => {
    if (!runId) {
      setHookStateMap(null);
      setHookBindings([]);
      setFetchError(null);
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setHookStateMap(null);
    setFetchError(null);

    (async () => {
      try {
        const hub = await connectionManager.getHub();
        if (cancelled) return;

        unsubscribe = hub.onEvent<{
          runId: string;
          hookId: string;
          hookState: HookStateSnapshot;
        }>('space.hookState.updated', (event) => {
          if (event.runId !== runId) return;
          setHookStateMap((prev) => {
            const next = new Map(prev ?? []);
            next.set(event.hookId, event.hookState);
            return next;
          });
        });

        const result = await hub.request<{
          hookStates: HookStateSnapshot[];
          hookBindings: HookBinding[];
        }>('spaceWorkflowRun.listHookStates', { runId });
        if (cancelled) return;
        setHookStateMap((prev) => {
          const merged = new Map<string, HookStateSnapshot>();
          for (const hs of result.hookStates) merged.set(hs.hookId, hs);
          for (const [hookId, data] of prev ?? []) merged.set(hookId, data);
          return merged;
        });
        setHookBindings(result.hookBindings);
      } catch (err: unknown) {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : 'Failed to load hook status');
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [runId, fetchAttempt]);

  const summaries =
    hookStateMap === null
      ? undefined
      : hookBindings
          .flatMap((binding): HookBannerSummary[] => {
            if (!binding.enabled) return [];
            const state = hookStateMap.get(binding.hookId);
            if (!state) return [];
            const summary = evaluateHookStatus(state, binding);
            // Only emit hooks that have a non-allow result (data row exists and
            // the hook has actually been evaluated to something meaningful).
            if (summary.status === 'allowed') return [];
            return [summary];
          })
          // Hook state is keyed (runId, hookId): a hook bound to multiple
          // routes shares ONE state snapshot, so render it once (labelled by
          // its first binding) — one stop must not spawn duplicate blocked
          // banners for every route, whose Approve buttons would all write the
          // same shared override.
          .filter((summary, index, all) => {
            return all.findIndex((other) => other.hookId === summary.hookId) === index;
          });

  return {
    summaries,
    fetchError,
    retry: () => setFetchAttempt((n) => n + 1),
    hasHooks: hookBindings.some((binding) => binding.enabled),
  };
}
