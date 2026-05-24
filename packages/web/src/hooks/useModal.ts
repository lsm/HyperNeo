/**
 * useModal Hook
 *
 * Simple hook for managing modal open/close state.
 * Reduces boilerplate for the common useState(false) + setOpen pattern.
 *
 * @example
 * ```typescript
 * const deleteModal = useModal();
 *
 * <button onClick={deleteModal.open}>Delete</button>
 * <Modal isOpen={deleteModal.isOpen} onClose={deleteModal.close}>
 *   <ConfirmDialog onConfirm={handleDelete} />
 * </Modal>
 * ```
 */

import { useState, useCallback } from 'preact/hooks';

export interface UseModalResult {
  /** Whether the modal is currently open */
  isOpen: boolean;
  /** Open the modal */
  open: () => void;
  /** Close the modal */
  close: () => void;
  /** Toggle the modal state */
  toggle: () => void;
  /** Set the modal state directly */
  setIsOpen: (open: boolean) => void;
}

/**
 * Hook for managing modal open/close state
 *
 * @param initialOpen - Initial open state (default: false)
 * @returns Modal state and control functions
 */
export function useModal(initialOpen = false): UseModalResult {
  const [isOpen, setIsOpen] = useState(initialOpen);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  return {
    isOpen,
    open,
    close,
    toggle,
    setIsOpen,
  };
}
