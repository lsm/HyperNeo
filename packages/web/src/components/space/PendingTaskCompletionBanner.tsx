import { useCallback, useState } from 'preact/hooks';
import type { SpaceTask } from '@hyperneo/shared';
import { spaceStore } from '../../lib/space-store';
import { Modal } from '../ui/Modal.tsx';
import { InlineStatusBanner, type InlineStatusBannerAction } from './InlineStatusBanner';

interface PendingTaskCompletionBannerProps {
  task: SpaceTask;
  spaceId: string;
}

function formatPendingSince(submittedAt: number | null | undefined): string | null {
  if (!submittedAt) return null;
  const delta = Date.now() - submittedAt;
  if (delta < 0) return null;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function PendingTaskCompletionBanner({
  task,
  spaceId: _spaceId,
}: PendingTaskCompletionBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [approveReason, setApproveReason] = useState('');

  const onApprove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const reason = approveReason.trim();
      await spaceStore.approvePendingCompletion(task.id, true, reason ? reason : null);
      setApproveReason('');
      setShowApproveModal(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setBusy(false);
    }
  }, [task.id, approveReason]);

  const onRejectConfirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const reason = rejectReason.trim();
      await spaceStore.approvePendingCompletion(task.id, false, reason ? reason : null);
      setShowRejectModal(false);
      setRejectReason('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to reject');
    } finally {
      setBusy(false);
    }
  }, [task.id, rejectReason]);

  if (task.pendingCheckpointType !== 'task_completion') return null;

  const agentReason = task.pendingCompletionReason?.trim();
  const reportedSummary = task.reportedSummary?.trim();
  const submittedAgo = formatPendingSince(task.pendingCompletionSubmittedAt ?? null);

  const actions: InlineStatusBannerAction[] = [
    {
      label: 'Approve',
      onClick: () => {
        setError(null);
        setShowApproveModal(true);
      },
      variant: 'primary',
      disabled: busy,
      testId: 'pending-task-completion-approve-btn',
    },
    {
      label: 'Send back',
      onClick: () => {
        setError(null);
        setShowRejectModal(true);
      },
      variant: 'danger',
      disabled: busy,
      testId: 'pending-task-completion-reject-btn',
    },
  ];

  return (
    <>
      <InlineStatusBanner
        tone="amber"
        icon={<span aria-hidden="true">⏸</span>}
        label="Awaiting approval"
        meta={submittedAgo ? `· ${submittedAgo}` : undefined}
        actions={actions}
        testId="pending-task-completion-banner"
      />

      <Modal
        isOpen={showApproveModal}
        onClose={() => {
          if (!busy) {
            setShowApproveModal(false);
            setApproveReason('');
            setError(null);
          }
        }}
        title="Approve task completion?"
        size="md"
        data-testid="pending-task-completion-approve-modal"
      >
        <div class="space-y-4" data-testid="pending-task-completion-approve-modal-content">
          {reportedSummary && (
            <div class="text-xs" data-testid="pending-task-completion-reported-summary">
              <p class="text-gray-400 mb-1">Agent's reported outcome:</p>
              <p class="p-2 bg-dark-900/60 border border-dark-700 rounded text-[11px] text-gray-300 whitespace-pre-wrap">
                {reportedSummary}
              </p>
            </div>
          )}

          {agentReason && (
            <div class="text-xs" data-testid="pending-task-completion-agent-reason">
              <p class="text-gray-400 mb-1">Agent rationale:</p>
              <p class="p-2 bg-dark-900/60 border border-dark-700 rounded text-[11px] text-gray-300 whitespace-pre-wrap">
                {agentReason}
              </p>
            </div>
          )}

          <div>
            <label class="block text-[11px] text-gray-400 mb-1" for="approve-reason-input">
              Approval note (optional — recorded on the task)
            </label>
            <textarea
              id="approve-reason-input"
              data-testid="pending-task-completion-approve-reason"
              value={approveReason}
              onInput={(e) => setApproveReason((e.target as HTMLTextAreaElement).value)}
              class="w-full rounded border border-dark-600 bg-dark-800 px-2 py-1 text-[11px] text-gray-200 focus:border-amber-500 focus:outline-none"
              rows={2}
              disabled={busy}
            />
          </div>

          {error && (
            <p class="text-xs text-red-400" data-testid="pending-task-completion-error">
              {error}
            </p>
          )}

          <div class="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => {
                if (!busy) {
                  setShowApproveModal(false);
                  setApproveReason('');
                  setError(null);
                }
              }}
              disabled={busy}
              class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onApprove()}
              disabled={busy}
              data-testid="pending-task-completion-approve-confirm"
              class="px-4 py-2 text-sm font-medium rounded-lg transition-colors bg-green-600 hover:bg-green-700 text-white disabled:bg-green-600/50 disabled:cursor-not-allowed"
            >
              {busy ? 'Processing...' : 'Approve'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showRejectModal}
        onClose={() => {
          if (!busy) {
            setShowRejectModal(false);
            setRejectReason('');
            setError(null);
          }
        }}
        title="Send task back for revision?"
        size="md"
        data-testid="pending-task-completion-reject-modal"
      >
        <div class="space-y-4" data-testid="pending-task-completion-reject-modal-content">
          <p class="text-gray-300 text-sm leading-relaxed">
            The task will be reopened (status: in_progress) so the end-node agent can revise and
            re-submit. The pending-completion request will be cleared.
          </p>

          {reportedSummary && (
            <div class="text-xs">
              <p class="text-gray-400 mb-1">Agent's reported outcome:</p>
              <p class="p-2 bg-dark-900/60 border border-dark-700 rounded text-[11px] text-gray-300 whitespace-pre-wrap">
                {reportedSummary}
              </p>
            </div>
          )}

          {agentReason && (
            <div class="text-xs">
              <p class="text-gray-400 mb-1">Agent rationale:</p>
              <p class="p-2 bg-dark-900/60 border border-dark-700 rounded text-[11px] text-gray-300 whitespace-pre-wrap">
                {agentReason}
              </p>
            </div>
          )}

          <div>
            <label
              class="block text-xs text-gray-400 mb-1"
              for="task-completion-reject-reason-input"
            >
              Reason (optional — shared with the agent as feedback)
            </label>
            <textarea
              id="task-completion-reject-reason-input"
              data-testid="pending-task-completion-reject-reason"
              value={rejectReason}
              onInput={(e) => setRejectReason((e.target as HTMLTextAreaElement).value)}
              class="w-full rounded border border-dark-600 bg-dark-800 px-2 py-1 text-sm text-gray-200 focus:border-red-500 focus:outline-none"
              rows={3}
              disabled={busy}
            />
          </div>

          {error && (
            <p class="text-xs text-red-400" data-testid="pending-task-completion-error">
              {error}
            </p>
          )}

          <div class="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => {
                if (!busy) {
                  setShowRejectModal(false);
                  setRejectReason('');
                  setError(null);
                }
              }}
              disabled={busy}
              class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Keep Pending
            </button>
            <button
              type="button"
              onClick={() => void onRejectConfirm()}
              disabled={busy}
              data-testid="pending-task-completion-reject-confirm"
              class="px-4 py-2 text-sm font-medium rounded-lg transition-colors bg-red-600 hover:bg-red-700 text-white disabled:bg-red-600/50 disabled:cursor-not-allowed"
            >
              {busy ? 'Processing...' : 'Send back to agent'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
