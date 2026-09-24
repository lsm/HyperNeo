import { useState } from 'preact/hooks';
import { FORM_CONTROL_CLASS, FormActions } from './FormField.tsx';
import { Modal } from './Modal.tsx';

export interface RejectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (feedback: string) => void;
  title: string;
  message: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  isLoading?: boolean;
}

export function RejectModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  placeholder = 'Please provide feedback explaining why this work was rejected...',
  confirmText = 'Reject',
  cancelText = 'Cancel',
  isLoading = false,
}: RejectModalProps) {
  const [feedback, setFeedback] = useState('');

  const handleConfirm = () => {
    if (feedback.trim()) {
      onConfirm(feedback.trim());
    }
  };

  const handleClose = () => {
    setFeedback('');
    onClose();
  };

  const isValid = feedback.trim().length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={title}
      size="md"
      showCloseButton={true}
      footer={
        <FormActions
          onCancel={handleClose}
          cancelLabel={cancelText}
          cancelDisabled={isLoading}
          submitLabel={confirmText}
          submitting={isLoading}
          submitDisabled={!isValid}
          submitVariant="danger"
          onSubmit={handleConfirm}
        />
      }
    >
      <div class="space-y-4">
        <p class="text-fg-soft text-sm leading-relaxed">{message}</p>

        <textarea
          class={`${FORM_CONTROL_CLASS} h-32 resize-none`}
          placeholder={placeholder}
          value={feedback}
          onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)}
          disabled={isLoading}
          autoFocus
        />
      </div>
    </Modal>
  );
}
