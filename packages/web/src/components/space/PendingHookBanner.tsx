import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { InlineStatusBanner, type InlineStatusBannerAction } from './InlineStatusBanner';
import { useRunHookStates, type HookBannerSummary } from './use-run-hook-states';

interface PendingHookBannerProps {
  runId: string;
  spaceId: string;
  workflowId: string | null;
  summaries?: HookBannerSummary[];
  fetchError?: string | null;
  retry?: () => void;
}

export function PendingHookBanner({
  runId,
  spaceId: _spaceId,
  workflowId,
  summaries: providedSummaries,
  fetchError: providedFetchError,
  retry: providedRetry,
}: PendingHookBannerProps) {
  const fallbackHookStates = useRunHookStates(
    providedSummaries === undefined && providedFetchError === undefined ? runId : null,
    workflowId
  );
  const summaries = providedSummaries ?? fallbackHookStates.summaries;
  const fetchError = providedFetchError ?? fallbackHookStates.fetchError;
  const retry = providedRetry ?? fallbackHookStates.retry;

  const [busyHookIds, setBusyHookIds] = useState<Set<string>>(() => new Set());
  const [decisionErrors, setDecisionErrors] = useState<Map<string, string>>(() => new Map());
  const decisionCancelledRef = useRef(false);
  const currentRunIdRef = useRef(runId);

  useEffect(() => {
    setDecisionErrors(new Map());
    setBusyHookIds(new Set());
    currentRunIdRef.current = runId;
  }, [runId]);

  useEffect(() => {
    decisionCancelledRef.current = false;
    return () => {
      decisionCancelledRef.current = true;
    };
  }, []);

  const bannerRef = useRef<HTMLDivElement | null>(null);

  const handleApprove = useCallback(
    async (hookId: string, approved: boolean) => {
      setBusyHookIds((prev) => {
        const next = new Set(prev);
        next.add(hookId);
        return next;
      });
      setDecisionErrors((prev) => {
        if (!prev.has(hookId)) return prev;
        const next = new Map(prev);
        next.delete(hookId);
        return next;
      });
      const runIdAtCall = runId;
      try {
        const hub = await connectionManager.getHub();
        await hub.request('spaceWorkflowRun.approveHook', { runId, hookId, approved });
      } catch (err: unknown) {
        if (decisionCancelledRef.current) return;
        if (currentRunIdRef.current !== runIdAtCall) return;
        const msg = err instanceof Error ? err.message : 'Failed to submit decision';
        setDecisionErrors((prev) => {
          const next = new Map(prev);
          next.set(hookId, msg);
          return next;
        });
      } finally {
        if (!decisionCancelledRef.current && currentRunIdRef.current === runIdAtCall) {
          setBusyHookIds((prev) => {
            if (!prev.has(hookId)) return prev;
            const next = new Set(prev);
            next.delete(hookId);
            return next;
          });
        }
      }
    },
    [runId]
  );

  const handleRetry = useCallback(
    async (hookId: string) => {
      setBusyHookIds((prev) => {
        const next = new Set(prev);
        next.add(hookId);
        return next;
      });
      setDecisionErrors((prev) => {
        if (!prev.has(hookId)) return prev;
        const next = new Map(prev);
        next.delete(hookId);
        return next;
      });
      const runIdAtCall = runId;
      try {
        const hub = await connectionManager.getHub();
        await hub.request('spaceWorkflowRun.retryHook', { runId, hookId });
      } catch (err: unknown) {
        if (decisionCancelledRef.current) return;
        if (currentRunIdRef.current !== runIdAtCall) return;
        const msg = err instanceof Error ? err.message : 'Failed to retry hook';
        setDecisionErrors((prev) => {
          const next = new Map(prev);
          next.set(hookId, msg);
          return next;
        });
      } finally {
        if (!decisionCancelledRef.current && currentRunIdRef.current === runIdAtCall) {
          setBusyHookIds((prev) => {
            if (!prev.has(hookId)) return prev;
            const next = new Set(prev);
            next.delete(hookId);
            return next;
          });
        }
      }
    },
    [runId]
  );

  const pendingHooks = (summaries ?? []).filter(
    (h) => h.status === 'blocked_by_hook' || h.status === 'waiting_on_hook_retry'
  );

  if (pendingHooks.length === 0 && !fetchError) return null;

  const fetchErrorBanner = fetchError ? (
    <InlineStatusBanner
      tone="red"
      icon={<span aria-hidden="true">⚠️</span>}
      label={`Failed to load hook status — ${fetchError}`}
      actions={[
        {
          label: 'Retry',
          onClick: retry,
          variant: 'primary',
          testId: 'pending-hook-fetch-retry',
        },
      ]}
      testId="pending-hook-fetch-error"
    />
  ) : null;

  return (
    <>
      {fetchErrorBanner}
      {pendingHooks.length > 0 && (
        <div
          ref={bannerRef}
          tabIndex={-1}
          class="focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/70"
          data-testid="pending-hook-banner"
        >
          {pendingHooks.map((hook) => {
            const busy = busyHookIds.has(hook.hookId);
            const error = decisionErrors.get(hook.hookId);
            const actions: InlineStatusBannerAction[] = [];

            if (hook.status === 'waiting_on_hook_retry') {
              actions.push({
                label: 'Retry',
                onClick: () => void handleRetry(hook.hookId),
                variant: 'primary',
                disabled: busy,
                testId: 'pending-hook-retry-btn',
              });
            }

            if (hook.status === 'blocked_by_hook' && hook.allowHumanApproval) {
              actions.push(
                {
                  label: 'Approve',
                  onClick: () => void handleApprove(hook.hookId, true),
                  variant: 'primary',
                  disabled: busy,
                  testId: 'pending-hook-approve-btn',
                },
                {
                  label: 'Reject',
                  onClick: () => void handleApprove(hook.hookId, false),
                  variant: 'danger',
                  disabled: busy,
                  testId: 'pending-hook-reject-btn',
                }
              );
            }

            const sourceTarget = [hook.sourceNode, hook.targetNode].filter(Boolean).join(' → ');
            const label = hook.label ?? hook.hookId;
            const subtitle = [sourceTarget, hook.method, hook.reason].filter(Boolean).join(' · ');

            return (
              <div key={hook.hookId}>
                <InlineStatusBanner
                  tone={hook.status === 'waiting_on_hook_retry' ? 'amber' : 'purple'}
                  icon={<span aria-hidden="true">🔒</span>}
                  label={`${label}${subtitle ? ` — ${subtitle}` : ''}`}
                  actions={actions}
                  testId="pending-hook-row"
                  dataAttrs={{ 'data-hook-id': hook.hookId }}
                />
                {error && (
                  <p class="mx-4 -mt-1 mb-2 text-xs text-red-400" data-testid="pending-hook-error">
                    {error}
                  </p>
                )}
                {hook.remediation && (
                  <p
                    class="mx-4 -mt-1 mb-2 text-xs text-gray-400"
                    data-testid="pending-hook-remediation"
                  >
                    {hook.remediation}
                  </p>
                )}
                {hook.retryCount !== undefined && hook.retryCount > 0 && (
                  <p
                    class="mx-4 -mt-1 mb-2 text-xs text-gray-500"
                    data-testid="pending-hook-retry-count"
                  >
                    Retry attempt {hook.retryCount}
                    {hook.nextRetryAt
                      ? ` · next retry ${new Date(hook.nextRetryAt).toLocaleTimeString()}`
                      : ''}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
