/**
 * PendingGateBanner — thread-view CTA for workflow gates awaiting human approval.
 *
 * Shows whenever the task's workflow run has at least one external-approval
 * gate that evaluates to `waiting_human` (see `gate-status.ts` for the exact
 * rule — mirrors the canvas evaluator). Task status is independent — a gate
 * can be waiting while the task itself is still `in_progress`. Provides
 * Approve / Reject / Review buttons wired to `spaceWorkflowRun.approveGate`,
 * and opens `GateArtifactsView` as a full-pane overlay for deeper review.
 *
 * Distinct from `TaskBlockedBanner` (which only shows when the task itself is
 * in `blocked` status). Multi-gate workflows render a short stack — one
 * `InlineStatusBanner` row per pending gate. The row layout is shared with the
 * other task-pane banners so the single-slot renderer (`SpaceTaskPane`) sees
 * a consistent thin-banner shape regardless of which kind fires.
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { GateArtifactsView } from './GateArtifactsView';
import { InlineStatusBanner, type InlineStatusBannerAction } from './InlineStatusBanner';
import { useRunGateSummaries } from './use-run-gate-summaries.ts';

interface PendingGateBannerProps {
  runId: string;
  spaceId: string;
  /** Workflow ID for the run; used to resolve gate definitions. */
  workflowId: string | null;
}

