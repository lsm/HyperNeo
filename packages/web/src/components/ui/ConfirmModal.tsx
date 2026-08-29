import type { ComponentChildren } from 'preact';

import { Modal } from './Modal.tsx';

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmButtonVariant?: 'danger' | 'primary' | 'warning' | 'approve';
  isLoading?: boolean;
  error?: string | null;
  children?: ComponentChildren;
  confirmTestId?: string;
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmButtonVariant = 'danger',
  isLoading = false,
  error = null,
  children,
  confirmTestId,
}: ConfirmModalProps) {
  const handleConfirm = () => {
    onConfirm();
  };

  const confirmButtonClasses =
    confirmButtonVariant === 'danger'
      ? 'bg-danger hover:bg-danger text-accent-fg disabled:bg-danger/50'
      : confirmButtonVariant === 'warning'
        ? 'bg-warning hover:bg-warning text-accent-fg disabled:bg-warning/50'
        : confirmButtonVariant === 'approve'
          ? 'bg-success hover:bg-success text-accent-fg disabled:bg-success/50'
          : 'bg-accent-hover hover:bg-accent-hover text-accent-fg disabled:bg-accent-hover/50';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm" showCloseButton={false}>
      <div class="space-y-4">
        <p class="text-fg-soft text-sm leading-relaxed">{message}</p>

        {children && <div class="mt-2">{children}</div>}

        {error && (
          <p class="text-danger text-sm bg-danger/20 border border-danger/50 rounded px-3 py-2">
            {error}
          </p>
        )}

        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            class="px-4 py-2 text-sm font-medium text-fg-soft hover:text-accent-fg bg-surface-raised hover:bg-fill-strong rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isLoading}
            data-testid={confirmTestId}
            class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed ${confirmButtonClasses}`}
          >
            {isLoading ? 'Processing...' : confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
}
