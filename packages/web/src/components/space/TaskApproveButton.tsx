import { useCallback, useState } from 'preact/hooks';
import type { SpaceTask } from '@hyperneo/shared';
import { spaceStore } from '../../lib/space-store';
import { Modal } from '../ui/Modal.tsx';

export function TaskApproveButton({ task }: { task: SpaceTask }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApproveModal, setShowApproveModal] = useState(false);
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

  if (task.status !== 'review') return null;

  const agentReason = task.pendingCompletionReason?.trim();
  const reportedSummary = task.reportedSummary?.trim();

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setShowApproveModal(true);
        }}
        disabled={busy}
        data-testid="pending-task-completion-approve-btn"
        title="Approve, or reply in the composer to send it back"
        class="h-6 flex-shrink-0 rounded-md bg-accent px-2.5 text-xs font-semibold text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        Approve
      </button>
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
              <p class="text-fg-muted mb-1">Agent's reported outcome:</p>
              <p class="p-2 bg-surface/60 border border-line rounded text-[11px] text-fg-soft whitespace-pre-wrap">
                {reportedSummary}
              </p>
            </div>
          )}

          {agentReason && (
            <div class="text-xs" data-testid="pending-task-completion-agent-reason">
              <p class="text-fg-muted mb-1">Agent rationale:</p>
              <p class="p-2 bg-surface/60 border border-line rounded text-[11px] text-fg-soft whitespace-pre-wrap">
                {agentReason}
              </p>
            </div>
          )}

          <div>
            <label class="block text-[11px] text-fg-muted mb-1" for="approve-reason-input">
              Approval note (optional — recorded on the task)
            </label>
            <textarea
              id="approve-reason-input"
              data-testid="pending-task-completion-approve-reason"
              value={approveReason}
              onInput={(e) => setApproveReason((e.target as HTMLTextAreaElement).value)}
              class="w-full rounded border border-line-strong bg-surface-raised px-2 py-1 text-[11px] text-fg-soft focus:border-warning focus:outline-none"
              rows={2}
              disabled={busy}
            />
          </div>

          {error && (
            <p class="text-xs text-danger" data-testid="pending-task-completion-error">
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
              class="px-4 py-2 text-sm font-medium text-fg-soft hover:text-fg bg-surface-raised hover:bg-fill-strong rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onApprove()}
              disabled={busy}
              data-testid="pending-task-completion-approve-confirm"
              class="px-4 py-2 text-sm font-medium rounded-lg transition-colors bg-success hover:bg-success text-on-success disabled:bg-success/50 disabled:cursor-not-allowed"
            >
              {busy ? 'Processing...' : 'Approve'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
