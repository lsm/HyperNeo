/**
 * PendingPostApprovalBanner — surfaces tasks stuck mid-post-approval.
 *
 * Renders when a task is in the `approved` status (i.e. the runtime routed
 * post-approval work) AND the router recorded a reason it could not complete
 * (`postApprovalBlockedReason` is set). This is a signal to the human that a
 * spawned post-approval sub-session failed — e.g. the sub-session died before
 * calling `mark_complete`, or the configured target agent could not be found.
 *
 * The banner offers three actions:
 *   - **Send back** — transition `approved → in_progress` so the operator can
 *     restart the work and re-approve when ready. This does NOT re-run the
 *     post-approval dispatch (a dedicated `retryPostApproval` RPC is tracked
 *     separately); the operator must redo the work and call `approve_task`
 *     again.
 *   - **Mark done** — manually transition `approved → done` via
 *     `spaceTask.update`. Equivalent to the end-node calling `mark_complete`
 *     itself; use when the work is provably finished but the sub-session
 *     failed to self-close.
 *   - **View session** — navigates to the spawned sub-session if we have a
 *     session id on `task.postApprovalSessionId`.
 *
 * Not shown when `task.status !== 'approved'` — `approved` with no
 * `postApprovalBlockedReason` is the healthy mid-flight state and does not
 * warrant a banner.
 */

import { useCallback, useState } from 'preact/hooks';
import type { SpaceTask } from '@hyperneo/shared';
import { spaceStore } from '../../lib/space-store';
import { InlineStatusBanner, type InlineStatusBannerAction } from './InlineStatusBanner';

export interface PendingPostApprovalBannerProps {
  task: SpaceTask;
  spaceId: string;
  /** Optional navigation hook for the "View session" action. */
  onViewSession?: (sessionId: string) => void;
}

export function PendingPostApprovalBanner({
  task,
  spaceId: _spaceId,
  onViewSession,
}: PendingPostApprovalBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reason = task.postApprovalBlockedReason?.trim();
  const sessionId = task.postApprovalSessionId?.trim() || null;

  const onMarkDone = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await spaceStore.updateTask(task.id, {
        status: 'done',
        postApprovalSessionId: null,
        postApprovalStartedAt: null,
        postApprovalBlockedReason: null,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to mark done');
    } finally {
      setBusy(false);
    }
  }, [task.id]);

  const onSendBack = useCallback(async () => {
    // Returns the task to `in_progress` so the operator can restart the
    // work and re-approve when ready. The reconciliation pass does NOT
    // automatically re-trigger post-approval routing on this transition —
    // the operator has to redo the work and call `approve_task` again. A
    // dedicated `retryPostApproval` RPC that re-runs the router directly
    // is tracked separately.
    setBusy(true);
    setError(null);
    try {
      await spaceStore.updateTask(task.id, {
        status: 'in_progress',
        postApprovalBlockedReason: null,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send back');
    } finally {
      setBusy(false);
    }
  }, [task.id]);

  if (task.status !== 'approved') return null;
  if (!reason) return null;

  const actions: InlineStatusBannerAction[] = [
    {
      label: 'Send back',
      onClick: () => void onSendBack(),
      variant: 'secondary',
      disabled: busy,
      testId: 'pending-post-approval-send-back-btn',
    },
    {
      label: 'Mark done',
      onClick: () => void onMarkDone(),
      variant: 'primary',
      disabled: busy,
      testId: 'pending-post-approval-mark-done-btn',
    },
  ];
  if (sessionId && onViewSession) {
    actions.push({
      label: 'View session',
      onClick: () => onViewSession(sessionId),
      variant: 'secondary',
      disabled: busy,
      testId: 'pending-post-approval-view-session-btn',
    });
  }

  return (
    <>
      <InlineStatusBanner
        tone="amber"
        icon={<span aria-hidden="true">⏳</span>}
        label={`Post-approval blocked: ${reason}`}
        actions={actions}
        testId="pending-post-approval-banner"
        dataAttrs={{ 'data-task-id': task.id }}
      />
      {error ? (
        <p class="mx-4 -mt-1 mb-2 text-xs text-red-400" data-testid="pending-post-approval-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
