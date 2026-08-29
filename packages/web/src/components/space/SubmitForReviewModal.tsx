import { useEffect, useState } from 'preact/hooks';
import { Modal } from '../ui/Modal.tsx';

interface SubmitForReviewModalProps {
  isOpen: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string | null) => void | Promise<void>;
  error?: string | null;
}

export function SubmitForReviewModal({
  isOpen,
  busy,
  onCancel,
  onConfirm,
  error,
}: SubmitForReviewModalProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!isOpen) setReason('');
  }, [isOpen]);

  const handleConfirm = (): void => {
    const trimmed = reason.trim();
    void onConfirm(trimmed ? trimmed : null);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!busy) onCancel();
      }}
      title="Submit task for human review?"
      size="md"
    >
      <div class="space-y-4" data-testid="submit-for-review-modal-content">
        <p class="text-fg-soft text-sm leading-relaxed">
          The task will be moved to <span class="font-mono">review</span>. A reviewer will approve
          or send it back via the pending-approval banner — the same flow used by the agent{' '}
          <span class="font-mono">submit_for_approval</span> tool.
        </p>

        <div>
          <label class="block text-[11px] text-fg-muted mb-1" for="submit-for-review-reason-input">
            Reason (optional — visible in the approval banner)
          </label>
          <textarea
            id="submit-for-review-reason-input"
            data-testid="submit-for-review-reason"
            value={reason}
            onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)}
            class="w-full rounded border border-line-strong bg-surface-raised px-2 py-1 text-[11px] text-fg-soft focus:border-warning focus:outline-none"
            rows={3}
            disabled={busy}
            placeholder="What should the reviewer look at?"
          />
        </div>

        {error && (
          <p class="text-xs text-danger" role="alert" data-testid="submit-for-review-error">
            {error}
          </p>
        )}

        <div class="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={() => {
              if (!busy) onCancel();
            }}
            disabled={busy}
            class="px-4 py-2 text-sm font-medium text-fg-soft hover:text-fg bg-surface-raised hover:bg-fill-strong rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            data-testid="submit-for-review-confirm"
            class="px-4 py-2 text-sm font-medium rounded-lg transition-colors bg-warning hover:bg-warning text-accent-fg disabled:bg-warning/50 disabled:cursor-not-allowed"
          >
            {busy ? 'Submitting...' : 'Submit for Review'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
