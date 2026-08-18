import { useCallback, useState } from 'preact/hooks';
import type { SpaceTask } from '@hyperneo/shared';
import { buildMarkDonePayload } from '../../lib/space-task-helpers';
import { spaceStore } from '../../lib/space-store';
import { InlineStatusBanner, type InlineStatusBannerAction } from './InlineStatusBanner';

export interface PendingPostApprovalBannerProps {
  task: SpaceTask;
  spaceId: string;
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
      await spaceStore.updateTask(task.id, buildMarkDonePayload(task));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to mark done');
    } finally {
      setBusy(false);
    }
  }, [task.id]);

  const onSendBack = useCallback(async () => {
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
