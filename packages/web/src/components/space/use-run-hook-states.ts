/**
 * useRunHookStates — subscribes to hook-state updates for a workflow run
 * and returns one evaluated HookBannerSummary per defined hook.
 *
 * Shared between SpaceTaskPane (deciding which single banner to render
 * via resolveActiveTaskBanner) and PendingHookBanner (rendering the
 * list of pending hooks). Extracted so both paths see the same hook-status
 * evaluation without racing each other with independent subscriptions
 * against the same run.
 */

import { useEffect, useState } from 'preact/hooks';
import type { WorkflowHook, WorkflowHookStateSnapshot } from '@hyperneo/shared';
import { connectionManager } from '../../lib/connection-manager';
import { spaceStore } from '../../lib/space-store';

export type HookBannerStatus = 'allowed' | 'blocked_by_hook' | 'waiting_on_hook_retry';

export interface HookBannerSummary {
  hookId: string;
  status: HookBannerStatus;
  label?: string;
  sourceNode?: string;
  targetNode?: string;
  method?: string;
  reason?: string;
  remediation?: string;
  retryAfterMs?: number;
  retryCount?: number;
  nextRetryAt?: number;
  /** True when the hook result explicitly allows human approval override. */
  allowHumanApproval?: boolean;
  /** Raw hook state — callers rendering details use this. */
  state: WorkflowHookStateSnapshot;
}

/**
 * Evaluate the banner-relevant status for a single hook state.
 */
export function evaluateHookStatus(
  state: WorkflowHookStateSnapshot,
  hookDef?: WorkflowHook
): HookBannerSummary {
  const lastResult = state.lastResult;
  const status: HookBannerStatus =
    hookDef?.classification === 'side_effect'
      ? 'allowed'
      : lastResult?.type === 'retryable_block'
        ? 'waiting_on_hook_retry'
        : lastResult?.type === 'block'
          ? 'blocked_by_hook'
          : 'allowed';

  return {
    hookId: state.hookId,
    status,
    label: hookDef?.label ?? hookDef?.id ?? state.hookId,
    sourceNode: hookDef?.sourceNode,
    targetNode: hookDef?.targetNode,
    method: hookDef?.method,
    reason:
      lastResult?.type === 'block' || lastResult?.type === 'retryable_block'
        ? lastResult.reason
        : undefined,
    remediation: lastResult?.message,
    retryAfterMs: lastResult?.type === 'retryable_block' ? lastResult.retryAfterMs : undefined,
    allowHumanApproval:
      lastResult?.data && lastResult.data.allowHumanApproval === true ? true : undefined,
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
export function useRunHookStates(
  runId: string | null | undefined,
  workflowId: string | null | undefined
): {
  summaries: HookBannerSummary[] | undefined;
  fetchError: string | null;
  retry: () => void;
  /** True once the workflow definition contains hook configs, even if none are pending. */
  hasHooks: boolean;
} {
  const [hooks, setHooks] = useState<WorkflowHook[]>([]);
  const workflowVersion = spaceStore.workflowVersions.value.get(workflowId ?? '') ?? 0;

  useEffect(() => {
    if (!workflowId) {
      setHooks([]);
      return;
    }
    let cancelled = false;
    setHooks([]);
    spaceStore.fetchWorkflowDetail(workflowId).then((wf) => {
      if (cancelled) return;
      if (wf) setHooks(wf.hooks ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [workflowId, workflowVersion]);

  const [hookStateMap, setHookStateMap] = useState<Map<string, WorkflowHookStateSnapshot> | null>(
    null
  );
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchAttempt, setFetchAttempt] = useState(0);

  useEffect(() => {
    if (!runId) {
      setHookStateMap(null);
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
          hookState: WorkflowHookStateSnapshot;
        }>('space.hookState.updated', (event) => {
          if (event.runId !== runId) return;
          setHookStateMap((prev) => {
            const next = new Map(prev ?? []);
            next.set(event.hookId, event.hookState);
            return next;
          });
        });

        const result = await hub.request<{
          hookStates: WorkflowHookStateSnapshot[];
          hooks: WorkflowHook[];
        }>('spaceWorkflowRun.listHookStates', { runId });
        if (cancelled) return;
        setHookStateMap((prev) => {
          const merged = new Map<string, WorkflowHookStateSnapshot>();
          for (const hs of result.hookStates) merged.set(hs.hookId, hs);
          for (const [hookId, data] of prev ?? []) merged.set(hookId, data);
          return merged;
        });
        if (result.hooks.length > 0) {
          setHooks(result.hooks);
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
      : hooks.flatMap((hook): HookBannerSummary[] => {
          if (!hook.enabled) return [];
          const state = hookStateMap.get(hook.id);
          if (!state) return [];
          const summary = evaluateHookStatus(state, hook);
          // Only emit hooks that have a non-allow result (data row exists and
          // the hook has actually been evaluated to something meaningful).
          if (summary.status === 'allowed') return [];
          return [summary];
        });

  return {
    summaries,
    fetchError,
    retry: () => setFetchAttempt((n) => n + 1),
    hasHooks: hooks.some((hook) => hook.enabled),
  };
}
