import { useEffect, useState } from 'preact/hooks';
import { FORM_CONTROL_CLASS, FORM_LABEL_CLASS, FormActions } from '../ui/FormField.tsx';
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
      footer={
        <FormActions
          onCancel={() => {
            if (!busy) onCancel();
          }}
          cancelDisabled={busy}
          submitLabel="Submit for Review"
          submitting={busy}
          submitVariant="warning"
          onSubmit={handleConfirm}
          submitTestId="submit-for-review-confirm"
        />
      }
    >
      <div class="space-y-4" data-testid="submit-for-review-modal-content">
        <p class="text-fg-soft text-sm leading-relaxed">
          The task will be moved to <span class="font-mono">review</span>. A reviewer will approve
          or send it back via the pending-approval banner — the same flow used by the agent{' '}
          <span class="font-mono">submit_for_approval</span> tool.
        </p>

        <div>
          <label class={FORM_LABEL_CLASS} for="submit-for-review-reason-input">
            Reason (optional — visible in the approval banner)
          </label>
          <textarea
            id="submit-for-review-reason-input"
            data-testid="submit-for-review-reason"
            value={reason}
            onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)}
            class={`${FORM_CONTROL_CLASS} resize-y`}
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
      </div>
    </Modal>
  );
}