export function PendingGateBanner({ runId, spaceId, workflowId }: PendingGateBannerProps) {
  const { summaries, fetchError, retry } = useRunGateSummaries(runId, workflowId);

  const [reviewGateId, setReviewGateId] = useState<string | null>(null);
  // Multiple gates can be pending at once, so busy/error state is keyed by
  // gateId — otherwise a second click would clobber the first gate's spinner
  // or error, and an error from gate A could render under gate B's row.
  const [busyGateIds, setBusyGateIds] = useState<Set<string>>(() => new Set());
  const [decisionErrors, setDecisionErrors] = useState<Map<string, string>>(() => new Map());
  const decisionCancelledRef = useRef(false);
  // Tracks the live runId so in-flight decision responses from a previous
  // run don't stamp busy/error state onto the new run after a runId swap.
  const currentRunIdRef = useRef(runId);

  useEffect(() => {
    setReviewGateId(null);
    setDecisionErrors(new Map());
    // If a decision RPC is in-flight when runId swaps (e.g. user navigates to
    // another task's run), the pending promise is abandoned by the cleanup
    // flag below — but busyGateIds from the prior run would otherwise leak
    // here and permanently disable a gate's buttons in the new run.
    setBusyGateIds(new Set());
    currentRunIdRef.current = runId;
  }, [runId]);

  useEffect(() => {
    decisionCancelledRef.current = false;
    return () => {
      decisionCancelledRef.current = true;
    };
  }, []);

  // Tracks the element that opened the review overlay so we can restore focus
  // to it when the overlay closes (WCAG 2.4.3). Captured at open time; cleared
  // after restore to avoid cross-open leakage. If the opener was removed from
  // the DOM while the overlay was open (e.g. approving a gate removes it from
  // `pendingGates`), we fall back to a wrapper element that is still mounted.
  const overlayOpenerRef = useRef<HTMLElement | null>(null);
  const bannerRef = useRef<HTMLDivElement | null>(null);

  // Close the review overlay on Escape (basic modal a11y). We don't implement a
  // full focus trap — GateArtifactsView's own close button is reachable via Tab.
  useEffect(() => {
    if (!reviewGateId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReviewGateId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reviewGateId]);

  // On overlay close, return focus to the element that opened it. If the
  // opener was unmounted while the overlay was open (common when Approve/
  // Reject from GateArtifactsView transitions the gate out of `pendingGates`),
  // .focus() on the detached node is a no-op — fall back to the banner wrapper
  // so keyboard focus lands somewhere meaningful rather than collapsing to
  // <body>.
  useEffect(() => {
    if (reviewGateId) return;
    const opener = overlayOpenerRef.current;
    if (!opener) return; // no overlay was open — nothing to restore
    if (opener.isConnected && typeof opener.focus === 'function') {
      opener.focus();
    } else if (bannerRef.current && typeof bannerRef.current.focus === 'function') {
      bannerRef.current.focus();
    }
    overlayOpenerRef.current = null;
  }, [reviewGateId]);

  const pendingGates = (summaries ?? []).filter((g) => g.status === 'waiting_human');

  const handleDecision = useCallback(
    async (gateId: string, approved: boolean) => {
      setBusyGateIds((prev) => {
        const next = new Set(prev);
        next.add(gateId);
        return next;
      });
      setDecisionErrors((prev) => {
        if (!prev.has(gateId)) return prev;
        const next = new Map(prev);
        next.delete(gateId);
        return next;
      });
      const runIdAtCall = runId;
      try {
        const hub = await connectionManager.getHub();
        await hub.request('spaceWorkflowRun.approveGate', { runId, gateId, approved });
      } catch (err: unknown) {
        if (decisionCancelledRef.current) return;
        if (currentRunIdRef.current !== runIdAtCall) return; // stale runId
        const msg = err instanceof Error ? err.message : 'Failed to submit decision';
        setDecisionErrors((prev) => {
          const next = new Map(prev);
          next.set(gateId, msg);
          return next;
        });
      } finally {
        if (!decisionCancelledRef.current && currentRunIdRef.current === runIdAtCall) {
          setBusyGateIds((prev) => {
            if (!prev.has(gateId)) return prev;
            const next = new Set(prev);
            next.delete(gateId);
            return next;
          });
        }
      }
    },
    [runId]
  );

  // Render the artifacts review as a full-pane modal overlay so `h-full`
  // inside GateArtifactsView resolves against a definite height. Rendering
  // it inline in the banner slot collapses it (banner is auto-height).
  const reviewGateData = reviewGateId
    ? (summaries?.find((g) => g.gateId === reviewGateId)?.data ?? {})
    : {};
  const reviewOverlay = reviewGateId ? (
    <div
      class="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4"
      data-testid="pending-gate-review-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Review gate artifacts"
      onClick={(e) => {
        if (e.target === e.currentTarget) setReviewGateId(null);
      }}
    >
      <div class="w-full max-w-2xl max-h-[80vh] bg-dark-900 border border-dark-600 rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <GateArtifactsView
          runId={runId}
          gateId={reviewGateId}
          spaceId={spaceId}
          gateData={reviewGateData}
          onClose={() => setReviewGateId(null)}
          onDecision={() => setReviewGateId(null)}
          class="flex-1 min-h-0"
        />
      </div>
    </div>
  ) : null;

  if (pendingGates.length === 0 && !fetchError) return reviewOverlay;

  const fetchErrorBanner = fetchError ? (
    <InlineStatusBanner
      tone="red"
      icon={<span aria-hidden="true">⚠️</span>}
      label={`Failed to load gate status — ${fetchError}`}
      actions={[
        {
          label: 'Retry',
          onClick: retry,
          variant: 'primary',
          testId: 'pending-gate-fetch-retry',
        },
      ]}
      testId="pending-gate-fetch-error"
    />
  ) : null;

  return (
    <>
      {fetchErrorBanner}
      {pendingGates.length > 0 && (
        <div
          ref={bannerRef}
          tabIndex={-1}
          class="focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/70"
          data-testid="pending-gate-banner"
        >
          {pendingGates.map((gate) => {
            const busy = busyGateIds.has(gate.gateId);
            const error = decisionErrors.get(gate.gateId);
            const actions: InlineStatusBannerAction[] = [
              {
                label: 'Approve',
                onClick: () => void handleDecision(gate.gateId, true),
                variant: 'primary',
                disabled: busy,
                testId: 'pending-gate-approve-btn',
              },
              {
                label: 'Reject',
                onClick: () => void handleDecision(gate.gateId, false),
                variant: 'danger',
                disabled: busy,
                testId: 'pending-gate-reject-btn',
              },
              {
                // The review overlay's opener element is the button DOM
                // node rendered by InlineStatusBanner. We grab it via the
                // click event inside openReview.
                label: 'Review',
                onClick: () => {
                  // The InlineStatusBanner button isn't wired to pass the
                  // native event — capture current focus target instead
                  // so focus restoration still works when the overlay
                  // closes.
                  if (document.activeElement instanceof HTMLElement) {
                    overlayOpenerRef.current = document.activeElement;
                  }
                  setReviewGateId(gate.gateId);
                },
                variant: 'secondary',
                testId: 'pending-gate-review-btn',
              },
            ];
            return (
              <div key={gate.gateId}>
                <InlineStatusBanner
                  tone="purple"
                  icon={<span aria-hidden="true">🔒</span>}
                  label={`Gate Awaiting Approval${gate.label ? ` — ${gate.label}` : ''}`}
                  actions={actions}
                  testId="pending-gate-row"
                  dataAttrs={{ 'data-gate-id': gate.gateId }}
                />
                <p
                  class="mx-4 -mt-1 mb-2 text-xs text-amber-300/90"
                  data-testid="pending-gate-legacy-copy"
                >
                  Deprecated legacy gate. During migration, this gate maps to a workflow hook
                  checkpoint.
                </p>
                {error && (
                  <p class="mx-4 -mt-1 mb-2 text-xs text-red-400" data-testid="pending-gate-error">
                    {error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {reviewOverlay}
    </>
  );
}
