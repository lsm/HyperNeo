import { useState } from 'preact/hooks';
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
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="md" showCloseButton={true}>
      <div class="space-y-4">
        <p class="text-fg-soft text-sm leading-relaxed">{message}</p>

        <textarea
          class="w-full h-32 bg-surface-raised border border-line-strong rounded-lg px-3 py-2 text-sm text-fg placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
          placeholder={placeholder}
          value={feedback}
          onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)}
          disabled={isLoading}
          autoFocus
        />

        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={isLoading}
            class="px-4 py-2 text-sm font-medium text-fg-soft hover:text-fg bg-surface-raised hover:bg-fill-strong rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isLoading || !isValid}
            class="px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed bg-danger hover:bg-danger text-accent-fg disabled:bg-danger/50"
          >
            {isLoading ? 'Rejecting...' : confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
}
