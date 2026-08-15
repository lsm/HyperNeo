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
  /** False for fail-closed/infrastructure stops — no Approve action is offered. */
  overrideEligible: boolean;
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
    // Engine-reserved flag: false marks fail-closed/infrastructure stops
    // (unresolved hook, unreadable artifacts, persistence failures) where an
    // approval must NOT be offered — overriding would deliver without the
    // gate ever having run. Absent defaults to eligible (a hook decision).
    overrideEligible: state.localState?.__overrideEligible !== false,
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
  // Set true once ANY successful listHookStates response arrives, so a FAILED
  // initial fetch still mounts the banner (with its Retry action) instead of
  // reporting hasHooks:false from data that only the failed request carries.
  const [everHadBindings, setEverHadBindings] = useState(false);
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
            // Version guard (mirrors the fetch-merge below): an OUT-OF-ORDER
            // delivery — an older event racing a newer snapshot — must not
            // regress the banner to the stale state.
            const existing = next.get(event.hookId);
            if (!existing || existing.version <= event.hookState.version) {
              next.set(event.hookId, event.hookState);
            }
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
          for (const [hookId, data] of prev ?? []) {
            // An event snapshot queued before the RPC response can be OLDER
            // than the fetched state (a newer write landed between them).
            // Unconditionally overwriting would regress the banner to an
            // obsolete state whose expectedVersion then conflicts on the
            // next approval — retain whichever snapshot has the higher
            // version (the fetched one on a true tie, matching the RPC's
            // authoritative read).
            const fetched = merged.get(hookId);
            if (!fetched || fetched.version < data.version) merged.set(hookId, data);
          }
          return merged;
        });
        setHookBindings(result.hookBindings);
        if (result.hookBindings.some((binding) => binding.enabled)) setEverHadBindings(true);
        // A legacy-cutover guard stop persists under the synthetic
        // __legacy_hooks__ id with NO bindings on the pinned definition —
        // latch presence so its banner still mounts.
        if (
          result.hookStates.some(
            (hs: HookStateSnapshot) => hs.hookId === '__legacy_hooks__' && hs.lastFlow === 'stop'
          )
        ) {
          setEverHadBindings(true);
        }
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
      : [
          ...hookBindings
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
            // routes shares ONE state snapshot, so render it once — one stop
            // must not spawn duplicate blocked banners for every route, whose
            // Approve buttons would all write the same shared override. The
            // engine stamps the state with the ROUTE that actually blocked
            // (__blockingRoute): re-label the kept summary with the matching
            // binding so the banner describes the blocked handoff, not an
            // arbitrary first route.
            .map((summary, _index, all) => {
              // Relabel BEFORE the dedup below so `all` still carries every
              // route's binding summary (the dedup keeps the FIRST slot per
              // hookId — its content must be the matched route's).
              const route = summary.state.localState?.__blockingRoute as
                | { sourceNode?: string; targetNode?: string }
                | undefined;
              if (!route) return summary;
              const match = all.find(
                (other) =>
                  other.hookId === summary.hookId &&
                  (route.sourceNode === undefined || other.sourceNode === route.sourceNode) &&
                  (route.targetNode === undefined || other.targetNode === route.targetNode)
              );
              return match ?? summary;
            })
            .filter((summary, index, all) => {
              return all.findIndex((other) => other.hookId === summary.hookId) === index;
            }),
          // Synthesize a banner for the legacy-cutover guard stop: it persists
          // under the __legacy_hooks__ id with no bindings on the pinned
          // definition, so the binding-driven pass above can never emit it.
          ...[...hookStateMap.values()]
            .filter((state) => state.hookId === '__legacy_hooks__' && state.lastFlow === 'stop')
            .map((state) => ({
              hookId: state.hookId,
              status: 'blocked_by_hook' as const,
              overrideEligible: state.localState?.__overrideEligible !== false,
              label: 'Legacy workflow hooks',
              reason: state.lastReason,
              state,
            })),
          // TRANSIENT routing-store outage: distinct from the permanent
          // legacy guard (the engine clears the row once routing
          // evaluation succeeds again, dismissing this banner).
          ...[...hookStateMap.values()]
            .filter(
              (state) => state.hookId === '__routing_unavailable__' && state.lastFlow === 'stop'
            )
            .map((state) => ({
              hookId: state.hookId,
              status: 'blocked_by_hook' as const,
              overrideEligible: false,
              label: 'Routing temporarily unavailable',
              reason: state.lastReason,
              state,
            })),
        ];

  return {
    summaries,
    fetchError,
    retry: () => setFetchAttempt((n) => n + 1),
    hasHooks: everHadBindings || hookBindings.some((binding) => binding.enabled),
  };
}
