/**
 * useRunGateSummaries — subscribes to gate-data updates for a workflow run
 * and returns one evaluated `GateBannerSummary` per defined gate.
 *
 * Shared between `SpaceTaskPane` (deciding which single banner to render
 * via `resolveActiveTaskBanner`) and `PendingGateBanner` (rendering the
 * list of pending gates). Extracted so both paths see the same gate-status
 * evaluation without racing each other with independent subscriptions
 * against the same run.
 *
 * Contract:
 *   - Returns `undefined` while the initial fetch is in flight — callers
 *     treat this as "gate status is not yet known" and do not fire any
 *     gate-dependent UI (see `task-banner.ts`).
 *   - Returns `[]` once loaded and no gate has been activated.
 *   - Returns a non-empty array with one summary per defined gate; the
 *     `status` matches `gate-status.ts::evaluateGateStatus`.
 *   - Live-updates on `space.gateData.updated` events so the banner flips
 *     without a refresh.
 */

import { useEffect, useState } from 'preact/hooks';
import type { Gate } from '@neokai/shared';
import { connectionManager } from '../../lib/connection-manager';
import { spaceStore } from '../../lib/space-store';
import type { GateBannerSummary } from '../../lib/task-banner.ts';
import { evaluateGateStatus, parseScriptResult } from './gate-status.ts';

interface GateDataRecord {
  runId: string;
  gateId: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

export interface RunGateSummary extends GateBannerSummary {
  gateId: string;
  label?: string;
  /** Raw gate data — callers rendering details (e.g. PendingGateBanner) use this. */
  data: Record<string, unknown>;
}

/**
 * Returns evaluated gate summaries for the given run, or `undefined` while
 * loading. Pass `null`/`undefined` for either arg to disable the hook —
 * it will always return `undefined` in that case.
 */
export function useRunGateSummaries(
  runId: string | null | undefined,
  workflowId: string | null | undefined
): { summaries: RunGateSummary[] | undefined; fetchError: string | null; retry: () => void } {
  const [gates, setGates] = useState<Gate[]>([]);
  // Read the workflow version so the effect re-runs when the same workflow
  // is edited in place (spaceStore bumps the version on spaceWorkflow.updated).
  const workflowVersion = spaceStore.workflowVersions.value.get(workflowId ?? '') ?? 0;

  useEffect(() => {
    if (!workflowId) {
      setGates([]);
      return;
    }
    let cancelled = false;
    // Clear stale gates immediately so banners are never evaluated against
    // a previous workflow's gate list while the new fetch is in flight.
    setGates([]);
    spaceStore.fetchWorkflowDetail(workflowId).then((wf) => {
      if (cancelled) return;
      // Only update gates when the fetch succeeds. If wf is null (transient
      // RPC failure or concurrently deleted workflow), leave gates as [] from
      // the clear above rather than explicitly mapping failure to "no gates".
      if (wf) setGates(wf.gates ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [workflowId, workflowVersion]);

  const [gateDataMap, setGateDataMap] = useState<Map<string, Record<string, unknown>> | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchAttempt, setFetchAttempt] = useState(0);

  useEffect(() => {
    if (!runId) {
      setGateDataMap(null);
      setFetchError(null);
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setGateDataMap(null);
    setFetchError(null);

    (async () => {
      try {
        const hub = await connectionManager.getHub();
        if (cancelled) return;

        // Subscribe before fetching so updates delivered while the fetch
        // is in flight aren't lost.
        unsubscribe = hub.onEvent<{
          runId: string;
          gateId: string;
          data: Record<string, unknown>;
        }>('space.gateData.updated', (event) => {
          if (event.runId !== runId) return;
          setGateDataMap((prev) => {
            const next = new Map(prev ?? []);
            next.set(event.gateId, event.data);
            return next;
          });
        });

        const result = await hub.request<{ gateData: GateDataRecord[] }>(
          'spaceWorkflowRun.listGateData',
          { runId }
        );
        if (cancelled) return;
        setGateDataMap((prev) => {
          // Seed from fetch; overlay any event-delivered entries already
          // present in `prev` (strictly newer than the fetch snapshot).
          const merged = new Map<string, Record<string, unknown>>();
          for (const record of result.gateData) merged.set(record.gateId, record.data);
          for (const [gateId, data] of prev ?? []) merged.set(gateId, data);
          return merged;
        });
      } catch (err: unknown) {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : 'Failed to load gate status');
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [runId, fetchAttempt]);

  const summaries =
    gateDataMap === null
      ? undefined
      : gates.flatMap((gate): RunGateSummary[] => {
          // Only emit gates that have been activated (data row exists). A
          // defined-but-never-triggered gate is not a banner signal.
          if (!gateDataMap.has(gate.id)) return [];
          const data = gateDataMap.get(gate.id)!;
          const scriptResult = parseScriptResult(data);
          const status = evaluateGateStatus(gate, data, scriptResult.failed);
          return [
            {
              gateId: gate.id,
              status,
              label: gate.label ?? gate.description,
              data,
            },
          ];
        });

  return {
    summaries,
    fetchError,
    retry: () => setFetchAttempt((n) => n + 1),
  };
}
