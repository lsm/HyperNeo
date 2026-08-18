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
      ? 'bg-red-600 hover:bg-red-700 text-white disabled:bg-red-600/50'
      : confirmButtonVariant === 'warning'
        ? 'bg-amber-600 hover:bg-amber-700 text-white disabled:bg-amber-600/50'
        : confirmButtonVariant === 'approve'
          ? 'bg-green-600 hover:bg-green-700 text-white disabled:bg-green-600/50'
          : 'bg-blue-600 hover:bg-blue-700 text-white disabled:bg-blue-600/50';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm" showCloseButton={false}>
      <div class="space-y-4">
        <p class="text-gray-300 text-sm leading-relaxed">{message}</p>

        {children && <div class="mt-2">{children}</div>}

        {error && (
          <p class="text-red-400 text-sm bg-red-900/20 border border-red-800/50 rounded px-3 py-2">
            {error}
          </p>
        )}

        <div class="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
